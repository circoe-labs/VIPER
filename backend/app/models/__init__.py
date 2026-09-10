"""ORM models. Import every model module here so Alembic autogenerate sees it."""

from app.models.audit import AuditLogEntry
from app.models.companies import Company, Establishment, company_activity_categories
from app.models.contact_tracking import ContactTracking, ContactTrackingStatusHistory
from app.models.imports import ImportBatch, ImportRowMetadata
from app.models.prospects import Email, Phone, Prospect, ProspectSource
from app.models.taxonomies import ActivityCategory, CommercialSegment, InternalReferent, Role
from app.models.users import User, UserSession

__all__ = [
    "ActivityCategory",
    "AuditLogEntry",
    "CommercialSegment",
    "Company",
    "ContactTracking",
    "ContactTrackingStatusHistory",
    "Email",
    "Establishment",
    "ImportBatch",
    "ImportRowMetadata",
    "InternalReferent",
    "Phone",
    "Prospect",
    "ProspectSource",
    "Role",
    "User",
    "UserSession",
    "company_activity_categories",
]
