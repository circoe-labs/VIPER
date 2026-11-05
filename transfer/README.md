# Transfert de la base locale du 5 novembre 2026

`viper-local-20261105.dump.gpg` est une sauvegarde PostgreSQL complète de la base locale,
chiffrée avec GnuPG (AES-256). La phrase de déchiffrement est transmise séparément et ne doit
pas être ajoutée au dépôt. L'archive contient aussi les comptes et données techniques : la
garder privée après déchiffrement.

Cette copie correspond à la révision Alembic `0032` et contient 40 entrepôts, 138 contacts
d'entrepôt, 812 entreprises et 1 049 prospects. Sa restauration dans une base temporaire a été
testée. Elle représente un instantané, pas une liste des changements depuis la production.

## Préparer la comparaison sur le PC administrateur

Récupérer `main`, puis dans un emplacement privé (avec GnuPG installé) :

```sh
mkdir -p "$HOME/viper-transfer-private"
chmod 700 "$HOME/viper-transfer-private"
gpg --output "$HOME/viper-transfer-private/viper-local.dump" --decrypt transfer/viper-local-20261105.dump.gpg
chmod 600 "$HOME/viper-transfer-private/viper-local.dump"
pg_restore --list "$HOME/viper-transfer-private/viper-local.dump"
```

Restaurer ensuite cette archive dans **une nouvelle base PostgreSQL isolée**, jamais directement
dans la base de production. Sauvegarder la production, comparer les données et leur historique,
puis choisir et effectuer une fusion adaptée. Les comptes, sessions, jetons, paramètres et
identifiants doivent être traités séparément : écraser la production avec cet instantané pourrait
effacer les données créées sur le serveur ou modifier les accès. La fusion et le déploiement
nécessitent l'accès au serveur et ne sont pas exécutés automatiquement par ce fichier.

Après utilisation, supprimer les copies déchiffrées et la base temporaire selon les procédures
du serveur. Ne jamais committer la sauvegarde déchiffrée ni la phrase de déchiffrement.
