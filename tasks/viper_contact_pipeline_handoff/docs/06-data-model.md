# 06 — Modèle de données cible

Ce document propose un schéma cible compatible avec les décisions du grill. Les noms SQL précis peuvent être adaptés au style du dépôt, mais la sémantique ne doit pas changer.

## 1. `contact_tracking`

### État

Recommandation : conserver la table mais migrer `status` vers :

```text
neutral
contacted
r1
r2
response_received
appointment_obtained
failure
ignored
```

Le défaut devient `neutral`.

### Échéance

Ajouter ou renommer vers :

```text
next_action_year INTEGER NULL
next_action_week INTEGER NULL
```

Les anciens `contact_year` / `contact_week` peuvent être migrés puis conservés comme alias transitoires ou supprimés dans une migration contrôlée. Éviter de garder deux sources de vérité actives.

`planned_contact_at` ne doit plus être utilisé comme substitut ambigu de la semaine métier. La date exacte d’envoi appartient au message.

## 2. Migration des anciens statuts

Mapping sûr recommandé :

| Ancien | Nouveau | Note |
|---|---|---|
| `to_contact` | `neutral` | si une semaine existe, elle devient `next_action_*`; pas de badge d’état |
| `contacted` | `contacted` | direct |
| `follow_up_1` | `r1` | direct |
| `follow_up_2` | `r2` | direct |
| `response_received` | `response_received` | direct |
| `appointment_obtained` | `appointment_obtained` | direct |
| `quote_sent` | `appointment_obtained` | post-RDV, préserver l’ancien statut dans l’historique/audit |
| `quote_follow_up` | `appointment_obtained` | idem |
| `won` | `appointment_obtained` | idem pour le scope Contact actuel |
| `not_interested` | `failure` ou `ignored` selon le blocage durable | si `contactability_status=do_not_contact`, préférer `ignored`; sinon `failure` |

La migration doit être testée sur une copie et produire des compteurs avant/après.

## 3. `prospects.activity_status`

Le champ actuel `activity_status` ne doit plus servir de statut de pipeline et le label `Inconnu` ne doit plus être mis en avant dans les cartes ou dashboards.

Pour minimiser les risques :

- ne pas supprimer le champ dans le même lot sans nécessité ;
- le considérer comme legacy / donnée annexe ;
- retirer les compteurs `unknown` du dashboard métier ;
- retirer le fallback visuel « Inconnu » pour l’état du prospect ;
- traiter l’identité manquante via un indicateur de qualité de donnée, pas un état commercial.

## 4. Nouvelle table `contact_messages`

Proposition :

```text
id TEXT PRIMARY KEY
prospect_id TEXT NOT NULL
step TEXT NOT NULL                -- contact | r1 | r2
status TEXT NOT NULL              -- draft | validated | scheduled | sent | cancelled
from_email TEXT
subject TEXT NOT NULL DEFAULT ''
body_text TEXT NOT NULL DEFAULT ''
to_recipients_json TEXT NOT NULL DEFAULT '[]'
cc_recipients_json TEXT NOT NULL DEFAULT '[]'
bcc_recipients_json TEXT NOT NULL DEFAULT '[]'
scheduled_at TEXT NULL
validated_at TEXT NULL
validated_by_actor_id TEXT NULL
sent_at TEXT NULL
cancelled_at TEXT NULL
cancel_reason TEXT NULL
remote_provider TEXT NULL         -- infomaniak/toolbox
remote_draft_id TEXT NULL
generation_model TEXT NULL
generation_prompt_version TEXT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Contrainte unique :

```text
UNIQUE(prospect_id, step)
```

Pour la V1, un seul message durable par étape suffit. Si le produit doit plus tard conserver plusieurs variantes, introduire une table de versions plutôt que de casser ce contrat silencieusement.

## 5. Historique des messages

Recommandé : `contact_message_events` ou audit existant pour tracer :

- generated
- edited
- validated
- unvalidated_by_edit
- scheduled
- sent
- cancelled
- send_failed

Ne pas écrire le corps complet dans l’audit global si cela crée une fuite de données ; conserver les versions dans la table métier si nécessaire.

## 6. Règles d’intégrité

- `scheduled_at` obligatoire si status=`scheduled` ;
- `sent_at` obligatoire si status=`sent` ;
- `remote_draft_id` peut être absent tant que l’intégration Toolbox n’est pas active ;
- une édition d’un message `validated`/`scheduled` remet `status=draft`, efface `validated_at` et invalide/supprime le remote draft ;
- un message `sent` ne peut pas être modifié ;
- `ignored` implique `contactability_status=do_not_contact` ;
- aucun import ne peut repasser `do_not_contact` à `contactable`.
