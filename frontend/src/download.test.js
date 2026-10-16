// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveDownload } from "./download";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:download");
    static revokeObjectURL = vi.fn();
  });
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser download resources", () => {
  it("does not confuse compressed wire size with the decoded blob size", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    saveDownload({ data: new Blob(["decoded data"]), headers: { "content-length": "4", "content-encoding": "gzip" } }, "report.txt");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("does not create a browser URL for a malformed response", () => {
    expect(() => saveDownload({ data: "not a blob" }, "report.txt")).toThrow();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("preserves Unicode and spaces while removing path and control characters", () => {
    let savedName;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { savedName = this.download; });
    saveDownload({ data: new Blob(["hello"]), headers: {} }, '../r\u00e9sum\u00e9 "2026"\r\n.pdf');
    expect(savedName).toBe("r\u00e9sum\u00e9 _2026___.pdf");
    expect(document.querySelector("a[download]")).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("releases the URL even when the browser click fails", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("browser failed"); });
    expect(() => saveDownload({ data: new Blob(), headers: {} }, "empty.txt")).toThrow();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
