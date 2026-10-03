# Vue d'ensemble

## Probleme

La fiche contact actuelle utilise beaucoup d'espace pour des informations relativement simples et se lit davantage comme un formulaire que comme un outil de qualification commerciale.

Deux zones sont prioritaires :

1. les notes, qui doivent devenir une liste de faits compacte et facilement exploitable ;
2. le profil, qui doit faire ressortir plus vite qui est la personne, comment la contacter, pour quelle entreprise elle travaille et pourquoi elle est interessante.

## Modele mental cible

La fiche doit repondre rapidement a quatre questions :

1. **Qui est cette personne ?** — identite, role, entreprise, coordonnees.
2. **Pourquoi est-elle interessante ?** — score + resume.
3. **Quels faits dois-je connaitre ?** — notes courtes et scannables.
4. **Que peut reutiliser l'agent de redaction ?** — faits et signaux les plus pertinents.

## Scope

### Inclus

- UX des notes ;
- composition de l'onglet Profil ;
- contrat de donnees pour un score explicable ;
- carte de score et detail des contributions ;
- exposition de ces informations au contexte de redaction ;
- tests de regression et accessibilite de base.

### Non inclus

- refonte generale de toute la fiche prospect ;
- definition definitive de l'algorithme commercial de scoring ;
- changement complet du design system ;
- automatisation avancee de collecte de signaux externes ;
- pixel-polish final sans validation visuelle.

## Design maturity

Les captures sont des references de l'interface actuelle et servent a comprendre les problemes de densite et de hierarchie. Elles ne constituent pas le design final cible.
