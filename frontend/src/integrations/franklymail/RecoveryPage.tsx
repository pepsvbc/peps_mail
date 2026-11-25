"use client";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROOT, useProviderCapabilities } from "./hooks";

const subscribe = () => () => {};

export function RecoveryPage() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return hydrated ? <RecoveryForm /> : <p>Loading…</p>;
}

function RecoveryForm() {
  const capabilities = useProviderCapabilities();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [formError, setFormError] = useState("");
  useEffect(() => {
    if (token) {
      // Tokens stay in memory, never in query strings, referrers or browser storage.
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [token]);
  const action = useMutation({
    mutationFn: () => token ? apiPost(`${ROOT}/recovery/reset`, { token, new_password: password }) : apiPost(`${ROOT}/recovery/request`, { email }),
    onSuccess: () => { setPassword(""); setConfirm(""); },
  });
  function submit(e: FormEvent) {
    e.preventDefault(); setFormError("");
    if (token && password !== confirm) { setFormError("The passwords do not match."); return; }
    action.mutate();
  }
  return <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground"><div className="w-full max-w-md space-y-5">
    <h1 className="text-2xl font-semibold">{token ? "Choose your mailbox password" : "Reset your mailbox password"}</h1>
    {capabilities.isPending ? <p>Loading…</p> : !capabilities.data?.franklymail_recovery ? <p>Password recovery is not available. Contact your administrator.</p> : action.isSuccess ? <p role="status">{token ? "Your password update was accepted. Sign in with your new password; provisioning may take a moment." : "If this mailbox has a personal recovery address, a link will be sent there. Check that inbox and its spam folder. The link expires in 15 minutes."}</p> : <form onSubmit={submit} className="space-y-4">
      {token ? <>
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} disabled={action.isPending} onChange={(e) => setPassword(e.target.value)} />
        <p className="text-sm text-muted-foreground">Use at least 12 characters.</p>
        <Label htmlFor="confirm-password">Confirm password</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirm} disabled={action.isPending} onChange={(e) => setConfirm(e.target.value)} />
      </> : <>
        <p className="text-sm text-muted-foreground">Enter your mailbox address. We’ll send a link to the personal email your administrator registered.</p>
        <Label htmlFor="recovery-mailbox">Mailbox address</Label>
        <Input id="recovery-mailbox" type="email" autoComplete="email" required value={email} disabled={action.isPending} onChange={(e) => setEmail(e.target.value)} />
      </>}
      {(formError || action.error) && <p role="alert" className="text-sm text-destructive">{formError || action.error?.message}</p>}
      <Button disabled={action.isPending}>{action.isPending ? "Please wait…" : token ? "Set password" : "Send password link"}</Button>
      {token && action.isError && <a className="block text-sm underline" href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/franklymail-recovery`}>Request a new link</a>}
    </form>}
    <Link href="/" className="block text-sm text-primary underline underline-offset-4">Back to sign in</Link>
  </div></main>;
}
