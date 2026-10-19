"use client";

import { useTranslation, useLanguageStore } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LanguageSwitcher({ className }: { className?: string }) {
  const { t, language } = useTranslation();
  const setLanguage = useLanguageStore((state) => state.setLanguage);

  return (
    <div role="group" aria-label={t("Interface language")} className={cn("inline-flex gap-1 rounded-full border border-border bg-card p-1", className)}>
      {(["en", "fr"] as const).map((value) => (
        <button
          key={value}
          type="button"
          lang={value}
          aria-label={value === "en" ? "English" : "Français"}
          aria-pressed={language === value}
          onClick={() => setLanguage(value)}
          className={cn("min-h-8 rounded-full px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", language === value ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent")}
        >
          {value.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
