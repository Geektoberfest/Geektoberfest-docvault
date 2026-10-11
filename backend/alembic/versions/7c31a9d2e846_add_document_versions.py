"""Add document version history and backfill existing files as version 1."""
from alembic import op
import sqlalchemy as sa

revision = "7c31a9d2e846"
down_revision = "4dddea78c22c"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("documents", sa.Column("current_version", sa.Integer(), nullable=False, server_default="1"))
    op.create_table(
        "document_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("filename", sa.String()),
        sa.Column("original_filename", sa.String()),
        sa.Column("file_path", sa.String()),
        sa.Column("file_size", sa.Integer()),
        sa.Column("content_type", sa.String()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("document_id", "version_number", name="uq_document_version"),
    )
    op.execute(sa.text("""
        INSERT INTO document_versions
            (document_id, version_number, filename, original_filename, file_path,
             file_size, content_type, created_at)
        SELECT id, 1, filename, original_filename, file_path,
               file_size, content_type, COALESCE(created_at, CURRENT_TIMESTAMP)
        FROM documents
    """))


def downgrade():
    # The current file remains available through the existing documents table.
    op.drop_table("document_versions")
    op.drop_column("documents", "current_version")
