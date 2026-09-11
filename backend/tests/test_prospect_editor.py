"""Prospect editor service (Task 15): the view model and the atomic save composing the domain
operations — identity, company change, role, verification, aliases, tracking, provenance,
contactability, concurrency and deletion. Synthetic values only."""

import uuid
from dataclasses import replace
from datetime import UTC, date, datetime, time

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.business_time import business_moment, start_of_day
from app.models import (
    ContactTrackingStatusHistory,
    Email,
    InternalReferent,
    Prospect,
    ProspectSource,
    Role,
)
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
from app.services import import_batches, provenance
from app.services.contact_channels import ChannelItem
from app.services.errors import (
    ConflictError,
    DoNotContactError,
    DuplicateValueError,
    InvalidFieldError,
    NotFoundError,
)
from app.services.prospect_editor import (
    EditorClock,
    EmploymentVerification,
    ManualSource,
    ProspectForm,
    ProspectView,
    TrackingForm,
    VerificationAction,
    create_prospect,
    delete_prospect,
    get_view,
    set_contactability,
    update_prospect,
)
from app.services.prospection.segments import VerificationState
from tests.builders import (
    OPERATOR,
    add_company,
    add_email,
    add_phone,
    add_prospect,
    add_role,
    audit_events,
)

NOW = datetime(2026, 9, 11, 8, 30, tzinfo=UTC)  # 10:30 in Paris
CLOCK = EditorClock(now=NOW)
EARLIER = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
CONTEXT = "Saisie manuelle — prospection B2B (synthétique)"


def form_of(view: ProspectView, **changes: object) -> ProspectForm:
    """The editor's form as loaded from `view` (nothing changed), then `changes`."""
    tracking = view.tracking
    form = ProspectForm(
        first_name=view.first_name,
        last_name=view.last_name,
        company_id=view.company.id if view.company else None,
        civility=view.civility,
        role_id=view.role.id if view.role else None,
        exact_job_title=view.exact_job_title,
        activity_status=view.activity_status,
        emails=[
            ChannelItem(
                id=email.id,
                value=email.address,
                is_primary=email.is_primary,
                is_active=email.is_active,
                verification_status=email.verification_status,
                source_reference=email.source_reference,
            )
            for email in view.emails
        ],
        phones=[
            ChannelItem(
                id=phone.id,
                value=phone.number,
                phone_type=phone.type,
                is_primary=phone.is_primary,
                is_active=phone.is_active,
                verification_status=phone.verification_status,
                source_reference=phone.source_reference,
            )
            for phone in view.phones
        ],
        tracking=TrackingForm(
            status=tracking.status,
            planned_contact_on=tracking.planned_contact_on,
            response_received_on=tracking.response_received_on,
            appointment_on=tracking.appointment_on,
            appointment_time=tracking.appointment_time,
            referent_id=tracking.referent.id if tracking.referent else None,
        )
        if tracking
        else None,
    )
    return replace(form, **changes)  # type: ignore[arg-type]


def save(session: Session, prospect: Prospect, **changes: object) -> ProspectView:
    view = get_view(session, prospect.id, CLOCK)
    return update_prospect(
        session, OPERATOR, prospect.id, view.version, form_of(view, **changes), CLOCK
    )


def refused(error: pytest.ExceptionInfo[InvalidFieldError]) -> tuple[str, str | None]:
    return error.value.field, error.value.reason


def actions(session: Session) -> list[str]:
    return [event.action for event in audit_events(session)]


# --- creation --------------------------------------------------------------------------------


def test_creation_records_the_person_their_aliases_tracking_and_manual_provenance(
    db_session: Session,
) -> None:
    company = add_company(db_session)
    referent = InternalReferent(first_name="Claire", last_name="Référente")
    db_session.add(referent)
    db_session.flush()
    data = ProspectForm(
        first_name="  Jean ",
        last_name="Saisie   Test",
        company_id=company.id,
        civility=Civility.MR,
        role_label="Responsable quai fictif",
        exact_job_title="Chef de quai (synthétique)",
        activity_status=ActivityStatus.ACTIVE,
        employment_verification=EmploymentVerification(VerificationAction.VERIFIED_NOW),
        emails=[ChannelItem(value=" Jean.Saisie@Exemple.FR ", verified_now=True)],
        phones=[
            ChannelItem(value="06 12 34 56 78", phone_type=PhoneType.MOBILE),
            ChannelItem(value="01 23 45 67 89", phone_type=PhoneType.LANDLINE),
        ],
        tracking=TrackingForm(
            status=ContactTrackingStatus.TO_CONTACT,
            planned_contact_on=date(2026, 9, 16),
            referent_id=referent.id,
        ),
    )

    view = create_prospect(
        db_session, OPERATOR, data, ManualSource(f" {CONTEXT} ", "Salon fictif 2026"), CLOCK
    )

    assert (view.first_name, view.last_name, view.civility) == ("Jean", "Saisie Test", Civility.MR)
    assert view.company is not None and view.company.id == company.id
    assert view.role is not None and view.role.label == "Responsable quai fictif"
    assert view.employment_verified_at == NOW
    assert view.verification_state is VerificationState.VERIFIED
    [email] = view.emails
    assert (email.address, email.is_primary, email.origin_type) == (
        "jean.saisie@exemple.fr",
        True,
        OriginType.MANUAL,
    )
    assert (email.verification_status, email.last_verified_at) == (VerificationStatus.VERIFIED, NOW)
    assert [(phone.number, phone.is_primary) for phone in view.phones] == [
        ("+33612345678", True),
        ("+33123456789", False),
    ]
    assert view.tracking is not None
    assert (view.tracking.planned_contact_on, view.tracking.planned_contact_week) == (
        date(2026, 9, 16),
        "2026-W38",
    )
    [source] = view.sources
    assert (source.source_type, source.legal_basis_or_collection_context) == (
        ProspectSourceType.MANUAL,
        CONTEXT,
    )
    assert (source.source_reference, source.actor_display) == (
        "Salon fictif 2026",
        OPERATOR.display,
    )
    assert sorted(actions(db_session)) == sorted(
        [
            "role.created",
            "prospect.created",
            "email.created",
            "phone.created",
            "phone.created",
            "contact_tracking.created",
            "prospect_source.created",
        ]
    )
    assert {event.actor_id for event in audit_events(db_session)} == {OPERATOR.id}


def test_creation_needs_a_name_a_company_and_a_collection_context(db_session: Session) -> None:
    company = add_company(db_session)
    source = ManualSource(CONTEXT)

    with pytest.raises(InvalidFieldError) as no_name:
        create_prospect(db_session, OPERATOR, ProspectForm(" ", None, company.id), source, CLOCK)
    with pytest.raises(InvalidFieldError) as no_company:
        create_prospect(db_session, OPERATOR, ProspectForm("Jean", "Test", None), source, CLOCK)
    with pytest.raises(InvalidFieldError) as unknown_company:
        create_prospect(
            db_session, OPERATOR, ProspectForm("Jean", "Test", uuid.uuid4()), source, CLOCK
        )
    with pytest.raises(InvalidFieldError) as no_context:
        create_prospect(
            db_session, OPERATOR, ProspectForm("Jean", "Test", company.id), ManualSource(" "), CLOCK
        )

    assert refused(no_name) == ("last_name", "blank")
    assert refused(no_company) == ("company_id", "blank")
    assert refused(unknown_company) == ("company_id", "unknown")
    assert refused(no_context) == ("provenance.legal_basis_or_collection_context", "blank")
    assert db_session.scalar(select(func.count()).select_from(Prospect)) == 0


# --- identity, role, employment ----------------------------------------------------------------


def test_identity_edit_writes_one_prospect_event_with_the_changed_fields(
    db_session: Session,
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    view = save(
        db_session,
        prospect,
        civility=Civility.MS,
        first_name="Jeanne",
        exact_job_title="Directrice d’exploitation (synthétique)",
        activity_status=ActivityStatus.INACTIVE,
    )

    assert (view.civility, view.first_name, view.activity_status) == (
        Civility.MS,
        "Jeanne",
        ActivityStatus.INACTIVE,
    )
    [event] = audit_events(db_session)
    assert event.action == "prospect.updated"
    assert set(event.changes) == {"civility", "first_name", "exact_job_title", "activity_status"}
    assert event.changes["first_name"] == {"before": "Jean", "after": "Jeanne"}


def test_saving_an_unchanged_form_writes_nothing(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    add_email(db_session, prospect, "jean@exemple.example", is_primary=True)
    add_phone(db_session, prospect, "+33612345678", is_primary=True, type=PhoneType.MOBILE)

    save(db_session, prospect)

    assert audit_events(db_session) == []


def test_a_role_created_inline_is_audited_and_labelled_on_the_prospect(db_session: Session) -> None:
    old_role = add_role(db_session, "ancien-role", "Ancien rôle")
    prospect = add_prospect(db_session, add_company(db_session), role_id=old_role.id)

    view = save(db_session, prospect, role_id=None, role_label=" Responsable   flux ")

    assert view.role is not None and view.role.label == "Responsable flux"
    created, updated = audit_events(db_session)
    assert (created.action, created.entity_type, created.actor_id) == (
        "role.created",
        "role",
        OPERATOR.id,
    )
    assert updated.action == "prospect.updated"
    assert updated.changes["role_id"]["before_label"] == "Ancien rôle"
    assert updated.changes["role_id"]["after_label"] == "Responsable flux"


def test_a_new_role_matching_an_existing_one_is_refused(db_session: Session) -> None:
    add_role(db_session, "logistique", "Responsable logistique")
    prospect = add_prospect(db_session, add_company(db_session))

    with pytest.raises(DuplicateValueError) as caught:
        save(db_session, prospect, role_label="responsable LOGISTIQUE")

    assert caught.value.field == "role_label"
    assert (
        caught.value.existing is not None
        and caught.value.existing.label == "Responsable logistique"
    )


@pytest.mark.parametrize(
    ("verification", "expected"),
    [
        (EmploymentVerification(VerificationAction.VERIFIED_NOW), NOW),
        (
            EmploymentVerification(VerificationAction.VERIFIED_ON, date(2026, 9, 2)),
            start_of_day(date(2026, 9, 2)),
        ),
        (EmploymentVerification(VerificationAction.VERIFIED_ON, date(2026, 9, 11)), NOW),
        (EmploymentVerification(VerificationAction.CLEAR), None),
        (EmploymentVerification(VerificationAction.KEEP), EARLIER),
    ],
)
def test_employment_verification_is_an_explicit_action(
    db_session: Session, verification: EmploymentVerification, expected: datetime | None
) -> None:
    prospect = add_prospect(db_session, add_company(db_session), employment_verified_at=EARLIER)

    view = save(db_session, prospect, employment_verification=verification)

    assert view.employment_verified_at == expected


def test_a_verification_date_cannot_be_in_the_future_or_missing(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    with pytest.raises(InvalidFieldError) as future:
        save(
            db_session,
            prospect,
            employment_verification=EmploymentVerification(
                VerificationAction.VERIFIED_ON, date(2026, 9, 12)
            ),
        )
    with pytest.raises(InvalidFieldError) as missing:
        save(
            db_session,
            prospect,
            employment_verification=EmploymentVerification(VerificationAction.VERIFIED_ON),
        )

    assert refused(future) == ("employment_verification.day", "future")
    assert refused(missing) == ("employment_verification.day", "blank")


# --- aliases -----------------------------------------------------------------------------------


def test_adding_an_email_and_making_it_primary_switches_without_a_clash(
    db_session: Session,
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    first = add_email(db_session, prospect, "jean@exemple.example", is_primary=True)
    view = get_view(db_session, prospect.id, CLOCK)
    loaded = form_of(view)
    emails = [
        replace(loaded.emails[0], is_primary=False),
        ChannelItem(
            value="Jean.Nouveau@Exemple.example", is_primary=True, source_reference="Signature"
        ),
    ]

    saved = update_prospect(
        db_session, OPERATOR, prospect.id, view.version, replace(loaded, emails=emails), CLOCK
    )

    assert [(email.address, email.is_primary, email.is_active) for email in saved.emails] == [
        ("jean.nouveau@exemple.example", True, True),
        ("jean@exemple.example", False, True),
    ]
    assert saved.emails[0].origin_type is OriginType.MANUAL
    assert saved.emails[0].source_reference == "Signature"
    updated, created = audit_events(db_session)
    assert (updated.action, updated.entity_id) == ("email.updated", first.id)
    assert updated.changes == {"is_primary": {"before": True, "after": False}}
    assert created.action == "email.created"


def test_deactivating_the_primary_hands_it_to_the_first_active_alias(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    add_phone(db_session, prospect, "+33612345678", is_primary=True, type=PhoneType.MOBILE)
    add_phone(db_session, prospect, "+33123456789")
    view = get_view(db_session, prospect.id, CLOCK)
    loaded = form_of(view)
    phones = [replace(loaded.phones[0], is_primary=False, is_active=False), loaded.phones[1]]

    saved = update_prospect(
        db_session, OPERATOR, prospect.id, view.version, replace(loaded, phones=phones), CLOCK
    )

    assert [(phone.number, phone.is_primary, phone.is_active) for phone in saved.phones] == [
        ("+33123456789", True, True),
        ("+33612345678", False, False),
    ]


def test_removing_an_alias_deletes_it_with_its_event(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    add_email(db_session, prospect, "jean@exemple.example", is_primary=True)
    wrong = add_email(db_session, prospect, "erreur@exemple.example")
    view = get_view(db_session, prospect.id, CLOCK)

    saved = update_prospect(
        db_session,
        OPERATOR,
        prospect.id,
        view.version,
        form_of(view, emails=form_of(view).emails[:1]),
        CLOCK,
    )

    assert [email.address for email in saved.emails] == ["jean@exemple.example"]
    [event] = audit_events(db_session)
    assert (event.action, event.entity_id) == ("email.deleted", wrong.id)


@pytest.mark.parametrize(
    ("emails", "field", "reason"),
    [
        (
            [ChannelItem(value="jean@exemple.example"), ChannelItem(value=" JEAN@exemple.example")],
            "emails.1.address",
            "repeated",
        ),
        ([ChannelItem(value="pas-une-adresse")], "emails.0.address", "format"),
        ([ChannelItem(value="  ")], "emails.0.address", "blank"),
        (
            [ChannelItem(value="a@exemple.example", is_primary=True, is_active=False)],
            "emails.0.is_primary",
            "inactive",
        ),
        (
            [
                ChannelItem(value="a@exemple.example", is_primary=True),
                ChannelItem(value="b@exemple.example", is_primary=True),
            ],
            "emails.1.is_primary",
            "multiple",
        ),
        (
            [
                ChannelItem(
                    value="a@exemple.example", verification_status=VerificationStatus.VERIFIED
                )
            ],
            "emails.0.verification_status",
            "verification_action",
        ),
        ([ChannelItem(value="a@exemple.example", id=uuid.uuid4())], "emails.0.id", "unknown"),
    ],
)
def test_invalid_email_lists_are_refused(
    db_session: Session, emails: list[ChannelItem], field: str, reason: str
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    with pytest.raises(InvalidFieldError) as caught:
        save(db_session, prospect, emails=emails)

    assert refused(caught) == (field, reason)


def test_invalid_phones_are_refused(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    with pytest.raises(InvalidFieldError) as number:
        save(db_session, prospect, phones=[ChannelItem(value="06 12", phone_type=PhoneType.MOBILE)])
    with pytest.raises(InvalidFieldError) as kind:
        save(db_session, prospect, phones=[ChannelItem(value="0612345678")])

    assert refused(number) == ("phones.0.number", "format")
    assert refused(kind) == ("phones.0.type", "blank")


def test_one_click_verification_and_status_changes(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    imported = add_email(
        db_session,
        prospect,
        "jean@exemple.example",
        is_primary=True,
        origin_type=OriginType.IMPORTED,
    )
    verified = add_email(
        db_session,
        prospect,
        "ancien@exemple.example",
        verification_status=VerificationStatus.VERIFIED,
        last_verified_at=EARLIER,
    )
    view = get_view(db_session, prospect.id, CLOCK)
    assert [email.imported_unverified for email in view.emails] == [True, False]
    loaded = form_of(view)
    emails = [
        replace(loaded.emails[0], verified_now=True),
        replace(loaded.emails[1], verification_status=VerificationStatus.INVALID),
    ]

    saved = update_prospect(
        db_session, OPERATOR, prospect.id, view.version, replace(loaded, emails=emails), CLOCK
    )

    assert [(e.verification_status, e.last_verified_at) for e in saved.emails] == [
        (VerificationStatus.VERIFIED, NOW),
        (VerificationStatus.INVALID, EARLIER),
    ]
    assert saved.emails[0].origin_type is OriginType.IMPORTED
    assert {event.entity_id for event in audit_events(db_session)} == {imported.id, verified.id}


def test_editing_an_address_makes_it_a_new_unverified_manual_value(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    add_email(
        db_session,
        prospect,
        "jean.dupond@exemple.example",
        is_primary=True,
        origin_type=OriginType.IMPORTED,
        verification_status=VerificationStatus.UNVERIFIED,
        last_verified_at=EARLIER,
    )
    view = get_view(db_session, prospect.id, CLOCK)
    loaded = form_of(view)

    saved = update_prospect(
        db_session,
        OPERATOR,
        prospect.id,
        view.version,
        replace(loaded, emails=[replace(loaded.emails[0], value="jean.dupont@exemple.example")]),
        CLOCK,
    )

    [email] = saved.emails
    assert (email.address, email.origin_type, email.last_verified_at) == (
        "jean.dupont@exemple.example",
        OriginType.MANUAL,
        None,
    )


# --- company change ----------------------------------------------------------------------------


def test_company_change_clears_employment_and_resets_verified_channels(db_session: Session) -> None:
    old, new = (
        add_company(db_session, "Ancien Employeur SARL"),
        add_company(db_session, "Nouvel Employeur SAS"),
    )
    prospect = add_prospect(db_session, old, employment_verified_at=EARLIER)
    verified = {"verification_status": VerificationStatus.VERIFIED, "last_verified_at": EARLIER}
    add_email(db_session, prospect, "jean@ancien.example", is_primary=True, **verified)
    add_phone(
        db_session, prospect, "+33612345678", is_primary=True, type=PhoneType.MOBILE, **verified
    )
    view = get_view(db_session, prospect.id, CLOCK)
    loaded = form_of(view)
    # What the editor sends once it shows the rule's effect: channels back to « non vérifié ».
    emails = [replace(loaded.emails[0], verification_status=VerificationStatus.UNVERIFIED)]
    phones = [replace(loaded.phones[0], verification_status=VerificationStatus.UNVERIFIED)]

    saved = update_prospect(
        db_session,
        OPERATOR,
        prospect.id,
        view.version,
        replace(loaded, company_id=new.id, emails=emails, phones=phones),
        CLOCK,
    )

    assert saved.company is not None and saved.company.display_name == "Nouvel Employeur SAS"
    assert saved.employment_verified_at is None
    assert saved.verification_state is VerificationState.NEVER_VERIFIED
    [email], [phone] = saved.emails, saved.phones
    assert (email.verification_status, email.last_verified_at) == (
        VerificationStatus.UNVERIFIED,
        EARLIER,
    )
    assert (phone.verification_status, phone.last_verified_at) == (
        VerificationStatus.UNVERIFIED,
        EARLIER,
    )
    changed, *channels = audit_events(db_session)
    assert changed.action == "prospect.company_changed"
    assert changed.changes["company_id"]["before_label"] == "Ancien Employeur SARL"
    assert changed.changes["company_id"]["after_label"] == "Nouvel Employeur SAS"
    assert changed.changes["employment_verified_at"]["after"] is None
    assert sorted(event.action for event in channels) == ["email.updated", "phone.updated"]


def test_after_a_company_change_only_an_explicit_action_verifies_again(db_session: Session) -> None:
    old, new = add_company(db_session), add_company(db_session, "Nouvel Employeur SAS")
    prospect = add_prospect(db_session, old, employment_verified_at=EARLIER)
    add_email(
        db_session,
        prospect,
        "jean@ancien.example",
        is_primary=True,
        verification_status=VerificationStatus.VERIFIED,
        last_verified_at=EARLIER,
    )
    view = get_view(db_session, prospect.id, CLOCK)
    loaded = form_of(view, company_id=new.id)

    # A client that keeps « verified » as it was loaded does not undo the company-change rule.
    with pytest.raises(InvalidFieldError) as kept:
        update_prospect(db_session, OPERATOR, prospect.id, view.version, loaded, CLOCK)
    assert refused(kept) == ("emails.0.verification_status", "verification_action")

    saved = update_prospect(
        db_session,
        OPERATOR,
        prospect.id,
        get_view(db_session, prospect.id, CLOCK).version,
        replace(
            loaded,
            employment_verification=EmploymentVerification(VerificationAction.VERIFIED_NOW),
            emails=[replace(loaded.emails[0], verified_now=True)],
        ),
        CLOCK,
    )
    assert saved.employment_verified_at == NOW
    assert (saved.emails[0].verification_status, saved.emails[0].last_verified_at) == (
        VerificationStatus.VERIFIED,
        NOW,
    )


# --- contact tracking --------------------------------------------------------------------------


def test_tracking_records_dates_in_business_time_referent_and_history(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    referent = InternalReferent(first_name="Claire", last_name="Référente")
    db_session.add(referent)
    db_session.flush()

    save(
        db_session,
        prospect,
        tracking=TrackingForm(
            ContactTrackingStatus.TO_CONTACT, planned_contact_on=date(2026, 9, 14)
        ),
    )
    view = save(
        db_session,
        prospect,
        tracking=TrackingForm(
            ContactTrackingStatus.APPOINTMENT_OBTAINED,
            planned_contact_on=date(2026, 9, 14),
            response_received_on=date(2026, 9, 15),
            appointment_on=date(2026, 9, 22),
            appointment_time=time(10, 30),
            referent_id=referent.id,
        ),
    )

    tracking = view.tracking
    assert tracking is not None
    assert (tracking.status, tracking.planned_contact_on, tracking.response_received_on) == (
        ContactTrackingStatus.APPOINTMENT_OBTAINED,
        date(2026, 9, 14),
        date(2026, 9, 15),
    )
    assert (tracking.appointment_on, tracking.appointment_time) == (date(2026, 9, 22), time(10, 30))
    assert tracking.referent is not None and tracking.referent.label == "Claire Référente"
    row = prospect.contact_tracking
    assert row is not None
    assert row.planned_contact_at == start_of_day(date(2026, 9, 14))
    assert row.appointment_at == business_moment(date(2026, 9, 22), time(10, 30))
    transitions = db_session.execute(
        select(ContactTrackingStatusHistory.from_status, ContactTrackingStatusHistory.to_status)
        .where(ContactTrackingStatusHistory.contact_tracking_id == row.id)
        .order_by(ContactTrackingStatusHistory.changed_at)
    ).all()
    assert [tuple(transition) for transition in transitions] == [
        (None, ContactTrackingStatus.TO_CONTACT),
        (ContactTrackingStatus.TO_CONTACT, ContactTrackingStatus.APPOINTMENT_OBTAINED),
    ]
    assert actions(db_session) == ["contact_tracking.created", "contact_tracking.status_changed"]


def test_an_unchanged_day_keeps_the_stored_moment(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    save(
        db_session,
        prospect,
        tracking=TrackingForm(
            ContactTrackingStatus.CONTACTED, planned_contact_on=date(2026, 9, 14)
        ),
    )
    stored = prospect.contact_tracking
    assert stored is not None
    # e.g. set to 15:00 through the Database Explorer: the editor shows its day only.
    stored.planned_contact_at = datetime(2026, 9, 14, 13, 0, tzinfo=UTC)
    db_session.flush()
    before = len(audit_events(db_session))

    save(db_session, prospect)

    assert stored.planned_contact_at == datetime(2026, 9, 14, 13, 0, tzinfo=UTC)
    assert len(audit_events(db_session)) == before


def test_an_appointment_time_needs_its_day_and_referents_must_exist(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    with pytest.raises(InvalidFieldError) as no_day:
        save(
            db_session,
            prospect,
            tracking=TrackingForm(ContactTrackingStatus.CONTACTED, appointment_time=time(9, 0)),
        )
    with pytest.raises(InvalidFieldError) as referent:
        save(
            db_session,
            prospect,
            tracking=TrackingForm(ContactTrackingStatus.CONTACTED, referent_id=uuid.uuid4()),
        )

    assert refused(no_day) == ("tracking.appointment_time", "without_day")
    assert refused(referent) == ("tracking.referent_id", "unknown")


# --- contactability ----------------------------------------------------------------------------


def test_opposition_is_set_and_lifted_only_with_a_reason(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    version = get_view(db_session, prospect.id, CLOCK).version

    with pytest.raises(InvalidFieldError) as blank:
        set_contactability(
            db_session, OPERATOR, prospect.id, version, do_not_contact=True, reason=" ", clock=CLOCK
        )
    assert refused(blank) == ("reason", "blank")

    blocked = set_contactability(
        db_session,
        OPERATOR,
        prospect.id,
        version,
        do_not_contact=True,
        reason="Demande de l’intéressé (synthétique)",
        clock=CLOCK,
    )
    assert blocked.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert blocked.do_not_contact_reason == "Demande de l’intéressé (synthétique)"

    lifted = set_contactability(
        db_session,
        OPERATOR,
        prospect.id,
        blocked.version,
        do_not_contact=False,
        reason="Opposition saisie par erreur (synthétique)",
        clock=CLOCK,
    )
    assert lifted.contactability_status is ContactabilityStatus.CONTACTABLE
    set_event, cleared = audit_events(db_session)
    assert set_event.action == "prospect.do_not_contact.set"
    assert cleared.action == "prospect.do_not_contact.cleared"
    assert cleared.context["reason"] == "Opposition saisie par erreur (synthétique)"


def test_the_save_never_touches_an_opposition(db_session: Session) -> None:
    prospect = add_prospect(
        db_session,
        add_company(db_session),
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=EARLIER,
        do_not_contact_reason="Demande (synthétique)",
    )

    view = save(
        db_session,
        prospect,
        last_name="Renommé",
        tracking=TrackingForm(ContactTrackingStatus.NOT_INTERESTED),
    )

    assert view.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert (view.do_not_contact_at, view.do_not_contact_reason) == (
        EARLIER,
        "Demande (synthétique)",
    )


# --- concurrency and deletion ------------------------------------------------------------------


def test_a_write_on_a_stale_version_is_refused(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = get_view(db_session, prospect.id, CLOCK)
    # Meanwhile, another write path adds an alias (e.g. the Database Explorer).
    add_email(db_session, prospect, "ajout@exemple.example", is_primary=True)

    with pytest.raises(ConflictError):
        update_prospect(db_session, OPERATOR, prospect.id, view.version, form_of(view), CLOCK)
    with pytest.raises(ConflictError):
        set_contactability(
            db_session,
            OPERATOR,
            prospect.id,
            view.version,
            do_not_contact=True,
            reason="x",
            clock=CLOCK,
        )
    with pytest.raises(ConflictError):
        delete_prospect(db_session, OPERATOR, prospect.id, view.version)
    assert get_view(db_session, prospect.id, CLOCK).version != view.version


def test_deleting_takes_the_person_s_records_and_leaves_one_event(db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    add_email(db_session, prospect, "jean@exemple.example", is_primary=True)
    provenance.add_manual_source(
        db_session, OPERATOR, prospect.id, legal_basis_or_collection_context=CONTEXT
    )
    save(db_session, prospect, tracking=TrackingForm(ContactTrackingStatus.CONTACTED))
    events_before = len(audit_events(db_session))
    version = get_view(db_session, prospect.id, CLOCK).version
    prospect_id = prospect.id
    db_session.expunge_all()

    delete_prospect(db_session, OPERATOR, prospect_id, version)

    assert db_session.get(Prospect, prospect_id) is None
    assert db_session.scalar(select(func.count()).select_from(Email)) == 0
    assert db_session.scalar(select(func.count()).select_from(ProspectSource)) == 0
    [deleted] = audit_events(db_session)[events_before:]
    assert (deleted.action, deleted.entity_id) == ("prospect.deleted", prospect_id)
    with pytest.raises(NotFoundError):
        get_view(db_session, prospect_id, CLOCK)


def test_an_opposed_prospect_cannot_be_deleted(db_session: Session) -> None:
    prospect = add_prospect(
        db_session,
        add_company(db_session),
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=EARLIER,
    )
    version = get_view(db_session, prospect.id, CLOCK).version

    with pytest.raises(DoNotContactError):
        delete_prospect(db_session, OPERATOR, prospect.id, version)

    assert db_session.get(Prospect, prospect.id) is not None


# --- view model --------------------------------------------------------------------------------


def test_the_view_flags_imported_values_that_were_never_verified(db_session: Session) -> None:
    company = add_company(db_session, email_domain="exemple.example")
    prospect = add_prospect(db_session, company, role_id=add_role(db_session).id)
    add_phone(
        db_session, prospect, "+33612345678", origin_type=OriginType.IMPORTED, is_primary=True
    )
    batch = import_batches.start_batch(
        db_session, OPERATOR, filename="base-exemple.xlsx", sheet_names=["Prospects"]
    )
    with import_batches.importing(db_session, batch, confirmed_by=OPERATOR) as importer:
        provenance.add_import_source(
            db_session, importer, prospect.id, batch, sheet="Prospects", row_number=7
        )
        import_batches.record_row(
            db_session,
            batch,
            sheet="Prospects",
            row_number=7,
            prospect_id=prospect.id,
            legacy_metadata={},
        )

    view = get_view(db_session, prospect.id, EditorClock(now=NOW, stale_days=30))

    assert view.employment_imported_unverified is True
    assert view.verification_state is VerificationState.NEVER_VERIFIED
    assert view.phones[0].imported_unverified is True
    [source] = view.sources
    assert (source.import_filename, source.source_reference) == (
        "base-exemple.xlsx",
        "base-exemple.xlsx / Prospects / ligne 7",
    )
    assert view.import_row_count == 1
    assert view.company is not None and view.company.email_domain == "exemple.example"
    assert (view.today, view.stale_threshold_days) == (date(2026, 9, 11), 30)
    assert db_session.get(Role, view.role.id if view.role else None) is not None
