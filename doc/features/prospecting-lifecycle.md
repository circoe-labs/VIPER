# Cycle de vie de prospection : statut, archive, exclusion

Qui peut être prospecté, pourquoi pas, et comment il revient. Migration 0063.

## La règle (un seul propriétaire : `app/services/eligibility.py`)

Une personne est **prospectable** sauf si un blocage s'applique ; le premier de cette liste est celui affiché.

| Code | Cause | Retour |
|---|---|---|
| `prospect_do_not_contact` | opposition « Ne pas contacter » | uniquement l'opération dédiée, avec motif |
| `prospect_departed` | activité « Inactif » (retraite, départ…) | « De retour en poste » : activité « Inconnu », emploi à revérifier |
| `prospect_archived` / `company_archived` | fiche ou entreprise archivée | « Désarchiver » |
| `prospect_excluded` / `company_excluded` | exclusion temporaire, sans date de fin, motif obligatoire | « Réintégrer », avec la nouvelle information ou le nouvel angle |

Le blocage est lu sur les lignes courantes : rien n'est recopié sur la personne. Une personne d'une entreprise
exclue qui change d'entreprise redevient prospectable ; son ancien poste ne l'est pas.

**« Incomplet »** n'est pas un blocage : c'est le statut calculé de la fiche (`doc/features/file-status.md`), qui
redevient exploitable de lui-même dès que les informations requises sont là. Aucun retour automatique ne lève une
opposition, une exclusion, une archive ni un départ.

## Où la règle s'applique

- Listes et compteurs : `segments.actionable` et `contact_sequences.due_open_sql` (donc échéances, « à envoyer »,
  retards, Accueil, planification) ; les bloqués d'une semaine de contact sont dans « Écartés ». La raison de pause
  d'une séquence dit `departed`, `archived` ou `excluded`.
- Préparation : génération, rédaction, validation, programmation, réouverture et brouillon Infomaniak sont refusés
  (409 avec le code), y compris par MCP. Déclarer un envoi réellement fait (« Marquer comme envoyé », import) reste
  possible, sauf opposition.
- Envoi : le dispatcher revérifie sous verrou et annule au lieu d'envoyer, quel que soit le chemin qui a écrit le
  blocage.
- Courriers entrepôt : un destinataire qui est l'adresse d'une personne bloquée, ou l'entrepôt d'une entreprise
  archivée ou exclue, est refusé à la validation, à la programmation et à l'envoi.
- Export : colonne « Prospection ». Lectures MCP : `prospecting_block`.

## Retirer (`app/services/lifecycle.py`, une personne uniquement)

`POST /api/prospects/{id}/lifecycle` (`archive`, `unarchive`, `exclude`, `reinstate`, `depart` +
`departure_reason`, `return`) et `POST /api/companies/{id}/lifecycle` (les quatre premières), avec `reason`.

- Les messages **validés ou programmés** non envoyés sont annulés avec le code en `cancel_reason` et la trace du
  créneau (`missed_*`) ; les brouillons sont conservés. Un message en cours d'envoi est compté (`in_flight`).
- Les courriers entrepôt préprogrammés ou programmés concernés passent en échec avec le code.
- Les mêmes annulations suivent un départ saisi par l'éditeur, une revue d'agent, un import, un changement
  d'entreprise ou l'explorateur.
- Réintégrer ne reprogramme rien.
- Une annulation garde le doute « peut-être parti » d'un message (`contact.md` § Effective schedule).
- Rien n'est supprimé : `prospecting_holds` garde qui a retiré et réintégré, quand et pourquoi ; l'historique des
  fiches le montre.

## Interface

- Fiche prospect : bouton « Statut », menu « … » (« Changer de statut… », « Archiver… »), bandeau quand la personne
  est hors prospection. Fiche entreprise : « Statut » et « Archiver ». Menus de ligne : listes Prospects, Entreprises
  et Contact.
- Les archivés sont masqués des listes Prospects et Entreprises ; filtre « Afficher les archivés »
  (`include_archived`).

## Changement d'adresse e-mail (`app/services/contact_recipients.py`)

Quand l'adresse principale change, ou qu'une adresse est modifiée, désactivée ou retirée (éditeur ou explorateur),
les messages non envoyés suivent : la nouvelle principale remplace l'ancienne ; un message validé ou programmé
redevient brouillon (`recipient_changed`, créneau gardé en trace, brouillon Infomaniak supprimé, doute « peut-être
parti » conservé ou levé si le brouillon programmé était introuvable ; l'éditeur le dit au-dessus de l'objet). Le choix d'une
autre adresse toujours active est conservé.
