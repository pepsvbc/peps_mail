import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStoredPreference, STORAGE_KEYS, writeStoredPreference } from "../browser-storage";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("browser storage migration", () => {
  it.each([
    [STORAGE_KEYS.theme, "oxi-theme", "dark"],
    [STORAGE_KEYS.language, "oxi-language", "fr"],
    [STORAGE_KEYS.uiSettings, "oxi-ui-settings", '{"sidebarWidth":240}'],
    [STORAGE_KEYS.activeAccountId, "oxi-active-account-id", "account-2"],
    [STORAGE_KEYS.notificationBannerDismissed, "oxi-notif-banner-dismissed", "true"],
  ] as const)("migrates %s without losing its value", (key, legacyKey, value) => {
    localStorage.setItem(legacyKey, value);
    expect(readStoredPreference(key)).toBe(value);
    expect(localStorage.getItem(key)).toBe(value);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(readStoredPreference(key)).toBe(value);
  });

  it("keeps newer preferences and removes stale originals", () => {
    localStorage.setItem("oxi-theme", "dark");
    localStorage.setItem(STORAGE_KEYS.theme, "light");
    expect(readStoredPreference(STORAGE_KEYS.theme)).toBe("light");
    expect(localStorage.getItem("oxi-theme")).toBeNull();
  });

  it("still reads the original if the migrated value cannot be saved", () => {
    localStorage.setItem("oxi-theme", "dark");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    expect(readStoredPreference(STORAGE_KEYS.theme)).toBe("dark");
    expect(localStorage.getItem("oxi-theme")).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEYS.theme)).toBeNull();
  });

  it("tolerates blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(readStoredPreference(STORAGE_KEYS.theme)).toBeNull();
    expect(() => writeStoredPreference(STORAGE_KEYS.theme, "dark")).not.toThrow();
  });

  it("writes only the new preference and removes the original", () => {
    localStorage.setItem("oxi-language", "en");
    writeStoredPreference(STORAGE_KEYS.language, "fr");
    expect(localStorage.getItem(STORAGE_KEYS.language)).toBe("fr");
    expect(localStorage.getItem("oxi-language")).toBeNull();
  });

  it("clears both account keys so a removed account cannot reappear", () => {
    localStorage.setItem("oxi-active-account-id", "account-1");
    localStorage.setItem(STORAGE_KEYS.activeAccountId, "account-2");
    writeStoredPreference(STORAGE_KEYS.activeAccountId, null);
    expect(readStoredPreference(STORAGE_KEYS.activeAccountId)).toBeNull();
    expect(localStorage.getItem("oxi-active-account-id")).toBeNull();
  });
});
