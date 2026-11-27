"""« Identité e-mail » (`app.services.email_identity`): the rule, and every place it blocks."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.cli import main
from app.core.actor import ActorContext, ActorType
from app.models import Email, EmailIdentityConfirmation
from app.models.enums import ContactMessageStatus, VerificationStatus
from app.services import audit, email_identity
from app.services.email_identity import Name, Person, Reason, assess
from app.services.errors import ActorNotAllowedError
from tests.builders import FIXTURE_ACTOR
from tests.test_contact_dispatch import DUE, Clock, dispatcher, row, scheduled, toolbox_of
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id, refused


def reason_of(address: str, first: str, last: str, **extra: Any) -> Reason | None:
    doubt = assess(address, Name.of(first, last), **extra)
    return doubt.reason if doubt else None


@pytest.mark.parametrize(
    ("address", "first", "last"),
    [
        ("camille.martin@exemple.fr", "Camille", "Martin"),
        ("c.martin@exemple.fr", "Camille", "Martin"),
        ("martin.c@exemple.fr", "Camille", "Martin"),
        ("cmartin2@exemple.fr", "Camille", "Martin"),
        ("camille@exemple.fr", "Camille", "Martin"),
        ("helene.lefevre@exemple.fr", "Hélène", "Lefèvre"),
        ("jp.durand@exemple.fr", "Jean-Pierre", "Durand"),
        ("jpd@exemple.fr", "Jean-Pierre", "Durand"),
        ("jeanpierre.delarue@exemple.fr", "Jean-Pierre", "De La Rue"),
        ("anne.le-gall@exemple.fr", "Anne", "Le Gall"),
        # Maiden name: the first name, or its initial, still says who it is.
        ("julie.bernard@exemple.fr", "Julie", "Petit"),
        ("j.bernard@exemple.fr", "Julie", "Petit"),
        # Shortened first name, truncated family name.
        ("seb.moreau@exemple.fr", "Sébastien", "Moreau"),
        ("n.vandeca@exemple.fr", "Noé", "Vandecasteele"),
        ("contact@exemple.fr", "Camille", "Martin"),
        ("info.lyon@exemple.fr", "Camille", "Martin"),
        ("service.client@exemple.fr", "Camille", "Martin"),
        ("direction-generale@exemple.fr", "Camille", "Martin"),
        # A single unknown word says nothing.
        ("bob@exemple.fr", "Camille", "Martin"),
    ],
)
def test_an_address_that_may_be_the_persons_is_not_doubted(
    address: str, first: str, last: str
) -> None:
    assert reason_of(address, first, last) is None


@pytest.mark.parametrize(
    "address",
    ["samuel.durand@exemple.fr", "s.durand@exemple.fr", "samuel_durand+x@exemple.fr"],
)
def test_another_persons_name_is_doubted(address: str) -> None:
    assert reason_of(address, "Victor", "Morel") is Reason.NAMED_OTHER


def test_names_the_company_and_missing_names() -> None:
    assert reason_of("durand.logistics@exemple.fr", "Victor", "Morel") is None
    words = frozenset({"transports", "durand"})
    assert reason_of("agent.durand@exemple.fr", "Victor", "Morel", company_words=words) is None
    # Without both names the shape alone proves nothing.
    assert reason_of("samuel.durand@exemple.fr", "", "Morel") is None


def test_colleague_and_shared_address() -> None:
    samuel = Person(None, Name.of("Samuel", "Durand"), "Samuel Durand")
    found = assess("sdurand@exemple.fr", Name.of("Victor", "Morel"), colleagues=[samuel])
    assert found is not None and found.reason is Reason.COLLEAGUE
    assert found.other_name == "Samuel Durand"
    # The person's own family name wins over a colleague's initials.
    paul = Person(None, Name.of("Paul", "Durand"), "Paul Durand")
    assert reason_of("p.durand@exemple.fr", "Pierre", "Durand", colleagues=[paul]) is None
    # Shared: the holder the address names is not doubted, the other is.
    victor = Person(None, Name.of("Victor", "Morel"), "Victor Morel")
    assert reason_of("samuel.durand@exemple.fr", "Samuel", "Durand", holders=[victor]) is None
    assert (
        reason_of("samuel.durand@exemple.fr", "Victor", "Morel", holders=[samuel]) is Reason.SHARED
    )
    # Two people it names equally (a duplicate record): both are to check.
    assert (
        reason_of("samuel.durand@exemple.fr", "Samuel", "Durand", holders=[samuel]) is Reason.SHARED
    )
    assert reason_of("contact@exemple.fr", "Victor", "Morel", holders=[samuel]) is None


# --- the places it blocks -------------------------------------------------------------------------

WRONG = "samuel.durand@exemple.invalid"


def readdress(session: Session, person: Any, address: str) -> None:
    """The existing data: the address came from an import and was marked verified."""
    session.expire_all()
    primary = session.scalar(select(Email).where(Email.prospect_id == person, Email.is_primary))
    assert primary is not None
    audit.annotate(session, FIXTURE_ACTOR, primary)
    primary.address = address
    primary.verification_status = VerificationStatus.VERIFIED
    session.flush()


def test_confirmation_is_per_address_and_recorded(
    db_session: Session, connected: TestClient
) -> None:
    person = prospect_id(db_session)
    base = f"/api/prospects/{person}"
    primary = db_session.scalar(select(Email).where(Email.prospect_id == person, Email.is_primary))
    assert primary is not None
    sheet = ok(connected.get(base))
    assert sheet["emails"][0]["identity_doubt"] is None
    save = {
        "version": sheet["version"],
        "first_name": sheet["first_name"],
        "last_name": sheet["last_name"],
        "company_id": sheet["company"]["id"],
        "emails": [{"id": str(primary.id), "address": WRONG, "verified_now": True}],
        "phones": [],
    }
    response = connected.put(base, json=save)
    assert response.status_code == 422
    assert "identity_doubt" in response.text
    save["emails"][0]["identity_confirmed"] = True
    saved = ok(connected.put(base, json=save))
    email = saved["prospect"]["emails"][0] if "prospect" in saved else saved["emails"][0]
    assert email["verification_status"] == "verified"
    assert email["identity_doubt"] is None
    assert email["identity_confirmed_by"]
    record = db_session.scalar(select(EmailIdentityConfirmation))
    assert record is not None and record.confirmed_at is not None

    # Taken back, doubted again, confirmed on the sheet.
    revoked = connected.post(f"{base}/email-identity/revoke", json={"address": WRONG})
    assert revoked.status_code == 204
    assert ok(connected.get(base))["emails"][0]["identity_doubt"]["reason"] == "named_other"
    assert connected.post(f"{base}/email-identity", json={"address": WRONG}).status_code == 204

    # Changing the address voids the override, also when it comes back to the former value.
    for address in ("victor.autre@exemple.invalid", WRONG):
        current = ok(connected.get(base))
        save.update(version=current["version"])
        save["emails"] = [{"id": current["emails"][0]["id"], "address": address}]
        ok(connected.put(base, json=save))
    db_session.expire_all()
    assert db_session.scalar(select(EmailIdentityConfirmation)) is None
    assert ok(connected.get(base))["emails"][0]["identity_doubt"] is not None


def test_a_doubtful_recipient_blocks_every_step(db_session: Session, connected: TestClient) -> None:
    person = prospect_id(db_session)
    base = f"{messages(person)}/contact"
    ok(connected.put(base, json={"subject": "Objet", "body_text": "Corps", "to": [WRONG]}), 201)
    listed = ok(connected.get(messages(person)))
    assert [d["address"] for d in listed["identity_doubts"]] == [WRONG]
    response = connected.post(f"{base}/validate", json={"expected_revision": 1})
    refused(response, 409, "email_identity_doubt")
    drafted = connected.post(f"{base}/generate", json={"expected_revision": 1, "replace": True})
    refused(drafted, 409, "email_identity_doubt")
    identity = f"/api/prospects/{person}/email-identity"
    assert connected.post(identity, json={"address": WRONG}).status_code == 204
    ok(connected.post(f"{base}/validate", json={"expected_revision": 1}))
    assert connected.post(f"{identity}/revoke", json={"address": WRONG}).status_code == 204
    response = connected.post(
        f"{base}/schedule",
        json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
    )
    refused(response, 409, "email_identity_doubt")
    series = ok(
        connected.post(
            "/api/contact/schedule-cohorts",
            json={
                "cohorts": [listed_cohort(connected, person)],
                "step": "contact",
                "scheduled_at": FUTURE.isoformat(),
            },
        )
    )
    assert (series["scheduled"], series["doubtful"]) == (0, 1)


def listed_cohort(client: TestClient, person: Any) -> str:
    return str(ok(client.get(f"/api/prospects/{person}"))["contact"]["cohort"]["code"])


def test_the_dispatcher_holds_a_scheduled_mail_to_a_doubtful_address(
    connected: TestClient, toolbox_app: Any, fake: Any, db_session: Session
) -> None:
    person = prospect_id(db_session)
    message = scheduled(connected, person)
    # An address that names someone else (nothing re-validated the message).
    stored = row(db_session, message["id"])
    audit.annotate(db_session, FIXTURE_ACTOR, stored)
    stored.to_recipients = [WRONG]
    db_session.flush()
    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    after = row(db_session, message["id"])
    assert after.status is ContactMessageStatus.VALIDATED
    assert after.last_error_code == "email_identity_doubt"
    assert not fake.sent


def test_the_operator_listing_changes_nothing(
    db_session: Session, connected: TestClient, session_factory: Any, capsys: Any
) -> None:
    person = prospect_id(db_session)
    readdress(db_session, person, WRONG)
    page = ok(connected.get("/api/prospection/prospects?identity_doubt=true"))
    assert [item["id"] for item in page["items"]] == [str(person)]
    assert page["items"][0]["identity_doubt"]["reason"] == "named_other"
    assert ok(connected.get("/api/prospection/counters"))["identity_doubts"] == 1
    assert main(["email-identity"], session_factory=session_factory) == 0
    out = capsys.readouterr().out
    assert WRONG in out and "1 doubtful address(es), 1 of them marked verified" in out


def test_only_a_person_confirms(db_session: Session) -> None:
    person = prospect_id(db_session)
    agent = ActorContext(type=ActorType.AGENT, display="Agent", id="agent")
    with pytest.raises(ActorNotAllowedError):
        email_identity.confirm(db_session, agent, person, WRONG)


def test_a_doubtful_verified_address_is_not_a_verified_email_for_the_file(
    db_session: Session, connected: TestClient
) -> None:
    person = prospect_id(db_session)
    base = f"/api/prospects/{person}"

    def file_status() -> tuple[str, str, int, int]:
        sheet = ok(connected.get(base))["data_quality"]
        verified = next(c for c in sheet["criteria"] if c["id"] == "email_verified")
        (item,) = ok(connected.get("/api/prospection/prospects"))["items"]
        return item["review"], verified["detail"], sheet["total"], item["quality_score"]

    primary = db_session.scalar(select(Email).where(Email.prospect_id == person, Email.is_primary))
    assert primary is not None
    readdress(db_session, person, primary.address)  # verified, and the person's own
    review, detail, total, listed = file_status()
    assert detail == "E-mail vérifié" and total == listed

    readdress(db_session, person, WRONG)
    doubted_review, detail, doubted_total, doubted_listed = file_status()
    assert detail == "E-mail à vérifier (identité)"
    assert doubted_total == doubted_listed == total - 20
    assert doubted_review == "incomplete"
    reviews = ok(connected.get("/api/prospection/counters"))["reviews"]
    assert reviews["incomplete"]["total"] == 1

    # Confirmed: the same read, without any other write, counts it again.
    path = f"{base}/email-identity"
    assert connected.post(path, json={"address": WRONG}).status_code == 204
    assert file_status() == (review, "E-mail vérifié", total, total)
