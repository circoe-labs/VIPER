# Task 14 — Génération OpenAI

## Goal

Ajouter la génération et régénération IA de l’objet et du corps des trois messages, sans autorité sur le workflow.

## Context

L’utilisateur fournira une clé API. Le modèle exact doit être configurable. L’IA reçoit le contexte disponible et un prompt système éditorial.

## Scope
### In Scope
- Adaptateur OpenAI serveur.
- `OPENAI_API_KEY` et `OPENAI_MODEL`.
- Prompt versionné.
- Génération Contact/R1/R2.
- Régénération avec instruction utilisateur courte.
- Sortie structurée subject/body validée.
- Sauvegarde en draft uniquement.
- Diagnostics erreurs.

### Out of Scope
- Changer le statut prospect.
- Valider/programmer/envoyer automatiquement.
- Inventer des signaux absents.
- Exposer la clé au client.

## Dependencies

Tasks 12-13.

## Implementation Steps

1. Charger les skills code.
2. Vérifier la documentation OpenAI actuelle pour l’identifiant de modèle choisi.
3. Créer une interface d’adapter mockable.
4. Construire un prompt qui interdit l’invention.
5. Inclure pour R1/R2 les messages précédents réellement enregistrés.
6. Ajouter endpoint generate/regenerate.
7. Persister `generation_model` et `prompt_version`.
8. Ajouter tests avec fake adapter.

## Files Likely Touched

- nouveau adapter/service OpenAI
- routes
- UI bouton Générer/Régénérer
- `.env.example`
- tests

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Fake OpenAI succès.
- Sortie invalide rejetée.
- Timeout/erreur => message existant intact.
- Génération => status draft.
- Aucune transition prospect.

## Acceptance Criteria

- L’IA remplit subject/body.
- Une consigne utilisateur peut guider une nouvelle version.
- L’utilisateur doit encore valider.
- Aucun secret côté navigateur.

## Documentation Updates

Documenter variables d’environnement et version de prompt.

## Handoff Notes

Ne pas coder un identifiant modèle à partir de mémoire : le vérifier au moment de l’implémentation et garder la config override.
