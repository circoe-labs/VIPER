# 01 — Journal des décisions verrouillées

Les décisions sont listées dans l’ordre logique. Lorsqu’une décision plus récente contredit une proposition antérieure, la plus récente prévaut.

| # | Décision verrouillée | Conséquence |
|---|---|---|
| 1 | `Inconnu` n’est plus un statut métier visible. | Supprimer les compteurs/badges/filtres qui utilisent « Inconnu » comme état par défaut. |
| 2 | `Validé / Non validé` n’est plus un statut global du prospect. | Garder les vérifications au niveau des champs (email, qualité de donnée), pas du pipeline. |
| 3 | Une fiche identifiable peut exister sans email. | Ne pas supprimer les fiches à enrichir ; distinguer présence en base et capacité de contact. |
| 4 | L’état initial est neutre et n’affiche aucun badge. | Le backend doit supporter `neutral` ou équivalent interne, sans label UI. |
| 5 | La semaine de prochaine échéance est séparée de l’état. | Deux badges/indicateurs indépendants sur les cartes. |
| 6 | États visibles : aucun, Contacté, R1, R2, Réponse reçue, RDV pris, Failure, Ignoré. | Remplacer la taxonomie actuelle. |
| 7 | `Ignoré` est terminal et persistant. | Doit renforcer `do_not_contact`; un réimport ne doit jamais réactiver le contact. |
| 8 | `RDV pris` remplace `Done`. | Arrêt du périmètre commercial à la prise de rendez-vous. |
| 9 | `Réponse reçue` est un état à part entière. | Affichage sélectionnable ; futurs messages annulés après choix humain. |
| 10 | Toutes les transitions d’état sont humaines en V1. | Aucun auto-classement depuis mail/Calendly et aucun auto-passage en Failure. |
| 11 | Contact→R1 = +2 semaines par défaut. | Helper de cadence centralisé. |
| 12 | R1→R2 = +2 semaines par défaut. | Même helper. |
| 13 | Après R2, échéance de revue = +4 semaines. | Afficher une prochaine semaine, mais exiger une décision humaine pour `Failure`. |
| 14 | La semaine métier et la date/heure d’envoi sont deux données distinctes. | `next_action_week` n’est pas `scheduled_at`. |
| 15 | Exploitation est renommé Contact. | Navigation, route/page, textes. |
| 16 | Contact reprend le langage visuel de Prospection mais pas ses métriques. | Composants partagés, dashboard spécifique. |
| 17 | Le compteur « à traiter cette semaine » distingue premier contact / relances. | Query agrégée + filtre cliquable. |
| 18 | Un compteur cumulé `RDV pris` est demandé. | Query + filtre cliquable. |
| 19 | Clic prospect dans Contact = fiche à gauche, mail à droite. | Ne pas réutiliser le drawer Prospection comme interaction principale. |
| 20 | Trois onglets : Contact, R1, R2. | Un message durable par étape et prospect. |
| 21 | Les messages envoyés sont consultables mais non modifiables. | Verrouillage UI + backend. |
| 22 | Un message généré mais non validé reste Brouillon. | L’IA ne peut jamais produire un message directement envoyable. |
| 23 | Validation humaine individuelle de chaque message. | Contact/R1/R2 possèdent chacun leur validation. |
| 24 | Modifier un message validé annule sa validation précédente. | Retour à Brouillon et revalidation obligatoire. |
| 25 | VIPER gère la programmation ; Toolbox exécute le mail. | Stocker `scheduled_at` dans VIPER et envoyer via `send_draft` au moment voulu. |
| 26 | Le seul usage IA de ce lot est la rédaction/prérédaction. | Aucun agent de workflow, aucune décision automatique. |
| 27 | La détection de réponses mail est hors périmètre. | `Réponse reçue` est choisi manuellement. |
| 28 | La détection de rendez-vous est hors périmètre. | `RDV pris` est choisi manuellement. |
| 29 | Après choix humain `Réponse reçue`, `RDV pris` ou `Ignoré`, les futurs messages sont annulés. | Effet mécanique transactionnel, sans décision IA. |

## Décisions antérieures explicitement supersédées

- L’ancien statut `À contacter` n’est plus un badge d’état : un prospect neutre avec une semaine signifie qu’un premier contact est prévu.
- Les anciens états `À relancer R1` / `À relancer R2` disparaissent : la relance à venir est déduite du dernier état + de la prochaine semaine.
- L’ancienne cadence cible d’environ une semaine est remplacée par 2 semaines entre Contact/R1/R2.
- L’ancien pipeline post-rendez-vous (devis, commande) n’appartient pas à cette page Contact V1.
- Toute idée d’auto-détection de réponse ou d’auto-transition est retirée de ce lot.
