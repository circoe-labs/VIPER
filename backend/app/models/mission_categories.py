"""Mission categories and instruction skills (task `viper_mission_agent_configuration_v2`, S1).

A **category** is admin-managed product taxonomy (« Prospection », « Veille concurrents »…): a name,
a description, an icon, a colour and a *general prompt*. It replaces the fixed `MissionType` enum
as what the person picks and sees, but the enum stays the **technical execution discriminator**:
each category maps to one `mission_type` that the task-generation code routes on
(`app.services.missions.check_runnable`, `agent_payloads`). The mapping is chosen when the category
is created and never changes, so an edit of the taxonomy cannot re-route a running mission.

A **skill** is a reusable block of instruction text (no tool or capability grant). Categories carry
default skills (`mission_category_skills`); a mission follows them until it overrides them
(`mission_skill_links`, written only when `skills` is in `Mission.overridden_fields`).

Contract: `doc/architecture/missions.md` § « Catégories, skills et héritage ».
"""

import uuid

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import MissionType
from app.models.organizations import OrganizationOwnedMixin

CATEGORY_NAME_MAX_LENGTH = 100
CATEGORY_DESCRIPTION_MAX_LENGTH = 500
CATEGORY_ICON_MAX_LENGTH = 40
CATEGORY_PROMPT_MAX_LENGTH = 5000
SKILL_NAME_MAX_LENGTH = 100
SKILL_DESCRIPTION_MAX_LENGTH = 500
SKILL_CONTENT_MAX_LENGTH = 5000
# `#RRGGBB`: the stable visual identity a mission card takes from its category.
COLOR_PATTERN = r"^#[0-9a-fA-F]{6}$"
# A glyph key the front end resolves (`frontend/src/ui/icons.tsx`), never markup.
ICON_PATTERN = r"^[a-z0-9]+(-[a-z0-9]+)*$"
# Mission fields that follow their category until a person overrides them.
INHERITABLE_FIELDS = ("prompt", "skills", "sources")


class MissionCategory(UUIDPrimaryKeyMixin, OrganizationOwnedMixin, TimestampMixin, Base):
    """What a person calls a kind of mission; `mission_type` is how VIPER executes it."""

    __tablename__ = "mission_categories"
    __table_args__ = (
        CheckConstraint(
            f"btrim(name) <> '' AND char_length(name) <= {CATEGORY_NAME_MAX_LENGTH}",
            name="name_valid",
        ),
        CheckConstraint(
            f"btrim(general_prompt) <> '' AND char_length(general_prompt) <= "
            f"{CATEGORY_PROMPT_MAX_LENGTH}",
            name="prompt_valid",
        ),
        CheckConstraint(f"color ~ '{COLOR_PATTERN}'", name="color_format"),
        CheckConstraint(f"icon ~ '{ICON_PATTERN}'", name="icon_format"),
        Index(
            "uq_mission_categories_organization_name",
            "organization_id",
            func.lower("name"),
            unique=True,
        ),
        # A system category is the seeded one of a technical type: one per type and organisation.
        Index(
            "uq_mission_categories_organization_key",
            "organization_id",
            "key",
            unique=True,
            postgresql_where="key IS NOT NULL",
        ),
    )

    # Seeded categories carry their `MissionType` value here; NULL for an admin-created one. A
    # keyed category cannot be deleted (a mission created from a bare type resolves to it).
    key: Mapped[str | None] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(CATEGORY_NAME_MAX_LENGTH))
    description: Mapped[str | None] = mapped_column(String(CATEGORY_DESCRIPTION_MAX_LENGTH))
    icon: Mapped[str] = mapped_column(String(CATEGORY_ICON_MAX_LENGTH))
    color: Mapped[str] = mapped_column(String(7))
    general_prompt: Mapped[str] = mapped_column(Text)
    # The technical execution discriminator: immutable once the category exists.
    mission_type: Mapped[MissionType] = mapped_column(text_enum(MissionType, "mission_type"))
    position: Mapped[int] = mapped_column(Integer, server_default="0")


class MissionSkill(UUIDPrimaryKeyMixin, OrganizationOwnedMixin, TimestampMixin, Base):
    """A reusable block of instruction text. Text only: it grants no tool or capability."""

    __tablename__ = "mission_skills"
    __table_args__ = (
        CheckConstraint(
            f"btrim(name) <> '' AND char_length(name) <= {SKILL_NAME_MAX_LENGTH}",
            name="name_valid",
        ),
        CheckConstraint(
            f"btrim(content) <> '' AND char_length(content) <= {SKILL_CONTENT_MAX_LENGTH}",
            name="content_valid",
        ),
        Index(
            "uq_mission_skills_organization_name",
            "organization_id",
            func.lower("name"),
            unique=True,
        ),
    )

    name: Mapped[str] = mapped_column(String(SKILL_NAME_MAX_LENGTH))
    description: Mapped[str | None] = mapped_column(String(SKILL_DESCRIPTION_MAX_LENGTH))
    content: Mapped[str] = mapped_column(Text)


class MissionCategorySkill(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A skill that is a default of a category (many-to-many, ordered)."""

    __tablename__ = "mission_category_skills"
    __table_args__ = (
        Index("uq_mission_category_skills_pair", "category_id", "skill_id", unique=True),
    )

    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mission_categories.id", ondelete="CASCADE"), index=True
    )
    # Deleting a skill detaches it everywhere (the service reports how many places it left).
    skill_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mission_skills.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(SmallInteger, server_default="0")


class MissionSkillLink(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A skill a mission uses **instead of** its category's defaults (override of `skills`)."""

    __tablename__ = "mission_skill_links"
    __table_args__ = (Index("uq_mission_skill_links_pair", "mission_id", "skill_id", unique=True),)

    mission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("missions.id", ondelete="CASCADE"), index=True
    )
    skill_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mission_skills.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(SmallInteger, server_default="0")
