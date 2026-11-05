"""Allow five independent Contact chart date annotations, without changing message dates."""

from collections.abc import Sequence

from alembic import op

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    keys = ["contact.max_follow_ups", *(f"contact.chart.date_{slot}" for slot in range(5))]
    op.drop_constraint(op.f("ck_app_settings_known_key"), "app_settings", type_="check")
    op.create_check_constraint(
        op.f("ck_app_settings_known_key"),
        "app_settings",
        f"key IN ({', '.join(repr(key) for key in keys)})",
    )


def downgrade() -> None:
    # A downgrade must explicitly remove the annotations introduced by this revision.
    op.execute("DELETE FROM app_settings WHERE key LIKE 'contact.chart.date_%'")
    op.drop_constraint(op.f("ck_app_settings_known_key"), "app_settings", type_="check")
    op.create_check_constraint(
        op.f("ck_app_settings_known_key"), "app_settings", "key = 'contact.max_follow_ups'"
    )
