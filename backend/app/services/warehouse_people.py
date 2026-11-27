"""The people of the warehouse listings as prospects (`doc/features/warehouses.md`).

An entry of a listing (an interlocutor, or the owner) is written to **from Contact only**, once a
person is linked to it:

- `read_name`: is the entry one person's name? A mailbox, a team, a company or two names are not
  (nobody is invented from them: the listing must name a person first); a single word is
  incomplete (a person completes it). A generic address (`contact@`) of a named person is fine;
- `Directory.candidates`: the prospects who may already be that person (same address, same name,
  or same family name and initial in the company). One candidate with the same name **and** the
  same address or company is a match; any other candidate is for a person to decide;
- `link` / `create` (one person, from the warehouse sheet) and `backfill` (the operator, dry run
  unless applied): never a second record for a matching person, never an attachment on the name
  alone. Linking never changes a prospect's opposition or holds; it stops the programmed
  warehouse mails of someone who may not be prospected, and counts the sent ones (`carry`).

Operations flush; the caller owns the transaction. Logs and audit carry ids, never names.
"""

import logging
import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import (
    Company,
    ContactMessage,
    Email,
    Establishment,
    Prospect,
    Warehouse,
    WarehouseDraft,
    WarehousePerson,
)
from app.models.enums import (
    Civility,
    ContactMessageStatus,
    OriginType,
    ProspectSourceType,
)
from app.services import (
    audit,
    contact_sequences,
    eligibility,
    prospects,
    provenance,
    warehouse_history,
)
from app.services.contact_message_cancellation import stop_warehouse_drafts
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    InvalidFieldError,
    NotFoundError,
)
from app.services.imports.matching import company_key
from app.services.imports.normalize import EMAIL_PATTERN, normalize_name
from app.services.imports.text import fold
from app.services.warehouse_history import name_key

logger = logging.getLogger(__name__)

Kind = Literal["contact", "owner"]
NameState = Literal["person", "incomplete", "not_a_person"]
Status = Literal["linked", "match", "ambiguous", "new", "incomplete", "not_a_person"]
NAME_MAX = 100
TITLE_MAX = 255
LEGAL_CONTEXT = "Interlocuteur relevé dans l’annuaire des entrepôts."

# Words of a mailbox, a team or a company: an entry holding one is not a person's name.
_NOT_A_NAME_WORDS = """
    accueil achats administratif administration adv agence atelier bureau cabinet client clients
    commercial commerciale communication compta comptabilite contact contacts depot direction
    directeur directrice dispatch drh entrepot entrepots equipe expedition exploitation facturation
    finance fonciere france gestion groupe holding immobilier immobiliere info infos international
    logistic logistics logistique magasin maintenance marketing messagerie office operations paie
    planning plateforme poste qhse qualite quai reception responsable rh sa sarl sas sasu sci
    secretariat securite service services siege site societe standard stock stocks support
    technique transit transport transports vente ventes
"""
NOT_A_NAME = frozenset(_NOT_A_NAME_WORDS.split())
CIVILITY_WORDS = {
    "m": Civility.MR,
    "mr": Civility.MR,
    "monsieur": Civility.MR,
    "mme": Civility.MS,
    "madame": Civility.MS,
    "mlle": Civility.MS,
    "mademoiselle": Civility.MS,
    "dr": None,
}
SEVERAL = frozenset({"et", "ou"})


@dataclass(frozen=True, slots=True)
class ReadName:
    state: NameState
    first_name: str = ""
    last_name: str = ""
    civility: Civility | None = None


def read_name(value: str) -> ReadName:
    """The listing's free text as one person. `First LAST` and `LAST First` follow the capitals;
    otherwise the first word is the first name."""
    words = value.split()
    civility = None
    while words and fold(words[0]) in CIVILITY_WORDS:
        civility = CIVILITY_WORDS[fold(words.pop(0))] or civility
    folded = [part for word in words for part in fold(word).split()]
    if (
        not any(char.isalpha() for word in words for char in word)
        or any(char in value for char in "@/\\,;&+:()0123456789")
        or any(part in NOT_A_NAME for part in folded)
        or any(fold(word) in SEVERAL for word in words)
        or len(words) > 5
    ):
        return ReadName("not_a_person")
    if len(words) < 2:
        return ReadName("incomplete", last_name=normalize_name(words[0]), civility=civility)
    upper = [len(fold(w)) > 1 and w.isupper() for w in words]
    if any(upper) and not all(upper):
        last = [w for w, is_upper in zip(words, upper, strict=True) if is_upper]
        first = [w for w, is_upper in zip(words, upper, strict=True) if not is_upper]
    else:
        first, last = words[:1], words[1:]
    return ReadName(
        "person", normalize_name(" ".join(first)), normalize_name(" ".join(last)), civility
    )


def addresses_of(text: str | None) -> list[str]:
    """Every address written in the free text (`a@x ou b@x`), in order."""
    return list(dict.fromkeys(EMAIL_PATTERN.findall((text or "").lower())))


# --- the listing ----------------------------------------------------------------------------------


@dataclass(slots=True)
class Entry:
    """One person of one warehouse listing (identical names of a site are one entry)."""

    key: str
    kind: Kind
    contact_name: str
    role: str | None
    addresses: list[str]


def entries(warehouse: Warehouse) -> list[Entry]:
    found: dict[str, Entry] = {}
    listed: list[tuple[Kind, str, str | None, str | None]] = [
        ("contact", str(c.get("full_name") or ""), c.get("role"), c.get("email"))
        for c in warehouse.contacts
    ]
    if warehouse.owner_name:
        listed.append(("owner", warehouse.owner_name, warehouse.owner_role, warehouse.owner_email))
    for kind, name, role, email in listed:
        key = name_key(name)
        if not key:
            continue
        entry = found.get(key)
        if entry is None:
            found[key] = Entry(key, kind, name, role, addresses_of(email))
        else:
            entry.role = entry.role or role
            entry.addresses += [a for a in addresses_of(email) if a not in entry.addresses]
    return list(found.values())


# --- who may already be that person ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Known:
    id: uuid.UUID
    first_name: str
    last_name: str
    company_id: uuid.UUID | None
    company_name: str | None


@dataclass(frozen=True, slots=True)
class Candidate:
    person: Known
    # `same_email`, `same_name`, `same_company`, `same_initial`.
    reasons: tuple[str, ...]

    @property
    def same_person(self) -> bool:
        return "same_name" in self.reasons and (
            "same_email" in self.reasons or "same_company" in self.reasons
        )


@dataclass(slots=True)
class Directory:
    """The prospects indexed for comparison, read once."""

    people: dict[uuid.UUID, Known] = field(default_factory=dict)
    by_name: dict[str, set[uuid.UUID]] = field(default_factory=lambda: defaultdict(set))
    by_email: dict[str, set[uuid.UUID]] = field(default_factory=lambda: defaultdict(set))
    by_family: dict[tuple[uuid.UUID, str], set[uuid.UUID]] = field(
        default_factory=lambda: defaultdict(set)
    )
    names: dict[uuid.UUID, str] = field(default_factory=dict)
    # Companies sharing a name key are one company for the comparison (computed when compared).
    keys: dict[uuid.UUID, str | None] = field(default_factory=dict)

    @classmethod
    def load(cls, session: Session) -> Directory:
        directory = cls()
        names = directory.names = dict(
            session.execute(select(Company.id, Company.display_name)).tuples().all()
        )
        for pid, first, last, company_id in session.execute(
            select(Prospect.id, Prospect.first_name, Prospect.last_name, Prospect.company_id)
        ).tuples():
            directory.add(
                Known(
                    pid,
                    first or "",
                    last or "",
                    company_id,
                    names[company_id] if company_id else None,
                )
            )
        for pid, address in session.execute(select(Email.prospect_id, Email.address)).tuples():
            directory.by_email[address].add(pid)
        return directory

    def add(self, person: Known, addresses: Iterable[str] = ()) -> None:
        self.people[person.id] = person
        self.by_name[name_key(f"{person.first_name} {person.last_name}")].add(person.id)
        if person.company_id is not None:
            self.by_family[(person.company_id, fold(person.last_name))].add(person.id)
        for address in addresses:
            self.by_email[address].add(person.id)

    def _same_company(self, person: Known, company_id: uuid.UUID | None) -> bool:
        if company_id is None or person.company_id is None:
            return False
        if person.company_id == company_id:
            return True
        mine = self._company_key(company_id)
        return mine is not None and self._company_key(person.company_id) == mine

    def _company_key(self, company_id: uuid.UUID) -> str | None:
        if company_id not in self.keys:
            name = self.names.get(company_id)
            self.keys[company_id] = company_key(name) if name else None
        return self.keys[company_id]

    def candidates(self, entry: Entry, company_id: uuid.UUID | None) -> list[Candidate]:
        read = read_name(entry.contact_name)
        reasons: dict[uuid.UUID, set[str]] = defaultdict(set)
        for address in entry.addresses:
            for pid in self.by_email.get(address, ()):
                reasons[pid].add("same_email")
        if read.state == "person":
            for pid in self.by_name.get(entry.key, ()):
                reasons[pid].add("same_name")
            if company_id is not None:
                initial = fold(read.first_name)[:1]
                for pid in self.by_family.get((company_id, fold(read.last_name)), ()):
                    first = fold(self.people[pid].first_name)
                    # `J. Name` / `Jean Name`: possibly the same, never decided here.
                    if first[:1] == initial and min(len(first), len(fold(read.first_name))) <= 1:
                        reasons[pid].add("same_initial")
        found = []
        for pid, why in reasons.items():
            person = self.people.get(pid)
            if person is None:
                continue
            if self._same_company(person, company_id):
                why.add("same_company")
            found.append(Candidate(person, tuple(sorted(why))))
        return sorted(
            found, key=lambda c: (not c.same_person, c.person.last_name, str(c.person.id))
        )


def classify(entry: Entry, candidates: Sequence[Candidate]) -> Status:
    state = read_name(entry.contact_name).state
    if state == "not_a_person":
        return "not_a_person"
    if len(candidates) == 1 and candidates[0].same_person and state == "person":
        return "match"
    if candidates:
        return "ambiguous"
    return "new" if state == "person" else "incomplete"


# --- reads ----------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ContactState:
    """Where a linked person stands in Contact."""

    block: str | None
    tracking: str | None
    cohort_code: str | None
    sequence_open: bool
    sent_count: int
    last_sent_at: datetime | None
    next_scheduled_at: datetime | None
    # A warehouse mail programmed or unsettled: nothing leaves from Contact meanwhile.
    warehouse_pending: bool
    # Sent warehouse mails not counted yet (no open sequence): counted when a week is chosen.
    warehouse_uncounted: int


@dataclass(frozen=True, slots=True)
class PersonRow:
    entry: Entry
    status: Status
    suggested: ReadName
    candidates: list[tuple[Candidate, str | None]]  # with the candidate's block
    prospect: Known | None = None
    state: ContactState | None = None


@dataclass(frozen=True, slots=True)
class WarehousePeople:
    company_id: uuid.UUID | None
    company_name: str | None
    people: list[PersonRow]


def _warehouse(session: Session, warehouse_id: uuid.UUID, *, lock: bool = False) -> Warehouse:
    statement = select(Warehouse).where(Warehouse.id == warehouse_id)
    found = session.scalar(statement.with_for_update() if lock else statement)
    if found is None:
        raise NotFoundError("Warehouse not found.")
    return found


def _company_of(session: Session, warehouse: Warehouse) -> tuple[uuid.UUID, str] | None:
    if warehouse.establishment_id is None:
        return None
    row = session.execute(
        select(Company.id, Company.display_name)
        .join(Establishment, Establishment.company_id == Company.id)
        .where(Establishment.id == warehouse.establishment_id)
    ).one_or_none()
    return (row[0], row[1]) if row else None


def contact_state(session: Session, prospect_id: uuid.UUID) -> ContactState:
    place = contact_sequences.prospect_sequence(session, prospect_id)
    sent_count, last_sent, scheduled = 0, None, None
    if place.sequence_id is not None:
        sent_count, last_sent = contact_sequences.sends_of(session, place.sequence_id)
        scheduled = session.scalar(
            select(ContactMessage.scheduled_at)
            .where(
                ContactMessage.sequence_id == place.sequence_id,
                ContactMessage.status == ContactMessageStatus.SCHEDULED,
            )
            .order_by(ContactMessage.scheduled_at)
            .limit(1)
        )
    prospect = prospects.get_prospect(session, prospect_id)
    block = eligibility.block_of(session, prospect_id)
    mails = warehouse_history.mails_of(session, prospect_id)
    return ContactState(
        block=block.value if block else None,
        tracking=prospect.contact_tracking.status.value if prospect.contact_tracking else None,
        cohort_code=place.cohort.code if place.cohort else None,
        sequence_open=place.sequence_open,
        sent_count=sent_count,
        last_sent_at=last_sent,
        next_scheduled_at=scheduled,
        warehouse_pending=any(m.send_state in warehouse_history.PENDING for m in mails),
        warehouse_uncounted=sum(
            m.send_state == "sent" and m.carried_message_id is None for m in mails
        ),
    )


def read(session: Session, warehouse_id: uuid.UUID) -> WarehousePeople:
    """Every person of the listing with their prospect and Contact state, or who they may be."""
    warehouse = _warehouse(session, warehouse_id)
    company = _company_of(session, warehouse)
    company_id = company[0] if company else None
    links = {
        link.contact_key: link.prospect_id
        for link in session.scalars(
            select(WarehousePerson).where(WarehousePerson.warehouse_id == warehouse_id)
        )
    }
    listed = entries(warehouse)
    directory = Directory.load(session)
    found: dict[str, list[Candidate]] = {
        e.key: directory.candidates(e, company_id) for e in listed if e.key not in links
    }
    blocks = eligibility.blocks_of(
        session, list({c.person.id for items in found.values() for c in items})
    )
    rows = []
    for entry in listed:
        suggested = read_name(entry.contact_name)
        linked = links.get(entry.key)
        if linked is not None:
            rows.append(
                PersonRow(
                    entry,
                    "linked",
                    suggested,
                    [],
                    directory.people[linked],
                    contact_state(session, linked),
                )
            )
            continue
        candidates = found[entry.key]
        rows.append(
            PersonRow(
                entry,
                classify(entry, candidates),
                suggested,
                [(c, blocks.get(c.person.id)) for c in candidates],
            )
        )
    return WarehousePeople(company_id, company[1] if company else None, rows)


# --- writes ---------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class NewPerson:
    first_name: str
    last_name: str
    company_id: uuid.UUID
    civility: Civility | None = None


def serialize(session: Session) -> None:
    """One writer of warehouse records at a time, until the transaction ends: what is compared
    for duplicates (people, companies) cannot appear meanwhile. Taken before any row lock."""
    session.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended("viper.warehouse_records", 0)))
    )


def _require_person(actor: ActorContext) -> None:
    if actor.type not in (ActorType.HUMAN, ActorType.SYSTEM):
        raise ActorNotAllowedError("A warehouse person is linked by a person or the operator.")


def _entry(warehouse: Warehouse, contact_name: str) -> Entry:
    key = name_key(contact_name)
    found = next((e for e in entries(warehouse) if e.key == key), None)
    if found is None:
        raise NotFoundError("This person is no longer in the warehouse listing: reload it.")
    return found


def _linked(session: Session, warehouse_id: uuid.UUID, key: str) -> uuid.UUID | None:
    return session.scalar(
        select(WarehousePerson.prospect_id).where(
            WarehousePerson.warehouse_id == warehouse_id, WarehousePerson.contact_key == key
        )
    )


def _attach(
    session: Session,
    actor: ActorContext,
    warehouse: Warehouse,
    entry: Entry,
    prospect_id: uuid.UUID,
) -> None:
    prospect = prospects.get_prospect(session, prospect_id)
    session.add(
        WarehousePerson(
            warehouse_id=warehouse.id,
            contact_key=entry.key,
            contact_name=entry.contact_name,
            prospect_id=prospect.id,
            linked_by_display=actor.display,
        )
    )
    # A person without any address gets the listing's: an existing choice is never changed.
    if entry.addresses and not any(email.is_active for email in prospect.emails):
        prospects.add_channels(
            session,
            actor,
            prospect,
            emails=[
                prospects.ChannelInput(
                    address,
                    is_primary=len(entry.addresses) == 1,
                    origin_type=OriginType.IMPORTED,
                    source_reference=f"Entrepôt « {warehouse.name} »",
                )
                for address in entry.addresses
            ],
        )
    drafts = session.scalars(
        select(WarehouseDraft)
        .where(WarehouseDraft.warehouse_id == warehouse.id, WarehouseDraft.prospect_id.is_(None))
        .order_by(WarehouseDraft.id)
        .with_for_update()
    ).all()
    for draft in drafts:
        if name_key(draft.contact_name) == entry.key:
            draft.prospect_id = prospect.id
    session.flush()
    audit.record_event(
        session,
        actor,
        "warehouse.person_linked",
        entity_type="warehouse",
        entity_id=warehouse.id,
        subject=("prospect", prospect.id),
    )
    # The opposition and the other blocks apply to their warehouse mails too.
    block = eligibility.block_of(session, prospect.id)
    if block is not None:
        stop_warehouse_drafts(
            session,
            actor,
            WarehouseDraft.prospect_id == prospect.id,
            block.value,
            datetime.now(UTC),
        )
    warehouse_history.carry(session, actor, prospect.id)
    logger.info("warehouse_people.linked warehouse=%s prospect=%s", warehouse.id, prospect.id)


def link(
    session: Session,
    actor: ActorContext,
    warehouse_id: uuid.UUID,
    contact_name: str,
    prospect_id: uuid.UUID,
) -> uuid.UUID:
    """This listing entry is that prospect (a person's decision). Linking the same one again only
    counts the mails sent since; another one is refused (409 `already_linked`)."""
    _require_person(actor)
    serialize(session)
    warehouse = _warehouse(session, warehouse_id, lock=True)
    entry = _entry(warehouse, contact_name)
    current = _linked(session, warehouse.id, entry.key)
    if current is not None:
        if current != prospect_id:
            raise BusinessRuleError(
                "already_linked",
                HTTPStatus.CONFLICT,
                "This person is already linked to another prospect: reload the warehouse.",
            )
        warehouse_history.carry(session, actor, current)
        return current
    _attach(session, actor, warehouse, entry, prospect_id)
    return prospect_id


def create(
    session: Session,
    actor: ActorContext,
    warehouse_id: uuid.UUID,
    contact_name: str,
    data: NewPerson,
    *,
    distinct_confirmed: bool = False,
    directory: Directory | None = None,
) -> uuid.UUID:
    """A new prospect for the entry. Refused while the base holds the same person (409
    `person_exists`: link them) — and, unless a person says it is someone else, any look-alike
    (409 `person_to_confirm`); an address of someone under « Ne pas contacter » is never given to
    a new record."""
    _require_person(actor)
    serialize(session)
    warehouse = _warehouse(session, warehouse_id, lock=True)
    entry = _entry(warehouse, contact_name)
    if _linked(session, warehouse.id, entry.key) is not None:
        raise BusinessRuleError(
            "already_linked",
            HTTPStatus.CONFLICT,
            "This person is already a prospect: reload the warehouse.",
        )
    first, last = " ".join(data.first_name.split()), " ".join(data.last_name.split())
    for name, value in (("first_name", first), ("last_name", last)):
        if not value:
            raise InvalidFieldError(name, "A first and a last name are required.", "required")
        if len(value) > NAME_MAX:
            raise InvalidFieldError(name, "This name is too long.", "too_long")
    company_name = session.scalar(select(Company.display_name).where(Company.id == data.company_id))
    if company_name is None:
        raise InvalidFieldError("company_id", "Unknown company.", "unknown")
    directory = directory or Directory.load(session)
    # Both the listing's name and the name typed are compared.
    typed = Entry(
        name_key(f"{first} {last}"), entry.kind, f"{first} {last}", entry.role, entry.addresses
    )
    found = {
        c.person.id: c
        for compared in (entry, typed)
        for c in directory.candidates(compared, data.company_id)
    }
    if found:
        blocks = eligibility.blocks_of(session, list(found))
        ids = [str(i) for i in found]
        if any(
            c.same_person
            or ("same_email" in c.reasons and blocks.get(i) == eligibility.Block.DO_NOT_CONTACT)
            for i, c in found.items()
        ):
            raise BusinessRuleError(
                "person_exists",
                HTTPStatus.CONFLICT,
                "This person is already in the base: link the existing record.",
                prospect_ids=ids,
            )
        if not distinct_confirmed:
            raise BusinessRuleError(
                "person_to_confirm",
                HTTPStatus.CONFLICT,
                "Someone alike is in the base: link them, or confirm it is another person.",
                prospect_ids=ids,
            )
    prospect = prospects.create_prospect(
        session,
        actor,
        prospects.ProspectInput(
            first_name=first,
            last_name=last,
            civility=data.civility,
            company_id=data.company_id,
            exact_job_title=(entry.role or "").strip()[:TITLE_MAX] or None,
        ),
    )
    reference = f"Entrepôt « {warehouse.name} »"
    if warehouse.source_reference:
        reference += f" · {warehouse.source_reference}"
    provenance.add_source(
        session,
        actor,
        prospect.id,
        ProspectSourceType.OTHER,
        source_reference=reference,
        legal_basis_or_collection_context=LEGAL_CONTEXT,
    )
    _attach(session, actor, warehouse, entry, prospect.id)
    directory.add(Known(prospect.id, first, last, data.company_id, company_name), entry.addresses)
    return prospect.id


# --- the operator's backfill ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BackfillLine:
    # linked | to_link | to_create | ambiguous | no_company | owner | incomplete | not_a_person
    status: str
    warehouse: str
    contact_name: str
    detail: str = ""


def backfill(session: Session, actor: ActorContext) -> list[BackfillLine]:
    """Link every unambiguous match and create the clearly new people of warehouses that have an
    owning company; list everything else. An owner is linked but never created (the listing's
    owner is often a company). Running it again changes nothing."""
    serialize(session)
    directory = Directory.load(session)
    lines: list[BackfillLine] = []
    warehouses = session.scalars(select(Warehouse).order_by(Warehouse.name, Warehouse.id)).all()
    for warehouse in warehouses:
        company = _company_of(session, warehouse)
        company_id = company[0] if company else None
        for entry in entries(warehouse):
            line = _backfill_one(session, actor, directory, warehouse, entry, company_id)
            lines.append(BackfillLine(line[0], warehouse.name, entry.contact_name, line[1]))
    return lines


def _backfill_one(
    session: Session,
    actor: ActorContext,
    directory: Directory,
    warehouse: Warehouse,
    entry: Entry,
    company_id: uuid.UUID | None,
) -> tuple[str, str]:
    linked = _linked(session, warehouse.id, entry.key)
    if linked is not None:
        # Mails sent since the link are counted.
        warehouse_history.carry(session, actor, linked)
        return "linked", str(linked)
    candidates = directory.candidates(entry, company_id)
    status = classify(entry, candidates)
    seen = ", ".join(
        f"{c.person.first_name} {c.person.last_name} [{', '.join(c.reasons)}] {c.person.id}"
        for c in candidates
    )
    if status == "match":
        link(session, actor, warehouse.id, entry.contact_name, candidates[0].person.id)
        return "to_link", seen
    if status != "new":
        return status, seen
    name = read_name(entry.contact_name)
    split = f"prénom « {name.first_name} », nom « {name.last_name} »"
    if entry.kind == "owner":
        return "owner", split
    if company_id is None:
        return "no_company", split
    if max(len(name.first_name), len(name.last_name)) > NAME_MAX:
        return "incomplete", split
    create(
        session,
        actor,
        warehouse.id,
        entry.contact_name,
        NewPerson(name.first_name, name.last_name, company_id, name.civility),
        directory=directory,
    )
    return "to_create", split
