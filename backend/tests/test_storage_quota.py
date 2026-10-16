import io
import os
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import auth, models
from app.config import (
    DEFAULT_DOCUMENT_STORAGE_QUOTA_BYTES,
    MAX_DOCUMENT_STORAGE_QUOTA_BYTES,
    parse_document_storage_quota,
)
from app.database import Base, get_db
from app.routes import documents


def build_app(db_factory):
    def test_db():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(documents.router, prefix="/documents")
    app.dependency_overrides[get_db] = test_db
    return app


class StorageQuotaTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self.engine)
        self.factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.factory()
        self.alice = models.User(username="alice", email="alice@example.com", hashed_password="unused")
        self.bob = models.User(username="bob", email="bob@example.com", hashed_password="unused")
        self.db.add_all([self.alice, self.bob])
        self.db.commit()
        self.upload_dir = tempfile.TemporaryDirectory()
        self.patchers = [
            mock.patch.object(documents, "UPLOAD_DIR", self.upload_dir.name),
            mock.patch.object(documents, "DOCUMENT_STORAGE_QUOTA_BYTES", 5),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.app = build_app(self.factory)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.db.close()
        self.engine.dispose()
        self.upload_dir.cleanup()

    def headers(self, user=None):
        user = user or self.alice
        return {"Authorization": f"Bearer {auth.create_access_token({'sub': user.username})}"}

    def upload(self, content, user=None, filename="sample.txt"):
        return self.client.post(
            "/documents/upload",
            headers=self.headers(user),
            files={"file": (filename, io.BytesIO(content), "text/plain")},
        )

    def stored_documents(self, user=None):
        return self.db.query(models.Document).filter_by(owner_id=(user or self.alice).id).all()

    def test_default_and_invalid_quota_configuration(self):
        self.assertEqual(parse_document_storage_quota(None), DEFAULT_DOCUMENT_STORAGE_QUOTA_BYTES)
        self.assertEqual(parse_document_storage_quota("5"), 5)
        for value in ("", "0", "-1", "+2", "1.5", " 4", "9223372036854775808"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_document_storage_quota(value)
        self.assertEqual(parse_document_storage_quota(str(MAX_DOCUMENT_STORAGE_QUOTA_BYTES)), MAX_DOCUMENT_STORAGE_QUOTA_BYTES)

    def test_empty_storage_accepts_upload_below_quota(self):
        response = self.upload(b"abc")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["file_size"], 3)
        self.assertEqual(sum(d.file_size for d in self.stored_documents()), 3)

    def test_upload_exactly_reaching_quota_succeeds(self):
        self.assertEqual(self.upload(b"abc").status_code, 200)
        self.assertEqual(self.upload(b"de").status_code, 200)
        self.assertEqual(sum(d.file_size for d in self.stored_documents()), 5)

    def test_one_byte_over_quota_returns_stable_details_and_cleans_staging(self):
        self.assertEqual(self.upload(b"1234").status_code, 200)
        response = self.upload(b"xy")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], {
            "code": "STORAGE_QUOTA_EXCEEDED",
            "quota_bytes": 5,
            "used_bytes": 4,
            "incoming_bytes": 2,
            "remaining_bytes": 1,
        })
        self.assertEqual(len(self.stored_documents()), 1)
        self.assertEqual(len(os.listdir(self.upload_dir.name)), 1)

    def test_existing_records_and_multiple_documents_are_counted(self):
        existing_path = os.path.join(self.upload_dir.name, "old.txt")
        with open(existing_path, "wb") as existing:
            existing.write(b"old")
        self.db.add(models.Document(
            filename="old.txt", original_filename="old.txt", file_path=existing_path,
            file_size=3, content_type="text/plain", owner_id=self.alice.id,
        ))
        self.db.commit()
        self.assertEqual(self.upload(b"x").status_code, 200)
        self.assertEqual(self.upload(b"y").status_code, 200)
        response = self.upload(b"y")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(sum(d.file_size for d in self.stored_documents()), 5)

    def test_invalid_negative_legacy_sizes_do_not_reduce_usage(self):
        self.db.add(models.Document(
            filename="bad.txt", original_filename="bad.txt", file_path="unused",
            file_size=-100, content_type="text/plain", owner_id=self.alice.id,
        ))
        self.db.commit()
        self.assertEqual(self.upload(b"12345").status_code, 200)
        response = self.upload(b"x")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"]["used_bytes"], 5)

    def test_accounts_have_independent_quotas(self):
        self.assertEqual(self.upload(b"12345").status_code, 200)
        self.assertEqual(self.upload(b"abcde", user=self.bob).status_code, 200)
        self.assertEqual(sum(d.file_size for d in self.stored_documents(self.alice)), 5)
        self.assertEqual(sum(d.file_size for d in self.stored_documents(self.bob)), 5)

    def test_repeated_requests_cannot_exceed_quota(self):
        self.assertEqual(self.upload(b"1234").status_code, 200)
        for _ in range(3):
            self.assertEqual(self.upload(b"xx").status_code, 413)
        self.assertEqual(len(self.stored_documents()), 1)

    def test_file_limit_still_applies_and_does_not_store_file(self):
        with mock.patch.object(documents, "DOCUMENT_STORAGE_QUOTA_BYTES", documents.MAX_FILE_SIZE + 2):
            response = self.upload(b"x" * (documents.MAX_FILE_SIZE + 1))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.stored_documents(), [])
        self.assertEqual(os.listdir(self.upload_dir.name), [])

    def test_storage_write_failure_cleans_staged_file(self):
        with mock.patch.object(documents.os, "replace", side_effect=OSError("private path detail")):
            response = self.upload(b"abc")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Upload storage is unavailable")
        self.assertEqual(self.stored_documents(), [])
        self.assertEqual(os.listdir(self.upload_dir.name), [])

    def test_staging_write_failure_cleans_partial_file(self):
        with mock.patch.object(documents.shutil, "copyfileobj", side_effect=OSError("private path detail")):
            response = self.upload(b"abc")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Upload storage is unavailable")
        self.assertEqual(self.stored_documents(), [])
        self.assertEqual(os.listdir(self.upload_dir.name), [])

    def test_database_failure_rolls_back_record_and_removes_file(self):
        with mock.patch.object(Session, "commit", side_effect=SQLAlchemyError("private database detail")):
            response = self.upload(b"abc")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Upload could not be saved")
        self.db.rollback()
        self.assertEqual(self.stored_documents(), [])
        self.assertEqual(os.listdir(self.upload_dir.name), [])

    def test_delete_reclaims_quota_only_after_storage_is_removed(self):
        self.assertEqual(self.upload(b"12345").status_code, 200)
        doc = self.stored_documents()[0]
        response = self.client.delete(f"/documents/{doc.id}", headers=self.headers())
        self.assertEqual(response.status_code, 204)
        self.assertFalse(os.path.exists(doc.file_path))
        self.assertEqual(self.stored_documents(), [])
        self.assertEqual(self.upload(b"abcde").status_code, 200)

    def test_failed_file_removal_does_not_reclaim_quota(self):
        self.assertEqual(self.upload(b"12345").status_code, 200)
        doc = self.stored_documents()[0]
        with mock.patch.object(documents.os, "remove", side_effect=OSError("private path detail")):
            with TestClient(self.app, raise_server_exceptions=False) as client:
                response = client.delete(f"/documents/{doc.id}", headers=self.headers())
        self.assertEqual(response.status_code, 500)
        self.assertTrue(os.path.exists(doc.file_path))
        self.assertEqual(len(self.stored_documents()), 1)
        self.assertEqual(self.upload(b"x").status_code, 413)


@unittest.skipUnless(os.getenv("DOCVAULT_TEST_POSTGRES_URL"), "set DOCVAULT_TEST_POSTGRES_URL to an isolated PostgreSQL test database")
class PostgreSQLQuotaConcurrencyTests(unittest.TestCase):
    """Exercise the user-row lock with independent PostgreSQL transactions."""

    def setUp(self):
        from sqlalchemy.schema import CreateSchema

        url = os.environ["DOCVAULT_TEST_POSTGRES_URL"]
        database_name = make_url(url).database or ""
        if "test" not in database_name.lower():
            self.skipTest("PostgreSQL database name must contain 'test' for isolation")
        self.engine = create_engine(url, isolation_level="READ COMMITTED")
        if self.engine.dialect.name != "postgresql":
            self.engine.dispose()
            self.skipTest("DOCVAULT_TEST_POSTGRES_URL must use PostgreSQL")
        self.schema = f"quota_test_{uuid.uuid4().hex}"
        with self.engine.begin() as conn:
            conn.execute(CreateSchema(self.schema))
        self.test_engine = self.engine.execution_options(schema_translate_map={None: self.schema})
        Base.metadata.create_all(self.test_engine)
        self.factory = sessionmaker(bind=self.test_engine, expire_on_commit=False)
        with self.factory() as db:
            self.alice = models.User(username="alice", email="alice@example.com", hashed_password="unused")
            self.bob = models.User(username="bob", email="bob@example.com", hashed_password="unused")
            db.add_all([self.alice, self.bob])
            db.commit()
            self.users = {u.username: u for u in (self.alice, self.bob)}
        self.upload_dir = tempfile.TemporaryDirectory()
        self.upload_patch = mock.patch.object(documents, "UPLOAD_DIR", self.upload_dir.name)
        self.quota_patch = mock.patch.object(documents, "DOCUMENT_STORAGE_QUOTA_BYTES", 5)
        self.upload_patch.start()
        self.quota_patch.start()
        self.app = build_app(self.factory)

    def tearDown(self):
        from sqlalchemy.schema import DropSchema

        self.upload_patch.stop()
        self.quota_patch.stop()
        self.upload_dir.cleanup()
        Base.metadata.drop_all(self.test_engine)
        with self.engine.begin() as conn:
            conn.execute(DropSchema(self.schema, cascade=True))
        self.engine.dispose()

    def concurrent_upload(self, username, content=b"1234"):
        user = self.users[username]
        headers = {"Authorization": f"Bearer {auth.create_access_token({'sub': username})}"}
        with TestClient(self.app) as client:
            return client.post(
                "/documents/upload", headers=headers,
                files={"file": ("parallel.txt", io.BytesIO(content), "text/plain")},
            ).status_code

    def test_same_user_parallel_uploads_do_not_oversubscribe(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(self.concurrent_upload, ("alice", "alice")))
        self.assertCountEqual(statuses, [200, 413])
        with self.factory() as db:
            usage = db.query(models.Document.file_size).filter_by(owner_id=self.users["alice"].id).all()
        self.assertEqual(sum(row[0] for row in usage), 4)

    def test_different_users_upload_concurrently_independently(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(self.concurrent_upload, ("alice", "bob")))
        self.assertEqual(statuses, [200, 200])


if __name__ == "__main__":
    unittest.main()
