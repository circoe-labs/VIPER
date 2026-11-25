"""The import agent's reading plan: the **structure** of a workbook, never its values.

The agent (`agent.py`) says where the tables are, what each column means, which spellings name one
company and how to split an ambiguous full name. Everything imported is still read from the cells
by the deterministic engine (`plan_reader`), so a plan cannot invent data; and the plan travels
with the review and the commit (`ImportMapping.plan`), so both read the file identically.
"""

from pydantic import BaseModel, ConfigDict, Field

from app.services.imports.fields import ImportField

MAX_BLOCKS = 200


class PlanModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PlanColumn(PlanModel):
    column: str = Field(pattern=r"^[A-Z]{1,3}$")
    field: ImportField


class PlanBlock(PlanModel):
    """Consecutive rows of one sheet sharing one column layout."""

    sheet: str = Field(max_length=255)
    header_row: int | None = None
    first_row: int = Field(ge=1)
    last_row: int = Field(ge=1)
    columns: list[PlanColumn] = Field(max_length=100)
    # Extra columns (a company switchboard…) copied down like the company-level ones.
    carry_down: list[str] = Field(default_factory=list, max_length=100)


class PlanCompanyGroup(PlanModel):
    """Spellings of the file that name one company; the first one is the reference."""

    names: list[str] = Field(max_length=50)


class PlanName(PlanModel):
    sheet: str = Field(max_length=255)
    row: int = Field(ge=1)
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)


class ImportPlanSpec(PlanModel):
    blocks: list[PlanBlock] = Field(max_length=MAX_BLOCKS)
    same_companies: list[PlanCompanyGroup] = Field(default_factory=list, max_length=2000)
    names: list[PlanName] = Field(default_factory=list, max_length=5000)
    # What the agent wants the person to know, in French.
    notes: list[str] = Field(default_factory=list, max_length=40)
