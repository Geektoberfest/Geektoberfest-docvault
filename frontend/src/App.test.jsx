// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import * as api from "./api";
import { saveFilterPresets } from "./filterPresets";

vi.mock("./api", () => ({
  default: { get: vi.fn(), defaults: { baseURL: "https://api.test" } },
  getMe: vi.fn(), getFolders: vi.fn(),
  createFolder: vi.fn(), renameFolder: vi.fn(), deleteFolder: vi.fn(),
  uploadDocument: vi.fn(), deleteDocument: vi.fn(), searchDocuments: vi.fn(),
  login: vi.fn(), register: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem("token", "test-token");
  api.getMe.mockResolvedValue({ data: { id: 1, username: "alice" } });
  api.default.get.mockResolvedValue({ data: [] });
  api.searchDocuments.mockResolvedValue({ data: [] });
  api.getFolders.mockResolvedValue({ data: [{ id: 1, name: "Reports" }] });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function openApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Rename Reports" });
  return user;
}

describe("folder creation", () => {
  it("rejects whitespace visibly and retains the input", async () => {
    const user = await openApp();
    const input = screen.getByRole("textbox", { name: "New folder name" });
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    expect(screen.getByRole("alert").textContent).toContain("cannot be empty");
    expect(input.value).toBe("   ");
    expect(api.createFolder).not.toHaveBeenCalled();
  });

  it.each([
    ["Folder already exists", "Folder already exists"],
    [[{ msg: "Folder name is invalid" }], "Folder name is invalid"],
  ])("retains input after API errors: %j", async (detail, message) => {
    api.createFolder.mockRejectedValue({ response: { data: { detail } } });
    const user = await openApp();
    const input = screen.getByRole("textbox", { name: "New folder name" });
    await user.type(input, " Reports ");
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(input.value).toBe(" Reports ");
    expect(api.createFolder).toHaveBeenCalledWith("Reports");
    expect(input.disabled).toBe(false);
  });

  it("clears input only after successful creation", async () => {
    api.createFolder.mockResolvedValue({ data: { id: 2, name: "Archive" } });
    const user = await openApp();
    const input = screen.getByRole("textbox", { name: "New folder name" });
    await user.type(input, " Archive ");
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(api.createFolder).toHaveBeenCalledWith("Archive");
    expect(api.getFolders).toHaveBeenCalledTimes(2);
  });
});

describe("folder renaming", () => {
  it("rejects blank names and keeps the editor open", async () => {
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Rename Reports" }));
    const input = screen.getByRole("textbox", { name: "Rename folder" });
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("cannot be empty");
    expect(input.value).toBe("");
    expect(api.renameFolder).not.toHaveBeenCalled();
  });

  it("retains a failed rename and lets the user correct and save it", async () => {
    api.renameFolder.mockRejectedValueOnce({ response: { data: { detail: "Folder already exists" } } });
    api.renameFolder.mockResolvedValueOnce({ data: { id: 1, name: "Archive" } });
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Reports", exact: true }));
    await user.click(screen.getByRole("button", { name: "Rename Reports" }));
    const input = screen.getByRole("textbox", { name: "Rename folder" });
    expect(input.value).toBe("Reports");
    await user.clear(input);
    await user.type(input, " Existing ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Folder already exists");
    expect(input.value).toBe(" Existing ");
    await user.clear(input);
    await user.type(input, " Archive ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const renamed = await screen.findByRole("button", { name: "Archive", exact: true });
    expect(renamed.className).toContain("bg-indigo-50");
    expect(api.renameFolder).toHaveBeenLastCalledWith(1, "Archive");
    expect(screen.queryByRole("textbox", { name: "Rename folder" })).toBeNull();
  });

  it("shows a network error without losing the attempted name", async () => {
    api.renameFolder.mockRejectedValue(new Error("Network error"));
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Rename Reports" }));
    const input = screen.getByRole("textbox", { name: "Rename folder" });
    await user.clear(input);
    await user.type(input, "Archive");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Failed to rename folder");
    expect(input.value).toBe("Archive");
  });

  it("cancels editing without sending a request", async () => {
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Rename Reports" }));
    await user.type(screen.getByRole("textbox", { name: "Rename folder" }), " changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.renameFolder).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reports", exact: true })).toBeTruthy();
  });
});


function makeDocument(id, name, folder_id, content_type) {
  return {
    id, folder_id, original_filename: name, content_type, file_size: 1024,
    created_at: "2026-10-01T00:00:00.000Z",
  };
}

describe("document search clear", () => {
  it("hides the clear control while the search is empty", async () => {
    await openApp();
    expect(screen.getByRole("textbox", { name: "Search documents" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear document search" })).toBeNull();
  });

  it("clears search, restores all documents without reloading, and allows a new search", async () => {
    const fullList = [
      makeDocument(10, "quarterly-report.pdf", 1, "application/pdf"),
      makeDocument(11, "annual-budget.pdf", 1, "application/pdf"),
    ];
    const searchResult = makeDocument(12, "needle-match.txt", 1, "text/plain");
    const afterClearSearch = makeDocument(13, "second-search.txt", 1, "text/plain");
    api.default.get.mockResolvedValue({ data: fullList });
    api.searchDocuments.mockImplementation((query) =>
      Promise.resolve({ data: query === "needle" ? [searchResult] : query === "again" ? [afterClearSearch] : [] })
    );

    const user = await openApp();
    const input = screen.getByRole("textbox", { name: "Search documents" });
    await user.type(input, "needle");
    expect(await screen.findByText("needle-match.txt")).toBeTruthy();
    expect(screen.queryByText("quarterly-report.pdf")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear document search" }));
    expect(await screen.findByText("quarterly-report.pdf")).toBeTruthy();
    expect(screen.getByText("annual-budget.pdf")).toBeTruthy();
    expect(screen.queryByText("needle-match.txt")).toBeNull();
    await waitFor(() => expect(api.default.get).toHaveBeenLastCalledWith("/documents/"));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(api.getMe).toHaveBeenCalledTimes(1);

    await user.type(input, "again");
    expect(await screen.findByText("second-search.txt")).toBeTruthy();
    expect(api.searchDocuments).toHaveBeenLastCalledWith("again");
  });

  it("restores the active file-type and folder results", async () => {
    const report = makeDocument(20, "reports-q1.pdf", 1, "application/pdf");
    const archive = makeDocument(21, "archive-q1.pdf", 2, "application/pdf");
    const note = makeDocument(22, "reports-notes.txt", 1, "text/plain");
    const searchHit = makeDocument(23, "search-hit.pdf", 1, "application/pdf");
    api.default.get.mockImplementation((url) =>
      Promise.resolve({ data: url.includes("file_type=pdf") ? [report, archive] : [report, archive, note] })
    );
    api.searchDocuments.mockResolvedValue({ data: [searchHit] });

    const user = await openApp();
    await user.selectOptions(screen.getByRole("combobox", { name: "Type:" }), "pdf");
    expect(await screen.findByText("archive-q1.pdf")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reports", exact: true }));
    const input = screen.getByRole("textbox", { name: "Search documents" });
    await user.type(input, "hit");
    expect(await screen.findByText("search-hit.pdf")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear document search" }));
    expect(await screen.findByText("reports-q1.pdf")).toBeTruthy();
    expect(screen.queryByText("archive-q1.pdf")).toBeNull();
    expect(screen.queryByText("reports-notes.txt")).toBeNull();
    expect(screen.queryByText("search-hit.pdf")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Type:" }).value).toBe("pdf");
    expect(screen.getByRole("button", { name: "Reports", exact: true }).className).toContain("bg-indigo-50");
    expect(api.default.get).toHaveBeenLastCalledWith("/documents/?file_type=pdf");
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("clears the query with %s and returns focus to search", async (_key, activation) => {
    const user = await openApp();
    const input = screen.getByRole("textbox", { name: "Search documents" });
    await user.type(input, "x");
    const clear = await screen.findByRole("button", { name: "Clear document search" });
    expect(clear.type).toBe("button");
    await user.tab();
    expect(document.activeElement).toBe(clear);
    await user.keyboard(activation);
    await waitFor(() => expect(input.value).toBe(""));
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("button", { name: "Clear document search" })).toBeNull();
  });

  it("ignores a search response that arrives after the clear request", async () => {
    const fullDocument = makeDocument(30, "current-list.pdf", 1, "application/pdf");
    const staleDocument = makeDocument(31, "stale-search.pdf", 1, "application/pdf");
    let resolveSearch;
    api.default.get.mockResolvedValue({ data: [fullDocument] });
    api.searchDocuments.mockImplementation(() => new Promise((resolve) => { resolveSearch = resolve; }));

    const user = await openApp();
    const input = screen.getByRole("textbox", { name: "Search documents" });
    await user.type(input, "x");
    await user.click(await screen.findByRole("button", { name: "Clear document search" }));
    expect(await screen.findByText("current-list.pdf")).toBeTruthy();
    await act(async () => {
      resolveSearch({ data: [staleDocument] });
    });
    expect(screen.queryByText("stale-search.pdf")).toBeNull();
    expect(screen.getByText("current-list.pdf")).toBeTruthy();
  });
});

describe("saved filter presets", () => {
  it("saves the current folder, type, and sort and restores it after reload", async () => {
    const user = await openApp();
    await user.click(screen.getByRole("button", { name: "Reports", exact: true }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Type:" }), "pdf");
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort:" }), "name_asc");

    const name = screen.getByRole("textbox", { name: "Save current filters" });
    await user.type(name, "Quarterly reports");
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("status")).textContent).toContain("Saved preset");

    const stored = JSON.parse(localStorage.getItem("docvault:filter-presets:v1:1"));
    expect(stored).toEqual({
      version: 1,
      presets: [{ name: "Quarterly reports", folderId: 1, fileType: "pdf", sortBy: "name_asc" }],
    });

    cleanup();
    const reloadedUser = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "Rename Reports" });
    await screen.findByRole("option", { name: "Quarterly reports" });
    const select = screen.getByRole("combobox", { name: "Saved presets" });
    expect(select.querySelectorAll("option")).toHaveLength(2);
    await reloadedUser.selectOptions(select, "Quarterly reports");
    await reloadedUser.click(screen.getByRole("button", { name: "Apply preset" }));

    expect(screen.getByRole("combobox", { name: "Type:" }).value).toBe("pdf");
    expect(screen.getByRole("combobox", { name: "Sort:" }).value).toBe("name_asc");
    expect(screen.getByRole("button", { name: "Reports", exact: true }).className).toContain("bg-indigo-50");
    await waitFor(() => expect(api.default.get).toHaveBeenLastCalledWith("/documents/?file_type=pdf&sort_by=name_asc"));

    await reloadedUser.click(screen.getByRole("button", { name: "Delete preset" }));
    expect(await screen.findByText(/No saved presets yet/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("docvault:filter-presets:v1:1")).presets).toEqual([]);
  });

  it("clears search visibly before applying saved filters", async () => {
    const storage = {
      folderId: null,
      fileType: "pdf",
      sortBy: "date_desc",
    };
    saveFilterPresets(1, [{ name: "PDFs", ...storage }]);
    api.searchDocuments.mockResolvedValue({ data: [makeDocument(70, "secret-hit.pdf", null, "application/pdf")] });

    const user = await openApp();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    await user.type(search, "secret");
    expect(await screen.findByText("secret-hit.pdf")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Saved presets" }), "PDFs");
    await user.click(screen.getByRole("button", { name: "Apply preset" }));

    await waitFor(() => expect(search.value).toBe(""));
    expect((await screen.findByRole("status")).textContent).toContain("Search was cleared");
    await waitFor(() => expect(api.default.get).toHaveBeenLastCalledWith("/documents/?file_type=pdf"));
    expect(api.searchDocuments).toHaveBeenCalledWith("secret");
  });

  it("refuses presets whose folder is deleted or belongs to another user", async () => {
    saveFilterPresets(1, [{ name: "Unavailable folder", folderId: 99, fileType: "pdf", sortBy: "name_desc" }]);
    const user = await openApp();
    const preset = await screen.findByRole("option", { name: "Unavailable folder" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Saved presets" }), preset.value);
    await user.click(screen.getByRole("button", { name: "Apply preset" }));

    expect((await screen.findByRole("alert")).textContent).toContain("folder is no longer available");
    expect(screen.getByRole("combobox", { name: "Type:" }).value).toBe("all");
    expect(screen.getByRole("combobox", { name: "Sort:" }).value).toBe("date_desc");
    expect(screen.getByRole("button", { name: "All Documents" }).className).toContain("bg-indigo-50");
  });

  it("shows the empty state and supports saving and applying by keyboard", async () => {
    const user = await openApp();
    expect(await screen.findByText(/No saved presets yet/)).toBeTruthy();
    const name = screen.getByRole("textbox", { name: "Save current filters" });
    await user.type(name, "Keyboard preset");
    await user.keyboard("{Enter}");

    expect((await screen.findByRole("status")).textContent).toContain("Saved preset");
    expect(screen.getByRole("combobox", { name: "Saved presets" })).toBeTruthy();
    const apply = screen.getByRole("button", { name: "Apply preset" });
    apply.focus();
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("status")).textContent).toContain("Applied preset");
  });

  it("keeps browsing available when preset storage is blocked", async () => {
    const originalGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (key) {
      if (key.startsWith("docvault:filter-presets:")) throw new DOMException("blocked", "SecurityError");
      return originalGetItem.call(this, key);
    });

    await openApp();
    expect((await screen.findByRole("alert")).textContent).toContain("Saved presets are unavailable");
    expect(screen.getByRole("textbox", { name: "Search documents" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Type:" }).disabled).toBe(false);
  });

  it("does not let an old document response repopulate state after logout", async () => {
    let resolveSearch;
    api.searchDocuments.mockImplementation(() => new Promise((resolve) => { resolveSearch = resolve; }));
    const user = await openApp();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    await user.type(search, "stale");
    await waitFor(() => expect(api.searchDocuments).toHaveBeenCalledWith("stale"));
    await user.click(screen.getByRole("button", { name: /Logout/ }));
    expect(await screen.findByRole("heading", { name: "Sign in to your account" })).toBeTruthy();

    await act(async () => resolveSearch({ data: [makeDocument(80, "old-account.pdf", 1, "application/pdf")] }));
    expect(screen.queryByText("old-account.pdf")).toBeNull();
    expect(screen.queryByText("Quarterly reports")).toBeNull();
  });

  it("loads a separate preset list after switching accounts", async () => {
    saveFilterPresets(1, [{ name: "Alice only", folderId: null, fileType: "pdf", sortBy: "date_desc" }]);
    api.getMe
      .mockResolvedValueOnce({ data: { id: 1, username: "alice" } })
      .mockResolvedValueOnce({ data: { id: 2, username: "bob" } });
    api.login.mockResolvedValue({ data: { access_token: "second-token" } });

    const user = await openApp();
    await user.click(screen.getByRole("button", { name: /Logout/ }));
    await user.type(document.querySelector('input[type="text"]'), "bob");
    await user.type(document.querySelector('input[type="password"]'), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("button", { name: "Rename Reports" });
    expect(await screen.findByText("bob")).toBeTruthy();
    expect(screen.getByText(/No saved presets yet/)).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Alice only" })).toBeNull();
    expect(api.login).toHaveBeenCalledWith("bob", "password");

    await user.click(screen.getByRole("button", { name: /Logout/ }));
    expect(document.querySelector('input[type="password"]').value).toBe("");
  });

  it("keeps existing file-type and sorting requests intact", async () => {
    const user = await openApp();
    await user.selectOptions(screen.getByRole("combobox", { name: "Type:" }), "image");
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort:" }), "date_asc");

    await waitFor(() => expect(api.default.get).toHaveBeenLastCalledWith("/documents/?file_type=image&sort_by=date_asc"));
  });
});
