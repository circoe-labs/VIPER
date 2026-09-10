"""Who performs a mutation.

Every mutation service takes an `ActorContext` as its second argument and snapshots it onto
history/audit rows. It is always built server-side, never read from a request payload:

- HTTP: routes declare `actor: CurrentActor` (`app.api.dependencies`), which builds
  `ActorContext(type=HUMAN, id=<user UUID>, display=<display name>)` from the authenticated
  session (`app.services.auth.actor_for`);
- imports, CLI jobs and future agents construct their own `IMPORT` / `SYSTEM` / `AGENT` context.
"""

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
    # Opaque: a `users.id` UUID for humans, any stable identifier for other actor kinds.
    id: str | None = None
