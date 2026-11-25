"use client";
import { useAuthStore, selectActiveIsAdmin } from "@/stores/useAuthStore";
import { useProviderCapabilities } from "./franklymail/hooks";

/** Shared gate for optional provider administration entry points. */
export function useProviderAdminAccess() {
  const isAdmin = useAuthStore(selectActiveIsAdmin);
  const capabilities = useProviderCapabilities();
  return isAdmin && capabilities.data?.franklymail === true;
}
