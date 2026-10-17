export const MAX_FILTER_PRESETS = 20;
export const MAX_FILTER_PRESET_NAME_LENGTH = 40;

const FILE_TYPES = new Set(["all", "pdf", "image", "text"]);
const SORT_OPTIONS = new Set(["date_desc", "date_asc", "name_asc", "name_desc"]);

function getStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function validUserId(userId) {
  return Number.isSafeInteger(userId) && userId > 0;
}

export function getFilterPresetsStorageKey(userId) {
  return `docvault:filter-presets:v1:${userId}`;
}

export function normalizeFilterPreset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const name = typeof value.name === "string" ? value.name.trim() : "";
  const folderId = value.folderId;
  if (
    !name ||
    name.length > MAX_FILTER_PRESET_NAME_LENGTH ||
    !(folderId === null || (Number.isSafeInteger(folderId) && folderId > 0)) ||
    !FILE_TYPES.has(value.fileType) ||
    !SORT_OPTIONS.has(value.sortBy)
  ) {
    return null;
  }

  return { name, folderId, fileType: value.fileType, sortBy: value.sortBy };
}

export function loadFilterPresets(userId, storage = getStorage()) {
  if (!validUserId(userId)) {
    return { presets: [], error: "identity-unavailable", storageAvailable: false };
  }
  if (!storage || typeof storage.getItem !== "function") {
    return { presets: [], error: "storage-unavailable", storageAvailable: false };
  }

  let raw;
  try {
    raw = storage.getItem(getFilterPresetsStorageKey(userId));
  } catch {
    return { presets: [], error: "storage-unavailable", storageAvailable: false };
  }
  if (raw === null) return { presets: [], error: "", storageAvailable: true };

  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.presets)) {
      return { presets: [], error: "invalid-data", storageAvailable: true };
    }

    const presets = [];
    const names = new Set();
    let invalid = data.presets.length > MAX_FILTER_PRESETS;
    for (const item of data.presets.slice(0, MAX_FILTER_PRESETS)) {
      const preset = normalizeFilterPreset(item);
      const nameKey = preset?.name.toLowerCase();
      if (!preset || names.has(nameKey)) {
        invalid = true;
        continue;
      }
      names.add(nameKey);
      presets.push(preset);
    }

    return { presets, error: invalid ? "invalid-data" : "", storageAvailable: true };
  } catch {
    return { presets: [], error: "invalid-data", storageAvailable: true };
  }
}

export function saveFilterPresets(userId, presets, storage = getStorage()) {
  if (!validUserId(userId)) return { ok: false, error: "identity-unavailable" };
  if (!storage || typeof storage.setItem !== "function") {
    return { ok: false, error: "storage-unavailable" };
  }
  if (!Array.isArray(presets) || presets.length > MAX_FILTER_PRESETS) {
    return { ok: false, error: "invalid-data" };
  }

  const normalized = [];
  const names = new Set();
  for (const item of presets) {
    const preset = normalizeFilterPreset(item);
    const nameKey = preset?.name.toLowerCase();
    if (!preset || names.has(nameKey)) return { ok: false, error: "invalid-data" };
    names.add(nameKey);
    normalized.push(preset);
  }

  try {
    storage.setItem(
      getFilterPresetsStorageKey(userId),
      JSON.stringify({ version: 1, presets: normalized }),
    );
    return { ok: true, presets: normalized };
  } catch {
    return { ok: false, error: "storage-unavailable" };
  }
}

export function createFilterPreset(presets, name, filters) {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName) return { error: "blank-name" };
  if (normalizedName.length > MAX_FILTER_PRESET_NAME_LENGTH) return { error: "name-too-long" };
  if (presets.length >= MAX_FILTER_PRESETS) return { error: "preset-limit" };
  if (presets.some((preset) => preset.name.toLowerCase() === normalizedName.toLowerCase())) {
    return { error: "duplicate-name" };
  }

  const preset = normalizeFilterPreset({ ...filters, name: normalizedName });
  if (!preset) return { error: "invalid-filter" };
  return { preset, presets: [...presets, preset] };
}

export function deleteFilterPreset(presets, name) {
  const nameKey = typeof name === "string" ? name.toLowerCase() : "";
  return presets.filter((preset) => preset.name.toLowerCase() !== nameKey);
}
