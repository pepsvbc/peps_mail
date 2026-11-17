"use client";

import { useTranslation } from "@/lib/i18n";

import { useId, useMemo, useState } from "react";
import { Dialog } from "radix-ui";
import { AnimatePresence } from "framer-motion";
import { ClipboardPaste, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAutocomplete } from "@/hooks/useAutocomplete";
import { useCreateList, useIsAdmin, useListUsers, useUpdateList } from "@/hooks/useLists";
import { isValidEmail, parseMailboxList } from "@/lib/recipients";
import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";
import { createFadeSlideVariants, createScaleFadeVariants } from "@/lib/motion/variants";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/useUiStore";
import type { DistributionList, ListAccess, ListDisplayMode, ListKind, ListMember } from "@/types/list";

const MAX_MEMBERS = 500;

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
        checked ? "bg-primary" : "bg-muted",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

function SuggestionList<T>({
  items,
  activeIndex,
  onHover,
  onPick,
  render,
  label,
}: {
  items: T[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (item: T) => void;
  render: (item: T) => React.ReactNode;
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <div role="listbox" aria-label={label} className="absolute left-0 top-full z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={cn(
            "flex w-full flex-col px-3 py-2 text-left text-sm",
            i === activeIndex ? "bg-accent text-accent-foreground" : "text-popover-foreground hover:bg-accent/50",
          )}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus in the input
            onPick(item);
          }}
        >
          {render(item)}
        </button>
      ))}
    </div>
  );
}

function MembersEditor({
  members,
  onChange,
  readOnly,
  inputId,
  input,
  onInputChange,
}: {
  members: ListMember[];
  onChange: (members: ListMember[]) => void;
  readOnly: boolean;
  inputId: string;
  input: string;
  onInputChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const query = input.trim();
  const { results } = useAutocomplete(readOnly ? "" : query);
  const memberKeys = useMemo(() => new Set(members.map((m) => m.email.toLowerCase())), [members]);
  const suggestions = focused && query.length >= 2
    ? results.map((r) => r.item).filter((item) => !memberKeys.has(item.email.toLowerCase())).slice(0, 8)
    : [];

  /** Add every address in `text`; returns the invalid entries left over. */
  const addMany = (text: string): string[] => {
    const { valid, invalid } = parseMailboxList(text);
    const seen = new Set(memberKeys);
    const next = [...members];
    let duplicates = 0;
    for (const mailbox of valid) {
      const key = mailbox.email.toLowerCase();
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      next.push({ email: mailbox.email, name: mailbox.name });
    }
    if (next.length !== members.length) onChange(next);
    setError(invalid.length
      ? t(invalid.length === 1 ? "Not a valid email address: {addresses}" : "Not valid email addresses: {addresses}", { addresses: invalid.join(", ") })
      : null);
    setNotice(duplicates
      ? t(duplicates === 1 ? "{count} address was already in the list" : "{count} addresses were already in the list", { count: duplicates })
      : null);
    return invalid;
  };

  const commitInput = () => {
    if (!query) return;
    onInputChange(addMany(input).join(", "));
  };

  const pick = (item: { email: string; name?: string }) => {
    addMany(item.name ? `"${item.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${item.email}>` : item.email);
    onInputChange("");
    setActiveIndex(0);
  };

  const remove = (email: string) => {
    onChange(members.filter((m) => m.email.toLowerCase() !== email.toLowerCase()));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          {t("Members")}
        </label>
        <span className="text-xs text-muted-foreground" data-testid="list-member-count">
          {t(members.length === 1 ? "{count} member" : "{count} members", { count: members.length })}
        </span>
      </div>

      {!readOnly && (
        <>
          <div className="relative">
            <Input
              id={inputId}
              value={input}
              autoComplete="off"
              placeholder={t("Add a name or email address")}
              aria-invalid={error ? true : undefined}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => {
                onInputChange(e.target.value);
                setActiveIndex(0);
                setError(null);
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text");
                if (!/[,;\n]/.test(text)) return;
                e.preventDefault();
                onInputChange(addMany(`${input}${input.trim() ? "," : ""}${text}`).join(", "));
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(0, Math.min(i + (e.key === "ArrowDown" ? 1 : -1), suggestions.length - 1)));
                } else if (e.key === "Enter" || e.key === "," || e.key === ";") {
                  e.preventDefault();
                  if (e.key === "Enter" && suggestions.length && !isValidEmail(query)) pick(suggestions[Math.min(activeIndex, suggestions.length - 1)]);
                  else commitInput();
                }
              }}
            />
            <SuggestionList
              items={suggestions}
              activeIndex={activeIndex}
              onHover={setActiveIndex}
              onPick={pick}
              label={t("Suggested addresses")}
              render={(item) => (
                <>
                  <span className="font-medium">{item.name || item.email}</span>
                  {item.name && <span className="text-xs text-muted-foreground">{item.email}</span>}
                </>
              )}
            />
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

          <button
            type="button"
            onClick={() => setShowPaste((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={showPaste}
          >
            <ClipboardPaste className="size-3.5" />
            {t("Paste addresses")}
          </button>
          {showPaste && (
            <div className="space-y-2">
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={4}
                aria-label={t("Addresses to add")}
                placeholder={t("One address per line, or separated by commas or semicolons. “Name <email>” works too.")}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!pasteText.trim()}
                onClick={() => {
                  const invalid = addMany(pasteText);
                  setPasteText(invalid.join("\n"));
                  if (!invalid.length) setShowPaste(false);
                }}
              >
                {t("Add addresses")}
              </Button>
            </div>
          )}
        </>
      )}

      {members.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("No members yet.")}
        </p>
      ) : (
        <ul aria-label={t("List members")} className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {members.map((member) => (
            <li key={member.email.toLowerCase()} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate">
                {member.name ? (
                  <>{member.name} <span className="text-muted-foreground">&lt;{member.email}&gt;</span></>
                ) : member.email}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => remove(member.email)}
                  aria-label={t("Remove {email}", { email: member.email })}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccessEditor({
  access,
  onChange,
  inputId,
}: {
  access: ListAccess[];
  onChange: (access: ListAccess[]) => void;
  inputId: string;
}) {
  const { t } = useTranslation();
  const { data: users } = useListUsers();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const query = input.trim().toLowerCase();
  const granted = new Set(access.map((a) => a.email.toLowerCase()));
  const suggestions = focused
    ? (users ?? []).filter((u) => !granted.has(u.email.toLowerCase()) && u.email.toLowerCase().includes(query)).slice(0, 8)
    : [];

  const add = (email: string) => {
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setError(t("Not a valid email address: {addresses}", { addresses: trimmed }));
      return;
    }
    if (!granted.has(trimmed.toLowerCase())) onChange([...access, { email: trimmed, can_edit: false }]);
    setInput("");
    setError(null);
    setActiveIndex(0);
  };

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          {t("Who can use this list")}
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("People with access can use the list when writing. Turn on “Can edit” to also let them change it.")}
        </p>
      </div>
      <div className="relative">
        <Input
          id={inputId}
          value={input}
          autoComplete="off"
          placeholder={t("Search people or type an email address")}
          aria-invalid={error ? true : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setInput(e.target.value);
            setActiveIndex(0);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActiveIndex((i) => Math.max(0, Math.min(i + (e.key === "ArrowDown" ? 1 : -1), suggestions.length - 1)));
            } else if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              if (suggestions.length && !isValidEmail(input.trim())) add(suggestions[Math.min(activeIndex, suggestions.length - 1)].email);
              else if (input.trim()) add(input);
            }
          }}
        />
        <SuggestionList
          items={suggestions}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={(user) => add(user.email)}
          label={t("People on this server")}
          render={(user) => <span>{user.email}</span>}
        />
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {access.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t("Only you can see this list until you give someone access.")}
        </p>
      ) : (
        <ul aria-label={t("People with access")} className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {access.map((entry) => (
            <li key={entry.email.toLowerCase()} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate">{entry.email}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("Can edit")}</span>
                <Switch
                  checked={entry.can_edit}
                  label={t("{email} can edit", { email: entry.email })}
                  onChange={(canEdit) => onChange(access.map((a) => (a.email === entry.email ? { ...a, can_edit: canEdit } : a)))}
                />
                <button
                  type="button"
                  onClick={() => onChange(access.filter((a) => a.email !== entry.email))}
                  aria-label={t("Remove access for {email}", { email: entry.email })}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ListForm({ list, onClose }: { list: DistributionList | null; onClose: () => void }) {
  const { t } = useTranslation();
  const isAdmin = useIsAdmin();
  const createList = useCreateList();
  const updateList = useUpdateList();
  const ids = useId();
  const [name, setName] = useState(list?.name ?? "");
  const [kind, setKind] = useState<ListKind>(list?.kind ?? "personal");
  const [displayMode, setDisplayMode] = useState<ListDisplayMode>(list?.display_mode ?? "list");
  const [members, setMembers] = useState<ListMember[]>(list?.members ?? []);
  const [memberInput, setMemberInput] = useState("");
  const [access, setAccess] = useState<ListAccess[]>(list?.access ?? []);
  const [formError, setFormError] = useState<string | null>(null);

  const readOnly = !!list && !list.can_edit;
  const showType = !list && isAdmin;
  // Admins manage who sees a shared list; others never see (or send) access.
  const showAccess = isAdmin && kind === "shared" && (!list || (list.can_manage && list.access !== null));
  const saving = createList.isPending || updateList.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError(t("List name is required"));
      return;
    }
    // Include an address still being typed.
    let finalMembers = members;
    if (memberInput.trim()) {
      const { valid, invalid } = parseMailboxList(memberInput);
      if (invalid.length) {
        setFormError(t(invalid.length === 1 ? "Not a valid email address: {addresses}" : "Not valid email addresses: {addresses}", { addresses: invalid.join(", ") }));
        return;
      }
      const seen = new Set(members.map((m) => m.email.toLowerCase()));
      finalMembers = [...members];
      for (const mailbox of valid) {
        if (seen.has(mailbox.email.toLowerCase())) continue;
        seen.add(mailbox.email.toLowerCase());
        finalMembers.push(mailbox);
      }
      setMembers(finalMembers);
      setMemberInput("");
    }
    if (finalMembers.length > MAX_MEMBERS) {
      setFormError(t("A list can have at most 500 members"));
      return;
    }
    setFormError(null);
    const callbacks = {
      onSuccess: () => {
        toast.success(t(list ? "List saved" : "List created"));
        onClose();
      },
      onError: (error: Error) => setFormError(error.message),
    };
    if (list) {
      updateList.mutate({
        id: list.id,
        data: {
          name: trimmedName,
          display_mode: displayMode,
          members: finalMembers,
          ...(showAccess ? { access } : {}),
        },
      }, callbacks);
    } else {
      createList.mutate({
        name: trimmedName,
        kind,
        display_mode: displayMode,
        members: finalMembers,
        ...(kind === "shared" && isAdmin ? { access } : {}),
      }, callbacks);
    }
  };

  const title = readOnly ? t("List members") : list ? t("Edit list") : t("New distribution list");
  const displayOptions: { value: ListDisplayMode; label: string; description: string }[] = [
    {
      value: "list",
      label: t("Show as one list"),
      description: t("Adds a single entry like “{name} (12)” to the message. You can still expand it.", { name: name.trim() || t("Team") }),
    },
    {
      value: "expanded",
      label: t("Show every address"),
      description: t("Adds each member as a separate recipient."),
    },
  ];

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <Dialog.Title className="text-base font-semibold text-foreground">{title}</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">
            {readOnly
              ? t("You can use this list but not change it.")
              : t("Recipients always receive the message at their individual addresses.")}
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button type="button" aria-label={t("Close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </Dialog.Close>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
        <div className="space-y-1.5">
          {readOnly ? (
            <>
              <div className="text-xs font-medium text-muted-foreground">{t("Name")}</div>
              <p className="text-sm font-medium">{list?.name}</p>
            </>
          ) : (
            <>
            <label htmlFor={`${ids}-name`} className="text-xs font-medium text-muted-foreground">{t("Name")}</label>
            <Input
              id={`${ids}-name`}
              value={name}
              maxLength={200}
              autoComplete="off"
              placeholder={t("e.g. U13 team")}
              onChange={(e) => {
                setName(e.target.value);
                setFormError(null);
              }}
            />
            </>
          )}
        </div>

        {showType && (
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">{t("Type")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["personal", "shared"] as const).map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer flex-col rounded-lg border p-3 text-sm",
                    kind === value ? "border-primary bg-primary/5" : "border-border hover:bg-accent/50",
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input
                      type="radio"
                      name={`${ids}-kind`}
                      value={value}
                      checked={kind === value}
                      onChange={() => setKind(value)}
                      className="size-4"
                    />
                    {value === "personal" ? t("Personal") : t("Shared")}
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    {value === "personal" ? t("Only you can see it.") : t("Choose who can use or edit it.")}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="space-y-1.5" disabled={readOnly}>
          <legend className="text-xs font-medium text-muted-foreground">{t("When writing a message")}</legend>
          <div className="space-y-2">
            {displayOptions.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex gap-3 rounded-lg border p-3 text-sm",
                  readOnly ? "cursor-default" : "cursor-pointer",
                  displayMode === option.value ? "border-primary bg-primary/5" : "border-border",
                  !readOnly && displayMode !== option.value && "hover:bg-accent/50",
                )}
              >
                <input
                  type="radio"
                  name={`${ids}-display`}
                  value={option.value}
                  checked={displayMode === option.value}
                  onChange={() => setDisplayMode(option.value)}
                  className="mt-0.5 size-4"
                />
                <span>
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <MembersEditor
          members={members}
          onChange={(next) => {
            setMembers(next);
            setFormError(null);
          }}
          readOnly={readOnly}
          inputId={`${ids}-members`}
          input={memberInput}
          onInputChange={setMemberInput}
        />

        {showAccess && <AccessEditor access={access} onChange={setAccess} inputId={`${ids}-access`} />}
      </div>

      <div className="space-y-2 border-t border-border px-6 py-3">
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <div className="flex justify-end gap-2">
          <Dialog.Close asChild>
            <Button type="button" variant="outline" size="sm" disabled={saving}>
              {readOnly ? t("Close") : t("Cancel")}
            </Button>
          </Dialog.Close>
          {!readOnly && (
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {list ? t("Save") : t("Create list")}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Create, edit or (without edit rights) view a distribution list. */
export function DistributionListDialog({
  open,
  list,
  onClose,
}: {
  open: boolean;
  list: DistributionList | null;
  onClose: () => void;
}) {
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const overlayMotionProps = useMemo(() => createFadeSlideVariants(effectiveAnimationMode, "y"), [effectiveAnimationMode]);
  const contentMotionProps = useMemo(() => createScaleFadeVariants(effectiveAnimationMode), [effectiveAnimationMode]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {open ? (
            <Dialog.Overlay asChild forceMount>
              <AnimatedDiv
                key="list-dialog-overlay"
                variants={overlayMotionProps}
                initial="initial"
                animate="animate"
                exit="exit"
                className="fixed inset-0 z-50 bg-black/50"
              />
            </Dialog.Overlay>
          ) : null}
          {open ? (
            <Dialog.Content asChild forceMount>
              <AnimatedDiv
                key="list-dialog-content"
                variants={contentMotionProps}
                initial="initial"
                animate="animate"
                exit="exit"
                className="fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-popover shadow-lg"
              >
                <ListForm key={list?.id ?? "new"} list={list} onClose={onClose} />
              </AnimatedDiv>
            </Dialog.Content>
          ) : null}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
