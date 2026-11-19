# Relations entre personnes et graphe de prospection

Un **lien** relie deux personnes : chacune est un prospect ou un membre de l'organisation. Il remplace
l'ancien « Connaît Robin / Ne connaît pas Robin » (une note de prospect, sans nature ni force).

## Modèle (`person_links`, migration 0054)

- Non orienté : « Robin est son frère » se lit des deux côtés. Un couple de personnes n'existe qu'une fois
  (`pair_key` = les deux côtés triés).
- `relation` : libellé libre (« frère », « amis », « ancien collègue »…), 80 caractères. Les libellés déjà
  utilisés sont proposés à la saisie (`GET /api/links/relations`).
- `score` : force du lien, de 0 à 100 (100 : frère ; 78 : amis proches).
- `note` optionnelle, auteur et dates conservés. Les liens ne sont pas dans le journal d'audit (voir
  `NOT_AUDITED_TABLES`) ; la table est en lecture seule dans l'explorateur.
- Les anciennes notes « Connaît Robin » restent des notes : rien n'est converti, une note ne portait ni la
  nature ni la force du lien.

## API (`/api/links`)

`GET /graph` (filtres `min_score`, `relation`, `company_id`, `include_unlinked`), `GET /relations`,
`GET /person/{prospect|member}/{id}`, `POST`, `PATCH /{id}`, `DELETE /{id}`.
Refus : une personne liée à elle-même, un couple déjà lié (422 `duplicate`), une personne inconnue (404).

`GET /proximity/prospect/{id}` : score de proximité du prospect depuis les membres (voir `proximity-score.md`).

## Interface

- **Fiche prospect, carte « Relations »** (onglet Profil) : la liste des liens (personne, nature, force
  modifiable au curseur), suppression, et l'ajout (un membre ou un prospect trouvé par la recherche).
- **Prospection › Autres actions › Graphe de prospection** (`/prospection/graphe`) : un tableau blanc. Les
  prospects sont regroupés par société (cercle en pointillés), les membres sont à part. Un fil relie deux
  personnes ; plus il est épais et coloré, plus le lien est fort. Survoler ou cliquer une personne met ses
  liens en avant et ouvre le détail (liste des liens, ouverture de la fiche). Molette : zoom ; glisser : déplacer ;
  « Tout voir » recadre.
- Filtres : recherche d'une personne, société, nature du lien, force minimale, afficher les membres,
  étiquettes des liens, autres prospects des sociétés concernées.
- Les avatars sont les initiales sur une teinte stable : la base ne contient pas de photo de prospect. Une
  photo pourra remplacer les initiales quand elle existera.

## Membres = prospects (migration 0060)

Chaque membre de l'organisation a aussi une fiche prospect (`prospects.member_user_id`), dans la société qui *est*
l'organisation (`companies.represents_organization_id`, CIRCOE), au statut `do_not_contact` (motif « Membre de
l'organisation ») : aucune mission ni séquence ne la cible. Un prospect déjà présent (même adresse, ou même nom :
« Poté » = Robin Poté) est rattaché, pas dupliqué. Création à l'ajout d'un membre, à la première connexion
Infomaniak, à l'approbation d'une inscription, et rattrapage de l'existant au démarrage de l'API
(`services/member_prospects.py`). Limité à CIRCOE tant que les données ne sont pas isolées par organisation.
