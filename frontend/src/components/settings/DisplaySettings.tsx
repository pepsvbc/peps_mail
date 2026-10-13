"use client";

import { DEFAULT_MAIL_DENSITY, type MailDensity } from "@/lib/mail-density";

import { useTranslation, useLanguageStore, type LanguagePreference } from "@/lib/i18n";

import {
  useDisplayPreferences,
  useUpdateDisplayPreferences,
} from "@/hooks/useDisplayPreferences";
import type { AnimationMode } from "@/lib/motion/config";
import { runThemeSpreadTransition } from "@/lib/motion/theme-spread";
import { cn } from "@/lib/utils";
import type { ThemeMode } from "@/stores/useUiStore";
import { useUiStore } from "@/stores/useUiStore";
import { Code2, FileText, Loader2, Monitor, Moon, Search, Sun } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";

function SegmentedControl<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: T;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap rounded-lg border border-border bg-muted/50 p-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              value === opt.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DisplaySettings() {
  const { t } = useTranslation();
  const languagePreference = useLanguageStore((s) => s.preference);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const { data: prefs, isLoading } = useDisplayPreferences();
  const updatePrefs = useUpdateDisplayPreferences();
  const setDensity = useUiStore((s) => s.setDensity);
  const setTheme = useUiStore((s) => s.setTheme);
  const setComposeFormat = useUiStore((s) => s.setComposeFormat);
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);

  const handleDensityChange = useCallback(
    (density: MailDensity) => {
      setDensity(density);
      updatePrefs.mutate(
        { density },
        { onError: (e) => toast.error(t("Failed to update: {message}", { message: e.message })) },
      );
    },
    [setDensity, updatePrefs, t],
  );

  const handleThemeChange = useCallback(
    (theme: ThemeMode) => {
      runThemeSpreadTransition({
        mode: effectiveAnimationMode,
        trigger: "explicit",
        applyTheme: () => setTheme(theme),
        nextTheme: theme,
      });
      updatePrefs.mutate(
        { theme },
        { onError: (e) => toast.error(t("Failed to update: {message}", { message: e.message })) },
      );
    },
    [effectiveAnimationMode, setTheme, updatePrefs, t],
  );

  const handleComposeFormatChange = useCallback(
    (compose_format: "html" | "text") => {
      setComposeFormat(compose_format);
      updatePrefs.mutate(
        { compose_format },
        { onError: (e) => toast.error(t("Failed to update: {message}", { message: e.message })) },
      );
    },
    [setComposeFormat, updatePrefs, t],
  );

  const handleAnimationModeChange = useCallback(
    (animation_mode: AnimationMode) => {
      updatePrefs.mutate(
        { animation_mode },
        { onError: (e) => toast.error(t("Failed to update: {message}", { message: e.message })) },
      );
    },
    [updatePrefs, t],
  );

  const handleReset = useCallback(() => {
    setLanguage("system");
    setDensity(DEFAULT_MAIL_DENSITY);
    setTheme("system");
    setComposeFormat("html");
    updatePrefs.mutate(
      {
        density: DEFAULT_MAIL_DENSITY,
        theme: "system",
        language: "system",
        compose_format: "html",
        animation_mode: null,
        deep_index: false,
      },
      { onError: (e) => toast.error(t("Failed to reset: {message}", { message: e.message })) },
    );
  }, [setDensity, setTheme, setComposeFormat, updatePrefs, setLanguage, t]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {t("Loading display settings...")} </div>
    );
  }

  if (!prefs) return null;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">{t("Display")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground"> {t("Customize the appearance and layout of the app.")} </p>
      </div>

      <div className="space-y-3">
        <SegmentedControl
          label={t("Density")}
          description={t("Controls the spacing of the message list")}
          value={prefs.density}
          options={[
            { value: "compact", label: t("Compact") },
            { value: "standard", label: t("Standard") },
            { value: "comfortable", label: t("Comfortable") },
          ]}
          onChange={handleDensityChange}
        />

        <SegmentedControl
          label={t("Theme")}
          description={t("Choose light, dark, or match your system")}
          value={prefs.theme}
          options={[
            { value: "light", label: t("Light"), icon: <Sun className="size-3.5" /> },
            { value: "dark", label: t("Dark"), icon: <Moon className="size-3.5" /> },
            { value: "system", label: t("System"), icon: <Monitor className="size-3.5" /> },
          ]}
          onChange={handleThemeChange}
        />

        <SegmentedControl
          label={t("Compose format")}
          description={t("Default format for new emails")}
          value={prefs.compose_format}
          options={[
            { value: "html", label: t("HTML"), icon: <Code2 className="size-3.5" /> },
            { value: "text", label: t("Plain text"), icon: <FileText className="size-3.5" /> },
          ]}
          onChange={handleComposeFormatChange}
        />

        <SegmentedControl
          label={t("Animations")}
          description={t("Choose how much motion to use in the interface")}
          value={prefs.animation_mode ?? "subtle"}
          options={[
            { value: "rich", label: t("Rich") },
            { value: "medium", label: t("Medium") },
            { value: "subtle", label: t("Subtle") },
            { value: "off", label: t("Off") },
          ]}
          onChange={handleAnimationModeChange}
        />

        <SegmentedControl
          label={t("Search indexing")}
          description={t("Index message bodies for full-text search (uses more bandwidth)")}
          value={prefs.deep_index ? "on" : "off"}
          options={[
            { value: "off", label: t("Headers only"), icon: <Search className="size-3.5" /> },
            { value: "on", label: t("Full text"), icon: <Search className="size-3.5" /> },
          ]}
          onChange={(v) =>
            updatePrefs.mutate(
              { deep_index: v === "on" },
              { onError: (e) => toast.error(t("Failed to update: {message}", { message: e.message })) },
            )
          }
        />

        <SegmentedControl
          label={t("Language")}
          description={t("Interface language")}
          value={languagePreference}
          options={[
            { value: "system", label: t("Follow browser language") },
            { value: "en", label: "English" },
            { value: "fr", label: "Français" },
          ]}
          onChange={(language: LanguagePreference) => {
            setLanguage(language);
            updatePrefs.mutate(
              { language },
              { onError: () => toast.error(t("Language changed on this device, but could not be saved to your account.")) },
            );
          }}
        />
      </div>

      <button
        type="button"
        onClick={handleReset}
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      > {t("Reset to defaults")} </button>
    </div>
  );
}
