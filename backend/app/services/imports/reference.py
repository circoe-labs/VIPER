"""Reference data snapshot the engine matches against: a plain value, never a database handle.

Built from the database by `reference_loader.load_reference_data` (Task 09) or directly by tests.
Inactive taxonomy values and referents are included so an exact match on a deactivated value is
reported (reactivate instead of creating a duplicate label) rather than silently missed.
"""

import uuid
from dataclasses import dataclass

from app.models.enums import ContactabilityStatus


@dataclass(frozen=True, slots=True)
class ReferenceTaxonomy:
    """A role, activity category or commercial segment."""

    id: uuid.UUID
    label: str
    slug: str
    active: bool = True


@dataclass(frozen=True, slots=True)
class ReferenceReferent:
    id: uuid.UUID
    first_name: str
    last_name: str
    email: str | None = None
    active: bool = True

    @property
    def display(self) -> str:
        return f"{self.first_name} {self.last_name}"


@dataclass(frozen=True, slots=True)
class ReferenceCompany:
    id: uuid.UUID
    display_name: str
    legal_name: str | None = None
    email_domain: str | None = None


@dataclass(frozen=True, slots=True)
class ReferenceProspect:
    id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_id: uuid.UUID | None = None
    contactability_status: ContactabilityStatus = ContactabilityStatus.CONTACTABLE
    emails: tuple[str, ...] = ()  # normalized addresses, active or not


@dataclass(frozen=True, slots=True)
class ImportReferenceData:
    roles: tuple[ReferenceTaxonomy, ...] = ()
    activity_categories: tuple[ReferenceTaxonomy, ...] = ()
    commercial_segments: tuple[ReferenceTaxonomy, ...] = ()
    referents: tuple[ReferenceReferent, ...] = ()
    companies: tuple[ReferenceCompany, ...] = ()
    prospects: tuple[ReferenceProspect, ...] = ()


EMPTY_REFERENCE = ImportReferenceData()
