"use client";

import { useTranslation } from "@/lib/i18n";

import { ArrowRight, Mails } from "lucide-react";
import { useUiStore } from "@/stores/useUiStore";
import { ProviderSettings } from "@/integrations/ProviderSettings";
import { PasswordSettingsLink } from "@/integrations/franklymail/PasswordSettings";
import { DisplaySettings } from "./DisplaySettings";
import { IdentitySettings } from "./IdentitySettings";
import { NotificationSettings } from "./NotificationSettings";

/** Distribution lists have their own page; Settings only points to it. */
function DistributionListsLink() {
  const { t } = useTranslation();
  const setViewMode = useUiStore((s) => s.setViewMode);
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">{t("Distribution lists")}</h2>
      <button
        type="button"
        onClick={() => setViewMode("lists")}
        className="flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent"
      >
        <Mails className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("Open distribution lists")}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t("Create and manage personal and shared lists. Also available from the left bar.")}
          </span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

const SECTIONS = [
  { id: "settings-display", label: "Display", Component: DisplaySettings },
  { id: "settings-notifications", label: "Notifications", Component: NotificationSettings },
  { id: "settings-identities", label: "Sender Identities", Component: IdentitySettings },
  { id: "settings-lists", label: "Distribution lists", Component: DistributionListsLink },
] as const;

export function SettingsPanel() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="text-lg font-semibold">{t("Settings")}</h1>
          <nav aria-label={t("Settings sections")} className="mt-3 flex flex-wrap gap-1.5">
            {SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t(label)}
              </button>
            ))}
            <PasswordSettingsLink />
          </nav>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl divide-y divide-border">
          {SECTIONS.map(({ id, Component }) => (
            <section key={id} id={id} className="scroll-mt-4 py-8">
              <Component />
            </section>
          ))}
          <ProviderSettings />
        </div>
      </div>
    </div>
  );
}
