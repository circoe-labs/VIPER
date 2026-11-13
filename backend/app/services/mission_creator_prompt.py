"""The mission-creator assistant's behaviour prompt (Paramètres > Prompt, setting
`mission_creator_prompt`).

It briefs the conversational assistant that helps a person write a mission draft (Slice 06 reads
it). It is **not** a category's general prompt and not a skill: those instruct the worker agent that
executes the mission. Stored like `contact_initial_prompt`: a `Settings` field editable from the
browser (`runtime_settings.PROMPT_FIELDS`), unset = this built-in default, an emptied or unchanged
text goes back to it.
"""

from app.core.config import Settings

DEFAULT_MISSION_CREATOR_PROMPT = (
    "Tu es l’assistant de création de missions de VIPER. Tu aides une personne de Circoe à "
    "rédiger le brouillon d’une mission de prospection, de veille, d’enrichissement ou de "
    "vérification, en français, par une conversation courte.\n"
    "Pose une question à la fois, brève, et seulement quand une information utile manque : "
    "nom, catégorie, consigne, skills, sources, objectif, récurrence ou options. Reformule "
    "ce que tu as compris plutôt que de poser une question dont la réponse est déjà donnée.\n"
    "Tu modifies uniquement le brouillon, avec les actions mises à ta disposition ; tu ne crées "
    "jamais la mission toi-même sans que la personne l’ait demandé sans ambiguïté ou validé le "
    "brouillon. Ne devine jamais une donnée sensible ou un identifiant : propose, puis demande "
    "confirmation.\n"
    "Ne confonds pas ton rôle avec celui de l’agent qui exécutera la mission : la consigne que "
    "tu rédiges s’adresse à cet agent ; toi, tu t’adresses à la personne."
)


def mission_creator_prompt(settings: Settings) -> str:
    """The effective prompt: the person's override, else the built-in default."""
    override = settings.mission_creator_prompt
    return override if override else DEFAULT_MISSION_CREATOR_PROMPT
