"""Pure value normalizers: civility, names, emails, phones, planned-contact week, tracking stages,
address. Each returns the normalized value(s), the diagnostic codes raised and whether the raw
value must also be kept in legacy metadata (whenever the conversion is partial or impossible).
"""

import re
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum

from app.models.enums import Civility, PhoneType
from app.services.imports.diagnostics import DiagnosticCode
from app.services.imports.text import CellValue, fold, render, single_line

Codes = tuple[DiagnosticCode, ...]


@dataclass(frozen=True, slots=True)
class Outcome[T]:
    value: T | None = None
    codes: Codes = ()
    keep_raw: bool = False


def is_zero_placeholder(value: CellValue) -> bool:
    """`0` typed in a text column (a spreadsheet habit for "nothing")."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int | float):
        return value == 0
    return isinstance(value, str) and value.strip() == "0"


# --- Civility -----------------------------------------------------------------------------------

MR_FORMS = frozenset({"m", "mr", "monsieur"})
MS_FORMS = frozenset({"mme", "madame", "mlle", "melle", "mademoiselle", "ms", "mrs"})


def normalize_civility(value: CellValue) -> Outcome[Civility]:
    """`M.`, `M`, `MR`, `Monsieur` → mr; `Mme`, `MME.`, `Madame`, `Mlle` → ms; anything else
    (`0`, initials, notes) is invalid and kept raw."""
    key = fold(render(value)).replace(" ", "")
    if key in MR_FORMS:
        return Outcome(Civility.MR)
    if key in MS_FORMS:
        return Outcome(Civility.MS)
    return Outcome(codes=(DiagnosticCode.CIVILITY_INVALID,), keep_raw=True)


# --- Person names -------------------------------------------------------------------------------

PARTICLES = frozenset(
    {"de", "du", "des", "la", "le", "les", "van", "von", "der", "den", "ter", "ten", "di", "da"}
    | {"del", "della", "dos", "das", "do", "zu"}
)
WORD_START = re.compile(r"(?:^|(?<=[-']))\w")


def normalize_name(text: str) -> str:
    """Trimmed, single-spaced. A name typed entirely in upper or lower case gets capitalised
    parts (`JEAN-PIERRE` → `Jean-Pierre`) with inner particles lowercase (`DE LA TOUR` →
    `De la Tour`, `MARIE D'ARC` → `Marie d'Arc`); mixed case is the author's choice and kept."""
    text = " ".join(text.split())
    if not any(char.isalpha() for char in text) or not (text.isupper() or text.islower()):
        return text
    words = text.lower().split(" ")
    return " ".join(style_word(word, first=index == 0) for index, word in enumerate(words))


def style_word(word: str, *, first: bool) -> str:
    if not first and word in PARTICLES:
        return word
    styled = WORD_START.sub(lambda match: match.group(0).upper(), word)
    if not first and styled[:2].lower() in {"d'", "l'"}:
        styled = styled[0].lower() + styled[1:]
    return styled


# --- Emails -------------------------------------------------------------------------------------

EMAIL_SEPARATORS = re.compile(r"[\s;,/|]+")
EMAIL_PATTERN = re.compile(
    r"[a-z0-9!#$%&'*+=?^_`{}~-]+(?:\.[a-z0-9!#$%&'*+=?^_`{}~-]+)*"
    r"@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}"
)
MAX_EMAIL_LENGTH = 320


def parse_emails(value: CellValue) -> Outcome[tuple[str, ...]]:
    """Split on spaces, `;`, `,`, `/`, `|`; lowercase; strip `mailto:` and wrapping punctuation;
    keep syntactically valid addresses in order (the first is the primary candidate)."""
    addresses: list[str] = []
    invalid = False
    for token in EMAIL_SEPARATORS.split(render(value)):
        candidate = token.lower().removeprefix("mailto:").strip("<>()[]\"'.:")
        if not candidate:
            continue
        if EMAIL_PATTERN.fullmatch(candidate) and len(candidate) <= MAX_EMAIL_LENGTH:
            if candidate not in addresses:
                addresses.append(candidate)
        else:
            invalid = True
    codes = [DiagnosticCode.EMAIL_INVALID] if invalid else []
    if len(addresses) > 1:
        codes.append(DiagnosticCode.EMAIL_MULTIPLE_IN_CELL)
    return Outcome(tuple(addresses), tuple(codes), keep_raw=invalid)


def email_domain(address: str) -> str:
    return address.rpartition("@")[2]


# --- Phones -------------------------------------------------------------------------------------

EN_DASH = chr(0x2013)
PHONE_SEPARATORS = re.compile(r"[;,/|\n]+|\s+(?:ou|et)\s+|\s+[-" + EN_DASH + r"]\s+", re.IGNORECASE)
PHONE_FORMATTING = re.compile(r"[\s.\-()]")
FRENCH_NATIONAL = re.compile(r"[1-9][0-9]{8}")
PHONE_DIGITS = re.compile(r"\+?[0-9]+")


@dataclass(frozen=True, slots=True)
class ParsedPhone:
    number: str  # digits with optional leading `+` (database format)
    type: PhoneType


def parse_phones(value: CellValue, *, mobile_column: bool) -> Outcome[tuple[ParsedPhone, ...]]:
    """French numbers (`06 00 00 00 01`, `+33 (0)6…`, `0033…`) become `+33XXXXXXXXX`; other
    `+`/`00` numbers keep their digits; a number typed as a number that lost its leading zero is
    restored (flagged); other digit strings are kept as typed (flagged) unless they start with a
    national `0`; anything with letters or the wrong length is invalid and kept raw."""
    numeric = isinstance(value, int | float) and not isinstance(value, bool)
    phones: list[ParsedPhone] = []
    codes: list[DiagnosticCode] = []
    invalid = False
    for token in PHONE_SEPARATORS.split(render(value)):
        cleaned = PHONE_FORMATTING.sub("", token.replace("(0)", ""))
        if not cleaned:
            continue
        number, code = normalize_phone(cleaned, numeric=numeric)
        if number is None:
            invalid = True
            continue
        if code is not None and code not in codes:
            codes.append(code)
        if all(phone.number != number for phone in phones):
            phones.append(ParsedPhone(number, phone_type(number, mobile_column=mobile_column)))
    if invalid:
        codes.insert(0, DiagnosticCode.PHONE_INVALID)
    if len(phones) > 1:
        codes.append(DiagnosticCode.PHONE_MULTIPLE_IN_CELL)
    return Outcome(tuple(phones), tuple(codes), keep_raw=invalid)


def normalize_phone(cleaned: str, *, numeric: bool) -> tuple[str | None, DiagnosticCode | None]:
    if not PHONE_DIGITS.fullmatch(cleaned):
        return None, None
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]
    if cleaned.startswith("+"):
        digits = cleaned[1:]
        if digits.startswith("33"):
            national = digits[2:].removeprefix("0")
            return (f"+33{national}", None) if FRENCH_NATIONAL.fullmatch(national) else (None, None)
        return (cleaned, None) if 4 <= len(digits) <= 20 else (None, None)
    if len(cleaned) == 10 and FRENCH_NATIONAL.fullmatch(cleaned[1:]) and cleaned[0] == "0":
        return f"+33{cleaned[1:]}", None
    if numeric and FRENCH_NATIONAL.fullmatch(cleaned):
        return f"+33{cleaned}", DiagnosticCode.PHONE_LEADING_ZERO_RESTORED
    if not cleaned.startswith("0") and 4 <= len(cleaned) <= 20:
        return cleaned, DiagnosticCode.PHONE_UNRECOGNIZED_FORMAT
    return None, None


def phone_type(number: str, *, mobile_column: bool) -> PhoneType:
    """By the French numbering plan when possible (06/07 mobile, 01 to 05 and 09 landline,
    08 other), otherwise by the column it came from."""
    if number.startswith("+33"):
        prefix = number[3]
        if prefix in "67":
            return PhoneType.MOBILE
        return PhoneType.OTHER if prefix == "8" else PhoneType.LANDLINE
    return PhoneType.MOBILE if mobile_column else PhoneType.OTHER


# --- Planned contact (first `A contacter`) ------------------------------------------------------

WEEK = re.compile(r"(?:s|sem|semaine|w|wk|week) ?([0-9]{1,2})")
WEEK_YEAR = re.compile(r"(?:s|sem|semaine|w|wk|week) ?([0-9]{1,2}) ([0-9]{4}|[0-9]{2})")
YEAR_WEEK = re.compile(r"([0-9]{4}) ?(?:s|w) ?([0-9]{1,2})")
DATE_TEXT = re.compile(r"([0-9]{1,2}) ([0-9]{1,2}) ([0-9]{4}|[0-9]{2})")
INACTIVE_HINT = re.compile(
    r"\b(?:retraite|retraitee|retraites|decede|decedee|plus en poste|n est plus|a quitte|parti)\b"
)


@dataclass(frozen=True, slots=True)
class PlannedContact:
    date: date | None = None  # a real date: given as such, or week + year written in the cell
    week: int | None = None
    year: int | None = None  # never guessed: None means the user must provide it


@dataclass(frozen=True, slots=True)
class PlannedOutcome:
    value: PlannedContact | None
    codes: Codes = ()
    keep_raw: bool = False
    suggests_inactive: bool = False


def suggests_inactive(text: str) -> bool:
    return INACTIVE_HINT.search(fold(text)) is not None


def full_year(text: str) -> int:
    return int(text) if len(text) == 4 else 2000 + int(text)


def parse_planned_contact(value: CellValue) -> PlannedOutcome:
    """`S37`/`sem 37` → week without year (flagged, raw kept); `S37 2026`/`2026-W37` → that ISO
    week's Monday; a date cell or `dd/mm/yyyy` → that date; anything else (e.g. `retraité`) is
    not a week, raw kept, with an `inactive` suggestion when it reads like a departure."""
    if isinstance(value, datetime):
        return PlannedOutcome(PlannedContact(date=value.date()))
    if isinstance(value, date):
        return PlannedOutcome(PlannedContact(date=value))
    text = fold(render(value))
    if dated := week_with_year(text):
        week, year = dated
        try:
            monday = date.fromisocalendar(year, week, 1)
        except ValueError:
            return invalid_week()
        return PlannedOutcome(PlannedContact(date=monday, week=week, year=year))
    if week_only := WEEK.fullmatch(text):
        week = int(week_only[1])
        if not 1 <= week <= 53:
            return invalid_week()
        return PlannedOutcome(
            PlannedContact(week=week),
            (DiagnosticCode.PLANNED_CONTACT_WEEK_WITHOUT_YEAR,),
            keep_raw=True,
        )
    if day_month_year := DATE_TEXT.fullmatch(text):
        day, month, year_text = day_month_year.groups()
        try:
            return PlannedOutcome(
                PlannedContact(date=date(full_year(year_text), int(month), int(day)))
            )
        except ValueError:
            pass
    return PlannedOutcome(
        None,
        (DiagnosticCode.PLANNED_CONTACT_NOT_A_WEEK,),
        keep_raw=True,
        suggests_inactive=suggests_inactive(render(value)),
    )


def week_with_year(text: str) -> tuple[int, int] | None:
    if match := WEEK_YEAR.fullmatch(text):
        return int(match[1]), full_year(match[2])
    if match := YEAR_WEEK.fullmatch(text):
        return int(match[2]), int(match[1])
    return None


def invalid_week() -> PlannedOutcome:
    return PlannedOutcome(None, (DiagnosticCode.PLANNED_CONTACT_INVALID_WEEK,), keep_raw=True)


# --- Legacy tracking stages (RDV / Devis / Suivi / Relance 1 / Relance 2) -----------------------


class StageState(StrEnum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    UNRECOGNIZED = "unrecognized"


POSITIVE_MARKERS = frozenset({"oui", "o", "x", "yes", "y", "ok", "fait", "vrai", "true", "1", "v"})
NEGATIVE_MARKERS = frozenset({"non", "n", "no", "faux", "false", "0"})
DASHES = frozenset({"-", EN_DASH, chr(0x2014)})  # hyphen, en and em dashes
CHECK_MARKS = frozenset({"✓", "✔", "☑", "✅"})


@dataclass(frozen=True, slots=True)
class StageReading:
    state: StageState
    plain: bool = True  # a bare yes/no marker: fully represented by the tracking status
    when: date | None = None


def read_stage(value: CellValue) -> StageReading:
    """Yes-like markers, check marks, `TRUE`, non-zero numbers and dates are positive; `non`,
    `0`, `FALSE`, `-` negative; any other text is unrecognized. Dates and numbers are positive
    but not plain (their detail is kept raw)."""
    if isinstance(value, bool):
        return StageReading(StageState.POSITIVE if value else StageState.NEGATIVE)
    if isinstance(value, datetime | date):
        when = value.date() if isinstance(value, datetime) else value
        return StageReading(StageState.POSITIVE, plain=False, when=when)
    if isinstance(value, int | float):
        return (
            StageReading(StageState.NEGATIVE)
            if value == 0
            else StageReading(StageState.POSITIVE, plain=False)
        )
    raw = render(value).strip()
    key = fold(raw)
    if key in POSITIVE_MARKERS or raw in CHECK_MARKS:
        return StageReading(StageState.POSITIVE)
    if key in NEGATIVE_MARKERS or raw in DASHES:
        return StageReading(StageState.NEGATIVE)
    if key.startswith("oui "):
        return StageReading(StageState.POSITIVE, plain=False)
    if day_month_year := DATE_TEXT.fullmatch(key):
        day, month, year_text = day_month_year.groups()
        try:
            when = date(full_year(year_text), int(month), int(day))
        except ValueError:
            return StageReading(StageState.UNRECOGNIZED, plain=False)
        return StageReading(StageState.POSITIVE, plain=False, when=when)
    return StageReading(StageState.UNRECOGNIZED, plain=False)


# --- Address ------------------------------------------------------------------------------------

POSTAL_CITY = re.compile(
    r"(?P<street>.*?)[,\s]*\b(?P<postal>[0-9]{5})\s+(?P<city>[^,0-9]+?)"
    r"\s*(?:,?\s*(?P<country>france))?\s*",
    re.IGNORECASE,
)
ADDRESS_LINE_LENGTH = 255


@dataclass(frozen=True, slots=True)
class Address:
    line1: str | None = None
    line2: str | None = None
    postal_code: str | None = None
    city: str | None = None
    country: str | None = None


def parse_address(text: str) -> Outcome[Address]:
    """`12 rue X, 69000 Lyon` → line 1, postal code, city (country only when written); without a
    recognisable postal code the text stays free text (first line / other lines), raw kept."""
    lines = text.splitlines()
    flat = ", ".join(lines)
    if match := POSTAL_CITY.fullmatch(flat):
        street = match["street"].strip(" ,") or None
        address = Address(
            line1=street,
            postal_code=match["postal"],
            city=single_line(match["city"]),
            country="France" if match["country"] else None,
        )
        if street is None or len(street) <= ADDRESS_LINE_LENGTH:
            return Outcome(address)
    line1, line2 = lines[0], " / ".join(lines[1:]) or None
    if len(line1) > ADDRESS_LINE_LENGTH or (line2 and len(line2) > ADDRESS_LINE_LENGTH):
        return Outcome(codes=(DiagnosticCode.VALUE_TOO_LONG,), keep_raw=True)
    return Outcome(Address(line1=line1, line2=line2), (DiagnosticCode.ADDRESS_UNSTRUCTURED,), True)
