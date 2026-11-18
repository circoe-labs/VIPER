# VIPER — Refonte fiche prospect, missions contextuelles et scoring

## Mission
Faire évoluer la fiche prospect VIPER autour de trois objectifs :
1. adopter la nouvelle hiérarchie visuelle validée (scores/états prioritaires, résumé, coordonnées, cartes alignées, padding et densité maîtrisés) sans recopier littéralement la maquette ;
2. conserver les deux onglets **Profil / Suivi** et appliquer une organisation cohérente aux deux ;
3. rendre la fiche actionnable avec un **menu Mission** contextuel et des actions de rescoring/proximité fondées sur les briques existantes de VIPER.

Projet : **VIPER**  
Repository : `circoe-labs/VIPER`  
Référence visuelle : `references/selected-prospect-sheet-visual.png`  
Source fonctionnelle : `references/source-verite-pipeline-v2.md`

## Décisions produit verrouillées
- La référence visuelle est une **direction de design**, pas un wireframe contractuel : les données, labels et emplacements exacts restent soumis aux contrats réels du produit.
- Garder les onglets **Profil** et **Suivi**.
- En haut de Profil, prioriser : **Score prospect**, **État de la fiche**, **Score de proximité**, identité/résumé puis coordonnées.
- Le **Score prospect** mesure uniquement l'intérêt commercial / l'adéquation du prospect aux critères cibles. Le graphe relationnel ne doit plus modifier ce score.
- La **Qualité de la fiche** ne doit plus être présentée comme un score 0–100. Elle devient un **état de complétude** lisible (p. ex. Incomplète / Exploitable / Fournie / Très fournie), même si le backend conserve éventuellement un calcul interne.
- Ajouter un **Score de proximité 0–100** distinct, calculé à partir du graphe de relations et de la distance/force des chemins depuis des membres Circoe vers le prospect.
- Le score de proximité doit réutiliser le graphe actuel et se coordonner avec la tâche existante `viper_prospect_intelligence_graph_scoring_followups` ; ne pas créer un second algorithme concurrent si un contrat canonique existe/atterrit.
- Ajouter un bouton **Mission** dans la zone d'actions de la fiche. Il ouvre un menu compact, pas un écran plein.
- Menu Mission : grille 2×2 de raccourcis **Complète cette fiche**, **Réanalyse son score**, **Cherche ses relations**, **Autre**. Le mode Autre accepte un texte libre et une saisie micro.
- Toute mission créée depuis la fiche doit être pré-ciblée sur le prospect courant et transporter le contexte utile (identité, entreprise, objectif), via l'infrastructure Missions existante.
- Le score prospect peut être **réévalué** depuis sa carte/action. Cette action passe par un agent VIPER/mission traçable et doit produire une justification explicable ; elle ne doit pas créer une API IA parallèle non traçable.
- Clic droit / menu contextuel sur la fiche : au minimum **Contacter** avec un équivalent accessible au clavier/bouton. Ne jamais rendre l'action uniquement disponible au clic droit.

## Exécution asynchrone
Slice 00 est le gate Project Manager. Après `READY`, les Slices **01, 02, 03, 04, 05, 06** peuvent avancer en parallèle dans la mesure où le contrôle de fraîcheur confirme l'absence de collisions de fichiers. Les Slices UI travaillent contre fixtures/contrats temporaires quand les contrats backend ne sont pas encore intégrés.

Initial ready set : **01 + 02 + 03 + 04 + 05 + 06**.

Chaînes dures principales :
- `01 + 02 + 03 + 04 + 05 + 06 -> 07`
- aucun autre `depends_on` n'est imposé par défaut ; les dépendances entre score/proximité/UI sont des `requires` avec fixtures, afin d'éviter une sérialisation artificielle.

## QA
Les Slices d'implémentation font revue, type/build/static checks ciblés et smoke checks bornés. **Ne pas lancer les suites unitaires complètes à la fin de chaque Slice.** Slice 07 est l'unique convergence qui exécute la campagne complète unit + intégration + E2E, avec validation responsive et accessibilité.
