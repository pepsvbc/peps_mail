import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStoredPreference, STORAGE_KEYS, writeStoredPreference } from "../browser-storage";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("browser storage", () => {
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
});
