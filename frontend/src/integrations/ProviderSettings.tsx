"use client";
import { ArrowRight, Users } from "lucide-react";
import { useUiStore } from "@/stores/useUiStore";
import { useTranslation } from "@/lib/i18n";
import { useProviderAdminAccess } from "./useProviderAdminAccess";
import { PasswordSettings } from "./franklymail/PasswordSettings";
import { useAuthStore } from "@/stores/useAuthStore";

export function ProviderSettings() {
  const { t } = useTranslation();
  const canManageUsers = useProviderAdminAccess();
  const account = useAuthStore((s) => s.activeAccountId);
  const setViewMode = useUiStore((s) => s.setViewMode);
  return <><PasswordSettings key={account} />{canManageUsers && <section id="settings-provider" className="scroll-mt-4 space-y-3 py-8">
    <h2 className="text-base font-semibold">{t("Users")}</h2>
    <button type="button" onClick={() => setViewMode("users")} className="flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent">
      <Users className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{t("Manage users")}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{t("Add mailboxes, send password links and manage forwarding. Also available from the left bar.")}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  </section>}</>;
}
