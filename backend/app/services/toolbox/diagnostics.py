"""« Tester la Toolbox »: a scripted run of every mail operation VIPER relies on (test address).

Settings > Connexions starts it; it runs in a background thread (a scheduled send waits about a
minute) and the page polls `ToolboxDiagnostics.get`. Each step records what was expected, what
happened, how long it took, the stable `toolbox_*` code of a failure with a hint, and the raw HTTP /
JSON-RPC exchange (`mcp_client.capture_trace`, the Toolbox's own error text included: it only ever
concerns the test address typed for this run).

What it covers, in order — configuration, the Toolbox tools, listing drafts, creating a draft
(plain, then with accents / typographic characters / a long realistic body), the recovery lookup
(`list_drafts`), an edit (VIPER replaces a draft: create the new one, delete the old one), an
idempotent delete, the refusals VIPER relies on (bad address, empty or oversized subject, unknown
draft), and — only when « envoi réel » is ticked — a scheduled send: the draft waits, its date is
moved, then it is sent for real to the test address, and a second send of the same draft must be
refused. The VIPER-side schedule (dates, the dispatcher's passes) is simulated here with a clock:
the Toolbox only ever sees `create_draft` / `send_draft`; what the run proves is that they work at
the moment they are called, and that a draft survives the wait.

Leftovers: every draft the run created (or may have created: an unknown outcome) is deleted at the
end, found by its `[Test VIPER xxxxxxxx]` subject marker.
"""

# French copy and deliberately typographic test text: long lines and look-alike characters are intended.
# ruff: noqa: E501, RUF001

import json
import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, allowlist_permits, parse_allowlist
from app.models import ContactMessage
from app.services.errors import ToolboxError
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.mcp_client import (
    TOOLS,
    DraftInput,
    McpMailToolbox,
    capture_trace,
)

logger = logging.getLogger(__name__)

MIN_DELAY_SECONDS = 20
MAX_DELAY_SECONDS = 300
DEFAULT_DELAY_SECONDS = 60
KEPT_RUNS = 5

# What a person can do about each failure code (French: shown as is).
HINTS: dict[str, str] = {
    "toolbox_not_configured": "Activer la Toolbox et renseigner ses adresses (Paramètres > Connexions).",
    "toolbox_not_connected": "Se connecter à la Toolbox (bouton « Connecter » de la carte).",
    "toolbox_auth_expired": "La connexion est expirée ou refusée : se reconnecter ; si cela revient, "
    "le jeton API Infomaniak de la Toolbox est peut-être à renouveler côté Toolbox.",
    "toolbox_unavailable": "La Toolbox (ou Infomaniak derrière elle) répond mal : voir le statut HTTP "
    "et le corps de la réponse dans l'échange brut.",
    "toolbox_timeout": "La Toolbox n'a pas répondu à temps : le délai est réglé par "
    "VIPER_TOOLBOX_TIMEOUT_MS ; un envoi en timeout peut être parti quand même.",
    "toolbox_invalid_response": "Réponse illisible : comparer avec l'échange brut (format JSON-RPC "
    "attendu).",
    "toolbox_rejected": "Refus au texte non reconnu par VIPER : le texte exact de la Toolbox est dans "
    "l'échange brut ; c'est le plus souvent la cause réelle d'un « brouillon non créé ».",
    "toolbox_outbound_blocked": "Destinataire hors de la liste d'envoi autorisée de la Toolbox.",
    "toolbox_invalid_input": "Paramètres refusés (adresse, objet, texte) avant ou par la Toolbox.",
    "toolbox_draft_not_found": "Brouillon inconnu de la boîte Infomaniak.",
}

OK, FAILED, EXPECTED, UNEXPECTED, SKIPPED = (
    "ok",
    "failed",
    "expected_error",
    "unexpected",
    "skipped",
)


@dataclass
class Step:
    key: str
    title: str
    # What the step should show, in words.
    expectation: str
    status: str = (
        "pending"  # pending | running | ok | failed | expected_error | unexpected | skipped
    )
    started_at: datetime | None = None
    duration_ms: int | None = None
    # What was sent / looked at, and what came back (identifiers, lengths, counts).
    context: dict[str, Any] = field(default_factory=dict)
    observed: dict[str, Any] = field(default_factory=dict)
    error: dict[str, Any] | None = None
    note: str | None = None
    # The raw HTTP / JSON-RPC exchange of the step.
    trace: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Run:
    id: str
    recipient: str
    send_real: bool
    delay_seconds: int
    started_at: datetime
    finished_at: datetime | None = None
    status: str = "running"  # running | done | crashed
    steps: list[Step] = field(default_factory=list)
    verdict: dict[str, Any] | None = None
    crash: str | None = None

    @property
    def marker(self) -> str:
        return f"[Test VIPER {self.id[:8]}]"


class _Abort(Exception):
    """A step the rest cannot go on without (e.g. the Toolbox is not connected)."""


def _toolbox_words(trace: list[dict[str, Any]]) -> str | None:
    """What the Toolbox itself said about the failure, from the raw exchange: its tool error text,
    its JSON-RPC error, or the HTTP status with the start of the body."""
    for event in reversed(trace):
        if event.get("outcome") == "tool_error":
            return str(event.get("text", ""))
        if event.get("outcome") == "rpc_error":
            return json.dumps(event.get("rpc_error"), ensure_ascii=False)
    for event in reversed(trace):
        status = event.get("http_status")
        if isinstance(status, int) and status >= 400:
            return f"HTTP {status} : {str(event.get('body', ''))[:600]}"
        if event.get("outcome") in ("transport_error", "timeout"):
            return f"{event.get('exception')} : {event.get('detail', '')}".strip(" :")
    return None


def _error_dict(error: BaseException) -> dict[str, Any]:
    if isinstance(error, ToolboxError):
        return {
            "code": error.code,
            "message": str(error),
            "retryable": error.retryable,
            "outcome_unknown": error.outcome_unknown,
            "upstream_status": error.upstream_status,
            "hint": HINTS.get(error.code),
        }
    return {
        "code": "unexpected_exception",
        "message": f"{type(error).__name__}: {str(error)[:500]}",
        "retryable": False,
        "outcome_unknown": False,
        "upstream_status": None,
        "hint": "Erreur inattendue côté VIPER : voir le journal du serveur.",
    }


# A realistic body: accents, typographic quotes, a link and the real signature layout.
REALISTIC_BODY = (
    "Bonjour Madame, Monsieur,\n\n"
    "Je me permets de vous relancer à propos d’un échange sur l’IA en logistique : "
    "« optimiser les tournées », réduire les coûts (–10 %) et automatiser le suivi.\n\n"
    "Œuvre commune, café, naïve, Zoë — 5 € / mois.\n\n"
    "Vous pouvez choisir votre créneau ici :\nhttps://calendly.com/experts-circoe/30min\n\n"
    "Au plaisir d’échanger avec vous,\n\nL’équipe CIRCOE\n\n"
    "Test VIPER\nChargé de projets, CIRCOE\n+33 (0)2 76 40 80 00 | www.circoe.com |\n"
    "32 rue Jules Lecesne 76600 Le Havre - France\n"
)


class DiagnosticRunner:
    """One run: builds the steps, executes them in order, never raises."""

    def __init__(
        self,
        run: Run,
        *,
        integration: ToolboxIntegration,
        settings: Settings,
        session_factory: sessionmaker[Session] | None,
        dispatch_reason: Callable[[], dict[str, Any]],
        lock: threading.Lock,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.run = run
        self.integration = integration
        self.settings = settings
        self.session_factory = session_factory
        self.dispatch_reason = dispatch_reason
        self.lock = lock
        self.sleep = sleep
        self.now = now
        self.toolbox: McpMailToolbox | None = None
        self.drafts: dict[str, str] = {}  # label -> remote draft id still to clean
        self.baseline_ids: set[str] = set()
        self.sent_draft_id: str | None = None
        self._abort = False

    # --- plumbing ---------------------------------------------------------------------------

    def _add(self, key: str, title: str, expectation: str) -> Step:
        step = Step(key, title, expectation)
        with self.lock:
            self.run.steps.append(step)
        return step

    def _step(
        self,
        key: str,
        title: str,
        expectation: str,
        action: Callable[[Step], dict[str, Any] | None],
        *,
        expect_error: str | None = None,
        critical: bool = False,
        needs: tuple[str, ...] = (),
    ) -> Step:
        """Run `action`, record its outcome. `expect_error`: a refusal the step must provoke (its
        `toolbox_*` code); `critical`: a failure stops the run; `needs`: draft labels required."""
        step = self._add(key, title, expectation)
        missing = [label for label in needs if label not in self.drafts]
        if self._abort or missing:
            step.status = SKIPPED
            step.note = (
                "Étape précédente bloquante en échec."
                if self._abort
                else "Brouillon nécessaire absent (étape précédente en échec)."
            )
            return step
        started = time.monotonic()
        step.status, step.started_at = "running", self.now()
        with capture_trace() as trace:
            try:
                observed = action(step)
            except ToolboxError as error:
                step.error = _error_dict(error)
                if expect_error is not None:
                    step.status = EXPECTED if error.code == expect_error else UNEXPECTED
                    if step.status == UNEXPECTED:
                        step.note = f"Code attendu {expect_error}, obtenu {error.code}."
                else:
                    step.status = FAILED
            except _Abort as error:
                step.status, step.error = FAILED, _error_dict(error)
                step.error["code"] = "diagnostic_aborted"
                step.error["message"] = str(error)
                self._abort = True
            except Exception as error:
                logger.exception("toolbox.diagnostic_step_crashed step=%s", key)
                step.status, step.error = FAILED, _error_dict(error)
            else:
                step.observed = observed or {}
                if expect_error is not None:
                    step.status = UNEXPECTED
                    step.note = f"Un refus {expect_error} était attendu : l'opération a réussi."
                else:
                    step.status = OK
            step.trace = list(trace)
            if step.error is not None:
                step.error["toolbox_text"] = _toolbox_words(step.trace)
        step.duration_ms = round((time.monotonic() - started) * 1000)
        if step.status == FAILED and critical:
            self._abort = True
        return step

    @property
    def mail(self) -> McpMailToolbox:
        assert self.toolbox is not None
        return self.toolbox

    def _subject(self, label: str) -> str:
        return f"{self.run.marker} {label}"

    def _create(self, step: Step, label: str, subject: str, text: str) -> str:
        step.context.update(
            tool=TOOLS["create_draft"],
            to=self.run.recipient,
            subject=subject,
            text_length=len(text),
        )
        draft_id = self.mail.create_draft(
            DraftInput(to=[self.run.recipient], subject=subject, text=text)
        )
        self.drafts[label] = draft_id
        step.observed["draft_id"] = draft_id
        return draft_id

    def _delete(self, step: Step, label: str) -> bool:
        draft_id = self.drafts[label]
        step.context.update(tool=TOOLS["delete_draft"], draft_id=draft_id)
        deleted = self.mail.delete_draft(draft_id)
        step.observed["deleted"] = deleted
        if deleted:
            del self.drafts[label]
        return deleted

    def _present(self, draft_id: str) -> tuple[bool, int]:
        listed = self.mail.list_drafts(100)
        return any(item.draft_id == draft_id for item in listed), len(listed)

    # --- the run ----------------------------------------------------------------------------

    def execute(self) -> None:
        try:
            self._scenario()
        except Exception as error:  # the runner itself broke: say so, keep what was recorded
            logger.exception("toolbox.diagnostic_crashed run=%s", self.run.id)
            self.run.status, self.run.crash = "crashed", f"{type(error).__name__}: {error}"
        finally:
            self._cleanup()
            self._finish()

    def _scenario(self) -> None:
        self._step(
            "config",
            "Configuration et connexion",
            "Toolbox activée, configurée et connectée ; destinataire de test autorisé.",
            self._config,
            critical=True,
        )
        self._step(
            "database",
            "Messages en erreur dans VIPER",
            "Aucun message validé/programmé avec un code d'erreur d'envoi (information).",
            self._database,
        )
        self._step(
            "tools",
            "Outils exposés par la Toolbox (tools/list)",
            "Les 4 outils mail utilisés par VIPER sont présents.",
            self._tools,
        )
        self._step(
            "list_baseline",
            "Lister les brouillons (accès à la boîte Infomaniak)",
            "La liste répond (peut être vide).",
            self._list_baseline,
        )
        self._step(
            "create",
            "Créer un brouillon simple",
            "Un identifiant de brouillon est renvoyé, rien n'est envoyé.",
            lambda step: {
                "draft_id": self._create(
                    step, "simple", self._subject("brouillon simple"), "Test de création."
                )
            },
        )
        self._step(
            "find",
            "Retrouver le brouillon dans la liste",
            "Le brouillon créé apparaît dans list_drafts (reprise après une issue inconnue).",
            self._find,
            needs=("simple",),
        )
        self._step(
            "create_special",
            "Créer un brouillon réaliste (accents, apostrophes, lien, signature)",
            "Les caractères français et typographiques passent sans refus.",
            self._create_special,
        )
        self._step(
            "create_long",
            "Créer un brouillon long (≈ 20 000 caractères)",
            "Un corps volumineux est accepté.",
            self._create_long,
        )
        self._step(
            "edit",
            "Modifier un brouillon (remplacement : créer le nouveau, supprimer l'ancien)",
            "Le nouveau brouillon existe, l'ancien a disparu de la liste.",
            self._edit,
            needs=("simple",),
        )
        self._step(
            "delete",
            "Supprimer un brouillon",
            "Suppression confirmée (deleted = true).",
            lambda step: {"deleted": self._delete(step, "special")},
            needs=("special",),
        )
        self._step(
            "delete_again",
            "Supprimer deux fois (idempotence)",
            "Le second appel répond « déjà absent » sans erreur.",
            self._delete_again,
            needs=("long",),
        )
        self._negatives()
        if self.run.send_real:
            self._scheduled_send()
        else:
            for key, title in (
                ("schedule", "Envoi programmé : attente puis changement de date"),
                ("send", "Envoi réel du brouillon"),
                ("send_twice", "Second envoi du même brouillon"),
            ):
                step = self._add(key, title, "Nécessite « Envoyer pour de vrai ».")
                step.status, step.note = SKIPPED, "Envoi réel non demandé."

    # --- steps ------------------------------------------------------------------------------

    def _config(self, step: Step) -> dict[str, Any]:
        status = self.integration.status()
        settings = self.settings
        allowlist = (
            parse_allowlist(settings.infomaniak_send_allowlist)
            if settings.infomaniak_send_allowlist
            else None
        )
        permitted = allowlist_permits(allowlist, [self.run.recipient])
        dispatch = self.dispatch_reason()
        step.context.update(
            recipient=self.run.recipient, toolbox_timeout_ms=settings.toolbox_timeout_ms
        )
        step.observed = {
            "enabled": status.enabled,
            "state": status.state,
            "missing_settings": status.missing,
            "toolbox_origin": status.toolbox_origin,
            "connected_at": status.connected_at.isoformat() if status.connected_at else None,
            "connected_by": status.connected_by,
            "token_expires_at": status.expires_at.isoformat() if status.expires_at else None,
            "last_connection_error": status.last_error.model_dump(mode="json")
            if status.last_error
            else None,
            "viper_send_allowlist": list(allowlist) if allowlist is not None else None,
            "recipient_permitted_by_viper_allowlist": permitted,
            **dispatch,
        }
        if not permitted:
            step.note = (
                "Le destinataire n'est pas dans VIPER_INFOMANIAK_SEND_ALLOWLIST : le dispatcher de VIPER "
                "refuserait cet envoi ; le test, lui, parle directement à la Toolbox."
            )
        self.toolbox = self.integration.required_mail_toolbox()  # type: ignore[assignment]
        return step.observed

    def _database(self, step: Step) -> dict[str, Any]:
        if self.session_factory is None:
            step.note = "Base non disponible dans ce contexte."
            return {}
        with self.session_factory() as session:
            rows = session.execute(
                select(ContactMessage.status, ContactMessage.last_error_code, func.count())
                .where(ContactMessage.last_error_code.is_not(None))
                .group_by(ContactMessage.status, ContactMessage.last_error_code)
            ).all()
            latest = session.scalar(select(func.max(ContactMessage.last_error_at)))
        errors = [
            {"status": str(s.value if hasattr(s, "value") else s), "code": c, "count": n}
            for s, c, n in rows
        ]
        step.observed = {
            "messages_with_error": sum(item["count"] for item in errors),
            "by_status_and_code": errors,
            "latest_error_at": latest.isoformat() if latest else None,
        }
        if errors:
            step.note = (
                "Information, pas un échec : le code final d'un envoi raté est souvent "
                "send_draft_not_created ; la cause réelle est dans le journal d'audit "
                "(remote_draft_failed) et dans les étapes suivantes."
            )
        return step.observed

    def _tools(self, step: Step) -> dict[str, Any]:
        step.context["tool"] = "tools/list"
        names = {tool.name for tool in self.mail.list_tools()}
        required = set(TOOLS.values())
        missing = sorted(required - names)
        step.observed = {"offered": sorted(names), "missing": missing}
        if missing:
            raise _Abort(f"Outils manquants côté Toolbox : {', '.join(missing)}.")
        return step.observed

    def _list_baseline(self, step: Step) -> dict[str, Any]:
        step.context["tool"] = TOOLS["list_drafts"]
        listed = self.mail.list_drafts(100)
        self.baseline_ids = {item.draft_id for item in listed}
        step.observed = {
            "drafts_in_mailbox": len(listed),
            "sample_subjects": [item.subject for item in listed[:5]],
        }
        return step.observed

    def _find(self, step: Step) -> dict[str, Any]:
        draft_id = self.drafts["simple"]
        step.context.update(tool=TOOLS["list_drafts"], looking_for=draft_id)
        found, count = self._present(draft_id)
        step.observed = {"found": found, "drafts_in_mailbox": count}
        if not found:
            raise ToolboxMismatch(
                "Le brouillon créé n'apparaît pas dans list_drafts : la reprise après un timeout de "
                "VIPER ne pourrait pas le retrouver."
            )
        return step.observed

    def _create_special(self, step: Step) -> dict[str, Any]:
        self._create(
            step,
            "special",
            self._subject("Un échange sur l’IA : Œuvre, café – 5 €"),
            REALISTIC_BODY,
        )
        return step.observed

    def _create_long(self, step: Step) -> dict[str, Any]:
        paragraph = (
            "Paragraphe de test avec des accents éàùç et une phrase assez longue. " * 4 + "\n"
        )
        text = (paragraph * 80)[:20_000]
        self._create(step, "long", self._subject("brouillon long"), text)
        return step.observed

    def _edit(self, step: Step) -> dict[str, Any]:
        old_id = self.drafts["simple"]
        new_id = self._create(step, "edited", self._subject("brouillon modifié"), "Texte modifié.")
        step.context["replaces"] = old_id
        deleted = self.mail.delete_draft(old_id)
        del self.drafts["simple"]
        old_present, _ = self._present(old_id)
        new_present, _ = self._present(new_id)
        step.observed.update(
            old_deleted=deleted, old_still_listed=old_present, new_listed=new_present
        )
        if old_present or not new_present:
            raise ToolboxMismatch("Après la modification, la liste des brouillons est incohérente.")
        return step.observed

    def _delete_again(self, step: Step) -> dict[str, Any]:
        first = self._delete(step, "long")
        second = self.mail.delete_draft(step.context["draft_id"])
        step.observed.update(first_deleted=first, second_deleted=second)
        if second:
            raise ToolboxMismatch(
                "Le second appel a de nouveau « supprimé » : la suppression n'est pas idempotente."
            )
        return step.observed

    def _negatives(self) -> None:
        def create_with(**changes: Any) -> Callable[[Step], dict[str, Any]]:
            def run(step: Step) -> dict[str, Any]:
                values: dict[str, Any] = {
                    "to": [self.run.recipient],
                    "subject": self._subject("refus"),
                    "text": "x",
                    **changes,
                }
                step.context.update(
                    tool=TOOLS["create_draft"], **{k: _short(v) for k, v in changes.items()}
                )
                self.mail.create_draft(DraftInput(**values))
                return {}

            return run

        self._step(
            "refuse_address",
            "Refus : adresse invalide",
            "toolbox_invalid_input, sans appel réseau.",
            create_with(to=["pas-une-adresse"]),
            expect_error="toolbox_invalid_input",
        )
        self._step(
            "refuse_subject_empty",
            "Refus : objet vide",
            "toolbox_invalid_input, sans appel réseau.",
            create_with(subject="   "),
            expect_error="toolbox_invalid_input",
        )
        self._step(
            "refuse_subject_long",
            "Refus : objet de plus de 500 caractères",
            "toolbox_invalid_input, sans appel réseau.",
            create_with(subject="x" * 501),
            expect_error="toolbox_invalid_input",
        )

        def unknown_send(step: Step) -> dict[str, Any]:
            step.context.update(tool=TOOLS["send_draft"], draft_id="inexistant-diagnostic")
            self.mail.send_draft("inexistant-diagnostic")
            return {}

        self._step(
            "send_unknown",
            "Refus : envoyer un brouillon inconnu",
            "toolbox_draft_not_found (rien ne part).",
            unknown_send,
            expect_error="toolbox_draft_not_found",
        )

        def unknown_delete(step: Step) -> dict[str, Any]:
            step.context.update(tool=TOOLS["delete_draft"], draft_id="inexistant-diagnostic")
            return {"deleted": self.mail.delete_draft("inexistant-diagnostic")}

        self._step(
            "delete_unknown",
            "Supprimer un brouillon inconnu",
            "Répond « déjà absent » (deleted = false), pas d'erreur.",
            unknown_delete,
        )

    def _scheduled_send(self) -> None:
        delay = self.run.delay_seconds
        plan: dict[str, datetime] = {}

        def schedule(step: Step) -> dict[str, Any]:
            created = self._create(
                step, "scheduled", self._subject("envoi programmé"), REALISTIC_BODY
            )
            first = self.now() + timedelta(seconds=delay)
            plan["due"] = first
            step.context["scheduled_at"] = first.isoformat()
            # The page moves the date: later by a third of the delay. The draft must not be touched.
            self.sleep(max(3, delay // 6))
            moved = first + timedelta(seconds=max(5, delay // 3))
            plan["due"] = moved
            still, _ = self._present(created)
            step.observed.update(rescheduled_to=moved.isoformat(), draft_still_listed=still)
            if not still:
                raise ToolboxMismatch("Le brouillon a disparu pendant l'attente.")
            return step.observed

        self._step(
            "schedule",
            f"Envoi programmé dans {delay} s, puis changement de date",
            "Le brouillon attend sans être modifié ; la date est repoussée ; il existe encore à l'échéance.",
            schedule,
            critical=False,
        )

        def send(step: Step) -> dict[str, Any]:
            due = plan["due"]
            wait = (due - self.now()).total_seconds()
            if wait > 0:
                self.sleep(wait)
            draft_id = self.drafts["scheduled"]
            step.context.update(
                tool=TOOLS["send_draft"],
                draft_id=draft_id,
                to=self.run.recipient,
                due_at=due.isoformat(),
                waited_seconds=round(max(wait, 0)),
            )
            result = self.mail.send_draft(draft_id)
            step.observed.update(
                sent=True, transport=result.transport, cancel_resource=result.cancel_resource
            )
            del self.drafts["scheduled"]
            self.sent_draft_id = draft_id
            for _ in range(3):
                listed, _count = self._present(draft_id)
                step.observed["still_in_drafts_after_send"] = listed
                if not listed:
                    break
                self.sleep(2)
            return step.observed

        self._step(
            "send",
            "Envoi réel au destinataire de test (à l'échéance)",
            "send_draft confirme l'envoi ; le brouillon quitte la liste ; le mail arrive à l'adresse de test.",
            send,
            needs=("scheduled",),
        )

        def send_twice(step: Step) -> dict[str, Any]:
            draft_id = self.sent_draft_id or ""
            step.context.update(tool=TOOLS["send_draft"], draft_id=draft_id)
            self.mail.send_draft(draft_id)
            return {}

        if self.sent_draft_id is None:
            step = self._add(
                "send_twice", "Second envoi du même brouillon", "Refusé : aucun doublon possible."
            )
            step.status, step.note = SKIPPED, "Pas d'envoi réussi à rejouer."
            return
        self._step(
            "send_twice",
            "Second envoi du même brouillon",
            "Refusé (toolbox_draft_not_found) : aucun doublon possible.",
            send_twice,
            expect_error="toolbox_draft_not_found",
        )

    # --- end --------------------------------------------------------------------------------

    def _cleanup(self) -> None:
        step = self._add(
            "cleanup", "Nettoyage des brouillons de test", "Aucun brouillon de test ne reste."
        )
        if self.toolbox is None:
            step.status, step.note = SKIPPED, "Pas de connexion : rien créé."
            return
        started = time.monotonic()
        step.status, step.started_at = "running", self.now()
        removed: list[str] = []
        with capture_trace() as trace:
            try:
                leftovers = {
                    item.draft_id
                    for item in self.mail.list_drafts(100)
                    if item.subject.startswith(self.run.marker)
                } | set(self.drafts.values())
                for draft_id in sorted(leftovers):
                    if self.mail.delete_draft(draft_id):
                        removed.append(draft_id)
                self.drafts.clear()
                step.status = OK
            except Exception as error:
                step.status, step.error = FAILED, _error_dict(error)
                step.note = (
                    "Des brouillons « [Test VIPER …] » sont peut-être à supprimer à la main."
                )
            step.trace = list(trace)
            if step.error is not None:
                step.error["toolbox_text"] = _toolbox_words(step.trace)
        step.observed = {"removed": removed}
        step.duration_ms = round((time.monotonic() - started) * 1000)

    def _finish(self) -> None:
        steps = self.run.steps
        counts: dict[str, int] = {}
        for step in steps:
            counts[step.status] = counts.get(step.status, 0) + 1
        problems = [s for s in steps if s.status in (FAILED, UNEXPECTED)]
        first = problems[0] if problems else None
        self.run.verdict = {
            "ok": not problems and self.run.status != "crashed",
            "counts": counts,
            "problems": [s.key for s in problems],
            "first_problem": (
                {
                    "step": first.key,
                    "title": first.title,
                    "code": first.error["code"] if first.error else None,
                    "hint": first.error.get("hint") if first.error else first.note,
                }
                if first
                else None
            ),
        }
        self.run.finished_at = self.now()
        if self.run.status == "running":
            self.run.status = "done"
        logger.info(
            "toolbox.diagnostic_done run=%s ok=%s counts=%s",
            self.run.id,
            self.run.verdict["ok"],
            counts,
        )


class ToolboxMismatch(ToolboxError):
    """The Toolbox answered, but not with what VIPER relies on."""

    def __init__(self, message: str) -> None:
        super().__init__("toolbox_invalid_response", 502, message)


def _short(value: Any) -> Any:
    return (
        value
        if not isinstance(value, str) or len(value) <= 80
        else f"{value[:80]}… ({len(value)} car.)"
    )


class ToolboxDiagnostics:
    """The runs of one process: at most one at a time, the last few kept for the page."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: list[Run] = []

    def start(
        self,
        *,
        recipient: str,
        send_real: bool,
        delay_seconds: int,
        integration: ToolboxIntegration,
        settings: Settings,
        session_factory: sessionmaker[Session] | None,
        dispatch_reason: Callable[[], dict[str, Any]],
        blocking: bool = False,
        sleep: Callable[[float], None] = time.sleep,
    ) -> Run | None:
        """Start a run; None while another one is still going."""
        with self._lock:
            if any(run.status == "running" for run in self._runs):
                return None
            run = Run(
                id=uuid.uuid4().hex,
                recipient=recipient,
                send_real=send_real,
                delay_seconds=max(MIN_DELAY_SECONDS, min(MAX_DELAY_SECONDS, delay_seconds)),
                started_at=datetime.now(UTC),
            )
            self._runs.append(run)
            del self._runs[:-KEPT_RUNS]
        runner = DiagnosticRunner(
            run,
            integration=integration,
            settings=settings,
            session_factory=session_factory,
            dispatch_reason=dispatch_reason,
            lock=self._lock,
            sleep=sleep,
        )
        if blocking:
            runner.execute()
        else:
            threading.Thread(target=runner.execute, name="toolbox-diagnostic", daemon=True).start()
        return run

    def latest(self) -> Run | None:
        with self._lock:
            return self._runs[-1] if self._runs else None

    def clear(self) -> bool:
        """Forget the finished runs (a run in progress stays: its thread keeps writing).
        False when a run is still going."""
        with self._lock:
            if any(run.status == "running" for run in self._runs):
                return False
            self._runs.clear()
            return True

    def get(self, run_id: str) -> Run | None:
        with self._lock:
            return next((run for run in self._runs if run.id == run_id), None)

    def snapshot(self, run: Run) -> dict[str, Any]:
        """A JSON-ready copy, taken under the lock (the thread keeps writing)."""
        for _ in range(5):
            try:
                return asdict(run)  # the thread may write meanwhile: a torn copy is simply retried
            except RuntimeError:
                time.sleep(0.01)
        with self._lock:
            return asdict(run)
