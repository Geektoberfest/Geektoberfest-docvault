import { expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  interceptors: { request: { use: vi.fn() } }, get: vi.fn(),
}));
vi.mock("axios", () => ({ default: { create: () => client } }));
import { downloadDocument } from "./api";
const interceptor = client.interceptors.request.use.mock.calls[0][0];

it("uses the existing authenticated Axios instance with a blob response and abort signal", () => {
  const signal = new AbortController().signal;
  downloadDocument(12, signal);
  expect(client.get).toHaveBeenCalledWith("/documents/12/download", { responseType: "blob", signal });
  vi.stubGlobal("localStorage", { getItem: () => "private-token" });
  expect(interceptor({ headers: {} }).headers.Authorization).toBe("Bearer private-token");
  vi.unstubAllGlobals();
});
