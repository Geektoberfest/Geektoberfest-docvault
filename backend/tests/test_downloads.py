import errno
import asyncio
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from contextlib import chdir, contextmanager
from unittest import mock
from urllib.parse import unquote

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import auth, downloads, models
from app.database import Base, get_db
from app.routes import documents


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "uploads"
        self.root.mkdir()
        patcher = mock.patch.object(documents, "UPLOAD_DIR", str(self.root))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.alice = models.User(username="alice", email="alice@test.invalid", hashed_password="unused")
        self.bob = models.User(username="bob", email="bob@test.invalid", hashed_password="unused")
        self.db.add_all([self.alice, self.bob])
        self.db.flush()
        self.path = self.root / "file.txt"
        self.path.write_bytes(b"hello")
        self.doc = models.Document(filename="file.txt", original_filename="report.txt",
                                   file_path=str(self.path), file_size=5, content_type="text/plain",
                                   owner_id=self.alice.id)
        self.db.add(self.doc)
        self.db.commit()
        app = FastAPI()
        app.include_router(documents.router, prefix="/documents")

        def test_db():
            yield self.db

        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.client.headers["Authorization"] = "Bearer " + auth.create_access_token({"sub": "alice"})

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def get(self, doc_id=None):
        return self.client.get(f"/documents/{doc_id or self.doc.id}/download")

    def unavailable(self, response, status):
        self.assertEqual(response.status_code, status, response.text)
        self.assertNotIn(str(self.root), response.text)
        self.assertNotIn("Traceback", response.text)
        self.assertEqual(self.db.query(models.AuditLog).count(), 0)

    def test_owner_download_has_exact_bytes_headers_and_audit(self):
        response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"hello")
        self.assertEqual(response.headers["content-length"], "5")
        self.assertTrue(response.headers["content-type"].startswith("text/plain"))
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.db.query(models.AuditLog).one().action, "download")

    def test_unauthenticated_request(self):
        self.client.headers.pop("Authorization")
        self.unavailable(self.get(), 401)

    def test_owner_query_token_contract_is_preserved(self):
        self.client.headers.pop("Authorization")
        token = auth.create_access_token({"sub": "alice"})
        response = self.client.get(f"/documents/{self.doc.id}/download", params={"token": token})
        self.assertEqual(response.content, b"hello")

    def test_single_ranges_preserve_download_bytes_and_headers(self):
        for value, content, content_range in (
            ("bytes=1-3", b"ell", "bytes 1-3/5"),
            ("bytes=3-", b"lo", "bytes 3-4/5"),
            ("bytes=-2", b"lo", "bytes 3-4/5"),
        ):
            with self.subTest(range=value):
                response = self.client.get(f"/documents/{self.doc.id}/download", headers={"Range": value})
                self.assertEqual(response.status_code, 206)
                self.assertEqual(response.content, content)
                self.assertEqual(response.headers["content-range"], content_range)
                self.assertEqual(int(response.headers["content-length"]), len(content))

    def test_unsatisfiable_range_and_unsupported_range_fallback(self):
        response = self.client.get(f"/documents/{self.doc.id}/download", headers={"Range": "bytes=99-"})
        self.assertEqual(response.status_code, 416)
        self.assertEqual(response.headers["content-range"], "bytes */5")
        self.assertEqual(response.content, b"")
        for headers in ({"Range": "bytes=0-1,3-4"}, {"Range": "bytes=0-1", "If-Range": '"unknown"'},
                        {"Range": "bytes=" + "9" * 10000 + "-"}):
            response = self.client.get(f"/documents/{self.doc.id}/download", headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, b"hello")

    def test_existing_relative_storage_paths(self):
        self.doc.file_path = "uploads/file.txt"
        self.db.commit()
        with chdir(self.temp.name), mock.patch.object(documents, "UPLOAD_DIR", "uploads"):
            self.assertEqual(self.get().content, b"hello")

    def test_cross_user_and_missing_document_are_identical(self):
        self.client.headers["Authorization"] = "Bearer " + auth.create_access_token({"sub": "bob"})
        foreign, missing = self.get(), self.get(99999)
        self.unavailable(foreign, 404)
        self.assertEqual(foreign.json(), missing.json())

    def test_missing_stored_file(self):
        self.path.unlink()
        self.unavailable(self.get(), 404)

    def test_hardlink_to_an_external_file_is_rejected(self):
        outside = Path(self.temp.name) / "secret.txt"
        outside.write_bytes(b"hello")
        self.path.unlink()
        os.link(outside, self.path)
        self.unavailable(self.get(), 404)

    @unittest.skipIf(os.name == "nt", "POSIX FIFO test")
    def test_fifo_is_rejected_without_blocking(self):
        self.path.unlink()
        os.mkfifo(self.path)
        self.unavailable(self.get(), 404)

    @unittest.skipIf(os.name == "nt", "POSIX pinned-directory test")
    def test_open_directory_descriptor_survives_root_path_replacement(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "file.txt").write_bytes(b"other")
        original = os.open

        def replace_root(path, flags, *args, **kwargs):
            fd = original(path, flags, *args, **kwargs)
            if path == self.root:
                self.root.rename(Path(self.temp.name) / "pinned")
                self.root.symlink_to(outside, target_is_directory=True)
            return fd

        with mock.patch.object(downloads.os, "open", side_effect=replace_root):
            response = self.get()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"hello")

    def test_directory_is_not_a_download(self):
        self.path.unlink()
        self.path.mkdir()
        self.assertIn(self.get().status_code, (404, 503))

    def test_traversal_absolute_escape_and_prefix_sibling_are_rejected(self):
        outside = Path(self.temp.name) / "secret.txt"
        outside.write_bytes(b"hello")
        sibling = Path(self.temp.name) / "uploads-other"
        sibling.mkdir()
        (sibling / "secret.txt").write_bytes(b"hello")
        for path in (str(self.root / ".." / "secret.txt"), str(outside), str(sibling / "secret.txt"),
                     "uploads/../../secret.txt", "C:\\secret.txt", "../secret.txt", "\x00",
                     str(self.root / "file.txt:stream")):
            with self.subTest(path=path):
                self.doc.file_path = path
                self.db.commit()
                self.unavailable(self.get(), 404)

    def test_file_symlink_escape(self):
        outside = Path(self.temp.name) / "secret.txt"
        outside.write_bytes(b"hello")
        self.path.unlink()
        try:
            self.path.symlink_to(outside)
        except OSError as exc:
            self.skipTest(f"File symlink creation unavailable: {exc.winerror if hasattr(exc, 'winerror') else exc.errno}")
        self.unavailable(self.get(), 404)

    @unittest.skipUnless(os.name == "nt", "Windows junction test")
    def test_windows_junction_escape(self):
        outside = Path(self.temp.name) / "private"
        outside.mkdir()
        self.path.unlink()
        result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(self.path), str(outside)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.addCleanup(os.rmdir, self.path)
        response = self.get()
        self.assertIn(response.status_code, (404, 503))
        self.unavailable(response, response.status_code)

    def test_replacement_with_symlink_between_validation_and_open(self):
        outside = Path(self.temp.name) / "secret.txt"
        outside.write_bytes(b"hello")
        probe = self.root / "probe"
        try:
            probe.symlink_to(outside)
            probe.unlink()
        except OSError:
            self.skipTest("File symlink creation unavailable")
        original = downloads._open_source

        @contextmanager
        def replace_before_open(root, name):
            self.path.unlink()
            self.path.symlink_to(outside)
            with original(root, name) as source:
                yield source

        with mock.patch.object(downloads, "_open_source", replace_before_open):
            self.unavailable(self.get(), 404)

    def test_size_mismatch_is_rejected_before_response(self):
        self.path.write_bytes(b"shorter or longer")
        self.unavailable(self.get(), 409)

    def test_change_during_copy_is_rejected(self):
        original_fstat = downloads.os.fstat
        calls = 0

        def changed_metadata(fd):
            nonlocal calls
            info = original_fstat(fd)
            calls += 1
            if calls == 3:
                return mock.Mock(st_size=info.st_size, st_mtime_ns=info.st_mtime_ns + 1,
                                 st_ctime_ns=info.st_ctime_ns)
            return info

        with mock.patch.object(downloads.os, "fstat", side_effect=changed_metadata):
            self.unavailable(self.get(), 409)

    def test_snapshot_disk_failure_is_sanitized(self):
        with mock.patch.object(downloads.tempfile, "TemporaryFile", side_effect=OSError(errno.ENOSPC, "private disk details")):
            self.unavailable(self.get(), 503)

    def test_empty_and_legacy_missing_size(self):
        self.path.write_bytes(b"")
        self.doc.file_size = 0
        self.db.commit()
        self.assertEqual(self.get().headers["content-length"], "0")
        self.path.write_bytes(b"legacy")
        self.doc.file_size = None
        self.db.commit()
        response = self.get()
        self.assertEqual(response.content, b"legacy")
        self.assertEqual(response.headers["content-length"], "6")

    def test_size_check_is_not_claimed_to_be_a_checksum(self):
        self.path.write_bytes(b"other")
        self.assertEqual(self.get().content, b"other")
        self.assertNotIn("content_sha256", models.Document.__table__.columns)

    def test_permission_and_mid_read_errors_are_sanitized(self):
        for failure in (PermissionError(errno.EACCES, "private storage path", str(self.path)),
                        OSError(errno.EIO, "internal disk detail", str(self.path))):
            with self.subTest(error=type(failure).__name__):
                with mock.patch.object(downloads, "_open_source", side_effect=failure):
                    self.unavailable(self.get(), 503)

        original = downloads._open_source

        @contextmanager
        def read_error(root, name):
            with original(root, name) as source:
                wrapped = mock.Mock(wraps=source)
                wrapped.read.side_effect = OSError(errno.EIO, "secret disk details")
                yield wrapped

        with mock.patch.object(downloads, "_open_source", read_error):
            self.unavailable(self.get(), 503)

    def test_snapshot_survives_source_change_and_closes(self):
        snapshot, length = downloads.prepare_download(str(self.path), str(self.root), 5)
        self.path.write_bytes(b"other")
        self.assertEqual(length, 5)
        chunks = downloads.snapshot_chunks(snapshot)
        self.assertEqual(next(chunks), b"hello")
        chunks.close()
        self.assertTrue(snapshot.closed)

    def test_disconnect_before_iteration_closes_snapshot(self):
        snapshot = tempfile.TemporaryFile(mode="w+b")
        response = downloads.DownloadResponse(snapshot, 0, "empty.txt", "text/plain")

        async def receive():
            return {"type": "http.disconnect"}

        async def send(_message):
            raise OSError("connection closed")

        with self.assertRaises(Exception):
            asyncio.run(response({"type": "http", "method": "GET", "asgi": {"spec_version": "2.4"}}, receive, send))
        self.assertTrue(snapshot.closed)

    def test_snapshot_read_failure_after_headers_cannot_rewrite_status(self):
        snapshot = mock.Mock()
        snapshot.read.side_effect = OSError(errno.EIO, "disk failed after headers")
        response = downloads.DownloadResponse(snapshot, 5, "report.txt", "text/plain")
        sent = []

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)

        with self.assertRaises(Exception):
            asyncio.run(response({"type": "http", "method": "GET", "asgi": {"spec_version": "2.4"}}, receive, send))
        self.assertEqual(sent[0]["status"], 200)
        snapshot.close.assert_called()

    def test_unicode_filename_and_header_injection_are_safe(self):
        self.doc.original_filename = '../r\u00e9sum\u00e9 "2026"\r\nX-Injected.pdf'
        self.doc.content_type = "text/plain\r\nX-Injected: yes"
        self.db.commit()
        response = self.get()
        self.assertEqual(response.status_code, 200)
        disposition = response.headers["content-disposition"]
        self.assertTrue(disposition.startswith("attachment; filename*=UTF-8''"))
        self.assertEqual(unquote(disposition.split("''")[1]), 'r\u00e9sum\u00e9 "2026"X-Injected.pdf')
        self.assertNotIn("x-injected", response.headers)
        self.assertEqual(response.headers["content-type"], "application/octet-stream")

    def test_audit_failure_closes_snapshot_and_does_not_leak(self):
        snapshot = tempfile.TemporaryFile(mode="w+b")
        snapshot.write(b"hello")
        snapshot.seek(0)
        with mock.patch.object(documents, "prepare_download", return_value=(snapshot, 5)):
            with mock.patch.object(self.db, "commit", side_effect=SQLAlchemyError("secret database details")):
                self.unavailable(self.get(), 503)
        self.assertTrue(snapshot.closed)


if __name__ == "__main__":
    unittest.main()
