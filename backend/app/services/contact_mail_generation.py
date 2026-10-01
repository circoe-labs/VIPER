"""AI drafting of a Contact / R1 / R2 message (Contact port Slice S5; handoff Task 14, decisions 22
and 26). The AI only writes the subject and the body:

1. `prepare` — before any AI call (no data sent for nothing): a person, the prospect exists, the
   sequence is open, the step is neither sent, cancelled, being sent nor scheduled (unschedule
   first), the `expected_revision` is the current one, and replacing a saved text was confirmed
   (`replace`); then the prompt is built from the minimal data (`mail_generation.prompt`);
2. `draft` — the AI call (`MailGenerator`), without any database transaction open: it can last a
   minute; its output is validated by the adapter;
3. `contact_messages.save_generated` — in its own transaction, which checks everything again
   (revision, sequence, scheduled): the result is always a `draft`, the model and the prompt version
   are recorded, a validated message goes back to draft (to validate again).

The prospect's state never changes, nothing is validated or scheduled; a failed AI call writes
nothing (neither the message nor an audit event). Port of the reference
`src/server/contactMailGenerationService.ts`.
"""

import logging
import time
import uuid
from dataclasses import dataclass
from http import HTTPStatus

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import (
    ActivityCategory,
    CommercialSegment,
    Company,
    ContactMessage,
    Prospect,
    Role,
    company_activity_categories,
)
from app.models.enums import Civility, ContactMessageStatus, ContactMessageStep
from app.services.contact_messages import (
    STEPS,
    get_message,
    require_generation_target,
    sequence_context,
)
from app.services.contact_sequences import current_sequence
from app.services.contact_workflow import MESSAGE_STATUS_LABELS
from app.services.errors import ActorNotAllowedError, ContactMessageError, MailGenerationError
from app.services.mail_generation.openai_client import (
    GeneratedMail,
    MailGenerator,
    generation_error,
)
from app.services.mail_generation.prompt import (
    CompanyFacts,
    CurrentVersion,
    MailContext,
    MailPrompt,
    PreviousMessage,
    ProspectFacts,
    build_prompt,
)

logger = logging.getLogger(__name__)

# As written in a salutation's data (« Mme Martin »), like the export and the history.
CIVILITY_LABELS = {Civility.MR: "M.", Civility.MS: "Mme"}


@dataclass(frozen=True, slots=True)
class GenerationRequest:
    # None: the step has no message yet. Else the revision the client read.
    expected_revision: int | None = None
    # The person's short instruction (« consigne ») for this version.
    instruction: str | None = None
    # The person confirmed that the saved subject/body are replaced.
    replace: bool = False


def _has_text(message: ContactMessage | None) -> bool:
    return message is not None and bool(message.subject.strip() or message.body_text.strip())


def load_context(
    session: Session,
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    *,
    instruction: str | None,
    booking_url: str | None,
) -> MailContext:
    """The prompt's data: the minimal facts, never an address, a phone, a SIREN or a note; the
    earlier steps' recorded messages (cancelled or empty ones excluded)."""
    row = session.execute(
        select(
            Prospect.civility,
            Prospect.first_name,
            Prospect.last_name,
            Prospect.exact_job_title,
            Role.label,
            Company.id,
            Company.display_name,
            Company.website_url,
            Company.size_label,
            CommercialSegment.label,
            Company.project_done_with_circoe,
            Company.project_type,
            Company.circoe_references,
            Company.client_approach,
        )
        .outerjoin(Role, Role.id == Prospect.role_id)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .outerjoin(CommercialSegment, CommercialSegment.id == Company.commercial_segment_id)
        .where(Prospect.id == prospect_id)
    ).one()
    (civility, first, last, title, role, company_id, name, website, size, segment) = row[:10]
    categories = (
        list(
            session.scalars(
                select(ActivityCategory.label)
                .join(
                    company_activity_categories,
                    company_activity_categories.c.activity_category_id == ActivityCategory.id,
                )
                .where(company_activity_categories.c.company_id == company_id)
                .order_by(ActivityCategory.label)
            )
        )
        if company_id is not None
        else []
    )
    # The current sequence's messages only: a former sequence's mails belong to another cohort.
    sequence = current_sequence(session, prospect_id)
    messages = {
        message_step: message
        for message in (
            session.scalars(select(ContactMessage).where(ContactMessage.sequence_id == sequence.id))
            if sequence is not None
            else []
        )
        if (message_step := message.step) is not None
    }
    earlier = STEPS[: STEPS.index(step)]
    previous = [
        PreviousMessage(
            step=earlier_step,
            status_label=MESSAGE_STATUS_LABELS[message.status],
            subject=message.subject,
            body=message.body_text,
        )
        for earlier_step, message in ((s, messages.get(s)) for s in earlier)
        if message is not None
        and message.status is not ContactMessageStatus.CANCELLED
        and _has_text(message)
    ]
    current = messages.get(step)
    return MailContext(
        step=step,
        prospect=ProspectFacts(
            civility=CIVILITY_LABELS[civility] if civility else None,
            first_name=first,
            last_name=last,
            job_title=title,
            role=role,
        ),
        company=CompanyFacts(
            name=name,
            website=website,
            size_label=size,
            segment=segment,
            activity_categories=tuple(categories),
            project_done_with_circoe=row[10],
            project_type=row[11],
            circoe_references=row[12],
            client_approach=row[13],
        ),
        previous_messages=tuple(previous),
        current_version=(
            CurrentVersion(subject=current.subject, body=current.body_text) if current else None
        ),
        instruction=instruction,
        booking_url=booking_url,
    )


def prepare(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    request: GenerationRequest,
    *,
    booking_url: str | None,
) -> MailPrompt:
    """The refusals before any AI call, then the prompt. Reads only (no lock is taken)."""
    if actor.type is not ActorType.HUMAN or not actor.id:
        raise ActorNotAllowedError("A Contact message is handled by a person.")
    context = sequence_context(session, prospect_id)
    message = get_message(session, prospect_id, step)
    require_generation_target(context, message, request.expected_revision)
    if _has_text(message) and not request.replace:
        raise ContactMessageError(
            "replace_confirmation_required",
            HTTPStatus.CONFLICT,
            "The message already has a text: confirm that the AI draft replaces it.",
        )
    instruction = (request.instruction or "").strip() or None
    return build_prompt(
        load_context(session, prospect_id, step, instruction=instruction, booking_url=booking_url)
    )


def draft(
    generator: MailGenerator,
    prompt: MailPrompt,
    *,
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
) -> GeneratedMail:
    """Call the AI. Logged without personal data: ids, step, code, upstream status and type,
    duration — never the prompt, the answer or the key."""
    started = time.monotonic()
    logger.info("mail_generation.started prospect=%s step=%s", prospect_id, step.value)
    try:
        mail = generator.generate(prompt)
    except MailGenerationError as error:
        logger.warning(
            "mail_generation.failed prospect=%s step=%s code=%s upstream_status=%s "
            "upstream_code=%s duration=%.1fs",
            prospect_id,
            step.value,
            error.code,
            error.upstream_status,
            error.upstream_code,
            time.monotonic() - started,
        )
        raise
    except Exception as error:
        # An adapter defect (not a typed failure): logged with its type, answered as an upstream
        # error so the person reads that nothing was saved; the traceback stays in the log.
        logger.exception(
            "mail_generation.crashed prospect=%s step=%s error=%s",
            prospect_id,
            step.value,
            type(error).__name__,
        )
        raise generation_error(
            "ai_upstream_error", "AI drafting failed unexpectedly: nothing was saved."
        ) from error
    logger.info(
        "mail_generation.succeeded prospect=%s step=%s model=%s duration=%.1fs",
        prospect_id,
        step.value,
        mail.model,
        time.monotonic() - started,
    )
    return mail
