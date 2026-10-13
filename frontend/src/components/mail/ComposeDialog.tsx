"use client";

import { translate as t, useTranslation } from "@/lib/i18n";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { AnimatePresence, motion } from "framer-motion";
import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";
import {
  Send,
  X,
  ChevronUp,
  AlertTriangle,
  Paperclip,
  Loader2,
  Save,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeft,
  PanelRight,
  Upload,
  FileText,
  Code,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";
import {
  useComposeStore,
  replaceSignatureInBody,
  removeSignatureFromBody,
  injectSignature,
} from "@/stores/useComposeStore";
import {
  useSendMessage,
  useSaveDraft,
  useUploadAttachment,
  useDeleteAttachment,
  useDeleteDraft,
} from "@/hooks/useCompose";
import { useIdentities } from "@/hooks/useIdentities";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/useUiStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { createFadeSlideVariants, createScaleFadeVariants } from "@/lib/motion/variants";
import {
  countRecipients,
  formatFileSize,
  stripHtml,
  generateId,
  DiscardAlertDialog,
  AttachmentPreviewDialog,
} from "./ComposeDialog/index";
import { RecipientInput } from "./ComposeDialog/RecipientInput";
import dynamic from "next/dynamic";

const RichTextEditor = dynamic(
  () => import("@/components/mail/RichTextEditor").then((mod) => mod.RichTextEditor),
  { ssr: false }
);

export function ComposeDialog() {
  useTranslation();
  const {
    isOpen,
    isMinimized,
    accountId,
    to,
    cc,
    bcc,
    subject,
    body,
    inReplyTo,
    references,
    draftId,
    showCc,
    showBcc,
    attachments,
    fromIdentityId,
    isHtml,
    signatureHtml,
    signatureEnabled,
    closeCompose,
    minimizeCompose,
    restoreCompose,
    setField,
    setShowCc,
    setShowBcc,
    setDraftId,
    setFromIdentityId,
    setIsHtml,
    setSignatureHtml,
    setSignatureEnabled,
    addAttachments,
    removeAttachment,
    reset,
  } = useComposeStore();

  const sendMutation = useSendMessage();
  const saveDraftMutation = useSaveDraft();
  const uploadMutation = useUploadAttachment();
  const deleteMutation = useDeleteAttachment();
  const deleteDraftMutation = useDeleteDraft();
  const { data: identities } = useIdentities();
  const [draftSaved, setDraftSaved] = useState(false);
  const [showDiscardAlert, setShowDiscardAlert] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<"left" | "right">("right");
  const [previewAttId, setPreviewAttId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const toInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSavedHashRef = useRef<string>("");
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const accountMismatch = accountId != null && accountId !== activeAccountId;
  const isCurrentAccount = useCallback(
    () => accountId == null || accountId === useAuthStore.getState().activeAccountId,
    [accountId],
  );
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const shouldAnimate = effectiveAnimationMode !== "off";
  const contentMotionProps = useMemo(() => createScaleFadeVariants(effectiveAnimationMode), [effectiveAnimationMode]);
  const sendFeedbackMotionProps = useMemo(() => createFadeSlideVariants(effectiveAnimationMode, "y"), [effectiveAnimationMode]);
  const serializedSendFeedbackMotionProps = useMemo(() => JSON.stringify(sendFeedbackMotionProps), [sendFeedbackMotionProps]);

  const hasContent = useCallback(() => {
    return !!(
      to.trim() ||
      cc.trim() ||
      bcc.trim() ||
      subject.trim() ||
      stripHtml(body).trim() ||
      attachments.length > 0
    );
  }, [to, cc, bcc, subject, body, attachments]);

  // Auto-select the default identity when dialog opens and no identity is set,
  // and inject signature into body
  useEffect(() => {
    if (isOpen && !accountMismatch && fromIdentityId === null && identities && identities.length > 0) {
      const defaultIdentity = identities.find((i) => i.is_default) ?? identities[0];
      setFromIdentityId(defaultIdentity.id);
      // Inject signature from the default identity
      if (defaultIdentity.signature_html && signatureEnabled) {
        setSignatureHtml(defaultIdentity.signature_html);
        // Saved drafts already contain the signature the author chose.
        if (!draftId) setField("body", injectSignature(body, defaultIdentity.signature_html));
      }
    }
  }, [isOpen, accountMismatch, fromIdentityId, identities, setFromIdentityId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus the To field when dialog opens
  useEffect(() => {
    if (isOpen && !isMinimized && !accountMismatch) {
      const focusInput = () => toInputRef.current?.focus();
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(focusInput);
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [isOpen, isMinimized, accountMismatch]);

  useEffect(() => {
    if (isMinimized) restoreButtonRef.current?.focus();
  }, [isMinimized]);

  // Compute a simple hash of compose fields for dirty tracking
  const computeHash = useCallback(() => {
    return `${to}|${cc}|${bcc}|${subject}|${body}`;
  }, [to, cc, bcc, subject, body]);

  // Save draft function. When force=true, skip the hash guard (used for explicit save/close).
  const saveDraft = useCallback(
    (force = false) => {
      if (!isCurrentAccount()) return;
      const hash = computeHash();
      // Don't save if nothing changed (unless forced) or compose is empty
      if (!force && hash === lastSavedHashRef.current) return;
      if (
        !to.trim() &&
        !cc.trim() &&
        !bcc.trim() &&
        !subject.trim() &&
        !stripHtml(body).trim()
      )
        return;

      let currentDraftId = draftId;
      if (!currentDraftId) {
        currentDraftId = generateId();
        setDraftId(currentDraftId);
      }

      saveDraftMutation.mutate(
        {
          id: currentDraftId,
          to,
          cc,
          bcc,
          subject,
          textBody: isHtml ? stripHtml(body) : body,
          htmlBody: isHtml ? body : null,
          inReplyTo: inReplyTo,
          references: references,
        },
        {
          onSuccess: () => {
            lastSavedHashRef.current = hash;
            setDraftSaved(true);
            setTimeout(() => setDraftSaved(false), 3000);
            toast.success(t("Draft saved"));
          },
        }
      );
    },
    [
      computeHash,
      to,
      cc,
      bcc,
      subject,
      body,
      isHtml,
      draftId,
      setDraftId,
      inReplyTo,
      references,
      saveDraftMutation,
      isCurrentAccount,
    ]
  );

  // Auto-save every 30s when dialog is open
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      saveDraft();
    }, 30000);
    return () => clearInterval(interval);
  }, [isOpen, saveDraft]);

  // Reset saved hash when dialog opens
  useEffect(() => {
    if (isOpen) {
      lastSavedHashRef.current = computeHash();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSend = useCallback(() => {
    if (!isCurrentAccount()) {
      toast.error(t("Switch back to this draft's account before sending."));
      useComposeStore.setState({ isOpen: true, isMinimized: false });
      return;
    }
    let plainText: string;
    let sendHtml: string | null;
    if (isHtml) {
      plainText = stripHtml(body);
      // Convert preview URLs back to cid: references for the email MIME body
      sendHtml = body.replace(
        /\/api\/drafts\/[^/]+\/attachments\/([^/]+)\/content/g,
        (_match, attId) => `cid:${attId}`
      );
    } else {
      plainText = body;
      sendHtml = null;
    }
    sendMutation.mutate(
      {
        to,
        cc,
        bcc,
        subject,
        body: plainText,
        htmlBody: sendHtml,
        inReplyTo,
        references,
        draftId,
        fromIdentityId,
      },
      {
        onSuccess: (result) => {
          if (result.sent_copy_saved === false) {
            toast.warning(t("Message sent, but a copy could not be saved to Sent. Do not resend."), { duration: 10000 });
          } else {
            toast.success(t("Message sent"));
          }
          reset();
        },
        onError: (error) => {
          toast.error(t("Failed to send: {error}", { error: error.message }));
        },
      }
    );
  }, [
    to,
    cc,
    bcc,
    subject,
    body,
    isHtml,
    inReplyTo,
    references,
    draftId,
    fromIdentityId,
    sendMutation,
    reset,
    isCurrentAccount,
  ]);

  const handleSend = useCallback(() => {
    if (!isCurrentAccount()) return;
    if (!to.trim() && !cc.trim() && !bcc.trim()) return;
    closeCompose();

    // 5-second undo window via sonner
    const timer = setTimeout(() => {
      toast.dismiss("undo-send");
      doSend();
    }, 5000);

    toast(t("Sending message..."), {
      id: "undo-send",
      duration: 5500,
      action: {
        label: t("Undo"),
        onClick: () => {
          clearTimeout(timer);
          useComposeStore.setState({ isOpen: true });
        },
      },
    });
  }, [to, cc, bcc, closeCompose, doSend, isCurrentAccount]);

  const handleDiscard = useCallback(() => {
    if (hasContent()) {
      setShowDiscardAlert(true);
    } else {
      reset();
    }
  }, [hasContent, reset]);

  const confirmDiscard = useCallback(() => {
    setShowDiscardAlert(false);
    if (draftId && isCurrentAccount()) {
      deleteDraftMutation.mutate(draftId);
    }
    reset();
  }, [draftId, deleteDraftMutation, reset, isCurrentAccount]);

  // Save draft and close the dialog without discarding.
  const handleSaveAndClose = useCallback(() => {
    if (!isCurrentAccount()) {
      toast.error(t("Switch back to this draft's account before saving or closing it."));
      return;
    }
    if (hasContent()) {
      saveDraft(true);
    }
    closeCompose();
  }, [hasContent, saveDraft, closeCompose, isCurrentAccount]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isMinimized || accountMismatch) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSend();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveDraft(true);
      }
    },
    [handleSend, saveDraft, isMinimized, accountMismatch]
  );

  const handleAttachFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!isCurrentAccount()) return;
      const files = e.target.files;
      if (!files || files.length === 0) return;

      // Ensure we have a draft ID for uploads
      let currentDraftId = draftId;
      if (!currentDraftId) {
        currentDraftId = generateId();
        setDraftId(currentDraftId);
      }

      uploadMutation.mutate(
        { draftId: currentDraftId, files: Array.from(files) },
        {
          onSuccess: (data) => {
            addAttachments(
              data.attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                contentType: a.content_type,
                size: a.size,
              }))
            );
          },
          onError: (error) => {
            toast.error(t("Upload failed: {error}", { error: error.message }));
          },
        }
      );

      // Reset the input so the same file can be re-selected
      e.target.value = "";
    },
    [draftId, setDraftId, uploadMutation, addAttachments, isCurrentAccount]
  );

  const handleImageUpload = useCallback(
    async (file: File): Promise<string | null> => {
      if (!isCurrentAccount()) return null;
      // Ensure we have a draft ID for the upload
      let currentDraftId = draftId;
      if (!currentDraftId) {
        currentDraftId = generateId();
        setDraftId(currentDraftId);
      }

      return new Promise((resolve) => {
        uploadMutation.mutate(
          { draftId: currentDraftId!, files: [file] },
          {
            onSuccess: (data) => {
              if (data.attachments.length > 0) {
                const att = data.attachments[0];
                addAttachments([
                  {
                    id: att.id,
                    filename: att.filename,
                    contentType: att.content_type,
                    size: att.size,
                  },
                ]);
                // Return a preview URL that the browser can render.
                // The send flow converts these back to cid: references.
                resolve(
                  `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/drafts/${currentDraftId}/attachments/${att.id}/content`
                );
              } else {
                resolve(null);
              }
            },
            onError: (error) => {
              toast.error(t("Image upload failed: {error}", { error: error.message }));
              resolve(null);
            },
          }
        );
      });
    },
    [draftId, setDraftId, uploadMutation, addAttachments, isCurrentAccount]
  );

  const handleRemoveAttachment = useCallback(
    (attachmentId: string) => {
      if (!draftId || !isCurrentAccount()) return;
      deleteMutation.mutate(
        { draftId, attachmentId },
        {
          onSuccess: () => {
            removeAttachment(attachmentId);
          },
          onError: (error) => {
            toast.error(t("Delete failed: {error}", { error: error.message }));
          },
        }
      );
    },
    [draftId, deleteMutation, removeAttachment, isCurrentAccount]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isMinimized || !isCurrentAccount()) return;
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, [isMinimized, isCurrentAccount]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounterRef.current = 0;

      if (isMinimized || !isCurrentAccount()) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      let currentDraftId = draftId;
      if (!currentDraftId) {
        currentDraftId = generateId();
        setDraftId(currentDraftId);
      }

      uploadMutation.mutate(
        { draftId: currentDraftId, files },
        {
          onSuccess: (data) => {
            addAttachments(
              data.attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                contentType: a.content_type,
                size: a.size,
              }))
            );
            toast.success(t(data.attachments.length === 1 ? "{count} file attached" : "{count} files attached", { count: data.attachments.length }));
          },
          onError: (error) => {
            toast.error(t("Upload failed: {error}", { error: error.message }));
          },
        }
      );
    },
    [draftId, setDraftId, uploadMutation, addAttachments, isCurrentAccount, isMinimized]
  );

  const handleToggleHtml = useCallback(() => {
    if (isHtml) {
      // HTML → plain text: strip tags
      setField("body", stripHtml(body));
    } else {
      // Plain text → HTML: wrap lines in <p> tags
      const html = body
        .split("\n")
        .map((line) => `<p>${line || "<br>"}</p>`)
        .join("");
      setField("body", html);
    }
    setIsHtml(!isHtml);
  }, [isHtml, body, setField, setIsHtml]);

  const previewAttachment = previewAttId
    ? attachments.find((a) => a.id === previewAttId)
    : null;

  return (
    <>
      <Dialog.Root
        open={isOpen}
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            handleSaveAndClose();
          }
        }}
      >
        <Dialog.Portal>
          <AnimatePresence>
            {isOpen ? (
              <Fragment key="compose-dialog-open">
                <Dialog.Content
                  forceMount
                  asChild
                  aria-describedby={undefined}
                  onInteractOutside={(event) => event.preventDefault()}
                  onEscapeKeyDown={(event) => {
                    if (!contentRef.current?.contains(document.activeElement)) {
                      event.preventDefault();
                    }
                  }}
                >
                  <AnimatedDiv
                    ref={contentRef}
                    data-testid="compose-dialog-content-transition"
                    variants={contentMotionProps}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className={cn(
                      "fixed z-50 flex flex-col rounded-xl border border-border bg-background shadow-2xl",
                      expanded && !isMinimized
                        ? "inset-4 sm:left-20"
                        : cn(
                            "inset-x-4 bottom-4 max-h-[80dvh] sm:bottom-8",
                            isMinimized ? "sm:w-80" : "h-[min(42rem,80dvh)] sm:w-[min(42rem,calc(100vw-6rem))]",
                            position === "left" ? "sm:left-20 sm:right-auto" : "sm:left-auto sm:right-4",
                          )
                    )}
                    onKeyDown={handleKeyDown}
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                  >
            {/* Drop overlay */}
            {isDragging && !isMinimized && !accountMismatch && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-background/90 backdrop-blur-sm">
                <Upload className="size-10 text-primary" />
                <p className="mt-3 text-sm font-medium text-foreground">
                  {t("Drop files to attach")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Files will be uploaded as attachments")}
                </p>
              </div>
            )}

            {/* Header */}
            <div className={cn("flex shrink-0 items-center justify-between gap-2 rounded-t-xl bg-muted px-4 py-2.5", !isMinimized && "border-b border-border")}>
              <Dialog.Title className="min-w-0 flex-1 text-sm font-semibold">
                {isMinimized ? (
                  <button
                    ref={restoreButtonRef}
                    onClick={restoreCompose}
                    aria-label={t("Restore composer")}
                    title={t("Restore composer")}
                    className="flex w-full items-center gap-2 rounded text-left hover:text-primary"
                  >
                    <ChevronUp className="size-4 shrink-0" /><span className="truncate">{subject.trim() || t("New Message")}</span>
                  </button>
                ) : t("New Message")}
              </Dialog.Title>
              <div className="flex shrink-0 items-center gap-1">
                {(["left", "right"] as const).map((side) => (
                  <button key={side} type="button"
                    onClick={() => { setPosition(side); setExpanded(false); }}
                    className={cn("rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground", position === side && !expanded && "bg-background text-foreground shadow-sm")}
                    aria-pressed={position === side && !expanded}
                    aria-label={t(side === "left" ? "Move composer to left" : "Move composer to right")}
                    title={t(side === "left" ? "Move composer to left" : "Move composer to right")}>
                    {side === "left" ? <PanelLeft className="size-4" /> : <PanelRight className="size-4" />}
                  </button>
                ))}
                {!isMinimized && (
                  <>
                    <button
                      onClick={minimizeCompose}
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={t("Minimize composer")}
                      title={t("Minimize composer")}
                    >
                      <Minus className="size-4" />
                    </button>
                    <button
                      onClick={() => setExpanded((e) => !e)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={expanded ? t("Restore composer size") : t("Maximize composer")}
                      title={expanded ? t("Restore composer size") : t("Maximize composer")}
                    >
                      {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                    </button>
                  </>
                )}
                <Dialog.Close asChild>
                  <button
                    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={t("Close composer")}
                    title={t("Save draft and close")}
                  >
                    <X className="size-4" />
                  </button>
                </Dialog.Close>
              </div>
            </div>

            {accountMismatch && !isMinimized && (
              <div className="space-y-3 p-4 text-sm text-muted-foreground">
                <p>{t("Switch back to this draft's account to continue composing.")}</p>
                <button onClick={handleDiscard} className="rounded-md border border-border px-3 py-2 hover:bg-accent">
                  {t("Discard")}
                </button>
              </div>
            )}

            <div
              hidden={isMinimized || accountMismatch}
              className={cn(!isMinimized && !accountMismatch && "flex min-h-0 flex-1 flex-col overflow-y-auto")}
            >
            {/* Fields */}
            <div className="flex flex-col border-b border-border">
              {identities && identities.length > 1 && (
                <div className="flex items-center border-b border-border/50 px-4">
                  <label className="w-12 shrink-0 text-xs text-muted-foreground">
                    {t("From")}
                  </label>
                  <select
                    value={fromIdentityId ?? ""}
                    onChange={(e) => {
                      const newId = e.target.value ? Number(e.target.value) : null;
                      setFromIdentityId(newId);
                      // Swap signature when identity changes
                      if (identities && signatureEnabled) {
                        const newIdentity = identities.find((i) => i.id === newId);
                        const newSig = newIdentity?.signature_html || "";
                        setSignatureHtml(newSig);
                        setField("body", replaceSignatureInBody(body, newSig));
                      }
                    }}
                    className="flex-1 bg-transparent py-2 text-sm outline-none"
                  >
                    {identities.map((identity) => (
                      <option key={identity.id} value={identity.id}>
                        {identity.display_name
                          ? `${identity.display_name} <${identity.email}>`
                          : identity.email}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center border-b border-border/50 px-4">
                <label className="w-12 shrink-0 text-xs text-muted-foreground">
                  {t("To")}
                </label>
                <RecipientInput
                  inputRef={toInputRef}
                  value={to}
                  onChange={(v) => setField("to", v)}
                  placeholder={t("Recipients")}
                />
                <button
                  className="ml-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    if (!showCc && !showBcc) {
                      setShowCc(true);
                    } else {
                      setShowCc(!showCc);
                      setShowBcc(!showBcc);
                    }
                  }}
                >
                  {showCc || showBcc ? (
                    <ChevronUp className="size-3.5" />
                  ) : (
                    <span>{t("Cc Bcc")}</span>
                  )}
                </button>
              </div>

              {showCc && (
                <div className="flex items-center border-b border-border/50 px-4">
                  <label className="w-12 shrink-0 text-xs text-muted-foreground">
                    {t("Cc")}
                  </label>
                  <RecipientInput
                    value={cc}
                    onChange={(v) => setField("cc", v)}
                  />
                </div>
              )}

              {showBcc && (
                <div className="flex items-center border-b border-border/50 px-4">
                  <label className="w-12 shrink-0 text-xs text-muted-foreground">
                    {t("Bcc")}
                  </label>
                  <RecipientInput
                    value={bcc}
                    onChange={(v) => setField("bcc", v)}
                  />
                </div>
              )}

              <div className="flex items-center px-4">
                <label className="w-12 shrink-0 text-xs text-muted-foreground">
                  {t("Subject")}
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setField("subject", e.target.value)}
                  className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground/50"
                />
              </div>
            </div>

            {/* Recipient count warning */}
            {countRecipients(to, cc, bcc) > 10 && (
              <div className="flex items-center gap-2 border-b border-yellow-300/50 bg-yellow-50 px-4 py-2 dark:border-yellow-700/50 dark:bg-yellow-950/30">
                <AlertTriangle className="size-4 shrink-0 text-yellow-600 dark:text-yellow-500" />
                <span className="text-xs text-yellow-700 dark:text-yellow-400">
                  {t("You are sending to more than 10 recipients.")}
                </span>
              </div>
            )}

            {/* Attachments */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center gap-1.5 rounded-md border border-border bg-accent/50 px-2 py-1 text-xs"
                  >
                    <button
                      onClick={() => setPreviewAttId(att.id)}
                      className="flex items-center gap-1.5 hover:text-foreground"
                      title={t("Preview")}
                    >
                      <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                      <span
                        className="max-w-[150px] truncate"
                        title={att.filename}
                      >
                        {att.filename}
                      </span>
                      <span className="text-muted-foreground">
                        ({formatFileSize(att.size)})
                      </span>
                    </button>
                    <button
                      onClick={() => handleRemoveAttachment(att.id)}
                      className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title={t("Remove attachment")}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Body */}
            {isHtml ? (
              <RichTextEditor
                content={body}
                onChange={(html) => setField("body", html)}
                onImageUpload={handleImageUpload}
                placeholder={t("Write your message...")}
                className="flex-1 overflow-auto"
              />
            ) : (
              <textarea
                value={body}
                onChange={(e) => setField("body", e.target.value)}
                placeholder={t("Write your message...")}
                className="flex-1 resize-none overflow-auto bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground/50"
              />
            )}

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSend}
                  disabled={
                    sendMutation.isPending ||
                    (!to.trim() && !cc.trim() && !bcc.trim())
                  }
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  )}
                >
                  {shouldAnimate ? (
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={sendMutation.isPending ? "pending" : "idle"}
                        data-testid="compose-send-feedback-transition"
                        data-motion-props={serializedSendFeedbackMotionProps}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        variants={sendFeedbackMotionProps}
                        className="inline-flex items-center gap-2"
                      >
                        {sendMutation.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            {t("Sending...")}
                          </>
                        ) : (
                          <>
                            <Send className="size-4" />
                            {t("Send")}
                          </>
                        )}
                      </motion.span>
                    </AnimatePresence>
                  ) : sendMutation.isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t("Sending...")}
                    </>
                  ) : (
                    <>
                      <Send className="size-4" />
                      {t("Send")}
                    </>
                  )}
                </button>
                <button
                  onClick={handleAttachFiles}
                  disabled={uploadMutation.isPending}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  title={t("Attach files")}
                >
                  {uploadMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Paperclip className="size-4" />
                  )}
                </button>
                <button
                  onClick={() => saveDraft(true)}
                  disabled={saveDraftMutation.isPending}
                  className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  title={t("Save draft (Ctrl+S)")}
                >
                  {saveDraftMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                </button>
                <button
                  onClick={handleToggleHtml}
                  className={cn(
                    "rounded-lg p-2 hover:bg-accent hover:text-foreground",
                    isHtml ? "text-muted-foreground" : "text-primary"
                  )}
                  title={isHtml ? t("Switch to plain text") : t("Switch to rich text")}
                >
                  {isHtml ? (
                    <FileText className="size-4" />
                  ) : (
                    <Code className="size-4" />
                  )}
                </button>
                <button
                  onClick={() => {
                    const newEnabled = !signatureEnabled;
                    setSignatureEnabled(newEnabled);
                    if (newEnabled) {
                      // Re-inject signature
                      if (signatureHtml) {
                        setField("body", injectSignature(removeSignatureFromBody(body), signatureHtml));
                      }
                    } else {
                      // Remove signature from body
                      setField("body", removeSignatureFromBody(body));
                    }
                  }}
                  className={cn(
                    "rounded-lg p-2 hover:bg-accent hover:text-foreground",
                    signatureEnabled ? "text-primary" : "text-muted-foreground"
                  )}
                  title={signatureEnabled ? t("Remove signature") : t("Add signature")}
                >
                  <PenLine className="size-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelected}
                />
              </div>
              <div className="flex items-center gap-2">
                {draftSaved && (
                  <span className="text-xs text-muted-foreground">
                    {t("Draft saved")}
                  </span>
                )}
                <button
                  onClick={handleDiscard}
                  className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t("Discard")}
                </button>
              </div>
            </div>
            </div>
                  </AnimatedDiv>
                </Dialog.Content>
              </Fragment>
            ) : null}
          </AnimatePresence>
        </Dialog.Portal>
      </Dialog.Root>

      <DiscardAlertDialog
        open={showDiscardAlert}
        onOpenChange={setShowDiscardAlert}
        onConfirm={confirmDiscard}
      />

      {/* Attachment preview dialog */}
      {previewAttachment && draftId && !accountMismatch && !isMinimized && (
        <AttachmentPreviewDialog
          attachment={{
            id: previewAttachment.id,
            filename: previewAttachment.filename,
            contentType: previewAttachment.contentType,
            size: previewAttachment.size,
          }}
          previewUrl={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/drafts/${draftId}/attachments/${previewAttachment.id}/content`}
          onClose={() => setPreviewAttId(null)}
        />
      )}
    </>
  );
}
