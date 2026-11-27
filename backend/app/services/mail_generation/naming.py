"""How a message names a person's function and company (user feedback 2026-11-27, item 1).

Pure module, shared by the warehouse drafts and the AI drafting:

- a long job title is reduced to its level word (« Directeur »); a short one is kept;
- a label holding several organisations designates none of them: a person is never attached
  arbitrarily to one;
- helpers to find a name in a text (so a company is named at most once).
"""

import re
import unicodedata

# Above this many words a title is « long » and reduced to its level word.
MAX_TITLE_WORDS = 3

# Only separators that join two organisations. « & », « et » and « , » are left alone: they are
# usually part of one company's name.
_ORGANISATIONS = re.compile(r"\s+/\s+|\s+\+\s+|\s*[;|\n]\s*")
_LOCATION = re.compile(r"\s+[–—-]\s+")  # noqa: RUF001
_PARENTHESES = re.compile(r"\([^()]*\)")
_LEGAL_SUFFIX = re.compile(r"[\s,]+(?:SAS|SASU|SARL|SA|SNC|EURL|GMBH|LTD|INC)\.?$", re.IGNORECASE)
# What ends the first function of a title: another function, its scope or the company.
_TITLE_END = re.compile(r"\s*[–—,();|/\n&@]\s*|\s+-\s*|\s*-\s+(?=[A-Z])|\s+(?:et|and|chez|at)\s+")  # noqa: RUF001
_TITLE_COMPANY = re.compile(r"\s+(?:de |d’|d')(?=[A-Z])|\s+(?:PR Logistics|EPH|FBL)\b")
# The first of these words in a long title gives its level.
_LEVELS = {
    "directeur": "Directeur",
    "directrice": "Directrice",
    "director": "Directeur",
    "responsable": "Responsable",
    "manager": "Responsable",
    "head": "Responsable",
    "president": "Président",
    "presidente": "Présidente",
    "gerant": "Gérant",
    "gerante": "Gérante",
    "dirigeant": "Dirigeant",
    "dirigeante": "Dirigeante",
    "fondateur": "Fondateur",
    "fondatrice": "Fondatrice",
    "coordinateur": "Coordinateur",
    "coordinatrice": "Coordinatrice",
    "superviseur": "Superviseur",
    "ingenieur": "Ingénieur",
    "ingenieure": "Ingénieure",
    "consultant": "Consultant",
    "consultante": "Consultante",
    "adjoint": "Adjoint",
    "adjointe": "Adjointe",
    "assistant": "Assistant",
    "assistante": "Assistante",
}


def fold(text: str) -> str:
    """Lower case, no accents, single spaces, straight apostrophes: for comparisons only."""
    decomposed = unicodedata.normalize("NFD", text.casefold().replace("’", "'"))
    return " ".join("".join(c for c in decomposed if not unicodedata.combining(c)).split())


def count_mentions(text: str, name: str) -> int:
    """How many times `name` appears in `text` as whole words (case and accents ignored)."""
    wanted = fold(name)
    if len(wanted) < 3:
        return 0
    return len(re.findall(rf"(?<!\w){re.escape(wanted)}(?!\w)", fold(text)))


def organisations(label: str | None) -> list[str]:
    """The distinct organisation names a company or site label holds, without the site location
    (« Name - Street »), a parenthesis or a legal suffix. Several names mean the label does not
    say which one the person belongs to."""
    text = _PARENTHESES.sub(" ", label or "")
    text = _LOCATION.split(text.strip(), maxsplit=1)[0]
    found: dict[str, str] = {}
    for part in _ORGANISATIONS.split(text):
        name = _LEGAL_SUFFIX.sub("", " ".join(part.split()).strip(" ,.")).strip(" ,.")
        if name:
            found.setdefault(fold(name), name)
    return list(found.values())


def single_organisation(label: str | None) -> str | None:
    """The label's organisation, or None when it holds none or several."""
    names = organisations(label)
    return names[0] if len(names) == 1 else None


def title_segment(title: str | None) -> str | None:
    """The first function of a recorded title, without what follows it."""
    if not title:
        return None
    first = _TITLE_END.split(title.strip(), maxsplit=1)[0]
    first = _TITLE_COMPANY.split(first, maxsplit=1)[0]
    return " ".join(first.split()).strip(" .") or None


def short_title(title: str | None, company: str | None = None) -> str | None:
    """The function as a message names it: the first function when it is short, else its level
    word (« Directeur », « Directeur général », « Chef de projet »). None when a long title has
    no known level (the message then names no function). A company name inside the title is
    removed: the message names the company on its own."""
    segment = title_segment(title)
    if not segment:
        return None
    for name in organisations(company):
        found = re.search(rf"(?<!\w){re.escape(name)}(?!\w)", segment, re.IGNORECASE)
        if found:
            segment = re.sub(r"(?:\s+(?:de|du|des|d’|d'))?\s*$", "", segment[: found.start()])
    if segment.isupper() and len(segment) > 4:
        segment = segment.capitalize()
    words = segment.split()
    if not words:
        return None
    if len(words) <= MAX_TITLE_WORDS:
        return segment
    folded = [fold(word) for word in words]
    for index, word in enumerate(folded):
        if word in ("chef", "cheffe") and index + 2 < len(words):
            end = index + (3 if folded[index + 1] in ("de", "d'") else 2)
            return " ".join(words[index:end]).capitalize()
        if level := _LEVELS.get(word):
            following = folded[index + 1] if index + 1 < len(folded) else ""
            if level in ("Directeur", "Directrice") and following in ("general", "generale"):
                return f"{level} {'général' if level == 'Directeur' else 'générale'}"
            return level
    return None
