import { describe, expect, it } from "vitest";
import {
  createFilterPreset,
  deleteFilterPreset,
  getFilterPresetsStorageKey,
  loadFilterPresets,
  MAX_FILTER_PRESETS,
  saveFilterPresets,
} from "./filterPresets";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const filters = { folderId: 12, fileType: "pdf", sortBy: "name_asc" };

describe("saved filter presets", () => {
  it("creates, persists, reloads, and deletes a preset", () => {
    const storage = memoryStorage();
    const created = createFilterPreset([], "  Reports  ", filters);
    expect(created.preset).toEqual({ name: "Reports", ...filters });

    expect(saveFilterPresets(7, created.presets, storage).ok).toBe(true);
    expect(loadFilterPresets(7, storage).presets).toEqual([created.preset]);

    const remaining = deleteFilterPreset(loadFilterPresets(7, storage).presets, "Reports");
    expect(saveFilterPresets(7, remaining, storage).ok).toBe(true);
    expect(loadFilterPresets(7, storage).presets).toEqual([]);
  });

  it("rejects blank, duplicate, oversized, and over-limit names", () => {
    const first = createFilterPreset([], "Reports", filters);
    expect(createFilterPreset([], " \t ", filters).error).toBe("blank-name");
    expect(createFilterPreset(first.presets, " reports ", filters).error).toBe("duplicate-name");
    expect(createFilterPreset([], "x".repeat(41), filters).error).toBe("name-too-long");

    const full = Array.from({ length: MAX_FILTER_PRESETS }, (_, index) => ({
      name: `Preset ${index}`,
      ...filters,
    }));
    expect(createFilterPreset(full, "One more", filters).error).toBe("preset-limit");
  });

  it("isolates storage by stable user ID", () => {
    const storage = memoryStorage();
    const created = createFilterPreset([], "Private", filters);
    saveFilterPresets(7, created.presets, storage);

    expect(getFilterPresetsStorageKey(7)).not.toBe(getFilterPresetsStorageKey(8));
    expect(loadFilterPresets(8, storage).presets).toEqual([]);
    expect(loadFilterPresets(7, storage).presets).toEqual(created.presets);
  });

  it("ignores malformed JSON and unsupported stored values without throwing", () => {
    const storage = memoryStorage();
    storage.setItem(getFilterPresetsStorageKey(7), "{");
    expect(loadFilterPresets(7, storage)).toMatchObject({ presets: [], error: "invalid-data" });

    storage.setItem(getFilterPresetsStorageKey(7), JSON.stringify({
      version: 1,
      presets: [
        { name: "Invalid type", folderId: null, fileType: "video", sortBy: "date_desc" },
        { name: "Invalid sort", folderId: null, fileType: "all", sortBy: "random" },
        { name: "Valid", folderId: null, fileType: "all", sortBy: "date_desc", documentIds: [1] },
      ],
    }));

    const loaded = loadFilterPresets(7, storage);
    expect(loaded.error).toBe("invalid-data");
    expect(loaded.presets).toEqual([{ name: "Valid", folderId: null, fileType: "all", sortBy: "date_desc" }]);
    expect(loaded.presets[0]).not.toHaveProperty("documentIds");
  });

  it("reports unavailable storage for reads and writes without throwing", () => {
    const storage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    };

    expect(loadFilterPresets(7, storage)).toMatchObject({
      presets: [], error: "storage-unavailable", storageAvailable: false,
    });
    expect(saveFilterPresets(7, [], storage)).toMatchObject({ ok: false, error: "storage-unavailable" });
  });

  it("rejects unsupported filters and never persists pagination or document state", () => {
    expect(createFilterPreset([], "Invalid", { ...filters, fileType: "video" }).error).toBe("invalid-filter");
    expect(createFilterPreset([], "Invalid folder", { ...filters, folderId: 0 }).error).toBe("invalid-filter");

    const storage = memoryStorage();
    const created = createFilterPreset([], "Saved", { ...filters, page: 9, documentIds: [22] });
    expect(created.preset).toEqual({ name: "Saved", ...filters });
    saveFilterPresets(7, created.presets, storage);
    expect(JSON.parse(storage.getItem(getFilterPresetsStorageKey(7)))).toEqual({
      version: 1,
      presets: [{ name: "Saved", ...filters }],
    });
  });
});
