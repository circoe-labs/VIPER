"""Steps and levels of a contact sequence (sequences rework D1, D2, D6): pure names shared by the
models, the services and the API.

- A **step** is a rank of the sequence: 0 = the Contact mail, n = the follow-up Rn. Its code
  (`contact`, `r1`, `r2`…) addresses it in the API, its label (« Contact », « R1 »…) is shown.
  The ranks are unlimited in storage; the editor and the planning open them up to « max
  relances » (Paramètres, 4 by default, at most `MAX_FOLLOW_UPS_LIMIT`).
- A **level** is where a sequence stands after its real sends, for the weekly distribution:
  nothing sent (`contact_pending`), the Contact sent (`contact_sent`), Rn sent (`r<n>_sent`, for
  n below the maximum) and « Relance terminée » (`finished`: R<max> sent, or the sequence closed
  `completed`). `level_key` is the Python twin of `contact_sequences.level_key_sql`.
"""

import re

CONTACT_RANK = 0
# « Max relances » when Paramètres has no value (D2), and its upper bound (Q4).
DEFAULT_MAX_FOLLOW_UPS = 4
MAX_FOLLOW_UPS_LIMIT = 20

STEP_CODE = re.compile(r"contact|r([1-9][0-9]?)")
# The path pattern of a step code (`contact`, `r1` … `r99`); the service checks the maximum.
STEP_CODE_PATTERN = r"^(contact|r[1-9][0-9]?)$"

FINISHED_LABEL = "Relance terminée"
CONTACT_PENDING = "contact_pending"
CONTACT_SENT = "contact_sent"
FINISHED = "finished"
LEVEL_CODE = re.compile(r"contact_pending|contact_sent|finished|r([1-9][0-9]?)_sent")


def step_code(rank: int) -> str:
    """`contact`, `r1`, `r2`…: the stable code of a rank."""
    return "contact" if rank == CONTACT_RANK else f"r{rank}"


def step_label(rank: int) -> str:
    """« Contact », « R1 », « R2 »…"""
    return "Contact" if rank == CONTACT_RANK else f"R{rank}"


def parse_step(code: str) -> int | None:
    """The rank of a step code (`contact` → 0, `r3` → 3); None for anything else."""
    match = STEP_CODE.fullmatch(code.strip().lower())
    if match is None:
        return None
    return int(match[1]) if match[1] else CONTACT_RANK


def level_key(sent_count: int, finished: bool) -> str:
    """The level of a sequence: `contact_pending`, `contact_sent`, `r<n>_sent` or `finished`."""
    if finished:
        return FINISHED
    if sent_count == 0:
        return CONTACT_PENDING
    if sent_count == 1:
        return CONTACT_SENT
    return f"r{sent_count - 1}_sent"


def level_keys(max_follow_ups: int) -> list[str]:
    """Every level a sequence can be at under « max relances », in order: nothing sent, Contact
    sent, R1 sent … R<max-1> sent, « Relance terminée » (R<max> sent finishes the sequence)."""
    return [level_key(sent, False) for sent in range(max_follow_ups + 1)] + [FINISHED]


def level_label(key: str) -> str:
    """« Contact à envoyer », « Contact envoyé », « R2 envoyée », « Relance terminée »."""
    if key == CONTACT_PENDING:
        return "Contact à envoyer"
    if key == CONTACT_SENT:
        return "Contact envoyé"
    if key == FINISHED:
        return FINISHED_LABEL
    match = LEVEL_CODE.fullmatch(key)
    if match is None or match[1] is None:
        raise ValueError(f"Unknown level {key!r}.")
    return f"R{match[1]} envoyée"


def level_sent_count(key: str) -> int | None:
    """The number of real sends of a level (None for `finished`, which depends on the maximum)."""
    if key == CONTACT_PENDING:
        return 0
    if key == CONTACT_SENT:
        return 1
    match = LEVEL_CODE.fullmatch(key)
    if match is None or match[1] is None:
        return None
    return int(match[1]) + 1
