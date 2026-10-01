"""Contact messages (`contact_messages`, Contact port Slice S3, reshaped by the sequences rework
D6): one durable mail per contact sequence and rank (0 = Contact, 1 = R1, 2 = R2, …), separate
from the prospect's commercial state. A `sent` row is also the record of a real send, whoever made
it (`sent_source`: a person's « Marquer comme envoyé », an import, migration 0010 or the
dispatcher): the prospect's level is the number of sent rows of its current sequence.

Integrity is enforced in SQL as well as in `app.services.contact_messages` (the only application
write path), so Database Explorer or a raw write cannot produce an impossible row:

- `validated`/`scheduled` carry a *current* human validation (`validated_revision = revision`),
  and so does a `sent` row sent by the dispatcher (`worker`); a send recorded by a person, an
  import or a migration may have no validation (the mail left outside VIPER). An edit bumps
  `revision`, so it must go back to `draft` (decision 24); a `draft` carries no validation;
- `scheduled` has its `scheduled_at` (a timestamp, never the next due date: decision 14);
  `sent` ⇔ `sent_at` ⇔ `sent_source`; `cancelled` ⇔ `cancelled_at`;
- the sequence belongs to the same prospect (composite foreign key);
- a remote Toolbox draft only on a validated/scheduled/sent message; a dispatch claim is complete
  (id + moment) and only on scheduled/sent; an error code always has its moment;
- a `sent` row is immutable (trigger `reject_sent_change`, decision 21); deleting the prospect
  deletes its messages (cascade).

The generation (S5), remote draft (S6) and dispatch (S7) columns exist from the start so those
Slices need no migration of this table. Content (from/to/cc/bcc/subject/body) never enters the
audit log in clear (`app.core.audit_policy` masks it).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.contact_steps import step_code
from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import ContactMessageStatus, SendSource

EMAIL_MAX_LENGTH = 320
SUBJECT_MAX_LENGTH = 998  # RFC 5322 line limit
VALIDATED_STATUSES_SQL = "'validated', 'scheduled', 'sent'"


def _recipients() -> Mapped[list[str]]:
    return mapped_column(ARRAY(String(EMAIL_MAX_LENGTH)), server_default=text("'{}'"))


class ContactMessage(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "contact_messages"
    __table_args__ = (
        UniqueConstraint("sequence_id", "rank"),
        ForeignKeyConstraint(
            ["prospect_id", "sequence_id"],
            ["contact_sequences.prospect_id", "contact_sequences.id"],
            ondelete="CASCADE",
            name="fk_contact_messages_sequence",
        ),
        # Serves the composite key and the prospect lookups.
        Index("ix_contact_messages_prospect_id_sequence_id", "prospect_id", "sequence_id"),
        CheckConstraint("rank >= 0", name="rank_non_negative"),
        CheckConstraint("revision >= 1", name="revision_positive"),
        CheckConstraint(
            "validated_revision IS NULL OR validated_revision <= revision",
            name="validated_revision_known",
        ),
        CheckConstraint("dispatch_attempts >= 0", name="dispatch_attempts_non_negative"),
        CheckConstraint(
            "status <> 'scheduled' OR scheduled_at IS NOT NULL", name="scheduled_has_moment"
        ),
        CheckConstraint("(status = 'sent') = (sent_at IS NOT NULL)", name="sent_has_moment"),
        CheckConstraint("(status = 'sent') = (sent_source IS NOT NULL)", name="sent_has_source"),
        CheckConstraint(
            "(status = 'cancelled') = (cancelled_at IS NOT NULL)", name="cancelled_has_moment"
        ),
        CheckConstraint(
            "status NOT IN ('validated', 'scheduled') AND (status <> 'sent' OR sent_source <> "
            "'worker') OR (validated_at IS NOT NULL AND validated_by_actor_id IS NOT NULL "
            "AND validated_revision = revision)",
            name="validation_current",
        ),
        CheckConstraint(
            "status <> 'draft' OR (validated_at IS NULL AND validated_by_actor_id IS NULL "
            "AND validated_revision IS NULL)",
            name="draft_not_validated",
        ),
        CheckConstraint(
            "remote_draft_id IS NULL OR (remote_provider IS NOT NULL "
            f"AND status IN ({VALIDATED_STATUSES_SQL}))",
            name="remote_draft_validated",
        ),
        CheckConstraint(
            "(dispatch_claim_id IS NULL) = (dispatch_claimed_at IS NULL)",
            name="dispatch_claim_complete",
        ),
        CheckConstraint(
            "dispatch_claim_id IS NULL OR status IN ('scheduled', 'sent')",
            name="dispatch_claim_scheduled",
        ),
        CheckConstraint(
            "(last_error_code IS NULL) = (last_error_at IS NULL)", name="last_error_complete"
        ),
        # The dispatcher's scan (S7): scheduled messages by due moment.
        Index(
            "ix_contact_messages_scheduled_at_due",
            "scheduled_at",
            postgresql_where=text("status = 'scheduled'"),
        ),
        # A remote draft belongs to one message; a dispatch claim is an idempotency key.
        Index(
            "uq_contact_messages_remote_draft",
            "remote_provider",
            "remote_draft_id",
            unique=True,
            postgresql_where=text("remote_draft_id IS NOT NULL"),
        ),
        Index(
            "uq_contact_messages_dispatch_claim_id",
            "dispatch_claim_id",
            unique=True,
            postgresql_where=text("dispatch_claim_id IS NOT NULL"),
        ),
    )

    # The prospect of the sequence (composite key): the audit subject and the prospect lookups.
    prospect_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    sequence_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    # 0 = Contact, n = Rn; unique within the sequence.
    rank: Mapped[int] = mapped_column(Integer)
    status: Mapped[ContactMessageStatus] = mapped_column(
        text_enum(ContactMessageStatus, "status"),
        server_default=ContactMessageStatus.DRAFT.value,
    )
    from_email: Mapped[str | None] = mapped_column(String(EMAIL_MAX_LENGTH))
    to_recipients: Mapped[list[str]] = _recipients()
    cc_recipients: Mapped[list[str]] = _recipients()
    bcc_recipients: Mapped[list[str]] = _recipients()
    subject: Mapped[str] = mapped_column(String(SUBJECT_MAX_LENGTH), server_default="")
    body_text: Mapped[str] = mapped_column(Text, server_default="")
    # Bumped by every content change (and a reopening); the optimistic-concurrency token.
    revision: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    # The human validation of one precise revision (decision 23).
    validated_revision: Mapped[int | None] = mapped_column(Integer)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    validated_by_actor_id: Mapped[str | None] = mapped_column(String(128))
    validated_by_display: Mapped[str | None] = mapped_column(String(255))
    # Send moment chosen by a person (decision 25); never derived from the next-action week.
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_source: Mapped[SendSource | None] = mapped_column(text_enum(SendSource, "sent_source"))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # `manual`, or `prospect_state:<state>` for the mechanical cancellation (decision 29).
    cancel_reason: Mapped[str | None] = mapped_column(String(64))
    # AI drafting (S5): what produced the current text; the result is always a draft (decision 22).
    generation_model: Mapped[str | None] = mapped_column(String(200))
    generation_prompt_version: Mapped[str | None] = mapped_column(String(200))
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # CIRCOE Toolbox (S6): the Infomaniak draft of the validated revision, then the sent mail id.
    remote_provider: Mapped[str | None] = mapped_column(String(64))
    remote_draft_id: Mapped[str | None] = mapped_column(String(255))
    remote_message_id: Mapped[str | None] = mapped_column(String(255))
    # Scheduled dispatch (S7): idempotent claim, attempts and the last error *code* (never a raw
    # provider message, which may quote an address).
    dispatch_claim_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    dispatch_claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dispatch_attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    last_error_code: Mapped[str | None] = mapped_column(String(64))
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @property
    def step(self) -> str:
        """The step code of the rank: `contact`, `r1`, `r2`…"""
        return step_code(self.rank)
