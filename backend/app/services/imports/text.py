"""Text helpers of the import engine: folding for comparisons, cell rendering, JSON values."""

import re
import unicodedata
from datetime import date, datetime, time, timedelta

type CellValue = str | int | float | bool | datetime | date | time | timedelta | None
type JsonScalar = str | int | float | bool | None

# Ligatures folded to letters; typographic apostrophe and (narrow) no-break spaces to ASCII.
LIGATURES = str.maketrans(
    {"œ": "oe", "Œ": "OE", "æ": "ae", "Æ": "AE", chr(0x2019): "'", chr(0xA0): " ", chr(0x202F): " "}
)
NON_ALPHANUMERIC = re.compile(r"[^0-9a-z]+")


def fold(text: str) -> str:
    """Comparison key: lowercase, no accents, punctuation as single spaces, trimmed."""
    decomposed = unicodedata.normalize("NFKD", text.translate(LIGATURES))
    bare = "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()
    return " ".join(NON_ALPHANUMERIC.sub(" ", bare).split())


def is_blank(value: CellValue) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def render(value: CellValue) -> str:
    """Cell value as the text a user sees (numbers without a spurious `.0`, ISO dates)."""
    match value:
        case None:
            return ""
        case str():
            return value
        case bool():
            return "VRAI" if value else "FAUX"
        case float() if value.is_integer():
            return str(int(value))
        case datetime() if value.time() == time():
            return value.date().isoformat()
        case datetime() | date() | time():
            return value.isoformat()
        case _:
            return str(value)


def single_line(value: CellValue) -> str | None:
    """Rendered text on one line with collapsed whitespace; None when blank."""
    text = " ".join(render(value).translate(LIGATURES).split())
    return text or None


def multi_line(value: CellValue) -> str | None:
    """Rendered text keeping line breaks (lines trimmed, blank ones dropped); None when blank."""
    lines = (" ".join(line.split()) for line in render(value).translate(LIGATURES).splitlines())
    text = "\n".join(line for line in lines if line)
    return text or None


def json_value(value: CellValue) -> JsonScalar:
    """Raw cell value in a JSON-safe form, as close to the source as possible."""
    if isinstance(value, datetime | date | time | timedelta):
        return render(value)
    return value
