# Statut de la fiche (prospect, société, entrepôt)

Chaque fiche a un statut **calculé** (jamais saisi) : `verified` > `usable` > `incomplete`. Le code vit dans
`app/services/prospection/segments.py` (prospect, `Review`) et `app/services/file_status.py` (société, entrepôt).

## Prospect (`Review`: verified / usable / incomplete / ignored)
- **ignored** : a décliné (« Ignoré », « Non intéressé ») ou a demandé à ne plus être contacté (le motif « Ne pas
  contacter » reste sur la fiche). Masqué par défaut dans la Prospection (`include_ignored=true` pour l'afficher).
- **usable** : e-mail principal vérifié, prénom et nom, société, rôle. LinkedIn n'est pas exigé.
- **verified** : usable + emploi vérifié et à jour, ou rendez-vous pris.
- **incomplete** : le reste, à ne pas contacter.

## Société
- **usable** : nom, site web ou domaine e-mail, SIREN ou établissement localisé (code postal + ville), type
  (PME / grande / institutionnelle) et au moins un prospect `usable`.
- **verified** : usable + SIREN, raison sociale, effectif, segment commercial, au moins une catégorie d'activité.

## Entrepôt
Un entrepôt est un **bâtiment (établissement) d'une société** : `warehouses.establishment_id` (migration 0051,
rattachement automatique par SIRET au déploiement).
- **usable** : nom, code postal + ville, catégorie de prospection, rattaché à un bâtiment d'une société `usable`.
- **verified** : usable + SIRET, adresse, interlocuteur joignable (nom + e-mail, propriétaire ou contact listé).

Les listes (`GET /api/companies`, `GET /api/warehouses`) renvoient `status` et `missing` (ce qui manque pour le niveau
suivant) et acceptent le filtre `status`.
