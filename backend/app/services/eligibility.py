"""Who may be prospected: the one owner of the rule (`doc/features/prospecting-lifecycle.md`).

A person is **eligible** unless one of these blocks applies, in this order (the first one is the
reason shown):

1. `prospect_do_not_contact`: the durable opposition (never lifted by anything here);
2. `prospect_departed`: `activity_status = inactive` (retired, left the company…): the former
   job is not prospected;
3. `prospect_archived` / `company_archived`: the record, or its company, is archived;
4. `prospect_excluded` / `company_excluded`: temporarily excluded, until a person brings it back.

Everything is read from the current rows, so a block ends the moment its cause does: nothing is
copied on the prospect. Being **incomplete** is not a block: it is the computed file status
(`segments.Review`), and a completed record is prospectable again by itself.

Every list, counter, queue and export, and every path that prepares or sends a mail, asks here:
`eligible_sql` / `block_sql` over rows with `Prospect` in the FROM, `block_of` for one person,
`warehouse_block` for a warehouse mail (its recipient and its company). Writes live in
`app.services.lifecycle`. This module reads the models only (no import cycle).
"""

import uuid
from collections.abc import Collection
from enum import StrEnum
from typing import Any

from sqlalchemy import ColumnElement, String, case, exists, func, not_, null, or_, select
from sqlalchemy.orm import Session

from app.models import Email, Establishment, Prospect, ProspectingHold, Warehouse, WarehouseDraft
from app.models.enums import ActivityStatus, ContactabilityStatus, HoldKind


class Block(StrEnum):
    """Why a person is not prospectable; the value is also the API refusal code, the
    `cancel_reason` of the messages it cancels and the warehouse `failure_code`."""

    DO_NOT_CONTACT = "prospect_do_not_contact"
    DEPARTED = "prospect_departed"
    PROSPECT_ARCHIVED = "prospect_archived"
    COMPANY_ARCHIVED = "company_archived"
    PROSPECT_EXCLUDED = "prospect_excluded"
    COMPANY_EXCLUDED = "company_excluded"


# The reversible blocks (everything but the opposition, which has its own rules and reason code).
REVERSIBLE_CODES = frozenset(block.value for block in Block if block is not Block.DO_NOT_CONTACT)
# French labels (export, refusals shown as they are).
LABELS: dict[Block, str] = {
    Block.DO_NOT_CONTACT: "Ne pas contacter",
    Block.DEPARTED: "Plus en poste",
    Block.PROSPECT_ARCHIVED: "Fiche archivée",
    Block.COMPANY_ARCHIVED: "Entreprise archivée",
    Block.PROSPECT_EXCLUDED: "Exclu temporairement",
    Block.COMPANY_EXCLUDED: "Entreprise exclue temporairement",
}
# English, for API refusals (the UI words them in French from the code).
MESSAGES: dict[Block, str] = {
    Block.DO_NOT_CONTACT: "The prospect must not be contacted: no message is possible.",
    Block.DEPARTED: "The prospect left the role (retired or gone): no message is possible.",
    Block.PROSPECT_ARCHIVED: "The prospect is archived: no message is possible.",
    Block.COMPANY_ARCHIVED: "The company is archived: no message is possible.",
    Block.PROSPECT_EXCLUDED: "The prospect is excluded from prospecting for now.",
    Block.COMPANY_EXCLUDED: "The company is excluded from prospecting for now.",
}


def _open_hold(kind: HoldKind, *, company: bool) -> ColumnElement[bool]:
    subject = (
        ProspectingHold.company_id == Prospect.company_id
        if company
        else ProspectingHold.prospect_id == Prospect.id
    )
    return exists().where(
        subject, ProspectingHold.kind == kind, ProspectingHold.lifted_at.is_(None)
    )


def _conditions() -> list[tuple[Block, ColumnElement[bool]]]:
    return [
        (
            Block.DO_NOT_CONTACT,
            Prospect.contactability_status == ContactabilityStatus.DO_NOT_CONTACT,
        ),
        (Block.DEPARTED, Prospect.activity_status == ActivityStatus.INACTIVE),
        (Block.PROSPECT_ARCHIVED, _open_hold(HoldKind.ARCHIVE, company=False)),
        (Block.COMPANY_ARCHIVED, _open_hold(HoldKind.ARCHIVE, company=True)),
        (Block.PROSPECT_EXCLUDED, _open_hold(HoldKind.EXCLUSION, company=False)),
        (Block.COMPANY_EXCLUDED, _open_hold(HoldKind.EXCLUSION, company=True)),
    ]


def blocked_sql() -> ColumnElement[bool]:
    """Some block applies to the prospect of the row (never NULL)."""
    return or_(*(condition for _, condition in _conditions()))


def eligible_sql() -> ColumnElement[bool]:
    return not_(blocked_sql())


def block_sql() -> ColumnElement[str | None]:
    """The first block of the row's prospect (a `Block` value), NULL when eligible."""
    return case(
        *((condition, block.value) for block, condition in _conditions()),
        else_=null().cast(String),
    )


def archived_sql() -> ColumnElement[bool]:
    """The person themself is archived (the lists hide them unless asked)."""
    return _open_hold(HoldKind.ARCHIVE, company=False)


def company_archived_sql(company_id: Any) -> ColumnElement[bool]:
    return exists().where(
        ProspectingHold.company_id == company_id,
        ProspectingHold.kind == HoldKind.ARCHIVE,
        ProspectingHold.lifted_at.is_(None),
    )


def block_of(session: Session, prospect_id: uuid.UUID) -> Block | None:
    """The first block of one person, read now; None when eligible (or unknown)."""
    found = session.scalar(select(block_sql()).where(Prospect.id == prospect_id))
    return Block(found) if found else None


def blocks_of(session: Session, prospect_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, str]:
    """The first block of each of these people who has one (one statement)."""
    if not prospect_ids:
        return {}
    rows = session.execute(
        select(Prospect.id, block_sql()).where(Prospect.id.in_(prospect_ids), blocked_sql())
    ).tuples()
    return {prospect_id: code for prospect_id, code in rows if code is not None}


def company_blocks(session: Session, company_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, str]:
    """`company_archived` / `company_excluded` of each of these companies that has one (one
    statement): the block their people get from them."""
    if not company_ids:
        return {}
    rows = session.execute(
        select(ProspectingHold.company_id, ProspectingHold.kind)
        .where(ProspectingHold.company_id.in_(company_ids), ProspectingHold.lifted_at.is_(None))
        # The archive comes last, so it wins over an exclusion.
        .order_by(ProspectingHold.kind.desc())
    ).tuples()
    return {
        company_id: company_block(kind).value for company_id, kind in rows if company_id is not None
    }


def company_block(kind: HoldKind) -> Block:
    return Block.COMPANY_ARCHIVED if kind is HoldKind.ARCHIVE else Block.COMPANY_EXCLUDED


def open_holds(
    session: Session,
    *,
    prospect_id: uuid.UUID | None = None,
    company_id: uuid.UUID | None = None,
) -> list[ProspectingHold]:
    """The open holds of a person and/or a company, oldest first."""
    subjects = []
    if prospect_id is not None:
        subjects.append(ProspectingHold.prospect_id == prospect_id)
    if company_id is not None:
        subjects.append(ProspectingHold.company_id == company_id)
    if not subjects:
        return []
    return list(
        session.scalars(
            select(ProspectingHold)
            .where(or_(*subjects), ProspectingHold.lifted_at.is_(None))
            .order_by(ProspectingHold.placed_at, ProspectingHold.id)
        )
    )


def warehouse_block(session: Session, draft: WarehouseDraft) -> Block | None:
    """Why a warehouse mail may not leave: its person (linked, or holder of the recipient
    address, former ones included) is blocked, or the warehouse's company is archived or
    excluded."""
    recipient = (draft.recipient or "").strip().lower()
    found: set[Block] = set()
    people: list[ColumnElement[bool]] = []
    if recipient:
        people.append(exists().where(Email.prospect_id == Prospect.id, Email.address == recipient))
    if draft.prospect_id is not None:
        people.append(Prospect.id == draft.prospect_id)
    if people:
        found.update(
            Block(code)
            for code in session.scalars(
                select(block_sql()).select_from(Prospect).where(or_(*people), blocked_sql())
            )
            if code
        )
    held = session.scalars(
        select(ProspectingHold.kind)
        .join(Establishment, Establishment.company_id == ProspectingHold.company_id)
        .join(Warehouse, Warehouse.establishment_id == Establishment.id)
        .where(Warehouse.id == draft.warehouse_id, ProspectingHold.lifted_at.is_(None))
    )
    found.update(company_block(kind) for kind in held)
    return next((block for block in Block if block in found), None)


def warehouse_recipients_of(prospect_id: uuid.UUID) -> ColumnElement[bool]:
    """The warehouse drafts of the person: linked to them, or addressed to one of their
    addresses."""
    return or_(
        WarehouseDraft.prospect_id == prospect_id,
        func.lower(func.trim(WarehouseDraft.recipient)).in_(
            select(Email.address).where(Email.prospect_id == prospect_id)
        ),
    )
