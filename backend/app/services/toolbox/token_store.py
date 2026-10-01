"""Where the CIRCOE Toolbox OAuth state lives: a private JSON file, never the database.

The database is copied by backups and readable through the Database Explorer and the SQL console;
an OAuth bearer token must reach neither. The file (`VIPER_TOOLBOX_TOKEN_STORE_PATH`, default
`~/.viper/toolbox-oauth.json`, refused inside the checkout by `Settings`) holds:

- `client`: the dynamically registered public client (kept and reused while the issuer and the
  redirect URI do not change);
- `token`: the bearer token (30 days, no refresh token from the Toolbox) and what it is for;
- `connected_by` / `connected_at`: who connected, for the Settings page;
- `last_error`: the last connection failure code (never a text from the Toolbox).

Writes are atomic and private (`app.core.private_file.write_private_json`: temporary file then
`os.replace`, directory `0700`, file `0600`; on Windows the file inherits the user profile's ACL —
keep the path under the service account's profile). An unreadable file means
« not connected », never a crash. Tokens are excluded from `repr` and never logged.
"""

import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, Field, ValidationError

from app.core.private_file import write_private_json

logger = logging.getLogger(__name__)


class StoredClient(BaseModel):
    issuer: str
    client_id: str
    redirect_uri: str
    registered_at: datetime


class StoredToken(BaseModel):
    access_token: str = Field(repr=False)
    refresh_token: str | None = Field(default=None, repr=False)
    expires_at: datetime | None
    scope: str
    issuer: str
    resource: str
    token_endpoint: str
    client_id: str
    refresh_supported: bool
    obtained_at: datetime
    # Set when the Toolbox refused the token (401) or it expired without a refresh.
    invalidated_at: datetime | None = None


class ConnectedBy(BaseModel):
    id: str | None
    display: str | None


class LastError(BaseModel):
    code: str
    at: datetime


class StoreFile(BaseModel):
    version: int = 1
    client: StoredClient | None = None
    token: StoredToken | None = None
    connected_by: ConnectedBy | None = None
    connected_at: datetime | None = None
    last_error: LastError | None = None


class TokenStore(Protocol):
    def read(self) -> StoreFile: ...

    def write(self, file: StoreFile) -> None: ...


class MemoryTokenStore:
    """In-memory store (tests)."""

    def __init__(self, initial: StoreFile | None = None) -> None:
        self._file = (initial or StoreFile()).model_copy(deep=True)
        self._lock = threading.Lock()

    def read(self) -> StoreFile:
        with self._lock:
            return self._file.model_copy(deep=True)

    def write(self, file: StoreFile) -> None:
        with self._lock:
            self._file = file.model_copy(deep=True)


class FileTokenStore:
    """The private JSON file. Callers serialize their read-modify-write themselves
    (`oauth.ToolboxAuth` holds one lock; the API runs as one process)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()

    def read(self) -> StoreFile:
        with self._lock:
            try:
                raw = self.path.read_text(encoding="utf-8")
            except FileNotFoundError:
                # intentional: no file is the normal state before the first connection.
                return StoreFile()
            except OSError as error:
                logger.warning("toolbox.token_store_unreadable error=%s", type(error).__name__)
                return StoreFile()
            try:
                file = StoreFile.model_validate_json(raw)
            except ValidationError:
                logger.warning("toolbox.token_store_invalid: treated as not connected")
                return StoreFile()
            return file if file.version == 1 else StoreFile()

    def write(self, file: StoreFile) -> None:
        with self._lock:
            write_private_json(self.path, file.model_dump(mode="json"))
