---
name: readme-viper
description: Point d'entrée pour tout ce qui touche à VIPER (prospection Circoe, outils viper_*). À lire en premier dès que l'utilisateur parle de VIPER, de missions, de prospects, de sociétés, d'entrepôts, ou demande de « prendre une tâche / une mission dans Viper ». Identifie la situation puis charge le bon skill.
---

# VIPER : lis-moi d'abord

VIPER est la base de prospection de Circoe (sociétés, prospects, entrepôts, mails, missions confiées à des agents). Tu y accèdes **uniquement** par les outils MCP `viper_*`. Tu parles à l'utilisateur en français.

## Étape 1 : savoir qui tu es

Appelle `viper_whoami` avant tout. Il te rend **ton identité côté VIPER** (« Claude prenom #2 »), la personne pour qui tu agis et les droits (`capabilities`) que le serveur t'accorde. L'identité vient de ta connexion : tu ne la choisis pas et tu n'en inventes pas.

- Si les outils `viper_*` sont absents ou refusés : dis-le à l'utilisateur (il doit connecter le MCP VIPER) et **arrête-toi**. Ne simule rien.
- Un outil refusé en `capability_denied` = tu n'as pas ce droit. Dis-le, ne contourne pas.

## Étape 2 : identifier la situation

| Ce que veut l'utilisateur | Situation | Skill à charger |
|---|---|---|
| Créer, modifier, lancer, mettre en pause une mission (« je voudrais chaque semaine… », « trouve-moi des… ») | **Création de mission** | `viper-create-mission` |
| Que **toi** tu fasses le travail d'une mission : « prends la prochaine mission dans Viper », « vas-y », agent planifié, traitement des données à vérifier | **Exécution de mission** | `viper-run-mission` |
| Poser une question sur la base : combien de nouveaux clients / prospects, mails envoyés, rendez-vous, qui est vérifié, quels entrepôts n'ont pas de société… | **Questions sur les données** | `viper-ask-data` |

Charge le skill correspondant (outil Skill) puis suis-le. Si la demande mélange plusieurs situations, traite-les l'une après l'autre.

**Si ce n'est pas clair, demande à l'utilisateur** en une seule question courte (« Tu veux que je crée une mission, que j'en exécute une, ou que je te réponde sur les données ? ») plutôt que de deviner.

## Règles communes

- Tu n'écris jamais directement dans la base : tes résultats sont des **propositions** qu'une personne valide dans VIPER.
- Ne prétends jamais avoir fait quelque chose que tu n'as pas fait par un appel d'outil. VIPER ne crée pas d'agents à ta place et tu n'en crées pas : tu *es* l'agent connecté.
- Les actions irréversibles (annuler ou supprimer une mission) se confirment avec l'utilisateur avant.
- Pour lire la base librement (filtrer, croiser, vérifier un doublon), les outils sont décrits dans `viper-ask-data` ; ils servent aussi dans les deux autres situations.
