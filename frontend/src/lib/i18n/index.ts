import { useMemo } from "react";
import { useLanguageStore, getLanguage, type Language } from "./language-store";
import { mailMessages } from "./messages/mail";
import { organizerMessages } from "./messages/organizer";
import { sharedMessages } from "./messages/shared";
import { publicMessages } from "./messages/public";

export { useLanguageStore, getLanguage, getLocale, normalizeLanguage, detectLanguage, LANGUAGE_STORAGE_KEY } from "./language-store";
export type { Language, LanguagePreference } from "./language-store";

// The English source strings form the English catalog. Domain dictionaries supply
// French translations; an untranslated key keeps its readable English fallback.
export const frenchMessages: Record<string, string> = {
  ...mailMessages,
  ...organizerMessages,
  ...sharedMessages,
  ...publicMessages,
};

export type TranslationValues = Record<string, string | number>;

export function translate(message: string, values?: TranslationValues, language: Language = getLanguage()): string {
  const translated = language === "fr" ? frenchMessages[message] ?? message : message;
  return translated.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    return values && Object.hasOwn(values, name) ? String(values[name]) : placeholder;
  });
}

export function useTranslation() {
  const language = useLanguageStore((state) => state.language);
  const t = useMemo(
    () => (message: string, values?: TranslationValues) => translate(message, values, language),
    [language],
  );
  return { t, language, locale: language === "fr" ? "fr-CH" : "en-GB" } as const;
}
