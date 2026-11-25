"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export function useLoginOptions() {
  return useQuery({
    queryKey: ["login-options"],
    queryFn: () => apiGet<{ default_domain: string | null }>("/auth/options"),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
