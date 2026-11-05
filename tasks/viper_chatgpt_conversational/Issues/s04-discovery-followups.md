# Slice 04 — suites non bloquantes (QA du 2026-11-03)

- **Nouveau site d'une entreprise connue.** L'entreprise est refusée comme `already_known`, et le site comme le
  déclencheur sont perdus. Il faudrait un chemin d'acceptation qui rattache le site et le signal à l'entreprise
  existante.
- **Établissement principal.** Sur une entreprise nouvelle, le premier site découvert devient l'établissement
  principal (`companies.py:357`), même quand c'est un entrepôt et non le siège. À trancher par le produit.
- **Dédoublonnage (ville, nom) dépendant de l'ordre** (`agent_payloads.py:1173`). Un site avec SIRET placé avant un
  site homonyme sans SIRET fait refuser ce dernier ; dans l'ordre inverse, les deux sont gardés.
- **Déclencheur refusé, entreprise gardée.** Si le déclencheur est hors période, l'entreprise reste proposée sans
  déclencheur. C'est un choix de conception, à confirmer.
- **Provenance.** Les entreprises n'ont pas de table de sources ; la provenance repose sur l'audit et sur
  `result.applied`.
