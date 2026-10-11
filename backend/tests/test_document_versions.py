import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import auth, document_files, models
from app.database import Base, get_db
from app.routes import documents, folders


class DocumentVersionTests(unittest.TestCase):
    def setUp(self):
        self.storage = tempfile.TemporaryDirectory()
        self.storage_patch = patch.object(document_files, "UPLOAD_DIR", self.storage.name)
        self.storage_patch.start()
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.db.add_all([
            models.User(username="alice", email="alice@example.com", hashed_password="unused"),
            models.User(username="bob", email="bob@example.com", hashed_password="unused"),
        ])
        self.db.commit()
        self.owner_id = self.db.query(models.User).filter_by(username="alice").one().id

        def test_db():
            yield self.db

        app = FastAPI()
        app.include_router(documents.router, prefix="/documents")
        app.include_router(folders.router, prefix="/folders")
        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.sign_in("alice")

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()
        self.storage_patch.stop()
        self.storage.cleanup()

    def sign_in(self, username):
        self.client.headers["Authorization"] = "Bearer " + auth.create_access_token({"sub": username})

    def upload(self, content=b"first", name="report.txt", folder_id=None):
        response = self.client.post("/documents/upload", files={"file": (name, content, "text/plain")},
                                    data={"folder_id": folder_id} if folder_id else {})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def replace(self, doc, content=b"second", name="revised.txt"):
        return self.client.post(f"/documents/{doc['id']}/versions", files={"file": (name, content, "text/plain")})

    def versions(self, doc):
        response = self.client.get(f"/documents/{doc['id']}/versions")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def files(self):
        return sorted(Path(self.storage.name).iterdir())

    def assert_original_preserved(self, doc):
        current = self.client.get("/documents/").json()[0]
        self.assertEqual(current, doc)
        self.assertEqual(len(self.versions(doc)), 1)
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/download").content, b"first")
        self.assertEqual(len(self.files()), 1)

    def test_initial_upload_records_version_one(self):
        doc = self.upload()
        versions = self.versions(doc)
        self.assertEqual(doc["current_version"], 1)
        self.assertEqual(versions[0]["version_number"], 1)
        self.assertEqual(versions[0]["file_size"], 5)
        self.assertEqual(versions[0]["content_type"], "text/plain")
        self.assertTrue(versions[0]["created_at"])

    def test_replacement_preserves_identity_folder_and_creation_date(self):
        folder = self.client.post("/folders/", json={"name": "Reports"}).json()
        doc = self.upload(folder_id=folder["id"])
        response = self.replace(doc)
        self.assertEqual(response.status_code, 200, response.text)
        updated = response.json()
        for field in ("id", "folder_id", "owner_id", "created_at"):
            self.assertEqual(updated[field], doc[field])
        self.assertEqual(updated["current_version"], 2)
        self.assertEqual(updated["original_filename"], "revised.txt")
        self.assertNotEqual(updated["file_path"], doc["file_path"])
        self.assertEqual([version["version_number"] for version in self.versions(doc)], [2, 1])

    def test_download_current_and_previous_bytes(self):
        doc = self.upload()
        self.assertEqual(self.replace(doc).status_code, 200)
        for version, content, name in ((1, b"first", "report.txt"), (2, b"second", "revised.txt")):
            response = self.client.get(f"/documents/{doc['id']}/versions/{version}/download")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, content)
            self.assertIn(name, response.headers["content-disposition"])
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/download").content, b"second")

    def test_repeated_replacements_and_same_filename(self):
        doc = self.upload()
        for version in (2, 3, 4):
            self.assertEqual(self.replace(doc, str(version).encode(), "report.txt").json()["current_version"], version)
        self.assertEqual([v["version_number"] for v in self.versions(doc)], [4, 3, 2, 1])
        self.assertEqual(len(self.files()), 4)

    def test_file_type_filter_uses_current_version_and_keeps_history(self):
        doc = self.upload()
        self.assertEqual(len(self.client.get("/documents/?file_type=text").json()), 1)
        response = self.client.post(f"/documents/{doc['id']}/versions",
                                    files={"file": ("report.pdf", b"pdf content", "application/pdf")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/documents/?file_type=text").json(), [])
        self.assertEqual(self.client.get("/documents/?file_type=pdf").json()[0]["id"], doc["id"])
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/versions/1/download").content, b"first")
        self.assertEqual(len(self.versions(doc)), 2)

    def test_separate_upload_with_same_name_keeps_distinct_identity(self):
        first, second = self.upload(), self.upload()
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(self.versions(first)), 1)
        self.assertEqual(len(self.versions(second)), 1)

    def test_oversized_replacement_preserves_current(self):
        doc = self.upload()
        self.assertEqual(self.replace(doc, b"x" * (document_files.MAX_FILE_SIZE + 1)).status_code, 400)
        self.assert_original_preserved(doc)

    def test_partial_write_failure_cleans_new_file_and_preserves_current(self):
        doc = self.upload()
        def fail_copy(source, target):
            target.write(b"partial")
            raise OSError("Disk full")
        with patch.object(document_files.shutil, "copyfileobj", side_effect=fail_copy):
            self.assertEqual(self.replace(doc).status_code, 500)
        self.assert_original_preserved(doc)

    def test_failed_commit_cleans_new_file_and_rolls_back_metadata(self):
        doc = self.upload()
        with patch.object(self.db, "commit", side_effect=SQLAlchemyError("Commit failed")):
            self.assertEqual(self.replace(doc).status_code, 500)
        self.assert_original_preserved(doc)

    def test_initial_upload_commit_failure_removes_file(self):
        with patch.object(self.db, "commit", side_effect=SQLAlchemyError("Commit failed")):
            response = self.client.post("/documents/upload", files={"file": ("report.txt", b"first")})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.db.query(models.DocumentVersion).count(), 0)
        self.assertEqual(self.db.query(models.Document).count(), 0)

    def test_other_user_cannot_list_replace_or_download(self):
        doc = self.upload()
        self.sign_in("bob")
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/versions").status_code, 404)
        self.assertEqual(self.replace(doc).status_code, 404)
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/versions/1/download").status_code, 404)
        self.assertEqual(len(self.files()), 1)

    def test_authentication_is_required_for_each_version_endpoint(self):
        doc = self.upload()
        self.client.headers.pop("Authorization")
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/versions").status_code, 401)
        self.assertEqual(self.replace(doc).status_code, 401)
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/versions/1/download").status_code, 401)

    def test_missing_document_version_and_file_return_404(self):
        doc = self.upload()
        self.assertEqual(self.client.get("/documents/999/versions").status_code, 404)
        self.assertEqual(self.replace({"id": 999}).status_code, 404)
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/versions/999/download").status_code, 404)
        Path(doc["file_path"]).unlink()
        self.assertEqual(self.client.get(f"/documents/{doc['id']}/versions/1/download").status_code, 404)

    def test_document_deletion_removes_all_versions_and_files(self):
        doc = self.upload()
        self.replace(doc)
        self.assertEqual(self.client.delete(f"/documents/{doc['id']}").status_code, 204)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.db.query(models.DocumentVersion).count(), 0)

    def test_folder_deletion_removes_all_versions_and_files(self):
        folder = self.client.post("/folders/", json={"name": "Reports"}).json()
        doc = self.upload(folder_id=folder["id"])
        self.replace(doc)
        self.assertEqual(self.client.delete(f"/folders/{folder['id']}").status_code, 204)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.db.query(models.DocumentVersion).count(), 0)

    def test_failed_deletion_does_not_remove_files(self):
        doc = self.upload()
        with patch.object(self.db, "commit", side_effect=SQLAlchemyError("Commit failed")):
            with self.assertRaises(SQLAlchemyError):
                self.client.delete(f"/documents/{doc['id']}")
        self.db.rollback()
        self.assert_original_preserved(doc)


if __name__ == "__main__":
    unittest.main()
