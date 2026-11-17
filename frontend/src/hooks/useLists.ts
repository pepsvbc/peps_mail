"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { selectActiveIsAdmin, useAuthStore } from "@/stores/useAuthStore";
import type {
  CreateListRequest,
  DistributionList,
  ListUser,
  UpdateListRequest,
} from "@/types/list";

/** Whether the active account may create shared lists and manage access. */
export function useIsAdmin(): boolean {
  return useAuthStore(selectActiveIsAdmin);
}

/** All distribution lists visible to the active account, sorted by name. */
export function useLists() {
  return useQuery({
    queryKey: ["lists"],
    queryFn: async () => {
      const res = await apiGet<{ lists: DistributionList[] }>("/lists");
      return res.lists;
    },
    staleTime: 60_000,
  });
}

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateListRequest) =>
      apiPost<DistributionList>("/lists", data as unknown as Record<string, unknown>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lists"] });
    },
  });
}

export function useUpdateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateListRequest }) =>
      apiPut<DistributionList>(`/lists/${encodeURIComponent(id)}`, data as unknown as Record<string, unknown>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lists"] });
    },
  });
}

export function useDeleteList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ status: string }>(`/lists/${encodeURIComponent(id)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lists"] });
    },
  });
}

/** People who have signed in on this server (admins only), for the access picker. */
export function useListUsers() {
  const isAdmin = useIsAdmin();
  return useQuery({
    queryKey: ["lists", "users"],
    queryFn: async () => {
      const res = await apiGet<{ users: ListUser[] }>("/lists/users");
      return res.users;
    },
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  });
}
