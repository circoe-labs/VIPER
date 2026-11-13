"""Mission sources: saved links, reusable across missions.

Revision ID: 0044
Revises: 0043
"""
import sqlalchemy as sa
from alembic import op

revision = '0044'
down_revision = '0043'
branch_labels = None
depends_on = None

CIRCOE_ID = '01a00000-0000-7000-8000-00000000c1c0'


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    ]


def _trigger(table: str) -> None:
    op.execute(
        f'CREATE TRIGGER set_updated_at BEFORE UPDATE ON {table} '
        'FOR EACH ROW EXECUTE FUNCTION set_updated_at()'
    )


def upgrade() -> None:
    op.create_table(
        'mission_sources',
        sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('organization_id', sa.Uuid(), server_default=sa.text(f"'{CIRCOE_ID}'::uuid"), nullable=False),
        sa.Column('url', sa.String(2000), nullable=False),
        sa.Column('label', sa.String(200), nullable=True),
        sa.Column('created_by_display', sa.String(255), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "btrim(url) <> '' AND char_length(url) <= 2000", name=op.f('ck_mission_sources_url_valid')
        ),
        sa.ForeignKeyConstraint(
            ['organization_id'], ['organizations.id'],
            name=op.f('fk_mission_sources_organization_id_organizations'), ondelete='RESTRICT',
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_mission_sources')),
    )
    op.create_index(op.f('ix_mission_sources_organization_id'), 'mission_sources', ['organization_id'])
    op.create_index(
        'uq_mission_sources_organization_url', 'mission_sources', ['organization_id', 'url'], unique=True
    )
    _trigger('mission_sources')

    op.create_table(
        'mission_source_links',
        sa.Column('id', sa.Uuid(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('mission_id', sa.Uuid(), nullable=False),
        sa.Column('source_id', sa.Uuid(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ['mission_id'], ['missions.id'],
            name=op.f('fk_mission_source_links_mission_id_missions'), ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['source_id'], ['mission_sources.id'],
            name=op.f('fk_mission_source_links_source_id_mission_sources'), ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_mission_source_links')),
    )
    op.create_index(op.f('ix_mission_source_links_mission_id'), 'mission_source_links', ['mission_id'])
    op.create_index(op.f('ix_mission_source_links_source_id'), 'mission_source_links', ['source_id'])
    op.create_index(
        'uq_mission_source_links_pair', 'mission_source_links', ['mission_id', 'source_id'], unique=True
    )
    _trigger('mission_source_links')


def downgrade() -> None:
    op.drop_table('mission_source_links')
    op.drop_table('mission_sources')
