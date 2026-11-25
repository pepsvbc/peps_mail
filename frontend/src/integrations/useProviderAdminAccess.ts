"use client";
import { useProviderAccount, useProviderCapabilities } from "./franklymail/hooks";

/**
 * Shared gate for optional provider administration entry points. FranklyMail
 * administrators are configured separately (FRANKLYMAIL_ADMIN_EMAILS); the
 * distribution-list admin flag (`isAdmin`) does not grant access.
 */
export function useProviderAdminAccess() {
  const capabilities = useProviderCapabilities();
  const account = useProviderAccount();
  return capabilities.data?.franklymail === true && account.data?.admin === true;
}
