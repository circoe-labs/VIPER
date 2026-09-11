"""Readable history (Task 19): the formatter per kind of event, grouping, pages, actors and the
payload policy. Synthetic values only."""

import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.core import audit_policy
from app.core.actor import ActorContext, ActorType
from app.core.audit_policy import PersonalValues
from app.models import (
    ActivityCategory,
    AuditLogEntry,
    Company,
    ContactTracking,
    Email,
    Establishment,
    Phone,
    Prospect,
    ProspectSource,
)
from app.models.enums import ContactTrackingStatus, OriginType, VerificationStatus
from app.services import audit, history, home, import_batches, provenance
from app.services import prospects as prospect_service
from app.services.audit import AuditContext, AuditSource
from app.services.audit_changes import TECHNICAL_FIELDS
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.history import HistoryChange, HistoryEntry, HistoryPage
from app.services.prospects import ChannelInput, ProspectInput
from tests.builders import OPERATOR, add_company, add_email, add_phone, add_prospect, add_role

S = ContactTrackingStatus
CLI = ActorContext(type=ActorType.SYSTEM, display="Ligne de commande", id="app.cli")
AGENT = ActorContext(type=ActorType.AGENT, display="Agent de qualification (test)", id="agent.t")
AT = datetime(2026, 9, 11, 8, 30, tzinfo=UTC)  # 10:30 in Paris


@contextmanager
def saving(
    session: Session,
    actor: ActorContext = OPERATOR,
    source: AuditSource = AuditSource.UI,
    on_behalf_of: ActorContext | None = None,
) -> Iterator[None]:
    """One signed-in request (one save): its own request id, like `require_session` binds."""
    context = AuditContext(source=source, request_id=str(uuid.uuid7()), on_behalf_of=on_behalf_of)
    with audit.bound(session, actor, context):
        yield


def entries(session: Session, subject: Prospect | Company, limit: int = 50) -> list[HistoryEntry]:
    kind = "prospect" if isinstance(subject, Prospect) else "company"
    return history.history_page(session, kind, subject.id, limit=limit).items


def latest(session: Session, subject: Prospect | Company) -> HistoryEntry:
    return entries(session, subject)[0]


def lines(entry: HistoryEntry) -> list[tuple[str, str | None, str | None]]:
    return [(change.label, change.before, change.after) for change in entry.changes]


# --- one kind of event at a time --------------------------------------------------------------


def test_a_manual_edit_reads_field_by_field_with_labels(db_session: Session) -> None:
    role = add_role(db_session, "resp-exploitation", "Responsable exploitation")
    prospect = add_prospect(db_session, add_company(db_session), last_name="Témoin")

    with saving(db_session):
        audit.annotate(db_session, OPERATOR, prospect, labels={"role_id": (None, role.label)})
        prospect.last_name = "Martin"
        prospect.role_id = role.id
        prospect.employment_verified_at = AT
        db_session.flush()

    entry = latest(db_session, prospect)
    assert (entry.title, entry.actor.kind, entry.actor.label, entry.source) == (
        "Fiche modifiée",
        ActorType.HUMAN,
        "Opératrice Test",
        AuditSource.UI,
    )
    assert entry.actor.id == OPERATOR.id
    assert lines(entry) == [
        ("Nom", "Témoin", "Martin"),
        ("Rôle", "—", "Responsable exploitation"),
        ("Emploi vérifié le", "—", "11 sept. 2026 à 10:30"),
    ]
    assert entry.summary == ["Nom modifié", "Rôle modifié", "Emploi vérifié"]
    assert entry.actions == ["prospect.updated"]


def test_an_import_creation_names_the_file_and_the_person_who_confirmed_it(
    db_session: Session,
) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    batch = import_batches.start_batch(
        db_session, OPERATOR, filename="base_synthetique.xlsx", sheet_names=["Prospects"]
    )
    with import_batches.importing(db_session, batch, confirmed_by=OPERATOR) as importer:
        prospect = prospect_service.create_prospect(
            db_session,
            importer,
            ProspectInput(
                first_name="Jean",
                last_name="Import",
                company_id=company.id,
                emails=[
                    ChannelInput(
                        "jean.import@exemple.example",
                        is_primary=True,
                        origin_type=OriginType.IMPORTED,
                    )
                ],
            ),
        )
        save_contact_tracking(db_session, importer, prospect.id, ContactTrackingInput(S.CONTACTED))
        provenance.add_import_source(
            db_session,
            importer,
            prospect.id,
            batch,
            sheet="Prospects",
            row_number=7,
            legal_basis_or_collection_context="Fichier historique (synthétique)",
        )

    (entry,) = entries(db_session, prospect)
    assert (entry.title, entry.source) == ("Fiche créée", AuditSource.IMPORT)
    assert (entry.actor.kind, entry.actor.label, entry.actor.on_behalf_of) == (
        ActorType.IMPORT,
        "base_synthetique.xlsx",
        "Opératrice Test",
    )
    assert entry.actor.id == str(batch.id)
    changes = lines(entry)
    assert ("Prénom", None, "Jean") in changes
    assert ("Entreprise", None, "Transports Exemple SARL") in changes
    assert ("E-mail ajouté", None, "jean.import@exemple.example · principal") in changes
    assert ("Étape", None, "Contacté") in changes
    assert (
        "Provenance ajoutée",
        None,
        "Import Excel · base_synthetique.xlsx / Prospects / ligne 7",
    ) in changes
    assert ("Contexte de collecte ou base légale", None, "Fichier historique (synthétique)") in (
        changes
    )
    assert entry.summary == [
        "Fiche créée",
        "E-mail ajouté",
        "Suivi : Contacté",
        "Provenance ajoutée",
    ]


def test_a_company_change_names_both_companies_and_what_goes_back_to_verify(
    db_session: Session,
) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    other = add_company(db_session, "Nouvel Employeur SAS")
    prospect = add_prospect(db_session, company, employment_verified_at=AT)
    add_email(
        db_session,
        prospect,
        "jean.test@exemple.example",
        is_primary=True,
        verification_status=VerificationStatus.VERIFIED,
        last_verified_at=AT,
    )

    with saving(db_session):
        prospect_service.change_company(db_session, OPERATOR, prospect.id, other.id)

    entry = latest(db_session, prospect)
    assert entry.title == "Changement d’entreprise"
    assert lines(entry) == [
        ("Entreprise", "Transports Exemple SARL", "Nouvel Employeur SAS"),
        ("Emploi vérifié le", "11 sept. 2026 à 10:30", "—"),
        ("E-mail jean.test@exemple.example · vérification", "Vérifié", "Non vérifié"),
    ]
    assert entry.summary == ["Changement d’entreprise", "Vérification de l’e-mail modifiée"]


def test_a_primary_switch_reads_as_one_line_and_names_each_alias(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    old = add_email(db_session, prospect, "ancienne@exemple.example", is_primary=True)
    phone = add_phone(db_session, prospect, "+33612345678", is_primary=True)

    with saving(db_session):
        audit.annotate(db_session, OPERATOR, old)
        old.is_primary = False
        db_session.flush()
        new = Email(
            prospect_id=prospect.id,
            address="nouvelle@exemple.example",
            is_primary=True,
            origin_type=OriginType.MANUAL,
        )
        audit.annotate(db_session, OPERATOR, new)
        db_session.add(new)
        audit.annotate(db_session, OPERATOR, phone)
        phone.verification_status = VerificationStatus.VERIFIED
        phone.last_verified_at = AT
        db_session.flush()

    entry = latest(db_session, prospect)
    # The unchanged address of the old primary comes from its creation event.
    assert lines(entry) == [
        ("E-mail principal", "ancienne@exemple.example", "nouvelle@exemple.example"),
        ("E-mail ajouté", None, "nouvelle@exemple.example"),
        ("Téléphone +33 6 12 34 56 78 · vérification", "Non vérifié", "Vérifié"),
    ]
    assert entry.summary == ["E-mail principal modifié", "E-mail ajouté", "Téléphone vérifié"]


def test_deactivated_and_removed_aliases(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    former = add_email(db_session, prospect, "ancienne@exemple.example")
    typo = add_phone(db_session, prospect, "+33100000000")

    with saving(db_session):
        audit.annotate(db_session, OPERATOR, former)
        former.is_active = False
        audit.annotate(db_session, OPERATOR, typo)
        db_session.delete(typo)
        db_session.flush()

    entry = latest(db_session, prospect)
    assert lines(entry) == [
        ("E-mail désactivé", "ancienne@exemple.example", None),
        ("Téléphone retiré", "+33 1 00 00 00 00", None),
    ]
    assert entry.summary == ["E-mail désactivé", "Téléphone retiré"]


def test_a_tracking_stage_change_and_its_dates(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    save_contact_tracking(db_session, OPERATOR, prospect.id, ContactTrackingInput(S.CONTACTED))
    planned = datetime(2026, 9, 13, 22, 0, tzinfo=UTC)  # 14 Sept., midnight in Paris

    with saving(db_session):
        save_contact_tracking(
            db_session,
            OPERATOR,
            prospect.id,
            ContactTrackingInput(S.FOLLOW_UP_1, planned_contact_at=planned),
        )

    entry = latest(db_session, prospect)
    assert lines(entry) == [
        ("Étape", "Contacté", "Relance 1"),
        ("Contact prévu le", "—", "14 sept. 2026"),
    ]
    assert entry.summary == ["Suivi : Contacté → Relance 1", "Contact planifié"]
    assert entry.actions == ["contact_tracking.status_changed"]


def test_an_opposition_set_then_lifted_shows_each_reason(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    with saving(db_session):
        prospect_service.mark_do_not_contact(
            db_session, OPERATOR, prospect.id, reason="Demande écrite (synthétique)"
        )
    with saving(db_session):
        prospect_service.clear_do_not_contact(
            db_session, OPERATOR, prospect.id, reason="Consentement renouvelé (synthétique)"
        )

    cleared, marked = entries(db_session, prospect)[:2]
    assert (marked.title, lines(marked)) == (
        "Opposition enregistrée",
        [("Opposition enregistrée — motif", None, "Demande écrite (synthétique)")],
    )
    assert (cleared.title, lines(cleared)) == (
        "Opposition levée",
        [("Opposition levée — motif", None, "Consentement renouvelé (synthétique)")],
    )
    assert (marked.summary, cleared.summary) == (["Opposition enregistrée"], ["Opposition levée"])


def test_a_database_explorer_edit_keeps_its_source(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    with saving(db_session, source=AuditSource.DATABASE_EXPLORER):
        prospect.exact_job_title = "Chef de quai (synthétique)"
        db_session.flush()

    entry = latest(db_session, prospect)
    assert (entry.source, entry.actor.kind) == (AuditSource.DATABASE_EXPLORER, ActorType.HUMAN)
    assert lines(entry) == [("Intitulé exact", "—", "Chef de quai (synthétique)")]


def test_a_command_line_creation_is_one_system_entry(db_session: Session) -> None:
    with audit.bound(db_session, CLI):
        company = add_company(db_session, "Entrepôts Exemple SAS", siren=None)
        db_session.add(
            Establishment(company_id=company.id, name="Siège", city="Lyon", is_primary=True)
        )
        db_session.flush()

    (entry,) = entries(db_session, company)
    assert (entry.actor.kind, entry.actor.label, entry.source) == (
        ActorType.SYSTEM,
        "Ligne de commande",
        AuditSource.CLI,
    )
    assert entry.title == "Entreprise créée"
    assert lines(entry) == [
        ("Nom", None, "Entrepôts Exemple SAS"),
        ("Établissement ajouté", None, "Siège · Lyon · principal"),
    ]


def test_company_fields_categories_and_establishments(db_session: Session) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    siege = Establishment(company_id=company.id, name="Siège", city="Lyon", is_primary=True)
    depot = Establishment(company_id=company.id, name="Dépôt", city="Nantes")
    db_session.add_all([siege, depot])
    db_session.flush()
    category = ActivityCategory(slug="entreposage-test", label="Entreposage (test)")
    db_session.add(category)
    db_session.flush()

    with saving(db_session):
        audit.annotate(db_session, OPERATOR, company)
        company.email_domain = "exemple.example"
        company.activity_categories = [category]
        audit.annotate(db_session, OPERATOR, siege)
        siege.is_primary = False
        db_session.flush()
        audit.annotate(db_session, OPERATOR, depot)
        depot.is_primary = True
        depot.city = "Saint-Nazaire"
        db_session.flush()

    entry = latest(db_session, company)
    assert entry.title == "Entreprise modifiée"
    assert lines(entry) == [
        ("Domaine e-mail", "—", "exemple.example"),
        ("Catégories d’activité", "—", "Entreposage (test)"),
        ("Établissement principal", "Siège", "Dépôt"),
        ("Établissement Dépôt · ville", "Nantes", "Saint-Nazaire"),
    ]


def test_an_agent_actor_is_representable_in_the_history_and_on_home(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session), first_name="Léa")
    with saving(db_session, AGENT, AuditSource.AGENT, on_behalf_of=OPERATOR):
        audit.annotate(db_session, AGENT, prospect)
        prospect.exact_job_title = "Directrice logistique (synthétique)"
        db_session.flush()

    entry = latest(db_session, prospect)
    assert (entry.actor.kind, entry.actor.label, entry.actor.id, entry.source) == (
        ActorType.AGENT,
        "Agent de qualification (test)",
        "agent.t",
        AuditSource.AGENT,
    )
    assert entry.actor.on_behalf_of == "Opératrice Test"
    (edit,) = home.recent_edits(db_session)
    assert (edit.actor.kind, edit.summary) == (ActorType.AGENT, ["Intitulé exact modifié"])


# --- grouping and pages ------------------------------------------------------------------------


def test_one_entry_per_save_and_a_new_one_for_the_next_save(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    with saving(db_session):
        prospect.exact_job_title = "Premier intitulé"
        add_email(db_session, prospect, "un@exemple.example", is_primary=True)
    with saving(db_session):
        prospect.exact_job_title = "Second intitulé"
        db_session.flush()

    second, first = entries(db_session, prospect)[:2]
    # One flush writes creations before updates.
    assert first.actions == ["email.created", "prospect.updated"]
    assert second.actions == ["prospect.updated"]
    assert second.occurred_at > first.occurred_at


SUBJECT = uuid.UUID("00000000-0000-7000-8000-000000000001")


def event(
    *,
    at: datetime,
    action: str = "prospect.updated",
    changes: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
    actor: ActorContext = CLI,
    subject: uuid.UUID = SUBJECT,
) -> AuditLogEntry:
    """An event as stored, without the database (pure formatter tests)."""
    return AuditLogEntry(
        id=uuid.uuid7(),
        occurred_at=at,
        actor_type=actor.type,
        actor_id=actor.id,
        actor_display=actor.display,
        entity_type=action.split(".")[0],
        entity_id=subject,
        subject_type="prospect",
        subject_id=subject,
        action=action,
        changes=changes or {},
        context=context or {"source": "cli"},
    )


def test_events_outside_a_request_group_only_when_close_together() -> None:
    newest_first = [
        event(at=AT + timedelta(seconds=30)),
        event(at=AT + timedelta(seconds=2)),
        event(at=AT),
    ]

    assert [len(group) for group in history.group_events(newest_first)] == [1, 2]


def test_a_feed_across_records_joins_each_save_despite_concurrent_saves() -> None:
    other = uuid.uuid7()
    saves = [("r1", SUBJECT), ("r2", other), ("r1", SUBJECT), ("r2", other)]
    newest_first = [
        event(at=AT + timedelta(seconds=n), context={"source": "ui", "request_id": r}, subject=s)
        for n, (r, s) in enumerate(saves)
    ][::-1]

    # One record's history keeps consecutive runs (its pages cut between entries)…
    assert [len(group) for group in history.group_events(newest_first)] == [1, 1, 1, 1]
    # …Home's feed across records joins a request's events on one record wherever they fall.
    feed = history.group_events(newest_first, across_records=True)
    assert [(group[0].subject_id, len(group)) for group in feed] == [(other, 2), (SUBJECT, 2)]


def test_pages_follow_the_cursor_without_cutting_a_save(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    for n in range(7):
        with saving(db_session):
            prospect.exact_job_title = f"Intitulé {n}"
            add_email(db_session, prospect, f"adresse{n}@exemple.example")
    # Reads of 3 events: every save (2 events) spans two reads somewhere.
    monkeypatch.setattr(history, "EVENTS_PER_READ", 3)

    everything = entries(db_session, prospect)
    pages: list[HistoryPage] = [history.history_page(db_session, "prospect", prospect.id, limit=3)]
    while pages[-1].next_cursor:
        pages.append(
            history.history_page(
                db_session, "prospect", prospect.id, limit=3, before=pages[-1].next_cursor
            )
        )

    assert [len(page.items) for page in pages] == [3, 3, len(everything) - 6]
    assert [entry.id for page in pages for entry in page.items] == [e.id for e in everything]
    assert [e.actions for e in everything[:7]] == [["email.created", "prospect.updated"]] * 7
    moments = [(e.occurred_at, e.id) for e in everything]
    assert moments == sorted(moments, reverse=True)
    assert everything[0].changes == [
        HistoryChange("E-mail ajouté", None, "adresse6@exemple.example"),
        HistoryChange("Intitulé exact", "Intitulé 5", "Intitulé 6"),
    ]


# --- payload policy ------------------------------------------------------------------------------


def test_personal_values_are_shown_as_the_policy_stored_them(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        audit_policy, "POLICY", replace(audit_policy.POLICY, personal_values=PersonalValues.MASKED)
    )
    prospect = add_prospect(db_session, add_company(db_session))
    with saving(db_session):
        add_email(db_session, prospect, "jean.secret@exemple.example", is_primary=True)
        prospect.first_name = "Jeannot"
        db_session.flush()

    entry = latest(db_session, prospect)
    assert ("Prénom", "J•••", "J•••") in lines(entry)
    assert ("E-mail ajouté", None, "j•••@exemple.example · principal") in lines(entry)
    assert "jean.secret" not in json.dumps(asdict(entry), default=str)


def test_secrets_masked_values_and_structures_never_reach_the_display() -> None:
    stored = event(
        at=AT,
        changes={
            "exact_job_title": {"before": audit_policy.MASKED_VALUE, "after": {"raw": "json"}},
            "password_hash": {"before": "argon2-hash", "after": "autre"},
            "api_token": {"before": "t0k3n", "after": None},
            "legacy_metadata": {"before": None, "after": audit_policy.MASKED_VALUE},
        },
    )

    entry = history.describe([stored], history.Lookups())

    assert lines(entry) == [("Intitulé exact", "(masqué)", "(valeur non affichée)")]
    shown = json.dumps(asdict(entry), default=str)
    for leaked in ("argon2", "t0k3n", "raw", "legacy", "password", "token"):
        assert leaked not in shown


def test_every_audited_column_of_a_history_is_labelled_or_deliberately_hidden() -> None:
    models = {
        "prospect": Prospect,
        "email": Email,
        "phone": Phone,
        "contact_tracking": ContactTracking,
        "prospect_source": ProspectSource,
        "company": Company,
        "establishment": Establishment,
    }
    for kind, model in models.items():
        columns = {attr.key for attr in inspect(model).column_attrs} - TECHNICAL_FIELDS
        many = {
            f"{rel.key}_ids" for rel in inspect(model).relationships if rel.secondary is not None
        }
        shown = set(history.FIELDS[kind])
        assert columns | many == shown | history.NOT_SHOWN.get(kind, frozenset()), kind
        assert not any(audit_policy.is_secret(name, audit_policy.POLICY) for name in shown)
