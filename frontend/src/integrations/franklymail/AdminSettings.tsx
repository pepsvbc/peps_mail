"use client";

import { useState, type ReactNode, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { ChevronRight, Loader2, Plus, RefreshCw, Search, Trash2, UserRound, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectField } from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n";
import { useMailboxes, useFranklyMutation, useDeleteMailbox, type Mailbox } from "./hooks";
import { useAuthStore } from "@/stores/useAuthStore";
import { SelectedMailbox } from "./MailboxSettings";

function UserDialog({ title, description, onClose, busy = false, children }: {
  title: string; description: string; onClose: () => void; busy?: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Description className="mt-1 break-words text-sm text-muted-foreground">{description}</Dialog.Description>
          </div>
          <Dialog.Close disabled={busy} aria-label={t("Close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"><X className="size-4" aria-hidden /></Dialog.Close>
        </div>
        <div className="overflow-y-auto p-6">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function AddUserDialog({ domains, addresses, onClose }: { domains: string[]; addresses: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const create = useFranklyMutation("/mailboxes");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [personal, setPersonal] = useState("");
  const localPart = name.trim().toLowerCase();
  const email = `${localPart}@${domain}`;
  const validName = localPart.length > 0 && localPart.length <= 64 && email.length <= 254
    && /^[a-z0-9!#%&'*+/=?^_`|~-]+(?:\.[a-z0-9!#%&'*+/=?^_`|~-]+)*$/i.test(localPart);
  const taken = addresses.some((address) => address.trim().toLowerCase() === email.toLowerCase());
  const nameError = taken ? t("This address is already taken. Choose another name.")
    : localPart && !validName ? t("Enter a valid mailbox name before @, without spaces.") : "";
  const canCreate = validName && domains.includes(domain) && !taken && !create.isPending;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    create.mutate({ email, personal_email: personal.trim() }, { onSuccess: onClose });
  }
  return <UserDialog title={t("Add user")} description={t("Create a mailbox and invite its owner to choose a password.")} onClose={onClose} busy={create.isPending}>
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="frankly-new-email">{t("Mailbox address")}</Label>
        <div className="flex min-w-0 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <Input id="frankly-new-email" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={64} placeholder={t("name")} value={name} disabled={create.isPending} onChange={(e) => { setName(e.target.value); create.reset(); }} aria-invalid={!!nameError} aria-describedby={`frankly-new-domain frankly-new-name-hint${nameError ? " frankly-new-name-error" : ""}`} className="flex-1 rounded-r-none border-0 shadow-none focus-visible:ring-0" />
          <span id="frankly-new-domain" className="max-w-[65%] break-all border-l border-input bg-muted/50 px-3 py-2 text-sm text-muted-foreground">@{domain}</span>
        </div>
        {domains.length > 1 && <div className="flex items-center gap-3">
          <Label htmlFor="frankly-new-domain-choice">{t("Domain")}</Label>
          <SelectField id="frankly-new-domain-choice" value={domain} disabled={create.isPending} onValueChange={(value) => { setDomain(value); create.reset(); }} options={domains.map((value) => ({ value, label: value }))} />
        </div>}
        <p id="frankly-new-name-hint" className="text-xs text-muted-foreground">{t("Enter only the name before @. The domain is set by your server.")}</p>
        {nameError && <p id="frankly-new-name-error" role="alert" className="text-sm text-destructive">{nameError}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="frankly-new-personal">{t("Personal email")}</Label>
        <Input id="frankly-new-personal" type="email" autoComplete="off" required value={personal} disabled={create.isPending} onChange={(e) => setPersonal(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t("The welcome email and future password links go to this address. Make sure it belongs to the user.")}</p>
      </div>
      <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">{t("The user chooses their own password through a link valid for 15 minutes.")}</p>
      {create.error && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}
      <div className="flex flex-col-reverse justify-end gap-2 border-t border-border pt-4 sm:flex-row">
        <Button className="w-full sm:w-auto" type="button" variant="outline" onClick={onClose} disabled={create.isPending}>{t("Cancel")}</Button>
        <Button className="h-auto min-h-9 w-full whitespace-normal sm:w-auto" disabled={!canCreate}>{create.isPending ? <><Loader2 className="size-4 animate-spin" aria-hidden />{t("Creating...")}</> : <><Plus className="size-4" aria-hidden />{t("Create user and send invitation")}</>}</Button>
      </div>
    </form>
  </UserDialog>;
}

function ManageUserDialog({ user, recoveryEnabled, onClose }: { user: Mailbox; recoveryEnabled: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const activeEmail = useAuthStore((s) => s.accounts.find((a) => a.id === s.activeAccountId)?.email);
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const remove = useDeleteMailbox();
  const isSelf = activeEmail?.toLowerCase() === user.address.toLowerCase();
  const locked = user.protected === true;
  const confirmed = confirmation.trim().toLowerCase() === user.address.toLowerCase();
  return <UserDialog title={t(deleting ? "Delete user" : "Manage user")} description={user.address} onClose={onClose} busy={remove.isPending}>
    {deleting ? <form className="space-y-4" onSubmit={(e) => {
      e.preventDefault();
      if (confirmed && !isSelf && !locked && !remove.isPending) remove.mutate({ email: user.address, mailbox_id: user.id, confirmation }, { onSuccess: onClose });
    }}>
      <p className="text-sm text-muted-foreground">{t("This takes the address out of service and signs the user out. FranklyMail keeps the existing mail. Recovery links and the personal recovery address are removed from this app.")}</p>
      <Label htmlFor="delete-user-confirmation">{t("Type {email} to confirm", { email: user.address })}</Label>
      <Input id="delete-user-confirmation" type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required value={confirmation} disabled={remove.isPending} onChange={(e) => setConfirmation(e.target.value)} />
      {remove.error && <p role="alert" className="text-sm text-destructive">{remove.error.message} {t("Refresh users before retrying. Their recovery settings may need to be set up again.")}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" disabled={remove.isPending} onClick={() => { setDeleting(false); setConfirmation(""); remove.reset(); }}>{t("Cancel")}</Button>
        <Button variant="destructive" disabled={!confirmed || isSelf || locked || remove.isPending}><Trash2 className="size-4" aria-hidden />{t(remove.isPending ? "Deleting…" : "Delete user")}</Button>
      </div>
    </form> : <div className="space-y-6">
      <SelectedMailbox email={user.address} recoveryEnabled={recoveryEnabled} />
      <div className="space-y-2 border-t border-border pt-5">
        <Button variant="destructive" disabled={isSelf || locked} onClick={() => setDeleting(true)}><Trash2 className="size-4" aria-hidden />{t("Delete user")}</Button>
        {isSelf && <p className="text-sm text-muted-foreground">{t("You cannot delete the account you are currently using")}</p>}
        {locked && !isSelf && <p className="text-sm text-muted-foreground">{t("Only its owner can change another administrator's mailbox.")}</p>}
      </div>
    </div>}
  </UserDialog>;
}

export function AdminSettings() {
  const { t } = useTranslation();
  const mailboxes = useMailboxes();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Mailbox | null>(null);
  const users = [...(mailboxes.data?.mailboxes ?? [])].sort((a, b) => a.address.localeCompare(b.address));
  const filtered = users.filter((user) => user.address.toLowerCase().includes(query.trim().toLowerCase()));
  const recoveryEnabled = mailboxes.data?.recovery_enabled === true;
  return <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
    <div className="border-b border-border px-4 py-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{t("Users")}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("Manage mailboxes, password recovery and forwarding.")}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!recoveryEnabled || !mailboxes.data?.domains.length || mailboxes.isError} onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t("Add user")}</Button>
      </div>
    </div>
    <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        {mailboxes.isPending ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />{t("Loading users...")}</p> : <>
          <div className="flex gap-2">
            <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input aria-label={t("Search users")} placeholder={t("Search users")} className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
            <Button variant="outline" size="icon" aria-label={t("Refresh users")} disabled={mailboxes.isFetching} onClick={() => mailboxes.refetch()}><RefreshCw className={`size-4 ${mailboxes.isFetching ? "animate-spin" : ""}`} aria-hidden /></Button>
          </div>
          {mailboxes.error && <p role="alert" className="text-sm text-destructive">{mailboxes.error.message}</p>}
          {mailboxes.data && <>
            {!recoveryEnabled && <p role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">{t("Welcome emails are not configured yet. User creation and password invitations will be available once email delivery is set up.")}</p>}
            <section aria-label={t("User mailboxes")} className="space-y-2">
              <h2 className="text-sm font-medium">{t(users.length === 1 ? "{count} user" : "{count} users", { count: users.length })}</h2>
              {filtered.length ? <ul className="space-y-2">{filtered.map((user) => <li key={user.id} className="overflow-hidden rounded-lg border border-border">
                <button type="button" aria-label={t("Manage {email}", { email: user.address })} onClick={() => setSelected(user)} className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-accent/50">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><UserRound className="size-4" aria-hidden /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{user.address}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t("Password recovery and forwarding")}</span></span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>)}</ul> : <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
                <Users className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium">{t(query.trim() ? "No users match your search." : "No users yet.")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t(query.trim() ? "Try another mailbox address." : "Add your first user to send them a welcome invitation.")}</p>
              </div>}
            </section>
          </>}
        </>}
      </div>
    </div>
    {adding && mailboxes.data && <AddUserDialog domains={mailboxes.data.domains} addresses={users.map((user) => user.address)} onClose={() => setAdding(false)} />}
    {selected && <ManageUserDialog key={selected.id} user={selected} recoveryEnabled={recoveryEnabled} onClose={() => setSelected(null)} />}
  </div>;
}
