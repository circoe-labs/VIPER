# Task 15 — Adaptateur CIRCOE Toolbox MCP

## Goal

Connecter VIPER à la Toolbox pour créer, supprimer et envoyer les brouillons Infomaniak via une frontière d’adapter claire.

## Context

La Toolbox expose les outils nécessaires mais son MCP utilise OAuth 2.1 + PKCE. Le mode d’authentification depuis VIPER doit être résolu proprement.

## Scope
### In Scope
- Adapter MCP encapsulant create_draft/delete_draft/send_draft.
- Flow de connexion/authentification officiellement supporté.
- Stockage sûr du remote draft id.
- Création du remote draft au moment de la validation ou de la programmation, pas à chaque génération IA.
- Fake adapter pour tests.
- Diagnostics et erreurs typées.

### Out of Scope
- Scheduler.
- Lecture automatique des réponses.
- Recherche mail.
- Contourner la politique outbound de la Toolbox.

## Dependencies

Tasks 12-14. Accès au repo Toolbox et endpoint MCP.

## Implementation Steps

1. Charger les skills code.
2. Lire les contrats/outils MCP actuels dans `circoe-toolbox`.
3. Valider le mécanisme d’auth OAuth pour VIPER.
4. Créer l’interface adapter + fake.
5. Implémenter create/delete/send draft.
6. Lors d’une revalidation après édition, remplacer proprement l’ancien remote draft.
7. Ne jamais logguer tokens ou corps email en clair dans les diagnostics globaux.

## Files Likely Touched

- adapter MCP
- config/auth glue
- message service integration
- tests
- `.env.example` si nécessaire

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Fake adapter.
- Auth manquante => erreur claire.
- create draft puis id persistant.
- delete draft sur invalidation/cancel.
- send draft succès/échec.

## Acceptance Criteria

- VIPER peut créer un brouillon distant validé.
- Un message non validé ne crée pas de brouillon distant obligatoire.
- La politique outbound Toolbox reste respectée.
- Aucun secret n’est exposé au client.

## Documentation Updates

Documenter le flow d’authentification réellement retenu.

## Handoff Notes

Si l’auth MCP ne peut pas être intégrée proprement dans le lot, garder l’adapter fake/contract et documenter le blocage plutôt que contourner la sécurité.
