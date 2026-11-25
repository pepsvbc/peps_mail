"use client";
import { useAuthStore } from "@/stores/useAuthStore";
import { useTranslation } from "@/lib/i18n";
import { useProviderAccount, useProviderCapabilities } from "./hooks";
import { AdminSettings } from "./AdminSettings";

/** Render inside the mail shell, retaining navigation and account context. */
export function AdminPage() {
  const { t } = useTranslation();
  const account = useAuthStore((s) => s.activeAccountId);
  const capabilities = useProviderCapabilities();
  const access = useProviderAccount();
  // FranklyMail administrators come from the server's own list, not from the
  // distribution-list admin flag.
  const isAdmin = access.data?.admin === true;
  if (isAdmin && capabilities.data?.franklymail) return <AdminSettings key={account} />;
  const pending = capabilities.isPending || (capabilities.data?.franklymail === true && access.isPending);
  return <div className="flex flex-1 flex-col overflow-hidden">
    <div className="border-b border-border px-4 py-4 sm:px-6"><h1 className="mx-auto max-w-3xl text-lg font-semibold">{t("Users")}</h1></div>
    <div className="mx-auto w-full max-w-3xl p-6 text-sm text-muted-foreground" role={pending ? "status" : "alert"}>
      {pending ? t("Loading...")
        : capabilities.isError || access.isError ? t("Could not load user management. Try refreshing the page.")
        : !capabilities.data?.franklymail ? t("FranklyMail administration is not enabled.")
        : t("Administrator access is required.")}
    </div>
  </div>;
}
