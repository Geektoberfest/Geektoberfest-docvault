"""Optional PostgreSQL checks, isolated in a temporary schema per test."""
import os
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app import auth, document_files
from app.database import get_db
from app.routes import documents

BACKEND = Path(__file__).resolve().parents[1]
TEST_URL = os.getenv("VERSION_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "Set VERSION_TEST_DATABASE_URL to run PostgreSQL migration/concurrency tests")
class PostgresVersionTests(unittest.TestCase):
    def setUp(self):
        self.schema = "version_test_" + uuid.uuid4().hex
        self.admin = create_engine(TEST_URL)
        self.addCleanup(self.admin.dispose)
        with self.admin.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.addCleanup(self.drop_schema)
        self.url = make_url(TEST_URL).update_query_dict({"options": f"-csearch_path={self.schema}"}).render_as_string(hide_password=False)
        self.engine = create_engine(self.url)
        self.addCleanup(self.engine.dispose)
        self.config = Config(str(BACKEND / "alembic.ini"))
        self.config.set_main_option("script_location", str(BACKEND / "alembic"))
        self.storage = tempfile.TemporaryDirectory()
        self.addCleanup(self.storage.cleanup)
        self.storage_patch = patch.object(document_files, "UPLOAD_DIR", self.storage.name)
        self.storage_patch.start()
        self.addCleanup(self.storage_patch.stop)
        self.migrate("upgrade", "4dddea78c22c")
        self.legacy_file = Path(self.storage.name) / "legacy.txt"
        self.legacy_file.write_bytes(b"original legacy contents")
        with self.engine.begin() as connection:
            connection.execute(text("INSERT INTO users (id, username, email, hashed_password) VALUES (1, 'alice', 'alice@example.com', 'unused')"))
            connection.execute(text("""
                INSERT INTO documents
                    (id, filename, original_filename, file_path, file_size, content_type, owner_id, created_at)
                VALUES (1, 'legacy.txt', 'legacy.txt', :path, 24, 'text/plain', 1, '2026-01-01 12:00:00')
            """), {"path": str(self.legacy_file)})
        self.migrate("upgrade", "head")
        sessions = sessionmaker(bind=self.engine)

        def test_db():
            with sessions() as db:
                yield db

        app = FastAPI()
        app.include_router(documents.router, prefix="/documents")
        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.client.headers["Authorization"] = "Bearer " + auth.create_access_token({"sub": "alice"})

    def migrate(self, direction, revision):
        # The existing Alembic env passes this value through ConfigParser.
        with patch.dict(os.environ, {"DATABASE_URL": self.url.replace("%", "%%")}):
            getattr(command, direction)(self.config, revision)

    def drop_schema(self):
        # Only the UUID-named schema created by this test is removed.
        with self.admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))

    def test_backfill_preserves_original_metadata_and_file(self):
        response = self.client.get("/documents/1/versions")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), [{
            "version_number": 1, "original_filename": "legacy.txt", "file_size": 24,
            "content_type": "text/plain", "created_at": "2026-01-01T12:00:00",
        }])
        self.assertEqual(self.client.get("/documents/1/versions/1/download").content, b"original legacy contents")
        self.assertEqual(self.client.get("/documents/").json()[0]["current_version"], 1)

    def test_concurrent_replacements_get_distinct_versions(self):
        def replace(content):
            return self.client.post("/documents/1/versions", files={"file": ("replacement.txt", content, "text/plain")})
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(replace, [b"parallel A", b"parallel B"]))
        self.assertEqual([response.status_code for response in responses], [200, 200])
        history = self.client.get("/documents/1/versions").json()
        self.assertEqual([version["version_number"] for version in history], [3, 2, 1])
        self.assertEqual({self.client.get(f"/documents/1/versions/{number}/download").content for number in (2, 3)}, {b"parallel A", b"parallel B"})
        self.assertEqual(self.client.get("/documents/").json()[0]["current_version"], 3)
        self.assertEqual(self.client.get("/documents/1/download").content,
                         self.client.get("/documents/1/versions/3/download").content)
        self.assertEqual(self.legacy_file.read_bytes(), b"original legacy contents")

    def test_downgrade_keeps_current_file(self):
        response = self.client.post("/documents/1/versions", files={"file": ("new.txt", b"replacement", "text/plain")})
        self.assertEqual(response.status_code, 200, response.text)
        current_path = response.json()["file_path"]
        self.migrate("downgrade", "4dddea78c22c")
        with self.engine.connect() as connection:
            row = connection.execute(text("SELECT original_filename, file_path FROM documents WHERE id = 1")).one()
        self.assertEqual(row, ("new.txt", current_path))
        self.assertEqual(Path(current_path).read_bytes(), b"replacement")
        self.assertTrue(self.legacy_file.exists())
