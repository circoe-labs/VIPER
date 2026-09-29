# Task 16 — Programmation différée et annulations

## Goal

Faire de VIPER le propriétaire du scheduling et envoyer uniquement les messages validés arrivés à échéance, de façon idempotente.

## Context

Le grill acte que la Toolbox ne programme pas la séquence. VIPER stocke `scheduled_at` et déclenche `send_draft`. Les états prospects restent humains.

## Scope
### In Scope
- Dispatcher backend persistant/restart-safe.
- Scan des messages `scheduled` dus.
- Verrou/idempotency anti-double-envoi.
- Appel `send_draft`.
- Passage message à `sent` après confirmation réelle.
- Aucune modification automatique du statut prospect.
- Sur changement manuel vers response_received/appointment_obtained/ignored, annuler les futurs messages et remote drafts.
- Sur ignored, conserver blocage durable.

### Out of Scope
- Auto Contacté/R1/R2 après envoi.
- Auto Failure après 4 semaines.
- Lecture boîte mail.
- Calendly.

## Dependencies

Tasks 04, 12, 15.

## Implementation Steps

1. Charger les skills code.
2. Choisir un mécanisme adapté au runtime actuel (timer persistant ou job explicite) sans dépendre du navigateur.
3. Ajouter verrouillage transactionnel/idempotency key.
4. Envoyer seulement si validation encore courante.
5. Marquer sent uniquement après confirmation Toolbox.
6. Implémenter annulation future sur décisions humaines.
7. Ajouter diagnostics retryables vs terminal errors.
8. Tester restart/concurrence.

## Files Likely Touched

- scheduled dispatcher service
- startup wiring serveur
- message/tracking services
- tests

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- due vs future.
- double scan concurrent.
- redémarrage simulé.
- send failure.
- manual response/RDV/ignored cancels pending.
- prospect status unchanged after send.

## Acceptance Criteria

- Aucun double-envoi.
- Aucun brouillon non validé envoyé.
- Un envoi réussi devient `sent`.
- Le prospect ne passe pas automatiquement à Contacté/R1/R2.
- Les futurs emails sont annulés suite aux états humains incompatibles.

## Documentation Updates

Documenter le modèle d’exécution et la reprise après erreur.

## Handoff Notes

Le délai +4 semaines après R2 doit alimenter l’échéance/filtre de revue, jamais déclencher seul `Failure`.
