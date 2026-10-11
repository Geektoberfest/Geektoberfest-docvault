// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";

vi.mock("./api", () => ({
  API_URL: "http://localhost:8000",
  getDocumentPage: vi.fn(), getFolders: vi.fn(), getMe: vi.fn(),
  deleteDocument: vi.fn(), uploadDocument: vi.fn(), deleteFolder: vi.fn(),
  createFolder: vi.fn(), renameFolder: vi.fn(), login: vi.fn(), register: vi.fn(),
}));

let documents;

function document(id) {
  return {
    id, original_filename: `report-${String(id).padStart(2, "0")}.txt`,
    file_size: 100, content_type: "text/plain", created_at: "2026-01-01T00:00:00", folder_id: id <= 12 ? 1 : null,
  };
}

function paginatedResponse({ page = 1, page_size = 10, q = "", folder_id, file_type = "all" }) {
  const matches = documents.filter((item) =>
    item.original_filename.toLowerCase().includes(q.toLowerCase()) &&
    (folder_id == null || item.folder_id === folder_id) &&
    (file_type === "all" || item.content_type.includes(file_type))
  );
  const total_pages = Math.max(1, Math.ceil(matches.length / page_size));
  page = Math.min(page, total_pages);
  return { data: {
    items: matches.slice((page - 1) * page_size, page * page_size),
    total: matches.length, page, page_size, total_pages,
  } };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem("token", "test-token");
  documents = Array.from({ length: 23 }, (_, index) => document(23 - index));
  api.getMe.mockResolvedValue({ data: { username: "alice" } });
  api.getFolders.mockResolvedValue({ data: [{ id: 1, name: "Reports" }] });
  api.getDocumentPage.mockImplementation(async (params) => paginatedResponse(params));
  api.deleteDocument.mockImplementation(async (id) => {
    documents = documents.filter((item) => item.id !== id);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function openApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(/Page 1 of/);
  return user;
}

describe("document pagination", () => {
  it("resets file-type changes to page one with filtered totals", async () => {
    documents.forEach((item) => { if (item.id >= 12) item.content_type = "application/pdf"; });
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 3/);
    await user.selectOptions(screen.getByLabelText("Type:"), "pdf");
    await screen.findByText("Page 1 of 2 · 12 documents · 10 per page");
    expect(api.getDocumentPage.mock.lastCall[0]).toMatchObject({ page: 1, file_type: "pdf" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 2/);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText("Type:"), "all");
    await screen.findByText("Page 1 of 3 · 23 documents · 10 per page");
  });

  it("shows ten rows and navigates through the last partial page", async () => {
    const user = await openApp();
    expect(screen.getByText("Page 1 of 3 · 23 documents · 10 per page")).toBeTruthy();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "Previous" }).disabled).toBe(true);
    expect(screen.getAllByTitle("Download")[0].href).toBe("http://localhost:8000/documents/23/download?token=test-token");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 3/);
    expect(screen.getByText("report-13.txt")).toBeTruthy();
    expect(screen.queryByText("report-23.txt")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 3 of 3/);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText(/Page 2 of 3/);
  });

  it("resets search to page one and sends the whole search string", async () => {
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 3/);
    await user.type(screen.getByPlaceholderText("Search documents..."), "report-01");
    await screen.findByText("Page 1 of 1 · 1 documents · 10 per page");
    expect(screen.getByText("report-01.txt")).toBeTruthy();
    expect(api.getDocumentPage).toHaveBeenLastCalledWith(
      { page: 1, page_size: 10, q: "report-01", folder_id: undefined, file_type: "all" }, expect.any(AbortSignal)
    );
  });

  it("resets folder changes and All Documents to page one", async () => {
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 3/);
    await user.click(await screen.findByRole("button", { name: "Reports", exact: true }));
    await screen.findByText("Page 1 of 2 · 12 documents · 10 per page");
    expect(api.getDocumentPage).toHaveBeenLastCalledWith(
      { page: 1, page_size: 10, q: "", folder_id: 1, file_type: "all" }, expect.any(AbortSignal)
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 2/);
    await user.click(screen.getByRole("button", { name: "All Documents" }));
    await screen.findByText("Page 1 of 3 · 23 documents · 10 per page");
  });

  it("handles zero results and disables both navigation buttons", async () => {
    documents = [];
    await openApp();
    expect(screen.getByText("No documents yet")).toBeTruthy();
    expect(screen.getByText("Page 1 of 1 · 0 documents · 10 per page")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true);
  });

  it("returns to the previous page after deleting its only document", async () => {
    documents = documents.slice(0, 11);
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 2/);
    await user.click(screen.getByTitle("Delete"));
    await screen.findByText("Page 1 of 1 · 10 documents · 10 per page");
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(11);
  });

  it("handles deletion of the final document", async () => {
    documents = [document(1)];
    const user = await openApp();
    await user.click(screen.getByTitle("Delete"));
    await screen.findByText("Page 1 of 1 · 0 documents · 10 per page");
    expect(screen.getByText("No documents yet")).toBeTruthy();
  });

  it("refreshes totals after an upload", async () => {
    documents = documents.slice(0, 10);
    api.uploadDocument.mockImplementation(async () => { documents.unshift(document(24)); });
    const user = await openApp();
    await user.upload(screen.getByLabelText("Upload file"), new File(["test"], "report-24.txt", { type: "text/plain" }));
    await user.click(screen.getByRole("button", { name: "Upload", exact: true }));
    await screen.findByText("Page 1 of 2 · 11 documents · 10 per page");
    expect(screen.getByText("report-24.txt")).toBeTruthy();
  });

  it("resets to All Documents after deleting the selected folder", async () => {
    api.deleteFolder.mockImplementation(async (id) => {
      documents = documents.filter((item) => item.folder_id !== id);
      api.getFolders.mockResolvedValue({ data: [] });
    });
    const user = await openApp();
    await user.click(await screen.findByRole("button", { name: "Reports", exact: true }));
    await screen.findByText(/Page 1 of 2/);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 2/);
    await user.click(screen.getByTitle("Delete folder"));
    await screen.findByText("Page 1 of 2 · 11 documents · 10 per page");
    expect(api.getDocumentPage).toHaveBeenLastCalledWith(
      { page: 1, page_size: 10, q: "", folder_id: undefined, file_type: "all" }, expect.any(AbortSignal)
    );
  });

  it("shows fetch errors and allows retry without navigating away", async () => {
    const user = await openApp();
    api.getDocumentPage.mockRejectedValueOnce(new Error("Network unavailable"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Failed to fetch documents");
    expect(screen.queryByText("report-23.txt")).toBeNull();
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Page 2 of 3/);
  });

  it("ignores a slow old response after filters change", async () => {
    const user = await openApp();
    let resolveOldRequest;
    api.getDocumentPage.mockImplementationOnce(() => new Promise((resolve) => { resolveOldRequest = resolve; }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const oldSignal = api.getDocumentPage.mock.lastCall[1];
    expect(screen.getByText("Loading documents...")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true);
    await user.type(screen.getByPlaceholderText("Search documents..."), "report-01");
    await screen.findByText("Page 1 of 1 · 1 documents · 10 per page");
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOldRequest(paginatedResponse({ page: 2 })));
    expect(screen.getByText("Page 1 of 1 · 1 documents · 10 per page")).toBeTruthy();
    expect(screen.queryByText("report-13.txt")).toBeNull();
  });
});
