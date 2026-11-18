# Cahier des charges - Pipeline de prospection IA

*Source de vérité fonctionnelle - pilote transport et logistique en Normandie*

| Commanditaire | Circoe |
| --- | --- |
| Version | V2 - source de vérité fonctionnelle |
| Date | 9 septembre 2026 |
| Statut | SOURCE DE VERITE - décisions vérifiées et placeholders explicites |

> **OBJECTIF DU PILOTE**  Mettre en place un pipeline de prospection assistée par IA composé de trois projets distincts - IProspect, VIPER et IContact - afin d'outiller une personne commerciale pour détecter, enrichir, personnaliser et suivre des prospects et viser 10 rendez-vous par mois à partir d'environ 100 nouveaux prospects contactés mensuellement.

> **RÈGLE SOURCE DE VÉRITÉ**  Toute information non actée est représentée par un placeholder explicite de la forme `<...>`. Un placeholder signale volontairement une décision à prendre et ne doit jamais être interprété comme un choix technique ou métier validé.

## 1. Contexte et objectifs
Circoe souhaite disposer d'un pipeline logiciel de prospection assistée par IA. Le projet est structuré en trois parties distinctes mais fortement synergiques : IProspect collecte et fiabilise la donnée, VIPER constitue l'interface humaine de validation et de pilotage, et IContact exploite la donnée pour préparer des actions soumises à validation. La base de données partagée constitue le point de passage commun entre ces trois projets.
### 1.1 Cible commerciale
- Entreprises situées en Normandie.
- Secteurs visés : transport et logistique.
- Aucun seuil de taille d'entreprise ni de fonction obligatoire pour considérer une réservation comme qualifiée.
### 1.2 Proposition de valeur mise en avant
Circoe se positionne comme un partenaire d'intégration de l'intelligence artificielle et d'agents spécialisés adaptés aux processus métiers, avec de nombreuses références à l'appui. Les campagnes devront expliquer comment cette intégration permet de :
- automatiser les tâches répétitives, administratives ou opérationnelles ;
- gagner en performance, fiabilité des flux et acquisition de nouveaux clients.
### 1.3 Indicateur principal

> **SUCCÈS**  10 rendez-vous pris par mois via le lien partagé de prise de rendez-vous inclus dans les emails validés.

### 1.4 Architecture fonctionnelle et responsabilités
L'architecture fonctionnelle cible repose sur trois projets séparés partageant les mêmes données, avec des responsabilités volontairement découplées.

| Projet | Responsabilité source de vérité | Frontière fonctionnelle |
| --- | --- | --- |
| IProspect | Agent de veille et de collecte. Alimente la base, complète les informations manquantes, analyse les signaux, les score et maintient la traçabilité des sources. | Ne rédige pas les actions commerciales et ne constitue pas l'interface de validation humaine. |
| VIPER | Validation Interface for Prospecting, Execution & Revenue. Interface humaine de lecture, contrôle, validation, correction, pilotage et suivi. | Fait le lien entre la base alimentée par IProspect et les actions proposées par IContact. N'absorbe pas les responsabilités métier des deux agents. |
| IContact | Agent d'exploitation de la donnée. Lit les informations de la base et prépare les actions commerciales qui doivent pouvoir être validées depuis VIPER. | Ne collecte pas la donnée source et ne remplace pas la validation humaine. |

Principe d'architecture : les trois projets doivent pouvoir évoluer séparément tout en restant synchronisés par un contrat de données commun. Les choix d'implémentation de ce contrat restent à définir.
## 2. Périmètre du pilote
### 2.1 Inclus
- IProspect : veille web configurable pour détecter des signaux d'affaires en Normandie, analyser leur pertinence, les scorer et conserver les sources justificatives.
- Import progressif dans la base de données partagée de prospects contenant notamment les adresses email disponibles.
- Prise en compte contrôlée de prospects issus de réactions LinkedIn obtenues par l'utilisateur, sans navigation, collecte ou action automatisée sur LinkedIn.
- IProspect : qualification, enrichissement, complétion et dédoublonnage des prospects et contacts.
- IContact : génération d'un brouillon d'email initial personnalisé et de deux brouillons de relance, à partir des données fiables présentes dans la base.
- VIPER : validation humaine obligatoire avant tout envoi ; l'envoi s'effectue via <OUTIL_GESTION_MAIL> depuis <BOITE_ENVOI_PROSPECTION>.
- VIPER : suivi des réponses, rendez-vous, devis, relances de devis et commandes à partir des données synchronisées dans la base.
- VIPER : tableau de bord d'activité, liste des actions à traiter et export des données de suivi.
### 2.2 Exclus à ce stade
- Envoi automatique d'emails sans validation humaine.
- Affectation automatique d'un rendez-vous à un expert métier : l'organisation reste interne à Circoe.
- Automatisation de navigation, d'extraction de profils, de réactions ou de messages sur LinkedIn.
- Gestion complète des devis, signatures ou commandes dans <OUTIL_ERP> ; VIPER suit uniquement le statut commercial jusqu'à la commande passée.
- Prospection hors transport/logistique ou hors Normandie dans le pilote.
- Fusion des responsabilités IProspect, VIPER et IContact dans un projet monolithique unique.
## 3. Utilisateur et parcours cible
Une seule personne commerciale opère VIPER pour le pilote. Elle supervise les données et actions proposées, corrige si nécessaire et valide les envois. Les experts métiers ne se connectent pas nécessairement à VIPER dans la V1.
### 3.1 Parcours opérationnel
1. IProspect détecte et collecte les signaux web ; des listes de prospects ou contacts identifiés peuvent également être importées dans la base partagée.
1. IProspect rapproche le signal, l'entreprise et la zone géographique, puis analyse et score la pertinence du signal et du prospect.
1. IProspect émet des suggestions sur la personne externe à contacter chez le prospect ; si un contact est déjà connu, cette information est utilisée plutôt que remplacée.
1. IProspect recherche l'adresse email professionnelle à partir du nom, de l'entreprise et de son domaine, ou l'utilisateur la complète / corrige manuellement depuis VIPER.
1. IContact produit un brouillon d'email fondé sur les données vérifiées : signal ou actualité, activité de l'entreprise, fonction de la personne ciblée et contexte disponible.
1. L'utilisateur relit, modifie si besoin et valide l'action depuis VIPER ; l'envoi passe ensuite par <OUTIL_GESTION_MAIL>.
1. IContact prépare jusqu'à deux brouillons de relance. VIPER les présente à validation ; l'utilisateur conserve la décision sur le moment d'envoi et aucune relance n'est envoyée sans validation explicite.
1. Une réponse ou une réservation via Calendly met fin aux relances actives et actualise le pipeline partagé.
1. Après le rendez-vous, l'utilisateur suit dans VIPER la suite commerciale jusqu'à la commande passée ou au non-intérêt ; la gestion opérationnelle de la commande relève ensuite de <OUTIL_ERP>.
## 4. Exigences fonctionnelles
### 4.1 Veille et détection de signaux
IProspect doit produire et enrichir des fiches de prospects à qualifier. IProspect n'envoie aucun message commercial directement.
Chaque signal doit être justifié par une URL, une date, un résumé lisible, une analyse de pertinence et un score / niveau de confiance explicable. La source doit rester consultable depuis VIPER.
Les signaux listés ci-dessous sont des exemples de signaux recherchés et ne constituent pas une taxonomie fermée.

| Signal recherché | Données attendues sur la fiche |
| --- | --- |
| Nouveau / agrandi entrepôt | Entreprise, localisation, date, source, résumé, lien vers l'article. |
| Appel d'offres ou nouveau flux transport | Entreprise concernée, nature du besoin, échéance si disponible, source. |
| Recrutement logistique | Entreprise, poste, indice sur la croissance ou la capacité recherchée, source. |
| Changement de logiciel ou processus | Entreprise, système / processus évoqué, intérêt potentiel, source. |
| Nouvelle implantation ou croissance des volumes | Entreprise, territoire, fait observé, source et date de détection. |

### 4.2 Import et gestion de la base prospects
- Permettre un import contrôlé de fichiers CSV ou Excel contenant au minimum une entreprise et, lorsque disponible, une adresse email professionnelle, vers la base de données partagée.
- Afficher un aperçu avant import, signaler les lignes incomplètes et permettre la correction ou l'exclusion.
- Dédupliquer sur l'entreprise, le domaine email et l'adresse email ; ne jamais réinscrire automatiquement une personne désinscrite.
- Conserver la source, la date d'ajout et la base légale / le contexte de collecte de chaque contact.
### 4.3 Qualification et enrichissement
Pour chaque entreprise issue de la veille ou d'un import incomplet, IProspect doit :
- vérifier la localisation en Normandie et le secteur transport ou logistique ;
- proposer la personne à contacter en priorité : dirigeant, responsable logistique ou responsable d'exploitation ;
- rechercher une adresse professionnelle à partir du nom du contact, du nom de l'entreprise et de son domaine public ;
- rechercher les coordonnées publiées sur les sites officiels, pages contact, documents publics ou autres sources web autorisées ;
- lorsqu'aucune adresse n'est publiée, proposer une adresse probable selon le format d'email du domaine, puis en vérifier la validité de manière non intrusive ;
- permettre à l'utilisateur d'ajouter ou de corriger le contact et l'adresse manuellement ;
- associer un score ou une mention de confiance, la source et la date de vérification de l'adresse ;

| REGLE DE DONNEE  Une adresse non vérifiée ou dont la source est inconnue ne doit pas pouvoir être envoyée dans une campagne sans confirmation explicite de l'utilisateur. |
| --- |

### 4.4 Rédaction des campagnes et emails
Chaque email doit être préparé individuellement par IContact comme un brouillon, avec un niveau de personnalisation élevé. IContact doit produire :
- un objet et un corps de message adaptés à la fonction de la personne ciblée, à l'activité de l'entreprise et au contexte du prospect ;
- un objet suffisamment spécifique et diversifié pour éviter la répétition mécanique des mêmes formulations entre prospects ;
- une référence factuelle et prudente à l'actualité ou au signal source de l'entreprise ;
- une proposition de valeur centrée sur l'intégration d'IA et d'agents spécialisés, reliée aux gains de performance, d'automatisation ou d'acquisition de clients attendus ;
- une ou plusieurs références Circoe pertinentes, lorsqu'elles ont été validées pour l'usage dans la campagne ;
- le même lien Calendly partagé pour tous les prospects, inséré dans une formulation claire ;
- une signature / identité de l'annonceur et un moyen simple de se désinscrire.
- deux brouillons de relance, cohérents avec le message initial et régénérables si nécessaire.
Depuis VIPER, l'utilisateur doit pouvoir modifier librement le texte, demander une nouvelle version à IContact, approuver, rejeter ou différer chaque brouillon.
### 4.5 Envoi et relances

| Etape | Regle attendue |
| --- | --- |
| Email initial | Envoi uniquement après validation explicite de l'utilisateur. |
| Relance 1 à 2 | Brouillon proposé à partir d'environ une semaine après le message précédent ; la date effective d'envoi reste décidée par l'utilisateur et l'envoi nécessite une validation explicite. |
| Réponse reçue | Arrêt immédiat des relances et mise à jour du statut. |
| Rendez-vous Calendly | Arrêt immédiat des relances et mise à jour du statut. |
| Désinscription / opposition | Blocage définitif des futurs envois de prospection pour le contact. |

- VIPER doit présenter à chaque ouverture une liste priorisée des brouillons à valider, des actions arrivées à échéance et des éléments nécessitant une vérification humaine.
- L'envoi est réalisé au travers de <OUTIL_GESTION_MAIL> depuis <BOITE_ENVOI_PROSPECTION>. Le mécanisme d'authentification est <MECANISME_AUTHENTIFICATION_MAIL> ; aucun mot de passe de messagerie ne doit être stocké en clair dans VIPER.
### 4.6 Réponses, Calendly et pipeline commercial
Le système doit intégrer dans la base les réponses issues de <OUTIL_GESTION_MAIL> et les rendez-vous Calendly. VIPER les présente à l'utilisateur, qui conserve la possibilité de corriger manuellement toute classification.

| Statut | Usage |
| --- | --- |
| Prêt à contacter | Prospect qualifié, email disponible, prêt à recevoir un brouillon. |
| Email envoyé | Message initial validé et transmis. |
| Relance 1 à Relance 2 | Prochaine relance à préparer par IContact, valider dans VIPER puis envoyer. |
| Réponse reçue | Conversation à traiter par l'utilisateur ; relances interrompues. |
| Rendez-vous pris | Réservation Calendly identifiée ; relances interrompues. |
| Devis envoyé | Rendez-vous réalisé et proposition commerciale transmise. |
| Devis relancé | Une relance de la proposition commerciale a été effectuée ; le suivi reste visible dans VIPER. |
| Commande passée | Opportunité gagnée. |
| Non intéressé | Prospect non converti ; aucune relance active. |
| Désinscrit / à ne plus contacter | Statut de blocage permanent, distinct du non-intérêt. |

Champs de suivi obligatoires en complément du statut : référent interne du rendez-vous / dossier, date d'envoi de l'email initial, date de la relance 1, date de la relance 2 et historique des changements de statut.
### 4.7 Tableau de bord et reporting
- VIPER affiche le nombre de signaux détectés, prospects importés, prospects qualifiés et contacts enrichis.
- VIPER affiche les brouillons en attente de validation, les relances à traiter et les éléments signalés comme incertains / à vérifier.
- Suivre les envois, réponses, désinscriptions, rendez-vous Calendly, devis et commandes.
- Mesurer la performance par source de prospect, campagne, secteur et type de signal.
- Exporter les données et indicateurs pour analyse externe.
## 5. Données, architecture de données et intégrations

| Composant / dépendance | Besoin V1 / statut de décision |
| --- | --- |
| Base de données partagée | Point de convergence fonctionnel entre IProspect, VIPER et IContact. Technologie : <TECHNO_BASE_DE_DONNEES>. Le schéma, les droits d'écriture/lecture et les mécanismes de synchronisation restent à définir. |
| <OUTIL_GESTION_MAIL> | Outil non arrêté. Doit permettre l'envoi des emails validés depuis <BOITE_ENVOI_PROSPECTION> et la remontée des réponses. Authentification : <MECANISME_AUTHENTIFICATION_MAIL>. |
| Calendly | Le même lien partagé est envoyé à tous les prospects. Les rendez-vous doivent remonter vers la fiche prospect. Mécanisme technique de rapprochement : <MECANISME_RAPPROCHEMENT_RDV>. |
| Recherche d'email | Recherche d'adresses publiées à partir du nom, de l'entreprise et de son domaine ; proposition d'un format d'adresse probable seulement si la source n'en publie pas. |
| Vérification d'email | Contrôle non intrusif du domaine et du format ; affichage d'un statut trouvée, déduite-vérifiée, manuelle ou à confirmer, avec provenance et date. |
| Sources web | Collecte de contenus publics autorisés pour la veille et la recherche d'email ; la fiche prospect conserve l'URL et l'extrait qui justifient le signal ou l'adresse. |
| LinkedIn | Aucune automatisation de navigation, collecte, export de profils, réactions ou messages. Les données éventuellement obtenues par l'utilisateur doivent être importées de façon contrôlée. |

### 5.1 Fiche prospect minimale

| Categorie | Champs attendus |
| --- | --- |
| Entreprise | Nom, site web, secteur, localisation, domaine email, taille si connue. |
| Contact | Nom, fonction, email professionnel, source, date / statut de vérification. |
| Signal | Type, résumé, URL source, date de détection, analyse de pertinence, score / confiance et justification. |
| Campagne | Angle de message, brouillon initial, deux brouillons de relance, validations, dates d'envoi et de relance. |
| Suivi | Statut, référent interne, réponses, rendez-vous, devis, relance de devis, commande, désinscription / opposition et historique des changements. |

### 5.2 Choix techniques non arrêtés
Les éléments ci-dessous sont volontairement laissés sous forme de placeholders. Ils ne constituent pas des choix d'architecture validés :
- <TECHNO_BASE_DE_DONNEES> - technologie de stockage de la base partagée.
- <STACK_VIPER> - technologies front-end / back-end de VIPER.
- <MODELE_IA_IPROSPECT> - modèle(s) ou moteur(s) IA utilisés par IProspect.
- <MODELE_IA_ICONTACT> - modèle(s) ou moteur(s) IA utilisés par IContact.
- <OUTIL_GESTION_MAIL> - outil / service de messagerie utilisé pour envoyer et relever les réponses.
- <MECANISME_AUTHENTIFICATION_MAIL> - mécanisme sécurisé d'autorisation de la messagerie.
- <MECANISME_RAPPROCHEMENT_RDV> - méthode de rattachement d'un rendez-vous Calendly à un prospect.
- <HEBERGEMENT> - solution et localisation d'hébergement.
- <OUTIL_ERP> - outil de gestion utilisé après la commande ; il reste hors périmètre fonctionnel de VIPER.
## 6. Exigences de conformité et de sécurité

| A VALIDER AVANT MISE EN SERVICE  Les choix de base légale, d'information des personnes, de conservation et de recherche / vérification des adresses professionnelles doivent être validés par Circoe avec son conseil juridique / DPO si nécessaire. Ce cahier des charges ne constitue pas un avis juridique. |
| --- |

- Prospection B2B : conserver la preuve de source, s'assurer que le message est en rapport avec la profession visée et offrir une opposition / désinscription simple.
- Désinscription : bloquer sans délai les nouveaux envois à la personne concernée et conserver la liste d'opposition selon la politique de conservation retenue.
- Traçabilité : journaliser les imports, enrichissements, validations, envois, erreurs, réponses et changements de statut.
- Accès : un compte utilisateur commercial unique pour le pilote dans VIPER, authentifié de manière sécurisée ; droits d'accès limités aux données nécessaires.
- Sécurité : chiffrement des connexions, sauvegardes, gestion des erreurs et suppression / anonymisation selon une durée à définir.
- LinkedIn : respecter les conditions de la plateforme ; ne pas utiliser de robot ou de logiciel tiers pour extraire des données ou automatiser une activité.
## 7. Critères d'acceptation du pilote
- L'utilisateur peut importer une liste de prospects et retrouver les erreurs ou doublons avant confirmation.
- IProspect génère une fiche exploitable depuis un signal web avec URL, date, résumé, entreprise, motif de pertinence et score / niveau de confiance.
- IProspect émet une suggestion de contact externe pertinente, recherche son adresse à partir de son nom et de son entreprise sans fournisseur de contacts B2B, ou permet de la compléter, et enregistre la provenance de cette donnée.
- IContact prépare les actions de contact ; chaque email initial et chaque relance restent au statut brouillon tant que l'utilisateur ne les a pas validés depuis VIPER.
- Deux relances au maximum sont proposées, avec un intervalle cible d'environ une semaine ; leur date d'envoi reste décidée par l'utilisateur et elles cessent après réponse, rendez-vous ou désinscription.
- Le même lien Calendly partagé est présent dans les emails validés et un rendez-vous peut être associé à la fiche prospect.
- Le pipeline permet de gérer tous les statuts convenus, dont devis envoyé, devis relancé et commande passée, et conserve le référent interne ainsi que les dates d'envoi du message initial et des deux relances.
Les responsabilités restent séparées : IProspect alimente et fiabilise la donnée, VIPER assure l'interface humaine et la validation, IContact exploite la donnée pour produire les actions à valider.
- Le tableau de bord permet de suivre l'objectif de 100 nouveaux prospects contactés et 10 rendez-vous pris par mois.
- Un contact désinscrit ou à ne plus contacter ne peut pas être inclus dans un nouvel envoi.
## 8. Décisions actées et points ouverts
### 8.1 Décisions actées
- Cible pilote : entreprises normandes de transport et de logistique.
- Volume cible : environ 100 nouveaux prospects contactés chaque mois, hors relances.
- Objectif : 10 rendez-vous Calendly pris par mois.
- Validation humaine obligatoire avant chaque email initial ou relance.
- Deux relances maximum, proposées avec un intervalle cible d'environ une semaine ; l'utilisateur décide du moment d'envoi.
- Un même lien Calendly partagé pour tous les prospects ; affectation du référent / expert gérée en interne.
- Une seule personne commerciale pilote VIPER dans la V1.
- La technologie de messagerie n'est pas arrêtée : <OUTIL_GESTION_MAIL>. Les emails de prospection partent de <BOITE_ENVOI_PROSPECTION> et les notifications de rendez-vous sont centralisées dans <BOITE_RECEPTION_RDV>.
- Architecture en trois projets distincts et fortement synergiques : IProspect, VIPER et IContact.
- IProspect est responsable de la collecte, de la complétion, de l'analyse / scoring des signaux et de la fiabilisation des données dans la base partagée.
- VIPER (Validation Interface for Prospecting, Execution & Revenue) est l'interface humaine de consultation, correction, validation, pilotage et suivi ; elle relie la base aux actions proposées par IContact.
- IContact est responsable de l'exploitation de la donnée et de la préparation des actions commerciales soumises à validation depuis VIPER.
- Les suggestions de contact concernent la personne externe à contacter chez le prospect ; l'affectation de l'expert / référent interne reste une décision humaine.
- La personnalisation des emails doit prendre en compte la fonction du contact, l'activité de l'entreprise et le signal / contexte disponible, avec des objets non mécaniquement répétitifs.
- Les dates d'envoi de l'email initial, de la relance 1 et de la relance 2 ainsi que le référent interne doivent être tracés.
- Recherche d'email sans fournisseur de contacts B2B, à partir du nom, de l'entreprise, du domaine et de sources web autorisées, avec compléments manuels.
### 8.2 Points ouverts avant chiffrage et réalisation
- Définir les règles de recherche, de déduction et de vérification non intrusive des adresses, ainsi que le niveau de confiance minimal autorisé avant envoi.
- Définir les sources web prioritaires et la fréquence de veille afin de limiter le bruit et les faux positifs ; statuer sur l'activation d'une revalidation périodique des données anciennes, dont IProspect serait responsable, et sur sa cadence.
- Définir <MECANISME_RAPPROCHEMENT_RDV> pour rattacher de manière fiable un rendez-vous Calendly au bon prospect.
- Valider les modèles de signature, mention d'information et désinscription avec les personnes responsables de la conformité.
- Définir <HEBERGEMENT>, le budget, les exigences de sauvegarde et la durée de conservation des données.
- Constituer les références Circoe qui peuvent être utilisées, avec leurs secteurs, résultats et formulations autorisées dans les messages.
- Définir les exemples de messages attendus et les règles éditoriales pour garantir une personnalisation fidèle au positionnement de Circoe comme intégrateur d'IA.
- Définir <TECHNO_BASE_DE_DONNEES> et le contrat de données partagé entre IProspect, VIPER et IContact : schéma, droits, versionnement et synchronisation.
- Définir <STACK_VIPER> sans réintégrer dans VIPER les responsabilités fonctionnelles propres à IProspect ou IContact.
- Définir <MODELE_IA_IPROSPECT> et <MODELE_IA_ICONTACT>, ainsi que les règles de contrôle / évaluation associées.
- Définir <OUTIL_GESTION_MAIL>, <MECANISME_AUTHENTIFICATION_MAIL>, <BOITE_ENVOI_PROSPECTION> et <BOITE_RECEPTION_RDV>.
- Définir le mécanisme d'exécution technique d'une action après validation humaine dans VIPER.
## 9. Sources de référence
Les références officielles ci-dessous ont été revérifiées le 9 septembre 2026. Elles bornent les exigences de conformité mais ne remplacent pas une validation juridique / DPO avant mise en production.
- CNIL - La prospection commerciale par courrier électronique, SMS-MMS et automate d’appel : https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel
- LinkedIn - Activité automatique sur LinkedIn : https://www.linkedin.com/help/linkedin/answer/a1335595/demandes-excessives-de-pages-sur-linkedin?lang=fr
- LinkedIn - User Agreement : https://www.linkedin.com/legal/user-agreement
