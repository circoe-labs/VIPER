"""ORM models. Import every model module here so Alembic autogenerate sees it."""

from app.models.agenda import Appointment
from app.models.agent_missions import AgentTask, AgentTaskResult, AgentThread
from app.models.app_settings import AppSetting
from app.models.audit import AuditLogEntry
from app.models.companies import Company, Establishment, company_activity_categories
from app.models.contact_messages import ContactMessage, ContactMessageRemoteDraftCleanup
from app.models.contact_sequences import Cohort, ContactSequence
from app.models.contact_tracking import ContactTracking, ContactTrackingStatusHistory
from app.models.imports import ImportBatch, ImportRowMetadata
from app.models.mcp import McpToken
from app.models.missions import Mission, MissionRun, MissionTarget
from app.models.oauth import OAuthAuthorization, OAuthClient, OAuthToken
from app.models.organizations import Organization
from app.models.prospects import Email, Phone, Prospect, ProspectNote, ProspectSource
from app.models.quality_alerts import QualityAlert
from app.models.taxonomies import ActivityCategory, CommercialSegment, InternalReferent, Role
from app.models.users import User, UserSession

__all__ = [
    "ActivityCategory",
    "AgentTask",
    "AgentTaskResult",
    "AgentThread",
    "AppSetting",
    "Appointment",
    "AuditLogEntry",
    "Cohort",
    "CommercialSegment",
    "Company",
    "ContactMessage",
    "ContactMessageRemoteDraftCleanup",
    "ContactSequence",
    "ContactTracking",
    "ContactTrackingStatusHistory",
    "Email",
    "Establishment",
    "ImportBatch",
    "ImportRowMetadata",
    "InternalReferent",
    "McpToken",
    "Mission",
    "MissionRun",
    "MissionTarget",
    "OAuthAuthorization",
    "OAuthClient",
    "OAuthToken",
    "Organization",
    "Phone",
    "Prospect",
    "ProspectNote",
    "ProspectSource",
    "QualityAlert",
    "Role",
    "User",
    "UserSession",
    "company_activity_categories",
]
