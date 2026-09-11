"""Readable history (Task 19): audit events turned into typed display entries.

The one place that decides how an audit event reads (`doc/architecture/audit-and-provenance.md`,
*Visible history*, decisions I-130 …). Raw `changes` / `context` never leave this module:

- **grouping** — the events of one save (same request, subject, actor and source) form one entry;
  events written outside a request (CLI, seed, jobs) group when consecutive, by the same actor and
  source, less than `UNBOUND_GAP` apart;
- **entries** carry when, who (`HistoryActor`: human, import, system or agent, with a label), the
  source, a title, value-free `summary` phrases (Home's feed) and `changes`: French field labels
  with formatted before/after values — enums, dates in business time, booleans, references by
  their label (snapshotted in the event, else looked up once per page), child rows by the address,
  number or name they had then — and one « E-mail principal : A → B » line for a primary switch;
- **payload policy** — values are shown as stored: personal values follow the audit policy switch,
  masked ones stay masked, secret-looking fields and fields without a label are never shown, and
  structured values never appear as JSON.
"""

import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import audit_policy
from app.core.actor import ActorType
from app.core.business_time import BUSINESS_TIMEZONE
from app.models import ActivityCategory, CommercialSegment, Company, InternalReferent, Role
from app.models.audit import AuditLogEntry
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    OriginType,
    PhoneType,
    ProspectSourceType,
    VerificationStatus,
)
from app.repositories import audit as audit_repository
from app.services import audit
from app.services.audit import AuditAction, AuditSource
from app.services.import_batches import IMPORT_ACTOR_PREFIX

# Consecutive events without a request id (CLI, seed, jobs) closer than this are one entry.
UNBOUND_GAP = timedelta(seconds=5)
# Events read per query while filling a history page.
EVENTS_PER_READ = 100
# Side of an updated field that was (or became) empty.
EMPTY = "—"
TEXT_LIMIT = 160


@dataclass(frozen=True, slots=True)
class HistoryActor:
    kind: ActorType
    # A person's display name, an import's file name, a command or an agent label.
    label: str
    # Stable id: the user id, the import batch id, the command or agent identifier.
    id: str | None
    # The human who confirmed an automated actor's work (an import).
    on_behalf_of: str | None


@dataclass(frozen=True, slots=True)
class HistoryChange:
    label: str
    # Display values. An updated field has both (`EMPTY` for an empty side); a line that only adds
    # or removes something has one; a plain statement has none.
    before: str | None
    after: str | None


@dataclass(frozen=True, slots=True)
class HistoryEntry:
    """One save, with the id and time of its newest event."""

    id: uuid.UUID
    occurred_at: datetime
    actor: HistoryActor
    source: AuditSource | None
    subject_type: str
    subject_id: uuid.UUID | None
    # Its events' actions, oldest first (the vocabulary of `app.services.audit`).
    actions: list[str]
    title: str
    # Value-free phrases, e.g. « E-mail principal modifié », « Suivi : Contacté → Relance 1 ».
    summary: list[str]
    changes: list[HistoryChange]


@dataclass(frozen=True, slots=True)
class HistoryPage:
    items: list[HistoryEntry]
    # Pass as `before` for the next, older entries; None on the last page.
    next_cursor: uuid.UUID | None


@dataclass(frozen=True, slots=True)
class Lookups:
    """What a page needs besides its events: labels of referenced records (`(kind, id)` →
    label) and each child-row event's identity (the address, number or name the row had then)."""

    labels: Mapping[tuple[str, str], str] = field(default_factory=dict)
    identities: Mapping[uuid.UUID, str] = field(default_factory=dict)


# --- values --------------------------------------------------------------------------------------

type Render = Callable[[Any, Lookups], str | None]

MONTHS = (
    "janv.",
    "févr.",
    "mars",
    "avr.",
    "mai",
    "juin",
    "juil.",
    "août",
    "sept.",
    "oct.",
    "nov.",
    "déc.",
)
HIDDEN_VALUES = frozenset({audit_policy.MASKED_VALUE, audit_policy.OMITTED_VALUE})
DELETED_REFERENCE = "valeur supprimée"


def _text(value: Any, _: Lookups) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "Oui" if value else "Non"
    if not isinstance(value, str | int | float):
        return "(valeur non affichée)"
    if value in HIDDEN_VALUES:
        return "(masqué)"
    text = " ".join(str(value).split())
    return text if len(text) <= TEXT_LIMIT else f"{text[: TEXT_LIMIT - 1]}…"


def _moment(value: Any, lookups: Lookups) -> str | None:
    """« 3 sept. 2026 », plus « à 10:30 » unless it is midnight (a day without time)."""
    if not isinstance(value, str):
        return _text(value, lookups)
    try:
        moment = datetime.fromisoformat(value).astimezone(BUSINESS_TIMEZONE)
    except ValueError:
        return _text(value, lookups)
    day = f"{moment.day} {MONTHS[moment.month - 1]} {moment.year}"
    return day if (moment.hour, moment.minute) == (0, 0) else f"{day} à {moment:%H:%M}"


def _phone(value: Any, lookups: Lookups) -> str | None:
    """A French number by pairs (`+33 6 12 34 56 78`); anything else as stored."""
    text = _text(value, lookups)
    if text and len(text) == 12 and text.startswith("+33") and text[1:].isdigit():
        return f"+33 {text[3]} " + " ".join(text[index : index + 2] for index in range(4, 12, 2))
    return text


def _choice(labels: Mapping[str, str]) -> Render:
    def render(value: Any, lookups: Lookups) -> str | None:
        return labels.get(value, _text(value, lookups)) if isinstance(value, str) else None

    return render


def _reference(kind: str) -> Render:
    def render(value: Any, lookups: Lookups) -> str | None:
        if isinstance(value, list):
            names = sorted(
                lookups.labels.get((kind, str(item)), DELETED_REFERENCE) for item in value
            )
            return ", ".join(names) or None
        return None if value is None else lookups.labels.get((kind, str(value)), DELETED_REFERENCE)

    return render


CIVILITIES: dict[str, str] = {Civility.MR: "M.", Civility.MS: "Mme"}
ACTIVITIES: dict[str, str] = {
    ActivityStatus.ACTIVE: "Actif",
    ActivityStatus.INACTIVE: "Inactif",
    ActivityStatus.UNKNOWN: "Inconnue",
}
CONTACTABILITY: dict[str, str] = {
    ContactabilityStatus.CONTACTABLE: "Contactable",
    ContactabilityStatus.DO_NOT_CONTACT: "Ne pas contacter",
}
VERIFICATIONS: dict[str, str] = {
    VerificationStatus.UNVERIFIED: "Non vérifié",
    VerificationStatus.VERIFIED: "Vérifié",
    VerificationStatus.INVALID: "Invalide",
    VerificationStatus.UNKNOWN: "Statut inconnu",
}
ORIGINS: dict[str, str] = {
    OriginType.IMPORTED: "Import",
    OriginType.MANUAL: "Saisie manuelle",
    OriginType.PUBLISHED: "Source publique",
    OriginType.INFERRED: "Déduit",
    OriginType.OTHER: "Autre",
}
PHONE_TYPES: dict[str, str] = {
    PhoneType.MOBILE: "Mobile",
    PhoneType.LANDLINE: "Fixe",
    PhoneType.OTHER: "Autre",
}
STAGES: dict[str, str] = {
    ContactTrackingStatus.TO_CONTACT: "À contacter",
    ContactTrackingStatus.CONTACTED: "Contacté",
    ContactTrackingStatus.FOLLOW_UP_1: "Relance 1",
    ContactTrackingStatus.FOLLOW_UP_2: "Relance 2",
    ContactTrackingStatus.RESPONSE_RECEIVED: "Réponse reçue",
    ContactTrackingStatus.APPOINTMENT_OBTAINED: "Rendez-vous obtenu",
    ContactTrackingStatus.QUOTE_SENT: "Devis envoyé",
    ContactTrackingStatus.QUOTE_FOLLOW_UP: "Suivi du devis",
    ContactTrackingStatus.WON: "Gagné",
    ContactTrackingStatus.NOT_INTERESTED: "Pas intéressé",
}
SOURCE_TYPES: dict[str, str] = {
    ProspectSourceType.EXCEL_IMPORT: "Import Excel",
    ProspectSourceType.MANUAL: "Saisie manuelle",
    ProspectSourceType.FUTURE_AGENT: "Agent",
    ProspectSourceType.OTHER: "Autre source",
}


# --- field catalogue ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Field:
    label: str
    # What changed, without the value (Home's feed), e.g. « Rôle modifié ».
    summary: str
    render: Render = _text


def _channel_fields(noun: str, of_noun: str, value: tuple[str, Field]) -> dict[str, Field]:
    """Fields of an e-mail or phone; labels after the first one follow « E-mail <address> · »."""
    changed = f"{noun} modifié"
    return {
        value[0]: value[1],
        "is_primary": Field("principal", f"{noun} principal modifié"),
        "is_active": Field("actif", changed),
        "verification_status": Field(
            "vérification", f"Vérification {of_noun} modifiée", _choice(VERIFICATIONS)
        ),
        "last_verified_at": Field("vérifié le", f"{noun} vérifié", _moment),
        "origin_type": Field("origine", changed, _choice(ORIGINS)),
        "source_reference": Field("source", changed),
    }


# Every field a prospect's or company's history shows, in display order. A column missing here
# is never shown; `tests/test_history.py` requires each audited column to be here or in NOT_SHOWN.
FIELDS: dict[str, dict[str, Field]] = {
    "prospect": {
        "civility": Field("Civilité", "Civilité modifiée", _choice(CIVILITIES)),
        "first_name": Field("Prénom", "Prénom modifié"),
        "last_name": Field("Nom", "Nom modifié"),
        "company_id": Field("Entreprise", "Entreprise modifiée", _reference("company")),
        "role_id": Field("Rôle", "Rôle modifié", _reference("role")),
        "exact_job_title": Field("Intitulé exact", "Intitulé exact modifié"),
        "activity_status": Field("Activité", "Activité modifiée", _choice(ACTIVITIES)),
        "employment_verified_at": Field("Emploi vérifié le", "Emploi vérifié", _moment),
        "contactability_status": Field(
            "Contactabilité", "Opposition modifiée", _choice(CONTACTABILITY)
        ),
        "do_not_contact_at": Field("Opposition le", "Opposition modifiée", _moment),
        "do_not_contact_reason": Field("Motif d’opposition", "Opposition modifiée"),
    },
    "email": _channel_fields(
        "E-mail", "de l’e-mail", ("address", Field("Adresse e-mail", "Adresse e-mail modifiée"))
    ),
    "phone": _channel_fields(
        "Téléphone",
        "du téléphone",
        ("number", Field("Numéro de téléphone", "Numéro de téléphone modifié", _phone)),
    )
    | {"type": Field("type", "Téléphone modifié", _choice(PHONE_TYPES))},
    "contact_tracking": {
        "status": Field("Étape", "Étape modifiée", _choice(STAGES)),
        "planned_contact_at": Field("Contact prévu le", "Contact planifié", _moment),
        "response_received_at": Field("Réponse reçue le", "Réponse enregistrée", _moment),
        "appointment_at": Field("Rendez-vous le", "Rendez-vous planifié", _moment),
        "referent_id": Field("Référent Circoe", "Référent modifié", _reference("referent")),
    },
    "prospect_source": {
        "source_type": Field("type", "Provenance modifiée", _choice(SOURCE_TYPES)),
        "source_reference": Field("référence", "Provenance modifiée"),
        "collected_at": Field("collectée le", "Provenance modifiée", _moment),
        "legal_basis_or_collection_context": Field(
            "contexte de collecte ou base légale", "Provenance modifiée"
        ),
        "notes": Field("notes", "Provenance modifiée"),
    },
    "company": {
        "display_name": Field("Nom", "Nom de l’entreprise modifié"),
        "legal_name": Field("Raison sociale", "Raison sociale modifiée"),
        "siren": Field("SIREN", "SIREN modifié"),
        "commercial_segment_id": Field(
            "Segment commercial", "Segment commercial modifié", _reference("segment")
        ),
        "activity_categories_ids": Field(
            "Catégories d’activité", "Catégories d’activité modifiées", _reference("category")
        ),
        "size_label": Field("Taille", "Taille modifiée"),
        "website_url": Field("Site web", "Site web modifié"),
        "email_domain": Field("Domaine e-mail", "Domaine e-mail modifié"),
        "project_done_with_circoe": Field("Projet déjà réalisé", "Contexte Circoe modifié"),
        "project_type": Field("Type de projet", "Contexte Circoe modifié"),
        "circoe_references": Field("Références Circoe", "Contexte Circoe modifié"),
        "client_approach": Field("Approche client", "Contexte Circoe modifié"),
    },
    "establishment": {
        "name": Field("Nom de l’établissement", "Établissement modifié"),
        "kind": Field("type", "Établissement modifié"),
        "siret": Field("SIRET", "Établissement modifié"),
        "address_line1": Field("adresse", "Établissement modifié"),
        "address_line2": Field("complément d’adresse", "Établissement modifié"),
        "postal_code": Field("code postal", "Établissement modifié"),
        "city": Field("ville", "Établissement modifié"),
        "country": Field("pays", "Établissement modifié"),
        "is_primary": Field("principal", "Établissement principal modifié"),
    },
}
# Columns deliberately not shown: the parent key (it is the subject), the import batch id (the
# reference names the file) and the recorder snapshot (the entry's actor says who).
NOT_SHOWN: dict[str, frozenset[str]] = {
    "email": frozenset({"prospect_id"}),
    "phone": frozenset({"prospect_id"}),
    "contact_tracking": frozenset({"prospect_id"}),
    "prospect_source": frozenset(
        {"prospect_id", "import_batch_id", "actor_type", "actor_id", "actor_display"}
    ),
    "establishment": frozenset({"company_id"}),
}
# Child rows named by one of their fields, as it was at the time of the event.
IDENTITY_FIELDS = {"email": "address", "phone": "number", "establishment": "name"}
# Row kinds with one primary row per parent: a switch reads as one line.
PRIMARY_NOUNS = {"email": "E-mail", "phone": "Téléphone", "establishment": "Établissement"}
# Rows whose changes read « <Noun> <identity> · <field> ».
PREFIXED = {**PRIMARY_NOUNS, "prospect_source": "Provenance"}
# (noun, feminine) for lifecycle phrases.
NOUNS = {
    "prospect": ("Fiche", True),
    "email": ("E-mail", False),
    "phone": ("Téléphone", False),
    "contact_tracking": ("Suivi de contact", False),
    "prospect_source": ("Provenance", True),
    "company": ("Entreprise", True),
    "establishment": ("Établissement", False),
}


def _phrase(entity_type: str, participle: str) -> str:
    """« E-mail ajouté », « Provenance ajoutée »; « Modification » for another kind of row."""
    noun, feminine = NOUNS.get(entity_type, ("", False))
    return f"{noun} {participle}{'e' if feminine else ''}" if noun else "Modification"


# --- grouping ----------------------------------------------------------------------------------


def _source(event: AuditLogEntry) -> AuditSource | None:
    source = event.context.get("source")
    return AuditSource(source) if isinstance(source, str) and source in AuditSource else None


def _same_entry(newer: AuditLogEntry, event: AuditLogEntry) -> bool:
    request = event.context.get("request_id")
    same_origin = (
        (newer.subject_type, newer.subject_id) == (event.subject_type, event.subject_id)
        and (newer.actor_type, newer.actor_id) == (event.actor_type, event.actor_id)
        and newer.context.get("source") == event.context.get("source")
        and newer.context.get("request_id") == request
    )
    return same_origin and (
        request is not None or newer.occurred_at - event.occurred_at < UNBOUND_GAP
    )


def group_events(events: Iterable[AuditLogEntry]) -> list[list[AuditLogEntry]]:
    """Newest-first events → entries, newest first, each the run of events of one save."""
    groups: list[list[AuditLogEntry]] = []
    for event in events:
        if groups and _same_entry(groups[-1][-1], event):
            groups[-1].append(event)
        else:
            groups.append([event])
    return groups


# --- one entry ---------------------------------------------------------------------------------


def snapshot_actor(
    kind: ActorType, actor_id: str | None, display: str, on_behalf_of: str | None = None
) -> HistoryActor:
    """An actor snapshot (audit event, provenance source…) as shown: an import by its file name."""
    label = display.removeprefix(IMPORT_ACTOR_PREFIX) if kind is ActorType.IMPORT else display
    return HistoryActor(kind=kind, label=label, id=actor_id, on_behalf_of=on_behalf_of)


def actor_of(event: AuditLogEntry) -> HistoryActor:
    on_behalf = event.context.get("on_behalf_of")
    confirmed_by = on_behalf.get("display") if isinstance(on_behalf, dict) else None
    return snapshot_actor(
        event.actor_type,
        event.actor_id,
        event.actor_display,
        confirmed_by if isinstance(confirmed_by, str) else None,
    )


def _shown(event: AuditLogEntry) -> dict[str, dict[str, Any]]:
    """The event's changes that have a label (never a secret-looking name), in display order."""
    fields = FIELDS.get(event.entity_type, {})
    changes = event.changes
    return {
        name: changes[name]
        for name in fields
        if isinstance(changes.get(name), dict)
        and not audit_policy.is_secret(name, audit_policy.POLICY)
    }


def _value(event: AuditLogEntry, name: str, side: str, lookups: Lookups) -> str | None:
    change = event.changes.get(name)
    if not isinstance(change, dict):
        return None
    label = change.get(f"{side}_label")  # a readable snapshot given by the service
    if isinstance(label, str):
        return label
    return FIELDS[event.entity_type][name].render(change.get(side), lookups)


def _identity(event: AuditLogEntry, lookups: Lookups) -> str | None:
    name = IDENTITY_FIELDS.get(event.entity_type)
    if name is None:
        return None
    shown = _value(event, name, "after", lookups) or _value(event, name, "before", lookups)
    if shown is None and event.id in lookups.identities:
        shown = FIELDS[event.entity_type][name].render(lookups.identities[event.id], lookups)
    return shown


@dataclass
class _Lines:
    lookups: Lookups
    changes: list[HistoryChange] = field(default_factory=list)
    summary: list[str] = field(default_factory=list)

    def add(self, label: str, before: str | None, after: str | None) -> None:
        self.changes.append(HistoryChange(label, before, after))

    def note(self, phrase: str) -> None:
        if phrase not in self.summary:
            self.summary.append(phrase)


@dataclass(frozen=True, slots=True)
class _Switch:
    before: str | None
    after: str | None
    # Events whose primary flag the switch line covers; the line goes with the first of them.
    events: frozenset[uuid.UUID]


def _primary_switches(events: Sequence[AuditLogEntry], lookups: Lookups) -> dict[str, _Switch]:
    """Per row kind, the primary row one save replaced and the new one. A first e-mail created as
    primary is no switch (its line says « principal »), nor is a deleted primary not replaced."""
    lost: dict[str, AuditLogEntry] = {}
    gained: dict[str, AuditLogEntry] = {}
    for event in events:
        change = event.changes.get("is_primary")
        if event.entity_type in PRIMARY_NOUNS and isinstance(change, dict):
            if change.get("before") is True and not change.get("after"):
                lost[event.entity_type] = event
            if change.get("after") is True and not change.get("before"):
                gained[event.entity_type] = event
    switches = {}
    for kind in PRIMARY_NOUNS:
        old, new = lost.get(kind), gained.get(kind)
        updated = [event for event in (old, new) if event and event.action.endswith(".updated")]
        if (old and new) or updated:
            switches[kind] = _Switch(
                before=_identity(old, lookups) if old else None,
                after=_identity(new, lookups) if new else None,
                events=frozenset(event.id for event in (old, new) if event),
            )
    return switches


def _created(event: AuditLogEntry, lines: _Lines, switched: frozenset[uuid.UUID]) -> None:
    kind, lookups = event.entity_type, lines.lookups

    def value(name: str) -> str | None:
        return _value(event, name, "after", lookups) if name in FIELDS.get(kind, {}) else None

    if kind in PRIMARY_NOUNS:
        status = value("verification_status")
        facets = (
            _identity(event, lookups),
            value("type"),
            value("kind"),
            value("city"),
            "principal" if value("is_primary") == "Oui" and event.id not in switched else None,
            "inactif" if value("is_active") == "Non" else None,
            status.lower() if status and status != VERIFICATIONS["unverified"] else None,
        )
        phrase = _phrase(kind, "ajouté")
        lines.add(phrase, None, " · ".join(part for part in facets if part) or None)
        lines.note(phrase)
        return
    if kind == "prospect_source":
        reference = (value("source_type"), value("source_reference"))
        lines.add("Provenance ajoutée", None, " · ".join(part for part in reference if part))
        context = value("legal_basis_or_collection_context")
        if context:
            lines.add("Contexte de collecte ou base légale", None, context)
        lines.note("Provenance ajoutée")
        return
    if kind == "contact_tracking":
        lines.note(f"Suivi : {value('status') or STAGES[ContactTrackingStatus.TO_CONTACT]}")
    else:
        lines.note(_phrase(kind, "créé"))
    for name, spec in FIELDS.get(kind, {}).items():
        shown = value(name)
        if shown and not (name == "contactability_status" and shown == "Contactable"):
            lines.add(spec.label, None, shown)


def _deleted(event: AuditLogEntry, lines: _Lines) -> None:
    kind = event.entity_type
    if kind in PREFIXED:
        phrase = _phrase(kind, "retiré")
        identity = (
            _identity(event, lines.lookups)
            if kind in PRIMARY_NOUNS
            else _value(event, "source_reference", "before", lines.lookups)
        )
        lines.add(phrase, identity, None)
    else:
        phrase = _phrase(kind, "supprimé")
    lines.note(phrase)


def _updated_phrase(event: AuditLogEntry, name: str, spec: Field) -> str:
    """The value-free phrase of one updated field."""
    change = event.changes[name]
    kind, after = event.entity_type, change.get("after")
    if event.action == AuditAction.PROSPECT_COMPANY_CHANGED:
        return "Changement d’entreprise"
    if kind == "contact_tracking" and name == "status":
        before = STAGES.get(change.get("before"), EMPTY)
        return f"Suivi : {before} → {STAGES.get(after, EMPTY)}"
    if name == "employment_verified_at" and after is None:
        return "Vérification de l’emploi effacée"
    if name == "verification_status" and after == VerificationStatus.VERIFIED:
        return _phrase(kind, "vérifié")
    if name == "last_verified_at" and after is None:
        return FIELDS[kind]["verification_status"].summary
    return spec.summary


def _updated(event: AuditLogEntry, lines: _Lines, switched: frozenset[uuid.UUID]) -> None:
    kind, lookups = event.entity_type, lines.lookups
    identity = _identity(event, lookups)
    prefix = " ".join(part for part in (PREFIXED.get(kind), identity) if part)
    shown = _shown(event)
    for name, spec in FIELDS.get(kind, {}).items():
        if name not in shown or (name == "is_primary" and event.id in switched):
            continue
        if name == "last_verified_at" and "verification_status" in shown:
            continue  # the status line says it
        if name == "is_active" and kind in PRIMARY_NOUNS:
            active = bool(shown[name].get("after"))
            phrase = _phrase(kind, "réactivé" if active else "désactivé")
            lines.add(phrase, None if active else identity, identity if active else None)
            lines.note(phrase)
            continue
        label = spec.label
        if prefix and name != IDENTITY_FIELDS.get(kind):
            label = f"{prefix} · {spec.label}"
        before = _value(event, name, "before", lookups) or EMPTY
        after = _value(event, name, "after", lookups) or EMPTY
        lines.add(label, before, after)
        lines.note(_updated_phrase(event, name, spec))


def _opposition(event: AuditLogEntry, lines: _Lines, phrase: str) -> None:
    reason = _text(event.context.get("reason"), lines.lookups)
    if reason:
        lines.add(f"{phrase} — motif", None, reason)
    else:
        lines.add(phrase, None, None)
    lines.note(phrase)


OPPOSITIONS: dict[str, str] = {
    AuditAction.PROSPECT_DO_NOT_CONTACT_SET: "Opposition enregistrée",
    AuditAction.PROSPECT_DO_NOT_CONTACT_CLEARED: "Opposition levée",
}
# The entry title: the first of these actions in the save, else the subject's default.
TITLES: dict[str, str] = {
    "prospect.created": "Fiche créée",
    "prospect.deleted": "Fiche supprimée",
    "company.created": "Entreprise créée",
    "company.deleted": "Entreprise supprimée",
    **OPPOSITIONS,
    AuditAction.PROSPECT_COMPANY_CHANGED: "Changement d’entreprise",
}
DEFAULT_TITLES = {"prospect": "Fiche modifiée", "company": "Entreprise modifiée"}


def describe(group: Sequence[AuditLogEntry], lookups: Lookups) -> HistoryEntry:
    """The entry of one save, from its events newest first (as `group_events` returns them)."""
    newest = group[0]
    events = list(reversed(group))
    lines = _Lines(lookups)
    switches = _primary_switches(events, lookups)
    switched = frozenset(event_id for switch in switches.values() for event_id in switch.events)
    for event in events:
        if event.action in OPPOSITIONS:
            _opposition(event, lines, OPPOSITIONS[event.action])
        elif event.action.endswith(".created"):
            _created(event, lines, switched)
        elif event.action.endswith(".deleted"):
            _deleted(event, lines)
        else:
            _updated(event, lines, switched)
        switch = switches.get(event.entity_type)
        if switch and event.id in switch.events:
            noun = PRIMARY_NOUNS[event.entity_type]
            lines.add(f"{noun} principal", switch.before or EMPTY, switch.after or EMPTY)
            lines.note(f"{noun} principal modifié")
            del switches[event.entity_type]
    actions = [event.action for event in events]
    subject_type = newest.subject_type or newest.entity_type
    title = next(
        (title for action, title in TITLES.items() if action in actions),
        DEFAULT_TITLES.get(subject_type, "Modification"),
    )
    return HistoryEntry(
        id=newest.id,
        occurred_at=newest.occurred_at,
        actor=actor_of(newest),
        source=_source(newest),
        subject_type=subject_type,
        subject_id=newest.subject_id,
        actions=actions,
        title=title,
        summary=lines.summary or [title],
        changes=lines.changes,
    )


# --- pages ---------------------------------------------------------------------------------------

# Records referenced by id in change sets: kind → (id column, label).
REFERENCE_LABELS: dict[str, tuple[Any, Any]] = {
    "company": (Company.id, Company.display_name),
    "role": (Role.id, Role.label),
    "segment": (CommercialSegment.id, CommercialSegment.label),
    "category": (ActivityCategory.id, ActivityCategory.label),
    "referent": (
        InternalReferent.id,
        func.concat_ws(" ", InternalReferent.first_name, InternalReferent.last_name),
    ),
}
REFERENCE_FIELDS = {
    "company_id": "company",
    "role_id": "role",
    "commercial_segment_id": "segment",
    "activity_categories_ids": "category",
    "referent_id": "referent",
}


def _referenced_ids(events: Iterable[AuditLogEntry]) -> dict[str, set[str]]:
    """Ids to label: reference fields without a snapshot label (children's parent keys aside)."""
    wanted: dict[str, set[str]] = {kind: set() for kind in REFERENCE_LABELS}
    for event in events:
        for name, change in _shown(event).items():
            kind = REFERENCE_FIELDS.get(name)
            if kind is None:
                continue
            for side in ("before", "after"):
                value = change.get(side)
                if isinstance(change.get(f"{side}_label"), str) or value is None:
                    continue
                wanted[kind] |= (
                    {str(item) for item in value} if isinstance(value, list) else {str(value)}
                )
    return wanted


def _as_uuids(ids: Iterable[str]) -> set[uuid.UUID]:
    found = set()
    for value in ids:
        try:
            found.add(uuid.UUID(value))
        except ValueError:
            continue
    return found


def load_lookups(session: Session, events: Sequence[AuditLogEntry]) -> Lookups:
    """Labels and identities for these events: one query per referenced kind present, plus one
    for child rows named by an earlier event (an e-mail whose flag changed but not its address)."""
    labels: dict[tuple[str, str], str] = {}
    for kind, ids in _referenced_ids(events).items():
        key, label = REFERENCE_LABELS[kind]
        if wanted := _as_uuids(ids):
            for row_id, name in session.execute(select(key, label).where(key.in_(wanted))):
                labels[(kind, str(row_id))] = name
    unnamed = [
        event
        for event in events
        if event.entity_type in IDENTITY_FIELDS
        and event.entity_id is not None
        and IDENTITY_FIELDS[event.entity_type] not in event.changes
    ]
    identities: dict[uuid.UUID, str] = {}
    known = audit_repository.identity_changes(
        session, IDENTITY_FIELDS, {event.entity_id for event in unnamed if event.entity_id}
    )
    for event in unnamed:
        for earlier in known:
            if earlier.entity_id != event.entity_id or earlier.occurred_at > event.occurred_at:
                continue
            change = earlier.changes[IDENTITY_FIELDS[event.entity_type]]
            value = change.get("after") if change.get("after") is not None else change.get("before")
            if isinstance(value, str):
                identities[event.id] = value
    return Lookups(labels=labels, identities=identities)


def history_page(
    session: Session,
    subject_type: str,
    subject_id: uuid.UUID,
    *,
    limit: int,
    before: uuid.UUID | None = None,
) -> HistoryPage:
    """`limit` entries of a prospect's or company's history (its child rows included), newest
    first, after the entry ending with event `before`. Reads events until one more entry starts,
    so an entry is never cut between two pages."""
    events: list[AuditLogEntry] = []
    groups: list[list[AuditLogEntry]] = []
    cursor, exhausted = before, False
    while len(groups) <= limit and not exhausted:
        read = audit.history(
            session, subject_type, subject_id, limit=EVENTS_PER_READ, before=cursor
        )
        events.extend(read)
        groups = group_events(events)
        exhausted = len(read) < EVENTS_PER_READ
        cursor = read[-1].id if read else cursor
    page = groups[:limit]
    shown = [event for group in page for event in group]
    lookups = load_lookups(session, shown)
    return HistoryPage(
        items=[describe(group, lookups) for group in page],
        next_cursor=page[-1][-1].id if len(groups) > limit else None,
    )
