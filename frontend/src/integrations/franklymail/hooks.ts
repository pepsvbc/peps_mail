"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { translate } from "@/lib/i18n";
import { toast } from "sonner";

export const ROOT = "/integrations/franklymail";
export interface Forwarding { enabled: boolean; address: string; keep_copy: boolean }
export interface Settings {
  forwarding: Forwarding;
  revision: string;
  existing_rules: boolean;
  externally_managed: boolean;
  recovery_email: string | null;
}
export function useProviderCapabilities() {
  return useQuery({
    queryKey: ["integration-capabilities"],
    queryFn: () => apiGet<{ franklymail: boolean; franklymail_recovery: boolean }>("/integrations/capabilities"),
    staleTime: 5 * 60_000, retry: false,
  });
}
export function useProviderAccount() {
  const account = useAuthStore((s) => s.activeAccountId);
  const capabilities = useProviderCapabilities();
  return useQuery({
    queryKey: ["franklymail", account, "account"],
    queryFn: () => apiGet<{ change_password: boolean }>(`${ROOT}/account`, { accountId: account! }),
    enabled: !!account && capabilities.data?.franklymail === true,
    retry: false,
  });
}
export function useMailboxes() {
  const account = useAuthStore((s) => s.activeAccountId);
  return useQuery({
    queryKey: ["franklymail", account, "mailboxes"],
    queryFn: () => apiGet<{ mailboxes: { id: string; address: string }[]; domains: string[]; recovery_enabled: boolean }>(`${ROOT}/mailboxes`, { accountId: account! }),
    retry: false, refetchOnWindowFocus: false,
  });
}
export function useMailboxSettings(email: string) {
  const account = useAuthStore((s) => s.activeAccountId);
  return useQuery({
    queryKey: ["franklymail", account, email],
    queryFn: () => apiGet<Settings>(`${ROOT}/settings?email=${encodeURIComponent(email)}`, { accountId: account! }),
    enabled: !!email, retry: false, refetchOnWindowFocus: false,
  });
}
export function useFranklyMutation(path: string, method: "POST" | "PUT" = "POST") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => method === "PUT" ? apiPut(`${ROOT}${path}`, body) : apiPost(`${ROOT}${path}`, body),
    // Refetching may remount the mailbox editor; keep the outcome visible.
    onSuccess: () => toast.success(translate(path === "/forwarding" ? "Forwarding saved on FranklyMail" : path === "/mailboxes" ? "Mailbox created and welcome email sent" : "Password link sent")),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["franklymail"] }),
  });
}

export function useDeleteMailbox() {
  const account = useAuthStore((s) => s.activeAccountId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; mailbox_id: string; confirmation: string }) =>
      apiPost(`${ROOT}/mailboxes/delete`, body, { accountId: account! }),
    onSuccess: (_data, body) => {
      const host = useAuthStore.getState().accounts.find((a) => a.id === account)?.imapHost;
      for (const saved of useAuthStore.getState().accounts) {
        if (saved.email.toLowerCase() === body.email.toLowerCase() && saved.imapHost.toLowerCase() === host?.toLowerCase()) {
          useAuthStore.getState().removeAccount(saved.id);
          queryClient.removeQueries({ queryKey: ["account-unread", saved.id], exact: true });
        }
      }
      toast.success(translate("User deleted. FranklyMail has kept the mailbox’s mail."));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["franklymail"] }),
  });
}
