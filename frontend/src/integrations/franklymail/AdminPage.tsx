"use client";
import { useAuthStore, selectActiveIsAdmin } from "@/stores/useAuthStore";
import { useTranslation } from "@/lib/i18n";
import { useProviderCapabilities } from "./hooks";
import { AdminSettings } from "./AdminSettings";

/** Render inside the mail shell, retaining navigation and account context. */
export function AdminPage() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore(selectActiveIsAdmin);
  const account = useAuthStore((s) => s.activeAccountId);
  const capabilities = useProviderCapabilities();
  if (isAdmin && capabilities.data?.franklymail) return <AdminSettings key={account} />;
  return <div className="flex flex-1 flex-col overflow-hidden">
    <div className="border-b border-border px-4 py-4 sm:px-6"><h1 className="mx-auto max-w-3xl text-lg font-semibold">{t("Users")}</h1></div>
    <div className="mx-auto w-full max-w-3xl p-6 text-sm text-muted-foreground" role={capabilities.isPending && isAdmin ? "status" : "alert"}>
      {!isAdmin ? t("Administrator access is required.") : capabilities.isPending ? t("Loading...") : capabilities.isError ? t("Could not load user management. Try refreshing the page.") : t("FranklyMail administration is not enabled.")}
    </div>
  </div>;
}
