"use client";

import { useQueries } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";

interface AccountUnreadResponse {
  inbox_unread_count: number;
}

export interface AccountUnreadCount {
  count: number | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function useAccountUnreadCounts(): Record<string, AccountUnreadCount> {
  const accounts = useAuthStore((state) => state.accounts);
  const queries = useQueries({
    queries: accounts.map(({ id }) => ({
      queryKey: ["account-unread", id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiGet<AccountUnreadResponse>("/account/unread", {
          accountId: id,
          signal,
          // Background failures must not switch the selected mailbox.
          handleSessionExpiry: false,
        }),
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    })),
  });

  return Object.fromEntries(accounts.map(({ id }, index) => {
    const query = queries[index];
    return [id, {
      count: query.isError ? undefined : query.data?.inbox_unread_count,
      isLoading: query.isPending,
      isError: query.isError,
    }];
  }));
}
