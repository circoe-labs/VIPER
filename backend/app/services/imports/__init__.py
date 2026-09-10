"""Excel/CSV import engine (Task 08): uploaded file → typed, deterministic `ImportPreview`.

Pure and side-effect free: it never touches the database (only `reference_loader` reads it, to
build the `ImportReferenceData` snapshot). Pipeline: `workbook` (XLSX/CSV adapters, limits) →
`layout` (prospect sheet, column mapping + user overrides; legacy headers live in `fields`) →
`rows` (normalizers in `normalize`, taxonomy/referent matching in `matching`, lossless legacy
metadata) → `dedup` (duplicate candidates, do-not-contact blocking) → `preview` (summary).
Diagnostic codes, severities and French messages: `diagnostics`. Design: ADR-0007.
"""
