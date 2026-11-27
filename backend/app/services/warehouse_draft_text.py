"""The wording of the former warehouse mails. VIPER writes none any more (Contact drafts them);
migration 0045 still imports this module."""

import re
import unicodedata
import zlib
from collections.abc import Collection

from app.services.mail_generation.naming import (
    fold,
    short_title,
    single_organisation,
    title_segment,
)
from app.services.mail_generation.prompt import CONTACT_SIGNATURE, DIHNAMO_GOAL

BOOKING_URL = "https://calendly.com/experts-circoe/30min"
WAREHOUSE_DIHNAMO = (
    "Selon votre projet, un accompagnement et un financement peuvent être envisagés via "
    "DIHNAMO, écosystème normand d’innovation dont Circoé est partenaire."
)


# The warehouse directory does not store civility. Only use common first names as a
# provisional suggestion; ambiguous or unknown names keep the neutral greeting.
_WOMEN = {
    'amandine', 'amelia', 'anne', 'axelle', 'carine', 'claire', 'estelle', 'jenny', 'marie',
    'chloe', 'christelle', 'constance', 'elise', 'elodie', 'emilie', 'grace', 'isabelle',
    'julie', 'karine', 'laurence', 'linda', 'lucile', 'lucrece', 'marion', 'sandrine',
    'sandie', 'sarah', 'stephanie', 'victoria', 'virginie', 'wendy',
}
_MEN = {
    'alain', 'alexandre-jacques', 'anthony', 'antoine', 'benoit', 'bertrand', 'charles-antoine',
    'cirino', 'craig', 'eric', 'francois', 'gianni', 'gilles', 'gregory', 'harold', 'jason',
    'jean-claude', 'jean-daniel', 'jean-francois', 'jimmy', 'johannes', 'joel', 'julien',
    'laurent', 'lino', 'ludovic', 'mathias', 'matthew', 'mickael', 'olivier', 'pascal',
    'philippe', 'pierre', 'quentin', 'ramzi', 'ronny', 'rui', 'sylvain', 'william', 'willy',
    'alexandre', 'andrei', 'anton', 'arnaud', 'christophe', 'clement', 'cyril', 'damien', 'david', 'denis',
    'edouard', 'emmanuel', 'fabien', 'franck', 'francois-xavier', 'frederic', 'gaetan', 'gregory',
    'jacques', 'jean-paul', 'jerome', 'josik', 'martin', 'mathieu', 'mathis', 'michael', 'nicolas', 'patrick', 'pierre-yves',
    'pierrick', 'samuel', 'simon', 'sebastien', 'stephane', 'thierry', 'vincent',
}


def greeting(name: str) -> str:
    parts = name.split()
    # All-capital tokens usually identify a surname in this directory, not a first name.
    candidates_parts = [part for part in parts if not part.isupper()] or parts
    words = [
        ''.join(
            c for c in unicodedata.normalize('NFD', part.casefold()) if not unicodedata.combining(c)
        )
        for part in candidates_parts
    ]
    # Some records have the surname first (e.g. capitalized surname followed by first name).
    candidates = {word for word in words if word in _WOMEN or word in _MEN}
    title = 'Madame ' if candidates & _WOMEN and not candidates & _MEN else (
        'Monsieur ' if candidates & _MEN and not candidates & _WOMEN else 'Madame, Monsieur '
    )
    return f'Bonjour {title}{name},'


def introduction(label: str | None) -> str:
    context = f"dans vos fonctions de {label}" if label else "dans votre activité"
    return (
        f"Je souhaiterais mieux comprendre votre quotidien {context} et vos priorités. "
        "Chez Circoé, nous accompagnons les entreprises dans leurs projets de transformation, "
        "notamment grâce aux outils numériques et à l’intelligence artificielle."
    )


def other_introduction(role: str | None, label: str | None) -> str:
    """The category is read from the recorded title; `label` is the function as written."""
    normalized = fold(title_segment(role) or '')
    if not normalized:
        return 'Je m’intéresse à l’organisation de votre activité au quotidien.'
    if 'commercial' in normalized:
        focus = 'vous jonglez sans doute entre le suivi des clients et les priorités commerciales.'
    elif 'transport' in normalized or 'affret' in normalized:
        focus = 'vous coordonnez au quotidien le transport et les opérations.'
    elif any(word in normalized for word in ('logistique', 'entrepot', 'exploitation', 'equipe')):
        focus = 'vous pilotez au quotidien l’organisation logistique et le travail des équipes.'
    elif any(word in normalized for word in ('direct', 'president', 'dirigeant', 'responsable')):
        focus = 'vous gardez la vue d’ensemble sur les priorités et l’organisation de l’activité.'
    else:
        focus = 'vous connaissez de près l’organisation de l’activité au quotidien.'
    if not label:
        return focus[0].upper() + focus[1:]
    return f'En tant que {label}, {focus}'


def other_value_proposition(role: str | None) -> str:
    label = ''.join(c for c in unicodedata.normalize('NFD', (title_segment(role) or '').casefold()) if not unicodedata.combining(c))
    if 'commercial' in label:
        return "Circo\u00e9 peut vous accompagner dans l\u2019analyse de vos processus commerciaux et l\u2019identification d\u2019outils num\u00e9riques adapt\u00e9s pour simplifier le suivi et le partage d\u2019informations."
    if 'transport' in label or 'affret' in label:
        return "Circo\u00e9 accompagne les entreprises dans l\u2019analyse de leurs flux de transport et l\u2019optimisation de leur organisation, notamment avec des outils comme les TMS."
    if any(word in label for word in ('logistique', 'entrepot', 'exploitation', 'equipe')):
        return "Circo\u00e9 accompagne les entreprises dans l\u2019analyse de leurs flux et processus logistiques, ainsi que dans le choix et le d\u00e9ploiement d\u2019outils comme les WMS."
    if any(word in label for word in ('direct', 'president', 'dirigeant', 'responsable')):
        return "Circo\u00e9 peut aider vos \u00e9quipes \u00e0 analyser leurs processus, piloter un projet d\u2019am\u00e9lioration et choisir des outils num\u00e9riques adapt\u00e9s."
    return "Circo\u00e9 accompagne les entreprises dans l\u2019analyse de leurs processus et l\u2019int\u00e9gration d\u2019outils num\u00e9riques adapt\u00e9s \u00e0 leurs besoins."


# The subjects of the former template, one per kind of function: identical for every contact.
LEGACY_SUBJECTS = frozenset(
    f'Échangeons sur {topic}'
    for topic in (
        'vos priorités commerciales et le numérique',
        'vos priorités en transport et le numérique',
        'vos priorités logistiques et le numérique',
        'vos projets de transformation numérique',
        'vos projets et les outils numériques',
    )
)


def _topics(role: str | None) -> tuple[str, ...]:
    label = fold(title_segment(role) or '')
    if 'commercial' in label:
        return ('vos priorités commerciales', 'le suivi de vos clients', 'vos outils commerciaux')
    if 'transport' in label or 'affret' in label:
        return ('vos priorités en transport', 'l’organisation de vos transports', 'vos flux de transport')
    if any(word in label for word in ('logistique', 'entrepot', 'exploitation', 'equipe')):
        return ('vos priorités logistiques', 'vos flux logistiques', 'vos outils logistiques')
    if any(word in label for word in ('direct', 'president', 'dirigeant', 'responsable')):
        return ('vos projets de transformation', 'le numérique pour vos équipes', 'vos priorités numériques')
    return ('vos outils numériques', 'vos processus et le numérique', 'vos projets numériques')


def draft_subject(
    role: str | None,
    warehouse: str,
    contact_name: str,
    taken: Collection[str] = (),
    city: str | None = None,
) -> str:
    """A subject naming the company (else the town) and the contact's kind of work, never one of
    `taken`. The starting variant depends on the contact, so neighbours read differently."""
    topics = _topics(role)
    who = single_organisation(warehouse)
    if who:
        frames = ('{who} : {topic}', '{Topic} chez {who}', 'Échange sur {topic} – {who}')
    elif city and city.strip():
        who = city.strip()
        frames = ('{who} : {topic}', 'Échange sur {topic} – {who}', '{Topic}, secteur {who}')
    else:
        frames = ('Un échange sur {topic} ?', '{Topic} : échangeons', '{Topic} : un point ensemble ?')
    candidates = [
        frame.format(who=who, topic=topic, Topic=topic[0].upper() + topic[1:])
        for frame in frames
        for topic in topics
    ]
    start = zlib.crc32(f'{contact_name}|{warehouse}'.encode()) % len(candidates)
    used = {fold(subject) for subject in taken}
    for subject in candidates[start:] + candidates[:start]:
        if fold(subject) not in used:
            return subject
    # Every variant is taken (many contacts of one company): only the name still tells them apart.
    base = f'{candidates[start]} – {contact_name}'
    subject, number = base, 2
    while fold(subject) in used:
        subject, number = f'{base} {number}', number + 1
    return subject


_STOP_WORDS = {'de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'au', 'aux', 'un', 'une', 'chez'}


def _words(text: str) -> set[str]:
    folded = ''.join(c for c in unicodedata.normalize('NFD', text.casefold()) if not unicodedata.combining(c))
    return {word for word in re.split(r"[^a-z0-9]+", folded) if len(word) > 1 and word not in _STOP_WORDS}


def mentions_role(body: str, role: str | None) -> bool:
    """The message names the contact's function. Lenient on purpose: a person may reword it ("Direction
    d'entrepôt" for "Direction de l'entrepôt") or drop a trailing company name, so most of the significant
    words (at least 60 %) must appear somewhere in the text."""
    label = title_segment(role)
    wanted = _words(label or '')
    if not wanted:
        return False
    return len(wanted & _words(body)) >= -(-len(wanted) * 3 // 5)


def opening_line(warehouse: str, category: str | None) -> str:
    """The first sentence. A label holding several companies names none of them."""
    company = single_organisation(warehouse)
    return _opening_sentence(f' chez {company}' if company else '', category)


def _opening_sentence(at: str, category: str | None) -> str:
    start = 'Je vous contacte' if category == 'sme' else 'Je me permets de vous écrire'
    return f'{start} au sujet de votre activité{at}.'


def draft_text(name: str, warehouse: str, role: str | None, category: str | None = None) -> str:
    label = short_title(role, warehouse)
    opening = introduction(label) if category == 'sme' else other_introduction(role, label) + '\n\n' + other_value_proposition(role)
    opportunity = f"{WAREHOUSE_DIHNAMO}\n\n" if category == 'sme' else ''
    invitation = "Seriez-vous disponible 30 minutes pour en parler ? Vous pouvez choisir un créneau ici :" if category == 'sme' else "Seriez-vous ouvert à un échange de 30 minutes ? Vous pouvez choisir un créneau ici :"
    text = (
        f"{greeting(name)}\n\n"
        f"{opening_line(warehouse, category)}\n\n"
        f"{opening}\n\n"
        f"{opportunity}"
        f"{invitation}\n{BOOKING_URL}\n\n"
        f"Au plaisir de vous rencontrer,\n\n{CONTACT_SIGNATURE.replace('CIRCOE', 'Circoé')}"
    )
    return apply_category(without_parentheses(text), category)


def rewrite_body(body: str, warehouse: str, role: str | None) -> str:
    """Replace only the sentences the former template generated from the site label (cut at its
    first dash) and the title's first segment; every other character is kept."""
    old = title_segment(role)
    new = short_title(role, warehouse)
    former_company = re.split(r'\s+[–—-]\s+', warehouse, maxsplit=1)[0].strip()
    changes = [
        (_opening_sentence(f' chez {former_company}', category), opening_line(warehouse, category))
        for category in ('sme', 'other')
    ]
    if old and old != new:
        context = f'dans vos fonctions de {new}' if new else 'dans votre activité'
        changes += [
            (f'dans vos fonctions de {old} et vos priorités', f'{context} et vos priorités'),
            (other_introduction(role, old), other_introduction(role, new)),
        ]
    for former, current in changes:
        body = body.replace(without_parentheses(former), without_parentheses(current))
    return body


def without_parentheses(text: str) -> str:
    """Remove parentheses while preserving valid international phone numbers."""
    return (
        text.replace('+33 (0)', '+33 ')
        .replace('vos missions (', 'vos missions : ')
        .replace('(', '')
        .replace(')', '')
    )


def apply_category(text: str, category: str | None) -> str:
    """Apply the requested DIHNAMO rule without replacing the rest of the message."""
    if not text.strip():
        return text
    lines = text.split('\n')
    if category != 'sme':
        result = []
        removed = False
        for line in lines:
            if 'dihnamo' in line.casefold():
                removed = True
                continue
            if removed and line.strip() == DIHNAMO_GOAL:
                removed = False
                continue
            if line.strip():
                removed = False
            result.append(line)
        return '\n'.join(result)
    if 'dihnamo' in text.casefold():
        return text
    block = f'{WAREHOUSE_DIHNAMO}\n\n'
    marker = 'Seriez-vous disponible 30 minutes pour en parler ?'
    if marker in text:
        return text.replace(marker, block + marker, 1)
    marker = 'Vous pouvez choisir directement votre créneau ici :'
    if marker in text:
        return text.replace(marker, block + marker, 1)
    closing = 'Au plaisir d’échanger avec vous,'
    if closing in text:
        return text.replace(closing, block + closing, 1)
    return text.rstrip() + '\n\n' + block.rstrip()
