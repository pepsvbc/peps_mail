import { STORAGE_KEYS, readStoredPreference, writeStoredPreference } from "@/lib/browser-storage";
import { create } from "zustand";

export type Language = "en" | "fr";
export type LanguagePreference = Language | "system";
export const LANGUAGE_STORAGE_KEY = STORAGE_KEYS.language;

export function normalizeLanguage(value: unknown): Language | undefined {
  if (typeof value !== "string") return undefined;
  const primary = value.toLowerCase().split(/[-_]/)[0];
  return primary === "en" || primary === "fr" ? primary : undefined;
}

export function detectLanguage(languages: readonly string[]): Language {
  for (const language of languages) {
    const supported = normalizeLanguage(language);
    if (supported) return supported;
  }
  return "en";
}

function browserLanguage(): Language {
  return typeof navigator === "undefined"
    ? "en"
    : detectLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

function readPreference(): LanguagePreference | undefined {
  try {
    const value = readStoredPreference(LANGUAGE_STORAGE_KEY);
    return value === "system" ? "system" : normalizeLanguage(value);
  } catch {
    return undefined;
  }
}

interface LanguageState {
  language: Language;
  preference: LanguagePreference;
  initialized: boolean;
  hasStoredPreference: boolean;
  initialize: () => void;
  setLanguage: (preference: LanguagePreference) => void;
  applyAccountLanguage: (preference: string) => void;
}

export const useLanguageStore = create<LanguageState>((set, get) => ({
  language: "en",
  preference: "system",
  initialized: false,
  hasStoredPreference: false,
  initialize: () => {
    if (get().initialized) return;
    const stored = readPreference();
    const preference = stored ?? "system";
    set({
      language: preference === "system" ? browserLanguage() : preference,
      preference,
      initialized: true,
      hasStoredPreference: stored !== undefined,
    });
  },
  setLanguage: (preference) => {
    set({
      language: preference === "system" ? browserLanguage() : preference,
      preference,
      initialized: true,
      hasStoredPreference: true,
    });
    try {
      writeStoredPreference(LANGUAGE_STORAGE_KEY, preference);
    } catch {
      // The choice still applies for this visit when storage is blocked.
    }
  },
  applyAccountLanguage: (preference) => {
    get().initialize();
    // An explicit choice on this device also applies before login and across accounts.
    // A saved account preference fills in the choice on a new browser.
    if (get().hasStoredPreference) return;
    const language = normalizeLanguage(preference);
    if (language) get().setLanguage(language);
  },
}));

export function getLanguage(): Language {
  return useLanguageStore.getState().language;
}

export function getLocale(): "en-GB" | "fr-CH" {
  return getLanguage() === "fr" ? "fr-CH" : "en-GB";
}
