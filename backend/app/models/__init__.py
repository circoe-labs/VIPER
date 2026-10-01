"""ORM models. Import every model module here so Alembic autogenerate sees it."""

from app.models.app_settings import AppSetting
from app.models.audit import AuditLogEntry
from app.models.companies import Company, Establishment, company_activity_categories
from app.models.contact_messages import ContactMessage
from app.models.contact_sequences import Cohort, ContactSequence
from app.models.contact_tracking import ContactTracking, ContactTrackingStatusHistory
from app.models.imports import ImportBatch, ImportRowMetadata
from app.models.prospects import Email, Phone, Prospect, ProspectSource
from app.models.quality_alerts import QualityAlert
from app.models.taxonomies import ActivityCategory, CommercialSegment, InternalReferent, Role
from app.models.users import User, UserSession

__all__ = [
    "ActivityCategory",
    "AppSetting",
    "AuditLogEntry",
    "Cohort",
    "CommercialSegment",
    "Company",
    "ContactMessage",
    "ContactSequence",
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
    "QualityAlert",
    "Role",
    "User",
    "UserSession",
    "company_activity_categories",
]
