"""Privacy guard: fail if git tracks (or has staged) a private file. The repository is PUBLIC.

Rules:
- nothing under `tasks/**/sources/` (private handoff sources, incl. the real client workbook);
- no file named like the real workbook (`BASE_CLIENT*`), whatever its extension;
- spreadsheets/CSV only under the synthetic fixture folders.

Prints offending paths only, never file contents. Usage: `python scripts/check_private_data.py`.
"""

import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[1]
SPREADSHEET_SUFFIXES = {".xlsx", ".xlsm", ".xlsb", ".xls", ".ods", ".csv", ".tsv"}
SYNTHETIC_FIXTURE_DIRS = ("backend/tests/fixtures/synthetic/", "frontend/tests/fixtures/synthetic/")


def violation(path: str) -> str | None:
    posix = PurePosixPath(path)
    if posix.parts[0] == "tasks" and "sources" in posix.parts[1:-1]:
        return "private handoff source"
    if posix.name.lower().startswith("base_client"):
        return "real client workbook name"
    if posix.suffix.lower() in SPREADSHEET_SUFFIXES and not path.startswith(SYNTHETIC_FIXTURE_DIRS):
        return "spreadsheet outside synthetic fixture folders"
    return None


def find_violations(paths: Iterable[str]) -> list[tuple[str, str]]:
    return [(path, reason) for path in paths if (reason := violation(path))]


def tracked_paths() -> list[str]:
    # The index holds both committed and staged files.
    output = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO_ROOT, check=True, capture_output=True
    ).stdout
    return [path for path in output.decode("utf-8").split("\0") if path]


def main() -> int:
    paths = tracked_paths()
    violations = find_violations(paths)
    for path, reason in violations:
        print(f"PRIVATE DATA: {path} ({reason})", file=sys.stderr)
    if violations:
        print(f"Privacy guard FAILED: {len(violations)} private file(s) tracked.", file=sys.stderr)
        return 1
    print(f"Privacy guard OK: {len(paths)} tracked files checked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
