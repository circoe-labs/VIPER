# Task 13 — Éditeur mail et onglets Contact/R1/R2

## Goal

Rendre la page Contact utilisable manuellement de bout en bout sans IA : éditer, valider et programmer les trois messages.

## Context

L’utilisateur veut une interface de boîte mail préremplie, avec trois onglets et historique consultable.

## Scope
### In Scope
- Onglets Contact/R1/R2.
- From prérempli depuis config.
- Destinataire principal depuis l’email prospect, modifiable.
- Autres destinataires si le modèle les supporte.
- Objet + corps.
- Date/heure d’envoi.
- Badges état du message.
- Bouton valider / revalider.
- Sent read-only.
- Cancelled lisible.

### Out of Scope
- Génération IA.
- Envoi réel.
- Pièces jointes non confirmées.

## Dependencies

Tasks 10-12.

## Implementation Steps

1. Charger les skills code.
2. Construire form contrôlé par message étape.
3. Autosave raisonnable ou save explicite ; ne pas confondre avec validation.
4. Rendre le bouton de validation identique après modification.
5. Ajouter date/heure et action programmer seulement après validation.
6. Gérer message absent = nouveau draft vide.
7. Historique envoyé consultable.

## Files Likely Touched

- composants Contact
- styles
- API client
- config/settings éventuelle

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Draft vide puis édition.
- Validation.
- Modification -> draft.
- Programmation.
- Sent read-only.
- Switch onglets sans perdre les données.

## Acceptance Criteria

- Les trois étapes sont accessibles.
- Aucun message n’est programmé sans validation.
- Modifier un message programmé affiche clairement qu’il faut revalider.
- Les messages envoyés ne sont pas éditables.

## Documentation Updates

Documenter le workflow opérateur.

## Handoff Notes

L’adresse From doit venir de config, pas d’une transcription orale hardcodée.
