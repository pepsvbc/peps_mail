"use client";

import { useTranslation } from "@/lib/i18n";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { X, MailOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AnimatePresence } from "framer-motion";
import { useUiStore } from "@/stores/useUiStore";
import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";
import { MailboxHeader } from "@/components/mail/MailboxHeader";
import { SearchBar } from "@/components/mail/SearchBar";
import { SearchResults } from "@/components/mail/SearchResults";
import { MessageActionBar } from "@/components/mail/MessageActionBar";
import { isValidCommittedSearch } from "@/lib/search-parser";
import { brand } from "@/lib/brand";

interface ThreePanelLayoutProps {
  sidebar: React.ReactNode;
  messageList: React.ReactNode;
  readingPane: React.ReactNode;
}

const centerTransition = {
  initial: { opacity: 0, x: 8 },
  animate: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.22, ease: [0.2, 0, 0, 1] as const },
  },
  exit: {
    opacity: 0,
    x: -4,
    transition: { duration: 0.14, ease: [0.2, 0, 0, 1] as const },
  },
};

const readingPaneTransition = {
  initial: { opacity: 0, x: 12 },
  animate: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.22, ease: [0.2, 0, 0, 1] as const },
  },
  exit: {
    opacity: 0,
    x: 6,
    transition: { duration: 0.14, ease: [0.2, 0, 0, 1] as const },
  },
};

const MIN_SIDEBAR_WIDTH = 140;
const MAX_SIDEBAR_WIDTH = 400;
const MIN_MESSAGE_LIST_WIDTH = 280;
const MAX_MESSAGE_LIST_WIDTH = 700;
const MIN_READING_PANE_WIDTH = 420;
const RESIZE_HANDLE_BUDGET = 8;

function ResizeHandle({
  onDrag,
}: {
  onDrag: (deltaX: number) => void;
}) {
  const { t } = useTranslation();
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        onDrag(delta);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onDrag],
  );

  return (
    <button
      type="button"
      aria-label={t("Resize panel")}
      onMouseDown={onMouseDown}
      className="group relative z-10 w-0 cursor-col-resize outline-none"
    >
      {/* Invisible wider hit area */}
      <div className="absolute inset-y-0 -left-1 w-2 group-hover:bg-primary/20 group-active:bg-primary/30" />
    </button>
  );
}

export function ThreePanelLayout({
  sidebar,
  messageList,
  readingPane,
}: ThreePanelLayoutProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const folderDrawerOpen = useUiStore((s) => s.folderDrawerOpen);
  const setFolderDrawerOpen = useUiStore((s) => s.setFolderDrawerOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const messageListWidth = useUiStore((s) => s.messageListWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const setMessageListWidth = useUiStore((s) => s.setMessageListWidth);
  const selectedMessageUid = useUiStore((s) => s.selectedMessageUid);
  const searchActive = useUiStore((s) => s.searchActive);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const readingPaneVisible = useUiStore((s) => s.readingPaneVisible);
  const hideMessageList = useUiStore((s) => s.hideMessageList);
  const singlePane = hideMessageList || !readingPaneVisible;
  const readingMessage = selectedMessageUid !== null;
  const hasValidCommittedSearch = isValidCommittedSearch(searchQuery);
  const showSearchResults = searchActive && hasValidCommittedSearch;
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    setContainerWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const maxMessageListWidth = useMemo(() => {
    if (singlePane) {
      return MAX_MESSAGE_LIST_WIDTH;
    }

    if (containerWidth == null) {
      return MAX_MESSAGE_LIST_WIDTH;
    }

    const remaining = Math.floor(
      containerWidth -
      (typeof window !== "undefined" && window.innerWidth < 1024 ? 0 : sidebarWidth) -
      RESIZE_HANDLE_BUDGET -
      MIN_READING_PANE_WIDTH,
    );

    return Math.max(
      MIN_MESSAGE_LIST_WIDTH,
      Math.min(MAX_MESSAGE_LIST_WIDTH, remaining),
    );
  }, [containerWidth, singlePane, sidebarWidth]);

  const resolvedMessageListWidth = !singlePane
    ? Math.max(MIN_MESSAGE_LIST_WIDTH, Math.min(messageListWidth, maxMessageListWidth))
    : null;

  const handleSidebarDrag = useCallback(
    (delta: number) => {
      const current = useUiStore.getState().sidebarWidth;
      setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, current + delta)));
    },
    [setSidebarWidth],
  );

  const handleMessageListDrag = useCallback(
    (delta: number) => {
      const current = useUiStore.getState().messageListWidth;
      setMessageListWidth(
        Math.max(MIN_MESSAGE_LIST_WIDTH, Math.min(maxMessageListWidth, current + delta)),
      );
    },
    [maxMessageListWidth, setMessageListWidth],
  );

  return (
    <div ref={containerRef} className={cn("mail-workspace flex h-full min-h-0 w-full overflow-hidden", selectedMessageUid !== null && "has-message")}>
      {/* Folder sidebar */}
      <aside
        className="mail-folder-panel shrink-0 overflow-y-auto bg-sidebar"
        style={{ width: sidebarWidth }}
      >
        {sidebar}
      </aside>

      {/* Resize handle: sidebar | message list */}
      <div className="mail-folder-resizer flex"><ResizeHandle onDrag={handleSidebarDrag} /></div>
      <Dialog.Root open={folderDrawerOpen ?? false} onOpenChange={setFolderDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-sidebar shadow-xl">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
              <Dialog.Title className="font-semibold">{t("Folders")}</Dialog.Title>
              <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label={t("Close folders")}><X className="size-4" /></Button></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1">{sidebar}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Center panel — search bar + message list or search results */}
      <main
        className={cn(
          !singlePane
            ? "mail-list-panel flex shrink-0 flex-col overflow-hidden border-x border-border"
            : "mail-list-panel flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border",
          singlePane && readingMessage && "!hidden",
        )}
        style={!singlePane ? { width: resolvedMessageListWidth ?? messageListWidth } : undefined}
      >
        <MailboxHeader />
        <SearchBar />
        <AnimatePresence mode="wait" initial={false}>
          {showSearchResults ? (
            <AnimatedDiv
              key="search"
              data-testid="three-panel-search-transition"
              variants={centerTransition}
              initial={centerTransition.initial}
              animate={centerTransition.animate}
              exit={centerTransition.exit}
              className="flex min-h-0 flex-1 flex-col"
            >
              <SearchResults />
            </AnimatedDiv>
          ) : (
            <AnimatedDiv
              key="list"
              data-testid="three-panel-list-transition"
              variants={centerTransition}
              initial={centerTransition.initial}
              animate={centerTransition.animate}
              exit={centerTransition.exit}
              className="flex-1 overflow-y-auto"
            >
              {messageList}
            </AnimatedDiv>
          )}
        </AnimatePresence>
      </main>

      {/* Resize handle: message list | reading pane */}
      <AnimatePresence initial={false}>
        {(!singlePane || readingMessage) && (
          <AnimatedDiv
            key="reading-pane"
            data-testid="three-panel-reading-pane-transition"
            variants={readingPaneTransition}
            initial={readingPaneTransition.initial}
            animate={readingPaneTransition.animate}
            exit={readingPaneTransition.exit}
            className="mail-reader-panel flex min-h-0 min-w-0 flex-1"
          >
            {!singlePane && <ResizeHandle onDrag={handleMessageListDrag} />}
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              <MessageActionBar showBack={singlePane} />
              {selectedMessageUid !== null ? (
                <div className="flex min-h-0 flex-1">{readingPane}</div>
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <MailOpen className="mb-1 size-10 stroke-1 text-muted-foreground/60" />
                  <p className="text-lg font-semibold tracking-tight text-foreground">
                    {t("Mail")} · {brand.name}
                  </p>
                  <p className="text-sm text-muted-foreground">{t("Select a message to read it.")}</p>
                </div>
              )}
            </section>
          </AnimatedDiv>
        )}
      </AnimatePresence>
    </div>
  );
}
