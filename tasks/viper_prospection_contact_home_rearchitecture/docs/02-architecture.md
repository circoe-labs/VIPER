# Architecture cible (copy of Drive docs/02)
Ownership: Prospection=frontend/src/prospection/* (reuse companies/prospects/warehouses); Contact=frontend/src/contact/*; Home=frontend/src/home/*; routing=frontend/src/routes.tsx; API/read models: extend frontend/src/api/* + backend, don't duplicate in components.
Prospection summary per entity: total; added last 7 days; quality/validation counters; weekly sub-status evolution only when reliable.
Contact summary: to contact/upcoming; contacted; follow-ups due/late; replies; appointments; mail error/inactive if supported; quotes/opportunities only if contractual.
Home summary: only reliable figures from Prospection, Contact, Missions/Reviews; cards carry destination + stable query params.
Routing: URL-serializable deep-links e.g. /prospection?entity=prospect&review=to_verify, /prospection?entity=company, /prospection?entity=warehouse, /contact?status=appointment. Derive names from existing criteria to preserve bookmarks.
Reuse: criteria.ts, serializeView, parseView, React Router patterns; existing tables/editors; no second counter system.
