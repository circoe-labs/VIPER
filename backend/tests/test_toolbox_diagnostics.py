"""« Tester la Toolbox »: the scripted run against the local fake Toolbox (never a real one, P6)."""

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services.toolbox.diagnostics import Run, ToolboxDiagnostics
from tests.fake_toolbox import FakeToolbox

URL = "/api/settings/integrations/toolbox/diagnostics"
RECIPIENT = "test@circoe.com"


def run_diagnostic(app: FastAPI, *, send_real: bool, recipient: str = RECIPIENT) -> dict[str, Any]:
    diagnostics = ToolboxDiagnostics()
    run = diagnostics.start(
        recipient=recipient,
        send_real=send_real,
        delay_seconds=20,
        integration=app.state.toolbox,
        settings=app.state.settings,
        session_factory=app.state.session_factory,
        dispatch_reason=lambda: {"dispatch_active": False},
        blocking=True,
        sleep=lambda seconds: None,
    )
    assert isinstance(run, Run)
    return diagnostics.snapshot(run)


def statuses(run: dict[str, Any]) -> dict[str, str]:
    return {step["key"]: step["status"] for step in run["steps"]}


def test_full_run_with_a_real_send(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox
) -> None:
    run = run_diagnostic(toolbox_app, send_real=True)

    assert run["verdict"]["ok"], run["verdict"]
    assert run["status"] == "done"
    found = statuses(run)
    assert found["create"] == found["find"] == found["edit"] == found["send"] == "ok"
    assert (
        found["refuse_address"] == found["send_unknown"] == found["send_twice"] == "expected_error"
    )
    assert found["cleanup"] == "ok"
    # One mail left, to the test address only; every test draft is gone.
    assert len(fake.sent) == 1
    assert fake.drafts == {}
    send = next(step for step in run["steps"] if step["key"] == "send")
    assert send["context"]["to"] == RECIPIENT
    assert send["observed"]["sent"] is True


def test_without_a_real_send_nothing_leaves(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox
) -> None:
    run = run_diagnostic(toolbox_app, send_real=False)

    assert run["verdict"]["ok"]
    assert fake.sent == []
    found = statuses(run)
    assert found["schedule"] == found["send"] == found["send_twice"] == "skipped"
    assert fake.drafts == {}


def test_a_toolbox_refusal_is_captured_with_its_raw_text(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox
) -> None:
    fake.mode.tool_error_text = "Le fournisseur a répondu : quota dépassé"

    run = run_diagnostic(toolbox_app, send_real=True)

    assert run["verdict"]["ok"] is False
    create = next(step for step in run["steps"] if step["key"] == "list_baseline")
    assert create["status"] == "failed"
    assert create["error"]["code"] == "toolbox_rejected"
    assert create["error"]["hint"]
    assert "quota dépassé" in create["error"]["toolbox_text"]
    raw = [event for event in create["trace"] if event["outcome"] == "tool_error"]
    assert "quota dépassé" in raw[0]["text"]
    # Nothing is skipped for the sake of it: the other steps run (and fail the same way), and only
    # those that need a draft that was never created are skipped.
    after = statuses(run)
    assert after["create"] == "failed"
    assert after["create_special"] == "failed"
    assert after["find"] == "skipped"
    assert after["edit"] == "skipped"
    assert after["refuse_address"] == "expected_error"
    assert after["send"] == "skipped"
    assert run["verdict"]["first_problem"]["step"] == "list_baseline"


def test_unreachable_toolbox_reports_the_transport_error(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox
) -> None:
    fake.mode.unreachable = True

    run = run_diagnostic(toolbox_app, send_real=False)

    tools = next(step for step in run["steps"] if step["key"] == "tools")
    assert tools["status"] == "failed"
    assert tools["error"]["code"] == "toolbox_unavailable"
    assert tools["trace"][0]["outcome"] == "transport_error"


def test_not_connected_stops_at_the_configuration(toolbox_app: FastAPI) -> None:
    run = run_diagnostic(toolbox_app, send_real=True)

    found = statuses(run)
    assert found["config"] == "failed"
    config = run["steps"][0]
    assert config["error"]["code"] == "toolbox_not_connected"
    assert config["observed"]["state"] == "disconnected"
    assert found["tools"] == found["create"] == "skipped"
    assert found["cleanup"] == "skipped"


def test_allowlist_refusal_of_the_recipient_is_explained(
    connected: TestClient, toolbox_app: FastAPI
) -> None:
    toolbox_app.state.settings = toolbox_app.state.settings.model_copy(
        update={"infomaniak_send_allowlist": "@autre.fr"}
    )

    run = run_diagnostic(toolbox_app, send_real=False)

    config = run["steps"][0]
    assert config["observed"]["recipient_permitted_by_viper_allowlist"] is False
    assert "ALLOWLIST" in config["note"]


class InlineDiagnostics(ToolboxDiagnostics):
    """Runs on the request's thread: the per-test connection cannot be shared across threads."""

    def start(self, **kwargs: Any) -> Run | None:
        return super().start(**kwargs, blocking=True)


def test_the_page_starts_and_reads_a_run(connected: TestClient, toolbox_app: FastAPI) -> None:
    toolbox_app.state.toolbox_diagnostics = InlineDiagnostics()
    assert connected.get(f"{URL}/latest").json() is None

    started = connected.post(URL, json={"recipient": "Test@Circoe.com", "send_real": False})

    assert started.status_code == 202
    body = started.json()
    assert body["recipient"] == RECIPIENT
    assert body["status"] == "done"
    assert body["verdict"]["ok"]
    assert connected.get(f"{URL}/latest").json()["id"] == body["id"]


def test_the_shown_result_can_be_cleared(connected: TestClient, toolbox_app: FastAPI) -> None:
    toolbox_app.state.toolbox_diagnostics = InlineDiagnostics()
    connected.post(URL, json={"recipient": RECIPIENT, "send_real": False})
    assert connected.get(f"{URL}/latest").json() is not None

    assert connected.delete(f"{URL}/latest").status_code == 204

    assert connected.get(f"{URL}/latest").json() is None


def test_a_bad_recipient_or_delay_is_refused(connected: TestClient) -> None:
    assert connected.post(URL, json={"recipient": "pas-une-adresse"}).status_code == 422
    assert connected.post(URL, json={"recipient": "a@b.fr, c@d.fr"}).status_code == 422
    assert connected.post(URL, json={"recipient": RECIPIENT, "delay_seconds": 5}).status_code == 422
    assert connected.post(URL, json={"recipient": RECIPIENT, "send_real": "x"}).status_code == 422
