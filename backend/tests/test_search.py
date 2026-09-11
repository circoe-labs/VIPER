"""Global search (Task 17): matching, ranking, limits and safety of `services.search`, against the
real test database. Every person and company here is invented. Definitions:
doc/features/global-search.md.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from app.models import Establishment
from app.models.enums import ActivityStatus, ContactabilityStatus
from app.services.errors import InvalidFieldError
from app.services.search import (
    GROUP_LIMIT,
    Badge,
    CompanyHit,
    EstablishmentHit,
    MatchField,
    MatchKind,
    ProspectHit,
    SearchHit,
    SearchResults,
    SearchType,
    search,
)
from tests.builders import (
    OTHER_SIREN,
    SIREN,
    SIRET,
    SIRET_2,
    add_company,
    add_email,
    add_phone,
    add_prospect,
    add_role,
    statements,
)

EXACT, PREFIX, CONTAINS = MatchKind.EXACT, MatchKind.PREFIX, MatchKind.CONTAINS


def hits(results: SearchResults, kind: SearchType) -> list[SearchHit]:
    return next((group.items for group in results.groups if group.type == kind), [])


def labels(session: Session, query: str, kind: SearchType = SearchType.PROSPECT) -> list[str]:
    return [hit.label for hit in hits(search(session, query), kind)]


def matches(
    session: Session, query: str, kind: SearchType
) -> list[tuple[str, MatchField, MatchKind]]:
    return [
        (hit.label, hit.match.field, hit.match.kind) for hit in hits(search(session, query), kind)
    ]


def add_establishment(session: Session, company_id: object, **fields: object) -> Establishment:
    establishment = Establishment(company_id=company_id, **fields)
    session.add(establishment)
    session.flush()
    return establishment


# --- prospects ---------------------------------------------------------------------------------


def test_prospects_by_name_ignore_case_accents_and_word_order(db_session: Session) -> None:
    add_prospect(db_session, first_name="Élodie", last_name="Ducasse-Témoin")
    add_prospect(db_session, first_name="Paul", last_name="Exemple")

    for query in ("elodie", "ÉLODIE", "Élo", "témoin elodie", "ducasse", "DUCASSE-TEMOIN"):
        assert labels(db_session, query) == ["Élodie Ducasse-Témoin"], query
    assert labels(db_session, "elodie paul") == []


def test_short_words_match_a_word_start_longer_ones_anywhere(db_session: Session) -> None:
    add_prospect(db_session, first_name="Martine", last_name="Témoin")
    add_prospect(db_session, first_name="Thomas", last_name="Témoin")
    add_prospect(db_session, first_name="Jean", last_name="Saint-Mars")
    add_prospect(db_session, first_name="Jeanne", last_name="D'Artois")

    assert labels(db_session, "ma") == ["Jean Saint-Mars", "Martine Témoin"]
    assert labels(db_session, "ar") == ["Jeanne D'Artois"]
    assert labels(db_session, "mas") == ["Thomas Témoin"]
    assert labels(db_session, "tine") == ["Martine Témoin"]


def test_prospect_ranking_exact_then_word_starts_then_anywhere(db_session: Session) -> None:
    add_prospect(db_session, first_name="Jean", last_name="Lamartine")
    add_prospect(db_session, first_name="Jean", last_name="Martinez")
    add_prospect(db_session, first_name="Jean", last_name="Martin")

    assert matches(db_session, "martin jean", SearchType.PROSPECT) == [
        ("Jean Martin", MatchField.NAME, EXACT),
        ("Jean Martinez", MatchField.NAME, PREFIX),
        ("Jean Lamartine", MatchField.NAME, CONTAINS),
    ]


def test_prospects_by_any_email_address(db_session: Session) -> None:
    person = add_prospect(db_session, first_name="Claire", last_name="Témoin")
    add_email(db_session, person, "claire.temoin@exemple-fret.example", is_primary=True)
    add_email(db_session, person, "ancienne.adresse@webmail.example", is_active=False)

    assert matches(db_session, "Claire.Temoin@exemple-fret.example", SearchType.PROSPECT) == [
        ("Claire Témoin", MatchField.EMAIL, EXACT)
    ]
    # A former (inactive) address still finds the person.
    [hit] = hits(search(db_session, "ancienne.adresse"), SearchType.PROSPECT)
    assert (hit.match.field, hit.match.kind, hit.match.value) == (
        MatchField.EMAIL,
        PREFIX,
        "ancienne.adresse@webmail.example",
    )
    [hit] = hits(search(db_session, "FRET.EXAMPLE"), SearchType.PROSPECT)
    assert (hit.match.field, hit.match.kind) == (MatchField.EMAIL, CONTAINS)


def test_prospects_by_phone_digits_in_any_format(db_session: Session) -> None:
    person = add_prospect(db_session, first_name="Hugo", last_name="Témoin")
    add_phone(db_session, person, "+33612345678", is_primary=True)

    for query, kind in [
        ("06 12 34 56 78", EXACT),
        ("+33 6 12 34 56 78", EXACT),
        ("06.12.34", PREFIX),
        ("56 78", CONTAINS),
    ]:
        [hit] = hits(search(db_session, query), SearchType.PROSPECT)
        assert (hit.match.field, hit.match.kind, hit.match.value) == (
            MatchField.PHONE,
            kind,
            "+33612345678",
        ), query
    # Three digits are too few for a phone number.
    assert labels(db_session, "678") == []


def test_prospect_hits_carry_context_badges_and_targets(db_session: Session) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    role = add_role(db_session, "directeur-test", "Directeur test")
    blocked = add_prospect(
        db_session,
        company,
        first_name="Nina",
        last_name="Opposée",
        role_id=role.id,
        exact_job_title="Responsable exploitation",
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    add_prospect(
        db_session,
        first_name="Nina",
        last_name="Partie",
        role_id=role.id,
        exact_job_title="DIRECTEUR TEST",
        activity_status=ActivityStatus.INACTIVE,
    )

    found = hits(search(db_session, "nina"), SearchType.PROSPECT)

    assert [(hit.label, hit.badges) for hit in found] == [
        ("Nina Opposée", [Badge.DO_NOT_CONTACT]),
        ("Nina Partie", [Badge.INACTIVE]),
    ]
    first = found[0]
    assert isinstance(first, ProspectHit)
    assert [hit.sublabel for hit in found] == [
        "Directeur test · Responsable exploitation",
        "Directeur test",  # a title repeating the role is shown once
    ]
    assert (first.company_id, first.company_name) == (company.id, "Transports Exemple SARL")
    assert (first.target.editor, first.target.editor_id) == ("prospect", blocked.id)
    assert (first.target.table, first.target.record_id) == ("prospects", blocked.id)


# --- companies and establishments --------------------------------------------------------------


def test_companies_by_name_legal_name_ranked(db_session: Session) -> None:
    add_company(db_session, "Aérofret Témoin")
    add_company(db_session, "Fret Express Témoin")
    add_company(db_session, "Fret")
    add_company(db_session, "Logistique Témoin", legal_name="Société Fret Témoin SAS")

    assert matches(db_session, "fret", SearchType.COMPANY) == [
        ("Fret", MatchField.NAME, EXACT),
        ("Fret Express Témoin", MatchField.NAME, PREFIX),
        ("Logistique Témoin", MatchField.LEGAL_NAME, PREFIX),
        ("Aérofret Témoin", MatchField.NAME, CONTAINS),
    ]
    [legal] = hits(search(db_session, "societe fret"), SearchType.COMPANY)
    assert isinstance(legal, CompanyHit)
    assert (legal.sublabel, legal.match.value) == (
        "Société Fret Témoin SAS",
        "Société Fret Témoin SAS",
    )


def test_companies_by_siren_digits_and_by_the_siren_of_a_siret(db_session: Session) -> None:
    add_company(db_session, "Transports Siren Témoin", siren=SIREN)
    add_company(db_session, "Autre Témoin", siren=OTHER_SIREN)

    spaced = f"{SIREN[:3]} {SIREN[3:6]} {SIREN[6:]}"
    assert matches(db_session, spaced, SearchType.COMPANY) == [
        ("Transports Siren Témoin", MatchField.SIREN, EXACT)
    ]
    assert matches(db_session, SIREN[:4], SearchType.COMPANY) == [
        ("Transports Siren Témoin", MatchField.SIREN, PREFIX)
    ]
    assert matches(db_session, SIREN[2:7], SearchType.COMPANY) == [
        ("Transports Siren Témoin", MatchField.SIREN, CONTAINS)
    ]
    assert matches(db_session, SIRET, SearchType.COMPANY) == [
        ("Transports Siren Témoin", MatchField.SIREN, PREFIX)
    ]


def test_companies_by_email_domain_and_website(db_session: Session) -> None:
    add_company(db_session, "Domaine Témoin", email_domain="exemple-fret.example")
    add_company(db_session, "Site Témoin", website_url="https://www.site-temoin.example/contact")

    assert matches(db_session, "exemple-fret.example", SearchType.COMPANY) == [
        ("Domaine Témoin", MatchField.EMAIL_DOMAIN, EXACT)
    ]
    # An e-mail address finds its company through the domain.
    assert matches(db_session, "paul@exemple-fret.example", SearchType.COMPANY) == [
        ("Domaine Témoin", MatchField.EMAIL_DOMAIN, EXACT)
    ]
    [site] = hits(search(db_session, "https://site-temoin.example"), SearchType.COMPANY)
    assert (site.match.field, site.match.kind, site.match.value) == (
        MatchField.WEBSITE,
        EXACT,
        "https://www.site-temoin.example/contact",
    )
    assert matches(db_session, "temoin.exa", SearchType.COMPANY) == [
        ("Site Témoin", MatchField.WEBSITE, CONTAINS)
    ]


def test_company_hits_carry_city_and_prospect_count(db_session: Session) -> None:
    company = add_company(db_session, "Entrepôts Témoin", siren=SIREN, email_domain="ent.example")
    add_establishment(db_session, company.id, city="Évreux", is_primary=True)
    add_establishment(db_session, company.id, city="Lyon")
    add_prospect(db_session, company)
    add_prospect(db_session, company, first_name="Luc")

    [hit] = hits(search(db_session, "entrepots"), SearchType.COMPANY)

    assert isinstance(hit, CompanyHit)
    assert (hit.siren, hit.email_domain, hit.city, hit.prospect_count) == (
        SIREN,
        "ent.example",
        "Évreux",
        2,
    )
    assert (hit.target.editor, hit.target.editor_id, hit.target.table) == (
        "company",
        company.id,
        "companies",
    )


def test_establishments_by_siret_name_and_city_open_their_company(db_session: Session) -> None:
    company = add_company(db_session, "Plateformes Témoin", siren=SIREN)
    primary = add_establishment(
        db_session,
        company.id,
        name="Siège Témoin",
        siret=SIRET,
        address_line1="1 rue de l'Exemple",
        postal_code="27000",
        city="Évreux",
        is_primary=True,
    )
    add_establishment(db_session, company.id, kind="Entrepôt", siret=SIRET_2, city="Saint-Étienne")

    found = hits(search(db_session, SIRET), SearchType.ESTABLISHMENT)
    assert [(hit.label, hit.match.field, hit.match.kind) for hit in found] == [
        ("Siège Témoin", MatchField.SIRET, EXACT)
    ]
    hit = found[0]
    assert isinstance(hit, EstablishmentHit)
    assert (hit.sublabel, hit.badges, hit.company_name, hit.siret) == (
        "1 rue de l'Exemple, 27000 Évreux",
        [Badge.PRIMARY],
        "Plateformes Témoin",
        SIRET,
    )
    assert (hit.target.editor, hit.target.editor_id) == ("company", company.id)
    assert (hit.target.table, hit.target.record_id) == ("establishments", primary.id)

    # The SIREN prefixes every SIRET of the company; the label falls back to the kind.
    assert labels(db_session, SIREN, SearchType.ESTABLISHMENT) == ["Siège Témoin", "Entrepôt"]
    assert matches(db_session, "evreux", SearchType.ESTABLISHMENT) == [
        ("Siège Témoin", MatchField.CITY, EXACT)
    ]
    assert matches(db_session, "et", SearchType.ESTABLISHMENT) == [
        ("Entrepôt", MatchField.CITY, PREFIX)
    ]


# --- groups, limits, safety --------------------------------------------------------------------


def test_groups_are_limited_and_ordered_by_their_best_match(db_session: Session) -> None:
    company = add_company(db_session, "Témoin Groupe", siren=SIREN)
    for n in range(GROUP_LIMIT + 2):
        add_prospect(db_session, company, first_name="Témoin", last_name=f"Groupe{n}")

    by_name = search(db_session, "temoin groupe")
    assert [group.type for group in by_name.groups] == [SearchType.COMPANY, SearchType.PROSPECT]
    people = by_name.groups[1]
    assert (len(people.items), people.has_more) == (GROUP_LIMIT, True)
    assert [hit.label for hit in people.items] == [f"Témoin Groupe{n}" for n in range(GROUP_LIMIT)]

    by_person = search(db_session, "groupe1")
    assert [group.type for group in by_person.groups] == [SearchType.PROSPECT]
    assert (by_person.groups[0].has_more, by_person.query) == (False, "groupe1")


def test_one_statement_per_group_whatever_the_matches(db_session: Session) -> None:
    company = add_company(db_session, "Témoin Requêtes", siren=SIREN)
    for n in range(12):
        person = add_prospect(db_session, company, first_name="Témoin", last_name=f"Requête{n}")
        add_email(db_session, person, f"temoin{n}@requetes.example")

    with statements(db_session) as executed:
        results = search(db_session, "temoin")

    assert len(executed) == 3
    assert [(group.type, len(group.items)) for group in results.groups] == [
        (SearchType.PROSPECT, GROUP_LIMIT),
        (SearchType.COMPANY, 1),
    ]


@pytest.mark.parametrize("query", ["", " ", "a", " é ", "x" * 201])
def test_queries_outside_2_to_200_characters_are_refused(db_session: Session, query: str) -> None:
    with pytest.raises(InvalidFieldError) as refused:
        search(db_session, query)
    assert (refused.value.field, refused.value.reason) == ("q", "length")


@pytest.mark.parametrize(
    "query",
    ["%%", "__", "\\%", "1_0", "'; DROP TABLE prospects; --", "a' OR '1'='1", "100%"],
)
def test_wildcards_and_quotes_are_matched_literally(db_session: Session, query: str) -> None:
    add_company(db_session, "Fret 100% Local")
    add_company(db_session, "Fret 1x0 Témoin")
    add_prospect(db_session, first_name="Axb", last_name="Témoin")

    found = [hit.label for group in search(db_session, query).groups for hit in group.items]

    assert found == (["Fret 100% Local"] if query == "100%" else [])
    assert labels(db_session, "témoin") == ["Axb Témoin"]
