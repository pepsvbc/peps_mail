"use client";
import Link from "next/link";
import { useProviderCapabilities } from "./franklymail/hooks";

export function ProviderRecoveryLink() {
  const capabilities = useProviderCapabilities();
  if (!capabilities.data?.franklymail_recovery) return null;
  return <Link href="/franklymail-recovery" className="mt-4 block text-center text-sm text-primary underline underline-offset-4">Forgot your password?</Link>;
}
