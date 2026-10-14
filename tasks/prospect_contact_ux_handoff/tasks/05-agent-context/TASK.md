# Task 05 — Exposition notes + score au contexte de l'agent de redaction

## Goal

Permettre a l'agent qui redige les e-mails d'utiliser directement les faits pertinents et le scoring pour trouver un angle d'approche personnalise.

## Context

Le score n'a pas seulement une fonction d'affichage. Son resume et ses principales raisons doivent enrichir le contexte disponible lors de la redaction.

## Scope

### In Scope

- ajout des notes / faits pertinents au contexte ;
- ajout du score total ;
- ajout du resume ;
- ajout des principales contributions ;
- contrat stable et testable ;
- comportement degrade si une partie des donnees manque.

### Out of Scope

- reecriture complete du prompt de redaction ;
- nouvelle strategie commerciale generale ;
- ingestion automatique de sources externes.

## Dependencies

Task 01 terminee ; Tasks 02 et 04 recommandees pour aligner les donnees visibles et les donnees agent.

## Implementation Steps

1. Charger `/caveman` et `/coding-guideline`.
2. Localiser le builder / serializer de contexte de l'agent.
3. Ajouter une structure `notes` / `facts` plutot qu'une concat simple si l'architecture le permet.
4. Ajouter `prospect_score.total`, `summary` et un sous-ensemble pertinent des contributions.
5. Eviter de dupliquer inutilement les memes informations dans plusieurs champs textuels.
6. Definir un ordre de priorite raisonnable pour les contributions transmises sans inventer une logique commerciale cachee.
7. Ajouter tests de contrat et snapshot si utilises dans le projet.

## Files Likely Touched

Builder de contexte agent, types / DTO, tests, eventuels prompts ou serializers.

## Architecture Constraints

- Conserver des donnees structurees jusqu'au plus tard possible.
- Ne pas transformer le score en consigne imperative pour l'agent ; il s'agit d'un contexte explicatif.
- Ne pas transmettre de champs inexistants comme s'ils etaient verifies.

## Testing Requirements

- contact avec notes + score ;
- contact sans notes ;
- score sans breakdown ;
- aucune donnee de score ;
- plusieurs contributions ;
- compatibilite avec le format attendu par l'agent existant.

## Acceptance Criteria

- L'agent recoit les faits disponibles et le score de maniere stable.
- Le resume et les contributions peuvent etre utilises pour personnaliser un e-mail.
- L'absence partielle de donnees ne casse pas la redaction.
- Les tests prouvent la presence des nouveaux champs.

## Documentation Updates

Mettre a jour la documentation du contexte agent / schema de payload.

## Handoff Notes

L'objectif est d'aider l'agent a trouver un angle pertinent, pas de lui faire inventer des faits absents.
