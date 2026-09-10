"""Explorer row reads: paging, multi-sort, search, typed filter AST, injection safety, records."""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import (
    Company,
    Establishment,
    ImportBatch,
    ImportRowMetadata,
    company_activity_categories,
)
from app.models.enums import ActivityStatus, ImportBatchStatus
from app.models.taxonomies import ActivityCategory
from app.services.explorer.reads import LIST_VALUE_MAX_CHARS
from tests.builders import add_company, add_prospect
from tests.explorer_helpers import (
    API,
    column_values,
    condition,
    get_rows,
    group,
    rows_status,
)

NAMES = [
    "Alpha Transports",
    "beta logistique",
    "Gamma 100% Fret",
    "Gamma 1000 Fret",
    "Delta_Fret",
    "DeltaXFret",
]
LONG_TEXT = "Texte synthétique très long. " * 40


@pytest.fixture
def companies(db_session: Session) -> list[Company]:
    """Six companies in creation (= primary key) order, with a few NULLs to sort and filter."""
    return [
        add_company(
            db_session,
            name,
            legal_name=None if index % 2 else f"{name} Synthétique",
            size_label=("10-49", None, "50-249")[index % 3],
            email_domain=f"societe{index}.example.com",
        )
        for index, name in enumerate(NAMES)
    ]


@pytest.mark.usefixtures("companies")
def test_pages_are_disjoint_and_ordered_by_primary_key_by_default(client: TestClient) -> None:
    pages = [get_rows(client, "companies", offset=offset, limit=4) for offset in (0, 4)]

    assert [page["total"] for page in pages] == [6, 6]
    assert [len(page["rows"]) for page in pages] == [4, 2]
    assert (
        column_values(pages[0], "display_name") + column_values(pages[1], "display_name") == NAMES
    )


@pytest.mark.parametrize("paging", [{"limit": 0}, {"limit": 501}, {"offset": -1}])
def test_page_bounds_are_validated(client: TestClient, paging: dict[str, int]) -> None:
    assert client.get(f"{API}/companies/rows", params=paging).status_code == 422


@pytest.mark.usefixtures("companies")
def test_single_and_multi_column_sort(client: TestClient) -> None:
    # Sorted on `societeN.example.com` domains: the order does not depend on the collation.
    descending = get_rows(client, "companies", sort=["-email_domain"])
    by_size_then_domain = get_rows(client, "companies", sort=["size_label", "-email_domain"])

    assert column_values(descending, "display_name") == NAMES[::-1]
    # PostgreSQL orders NULLs last ascending; ties fall back to the second key.
    assert column_values(by_size_then_domain, "display_name") == [
        "Gamma 1000 Fret",
        "Alpha Transports",
        "DeltaXFret",
        "Gamma 100% Fret",
        "Delta_Fret",
        "beta logistique",
    ]


@pytest.mark.parametrize(
    "sort",
    [
        ["nope"],
        ["display_name; DROP TABLE companies"],
        ['display_name" DESC, (SELECT 1) --'],
        ["-"],
        ["display_name", "-display_name"],
        ["id"] * 11,
    ],
)
def test_invalid_sort_is_rejected(client: TestClient, sort: list[str]) -> None:
    assert rows_status(client, "companies", sort=sort) == 422


@pytest.mark.usefixtures("companies")
def test_search_is_case_insensitive_across_text_columns(client: TestClient) -> None:
    assert column_values(get_rows(client, "companies", q="LOGISTIQUE"), "display_name") == [
        "beta logistique"
    ]
    assert column_values(get_rows(client, "companies", q="societe3.example"), "display_name") == [
        "Gamma 1000 Fret"
    ]
    assert get_rows(client, "companies", q="   ")["total"] == 6


@pytest.mark.usefixtures("companies")
def test_search_wildcards_are_literal(client: TestClient) -> None:
    assert column_values(get_rows(client, "companies", q="100%"), "display_name") == [
        "Gamma 100% Fret"
    ]
    assert column_values(get_rows(client, "companies", q="delta_"), "display_name") == [
        "Delta_Fret"
    ]
    assert get_rows(client, "companies", q="%")["total"] == 1
    assert get_rows(client, "companies", q="/")["total"] == 0


def test_search_matches_identifiers_by_prefix(client: TestClient, companies: list[Company]) -> None:
    target = companies[2].id
    body = get_rows(client, "companies", q=str(target)[:18])

    assert column_values(body, "id") == [str(target)]


def test_search_is_length_limited(client: TestClient) -> None:
    assert rows_status(client, "companies", q="x" * 201) == 422


@pytest.mark.usefixtures("companies")
def test_text_operators(client: TestClient) -> None:
    def names(node: dict[str, Any]) -> list[str]:
        return column_values(get_rows(client, "companies", node=node), "display_name")

    assert names(condition("display_name", "contains", "FRET")) == NAMES[2:]
    assert names(condition("display_name", "starts_with", "gamma 10")) == NAMES[2:4]
    assert names(condition("display_name", "eq", "Delta_Fret")) == ["Delta_Fret"]
    assert names(condition("display_name", "eq", "delta_fret")) == []
    assert names(condition("display_name", "in", values=["Alpha Transports", "DeltaXFret"])) == [
        "Alpha Transports",
        "DeltaXFret",
    ]
    assert names(condition("legal_name", "is_null")) == NAMES[1::2]
    assert names(condition("legal_name", "not_null")) == NAMES[::2]
    assert names(condition("display_name", "contains", "a_f")) == ["Delta_Fret"]


@pytest.mark.usefixtures("companies")
def test_not_equal_keeps_missing_values(client: TestClient) -> None:
    body = get_rows(client, "companies", node=condition("size_label", "neq", "10-49"))

    assert column_values(body, "size_label") == [None, "50-249", None, "50-249"]


@pytest.fixture
def batches(db_session: Session) -> list[ImportBatch]:
    batches = [
        ImportBatch(
            filename=f"classeur-{n}.xlsx",
            sheet_names=[f"Feuille {n}", "Commune"],
            status=ImportBatchStatus.PENDING,
            rows_total=n * 10,
            actor_type=ActorType.IMPORT,
            actor_display="Import synthétique",
        )
        for n in (1, 2, 3)
    ]
    db_session.add_all(batches)
    db_session.flush()
    return batches


@pytest.mark.usefixtures("batches")
def test_integer_operators_and_types(client: TestClient) -> None:
    def totals(node: dict[str, Any]) -> list[int]:
        return column_values(get_rows(client, "import_batches", node=node), "rows_total")

    assert totals(condition("rows_total", "gt", 10)) == [20, 30]
    assert totals(condition("rows_total", "gte", 20)) == [20, 30]
    assert totals(condition("rows_total", "lt", 20)) == [10]
    assert totals(condition("rows_total", "lte", 20)) == [10, 20]
    assert totals(condition("rows_total", "eq", 30)) == [30]
    assert totals(condition("rows_total", "in", values=[10, 30])) == [10, 30]
    for bad in ("20", True, 1.5, 2**63):
        assert rows_status(client, "import_batches", node=condition("rows_total", "eq", bad)) == 422
    assert (
        rows_status(client, "import_batches", node=condition("rows_total", "contains", "1")) == 422
    )


@pytest.mark.usefixtures("batches")
def test_array_and_json_columns_match_as_text(client: TestClient, db_session: Session) -> None:
    body = get_rows(
        client, "import_batches", node=condition("sheet_names", "contains", "feuille 2")
    )
    assert column_values(body, "sheet_names") == [["Feuille 2", "Commune"]]

    batch = db_session.scalars(select(ImportBatch)).first()
    assert batch is not None
    db_session.add(
        ImportRowMetadata(
            import_batch_id=batch.id,
            source_sheet="Feuille 1",
            source_row_number=2,
            legacy_metadata={"Colonne inconnue": "valeur fictive"},
        )
    )
    db_session.flush()
    json_rows = get_rows(
        client, "import_row_metadata", node=condition("legacy_metadata", "contains", "FICTIVE")
    )
    assert column_values(json_rows, "legacy_metadata") == [{"Colonne inconnue": "valeur fictive"}]
    assert get_rows(client, "import_row_metadata", q="colonne inconnue")["total"] == 1
    assert (
        rows_status(client, "import_row_metadata", node=condition("legacy_metadata", "eq", "x"))
        == 422
    )


def test_boolean_enum_datetime_and_uuid_operators(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session)
    other = add_company(db_session, "Logistique Exemple SAS")
    for index, target in enumerate((company, company, other)):
        db_session.add(Establishment(company_id=target.id, is_primary=index != 1))
    verified = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
    active = add_prospect(
        db_session, company, activity_status=ActivityStatus.ACTIVE, employment_verified_at=verified
    )
    add_prospect(db_session, other, first_name="Marie")
    db_session.flush()

    def count(table: str, node: dict[str, Any]) -> int:
        total: int = get_rows(client, table, node=node)["total"]
        return total

    assert count("establishments", condition("is_primary", "eq", True)) == 2
    assert count("establishments", condition("is_primary", "neq", True)) == 1
    assert count("establishments", condition("company_id", "eq", str(company.id))) == 2
    assert count("establishments", condition("company_id", "starts_with", str(other.id)[:20])) == 1
    assert count("prospects", condition("activity_status", "eq", "active")) == 1
    assert count("prospects", condition("activity_status", "in", values=["active", "unknown"])) == 2
    assert (
        count("prospects", condition("employment_verified_at", "gte", "2026-03-01T12:00:00Z")) == 1
    )
    assert (
        count("prospects", condition("employment_verified_at", "lt", "2026-03-01T13:00:00+01:00"))
        == 0
    )
    assert count("prospects", condition("employment_verified_at", "is_null")) == 1
    assert count("prospects", condition("id", "eq", str(active.id))) == 1

    for node in (
        condition("is_primary", "eq", "true"),
        condition("activity_status", "eq", "retired"),
        condition("activity_status", "contains", "act"),
        condition("employment_verified_at", "gte", "2026-03-01T12:00:00"),
        condition("employment_verified_at", "gte", "demain"),
        condition("id", "eq", "not-a-uuid"),
        condition("id", "gt", str(active.id)),
    ):
        table = "establishments" if node["column"] == "is_primary" else "prospects"
        assert rows_status(client, table, node=node) == 422, node


@pytest.mark.usefixtures("companies")
def test_groups_combine_with_and_or(client: TestClient) -> None:
    either = group(
        condition("display_name", "eq", "Alpha Transports"),
        condition("display_name", "starts_with", "delta"),
        combinator="or",
    )
    nested = group(either, condition("legal_name", "not_null"))

    assert column_values(get_rows(client, "companies", node=either), "display_name") == [
        "Alpha Transports",
        "Delta_Fret",
        "DeltaXFret",
    ]
    assert column_values(get_rows(client, "companies", node=nested), "display_name") == [
        "Alpha Transports",
        "Delta_Fret",
    ]
    assert get_rows(client, "companies", node=group())["total"] == 6
    assert get_rows(client, "companies", node=group(combinator="or"))["total"] == 0


@pytest.mark.usefixtures("companies")
def test_filter_search_sort_and_paging_combine(client: TestClient) -> None:
    body = get_rows(
        client,
        "companies",
        node=condition("display_name", "contains", "fret"),
        q="gamma",
        sort=["-email_domain"],
        offset=1,
        limit=1,
    )

    assert body["total"] == 2
    assert column_values(body, "display_name") == ["Gamma 100% Fret"]


def deep(levels: int) -> dict[str, Any]:
    node = condition("display_name", "is_null")
    for _ in range(levels - 1):
        node = group(node)
    return node


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        json.dumps({"column": "display_name", "operator": "eq", "value": "x"}),
        json.dumps(condition("display_name", "like", "x")),
        json.dumps(condition("display_name", "eq")),
        json.dumps(condition("display_name", "eq", {"$ne": 1})),
        json.dumps(condition("display_name", "in", values=[])),
        json.dumps(condition("display_name", "in", values=["x"] * 101)),
        json.dumps(condition("display_name", "eq", "x" * 1001)),
        json.dumps(condition("display_name", "eq", "x") | {"sql": "1=1"}),
        json.dumps(condition("unknown_column", "is_null")),
        json.dumps(condition('display_name" OR 1=1 --', "is_null")),
        json.dumps(condition("companies.display_name", "is_null")),
        json.dumps(deep(5)),
        json.dumps(
            group(
                *[condition("display_name", "is_null")] * 30,
                group(*[condition("siren", "is_null")] * 21),
            )
        ),
    ],
)
def test_malformed_or_unsafe_filters_are_rejected(client: TestClient, raw: str) -> None:
    assert client.get(f"{API}/companies/rows", params={"filter": raw}).status_code == 422


def test_deepest_allowed_filter_is_accepted(client: TestClient) -> None:
    assert rows_status(client, "companies", node=deep(4)) == 200


@pytest.mark.parametrize(
    "payload",
    [
        "'; DROP TABLE companies; --",
        "x' OR '1'='1",
        "Alpha Transports' --",
        "\\' OR 1=1 --",
        "%' UNION SELECT token FROM secret --",
    ],
)
@pytest.mark.usefixtures("companies")
def test_injection_payloads_are_plain_values(
    client: TestClient, db_session: Session, payload: str
) -> None:
    for operator in ("eq", "contains", "starts_with"):
        assert (
            get_rows(client, "companies", node=condition("display_name", operator, payload))[
                "total"
            ]
            == 0
        )
    assert get_rows(client, "companies", q=payload)["total"] == 0
    assert db_session.scalar(select(func.count()).select_from(Company)) == len(NAMES)


def test_long_values_are_truncated_in_pages_and_complete_in_records(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, client_approach=LONG_TEXT, project_type="Court")

    row = get_rows(client, "companies")["rows"][0]
    assert row["truncated"] == ["client_approach"]
    assert row["values"]["client_approach"] == LONG_TEXT[:LIST_VALUE_MAX_CHARS]
    assert row["values"]["project_type"] == "Court"

    record = client.get(
        f"{API}/companies/record", params={"key": json.dumps({"id": str(company.id)})}
    )
    assert record.status_code == 200
    assert record.json()["values"]["client_approach"] == LONG_TEXT


@pytest.mark.usefixtures("batches")
def test_long_json_is_previewed_as_text(client: TestClient, db_session: Session) -> None:
    batch = db_session.scalars(select(ImportBatch)).first()
    assert batch is not None
    db_session.add(
        ImportRowMetadata(
            import_batch_id=batch.id,
            source_sheet="Feuille 1",
            source_row_number=2,
            legacy_metadata={"Remarques": LONG_TEXT},
        )
    )
    db_session.flush()

    row = get_rows(client, "import_row_metadata")["rows"][0]
    assert row["truncated"] == ["legacy_metadata"]
    assert row["values"]["legacy_metadata"].startswith('{"Remarques": "Texte')
    assert len(row["values"]["legacy_metadata"]) == LIST_VALUE_MAX_CHARS


def test_record_lookup_by_composite_key_and_key_validation(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session)
    category = ActivityCategory(slug="categorie-test", label="Catégorie test")
    db_session.add(category)
    db_session.flush()
    db_session.execute(
        company_activity_categories.insert().values(
            company_id=company.id, activity_category_id=category.id
        )
    )
    key = {"company_id": str(company.id), "activity_category_id": str(category.id)}

    def record(table: str, raw: str) -> int:
        return client.get(f"{API}/{table}/record", params={"key": raw}).status_code

    assert record("company_activity_categories", json.dumps(key)) == 200
    assert record("company_activity_categories", json.dumps({"company_id": str(company.id)})) == 422
    assert record("companies", json.dumps({"id": str(company.id), "extra": 1})) == 422
    assert record("companies", json.dumps({"id": "nope"})) == 422
    assert record("companies", "[1]") == 422
    assert record("companies", json.dumps({"id": str(uuid.uuid4())})) == 404


def test_the_only_explorer_posts_are_the_change_set_and_the_sql_console(
    client: TestClient,
) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    explorer = {
        path: set(methods) for path, methods in paths.items() if path.startswith("/api/explorer")
    }

    assert len(explorer) == 8
    assert explorer.pop("/api/explorer/tables/{table_name}/changes") == {"post"}
    assert explorer.pop("/api/explorer/sql") == {"post"}
    assert all(methods == {"get"} for methods in explorer.values())
    for method in ("post", "put", "patch", "delete"):
        assert client.request(method, f"{API}/companies/rows").status_code == 405
