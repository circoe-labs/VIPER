"""Atomic writes of a private JSON file kept outside the database (the CIRCOE Toolbox OAuth token,
S6; the integration settings set from the browser, S8).

The file is written to a temporary file in the same directory, then moved over the target with
`os.replace` (a reader sees the old or the new content, never half of it). The directory is
created `0700` and the file `0600`. On Windows these modes are ignored: the file inherits the ACL
of its folder — keep it under the profile of the account that runs VIPER.
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def write_private_json(path: Path, data: Any) -> None:
    directory = path.parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
