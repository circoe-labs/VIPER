"""ORM models. Import every model module here so Alembic autogenerate sees it."""

from app.models.audit import AuditLogEntry
from app.models.companies import Company, Establishment, company_activity_categories
from app.models.contact_messages import ContactMessage, ContactMessageRemoteDraftCleanup
from app.models.contact_tracking import ContactTracking, ContactTrackingStatusHistory
from app.models.imports import ImportBatch, ImportRowMetadata
from app.models.prospects import Email, Phone, Prospect, ProspectNote, ProspectSource
from app.models.taxonomies import ActivityCategory, CommercialSegment, InternalReferent, Role
from app.models.users import User, UserSession

__all__ = [
    "ActivityCategory",
    "AuditLogEntry",
    "CommercialSegment",
    "Company",
    "ContactMessage",
    "ContactMessageRemoteDraftCleanup",
    "ContactTracking",
    "ContactTrackingStatusHistory",
    "Email",
    "Establishment",
    "ImportBatch",
    "ImportRowMetadata",
    "InternalReferent",
    "Phone",
    "Prospect",
    "ProspectNote",
    "ProspectSource",
    "Role",
    "User",
    "UserSession",
    "company_activity_categories",
]
