import unittest
from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import auth, models
from app.database import Base, get_db
from app.routes import documents


class DocumentPaginationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.alice = models.User(username="alice", email="alice@example.com", hashed_password="unused")
        self.bob = models.User(username="bob", email="bob@example.com", hashed_password="unused")
        self.db.add_all([self.alice, self.bob])
        self.db.flush()
        self.folder = models.Folder(name="Reports", owner_id=self.alice.id)
        self.other_folder = models.Folder(name="Private", owner_id=self.bob.id)
        self.db.add_all([self.folder, self.other_folder])
        self.db.flush()
        for index in range(23):
            self.db.add(models.Document(
                filename=f"{index}.txt", original_filename=f"report-{index:02}.txt",
                file_path=f"__pagination_test_missing_file_{index}__", file_size=100,
                content_type="text/plain", owner_id=self.alice.id,
                folder_id=self.folder.id if index < 12 else None,
                created_at=datetime(2026, 1, 1),
            ))
        self.db.add(models.Document(
            filename="private.txt", original_filename="report-private.txt",
            file_path="__pagination_test_private_file__", file_size=100,
            content_type="text/plain", owner_id=self.bob.id, folder_id=self.other_folder.id,
            created_at=datetime(2026, 1, 2),
        ))
        self.db.commit()

        def test_db():
            yield self.db

        app = FastAPI()
        app.include_router(documents.router, prefix="/documents")
        app.dependency_overrides[get_db] = test_db
        self.client = TestClient(app)
        self.client.headers["Authorization"] = "Bearer " + auth.create_access_token({"sub": "alice"})

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def page(self, **params):
        response = self.client.get("/documents/page", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_default_page_has_ten_items_and_matching_total(self):
        page = self.page()
        self.assertEqual(len(page["items"]), 10)
        self.assertEqual((page["page"], page["page_size"], page["total_pages"], page["total"]), (1, 10, 3, 23))

    def test_file_type_combines_with_filters_before_counting_and_pagination(self):
        self.db.query(models.Document).filter(models.Document.id >= 12).update({"content_type": "application/pdf"})
        self.db.commit()
        page = self.page(file_type="PDF", page=2)
        self.assertEqual((page["total"], page["total_pages"], len(page["items"])), (12, 2, 2))
        self.assertTrue(all(item["content_type"] == "application/pdf" for item in page["items"]))
        page = self.page(file_type="pdf", folder_id=self.folder.id, q="report-11")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["id"], 12)
        self.assertEqual(self.page(file_type="image")["total"], 0)
        self.assertEqual(self.page(file_type="all")["total"], 23)

    def test_pages_have_stable_order_and_no_overlap_when_dates_match(self):
        ids = [item["id"] for number in (1, 2, 3) for item in self.page(page=number)["items"]]
        self.assertEqual(ids, list(range(23, 0, -1)))
        self.assertEqual(self.page(page=2), self.page(page=2))

    def test_newest_documents_come_first(self):
        self.db.get(models.Document, 1).created_at = datetime(2026, 2, 1)
        self.db.commit()
        self.assertEqual(self.page()["items"][0]["id"], 1)

    def test_last_partial_page_and_out_of_range_clamping(self):
        last = self.page(page=3)
        self.assertEqual(len(last["items"]), 3)
        self.assertEqual(self.page(page=999), last)

    def test_page_size_is_configurable(self):
        page = self.page(page=5, page_size=5)
        self.assertEqual((page["page_size"], page["total_pages"], len(page["items"])), (5, 5, 3))
        self.assertEqual(len(self.page(page_size=100)["items"]), 23)

    def test_invalid_pagination_parameters_are_rejected(self):
        for params in ({"page": 0}, {"page": -1}, {"page": "abc"},
                       {"page_size": 0}, {"page_size": 101}, {"folder_id": 0}):
            with self.subTest(params=params):
                self.assertEqual(self.client.get("/documents/page", params=params).status_code, 422)

    def test_search_and_folder_filter_are_applied_before_pagination(self):
        page = self.page(q="REPORT-0", folder_id=self.folder.id, page_size=3, page=2)
        self.assertEqual(page["total"], 10)
        self.assertEqual(page["total_pages"], 4)
        self.assertEqual([item["original_filename"] for item in page["items"]],
                         ["report-06.txt", "report-05.txt", "report-04.txt"])
        self.assertTrue(all(item["folder_id"] == self.folder.id for item in page["items"]))

    def test_folder_filter_returns_matching_total_and_partial_page(self):
        page = self.page(folder_id=self.folder.id, page=2)
        self.assertEqual((page["total"], len(page["items"])), (12, 2))

    def test_zero_results_returns_empty_first_page(self):
        for params in ({"q": "absent"}, {"folder_id": 999}, {"folder_id": self.other_folder.id}):
            with self.subTest(params=params):
                page = self.page(page=100, **params)
                self.assertEqual(page, {"items": [], "total": 0, "page": 1, "page_size": 10, "total_pages": 1})

    def test_results_and_totals_are_private(self):
        self.assertTrue(all(item["owner_id"] == self.alice.id for item in self.page(page_size=100)["items"]))
        self.client.headers["Authorization"] = "Bearer " + auth.create_access_token({"sub": "bob"})
        page = self.page(q="report")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["items"][0]["original_filename"], "report-private.txt")

    def test_deleting_last_page_clamps_to_previous_page(self):
        for item in self.page(page=3)["items"]:
            self.assertEqual(self.client.delete(f"/documents/{item['id']}").status_code, 204)
        page = self.page(page=3)
        self.assertEqual((page["page"], page["total_pages"], page["total"], len(page["items"])), (2, 2, 20, 10))

    def test_authentication_is_required(self):
        self.client.headers.pop("Authorization")
        self.assertEqual(self.client.get("/documents/page").status_code, 401)

    def test_legacy_list_and_search_still_return_arrays(self):
        response = self.client.get("/documents/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 23)
        response = self.client.get("/documents/search", params={"q": "report-00"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)


if __name__ == "__main__":
    unittest.main()
