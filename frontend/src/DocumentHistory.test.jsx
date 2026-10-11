// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";

vi.mock("./api", () => ({
  API_URL: "http://localhost:8000", getDocuments: vi.fn(), getFolders: vi.fn(),
  getMe: vi.fn(), getDocumentVersions: vi.fn(), uploadDocumentVersion: vi.fn(),
  deleteDocument: vi.fn(), uploadDocument: vi.fn(), deleteFolder: vi.fn(),
  createFolder: vi.fn(), renameFolder: vi.fn(), searchDocuments: vi.fn(), login: vi.fn(), register: vi.fn(),
}));

let documents;
let versions;

function version(number, name = "report.txt") {
  return { version_number: number, original_filename: name, file_size: 100,
    content_type: "text/plain", created_at: `2026-10-0${number}T12:00:00` };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem("token", "test-token");
  documents = [{ id: 1, original_filename: "report.txt", file_size: 100,
    created_at: "2026-10-01T12:00:00", current_version: 2, folder_id: null }];
  versions = [version(2), version(1)];
  api.getMe.mockResolvedValue({ data: { username: "alice" } });
  api.getDocuments.mockImplementation(async () => ({ data: [...documents] }));
  api.getFolders.mockResolvedValue({ data: [] });
  api.getDocumentVersions.mockImplementation(async () => ({ data: [...versions] }));
  api.uploadDocumentVersion.mockImplementation(async (id, form) => {
    const file = form.get("file");
    versions = [version(3, file.name), ...versions];
    documents = [{ ...documents[0], original_filename: file.name, current_version: 3 }];
    return { data: documents[0] };
  });
});

afterEach(() => { cleanup(); localStorage.clear(); });

async function openHistory() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Version history for report.txt" }));
  await screen.findByText("Version 2 (current)");
  return user;
}

describe("document version history", () => {
  it("keeps file-type filtering and search working alongside history", async () => {
    const user = await openHistory();
    const pdf = { ...documents[0], id: 2, original_filename: "manual.pdf", content_type: "application/pdf" };
    const text = { ...documents[0], content_type: "text/plain" };
    api.getDocuments.mockResolvedValue({ data: [pdf] });
    await user.selectOptions(screen.getByLabelText("Type:"), "pdf");
    await screen.findByRole("button", { name: "Version history for manual.pdf" });
    expect(api.getDocuments).toHaveBeenLastCalledWith("pdf");
    expect(screen.queryByRole("button", { name: "Version history for report.txt" })).toBeNull();
    expect(screen.getByText("Version 2 (current)")).toBeTruthy();

    api.searchDocuments.mockResolvedValue({ data: [text] });
    await user.type(screen.getByPlaceholderText("Search documents..."), "report");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Version history for manual.pdf" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Version history for report.txt" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Type:"), "all");
    await screen.findByRole("button", { name: "Version history for report.txt" });
    expect(api.searchDocuments).toHaveBeenLastCalledWith("report");
  });

  it("opens history with timestamps, current indicator, and version download links", async () => {
    await openHistory();
    const list = screen.getByRole("list", { name: "Document versions" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Version 1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download version 1" }).href)
      .toBe("http://localhost:8000/documents/1/versions/1/download?token=test-token");
    expect(within(list).getAllByText(/2026/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Upload new version", exact: true }).disabled).toBe(true);
  });

  it("uploads a replacement and refreshes history and the main list", async () => {
    const user = await openHistory();
    const file = new File(["new version"], "revised.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText(/Upload new version/), file);
    await user.click(screen.getByRole("button", { name: "Upload new version", exact: true }));
    await screen.findByText("Version 3 (current)");
    expect(screen.getByText("Version 3 uploaded successfully.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Version history for revised.txt" })).toBeTruthy();
    expect(api.uploadDocumentVersion.mock.lastCall[0]).toBe(1);
    expect(api.uploadDocumentVersion.mock.lastCall[1].get("file")).toBe(file);
    expect(screen.getByLabelText(/Upload new version/).files).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Download version 1" })).toBeTruthy();
  });

  it("keeps the file and existing history after a rejected replacement", async () => {
    api.uploadDocumentVersion.mockRejectedValue({ response: { data: { detail: "Could not save new version; current version is unchanged" } } });
    const user = await openHistory();
    const file = new File(["new"], "revised.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText(/Upload new version/), file);
    await user.click(screen.getByRole("button", { name: "Upload new version", exact: true }));
    expect((await screen.findByRole("alert")).textContent).toContain("current version is unchanged");
    expect(screen.getByLabelText(/Upload new version/).files[0]).toBe(file);
    expect(screen.getByText("Version 2 (current)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Version history for report.txt" })).toBeTruthy();
  });

  it("handles an uncertain network failure without claiming the server rolled back", async () => {
    api.uploadDocumentVersion.mockRejectedValue(new Error("Network failed"));
    const user = await openHistory();
    await user.upload(screen.getByLabelText(/Upload new version/), new File(["new"], "revised.txt"));
    await user.click(screen.getByRole("button", { name: "Upload new version", exact: true }));
    expect((await screen.findByRole("alert")).textContent).toContain("Refresh history");
    expect(screen.getByRole("button", { name: "Refresh history" })).toBeTruthy();
  });

  it("rejects oversized files before sending a replacement", async () => {
    const user = await openHistory();
    const file = new File(["large"], "large.txt");
    Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 + 1 });
    await user.upload(screen.getByLabelText(/Upload new version/), file);
    await user.click(screen.getByRole("button", { name: "Upload new version", exact: true }));
    expect(screen.getByRole("alert").textContent).toContain("10MB");
    expect(api.uploadDocumentVersion).not.toHaveBeenCalled();
  });

  it("disables repeat uploads and closing while a replacement is in progress", async () => {
    let complete;
    api.uploadDocumentVersion.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const user = await openHistory();
    await user.upload(screen.getByLabelText(/Upload new version/), new File(["new"], "revised.txt"));
    await user.click(screen.getByRole("button", { name: "Upload new version", exact: true }));
    expect(screen.getByRole("button", { name: "Uploading version..." }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Close history" }).disabled).toBe(true);
    expect(screen.getByLabelText(/Upload new version/).disabled).toBe(true);
    await act(async () => complete({ data: { ...documents[0], current_version: 3 } }));
    expect(api.uploadDocumentVersion).toHaveBeenCalledTimes(1);
  });

  it("allows retrying a failed history request", async () => {
    api.getDocumentVersions.mockRejectedValueOnce(new Error("Network failed"));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Version history for report.txt" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load version history");
    await user.click(screen.getByRole("button", { name: "Refresh history" }));
    await screen.findByText("Version 2 (current)");
  });

  it("closes history without modifying the document", async () => {
    const user = await openHistory();
    await user.click(screen.getByRole("button", { name: "Close history" }));
    expect(screen.queryByRole("heading", { name: "Version history" })).toBeNull();
    expect(api.uploadDocumentVersion).not.toHaveBeenCalled();
  });

  it("ignores a stale history response when switching documents", async () => {
    documents.push({ ...documents[0], id: 2, original_filename: "other.txt", current_version: 1 });
    let complete;
    api.getDocumentVersions.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    api.getDocumentVersions.mockResolvedValueOnce({ data: [version(1, "other.txt")] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Version history for report.txt" }));
    const signal = api.getDocumentVersions.mock.lastCall[1];
    await user.click(screen.getByRole("button", { name: "Version history for other.txt" }));
    await screen.findByText("Version 1 (current)");
    await act(async () => complete({ data: versions }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText("Version 2 (current)")).toBeNull();
    expect(screen.getByRole("link", { name: "Download version 1" }).href).toContain("/documents/2/");
  });
});
