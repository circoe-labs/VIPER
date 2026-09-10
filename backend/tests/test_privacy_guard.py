import importlib.util
from types import ModuleType

import pytest

from tests.support import BACKEND_DIR


def load_guard() -> ModuleType:
    path = BACKEND_DIR.parent / "scripts" / "check_private_data.py"
    spec = importlib.util.spec_from_file_location("check_private_data", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load_guard()


@pytest.mark.parametrize(
    "path",
    [
        "tasks/viper_v1_implementation_handoff_reviewed/sources/BASE_CLIENT.xlsx",
        "tasks/any/sources/notes.md",
        "exports/BASE_CLIENT_copy.bin",
        "backend/tests/fixtures/prospects.xlsx",
        "data/contacts.CSV",
        "frontend/src/sample.ods",
    ],
)
def test_private_paths_are_rejected(path: str) -> None:
    assert guard.violation(path) is not None


@pytest.mark.parametrize(
    "path",
    [
        "backend/tests/fixtures/synthetic/legacy_workbook.xlsx",
        "frontend/tests/fixtures/synthetic/prospects.csv",
        "tasks/viper_v1_implementation_handoff_reviewed/docs/excel-mapping.md",
        "doc/features/excel-import-export.md",
        "README.md",
    ],
)
def test_public_paths_are_accepted(path: str) -> None:
    assert guard.violation(path) is None


def test_repository_currently_tracks_no_private_file() -> None:
    assert guard.find_violations(guard.tracked_paths()) == []
