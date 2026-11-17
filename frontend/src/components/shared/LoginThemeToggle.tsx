"use client";

import { STORAGE_KEYS, readStoredPreference, writeStoredPreference } from "@/lib/browser-storage";

import { useTranslation } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore, type ThemeMode } from "@/stores/useUiStore";

const THEME_STORAGE_KEY = STORAGE_KEYS.theme;
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

function applyTheme(theme: ThemeMode, prefersDark: boolean) {
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && prefersDark),
  );
}

function useLoginTheme() {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const [prefersDark, setPrefersDark] = useState(false);

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
    setPrefersDark(media?.matches ?? false);
    applyTheme(initialTheme, media?.matches ?? false);

    const onSystemThemeChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
      if (useUiStore.getState().theme === "system") {
        applyTheme("system", event.matches);
      }
    };
    media?.addEventListener("change", onSystemThemeChange);
    return () => media?.removeEventListener("change", onSystemThemeChange);
  }, [setTheme]);

  const resolvedTheme = theme === "system" ? (prefersDark ? "dark" : "light") : theme;

  function toggleTheme() {
    const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    applyTheme(nextTheme, prefersDark);
    try {
      writeStoredPreference(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Apply the choice for this visit even if it cannot be saved.
    }
  }

  return { resolvedTheme, toggleTheme };
}

export function LoginThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { resolvedTheme, toggleTheme } = useLoginTheme();
  const label = t(resolvedTheme === "dark" ? "Light mode" : "Dark mode");
  const Icon = resolvedTheme === "dark" ? Sun : Moon;

  return (
    <div className={cn("inline-flex rounded-full border border-border bg-card p-1 shadow-sm", className)}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={toggleTheme}
        className="flex size-8 items-center justify-center rounded-full text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
