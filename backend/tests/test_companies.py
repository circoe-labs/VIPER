"""CompanyService (Task 07): normalization, identifiers, taxonomies, establishments, deletion,
search, similar companies and audit. Every company, number and address here is invented."""

import uuid
from dataclasses import replace

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import ActivityCategory, CommercialSegment, Company, Establishment
from app.services import companies
from app.services.companies import CompanyInput, EstablishmentInput
from app.services.errors import DuplicateValueError, InUseError, InvalidFieldError
from app.services.imports.models import MatchReason
from tests.builders import (
    BAD_SIRET,
    OPERATOR,
    OTHER_SIREN,
    SIREN,
    SIRET,
    SIRET_2,
    add_company,
    add_prospect,
    add_role,
    audit_events,
    bind_operator,
)

NBSP = chr(0xA0)


def taxonomy[T: (CommercialSegment, ActivityCategory)](
    session: Session, model: type[T], label: str
) -> T:
    row = model(label=label, slug=label.lower().replace(" ", "-"))
    session.add(row)
    session.flush()
    return row


def site(name: str, **fields: object) -> EstablishmentInput:
    return EstablishmentInput(name=name, **fields)  # type: ignore[arg-type]


def create(session: Session, name: str = "Transports Exemple SARL", **fields: object) -> uuid.UUID:
    data = CompanyInput(display_name=name, **fields)  # type: ignore[arg-type]
    return companies.create_company(session, OPERATOR, data).id


def as_input(detail: companies.CompanyDetail, **changes: object) -> CompanyInput:
    """The editor's view of a saved company, with `changes` applied."""
    data = CompanyInput(
        display_name=detail.display_name,
        legal_name=detail.legal_name,
        siren=detail.siren,
        website_url=detail.website_url,
        email_domain=detail.email_domain,
        size_label=detail.size_label,
        commercial_segment_id=detail.commercial_segment.id if detail.commercial_segment else None,
        activity_category_ids=[ref.id for ref in detail.activity_categories],
        establishments=[
            EstablishmentInput(
                id=row.id,
                name=row.name,
                siret=row.siret,
                address_line1=row.address_line1,
                city=row.city,
                kind=row.kind,
                is_primary=row.is_primary,
            )
            for row in detail.establishments
        ],
    )
    return replace(data, **changes)  # type: ignore[arg-type]


# --- identifiers and web values ---------------------------------------------------------------


def test_luhn_and_the_la_poste_siret_rule() -> None:
    assert SIREN == "123456782"
    assert companies.luhn_valid(SIREN)
    assert not companies.luhn_valid("123456789")
    # La Poste's establishments: digit sum multiple of 5, whatever the Luhn key says.
    assert companies.siret_key_valid("35600000000010")
    assert not companies.luhn_valid("35600000000010")
    assert not companies.siret_key_valid("35600000000011")


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        (" 123 456 782 ", "123456782"),
        (f"123{NBSP}456{NBSP}782", "123456782"),
        ("", None),
        (None, None),
    ],
)
def test_siren_ignores_spaces(raw: str | None, stored: str | None) -> None:
    assert companies.normalize_siren(raw) == stored


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        ("12345678", "format"),
        ("1234567822", "format"),
        ("12345678A", "format"),
        ("123456789", "checksum"),
    ],
)
def test_malformed_siren_is_refused(raw: str, reason: str) -> None:
    with pytest.raises(InvalidFieldError) as caught:
        companies.normalize_siren(raw)
    assert (caught.value.field, caught.value.reason) == ("siren", reason)


def test_an_unchanged_stored_identifier_is_not_rechecked() -> None:
    assert companies.normalize_siren("123456789", current="123456789") == "123456789"
    with pytest.raises(InvalidFieldError):
        companies.normalize_siren("123456789", current="987654321")
    assert companies.normalize_siret("s", "00000000000001", current="00000000000001")


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        ("exemple.fr", "https://exemple.fr"),
        ("  Exemple.FR/Contact ", "https://exemple.fr/Contact"),
        ("HTTP://www.Exemple.fr/", "http://www.exemple.fr"),
        ("https://exemple.fr:8443/a?b=c", "https://exemple.fr:8443/a?b=c"),
        ("", None),
    ],
)
def test_website_is_normalized(raw: str, stored: str | None) -> None:
    assert companies.normalize_website(raw) == stored


@pytest.mark.parametrize(
    "raw",
    [
        "exemple",
        "ftp://exemple.fr",
        "https://jean@exemple.fr",
        "exe mple.fr",
        "https://exemple.fr:99999",
    ],
)
def test_invalid_website_is_refused(raw: str) -> None:
    with pytest.raises(InvalidFieldError) as caught:
        companies.normalize_website(raw)
    assert (caught.value.field, caught.value.reason) == ("website_url", "format")


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        ("Exemple.FR", "exemple.fr"),
        ("@exemple.fr", "exemple.fr"),
        ("jean.test@Exemple.fr", "exemple.fr"),
        ("https://www.exemple.fr/contact", "exemple.fr"),
        ("mail.exemple.co.uk.", "mail.exemple.co.uk"),
        ("  ", None),
    ],
)
def test_email_domain_is_normalized(raw: str, stored: str | None) -> None:
    assert companies.normalize_email_domain(raw) == stored


@pytest.mark.parametrize(
    ("raw", "reason"), [("exemple", "format"), ("a b.fr", "format"), ("Gmail.com", "webmail")]
)
def test_invalid_or_webmail_domain_is_refused(raw: str, reason: str) -> None:
    with pytest.raises(InvalidFieldError) as caught:
        companies.normalize_email_domain(raw)
    assert (caught.value.field, caught.value.reason) == ("email_domain", reason)


# --- create / update ---------------------------------------------------------------------------


def test_create_normalizes_and_audits_the_company(db_session: Session) -> None:
    bind_operator(db_session)
    segment = taxonomy(db_session, CommercialSegment, "Transporteur")
    road = taxonomy(db_session, ActivityCategory, "Route")

    company_id = create(
        db_session,
        "  Transports   Exemple  SARL ",
        legal_name=" ",
        siren="123 456 782",
        website_url="Exemple.fr",
        email_domain="@EXEMPLE.fr",
        size_label=" 10-49 ",
        commercial_segment_id=segment.id,
        activity_category_ids=[road.id, road.id],
        client_approach="  Approche fictive\nsur deux lignes  ",
    )

    detail = companies.get_company(db_session, company_id)
    assert (detail.display_name, detail.legal_name, detail.siren) == (
        "Transports Exemple SARL",
        None,
        "123456782",
    )
    assert (detail.website_url, detail.email_domain, detail.size_label) == (
        "https://exemple.fr",
        "exemple.fr",
        "10-49",
    )
    assert detail.client_approach == "Approche fictive\nsur deux lignes"
    assert detail.commercial_segment == companies.TaxonomyRef(segment.id, "Transporteur", True)
    assert [ref.id for ref in detail.activity_categories] == [road.id]
    assert (detail.establishments, detail.prospect_count, detail.prospects) == ([], 0, [])

    [event] = audit_events(db_session, entity_type="company")
    assert (event.action, event.actor_type, event.actor_id) == (
        "company.created",
        ActorType.HUMAN,
        OPERATOR.id,
    )
    assert event.changes["activity_categories_ids"] == {"before": None, "after": [str(road.id)]}
    assert event.changes["commercial_segment_id"]["after_label"] == "Transporteur"


def test_display_name_is_required(db_session: Session) -> None:
    with pytest.raises(InvalidFieldError) as caught:
        create(db_session, "   ")
    assert (caught.value.field, caught.value.reason) == ("display_name", "blank")


def test_one_segment_and_several_categories_are_replaced_on_update(db_session: Session) -> None:
    bind_operator(db_session)
    carrier = taxonomy(db_session, CommercialSegment, "Transporteur")
    shipper = taxonomy(db_session, CommercialSegment, "Chargeur")
    road, storage, express = (
        taxonomy(db_session, ActivityCategory, label) for label in ("Route", "Stockage", "Express")
    )
    company_id = create(
        db_session, commercial_segment_id=carrier.id, activity_category_ids=[road.id, storage.id]
    )
    detail = companies.get_company(db_session, company_id)

    updated = companies.update_company(
        db_session,
        OPERATOR,
        company_id,
        as_input(
            detail, commercial_segment_id=shipper.id, activity_category_ids=[storage.id, express.id]
        ),
    )

    assert updated.commercial_segment is not None and updated.commercial_segment.id == shipper.id
    assert [ref.label for ref in updated.activity_categories] == ["Express", "Stockage"]
    [event] = audit_events(db_session, action="company.updated")
    assert event.changes["commercial_segment_id"] | {"before": None, "after": None} == {
        "before": None,
        "after": None,
        "before_label": "Transporteur",
        "after_label": "Chargeur",
    }
    assert event.changes["activity_categories_ids"]["after"] == sorted(
        [str(storage.id), str(express.id)]
    )


def test_unknown_segment_or_category_is_refused(db_session: Session) -> None:
    with pytest.raises(InvalidFieldError) as caught:
        create(db_session, commercial_segment_id=uuid.uuid4())
    assert (caught.value.field, caught.value.reason) == ("commercial_segment_id", "unknown")
    with pytest.raises(InvalidFieldError) as caught:
        create(db_session, activity_category_ids=[uuid.uuid4()])
    assert caught.value.field == "activity_category_ids"


def test_an_update_without_change_writes_no_event(db_session: Session) -> None:
    bind_operator(db_session)
    company_id = create(db_session, establishments=[site("Siège", siret=SIRET)])
    detail = companies.get_company(db_session, company_id)
    before = len(audit_events(db_session))

    companies.update_company(db_session, OPERATOR, company_id, as_input(detail))

    assert len(audit_events(db_session)) == before


def test_imported_identifiers_failing_their_key_do_not_block_other_edits(
    db_session: Session,
) -> None:
    company = add_company(db_session, siren="000000001")
    db_session.add(Establishment(company_id=company.id, siret="00000000000001", is_primary=True))
    db_session.flush()
    detail = companies.get_company(db_session, company.id)

    updated = companies.update_company(
        db_session, OPERATOR, company.id, as_input(detail, size_label="50-249")
    )

    assert (updated.size_label, updated.siren, updated.establishments[0].siret) == (
        "50-249",
        "000000001",
        "00000000000001",
    )
    with pytest.raises(InvalidFieldError) as caught:
        companies.update_company(
            db_session, OPERATOR, company.id, as_input(detail, siren="000000002")
        )
    assert caught.value.reason == "checksum"


# --- uniqueness -------------------------------------------------------------------------------


def test_a_siren_held_by_another_company_is_a_duplicate_naming_it(db_session: Session) -> None:
    add_company(db_session, "Logistique Témoin SAS", siren=SIREN)

    with pytest.raises(DuplicateValueError) as caught:
        create(db_session, siren=SIREN)

    assert caught.value.field == "siren"
    assert caught.value.existing is not None
    assert caught.value.existing.label == "Logistique Témoin SAS"


def test_a_siret_held_by_another_company_is_a_duplicate_naming_it(db_session: Session) -> None:
    other = add_company(db_session, "Logistique Témoin SAS")
    db_session.add(Establishment(company_id=other.id, siret=SIRET_2, is_primary=True))
    db_session.flush()

    with pytest.raises(DuplicateValueError) as caught:
        create(
            db_session, establishments=[site("Siège", siret=SIRET), site("Dépôt", siret=SIRET_2)]
        )

    assert caught.value.field == "establishments.1.siret"
    assert caught.value.existing is not None
    assert (caught.value.existing.id, caught.value.existing.label) == (
        other.id,
        "Logistique Témoin SAS",
    )


def test_a_siren_race_past_the_pre_check_is_translated(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_company(db_session, "Logistique Témoin SAS", siren=SIREN)
    monkeypatch.setattr(companies, "_refuse_taken_identifiers", lambda *_: None)

    with pytest.raises(DuplicateValueError) as caught:
        create(db_session, siren=SIREN)

    assert (
        caught.value.existing is not None and caught.value.existing.label == "Logistique Témoin SAS"
    )
    assert db_session.scalars(select(Company)).one().display_name == "Logistique Témoin SAS"


# --- establishments ---------------------------------------------------------------------------


def test_establishments_are_created_with_one_primary(db_session: Session) -> None:
    bind_operator(db_session)
    company_id = create(
        db_session,
        siren=SIREN,
        establishments=[
            site("Dépôt Nord", siret="  " + SIRET_2, city="Lille", kind="entrepôt"),
            site("Siège", siret=SIRET, city="Paris", kind="siège"),
        ],
    )

    detail = companies.get_company(db_session, company_id)
    # None was flagged primary: the first one is.
    assert [(row.name, row.is_primary, row.siret) for row in detail.establishments] == [
        ("Dépôt Nord", True, SIRET_2),
        ("Siège", False, SIRET),
    ]
    events = audit_events(db_session, entity_type="establishment")
    assert [event.action for event in events] == ["establishment.created"] * 2
    assert {(event.subject_type, event.subject_id) for event in events} == {("company", company_id)}


def test_establishments_are_edited_added_removed_and_the_primary_switched(
    db_session: Session,
) -> None:
    bind_operator(db_session)
    company_id = create(
        db_session,
        establishments=[site("Siège", siret=SIRET, is_primary=True), site("Agence", siret=SIRET_2)],
    )
    head, agency = companies.get_company(db_session, company_id).establishments
    before = {event.id for event in audit_events(db_session)}

    updated = companies.update_company(
        db_session,
        OPERATOR,
        company_id,
        CompanyInput(
            display_name="Transports Exemple SARL",
            establishments=[
                # The agency becomes primary and moves; the head office is removed; its SIRET goes
                # to a new establishment in the same save.
                EstablishmentInput(
                    id=agency.id, name="Agence", siret=SIRET_2, city="Lyon", is_primary=True
                ),
                EstablishmentInput(name="Nouveau siège", siret=SIRET),
            ],
        ),
    )

    assert [(row.name, row.is_primary, row.city, row.siret) for row in updated.establishments] == [
        ("Agence", True, "Lyon", SIRET_2),
        ("Nouveau siège", False, None, SIRET),
    ]
    assert head.id not in {row.id for row in updated.establishments}
    events = {event.action: event for event in audit_events(db_session) if event.id not in before}
    assert sorted(events) == [
        "establishment.created",
        "establishment.deleted",
        "establishment.updated",
    ]
    assert events["establishment.deleted"].entity_id == head.id
    agency_event = events["establishment.updated"]
    assert agency_event.entity_id == agency.id
    assert agency_event.changes == {
        "city": {"before": None, "after": "Lyon"},
        "is_primary": {"before": False, "after": True},
    }


def test_switching_the_primary_between_kept_establishments(db_session: Session) -> None:
    bind_operator(db_session)
    company_id = create(db_session, establishments=[site("A", is_primary=True), site("B")])
    a, b = companies.get_company(db_session, company_id).establishments
    before = {event.id for event in audit_events(db_session)}

    updated = companies.update_company(
        db_session,
        OPERATOR,
        company_id,
        CompanyInput(
            display_name="Transports Exemple SARL",
            establishments=[
                EstablishmentInput(id=a.id, name="A"),
                EstablishmentInput(id=b.id, name="B", is_primary=True),
            ],
        ),
    )

    assert [(row.name, row.is_primary) for row in updated.establishments] == [
        ("B", True),
        ("A", False),
    ]
    events = [event for event in audit_events(db_session) if event.id not in before]
    # One event per establishment even though the change is written in two steps.
    assert sorted(
        (str(event.entity_id), event.changes["is_primary"]["after"]) for event in events
    ) == sorted([(str(a.id), False), (str(b.id), True)])


def test_removing_the_primary_promotes_the_first_remaining(db_session: Session) -> None:
    company_id = create(
        db_session, establishments=[site("A", is_primary=True), site("B"), site("C")]
    )
    _, b, c = companies.get_company(db_session, company_id).establishments

    updated = companies.update_company(
        db_session,
        OPERATOR,
        company_id,
        CompanyInput(
            display_name="Transports Exemple SARL",
            establishments=[
                EstablishmentInput(id=c.id, name="C"),
                EstablishmentInput(id=b.id, name="B"),
            ],
        ),
    )

    assert [(row.name, row.is_primary) for row in updated.establishments] == [
        ("C", True),
        ("B", False),
    ]


@pytest.mark.parametrize(
    ("establishments", "field", "reason"),
    [
        (
            [site("A", is_primary=True), site("B", is_primary=True)],
            "establishments.1.is_primary",
            "multiple",
        ),
        ([site("A", siret=SIRET), site("B", siret=SIRET)], "establishments.1.siret", "repeated"),
        ([site("A", siret="1234")], "establishments.0.siret", "format"),
        ([site("A", siret=BAD_SIRET)], "establishments.0.siret", "checksum"),
        ([EstablishmentInput(id=uuid.uuid4(), name="A")], "establishments.0.id", "unknown"),
        ([site("A" * 256)], "establishments.0.name", "length"),
    ],
)
def test_invalid_establishment_lists_are_refused(
    db_session: Session, establishments: list[EstablishmentInput], field: str, reason: str
) -> None:
    with pytest.raises(InvalidFieldError) as caught:
        create(db_session, establishments=establishments)
    assert (caught.value.field, caught.value.reason) == (field, reason)


def test_an_establishment_of_another_company_cannot_be_edited_through_this_one(
    db_session: Session,
) -> None:
    other_id = create(db_session, "Logistique Témoin SAS", establishments=[site("Siège")])
    [foreign] = companies.get_company(db_session, other_id).establishments
    company_id = create(db_session)

    with pytest.raises(InvalidFieldError) as caught:
        companies.update_company(
            db_session,
            OPERATOR,
            company_id,
            CompanyInput(
                display_name="Transports Exemple SARL",
                establishments=[EstablishmentInput(id=foreign.id)],
            ),
        )
    assert caught.value.field == "establishments.0.id"


# --- deletion -------------------------------------------------------------------------------


def test_a_company_with_prospects_cannot_be_deleted(db_session: Session) -> None:
    company = add_company(db_session)
    add_prospect(db_session, company)
    add_prospect(db_session, company, first_name="Marie")

    with pytest.raises(InUseError) as caught:
        companies.delete_company(db_session, OPERATOR, company.id)

    assert caught.value.usage == {"prospects": 2}
    assert db_session.get(Company, company.id) is not None


def test_deleting_a_company_deletes_and_audits_its_establishments(db_session: Session) -> None:
    bind_operator(db_session)
    company_id = create(
        db_session, siren=SIREN, establishments=[site("Siège", siret=SIRET), site("Dépôt")]
    )

    companies.delete_company(db_session, OPERATOR, company_id)

    assert db_session.scalars(select(Establishment)).all() == []
    events = audit_events(db_session, action="company.deleted") + audit_events(
        db_session, action="establishment.deleted"
    )
    assert [event.action for event in events] == ["company.deleted"] + ["establishment.deleted"] * 2
    assert events[0].changes["siren"] == {"before": SIREN, "after": None}
    assert {event.subject_id for event in events} == {company_id}


# --- reads ------------------------------------------------------------------------------------


def test_detail_lists_the_prospects_with_their_role(db_session: Session) -> None:
    company = add_company(db_session)
    role = add_role(db_session, label="Responsable logistique")
    add_prospect(db_session, company, first_name="Zoé", last_name="Exemple", role_id=role.id)
    add_prospect(
        db_session, company, first_name="Jean", last_name="Anonyme", exact_job_title="Gérant"
    )
    add_prospect(db_session, add_company(db_session, "Autre SAS"))

    detail = companies.get_company(db_session, company.id)

    assert detail.prospect_count == 2
    assert [(p.last_name, p.role_label, p.exact_job_title) for p in detail.prospects] == [
        ("Anonyme", None, "Gérant"),
        ("Exemple", "Responsable logistique", None),
    ]


def test_search_by_name_legal_name_domain_siren_and_siret(db_session: Session) -> None:
    segment = taxonomy(db_session, CommercialSegment, "Transporteur")
    first = add_company(
        db_session,
        "Entrepôts Démo",
        legal_name="Société Fictive des Entrepôts",
        siren=SIREN,
        email_domain="entrepots-demo.example.com",
        commercial_segment_id=segment.id,
    )
    db_session.add(Establishment(company_id=first.id, siret=SIRET, city="Rouen", is_primary=True))
    db_session.add(Establishment(company_id=first.id, city="Caen"))
    second = add_company(db_session, "Transports Témoin", siren=OTHER_SIREN)
    add_prospect(db_session, first)
    db_session.flush()

    def names(search: str) -> list[str]:
        return [
            item.display_name for item in companies.list_companies(db_session, search=search).items
        ]

    assert names("") == ["Entrepôts Démo", "Transports Témoin"]
    assert names("ENTREPOTS demo") == ["Entrepôts Démo"]
    assert names("fictive") == ["Entrepôts Démo"]
    assert names("entrepots-demo.example") == ["Entrepôts Démo"]
    assert names(SIREN[:3] + " " + SIREN[3:6]) == ["Entrepôts Démo"]
    assert names(SIRET[-5:]) == ["Entrepôts Démo"]
    assert names(OTHER_SIREN) == ["Transports Témoin"]
    assert names("introuvable") == []

    page = companies.list_companies(db_session, limit=1, offset=0)
    assert page.total == 2 and len(page.items) == 1
    [item] = page.items
    assert (
        item.id,
        item.city,
        item.commercial_segment_label,
        item.establishment_count,
        item.prospect_count,
    ) == (
        first.id,
        "Rouen",
        "Transporteur",
        2,
        1,
    )
    assert companies.list_companies(db_session, limit=1, offset=1).items[0].id == second.id


def test_similar_companies_ignore_legal_forms_and_match_the_domain(db_session: Session) -> None:
    same = add_company(db_session, "TRANSPORTS EXEMPLE S.A.R.L.")
    close = add_company(db_session, "Transport Exemples")
    domain = add_company(db_session, "Groupe Témoin", email_domain="exemple.fr")
    add_company(db_session, "Logistique Sans Rapport")

    found = companies.find_similar(
        db_session, name="Transports Exemple SAS", email_domain="@Exemple.fr"
    )

    assert [(item.id, item.reasons) for item in found] == [
        (same.id, [MatchReason.SAME_COMPANY_NAME]),
        (close.id, [MatchReason.SIMILAR_COMPANY_NAME]),
        (domain.id, [MatchReason.SAME_EMAIL_DOMAIN]),
    ]
    assert (
        companies.find_similar(db_session, name="Transports Exemple", exclude_id=same.id)[0].id
        == close.id
    )
    assert companies.find_similar(db_session, name=" ", email_domain="pas un domaine") == []
