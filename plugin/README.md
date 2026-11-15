# Plugin Claude « viper »

Skills d'usage de VIPER pour les agents (Claude Code, Claude Desktop) :

- `readme-viper` : point d'entrée (`/readme-viper`), identifie la situation et charge le bon skill ;
- `viper-create-mission` : créer / modifier une mission avec l'utilisateur ;
- `viper-run-mission` : s'identifier, prendre une tâche, travailler, rendre le résultat, se désinscrire ;
- `viper-ask-data` : répondre aux questions sur la base, avec graphiques.

`viper/.mcp.json` déclare le serveur MCP VIPER (`https://viper.circoe.com/mcp`, OAuth).
Essai local : `claude --plugin-dir plugin/viper`.
