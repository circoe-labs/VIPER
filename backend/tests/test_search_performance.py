"""Global search stays instant on a synthetic base far above V1 scale (ADR-0017).

Locally the base has 20 000 prospects (2 000 companies, ~3 000 establishments, 25 000 e-mail
addresses, 20 000 phone numbers) and the budget is the design target: p95 < 150 ms per search,
HTTP included. CI runners are shared and slower: there (`CI` set) the base is ten times smaller and
the budget 500 ms, so the test still catches a search that scans or multiplies rows without slowing
the suite. The measurements behind the index decision are in ADR-0017.
"""

import os
import statistics
import time

from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

IN_CI = bool(os.environ.get("CI"))
PROSPECTS = 2_000 if IN_CI else 20_000
P95_BUDGET_SECONDS = 0.5 if IN_CI else 0.15
RUNS = 5

# Invented name parts: last names are three syllables (8 000 combinations).
SYLLABLES = ["bar", "ton", "mel", "vic", "dur", "lan", "pré", "col", "mor", "fèv"]
SYLLABLES += ["gau", "ber", "ric", "sal", "tou", "vin", "roc", "dal", "mar", "fon"]
FIRST_NAMES = ["Jean", "Élodie", "Marc", "Sophie", "Luc", "Chloé", "Hugo", "Inès", "Paul", "Léa"]
FIRST_NAMES += ["Noé", "Zoé", "Rémi", "Anaïs", "Yves", "Maëlle", "Tom", "Aude", "Loïc", "Céline"]
CITIES = ["Lyon", "Paris", "Marseille", "Lille", "Nantes", "Rennes", "Évreux", "Orléans"]
CITIES += ["Besançon", "Saint-Étienne"]

# What the search field receives: 2-letter starts, names, accents, e-mail and phone fragments,
# identifiers, domains, cities, and misses.
QUERIES = [
    "ma",
    "du",
    "jean",
    "élo",
    "ELODIE",
    "bartonmel",
    "barton",
    "jean bar",
    "mel jea",
    "sophie colmorfev",
    "personne12",
    "personne1234@",
    "@societe12.example",
    "06 12",
    "0612 34",
    "+33 6 00 01",
    "transports",
    "transports vin",
    "société sas",
    "123 45",
    "000104729",
    "00010472900001",
    "societe42.example",
    "https://www.societe42.example/",
    "lyon",
    "saint-étienne",
    "zzzz",
    "xq",
]

NUMBERED_PROSPECTS = "(SELECT id, row_number() OVER (ORDER BY id) AS n FROM prospects) AS numbered"
SEED = [
    # Companies: invented names, a legal name for half of them, SIREN, domain, website.
    "INSERT INTO companies (display_name, legal_name, siren, email_domain, website_url)"
    " SELECT 'Transports ' || initcap(syllable(g) || syllable(g / 20)) || ' ' || g,"
    " CASE WHEN g % 2 = 0 THEN 'Société ' || g || ' SAS' END,"
    " lpad(CAST(g * 104729 AS text), 9, '0'), 'societe' || g || '.example',"
    " 'https://www.societe' || g || '.example/' FROM generate_series(1, :companies) AS g",
    # A primary establishment per company, a second one for about half of them.
    "INSERT INTO establishments (company_id, name, siret, city, postal_code, is_primary)"
    " SELECT id, CASE WHEN n = 1 THEN 'Siège' ELSE 'Entrepôt ' || n END,"
    " siren || lpad(CAST(n AS text), 5, '0'), (CAST(:cities AS text[]))[1 + (salt + n) % 10],"
    " '69000', n = 1"
    " FROM (SELECT id, siren, get_byte(uuid_send(id), 15) AS salt FROM companies) AS company,"
    " generate_series(1, 2) AS n WHERE n = 1 OR salt % 2 = 0",
    "WITH numbered AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM companies)"
    " INSERT INTO prospects (company_id, first_name, last_name, activity_status,"
    " contactability_status, do_not_contact_at)"
    " SELECT numbered.id, (CAST(:first_names AS text[]))[1 + g % 20],"
    " initcap(syllable(g) || syllable(g / 20) || syllable(g / 400)),"
    " (ARRAY['active', 'inactive', 'unknown'])[1 + g % 3],"
    " CASE WHEN g % 50 = 0 THEN 'do_not_contact' ELSE 'contactable' END,"
    " CASE WHEN g % 50 = 0 THEN now() END"
    " FROM generate_series(1, :prospects) AS g JOIN numbered ON numbered.n = g % :companies",
    "INSERT INTO emails (prospect_id, address, is_primary, origin_type)"
    " SELECT id, 'personne' || n || '@societe' || n % :companies || '.example', true,"
    f" 'imported' FROM {NUMBERED_PROSPECTS}",
    "INSERT INTO emails (prospect_id, address, is_primary, is_active, origin_type)"
    " SELECT id, 'ancien' || n || '@webmail.example', false, false, 'imported'"
    f" FROM {NUMBERED_PROSPECTS} WHERE n % 4 = 0",
    "INSERT INTO phones (prospect_id, number, type, is_primary, origin_type)"
    " SELECT id, '+336' || lpad(CAST(n * 7919 % 100000000 AS text), 8, '0'), 'mobile', true,"
    f" 'imported' FROM {NUMBERED_PROSPECTS}",
    # What autovacuum does in a live database: statistics, and the trigram indexes' pending
    # entries (GIN fast update) merged, so searches do not scan 20 000 fresh rows linearly.
    "ANALYZE companies, establishments, prospects, emails, phones",
    "SELECT gin_clean_pending_list(CAST(indexname AS regclass)) FROM pg_indexes"
    " WHERE schemaname = 'public' AND indexname LIKE '%\\_trgm' ESCAPE '\\'",
]


def seed_base(session: Session, prospects: int = PROSPECTS) -> None:
    """Synthetic companies, establishments and prospects with e-mail addresses and phone numbers,
    then fresh planner statistics."""
    # DDL takes no bound parameter: the (constant) syllables are written into the function.
    syllables = ", ".join(f"'{syllable}'" for syllable in SYLLABLES)
    session.execute(
        text(
            "CREATE FUNCTION pg_temp.syllable(n integer) RETURNS text LANGUAGE sql"
            f" RETURN (ARRAY[{syllables}])[1 + n % 20]"
        )
    )
    params = {
        "first_names": FIRST_NAMES,
        "cities": CITIES,
        "companies": prospects // 10,
        "prospects": prospects,
    }
    for statement in SEED:
        session.execute(text(statement.replace("syllable(", "pg_temp.syllable(")), params)


def p95(timings: list[float]) -> float:
    return statistics.quantiles(timings, n=20)[-1]


def test_search_p95_on_a_large_base(client: TestClient, db_session: Session) -> None:
    seed_base(db_session)
    for query in QUERIES:  # warm-up: connection, plans, caches
        client.get("/api/search", params={"q": query})
    timings = []
    groups = 0
    for _ in range(RUNS):
        for query in QUERIES:
            started = time.perf_counter()
            response = client.get("/api/search", params={"q": query})
            timings.append(time.perf_counter() - started)
            assert response.status_code == 200, query
            groups += len(response.json()["groups"])

    assert groups > len(QUERIES) * RUNS
    assert p95(timings) < P95_BUDGET_SECONDS, f"p95 {p95(timings) * 1000:.0f} ms"
