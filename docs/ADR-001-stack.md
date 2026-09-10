# ADR-001 — V1 stack

Status: accepted for the GPT implementation branch.

- Frontend: React + TypeScript + Vite.
- Backend: Express + TypeScript.
- Database: SQLite via better-sqlite3 for the single-user pilot.
- Excel: SheetJS/xlsx.
- Validation/testing: TypeScript, Vitest, ESLint, GitHub Actions.

Rationale: minimal operational surface for a single-user pilot, deterministic local relational database, low migration cost, clear service boundary for later replacement by a networked shared database. This is an implementation choice for the branch, not a change to the broader IProspect/VIPER/IContact functional separation.
