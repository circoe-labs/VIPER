"""Builds the engine's `ImportReferenceData` snapshot from the database. Read-only: SELECTs only.

The only module of the import package that touches the database; the engine itself receives the
snapshot as a plain value.
"""

import uuid
from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.taxonomies import ActivityCategory, CommercialSegment, Role
from app.repositories import import_reference
from app.repositories.taxonomies import TaxonomyModel
from app.services.imports.reference import (
    ImportReferenceData,
    ReferenceCompany,
    ReferenceProspect,
    ReferenceReferent,
    ReferenceTaxonomy,
)


def taxonomy(session: Session, model: TaxonomyModel) -> tuple[ReferenceTaxonomy, ...]:
    return tuple(
        ReferenceTaxonomy(id=id_, label=label, slug=slug, active=active)
        for id_, label, slug, active in import_reference.taxonomy_rows(session, model)
    )


def load_reference_data(session: Session) -> ImportReferenceData:
    emails: dict[uuid.UUID, list[str]] = defaultdict(list)
    for prospect_id, address in import_reference.email_rows(session):
        emails[prospect_id].append(address)
    return ImportReferenceData(
        roles=taxonomy(session, Role),
        activity_categories=taxonomy(session, ActivityCategory),
        commercial_segments=taxonomy(session, CommercialSegment),
        referents=tuple(
            ReferenceReferent(id=id_, first_name=first, last_name=last, email=email, active=active)
            for id_, first, last, email, active in import_reference.referent_rows(session)
        ),
        companies=tuple(
            ReferenceCompany(id=id_, display_name=name, legal_name=legal, email_domain=domain)
            for id_, name, legal, domain in import_reference.company_rows(session)
        ),
        prospects=tuple(
            ReferenceProspect(
                id=id_,
                first_name=first,
                last_name=last,
                company_id=company_id,
                contactability_status=contactability,
                emails=tuple(emails[id_]),
            )
            for id_, first, last, company_id, contactability in import_reference.prospect_rows(
                session
            )
        ),
    )
