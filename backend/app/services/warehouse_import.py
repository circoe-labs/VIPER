"""Import the warehouse/owner/interlocutor workbook without altering the prospect base."""

import hashlib
import io
import unicodedata
import zipfile
from functools import partial
from pathlib import PureWindowsPath
from typing import Any
from xml.etree.ElementTree import ParseError

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import Warehouse
from app.services.errors import InvalidFieldError
from app.services.warehouses import WarehouseContact, WarehouseInput, save_warehouse

MAX_BYTES = 16 * 1024 * 1024


def column(headers: list[str], prefix: str, start: int, end: int) -> int | None:
    return next((i for i in range(start, end) if headers[i].startswith(prefix)), None)


def cell_text(row: tuple[Any, ...], index: int | None) -> str | None:
    value = row[index] if index is not None and index < len(row) else None
    return (str(value).strip() or None) if value is not None else None


def key(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold())
    return " ".join("".join(c for c in folded if not unicodedata.combining(c)).split())


class ImportPreview(BaseModel):
    items: list[WarehouseInput]
    references: list[str]
    warehouses: int
    contacts: int
    existing: int = 0


class ImportResult(BaseModel):
    created: int
    skipped: int
    contacts: int


def preview(content: bytes, filename: str) -> ImportPreview:
    def reject(message: str) -> InvalidFieldError:
        return InvalidFieldError("file", message, "workbook")

    if not content or len(content) > MAX_BYTES or not filename.lower().endswith(".xlsx"):
        raise reject("Choisissez un fichier .xlsx de moins de 16 Mo.")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            if sum(item.file_size for item in archive.infolist()) > 32 * 1024 * 1024:
                raise reject("Le classeur décompressé est trop volumineux.")
        book = load_workbook(io.BytesIO(content), read_only=True, data_only=True, keep_links=False)
    except (
        zipfile.BadZipFile,
        KeyError,
        OSError,
        ValueError,
        ParseError,
        InvalidFileException,
    ) as error:
        raise reject("Le fichier Excel ne peut pas être lu.") from error
    grouped: dict[str, WarehouseInput] = {}
    sources: dict[str, list[str]] = {}
    try:
        for sheet in book.worksheets:
            if (sheet.max_row or 0) > 10000 or (sheet.max_column or 0) > 100:
                raise reject("Le classeur dépasse la limite de 10 000 lignes ou 100 colonnes.")
            rows = sheet.iter_rows(values_only=True)
            headers = [key(str(value or "")) for value in next(rows, ())]
            if "nom entrepot" not in headers or "prospect a contacter" not in headers:
                continue
            site_col, person_col = (
                headers.index("nom entrepot"),
                headers.index("prospect a contacter"),
            )
            owner_col = next((i for i, name in enumerate(headers) if "proprietaire" in name), None)

            find_column = partial(column, headers)
            owner_start = owner_col + 1 if owner_col is not None else person_col
            mappings = {
                "owner_role": find_column("fonction", owner_start, person_col),
                "owner_email": find_column("email", owner_start, person_col),
                "owner_linkedin": find_column("linkedin", owner_start, person_col),
            }
            person_role = find_column("fonction", person_col + 1, len(headers))
            person_email = find_column("email", person_col + 1, len(headers))
            person_linkedin = find_column("linkedin", person_col + 1, len(headers))
            current: str | None = None
            for row_number, row in enumerate(rows, 2):
                text = partial(cell_text, row)
                name = text(site_col)
                if name:
                    current = key(name)
                    if current not in grouped:
                        grouped[current] = WarehouseInput(name=name)
                        sources[current] = []
                if not current:
                    if any(value is not None for value in row):
                        raise reject(f"{sheet.title}, ligne {row_number} : entrepôt manquant.")
                    continue
                warehouse = grouped[current]
                if sheet.title not in sources[current]:
                    sources[current].append(sheet.title)
                for field, index in {"owner_name": owner_col, **mappings}.items():
                    if value := text(index):
                        previous = getattr(warehouse, field)
                        if previous and key(previous) != key(value):
                            raise reject(
                                f"{sheet.title}, ligne {row_number} : "
                                "informations propriétaire contradictoires."
                            )
                        setattr(warehouse, field, value)
                if person := text(person_col):
                    contact = WarehouseContact(
                        full_name=person,
                        role=text(person_role),
                        email=text(person_email),
                        linkedin=text(person_linkedin),
                    )
                    if not any(
                        key(old.full_name) == key(person)
                        and old.email == contact.email
                        and old.role == contact.role
                        and old.linkedin == contact.linkedin
                        for old in warehouse.contacts
                    ):
                        warehouse.contacts.append(contact)
        if not grouped:
            raise reject("Colonnes attendues : Nom entrepôt et Prospect a contacter.")
        if len(grouped) > 2000:
            raise reject("Un import est limité à 2 000 entrepôts.")
        items = [WarehouseInput.model_validate(item.model_dump()) for item in grouped.values()]
    except ValidationError as error:
        raise reject(
            "Une cellule dépasse la taille autorisée. Vérifiez les noms et coordonnées."
        ) from error
    finally:
        book.close()
    basename = PureWindowsPath(filename).name
    return ImportPreview(
        items=items,
        references=[f"{basename} · {', '.join(sources[name])}" for name in grouped],
        warehouses=len(items),
        contacts=sum(len(item.contacts) for item in items),
    )


def existing_keys(session: Session) -> set[str]:
    return {key(name) for name in session.scalars(select(Warehouse.name))}


def import_workbook(
    session: Session, actor: ActorContext, content: bytes, filename: str
) -> ImportResult:
    plan = preview(content, filename)
    known = existing_keys(session)
    created = skipped = contacts = 0
    for item, reference in zip(plan.items, plan.references, strict=True):
        identity = key(item.name)
        if identity in known:
            skipped += 1
            continue
        save_warehouse(
            session,
            actor,
            item,
            source_reference=reference,
            source_key=hashlib.sha256(identity.encode()).hexdigest(),
        )
        known.add(identity)
        created += 1
        contacts += len(item.contacts)
    return ImportResult(created=created, skipped=skipped, contacts=contacts)
