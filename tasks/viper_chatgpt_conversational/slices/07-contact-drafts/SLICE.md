# Slice 07 — Brouillons de contact via MCP

Tier QA : **critical**. Dépend de la Slice 01. Référence : HANDOFF §9.

- **Outils**, tous deux sous la capacité `contact.draft` :
  - `viper_generate_contact_draft` s'appuie sur le générateur de `routes/contact_messages.py`
    (`get_mail_generator`) ;
  - `viper_update_contact_draft` s'appuie sur `save_message`, avec contrôle de révision.
- **Règle** : le brouillon reste un brouillon. Aucune validation, programmation ni envoi n'est possible ; un test
  négatif le vérifie obligatoirement.
- **Workers** : un worker n'a jamais `contact.draft` par défaut.
