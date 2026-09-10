"""The user's review decisions for one import (Task 09): typed, validated, JSON-ready.

Decisions are **overrides**: anything the client leaves out takes the default the review proposes
(`review.build_review`), and the defaults never apply a suggestion that needs a confirmation, never
invent a year and never create a taxonomy value. Grouped decisions are keyed by the review's group
keys (folded raw values), row decisions by source row number.
"""

import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.models.enums import Civility
from app.services.imports.fields import ImportField
from app.services.imports.layout import ImportMapping

MAX_KEYS = 5000  # the engine's row limit
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Correction = Annotated[str, StringConstraints(max_length=1000)] | None
Year = Annotated[int, Field(ge=2000, le=2100)]


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --- Role (`Fonction`), keyed by the folded job title ---------------------------------------------


class RoleNone(Decision):
    action: Literal["none"] = "none"


class RoleExisting(Decision):
    action: Literal["existing"] = "existing"
    role_id: uuid.UUID


class RoleCreate(Decision):
    """Create the role at commit time, through the audited Settings service, by the user."""

    action: Literal["create"] = "create"
    label: Label


RoleDecision = Annotated[RoleNone | RoleExisting | RoleCreate, Field(discriminator="action")]


# --- Activity category (`Catégorie`), keyed by the folded category token -------------------------


class CategoryIgnore(Decision):
    action: Literal["ignore"] = "ignore"


class CategoryExisting(Decision):
    action: Literal["existing"] = "existing"
    category_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class CategoryCreate(Decision):
    action: Literal["create"] = "create"
    label: Label


class CategorySegment(Decision):
    """The token names a commercial segment: set it on the company (when it has none)."""

    action: Literal["segment"] = "segment"
    segment_id: uuid.UUID


CategoryDecision = Annotated[
    CategoryIgnore | CategoryExisting | CategoryCreate | CategorySegment,
    Field(discriminator="action"),
]


# --- Internal referent (`Référent`), keyed by the folded raw value -------------------------------


class ReferentIgnore(Decision):
    action: Literal["ignore"] = "ignore"


class ReferentExisting(Decision):
    action: Literal["existing"] = "existing"
    referent_id: uuid.UUID


ReferentDecision = Annotated[ReferentIgnore | ReferentExisting, Field(discriminator="action")]


# --- Company, keyed by the engine's company key -------------------------------------------------


class CompanyCreate(Decision):
    action: Literal["create"] = "create"


class CompanyLink(Decision):
    action: Literal["link"] = "link"
    company_id: uuid.UUID


CompanyDecision = Annotated[CompanyCreate | CompanyLink, Field(discriminator="action")]


# --- Prospect resolution, per row ---------------------------------------------------------------


class ProspectCreate(Decision):
    action: Literal["create"] = "create"


class ProspectAttach(Decision):
    """Merge the row into an existing prospect (one of its duplicate candidates)."""

    action: Literal["attach"] = "attach"
    prospect_id: uuid.UUID


class ProspectAttachRow(Decision):
    """Merge the row into the prospect imported from another row of the file."""

    action: Literal["attach_row"] = "attach_row"
    row: int = Field(gt=0)


class ProspectExclude(Decision):
    action: Literal["exclude"] = "exclude"


ProspectResolution = Annotated[
    ProspectCreate | ProspectAttach | ProspectAttachRow | ProspectExclude,
    Field(discriminator="action"),
]


class RowDecision(Decision):
    resolution: ProspectResolution | None = None  # None: the review's default
    # Confirm the engine's `inactive` suggestion (`retraité`…). Only for rows that have one.
    inactive: bool = False


class PreviewOptions(Decision):
    """What shapes the preview itself: layout overrides and per-cell corrections (only the
    engine's `CORRECTABLE_FIELDS`; the engine refuses the others)."""

    mapping: ImportMapping | None = None
    corrections: dict[int, dict[ImportField, Correction]] = Field(
        default_factory=dict, max_length=MAX_KEYS
    )


class ImportDecisions(PreviewOptions):
    """Everything the commit needs besides the file. The file fingerprint and the preview digest
    tie the decisions to the exact preview the user reviewed."""

    file_fingerprint: Sha256
    preview_digest: Sha256
    legal_basis_or_collection_context: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
    ]
    source_reference: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""
    # The same file was already committed: the user saw the warning and imports it again.
    acknowledge_reimport: bool = False
    roles: dict[str, RoleDecision] = Field(default_factory=dict, max_length=MAX_KEYS)
    categories: dict[str, CategoryDecision] = Field(default_factory=dict, max_length=MAX_KEYS)
    referents: dict[str, ReferentDecision] = Field(default_factory=dict, max_length=MAX_KEYS)
    civilities: dict[str, Civility | None] = Field(default_factory=dict, max_length=MAX_KEYS)
    # Year of every week written without one (`S37`), unless `weeks` says otherwise for that week.
    week_year: Year | None = None
    weeks: dict[str, Year | None] = Field(default_factory=dict, max_length=60)
    companies: dict[str, CompanyDecision] = Field(default_factory=dict, max_length=MAX_KEYS)
    rows: dict[int, RowDecision] = Field(default_factory=dict, max_length=MAX_KEYS)
