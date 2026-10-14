# Specification cible

## 1. Donnees de note

Minimum recommande :

- `id`
- `contact_id`
- `fact_text`
- `date`
- `source_type` optionnel
- `source_label` optionnel
- `created_at`
- `updated_at`
- `score_contribution_id` optionnel

Une note doit rester un fait court. Ne pas transformer cette structure en mini-CRM complexe dans cette tache.

## 2. Contrat de scoring

Le front doit pouvoir consommer un objet equivalent a :

```text
ProspectScore
- total: integer 0..100
- summary: short text
- status/color_band: optional semantic value
- contributions[]
  - id
  - delta: signed integer
  - reason: short text
  - source_type: optional
  - source_ref: optional
  - created_at: optional
  - created_by / origin: optional
```

Le `total` est la valeur autoritative fournie par la couche de scoring. Le composant UI ne doit pas reconstituer un algorithme metier a partir des seules contributions sauf si l'architecture existante impose explicitement ce calcul.

## 3. Profil

Le profil doit distinguer clairement :

- lecture / resume ;
- edition.

Le resume prioritaire contient :

- nom complet ;
- role et entreprise ;
- e-mail ;
- telephone ;
- autres coordonnees deja prises en charge par le produit ;
- statut secondaire utile, si necessaire.

L'emploi peut conserver sa propre section, mais doit etre plus compacte et informative.

## 4. Carte Score prospect

Etat normal :

- anneau/cercle avec valeur 0-100 ;
- code visuel rouge / jaune / vert ;
- resume de quelques lignes maximum ;
- affordance claire indiquant que le detail est consultable.

Etat detail : drawer, popover large ou panneau conforme aux patterns existants. Afficher les contributions triees de maniere comprehensible, avec delta, raison et source lorsqu'elle existe.

Etats speciaux :

- score indisponible ;
- aucun signal ;
- chargement ;
- erreur ;
- score present mais aucun breakdown disponible.

## 5. Notes

Pattern cible : liste dense de lignes / items, et non carte volumineuse par fait.

Chaque item met en avant :

1. le fait ;
2. les metadonnees discretes ;
3. un delta de score eventuel ;
4. les actions secondaires seulement quand necessaire.

L'ajout d'une note doit etre rapide. La date peut utiliser une valeur par defaut raisonnable si le produit le permet, tout en restant modifiable.

## 6. Contexte pour l'agent de redaction

Le payload / contexte doit fournir une structure stable, par exemple :

```text
contact_context
- identity
- employment
- contact_methods
- notes[]
- prospect_score
  - total
  - summary
  - top_contributions[]
```

Eviter de transmettre seulement un texte concatene si une structure existe deja dans l'architecture agent.
