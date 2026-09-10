"""Who performs a mutation. Services receive an `ActorContext`; Task 04 builds it from the login."""

from dataclasses import dataclass
from enum import StrEnum


class ActorType(StrEnum):
    HUMAN = "human"
    IMPORT = "import"
    SYSTEM = "system"
    AGENT = "agent"


@dataclass(frozen=True, slots=True)
class ActorContext:
    """Server-side actor identity, snapshotted onto history/audit rows; never client-supplied."""

    type: ActorType
    display: str
    id: str | None = None
