"use client";

import { Menu, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/hooks/useMessages";
import { useTags, useTagMessages } from "@/hooks/useTags";
import { useUiStore } from "@/stores/useUiStore";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatFolderName, isDraftsFolder } from "./FolderTree";

export function MailboxHeader() {
  const { t } = useTranslation();
  const activeFolder = useUiStore((s) => s.activeFolder);
  const activeTagId = useUiStore((s) => s.activeTagId);
  const searchActive = useUiStore((s) => s.searchActive);
  const unreadOnly = useUiStore((s) => s.unreadOnly);
  const setUnreadOnly = useUiStore((s) => s.setUnreadOnly);
  const setFolderDrawerOpen = useUiStore((s) => s.setFolderDrawerOpen);
  const folderQuery = useMessages(activeFolder);
  const tagQuery = useTagMessages(activeTagId);
  const { data: tags } = useTags();
  const query = activeTagId ? tagQuery : folderQuery;
  const tagName = tags?.tags.find((tag) => tag.id === activeTagId)?.name;
  const title = searchActive ? t("Search") : activeTagId
    ? t("Tag: {name}", { name: tagName ?? "…" }) : formatFolderName(activeFolder);

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <Button variant="ghost" size="icon" className="size-7 shrink-0 lg:hidden"
        aria-label={t("Open folders")} onClick={() => setFolderDrawerOpen(true)}>
        <Menu className="size-4" />
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight" title={title}>{title}</h1>
      {!searchActive && !isDraftsFolder(activeFolder) && (
        <div role="group" aria-label={t("Filter messages")} className="flex rounded-lg bg-muted p-1">
          {[false, true].map((unread) => (
            <button key={String(unread)} type="button" aria-pressed={unreadOnly === unread}
              onClick={() => setUnreadOnly(unread)}
              className={cn("rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                unreadOnly === unread ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {t(unread ? "Unread" : "All")}
            </button>
          ))}
        </div>
      )}
      {!searchActive && (
        <Button variant="ghost" size="icon" className="size-7" aria-label={t("Refresh messages")} onClick={() => query.refetch()}>
          <RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} />
        </Button>
      )}
    </header>
  );
}
