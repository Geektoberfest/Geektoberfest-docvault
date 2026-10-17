import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  interceptors: { request: { use: vi.fn() } },
  post: vi.fn(),
}));

vi.mock("axios", () => ({ default: { create: () => mockApi } }));

import api, { bulkDeleteDocuments, uploadDocument } from "./api";

describe("uploadDocument request options", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes progress and abort signals through to Axios", () => {
    const formData = new FormData();
    const controller = new AbortController();
    const onUploadProgress = vi.fn();

    uploadDocument(formData, { signal: controller.signal, onUploadProgress });

    expect(api.post).toHaveBeenCalledWith("/documents/upload", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      signal: controller.signal,
      onUploadProgress,
    });
  });

  it("preserves the bulk-delete Axios contract", () => {
    bulkDeleteDocuments([4, 5]);
    expect(api.post).toHaveBeenCalledWith("/documents/bulk-delete", { document_ids: [4, 5] });
  });
});
