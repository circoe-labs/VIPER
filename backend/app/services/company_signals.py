"""Signals stored for a company and its people, as the company page reads them.

A signal is a `prospect_notes` row with a company or a prospect subject; this module joins the two
so the page can say « 2SN — Recrutement » or « Marie Dupont — Besoin exprimé » without a second
concept. Read-only: acceptance writes the row (`app.services.agent_review`).
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.companies import Company
from app.models.enums import SignalKind, SignalOrigin
from app.models.prospects import Prospect, ProspectNote
from app.services.errors import NotFoundError


@dataclass(frozen=True, slots=True)
class CompanySignalRow:
    id: uuid.UUID
    kind: SignalKind | None
    signal: str
    source_url: str | None
    observed_on: date | None
    valid_until: date | None
    relevance: int | None
    score_delta: int | None
    origin: SignalOrigin
    subject: str


def list_signals(session: Session, company_id: uuid.UUID) -> list[CompanySignalRow]:
    """Every signal attached to the company or to one of its people, newest first."""
    company = session.get(Company, company_id)
    if company is None:
        raise NotFoundError("Unknown company.")
    people = {
        prospect.id: prospect
        for prospect in session.scalars(
            select(Prospect).where(Prospect.company_id == company_id)
        )
    }
    notes = session.scalars(
        select(ProspectNote)
        .where(
            or_(
                ProspectNote.company_id == company_id,
                ProspectNote.prospect_id.in_(list(people)),
            )
        )
        .order_by(
            ProspectNote.observed_on.desc().nulls_last(),
            ProspectNote.created_at.desc(),
        )
    ).all()
    rows: list[CompanySignalRow] = []
    for note in notes:
        if note.prospect_id is not None:
            person = people.get(note.prospect_id)
            subject = (
                " ".join(part for part in (person.first_name, person.last_name) if part)
                if person is not None
                else "Personne supprimée"
            )
        else:
            subject = company.display_name
        rows.append(
            CompanySignalRow(
                id=note.id,
                kind=note.kind,
                signal=note.fact_text,
                source_url=note.source_url,
                observed_on=note.observed_on or note.noted_on,
                valid_until=note.valid_until,
                relevance=note.relevance,
                score_delta=note.score_delta,
                origin=note.origin,
                subject=subject,
            )
        )
    return rows
