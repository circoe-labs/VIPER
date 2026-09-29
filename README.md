# VIPER V1 — branche GPT

Implémentation V1 orientée **base de données + interface humaine**, conforme au handoff revu du 10 septembre 2026.

## Inclus
Authentification mono-utilisateur, base SQLite normalisée, audit/provenance, Home, Prospection, édition prospect, suivi de contact, import XLSX contrôlé, export normalisé, Database Explorer, SQL read-only côté serveur, Settings, recherche globale et Exploitation en placeholder explicite.

Aucun IProspect/IContact, envoi email, synchronisation Calendly ou CRM riche n'est simulé.

## Démarrage

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

Identifiants de développement par défaut : `commercial@example.test` / `change-me-now`. À remplacer hors développement.

## Persistance des données

Les données VIPER ne sont plus stockées dans le checkout Git. Par défaut, SQLite et les classeurs Excel importés sont conservés dans `~/.viper` :

- `~/.viper/viper.sqlite` : base VIPER persistante ;
- `~/.viper/imports/` : copie locale des classeurs importés.

Un redémarrage de VIPER, un `git pull` ou une modification du code ne doit donc plus effacer les prospects importés.

Au premier démarrage avec cette version, si une ancienne base existe encore dans `./data/viper.sqlite`, VIPER la recopie automatiquement vers le stockage persistant.

Pour un serveur, Docker ou une VM, définir `VIPER_STORAGE_DIR` vers un volume réellement persistant, par exemple `/data/viper`. `VIPER_DB_PATH` reste disponible si un chemin SQLite précis doit être imposé.

Les classeurs réels restent des données privées locales : ils sont archivés hors du dépôt et ne sont jamais commités sur GitHub.

## Git et branche GPT

Le dépôt distant est `https://github.com/circoe-labs/VIPER.git`. La branche de travail locale est `GPT` et suit `origin/GPT`.

```powershell
cd C:\Projects\Viper
git status
git pull --rebase origin GPT
git add <fichier-modifié>
git commit -m "Décrire la modification"
git push origin GPT
```

Explications :

- `git status` affiche les fichiers modifiés et la branche active.
- `git pull --rebase origin GPT` récupère les changements distants en conservant un historique linéaire.
- `git add` prépare les fichiers à valider.
- `git commit` enregistre une modification localement.
- `git push origin GPT` publie les commits sur GitHub.

Git Credential Manager utilise le compte GitHub authentifié sur cette machine. Pour vérifier le compte connu par Git :

```powershell
git credential-manager github list
```

## Données privées
Le classeur réel `BASE_CLIENT.xlsx` n'est jamais commité. `.gitignore` et la CI bloquent explicitement sa publication. Les tests n'emploient que des données synthétiques.

## Limite explicitement non masquée
Le Database Explorer propose la lecture technique et la console SQL read-only ; le niveau DBeaver complet pour les mutations génériques avancées reste partiel et est marqué comme tel dans `tasks-status.md` et `docs/IMPLEMENTATION_REPORT.md`.
