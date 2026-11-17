"use client";

import { translate as t, useTranslation } from "@/lib/i18n";

import {
  splitRecipientTokens,
  formatRecipient,
  decodeListRecipient,
  encodeListRecipient,
  expandRecipients,
  isListRecipientToken,
  recipientEmail,
  type ListRecipient,
} from "@/lib/recipients";
import { List, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useAutocomplete, type AutocompleteResult } from "@/hooks/useAutocomplete";
import { useLists } from "@/hooks/useLists";
import type { DistributionList } from "@/types/list";
import { useEffect, useMemo, useRef, useState } from "react";

// Matches the address autocomplete's minimum query length.
const MIN_QUERY_LENGTH = 2;

type Suggestion =
  | { kind: "list"; list: DistributionList }
  | { kind: "address"; result: AutocompleteResult };

/** Lower-cased addresses already in a field, including members of list chips. */
function presentEmails(tokens: string[]): Set<string> {
  return new Set(expandRecipients(tokens.join(", ")).map((token) => recipientEmail(token).toLowerCase()));
}

/** Member tokens not already present in the field. */
function newMemberTokens(members: ListRecipient["members"], existing: string[]): string[] {
  const seen = presentEmails(existing);
  const added: string[] = [];
  for (const member of members) {
    const key = member.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(formatRecipient(member.email, member.name));
  }
  return added;
}

function ListChip({
  list,
  onExpand,
  onRemove,
}: {
  list: ListRecipient;
  onExpand: () => void;
  onRemove: () => void;
}) {
  useTranslation();
  const label = `${list.name} (${list.members.length})`;
  const preview = list.members.slice(0, 15).map((m) => formatRecipient(m.email, m.name)).join("\n")
    + (list.members.length > 15 ? "\n…" : "");
  return (
    <span data-testid="recipient-list-chip" className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs text-foreground">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1 rounded hover:underline"
            aria-label={t("Show members of {name}", { name: label })}
            title={preview}
          >
            <List className="size-3 shrink-0 text-primary" aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={4}
            className="z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg"
          >
            <div className="px-1 pb-1 text-xs font-medium">{list.name}</div>
            <ul aria-label={t("List members")} className="max-h-48 overflow-y-auto text-xs">
              {list.members.map((member) => (
                <li key={member.email} className="truncate px-1 py-0.5" title={member.email}>
                  {member.name ? (
                    <><span>{member.name}</span> <span className="text-muted-foreground">&lt;{member.email}&gt;</span></>
                  ) : member.email}
                </li>
              ))}
            </ul>
            <Popover.Close asChild>
              <button
                type="button"
                onClick={onExpand}
                className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-xs font-medium hover:bg-accent"
              >
                {t("Show all addresses")}
              </button>
            </Popover.Close>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <button
        type="button"
        aria-label={`${t("Remove")} ${list.name}`}
        className="shrink-0 rounded p-0.5 hover:bg-accent"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

interface RecipientInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}

function HighlightedText({ html }: { html: string }) {
  useTranslation();
  const parts = useMemo(() => {
    if (!html) return [];
    const result: Array<{ text: string; highlighted: boolean }> = [];
    const regex = /<mark>(.*?)<\/mark>/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    match = regex.exec(html);
    while (match !== null) {
      if (match.index > lastIndex) {
        result.push({ text: html.slice(lastIndex, match.index), highlighted: false });
      }
      result.push({ text: match[1], highlighted: true });
      lastIndex = match.index + match[0].length;
      match = regex.exec(html);
    }

    if (lastIndex < html.length) {
      result.push({ text: html.slice(lastIndex), highlighted: false });
    }

    return result;
  }, [html]);

  if (parts.length === 0) return null;

  return (
    <>
      {parts.map((part, i) =>
        part.highlighted ? (
          <span key={`${i}-${part.text.slice(0, 10)}`} className="bg-primary/20 font-semibold">
            {part.text}
          </span>
        ) : (
          <span key={`${i}-${part.text.slice(0, 10)}`}>{part.text}</span>
        )
      )}
    </>
  );
}


function isCompleteAddress(value: string) {
  return /^.*<[^@<>\s]+@[^@<>\s]+>$/.test(value) || /^[^@<>\s]+@[^@<>\s]+\.[^@<>\s]+$/.test(value);
}

export function RecipientInput({
  value,
  onChange,
  placeholder,
  inputRef,
}: RecipientInputProps) {
  useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Track the query for which the dropdown was dismissed, so typing a new
  // query naturally re-opens it without setState-in-effect.
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the active token editable until the user confirms it. Prefilled
  // complete addresses are chips immediately, leaving room for another address.
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const parts = splitRecipientTokens(value);
  const last = parts.pop() ?? "";
  // A list chip is never edited as text, so it is always committed.
  const committedLast = isListRecipientToken(last) || (editingValue !== value && isCompleteAddress(last));
  const recipients = [...parts.filter(Boolean), ...(committedLast ? [last] : [])];
  const query = committedLast ? "" : last;
  const { results, isLoading } = useAutocomplete(query);
  const { data: lists } = useLists();
  const listQuery = query.trim().toLowerCase();
  const searching = query.length >= MIN_QUERY_LENGTH && !isCompleteAddress(query);
  const suggestions: Suggestion[] = [];
  if (searching) {
    const chipIds = new Set(recipients.map((r) => decodeListRecipient(r)?.id).filter(Boolean));
    for (const list of lists ?? []) {
      if (list.members.length > 0 && !chipIds.has(list.id) && list.name.toLowerCase().includes(listQuery)) {
        suggestions.push({ kind: "list", list });
      }
    }
    for (const result of results) suggestions.push({ kind: "address", result });
  }
  const showDropdown = suggestions.length > 0 && dismissedQuery !== query;

  const update = (addresses: string[], text: string) => {
    const next = [...addresses, text].join(", ");
    setEditingValue(next);
    onChange(next);
    setSelectedIndex(0);
  };

  const commit = () => {
    if (isCompleteAddress(query)) update([...recipients, query], "");
  };

  const selectAddress = (suggestion: { email: string; name?: string }) => {
    const formatted = formatRecipient(suggestion.email, suggestion.name);
    update([...recipients, formatted], "");
    setDismissedQuery(query);
  };

  // "expanded" lists insert every member; "list" lists insert one chip holding
  // a snapshot of the members, which is expanded when sending or saving.
  const selectList = (list: DistributionList) => {
    if (list.display_mode === "expanded") {
      update([...recipients, ...newMemberTokens(list.members, recipients)], "");
    } else {
      update([...recipients, encodeListRecipient({ id: list.id, name: list.name, members: list.members })], "");
    }
    // The query is cleared, so typing the same text again should suggest again.
    setDismissedQuery(null);
  };

  const selectSuggestion = (suggestion: Suggestion) => {
    if (suggestion.kind === "list") selectList(suggestion.list);
    else selectAddress(suggestion.result.item);
  };

  const expandChip = (index: number) => {
    const list = decodeListRecipient(recipients[index]);
    if (!list) return;
    const others = recipients.filter((_, i) => i !== index);
    const added = newMemberTokens(list.members, others);
    update([...others.slice(0, index), ...added, ...others.slice(index)], query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || (e.shiftKey && e.key === "Tab")) return;
    if (showDropdown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, Math.min(i + (e.key === "ArrowDown" ? 1 : -1), suggestions.length - 1)));
    } else if (showDropdown && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      selectSuggestion(suggestions[Math.min(selectedIndex, suggestions.length - 1)]);
    } else if (["Enter", "Tab", ",", ";"].includes(e.key) && isCompleteAddress(query)) {
      if (e.key !== "Tab") e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !query && recipients.length) {
      e.preventDefault();
      const lastRecipient = recipients[recipients.length - 1];
      // A list chip is removed as a whole rather than turned back into text.
      update(recipients.slice(0, -1), isListRecipientToken(lastRecipient) ? "" : lastRecipient);
    } else if (e.key === "Escape") {
      setDismissedQuery(query);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDismissedQuery(query);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [query]);

  return (
    <div ref={containerRef} className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1">
      {recipients.map((recipient, index) => {
        if (isListRecipientToken(recipient)) {
          const list = decodeListRecipient(recipient);
          const remove = () => update(recipients.filter((_, i) => i !== index), query);
          return list ? (
            <ListChip key={`${index}-list-${list.id}`} list={list} onExpand={() => expandChip(index)} onRemove={remove} />
          ) : (
            <span key={`${index}-invalid-list`} className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs">
              {t("Unknown list")}
              <button type="button" aria-label={t("Remove")} className="shrink-0 rounded p-0.5 hover:bg-accent" onClick={remove}>
                <X className="size-3" />
              </button>
            </span>
          );
        }
        return (
        <span key={`${index}-${recipient}`} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs" title={recipient}>
          <span className="truncate">{recipient}</span>
          <button
            type="button"
            aria-label={`${t("Remove")} ${recipient}`}
            className="shrink-0 rounded p-0.5 hover:bg-accent"
            onClick={() => update(recipients.filter((_, i) => i !== index), query)}
          >
            <X className="size-3" />
          </button>
        </span>
        );
      })}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          update(recipients, e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setDismissedQuery(null)}
        onBlur={commit}
        placeholder={placeholder}
        className="min-w-24 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground/50"
      />
      {showDropdown && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-72 max-w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
          {isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t("Searching...")}
            </div>
          )}
          {suggestions.map((suggestion, i) => {
            const itemClass = `flex w-full text-left text-sm transition-colors ${i === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent/50"
              }`;
            const select = (e: React.MouseEvent) => {
              e.preventDefault(); // prevent input blur
              selectSuggestion(suggestion);
            };
            if (suggestion.kind === "list") {
              const { list } = suggestion;
              return (
                <button
                  key={`list-${list.id}`}
                  type="button"
                  data-testid="recipient-list-suggestion"
                  className={`${itemClass} items-center gap-2 px-3 py-2`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onMouseDown={select}
                >
                  <List className="size-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{list.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(list.members.length === 1 ? "{count} member" : "{count} members", { count: list.members.length })}
                    </span>
                  </span>
                </button>
              );
            }
            const { result } = suggestion;
            return (
            <button
              key={`${result.item.email}-${i}`}
              type="button"
              className={`${itemClass} flex-col px-3 py-2`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={select}
            >
              <span className="font-medium">
                {result.item.name ? (
                  <HighlightedText html={result.highlightedName ?? result.item.name} />
                ) : (
                  <HighlightedText html={result.highlightedEmail} />
                )}
              </span>
              {result.item.name && (
                <span className="text-xs text-muted-foreground">
                  <HighlightedText html={result.highlightedEmail} />
                </span>
              )}
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
