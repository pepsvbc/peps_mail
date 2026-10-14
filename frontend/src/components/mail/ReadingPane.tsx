"use client";

import { translate as t, useTranslation } from "@/lib/i18n";

import { useState, useEffect, useRef, useMemo } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Paperclip,
  ChevronDown,
  ChevronUp,
  Code,
  Type,
  FileCode,
  ShieldAlert,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUiStore } from "@/stores/useUiStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useMessage, useUpdateFlags } from "@/hooks/useMessages";
import { createFadeSlideVariants } from "@/lib/motion/variants";
import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";
import { EmailRenderer, hasRemoteResources } from "./EmailRenderer";
import { MessageReplyActions } from "./MessageReplyActions";
import { ThreadView } from "./ThreadView";
import { Button } from "@/components/ui/button";
import {
  AddressChip,
  AddressList,
  AttachmentPreviewer,
  HeaderSkeleton,
  BodySkeleton,
  formatFileSize,
  humanizeDate,
} from "./ReadingPane/index";

type HeaderMode = "summary" | "details";
type BodyMode = "html" | "plain";
type EmailTheme = "auto" | "light" | "dark";

export function ReadingPane() {
  useTranslation();
  const activeFolder = useUiStore((s) => s.activeFolder);
  const selectedMessageUid = useUiStore((s) => s.selectedMessageUid);
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const [headerMode, setHeaderMode] = useState<HeaderMode>("details");
  const [bodyModeOverride, setBodyModeOverride] = useState<{
    messageKey: string;
    value: BodyMode;
  } | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);
  const [emailThemeOverride, setEmailThemeOverride] = useState<{
    messageKey: string;
    value: EmailTheme;
  } | null>(null);
  const [allowedRemoteMessages, setAllowedRemoteMessages] = useState<Set<string>>(
    new Set()
  );
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const queryClient = useQueryClient();
  const selectMessage = useUiStore((s) => s.selectMessage);

  const { data, isLoading, isError, error, refetch } = useMessage(
    activeFolder,
    selectedMessageUid ?? 0
  );

  const updateFlags = useUpdateFlags();

  const paneVariants = useMemo(() => createFadeSlideVariants(effectiveAnimationMode, "x"), [effectiveAnimationMode]);

  // When a message is not found on the server (stale cache), deselect it and
  // refresh the message list and search results so the ghost entry disappears.
  const handledStaleRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isError || !error?.message?.includes("not found")) return;
    if (handledStaleRef.current === selectedMessageUid) return;
    handledStaleRef.current = selectedMessageUid;
    selectMessage(null);
    queryClient.invalidateQueries({ queryKey: ["messages", activeFolder] });
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    queryClient.invalidateQueries({ queryKey: ["search"] });
  }, [isError, error, selectedMessageUid, activeFolder, selectMessage, queryClient]);

  // Auto-mark unread messages as read when opened.
  useEffect(() => {
    if (data && !data.flags.includes("\\Seen")) {
      updateFlags.mutate({
        folder: activeFolder,
        uid: data.uid,
        flags: ["\\Seen"],
        add: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.uid, data?.folder]);

  // No message selected
  if (selectedMessageUid === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("Select a message to read")}
      </div>
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <HeaderSkeleton />
        <BodySkeleton />
      </div>
    );
  }

  // Error
  if (isError || !data) {
    const errMsg = error?.message ?? t("Unknown error");
    console.error(`[ReadingPane] Failed to load message uid=${selectedMessageUid} folder=${activeFolder}:`, errMsg);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">{t("Failed to load message")}</p>
        <p className="max-w-md text-xs text-muted-foreground/60">{errMsg}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {t("Retry")}
        </Button>
      </div>
    );
  }

  const attachmentBaseUrl = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/messages/${encodeURIComponent(data.folder)}/${data.uid}/attachments`;
  const messageKey = JSON.stringify([activeAccountId, data.folder, data.uid]);
  const bodyMode = bodyModeOverride?.messageKey === messageKey
    ? bodyModeOverride.value
    : !data.html && data.text ? "plain" : "html";
  const emailTheme = emailThemeOverride?.messageKey === messageKey
    ? emailThemeOverride.value
    : "auto";
  const remoteAllowed = allowedRemoteMessages.has(messageKey);
  const showRemoteBanner = !remoteAllowed && hasRemoteResources(data.html);

  const paneContent = (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
    >
      {/* Header area */}
      <div className="relative shrink-0 space-y-1 overflow-x-hidden p-4 pb-6 pl-16">
        <div aria-hidden="true" className="absolute left-4 top-4 flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
          {(data.from_name || data.from_address).split(/\s+/).map((word) => word[0]).slice(0, 2).join("").toUpperCase()}
        </div>
        <h2 className="text-lg font-bold leading-tight">{data.subject}</h2>

        {headerMode === "summary" ? (
          <div className="text-sm text-foreground">
            {t("From")}{" "}
            <AddressChip
              address={data.from_address}
              name={data.from_name || null}
            />
            {" "}
            · {humanizeDate(data.date)}
          </div>
        ) : (
          <>
            <div className="text-sm text-foreground">
              <span className="font-medium text-muted-foreground">{t("From:")} </span>
              <AddressChip
                address={data.from_address}
                name={data.from_name || null}
              />
            </div>

            <div className="text-sm text-foreground">
              <span className="font-medium text-muted-foreground">{t("To:")} </span>
              <AddressList addresses={data.to_addresses} />
            </div>

            {data.cc_addresses.length > 0 && (
              <div className="text-sm text-foreground">
                <span className="font-medium text-muted-foreground">{t("Cc:")} </span>
                <AddressList addresses={data.cc_addresses} />
              </div>
            )}

            <div className="text-sm text-muted-foreground">
              {humanizeDate(data.date)}
            </div>
          </>
        )}

        {/* View toggle buttons */}
        <div className="flex gap-1 pt-1">
          {/* Details / Summary toggle */}
          <button
            type="button"
            onClick={() =>
              setHeaderMode(headerMode === "details" ? "summary" : "details")
            }
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {headerMode === "details" ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
            {headerMode === "details" ? t("Summary") : t("Details")}
          </button>

          {/* Plain text / HTML toggle */}
          <button
            type="button"
            onClick={() => {
              setBodyModeOverride({
                messageKey,
                value: bodyMode === "html" ? "plain" : "html",
              });
              setShowHeaders(false);
            }}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {bodyMode === "html" ? (
              <Type className="size-3" />
            ) : (
              <Code className="size-3" />
            )}
            {bodyMode === "html" ? t("Plain text") : "HTML"}
          </button>

          {/* Headers toggle (shows as selected when active) */}
          <button
            type="button"
            onClick={() => setShowHeaders(!showHeaders)}
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors ${
              showHeaders
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <FileCode className="size-3" />
            {t("Headers")}
          </button>

          {/* Email Theme toggle */}
          <button
            type="button"
            onClick={() => {
              setEmailThemeOverride({
                messageKey,
                value: emailTheme === "auto" ? "light" : emailTheme === "light" ? "dark" : "auto",
              });
            }}
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors ${
              emailTheme !== "auto"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {emailTheme === "auto" && <Monitor className="size-3" />}
            {emailTheme === "light" && <Sun className="size-3" />}
            {emailTheme === "dark" && <Moon className="size-3" />}
            {emailTheme === "auto" ? t("Auto theme") : emailTheme === "light" ? t("Light mode") : t("Dark mode")}
          </button>
        </div>
      </div>

      <div className="relative z-10 mb-4 h-px shrink-0 bg-border">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background px-2">
          <MessageReplyActions />
        </div>
      </div>

      {/* Attachment bar */}
      {data.attachments.length > 0 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border px-4 py-2">
          {data.attachments.map((att, i) => (
            <button
              key={att.id}
              type="button"
              onClick={() => setPreviewIndex(i)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-[200px] truncate">
                {att.filename ?? t("Attachment")}
              </span>
              <span className="text-muted-foreground">
                ({formatFileSize(att.size)})
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Attachment previewer */}
      {previewIndex !== null && (
        <AttachmentPreviewer
          attachments={data.attachments}
          baseUrl={attachmentBaseUrl}
          accountId={activeAccountId}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}

      {/* Thread view — only shown when there are multiple messages in the thread */}
      {data.thread && data.thread.length > 1 && (() => {
        const visibleThread = data.thread.filter(
          (m) => m.folder === activeFolder,
        );
        return visibleThread.length > 1 ? (
          <ThreadView thread={visibleThread} currentUid={data.uid} />
        ) : null;
      })()}

      {/* Remote resources banner */}
      {showRemoteBanner && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-4 py-2">
          <ShieldAlert className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-xs text-muted-foreground">
            {t("To protect your privacy, remote resources have been blocked.")}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            onClick={() =>
              setAllowedRemoteMessages((prev) => new Set(prev).add(messageKey))
            }
          >
            {t("Allow")}
          </Button>
        </div>
      )}

      {/* Body area — fills remaining space */}
      <div className="min-h-0 flex-1" key={messageKey}>
        {showHeaders ? (
          <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-foreground">
            {data.raw_headers || t("No headers available")}
          </pre>
        ) : bodyMode === "plain" ? (
          <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 text-sm leading-relaxed text-foreground">
            {data.text || t("No plain text available")}
          </pre>
        ) : (
          <EmailRenderer
            html={data.html}
            text={data.text}
            blockRemoteResources={!remoteAllowed}
            theme={emailTheme}
            emailTheme={data.email_theme}
          />
        )}
      </div>
      <div className="flex shrink-0 justify-center border-t border-border px-4 py-3">
        <MessageReplyActions labeled />
      </div>
    </div>
  );

  return (
    <AnimatePresence mode="wait" initial={false}>
      <AnimatedDiv
        key={`reading-pane-${messageKey}`}
        data-testid="reading-pane-message-transition"
        variants={paneVariants}
        initial={paneVariants.initial}
        animate={paneVariants.animate}
        exit={paneVariants.exit}
        className="h-full min-w-0 w-full"
      >
        {paneContent}
      </AnimatedDiv>
    </AnimatePresence>
  );
}
