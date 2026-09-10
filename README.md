# VIPER

**Validation Interface for Prospecting, Execution & Revenue** — V1 database-first, human-in-the-loop.

VIPER V1 provides a secure interface for maintaining companies/prospects, provenance and verification state, controlled Excel import/export, lightweight contact tracking, an operational dashboard, settings taxonomies and a technical database explorer. IProspect, IContact, automatic email sending and Calendly sync are intentionally not implemented.

## Local setup

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

The API defaults to `http://localhost:3001` and Vite to `http://localhost:5173`. In development only, if `.env` is absent, login is `admin` / `viper`. Production requires `VIPER_PASSWORD` and `VIPER_SESSION_SECRET`.

## Safety

The public repository must never contain the real `BASE_CLIENT.xlsx`, raw contact rows or the handoff `sources/` directory. `.gitignore` and CI enforce this. Committed tests use synthetic values only.

## Main routes

- `/` — Home dashboard from real database/manual tracking data
- `/prospection` — people-oriented prospect verification/contact workspace + import/export
- `/exploitation` — explicit Coming soon placeholder only
- `/database` — technical table explorer + backend-enforced read-only SQL
- `/settings` — roles, activity categories, segments and internal referents

See `docs/ADR-001-stack.md` and `docs/IMPLEMENTATION_REPORT.md` for architecture and remaining open decisions.
