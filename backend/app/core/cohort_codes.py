"""Cohort codes (`Sxx`, decision D5): pure normalization shared by the cohort service, the model
and the import engine (which must not import the database layer).

A code is `S<n>`: « S37 », « s 37 », « Sem 037 », « semaine 37 » all read `S37` (case, spaces,
`sem`/`semaine` prefixes and leading zeros ignored). Anything else is not a cohort code — in
particular a week with a year (« S37 2026 ») or a date: the number is a session name, never an ISO
week, and no year is ever inferred.
"""

import re

CODE_FORMAT = re.compile(r"(?:s|sem|semaine)\s*0*([0-9]{1,6})")
# The special cohort « validated, out of campaign »: no date, nobody in it is contacted.
OUT_OF_CAMPAIGN_CODE = "S0"


def normalize_code(raw: str) -> str | None:
    """`S<n>` from « S37 », « s 37 », « Sem 037 »…; None when it is not a cohort code."""
    match = CODE_FORMAT.fullmatch(raw.strip().lower())
    if match is None:
        return None
    return f"S{int(match[1])}"
