# Slice 04 — Découverte : établissements et déclencheur

Tier QA : **critical** (persistance). Références : HANDOFF §10, READINESS (décisions 5 et 6).

## Périmètre

- **`SignalKind`** (`models/enums.py`) : ajouter `facility_opening`, `facility_expansion`, `construction` et
  `relocation`. Prévoir la migration d'enum si la colonne est un enum Postgres, et les libellés côté frontend.
- **`CompanyProposal`** (`services/agent_payloads.py`) : ajouter `establishments: list[...]` et un `trigger`
  optionnel.
  - Champs d'un établissement : nom, kind, siret, adresse, code postal, ville, pays, `opened_on`, `surface_m2`,
    source.
  - Le déclencheur réutilise la forme de `SignalProposal` au lieu d'en créer une nouvelle.
- **Prompt worker** : le prompt et le schéma de sortie de `find_prospects` annoncent ces champs.
- **Revue** (`services/agent_review.py`, `_apply_find_prospects` / `_apply_company`) : à l'acceptation, créer
  dans une seule transaction l'entreprise, ses établissements (réutiliser `EstablishmentInput`) et le signal
  avec sa source. Dédoublonner les établissements par SIRET, puis par le couple (ville, nom).
- **Écran de revue** : les établissements et le déclencheur y sont visibles.

## Validation

Tests :
- l'acceptation d'une proposition « entrepôt à Honfleur » crée les trois enregistrements avec leur provenance ;
- un établissement déjà connu n'est pas recréé ;
- les anciennes propositions, sans ces champs, restent valides.
