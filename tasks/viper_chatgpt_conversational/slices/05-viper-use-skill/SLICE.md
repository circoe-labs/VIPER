# Slice 05 — Skill `viper-use` et routage CIRCOE

Tier QA : **docs**, plus `agent-trace-analysis` en Slice 08. Références : HANDOFF §11 et §12.

**État : IMPLEMENTED (2026-11-03), hors dépôt.** Décision du Human : le skill et le routage concernent la
configuration de ChatGPT, pas le dépôt VIPER, donc aucun fichier n'est ajouté au dépôt.

## Livrable

Il a été remis au Human dans `C:\Users\Clarice\Downloads\viper-use\` (et en archive `viper-use.zip`) :

- `SKILL.md` : modes interactif, worker et planifié. Toute session commence par `viper_whoami`, et les droits
  sont appliqués par le serveur.
- `EXAMPLES.md` : les demandes du handoff, avec les appels attendus pour chacune.
- `circoe-routing-snippet.md` : la section VIPER à intégrer dans le skill de routage CIRCOE côté ChatGPT.
- `README.md` : les étapes de publication.

## Suite

- Slice 08 : réconcilier les noms d'outils avec ceux réellement livrés par les Slices 01, 02, 03 et 07, puis
  fournir au Human une version à jour du skill à republier dans ChatGPT.
