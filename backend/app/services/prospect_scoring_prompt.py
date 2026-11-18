"""The prompt of « Évaluer le score » (Config AI > Scoring prospect).

Two editable texts, both stored like `contact_initial_prompt` (unset = the built-in default here, an
emptied or unchanged text goes back to it):

- `prospect_scoring_prompt`: the system prompt that briefs the model;
- `circoe_target`: who Circoe wants as a client (the target the score is measured against).

The answer format (`{score, rationale, criteria[]}`), the strict-JSON rules and the « fit only »
guardrail are fixed by the code (`FIXED_RULES`), not by the editable text: a person cannot break the
contract by editing the prompt. The effective instructions sent to the model are
`instructions(settings)`; their hash is the **prompt version** stored with every assessment, so a
score always says which prompt produced it.
"""

import hashlib

from app.core.config import Settings

DEFAULT_PROSPECT_SCORING_PROMPT = (
    "Tu es l’analyste commercial de Circoe, intégrateur d’intelligence artificielle et d’agents "
    "spécialisés. On te donne la fiche complète d’un prospect (une personne, son poste, son "
    "entreprise, ses coordonnées et leur vérification, ses notes et signaux sourcés, l’état de son "
    "suivi, l’origine des données).\n"
    "Ta tâche : dire, avec un score de 0 à 100, à quel point cette personne est un bon prospect "
    "pour Circoe, c’est-à-dire à quel point on aimerait l’avoir comme client, au regard de la "
    "cible de Circoe donnée ci-dessous.\n"
    "Repères : 0-39 faible adéquation, 40-69 adéquation moyenne, 70-100 forte adéquation.\n"
    "Méthode : pèse la fonction et le pouvoir de décision de la personne, la taille, le secteur et "
    "le profil de son entreprise, les signaux récents (recrutement, projet, actualité), puis les "
    "freins (poste sans lien avec nos sujets, entreprise hors cible, personne partie, donnée "
    "douteuse). Une donnée non vérifiée ou absente pèse peu : ne l’invente jamais et signale le "
    "manque dans la justification.\n"
    "Justifie par des critères courts : un libellé, un impact en points (positif ou négatif) et la "
    "preuve tirée de la fiche. Appuie-toi uniquement sur la fiche fournie."
)

DEFAULT_CIRCOE_TARGET = (
    "Circoe accompagne les entreprises dans l’intégration de l’intelligence artificielle et "
    "d’agents spécialisés dans leurs processus métiers (services : iGuard, Flexisme, "
    "Transepteur, iAdvice, e-mailing).\n"
    "Le client idéal est une entreprise française de taille moyenne à grande (PME, ETI, grande "
    "entreprise ou institution) dont l’activité repose sur des processus répétitifs, du volume de "
    "données ou de la relation client, et qui peut investir dans un projet d’IA.\n"
    "L’interlocuteur idéal décide ou influence ce type de projet : dirigeant, directeur "
    "général, directeur des systèmes d’information, de la transformation, de l’innovation, des "
    "opérations ou des ressources humaines.\n"
    "Sont de moins bons prospects : les très petites structures sans budget, les postes "
    "d’exécution sans influence sur le sujet, les personnes ayant quitté leur poste."
)

# Not editable: the contract of the answer and the guardrail (fit only; no graph, no contact state).
FIXED_RULES = (
    "Réponds uniquement par un objet JSON de la forme demandée :\n"
    "- `score` : entier de 0 à 100 (le score final, pas une somme à compléter) ;\n"
    "- `rationale` : une ou deux phrases en français qui expliquent le score ;\n"
    "- `criteria` : de 1 à 10 critères, chacun avec `label` (court), `delta` (entier signé : "
    "l’impact approximatif en points de ce critère, positif ou négatif) et `evidence` (la preuve "
    "tirée de la fiche, ou « non renseigné »).\n"
    "Le score mesure l’adéquation commerciale uniquement : ne tiens compte ni de la proximité "
    "avec l’équipe Circoe ni de l’état du contact (relances, réponses)."
)


def scoring_prompt(settings: Settings) -> str:
    """The editable system prompt: the person's override, else the built-in default."""
    override = settings.prospect_scoring_prompt
    return override if override else DEFAULT_PROSPECT_SCORING_PROMPT


def circoe_target(settings: Settings) -> str:
    """Who Circoe wants as a client: the person's override, else the built-in default."""
    override = settings.circoe_target
    return override if override else DEFAULT_CIRCOE_TARGET


def instructions(settings: Settings) -> str:
    """What the model is briefed with: the prompt, the Circoe target, then the fixed rules."""
    return (
        f"{scoring_prompt(settings).strip()}\n\n"
        f"## Cible de Circoe\n{circoe_target(settings).strip()}\n\n"
        f"## Format de la réponse\n{FIXED_RULES}"
    )


def prompt_hash(text: str) -> str:
    """The prompt version: SHA-256 (hex) of the exact instructions sent to the model."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def short_version(full_hash: str) -> str:
    """The label shown to people (`a1b2c3d4`): enough to tell two prompts apart."""
    return full_hash[:8]
