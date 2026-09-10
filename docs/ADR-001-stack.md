# ADR-001 — Stack VIPER V1

Status: accepted for V1 implementation.

VIPER uses React + TypeScript + Vite for the UI, an Express + TypeScript API, and SQLite through better-sqlite3 for the pilot relational store. XLSX import/export uses SheetJS. Authentication is a signed HttpOnly cookie session backed by one configured pilot account.

Rationale: the repository had no existing conventions, so V1 favors a small typed stack, deterministic migrations, easy local deployment and future replacement of persistence behind service boundaries. UI never accesses SQL directly.
