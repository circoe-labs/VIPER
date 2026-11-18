# Score de proximité (prospect)

Score **0-100** qui mesure à quel point les membres de l'organisation atteignent un prospect par le graphe de
relations (`person_links`, voir `person-links.md`). **Seule implémentation canonique** du scoring de chemin :
`backend/app/services/person_proximity.py`. Les anciennes branches `task/prospect-intelligence-graph-scoring`
et `task/pi-s5/6/7` ne sont pas reprises (décision du handoff `viper_prospect_sheet_missions_scoring_redesign`).

Il est **distinct du score prospect** (`prospect_score.py`, adéquation commerciale) : le graphe ne modifie
jamais ce dernier. Déterministe, sans LLM, explicable.

## Formule (version 1)

- Arête = force du lien (0-100). Un lien de force 0 est ignoré.
- Chemin = membre → … → prospect, au plus `MAX_HOPS = 3` liens, sans boucle ; il s'arrête au premier membre
  rencontré (un chemin ne traverse pas un autre membre). Les intermédiaires sont des prospects.
- Force du chemin = `100 × Π(force/100) × HOP_FACTOR[sauts]` avec `HOP_FACTOR = {1: 1.0, 2: 0.6, 3: 0.35}`.
- Score = `100 × (1 − (1 − meilleur) × Π(1 − 0,3 × autre_i))`, sur le meilleur chemin et au plus 4 autres
  (meilleurs d'abord) : les chemins multiples augmentent le score sans jamais dépasser 100.
- Exemples : lien direct 100 → 100 ; direct 40 → 40 ; membre -100- Paul -80- Anne → 48 ; directs 60 et 50
  vers deux membres → 66.
- Bornes de sécurité : 5000 liens lus, 500 chemins énumérés. Tri déterministe (force, sauts, identifiants).

## API

`GET /api/links/proximity/prospect/{id}` (session requise ; 404 si prospect inconnu) :

```
{ prospect_id, score, state: "reachable"|"unreachable"|"empty", path_count,
  members: [{ member: Person, strength }],            # meilleure force par membre
  paths: [{ member, hops, strength, people: [Person], edges: [{a, b, relation, score}] }],  # 3 meilleurs, membre -> prospect
  formula_version, max_hops }
```

- `empty` : aucun lien (de force > 0) pour ce prospect ; `unreachable` : des liens existent mais aucun chemin
  n'atteint un membre en `max_hops` liens (score 0) ; `reachable` sinon.
- Les états `loading` et `error` sont ceux de la requête côté client.

## Recalcul

Aucune valeur stockée : chaque lecture recalcule depuis les liens. Créer, modifier ou supprimer un lien est donc
visible à la lecture suivante ; côté client la clé de requête est sous `['links']`, que les mutations de
`useLinkMutations` rafraîchissent.

## Front

`frontend/src/api/proximity.ts` (types + `useProspectProximity`), `ProximityScoreCard.tsx` (carte autonome :
chargement, erreur avec « Réessayer », vide, inatteignable, score + meilleurs chemins), `proximityView.ts`
(tons d'affichage : ≥67 Proche, ≥34 Accessible, sinon Lointain). La slice S1 place la carte dans la bande
d'indicateurs de la fiche ; S3 ne touche pas `ProspectEditor.tsx`.

Tests : `backend/tests/test_person_proximity.py`, `frontend/src/prospects/ProximityScoreCard.test.tsx`.
