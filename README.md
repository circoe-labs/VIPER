# VIPER

**Validation Interface for Prospecting, Execution & Revenue**

VIPER est l’outil de prospection B2B de Circoe : une base de données de prospects (des personnes) et de leurs
entreprises, tenue à jour à la main, avec un suivi de contact léger. La V1 remplace le classeur Excel historique
sans en reprendre les confusions, et garde l’Excel comme format d’échange (import contrôlé, export normalisé).

Ce que fait la V1 :

- **Accueil** — l’état de la base (vérifications, e-mails, opposition), l’activité de contact du mois face aux
  objectifs, les prochaines actions et les dernières modifications ;
- **Prospection** — des compteurs qui filtrent une liste de personnes lisible, un éditeur de prospect (vérification
  explicite, adresses et téléphones, changement d’entreprise, opposition durable, « Enregistrer et suivant »), les
  fiches **Entreprises**, l’**import Excel** avec revue (correction, exclusion, doublons) et l’**export Excel** ;
- **Base de données** — un explorateur de tables (tri, filtres, modifications en attente puis enregistrées et
  tracées) et une console SQL en lecture seule garantie par PostgreSQL ;
- **Paramètres** — rôles, catégories d’activité, segments commerciaux et référents internes ;
- **Exploitation** — « Bientôt disponible » : aucun agent, e-mail ou Calendly n’est simulé.

Chaque modification est tracée (qui, quand, depuis où) ; une opposition « Ne pas contacter » survit aux réimports.
Un seul utilisateur authentifié pour le pilote. L’interface est en français ; le code et la documentation technique
sont en anglais.

## Stack

- `backend/` — Python 3.14, FastAPI, SQLAlchemy 2, Alembic, PostgreSQL 16 (pytest, ruff, mypy)
- `frontend/` — React 19, TypeScript, Vite, React Router, TanStack Query (Vitest, Playwright, axe-core)
- `docker-compose.yml` — PostgreSQL 16 on `127.0.0.1:5442` (databases `viper`, `viper_test`, `viper_e2e`)

Details and rationale: [ADR-0001](doc/adr/0001-stack.md).

## Quick start (PowerShell, from a fresh clone)

Prerequisites: Docker Desktop, Python 3.14, Node 24, Git; free ports 5442, 8042, 5173.

```powershell
docker compose up -d --wait                                     # PostgreSQL 16 on 127.0.0.1:5442
cd backend; python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
alembic upgrade head                                            # schema of the dev database `viper`
python -m app.seed                                              # suggested roles/segments/categories (optional)
python -m app.cli provision-sql-reader                          # read-only role of the SQL console (again after each migration)
python -m app.cli create-user --email vous@example.com --display-name "Prénom Nom"   # login account (password prompted)
uvicorn app.main:create_app --factory --reload --port 8042      # API: http://127.0.0.1:8042/api/health
# second terminal
cd frontend; npm ci; npm run dev                                # UI: http://localhost:5173
```

All quality gates: `python scripts/verify.py` (add `--e2e` for Playwright; run `npx playwright install chromium`
once in `frontend/`). Full guide, ports for parallel checkouts and troubleshooting:
[runbook-local-dev](doc/process/runbook-local-dev.md). Deployment requirements (no host chosen yet):
[runbook-production](doc/process/runbook-production.md).

## Documentation

Living documentation lives in [`doc/`](doc/README.md): product decisions and open questions, architecture,
feature specifications, ADRs and process. Start with the
[final implementation report](doc/process/final-implementation-report.md) for the state of V1.

## Confidentialité

Ce dépôt est **public**. Aucune donnée réelle de contact ne doit y être commitée : `tasks/**/sources/` et tous les
tableurs/CSV sont ignorés par git, et `scripts/check_private_data.py` (exécuté en CI) échoue si l’un d’eux est
suivi. Seules les fixtures synthétiques (`backend|frontend/tests/fixtures/synthetic/`) sont autorisées.
