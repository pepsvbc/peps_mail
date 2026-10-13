"use client";

import { STORAGE_KEYS, readStoredPreference, writeStoredPreference } from "@/lib/browser-storage";

import { useTranslation } from "@/lib/i18n";

import { useEffect } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUiStore, type ThemeMode } from "@/stores/useUiStore";

const THEME_STORAGE_KEY = STORAGE_KEYS.theme;
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
const options = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

function applyTheme(theme: ThemeMode, prefersDark: boolean) {
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && prefersDark),
  );
}

function useLoginTheme() {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);

  useEffect(() => {
    let initialTheme: ThemeMode = "system";
    try {
      const stored = readStoredPreference(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") {
        initialTheme = stored;
      }
    } catch {
      // Theme selection still works when browser storage is unavailable.
    }

    const media = window.matchMedia?.(SYSTEM_THEME_QUERY);
    setTheme(initialTheme);
    applyTheme(initialTheme, media?.matches ?? false);

    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      if (useUiStore.getState().theme === "system") {
        applyTheme("system", event.matches);
      }
    };
    media?.addEventListener("change", onSystemThemeChange);
    return () => media?.removeEventListener("change", onSystemThemeChange);
  }, [setTheme]);

  function selectTheme(nextTheme: ThemeMode) {
    setTheme(nextTheme);
    applyTheme(nextTheme, window.matchMedia?.(SYSTEM_THEME_QUERY).matches ?? false);
    try {
      writeStoredPreference(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Apply the choice for this visit even if it cannot be saved.
    }
  }

  return { theme, selectTheme };
}

export function LoginThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, selectTheme } = useLoginTheme();

  return (
    <div
      role="group"
      aria-label={t("Color theme")}
      className={cn("inline-flex gap-1 rounded-full border border-border bg-card p-1 shadow-sm", className)}
    >
      {options.map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={theme === value ? "default" : "ghost"}
          className="rounded-full text-xs"
          aria-pressed={theme === value}
          onClick={() => selectTheme(value)}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {t(label)}
        </Button>
      ))}
    </div>
  );
}
