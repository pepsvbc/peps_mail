import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectLanguage, frenchMessages, getLocale, LANGUAGE_STORAGE_KEY,
  normalizeLanguage, translate, useLanguageStore,
} from "@/lib/i18n";

beforeEach(() => {
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-CH", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
});

describe("language selection and persistence", () => {
  it("migrates the saved language before applying account preferences", () => {
    localStorage.setItem("oxi-language", "en");
    useLanguageStore.getState().initialize();
    useLanguageStore.getState().applyAccountLanguage("fr");
    expect(getLocale()).toBe("en-GB");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(localStorage.getItem("oxi-language")).toBeNull();
  });

  it("uses the first supported browser language with an English fallback", () => {
    expect(detectLanguage(["de-CH", "fr-FR", "en"])).toBe("fr");
    expect(detectLanguage(["en-US", "fr-CH"])).toBe("en");
    expect(detectLanguage(["de", "it"])).toBe("en");
    expect(normalizeLanguage("fr_CH")).toBe("fr");
    expect(normalizeLanguage("unknown")).toBeUndefined();
    useLanguageStore.getState().initialize();
    expect(getLocale()).toBe("fr-CH");
  });

  it("honours the saved browser choice before account preferences", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    useLanguageStore.getState().initialize();
    useLanguageStore.getState().applyAccountLanguage("fr");
    expect(getLocale()).toBe("en-GB");
  });

  it("uses the account preference on a new browser and remembers it", () => {
    useLanguageStore.getState().applyAccountLanguage("en");
    expect(getLocale()).toBe("en-GB");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
  });

  it("keeps a choice made before initialization and across account changes", () => {
    useLanguageStore.getState().setLanguage("fr");
    useLanguageStore.getState().initialize();
    useLanguageStore.getState().applyAccountLanguage("en");
    expect(getLocale()).toBe("fr-CH");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("fr");
  });

  it("lets an explicit browser-language preference override a saved account language", () => {
    useLanguageStore.getState().setLanguage("en");
    useLanguageStore.getState().setLanguage("system");
    useLanguageStore.getState().applyAccountLanguage("en");
    expect(getLocale()).toBe("fr-CH");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("system");
  });

  it("ignores unsupported saved values and works when storage is blocked", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "de");
    useLanguageStore.getState().initialize();
    expect(getLocale()).toBe("fr-CH");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => useLanguageStore.getState().setLanguage("en")).not.toThrow();
    expect(getLocale()).toBe("en-GB");
  });
});

describe("translation catalogs", () => {
  it("keeps readable English fallbacks and interpolates values once", () => {
    expect(translate("An unknown message for {name}", { name: "{count}" }, "fr"))
      .toBe("An unknown message for {count}");
    expect(translate("Sign in", undefined, "en")).toBe("Sign in");
    expect(translate("Sign in", undefined, "fr")).toBe("Se connecter");
  });

  it("preserves all interpolation values in every French translation", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [english, french] of Object.entries(frenchMessages)) {
      expect(french.trim(), english).not.toBe("");
      expect(placeholders(french), english).toEqual(placeholders(english));
    }
  });
});
