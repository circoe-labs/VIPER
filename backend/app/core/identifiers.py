"""Format checks of company identifiers, shared by the company service and the import engine."""

import re
from urllib.parse import urlsplit, urlunsplit

# La Poste's establishments share this SIREN; their SIRETs are checked by digit sum instead.
LA_POSTE_SIREN = "356000000"

_LABEL = r"[^\W_](?:[\w-]{0,61}[^\W_])?"
HOSTNAME = re.compile(rf"(?:{_LABEL}\.)+{_LABEL}")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)


def luhn_valid(digits: str) -> bool:
    total = 0
    for position, char in enumerate(reversed(digits)):
        digit = int(char) * (2 if position % 2 else 1)
        total += digit - 9 if digit > 9 else digit
    return total % 10 == 0


def siret_key_valid(siret: str) -> bool:
    if siret.startswith(LA_POSTE_SIREN):
        return sum(int(char) for char in siret) % 5 == 0
    return luhn_valid(siret)


def website_address(text: str) -> str | None:
    """`exemple.fr/contact` → `https://exemple.fr/contact` (scheme and host lowercase), or None
    when `text` is not a website address."""
    if not SCHEME.match(text):
        text = f"https://{text}"
    parts = urlsplit(text)
    host = parts.hostname or ""
    try:
        netloc = f"{host}:{parts.port}" if parts.port else host
    except ValueError:  # port not a number or out of range
        return None
    if (
        not netloc
        or parts.scheme.lower() not in {"http", "https"}
        or "@" in parts.netloc
        or not HOSTNAME.fullmatch(host)
        or any(char.isspace() for char in text)
    ):
        return None
    path = "" if parts.path == "/" else parts.path
    return urlunsplit((parts.scheme.lower(), netloc, path, parts.query, parts.fragment))
