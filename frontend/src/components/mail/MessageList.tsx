"use client";

import { translate as t, useTranslation, getLocale } from "@/lib/i18n";

import { useRef, useCallback, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence } from "framer-motion";
import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";
import { PenLine, X, PanelRight, Inbox } from "lucide-react";
import { useMessages } from "@/hooks/useMessages";
import { useTagMessages } from "@/hooks/useTags";
import { useListDrafts, useDeleteDraft } from "@/hooks/useCompose";
import { createFadeSlideVariants, type MotionVariants } from "@/lib/motion/variants";
import type { AnimationMode } from "@/lib/motion/config";
import { ANIMATION_MODES } from "@/lib/motion/config";
import { useUiStore } from "@/stores/useUiStore";
import { useOpenDraft } from "@/hooks/useOpenDraft";
import { useFolders } from "@/hooks/useFolders";
import { MessageListItem } from "./MessageListItem";
import { isDraftsFolder } from "./FolderTree";
import { BulkActionBar } from "./BulkActionBar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Pre-computed fade-slide variants keyed by animation mode — avoids per-render allocation. */
const ROW_MOTION_VARIANTS_BY_MODE: Record<AnimationMode, MotionVariants> = Object.fromEntries(
  ANIMATION_MODES.map((mode) => [mode, createFadeSlideVariants(mode, "y")]),
) as Record<AnimationMode, MotionVariants>;

function SkeletonRows({ count, height }: { count: number; height: number }) {
  useTranslation();
  return (
    <div className="flex flex-col">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border px-3"
          style={{ height }}
        >
          <div className="h-3 w-3 animate-pulse rounded-full bg-muted" />
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
          <div className="h-3 w-12 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function humanizeDate(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);

  if (diffMinutes < 1) return t("just now");
  if (diffMinutes < 60) {
    return diffMinutes === 1 ? t("1 minute ago") : t("{count} minutes ago", { count: diffMinutes });
  }
  if (diffHours < 24) {
    return diffHours === 1 ? t("1 hour ago") : t("{count} hours ago", { count: diffHours });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return t("yesterday");
  }

  return date.toLocaleString(getLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DraftItems() {
  useTranslation();
  const { data } = useListDrafts(true);
  const deleteDraft = useDeleteDraft();
  const { openDraft, isPending } = useOpenDraft();

  const drafts = data?.drafts ?? [];
  if (drafts.length === 0) return null;

  return (
    <>
      {drafts.map((draft) => (
        <div
          key={draft.id}
          role="row"
          aria-busy={isPending}
          tabIndex={0}
          onClick={() => {
            void openDraft({ id: draft.id });
          }}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              void openDraft({ id: draft.id });
            }
          }}
          className={cn(
            "group flex h-16 cursor-pointer flex-col justify-center border-b border-border px-3 py-1.5 transition-colors",
            "hover:bg-muted bg-transparent",
          )}
        >
          {/* Top row: "Draft" label + date + delete */}
          <div className="flex items-center gap-2">
            <PenLine className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
              {draft.to || t("No recipient")}
            </span>
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              {humanizeDate(draft.updated_at)}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteDraft.mutate(draft.id);
              }}
              className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:flex items-center justify-center"
              title={t("Delete draft")}
            >
              <X className="size-3" />
            </button>
          </div>

          {/* Bottom row: subject */}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">
              {draft.subject || t("(no subject)")}
            </span>
          </div>
        </div>
      ))}
    </>
  );
}

function ToggleReadingPaneButton() {
  useTranslation();
  const visible = useUiStore((s) => s.readingPaneVisible);
  const setVisible = useUiStore((s) => s.setReadingPaneVisible);

  return (
    <button
      type="button"
      aria-label={visible ? t("Hide reading pane") : t("Show reading pane")}
      onClick={() => setVisible(!visible)}
      className={cn(
        "flex size-6 items-center justify-center rounded transition-colors hover:bg-accent",
        !visible && "text-primary",
      )}
    >
      <PanelRight className="size-3.5" />
    </button>
  );
}

export function MessageList() {
  useTranslation();
  const activeFolder = useUiStore((s) => s.activeFolder);
  const unreadOnly = useUiStore((s) => s.unreadOnly);
  const activeTagId = useUiStore((s) => s.activeTagId);
  const density = useUiStore((s) => s.density);
  const selectedMessageUid = useUiStore((s) => s.selectedMessageUid);
  const selectMessage = useUiStore((s) => s.selectMessage);
  const { data: folders } = useFolders();
  const showDrafts = !activeTagId && isDraftsFolder(activeFolder, folders?.folders.find((f) => f.name === activeFolder)?.attributes);
  const { openDraft, isPending: openingDraft } = useOpenDraft();
  const selectedMessageUids = useUiStore((s) => s.selectedMessageUids);
  const bulkSelectMode = useUiStore((s) => s.bulkSelectMode);
  const keyboardNav = useUiStore((s) => s.keyboardNav);
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const toggleBulkSelect = useUiStore((s) => s.toggleBulkSelect);
  const selectAllMessages = useUiStore((s) => s.selectAllMessages);
  const clearBulkSelection = useUiStore((s) => s.clearBulkSelection);
  const shouldAnimateRows = effectiveAnimationMode !== "off";

  const folderQuery = useMessages(activeFolder);
  const tagQuery = useTagMessages(activeTagId);

  // Select the right data source based on whether a tag filter is active.
  const isTagView = !!activeTagId;
  const data = isTagView ? undefined : folderQuery.data;
  const isLoading = isTagView ? tagQuery.isLoading : folderQuery.isLoading;
  const isFetching = isTagView ? tagQuery.isFetching : folderQuery.isFetching;
  const isError = isTagView ? tagQuery.isError : folderQuery.isError;
  const refetch = isTagView ? tagQuery.refetch : folderQuery.refetch;
  const fetchNextPage = folderQuery.fetchNextPage;
  const hasNextPage = isTagView ? false : folderQuery.hasNextPage;
  const isFetchingNextPage = isTagView ? false : folderQuery.isFetchingNextPage;

  // Flatten all pages into a single array of messages.
  const folderMessages = data?.pages.flatMap((page) => page.messages) ?? [];
  const tagMessages = isTagView ? (tagQuery.data?.messages ?? []) : [];
  const allMessages = isTagView ? tagMessages : folderMessages;
  const messages = unreadOnly && !showDrafts ? allMessages.filter((message) => !message.flags.includes("\\Seen")) : allMessages;
  const totalCount = isTagView
    ? (tagQuery.data?.total_count ?? 0)
    : (data?.pages[0]?.total_count ?? 0);
  const isSyncing = isDraftsFolder(activeFolder) ? false : (data?.pages[0]?.syncing ?? false);

  const parentRef = useRef<HTMLDivElement>(null);
  const rowHeight = density === "compact" ? 44 : 96;
  const prevSelectedUidRef = useRef<number | null>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- useVirtualizer is designed for this usage
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  // Scroll the virtualizer to keep the keyboard-selected message visible
  // with a 3-row buffer so the user can preview upcoming messages.
  // Only runs when selectedMessageUid CHANGES (keyboard nav), not on every render.
  useEffect(() => {
    if (selectedMessageUid == null || selectedMessageUid === prevSelectedUidRef.current) return;
    prevSelectedUidRef.current = selectedMessageUid;

    const idx = messages.findIndex((m) => m.uid === selectedMessageUid);
    if (idx < 0) return;

    const scrollEl = parentRef.current;
    if (!scrollEl) return;

    const itemTop = idx * rowHeight;
    const itemBottom = itemTop + rowHeight;
    const viewTop = scrollEl.scrollTop;
    const viewBottom = viewTop + scrollEl.clientHeight;
    const buffer = rowHeight * 3;

    if (itemTop < viewTop + buffer) {
      scrollEl.scrollTop = Math.max(0, itemTop - buffer);
    } else if (itemBottom > viewBottom - buffer) {
      scrollEl.scrollTop = itemBottom - scrollEl.clientHeight + buffer;
    }
  }, [selectedMessageUid, messages, rowHeight]);

  // Fetch next page when scrolling near the bottom.
  const virtualItems = virtualizer.getVirtualItems();
  const rowMotionVariants = ROW_MOTION_VARIANTS_BY_MODE[effectiveAnimationMode];
  const prevVisibleUidsRef = useRef<Set<number>>(new Set());

  const changedVisibleDelays = new Map<number, number>();
  if (shouldAnimateRows) {
    const previous = prevVisibleUidsRef.current;
    let changedVisibleIndex = 0;
    for (const item of virtualItems) {
      const message = messages[item.index];
      if (!message) continue;
      if (!previous.has(message.uid)) {
        const boundedIndex = Math.min(changedVisibleIndex, 6);
        changedVisibleDelays.set(message.uid, boundedIndex * 0.03);
        changedVisibleIndex += 1;
      }
    }
  }

  useEffect(() => {
    const nextVisible = new Set<number>();
    for (const item of virtualItems) {
      const message = messages[item.index];
      if (message) {
        nextVisible.add(message.uid);
      }
    }
    prevVisibleUidsRef.current = nextVisible;
  }, [messages, virtualItems]);

  const lastItem = virtualItems[virtualItems.length - 1];
  const lastItemIndex = lastItem?.index;

  useEffect(() => {
    if (lastItemIndex == null && !(unreadOnly && messages.length === 0)) return;
    if ((lastItemIndex ?? 0) >= messages.length - 10 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [lastItemIndex, messages.length, unreadOnly, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Anchor UID for shift-click range selection.
  const anchorUidRef = useRef<number | null>(null);

  const handleClick = useCallback(
    (uid: number, e: React.MouseEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isMod) {
        // Cmd/Ctrl+click: toggle this message in bulk selection.
        // If entering bulk mode while reading a message, include the read message too.
        if (selectedMessageUids.length === 0 && selectedMessageUid != null && selectedMessageUid !== uid) {
          selectAllMessages([selectedMessageUid, uid]);
        } else {
          toggleBulkSelect(uid);
        }
        anchorUidRef.current = uid;
        return;
      }

      if (isShift && anchorUidRef.current != null) {
        // Shift+click: select range from anchor to clicked message.
        const uids = messages.map((m) => m.uid);
        const anchorIdx = uids.indexOf(anchorUidRef.current);
        const clickedIdx = uids.indexOf(uid);
        if (anchorIdx !== -1 && clickedIdx !== -1) {
          const start = Math.min(anchorIdx, clickedIdx);
          const end = Math.max(anchorIdx, clickedIdx);
          selectAllMessages(uids.slice(start, end + 1));
        }
        return;
      }

      // Plain click: normal single-message selection, clear bulk.
      clearBulkSelection();
      const message = messages.find((m) => m.uid === uid);
      if (showDrafts || message?.flags.split(",").includes("\\Draft")) {
        void openDraft({ folder: message?.folder ?? activeFolder, uid });
      } else {
        selectMessage(uid);
      }
      anchorUidRef.current = uid;
    },
    [showDrafts, openDraft, activeFolder, selectMessage, toggleBulkSelect, selectAllMessages, clearBulkSelection, messages, selectedMessageUid, selectedMessageUids],
  );

  const allUids = messages.map((m) => m.uid);
  const allSelected =
    messages.length > 0 && selectedMessageUids.length === messages.length;

  const handleSelectAllToggle = useCallback(() => {
    if (allSelected) {
      clearBulkSelection();
    } else {
      selectAllMessages(allUids);
    }
  }, [allSelected, allUids, clearBulkSelection, selectAllMessages]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" aria-busy={openingDraft}>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-3 text-xs text-muted-foreground">
          {!isLoading && !isError && messages.length > 0 && (
            <button
              type="button"
              aria-label={allSelected ? t("Deselect all") : t("Select all")}
              onClick={handleSelectAllToggle}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                allSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40 bg-transparent hover:border-primary",
              )}
            >
              {allSelected && (
                <svg
                  className="size-3"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2.5 6l2.5 2.5 4.5-5" />
                </svg>
              )}
            </button>
          )}
        <span className="flex-1">{isLoading && !data ? "…" : t(totalCount === 1 ? "{count} message" : "{count} messages", { count: totalCount })}</span>
        {isSyncing && <span className="animate-pulse text-primary">{t("syncing…")}</span>}
        <ToggleReadingPaneButton />
      </div>
      {/* Bulk action bar */}
      <BulkActionBar />

      {/* Non-blocking refetch indicator */}
      <div className="relative h-0">
        {isFetching && !isLoading && messages.length > 0 && (
          <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary/30" />
        )}
      </div>

      {/* Loading state (true initial load only) */}
      {isLoading && !data && (
        <SkeletonRows count={8} height={rowHeight} />
      )}

      {/* Error state */}
      {isError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("Failed to load messages")}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t("Retry")}
          </Button>
        </div>
      )}

      {/* Empty state (only when not a drafts folder or no drafts either) */}
      {!isLoading && !isError && messages.length === 0 && !showDrafts && !isFetchingNextPage && !(unreadOnly && hasNextPage) && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
          <Inbox className="size-9 opacity-50" />
          {unreadOnly ? t("No unread messages") : isTagView ? t("No messages with this tag") : t("No messages in this folder")}
        </div>
      )}

      {/* Scrollable content: drafts + virtualized message list */}
      {!isLoading && !isError && (showDrafts || messages.length > 0 || (unreadOnly && hasNextPage)) && (
        <div
          ref={parentRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"
          onMouseMove={keyboardNav ? () => useUiStore.getState().setKeyboardNav(false) : undefined}
        >
          {/* Local drafts at top of the Drafts folder */}
          {showDrafts && <DraftItems />}

          {/* Virtualized IMAP messages */}
          {messages.length > 0 && (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: "100%",
                position: "relative",
              }}
            >
              <AnimatePresence initial={false}>
                {virtualItems.map((virtualRow) => {
                  const message = messages[virtualRow.index];
                  if (!message) return null;

                  const staggerDelay = changedVisibleDelays.get(message.uid) ?? 0;
                  const animateValue = {
                    ...rowMotionVariants.animate,
                    transition: {
                      ...(rowMotionVariants.animate as { transition?: object }).transition,
                      delay: staggerDelay,
                    },
                  };

                  return (
                    <AnimatedDiv
                      key={message.uid}
                      data-testid="message-list-row-transition"
                      data-row-uid={String(message.uid)}
                      data-row-changed={changedVisibleDelays.has(message.uid) ? "true" : "false"}
                      data-row-stagger-delay={String(staggerDelay)}
                      variants={rowMotionVariants}
                      initial={rowMotionVariants.initial}
                      animate={animateValue}
                      exit={rowMotionVariants.exit}
                      exposeMotionProps={false}
                      data-motion-props={JSON.stringify({
                        initial: rowMotionVariants.initial,
                        animate: animateValue,
                        exit: rowMotionVariants.exit,
                      })}
                      style={{
                        position: "absolute",
                        top: virtualRow.start,
                        left: 0,
                        width: "100%",
                        height: virtualRow.size,
                      }}
                    >
                      <MessageListItem
                        message={message}
                        isSelected={selectedMessageUid === message.uid}
                        density={density}
                        onClick={(e) => handleClick(message.uid, e)}
                        bulkSelectMode={bulkSelectMode}
                        isBulkSelected={selectedMessageUids.includes(message.uid)}
                        onBulkToggle={toggleBulkSelect}
                        suppressHover={keyboardNav}
                        effectiveAnimationMode={effectiveAnimationMode}
                      />
                    </AnimatedDiv>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
          {isFetchingNextPage && (
            <div className="flex items-center justify-center py-2">
              <span className="text-xs text-muted-foreground">{t("Loading more...")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
