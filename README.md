# VIPER

**Validation Interface for Prospecting, Execution & Revenue**

VIPER est un projet dédié à la prospection, à l’exécution commerciale et au suivi du revenu.

## Stack

- `backend/` — Python 3.14, FastAPI, SQLAlchemy 2, Alembic, PostgreSQL 16 (pytest, ruff, mypy)
- `frontend/` — React 19, TypeScript, Vite, React Router, TanStack Query (Vitest, Playwright)
- `docker-compose.yml` — PostgreSQL 16 on `127.0.0.1:5442` (databases `viper`, `viper_test`, `viper_e2e`)

Details and rationale: [ADR-0001](doc/adr/0001-stack.md).

## Démarrage rapide (PowerShell)

```powershell
docker compose up -d --wait
cd backend; python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt; alembic upgrade head
python -m app.cli create-user --email vous@example.com --display-name "Prénom Nom"   # compte de connexion (mot de passe demandé)
uvicorn app.main:create_app --factory --reload --port 8042     # API : http://127.0.0.1:8042/api/health
# second terminal
cd frontend; npm ci; npm run dev                                # UI : http://localhost:5173
```

All quality gates: `python scripts/verify.py` (add `--e2e` for Playwright). Full guide:
[runbook-local-dev](doc/process/runbook-local-dev.md).

## Documentation

Living documentation lives in [`doc/`](doc/README.md) (product decisions, architecture, specs, ADRs, process).

## Confidentialité

Ce dépôt est **public**. Aucune donnée réelle de contact ne doit y être commitée : `tasks/**/sources/` et tous les
tableurs/CSV sont ignorés par git, et `scripts/check_private_data.py` (exécuté en CI) échoue si l’un d’eux est
suivi. Seules les fixtures synthétiques (`backend|frontend/tests/fixtures/synthetic/`) sont autorisées.
