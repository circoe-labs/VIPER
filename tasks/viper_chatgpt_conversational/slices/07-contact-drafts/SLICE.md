# Slice 07 — Brouillons de contact via MCP

Tier QA : **critical**. Dépend de la Slice 01. Référence : HANDOFF §9.

- **Outils**, tous deux sous la capacité `contact.draft` :
  - `viper_generate_contact_draft` s'appuie sur le générateur de `routes/contact_messages.py`
    (`get_mail_generator`) ;
  - `viper_update_contact_draft` s'appuie sur `save_message`, avec contrôle de révision.
- **Règle** : le brouillon reste un brouillon. Aucune validation, programmation ni envoi n'est possible ; un test
  négatif le vérifie obligatoirement.
- **Workers** : un worker n'a jamais `contact.draft` par défaut.

## Contexte de dispatch (mis à jour par le PM après la fusion des Slices 01, 02 et 04)

- Garde : `require(record, capability)` dans `backend/app/api/mcp.py`, capacité `contact.draft`. Le vocabulaire
  et les valeurs par défaut par mode sont dans `backend/app/services/agent_capabilities.py` : vérifier qu'un
  worker n'a pas `contact.draft`.
- Modèle à suivre : `backend/app/api/mcp_conversational.py`. Mettre les outils dans un module à part,
  `backend/app/api/mcp_contact.py`, pour ne pas entrer en conflit avec la Slice 03, qui avance en parallèle.
- Lecture existante : `viper_get_prospect_messages` (Slice 02).
- Annotations : non destructif ; `openWorldHint` est à `true` seulement pour la génération, si elle appelle un
  modèle externe.
- Migration : aucune n'est prévue. La Slice 03 pourrait prendre `0027`.
