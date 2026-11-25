"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { useAuthStore } from "@/stores/useAuthStore";
import { ROOT, useProviderAccount } from "./hooks";

export function PasswordSettings() {
  const { t } = useTranslation();
  const access = useProviderAccount();
  const account = useAuthStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const queryClient = useQueryClient();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const change = useMutation({
    gcTime: 0,
    mutationFn: () => apiPost(`${ROOT}/password`, { current_password: current, new_password: password }, { accountId: account!.id }),
    onSuccess: async () => {
      setCurrent(""); setPassword(""); setConfirm("");
      toast.success(t("Password changed. Sign in again with your new password; activation may take a moment."), { duration: 10_000 });
      await queryClient.cancelQueries();
      for (const saved of useAuthStore.getState().accounts) {
        if (saved.email.toLowerCase() === account!.email.toLowerCase() && saved.imapHost.toLowerCase() === account!.imapHost.toLowerCase()) {
          useAuthStore.getState().removeAccount(saved.id);
          queryClient.removeQueries({ queryKey: ["account-unread", saved.id], exact: true });
        }
      }
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "account-unread" });
      if (useAuthStore.getState().accounts.length === 0) router.replace("/");
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault(); setError("");
    if (password !== confirm) { setError(t("The passwords do not match.")); return; }
    if (password === current) { setError(t("Choose a different new password")); return; }
    change.mutate();
  }
  if (!account || !access.data?.change_password) return null;
  return <section id="settings-password" className="scroll-mt-4 space-y-3 py-8">
    <h2 className="flex items-center gap-2 text-base font-semibold"><KeyRound className="size-4" aria-hidden />{t("Change password")}</h2>
    <p className="break-all text-sm text-muted-foreground">{account.email}</p>
    <p className="text-sm text-muted-foreground">{t("After changing your password, sign in again on all devices and update it in your other mail apps.")}</p>
    <form onSubmit={submit} className="max-w-md space-y-4">
      <input type="hidden" autoComplete="username" value={account.email} />
      <div className="space-y-2"><Label htmlFor="settings-current-password">{t("Current password")}</Label>
        <Input id="settings-current-password" type="password" autoComplete="current-password" required maxLength={4096} value={current} disabled={change.isPending} onChange={(e) => setCurrent(e.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="settings-new-password">{t("New password")}</Label>
        <Input id="settings-new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} disabled={change.isPending} onChange={(e) => setPassword(e.target.value)} aria-describedby="settings-password-hint" />
        <p id="settings-password-hint" className="text-xs text-muted-foreground">{t("Use at least 12 characters.")}</p></div>
      <div className="space-y-2"><Label htmlFor="settings-confirm-password">{t("Confirm password")}</Label>
        <Input id="settings-confirm-password" type="password" autoComplete="new-password" required maxLength={256} value={confirm} disabled={change.isPending} onChange={(e) => setConfirm(e.target.value)} /></div>
      {(error || change.error) && <p role="alert" className="text-sm text-destructive">{error || change.error?.message}</p>}
      <Button disabled={change.isPending}>{t(change.isPending ? "Saving…" : "Change password")}</Button>
    </form>
  </section>;
}

export function PasswordSettingsLink() {
  const { t } = useTranslation();
  const access = useProviderAccount();
  if (!access.data?.change_password) return null;
  return <button type="button" onClick={() => document.getElementById("settings-password")?.scrollIntoView({ behavior: "smooth", block: "start" })} className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">{t("Change password")}</button>;
}
