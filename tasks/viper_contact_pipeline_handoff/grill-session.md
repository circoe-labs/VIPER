# Session de grill reconstruite — cycle Contact VIPER

> This is a reconstructed grill session based on available conversation context.
>
> La formulation ci-dessous reconstruit les décisions utiles à l’implémentation. Elle ne prétend pas être un verbatim intégral. Les corrections les plus récentes de l’utilisateur priment toujours sur les décisions antérieures contradictoires.

## 1. Problème initial : « Inconnu »

L’utilisateur observe environ 158 personnes affichées comme « inconnues » alors que la base source Excel ne contenait pratiquement pas d’inconnus au sens métier. Il précise qu’un véritable inconnu serait au mieux une donnée partielle impossible à rattacher correctement à une personne, par exemple une adresse générique sans identité, et non un prospect simplement non traité ou non validé.

### Décision

- `Inconnu` disparaît comme statut métier du pipeline.
- Une identité partielle relève de la **qualité de donnée**, pas d’un statut commercial.
- Une fiche identifiable peut rester en base même si elle doit encore être enrichie.
- Une fiche sans information exploitable peut être exclue de l’import, mais elle ne doit pas contaminer le pipeline avec un statut « Inconnu » par défaut.

## 2. Suppression de « Validé / Non validé » au niveau prospect

Le mot « validé » mélangeait la qualité de donnée, la vérification de l’email et la décision de contacter quelqu’un.

### Décision

- Aucun statut global `Validé / Non validé` pour une personne.
- La validation reste une propriété de données spécifiques, notamment l’email.
- La décision de prospection est indépendante de la fiabilité de ces champs.
- Le classeur source utilisé comme base doit être considéré comme une source déjà travaillée ; l’import ne doit pas transformer l’absence d’action commerciale en invalidité.

## 3. Présent dans la base vs contactable

### Décision

- Une personne identifiable peut exister dans la base sans être encore contactable.
- Une personne avec entreprise + email mais sans nom complet peut rester en base comme identité incomplète.
- Une personne avec nom/entreprise mais sans email peut rester en base pour enrichissement ultérieur.
- Une personne sans entreprise identifiable ni moyen de contact exploitable peut être exclue.

## 4. État neutre

L’utilisateur confirme qu’un prospect peut exister sans aucune décision de contact.

### Décision

- Le premier état est **neutre**.
- L’état neutre n’affiche **aucun badge d’état**.
- La décision humaine de planifier un premier contact pour une semaine donnée est ce qui fait entrer le prospect dans le planning de Contact.
- La semaine est visible séparément du badge d’état.

## 5. Première version du cycle, puis simplification

Une première proposition distinguait `À contacter`, `Contacté`, `À relancer R1`, `Relancé R1`, etc. L’utilisateur revient ensuite sur cette granularité et demande une représentation plus simple.

### Décision finale

Le badge d’état décrit **la dernière étape / situation actuelle**, et le badge semaine décrit **la prochaine échéance**.

États visibles retenus :

- aucun badge — aucune étape déjà réalisée ;
- `Contacté` ;
- `R1` ;
- `R2` ;
- `Réponse reçue` ;
- `RDV pris` ;
- `Failure` ;
- `Ignoré`.

Exemples d’interprétation :

- aucun badge + `S40` = premier contact prévu en semaine 40 ;
- `Contacté` + `S42` = premier contact déjà effectué, prochaine échéance en semaine 42 ;
- `R1` + `S44` = première relance déjà effectuée, prochaine échéance en semaine 44 ;
- `R2` + `S48` = deuxième relance déjà effectuée, revue/clôture prévue en semaine 48 si toujours sans résultat.

Les badges d’état et de semaine doivent être visibles sur la carte prospect en **Prospection** et **Contact**, même quand la carte est repliée.

## 6. Sens des états terminaux / de pause

### `Réponse reçue`

- État sélectionnable comme les autres.
- Signifie : le contact a répondu mais aucun rendez-vous n’a encore été pris et la séquence n’est pas considérée comme échouée.
- Les futurs emails de la séquence doivent être annulés quand l’humain place le prospect dans cet état.
- Il n’y a pas de détection automatique de la réponse dans ce lot.

### `RDV pris`

- Remplace l’ancien libellé générique `Done`.
- Signifie qu’un rendez-vous a effectivement été obtenu.
- L’outil ne gère pas encore le pipeline commercial détaillé après ce point.
- Les futurs emails de la séquence doivent être annulés.

### `Failure`

- Séquence terminée sans rendez-vous.
- Après `R2`, une échéance de revue est proposée quatre semaines plus tard.
- Correction finale importante : **le passage en Failure n’est pas automatique en V1** ; l’état est changé/validé par l’humain.

### `Ignoré`

- État terminal et persistant.
- Couvre une exclusion volontaire / une personne à ne plus contacter.
- La fiche ne doit pas nécessairement être supprimée : elle doit conserver assez d’identité pour empêcher une réintégration future.
- Cet état doit s’aligner sur la protection durable `do_not_contact` déjà existante.

## 7. Toutes les transitions d’état sont humaines en V1

Une proposition intermédiaire prévoyait une détection automatique des réponses via la boîte mail. L’utilisateur l’annule explicitement.

### Décision finale

- Aucun event de retour de boîte mail n’est traité dans ce lot.
- Aucun rendez-vous Calendly n’est détecté automatiquement.
- Tous les états sont choisis / validés par un humain.
- Aucun agent ne décide seul qu’un prospect est `Réponse reçue`, `RDV pris`, `Failure` ou `Ignoré`.
- Les automatisations mécaniques déclenchées **après une décision humaine** restent permises, par exemple annuler les emails futurs après passage manuel à `Réponse reçue` ou `RDV pris`.

## 8. Cadence

### Décision

- Intervalle par défaut : **2 semaines** entre Contact et R1, puis **2 semaines** entre R1 et R2.
- Après R2 : **4 semaines** avant l’échéance de revue / clôture proposée.
- Les dates/semaines proposées sont modifiables par l’utilisateur.

Exemple :

`Contact S40 → R1 S42 → R2 S44 → revue Failure S48`

## 9. Semaine métier vs date d’envoi exacte

### Décision

- La semaine (`S40`, `S42`, etc.) est le niveau de planification métier.
- La date/heure exacte appartient à l’email programmé.
- On peut donc avoir un prospect `S40` alors qu’aucun email précis n’est encore programmé.
- Lors de la validation d’un message, l’utilisateur peut choisir sa date/heure exacte d’envoi.

## 10. Page Contact

L’utilisateur demande de remplacer la partie « Exploitation » par **Contact**.

### Disposition

- Même langage visuel et même logique de liste que Prospection.
- Dashboard propre à Contact, avec des informations différentes de Prospection.
- Les compteurs sont aussi des filtres cliquables.
- Compteur explicitement demandé : personnes à traiter cette semaine, avec distinction premier contact / relances.
- Compteur explicitement demandé : nombre cumulé de `RDV pris`.
- Filtre par semaine : S37, S38, S39, semaines futures, etc.

### Clic sur un prospect

Dans Prospection, le clic sert à la fiche de données. Dans Contact, le clic ouvre un espace de travail mailing :

- **gauche** : fiche prospect / contexte ;
- **droite** : éditeur d’email.

L’éditeur ressemble à une boîte mail :

- From prérempli depuis une adresse de contact configurée ;
- destinataire principal prérempli depuis le prospect ;
- possibilité de modifier / ajouter des destinataires ;
- objet ;
- contenu ;
- programmation date/heure ;
- éventuelles pièces jointes à traiter seulement si l’intégration choisie les supporte proprement.

## 11. Trois onglets de séquence

### Décision

La fiche Contact expose trois onglets :

- `Contact`
- `R1`
- `R2`

Les trois messages peuvent être préparés dès le début. Les messages déjà envoyés doivent rester consultables et non modifiables.

## 12. Statuts des emails

### Décision

Chaque email a son propre état, indépendant du statut du prospect :

- `Brouillon`
- `Validé`
- `Programmé`
- `Envoyé`
- `Annulé`

Règles :

- un message généré est un `Brouillon` ;
- un message non validé ne peut jamais être envoyé ;
- la validation est individuelle pour Contact, R1 et R2 ;
- un message peut être prévalidé longtemps avant sa date d’envoi ;
- toute modification substantielle d’un message validé remet sa validation en cause et exige une nouvelle validation humaine ;
- les messages futurs passent en `Annulé` quand l’humain change le prospect vers `Réponse reçue`, `RDV pris` ou `Ignoré`.

## 13. IA limitée au pré-remplissage

### Décision

Le seul usage IA de ce lot est la rédaction :

- générer objet + contenu du premier contact ;
- générer R1 ;
- générer R2 ;
- permettre une régénération guidée par un petit prompt de correction utilisateur.

L’IA ne change pas les statuts, ne décide pas d’une relance, ne détecte pas les réponses et ne classe pas automatiquement les prospects.

La clé OpenAI sera fournie par l’utilisateur et doit rester côté serveur. L’identifiant exact du modèle API n’a pas été figé dans la session : il doit être configurable.

## 14. Toolbox mail

L’utilisateur indique le projet `circoe-labs/circoe-toolbox` et son endpoint MCP de production.

L’audit du README de la Toolbox confirme l’existence des outils mail :

- `infomaniak.mail.create_draft`
- `infomaniak.mail.create_drafts`
- `infomaniak.mail.send_draft`
- `infomaniak.mail.list_drafts`
- `infomaniak.mail.delete_draft`
- `infomaniak.mail.reply`
- `infomaniak.mail.send`

La Toolbox applique une politique d’envoi sortant et son MCP utilise OAuth 2.1 + PKCE.

### Décision d’architecture

- VIPER porte la logique de planification et le `scheduled_at`.
- La Toolbox est la couche d’exécution mail.
- Aucun outil de scheduling natif n’a été identifié dans l’audit du README Toolbox ; le déclenchement différé doit donc vivre dans VIPER, sauf évolution ultérieure de la Toolbox.

## 15. Priorité finale donnée par l’utilisateur

> priorité à implémenter : tout le système de badges et de gestion des utilisateurs, l’état d’avancement, les semaines à contacter, puis la page Contact avec son UI de mailing.

La session est considérée assez complète pour produire un dossier d’implémentation.
