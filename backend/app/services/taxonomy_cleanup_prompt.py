"""The taxonomy-cleanup prompt (Config AI > Prompt, setting `taxonomy_cleanup_prompt`).

It briefs the model behind the « Nettoyer » button of Paramètres (roles, activity categories,
commercial segments). Stored like `contact_initial_prompt`: unset = this built-in default, an
emptied or unchanged text goes back to it. The answer format (a list of groups, each with its final
label and the ids it replaces) is fixed by the code, not by this text.
"""

from app.core.config import Settings

DEFAULT_TAXONOMY_CLEANUP_PROMPT = (
    "Tu nettoies une liste de libellés d’une base de prospection B2B (rôles, catégories "
    "d’activité ou segments commerciaux), en français.\n"
    "On te donne tous les libellés avec leur identifiant et leur nombre d’utilisations. Propose "
    "une liste plus propre :\n"
    "- homogénéise l’écriture : majuscules cohérentes, espaces, ponctuation, singulier/pluriel, "
    "abréviations usuelles (ex. « Dir R.Humaine », « directeur des ressources humaines » → "
    "« DRH »), "
    "sans accent manquant ni faute ;\n"
    "- regroupe les libellés qui désignent la même chose (doublons, variantes, fautes de frappe) "
    "sous un seul libellé final ; ne regroupe jamais des notions réellement différentes ;\n"
    "- ne perds aucun libellé : chaque identifiant fourni apparaît dans exactement un groupe ;\n"
    "- garde un libellé court, en français, sans commentaire ; si un libellé est déjà propre et "
    "unique, garde-le tel quel dans son propre groupe.\n"
    "Réponds uniquement avec la structure demandée."
)


def taxonomy_cleanup_prompt(settings: Settings) -> str:
    """The effective prompt: the person's override, else the built-in default."""
    override = settings.taxonomy_cleanup_prompt
    return override if override else DEFAULT_TAXONOMY_CLEANUP_PROMPT
