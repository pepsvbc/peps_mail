"use client";

import { translate as t, useTranslation } from "@/lib/i18n";

import { splitRecipientTokens, formatRecipient } from "@/lib/recipients";
import { X } from "lucide-react";
import { useAutocomplete } from "@/hooks/useAutocomplete";
import { useEffect, useMemo, useRef, useState } from "react";

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
  const committedLast = editingValue !== value && isCompleteAddress(last);
  const recipients = [...parts.filter(Boolean), ...(committedLast ? [last] : [])];
  const query = committedLast ? "" : last;
  const { results, isLoading } = useAutocomplete(query);
  const showDropdown = results.length > 0 && query.length >= 2 && !isCompleteAddress(query) && dismissedQuery !== query;

  const update = (addresses: string[], text: string) => {
    const next = [...addresses, text].join(", ");
    setEditingValue(next);
    onChange(next);
    setSelectedIndex(0);
  };

  const commit = () => {
    if (isCompleteAddress(query)) update([...recipients, query], "");
  };

  const selectSuggestion = (suggestion: { email: string; name?: string }) => {
    const formatted = formatRecipient(suggestion.email, suggestion.name);
    update([...recipients, formatted], "");
    setDismissedQuery(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || (e.shiftKey && e.key === "Tab")) return;
    if (showDropdown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, Math.min(i + (e.key === "ArrowDown" ? 1 : -1), results.length - 1)));
    } else if (showDropdown && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      selectSuggestion(results[Math.min(selectedIndex, results.length - 1)].item);
    } else if (["Enter", "Tab", ",", ";"].includes(e.key) && isCompleteAddress(query)) {
      if (e.key !== "Tab") e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !query && recipients.length) {
      e.preventDefault();
      update(recipients.slice(0, -1), recipients[recipients.length - 1]);
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
      {recipients.map((recipient, index) => (
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
      ))}
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
      {showDropdown && results.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-72 max-w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
          {isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t("Searching...")}
            </div>
          )}
          {results.map((result, i) => (
            <button
              key={`${result.item.email}-${result.item.source}`}
              type="button"
              className={`flex w-full flex-col px-3 py-2 text-left text-sm transition-colors ${i === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "text-popover-foreground hover:bg-accent/50"
                }`}
              onMouseEnter={() => setSelectedIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent input blur
                selectSuggestion(result.item);
              }}
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
              {result.item.source === "known" && (
                <span className="mt-0.5 text-xs text-muted-foreground/60">
                  {t("From email history")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
