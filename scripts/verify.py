"""Run every local quality gate, in CI order. Usage: `python scripts/verify.py [--e2e]`.

Needs the backend venv (`backend/.venv`), `npm ci` in `frontend/` and the Docker database running
(`--e2e` also uses the `viper_e2e` database and ports 8044/5180; see runbook-local-dev.md).
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
PYTHON = str(BACKEND / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
NPM = "npm.cmd" if os.name == "nt" else "npm"

STEPS: list[tuple[str, list[str], Path]] = [
    ("privacy guard", [sys.executable, "scripts/check_private_data.py"], ROOT),
    ("ruff check", [PYTHON, "-m", "ruff", "check", ".", "../scripts"], BACKEND),
    ("ruff format", [PYTHON, "-m", "ruff", "format", "--check", ".", "../scripts"], BACKEND),
    ("mypy", [PYTHON, "-m", "mypy"], BACKEND),
    ("pytest", [PYTHON, "-m", "pytest"], BACKEND),
    ("eslint", [NPM, "run", "lint"], FRONTEND),
    ("tsc", [NPM, "run", "typecheck"], FRONTEND),
    ("vitest", [NPM, "run", "test"], FRONTEND),
    ("vite build", [NPM, "run", "build"], FRONTEND),
]
E2E_STEP = ("playwright", [NPM, "run", "e2e"], FRONTEND)


def main() -> int:
    steps = [*STEPS, E2E_STEP] if "--e2e" in sys.argv[1:] else STEPS
    for name, command, cwd in steps:
        print(f"==> {name}", flush=True)
        if subprocess.run(command, cwd=cwd).returncode != 0:
            print(f"FAILED: {name}", file=sys.stderr)
            return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
