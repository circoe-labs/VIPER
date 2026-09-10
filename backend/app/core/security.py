"""Credential primitives: argon2id password hashing, session tokens and CSRF tokens (ADR-0004)."""

import hashlib
import hmac
import secrets
from functools import cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from argon2.profiles import RFC_9106_LOW_MEMORY

# Longer inputs are refused before hashing (bounded work per request).
MAX_PASSWORD_LENGTH = 1024

# RFC 9106 second recommended profile: argon2id, t=3, m=64 MiB, p=4, 16-byte salt, 32-byte tag.
_hasher = PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY)

SESSION_TOKEN_BYTES = 32
_CSRF_LABEL = b"viper-csrf-v1"


@cache
def _dummy_hash() -> str:
    return _hasher.hash(secrets.token_urlsafe(16))


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Check `password`; without a stored hash, verify against a dummy one and return False.

    Either way exactly one argon2 verification runs, so a missing account costs the same time as a
    wrong password. argon2 compares the tags in constant time.
    """
    try:
        _hasher.verify(password_hash or _dummy_hash(), password)
    except VerificationError, InvalidHashError:
        return False
    return password_hash is not None


def password_needs_rehash(password_hash: str) -> bool:
    """True when the hash was made with other parameters than the current profile."""
    return _hasher.check_needs_rehash(password_hash)


def new_session_token() -> str:
    """256-bit random value sent to the browser in the session cookie; never stored."""
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)


def session_token_hash(token: str) -> str:
    """What the database stores. A fast hash is enough: the token is 256 random bits."""
    return hashlib.sha256(token.encode()).hexdigest()


def csrf_token(session_token: str) -> str:
    """Session-bound CSRF token: an HMAC keyed by the (HttpOnly) session token.

    The server recomputes it from the cookie on every unsafe request, so nothing extra is stored,
    and a leaked CSRF token reveals nothing about the session token.
    """
    return hmac.new(session_token.encode(), _CSRF_LABEL, hashlib.sha256).hexdigest()


def csrf_token_matches(session_token: str, candidate: str) -> bool:
    return hmac.compare_digest(csrf_token(session_token).encode(), candidate.encode())
