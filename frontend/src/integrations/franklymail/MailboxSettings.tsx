"use client";

import { useTranslation } from "@/lib/i18n";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMailboxSettings, useFranklyMutation, type Settings } from "./hooks";

function ErrorMessage({ error }: { error: Error | null }) {
  return error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null;
}
function MailboxEditor({ email, settings, recoveryEnabled }: { email: string; settings: Settings; recoveryEnabled: boolean }) {
  const { t } = useTranslation();
  const [forward, setForward] = useState(settings.forwarding);
  const [personal, setPersonal] = useState(settings.recovery_email ?? "");
  const forwarding = useFranklyMutation("/forwarding", "PUT");
  const recovery = useFranklyMutation("/recovery");
  function saveForward(e: FormEvent) {
    e.preventDefault();
    forwarding.mutate({ email, revision: settings.revision, forwarding: forward });
  }
  return <div className="space-y-8">
    {recoveryEnabled && <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); recovery.mutate({ email, personal_email: personal }); }}>
      <h3 className="font-medium">{t("Password recovery")}</h3>
      <p className="text-sm text-muted-foreground">{t("Check that this personal address belongs to the mailbox owner. Anyone with access to it can reset this mailbox’s password.")}</p>
      <Label htmlFor="frankly-personal">{t("Personal email")}</Label>
      <Input id="frankly-personal" type="email" required value={personal} disabled={recovery.isPending} onChange={(e) => setPersonal(e.target.value)} />
      <Button className="h-auto min-h-9 max-w-full whitespace-normal" disabled={recovery.isPending}>{recovery.isPending ? t("Sending…") : t("Save address and send password link")}</Button>
      <ErrorMessage error={recovery.error} />
      {recovery.isSuccess && <p role="status" className="text-sm">{t("Password link sent. It expires in 15 minutes.")}</p>}
    </form>}
    <form className="space-y-3" onSubmit={saveForward}>
      <h3 className="font-medium">{t("Automatic forwarding")}</h3>
      <p className="text-sm text-muted-foreground">{t("FranklyMail forwards future incoming messages, even when this app is offline.")}</p>
      {settings.existing_rules && <p className="text-sm text-amber-700 dark:text-amber-400">{t("Existing server rules run first and may stop forwarding or keep additional copies. Avoid editing rules in another client while saving here.")}</p>}
      {settings.externally_managed && <p role="alert" className="text-sm">{t("Agentic Inbox manages this mailbox’s rules. Edit them in FranklyMail.")}</p>}
      <fieldset disabled={forwarding.isPending || settings.externally_managed} className="space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={forward.enabled} onChange={(e) => setForward({ ...forward, enabled: e.target.checked })} />{t("Enable forwarding")}</label>
        <Label htmlFor="frankly-destination">{t("Forward to")}</Label>
        <Input id="frankly-destination" type="email" required={forward.enabled} disabled={!forward.enabled} value={forward.address} onChange={(e) => setForward({ ...forward, address: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={forward.keep_copy} disabled={!forward.enabled} onChange={(e) => setForward({ ...forward, keep_copy: e.target.checked })} />{t("Keep a copy in this mailbox")}</label>
        <Button>{forwarding.isPending ? t("Saving…") : t("Save forwarding")}</Button>
      </fieldset>
      <ErrorMessage error={forwarding.error} />
      {forwarding.isSuccess && <p role="status" className="text-sm">{t("Forwarding settings saved on FranklyMail.")}</p>}
    </form>
  </div>;
}
export function SelectedMailbox({ email, recoveryEnabled }: { email: string; recoveryEnabled: boolean }) {
  const { t } = useTranslation();
  const settings = useMailboxSettings(email);
  return <div className="space-y-4">
    <ErrorMessage error={settings.error} />
    <Button variant="outline" onClick={() => settings.refetch()} disabled={settings.isFetching}>{t("Refresh mailbox settings")}</Button>
    {settings.isPending && <p role="status">{t("Loading settings…")}</p>}
    {settings.data && <MailboxEditor key={`${email}:${settings.data.revision}:${settings.data.recovery_email}`} email={email} settings={settings.data} recoveryEnabled={recoveryEnabled} />}
  </div>;
}
