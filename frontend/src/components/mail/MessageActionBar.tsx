"use client";

import { translate as t, useTranslation } from "@/lib/i18n";

import { useState, useMemo } from "react";
import { toast } from "sonner";
import { useFolders } from "@/hooks/useFolders";
import { findJunkFolder } from "@/lib/mail-folders";
import {
  FolderInput,
  ArrowLeft,
  Trash2,
  Archive,
  Star,
  Mail,
  MailOpen,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useUiStore } from "@/stores/useUiStore";
import {
  useMessage,
  useUpdateFlags,
  useMoveMessage,
  useDeleteMessage,
} from "@/hooks/useMessages";
import { MoveToFolderMenu } from "./MoveToFolderMenu";
import { TagPicker } from "./TagPicker";
import { Button } from "@/components/ui/button";
import { createFadeSlideVariants, createScaleFadeVariants } from "@/lib/motion/variants";
import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";

export function MessageActionBar({ showBack = false }: { showBack?: boolean }) {
  useTranslation();
  const activeFolder = useUiStore((s) => s.activeFolder);
  const selectedMessageUid = useUiStore((s) => s.selectedMessageUid);
  const updateFlags = useUpdateFlags();
  const moveMessage = useMoveMessage();
  const { data: folderData } = useFolders();
  const deleteMessage = useDeleteMessage();

  const { data } = useMessage(activeFolder, selectedMessageUid ?? 0);

  const disabled = !data;
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const shouldAnimate = effectiveAnimationMode !== "off";
  const barMotionProps = useMemo(() => createFadeSlideVariants(effectiveAnimationMode, "y"), [effectiveAnimationMode]);
  const feedbackMotionProps = useMemo(() => createScaleFadeVariants(effectiveAnimationMode), [effectiveAnimationMode]);
  const serializedFeedbackMotionProps = useMemo(() => JSON.stringify(feedbackMotionProps), [feedbackMotionProps]);
  const [actionFeedback, setActionFeedback] = useState<"delete" | "archive" | "move" | null>(null);

  const isSeen = data?.flags.includes("\\Seen") ?? false;
  const isFlagged = data?.flags.includes("\\Flagged") ?? false;

  const handleDelete = () => {
    if (!data) return;
    setActionFeedback("delete");
    if (activeFolder === "Trash") {
      deleteMessage.mutate(
        { folder: activeFolder, uid: data.uid },
        { onSettled: () => setActionFeedback(null) },
      );
    } else {
      moveMessage.mutate(
        { fromFolder: activeFolder, toFolder: "Trash", uid: data.uid },
        { onSettled: () => setActionFeedback(null) },
      );
    }
  };

  const handleArchive = () => {
    if (!data) return;
    setActionFeedback("archive");
    moveMessage.mutate(
      { fromFolder: activeFolder, toFolder: "Archive", uid: data.uid },
      { onSettled: () => setActionFeedback(null) },
    );
  };

  const handleJunk = () => {
    if (!data) return;
    const toFolder = findJunkFolder(folderData?.folders ?? []);
    if (!toFolder) {
      toast.error(t("No Spam or Junk folder found. Select a destination using Move to folder."));
      return;
    }
    if (toFolder === activeFolder || moveMessage.isPending) return;
    moveMessage.mutate({ fromFolder: activeFolder, toFolder, uid: data.uid });
  };

  const handleToggleStar = () => {
    if (!data) return;
    updateFlags.mutate({
      folder: activeFolder,
      uid: data.uid,
      flags: ["\\Flagged"],
      add: !isFlagged,
    });
  };

  const handleToggleRead = () => {
    if (!data) return;
    updateFlags.mutate({
      folder: activeFolder,
      uid: data.uid,
      flags: ["\\Seen"],
      add: !isSeen,
    });
  };

  return (
    <AnimatedDiv
      data-testid="message-action-bar-transition"
      variants={barMotionProps}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex min-h-14 shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-2"
    >
      <Button variant="ghost" size="icon" className={showBack ? "size-8 shrink-0" : "size-8 shrink-0 md:hidden"}
        title={t("Back to messages")} aria-label={t("Back to messages")}
        onClick={() => useUiStore.getState().selectMessage(null)}>
        <ArrowLeft className="size-4" />
      </Button>

      {/* Delete */}
      <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled={disabled} title={t("Delete")} onClick={handleDelete}>
        {shouldAnimate ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={actionFeedback === "delete" ? "delete-busy" : "delete-idle"}
              data-testid="message-action-delete-feedback-transition"
              data-motion-props={serializedFeedbackMotionProps}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={feedbackMotionProps}
              className="inline-flex"
            >
              {actionFeedback === "delete" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        ) : (
          <Trash2 className="size-4" />
        )}
        <span className="sr-only">{activeFolder === "Trash" ? t("Delete") : t("Delete")}</span>
      </Button>

      {/* Archive */}
      <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled={disabled || activeFolder === "Archive"} title={t("Archive")} onClick={handleArchive}>
        {shouldAnimate ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={actionFeedback === "archive" ? "archive-busy" : "archive-idle"}
              data-testid="message-action-archive-feedback-transition"
              data-motion-props={serializedFeedbackMotionProps}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={feedbackMotionProps}
              className="inline-flex"
            >
              {actionFeedback === "archive" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Archive className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        ) : (
          <Archive className="size-4" />
        )}
        <span className="sr-only">{t("Archive")}</span>
      </Button>

      {/* Move to */}
      {shouldAnimate ? (
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={actionFeedback === "move" ? "move-busy" : "move-idle"}
            data-testid="message-action-move-feedback-transition"
            data-motion-props={serializedFeedbackMotionProps}
            initial="initial"
            animate="animate"
            exit="exit"
            variants={feedbackMotionProps}
            className="inline-flex"
          >
            {actionFeedback === "move" ? (
              <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled>
                <Loader2 className="size-4 animate-spin" />
                <span className="sr-only">{t("Move to...")}</span>
              </Button>
            ) : disabled ? (
              <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled>
                <FolderInput className="size-4" /><span className="sr-only">{t("Move to...")}</span>
              </Button>
            ) : (
              <MoveToFolderMenu
                currentFolder={activeFolder}
                onMove={(toFolder) => {
                  setActionFeedback("move");
                  moveMessage.mutate(
                    { fromFolder: activeFolder, toFolder, uid: data.uid },
                    { onSettled: () => setActionFeedback(null) },
                  );
                }}
              />
            )}
          </motion.span>
        </AnimatePresence>
      ) : disabled ? (
        <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled>
          <FolderInput className="size-4" /><span className="sr-only">{t("Move to...")}</span>
        </Button>
      ) : (
        <MoveToFolderMenu
          currentFolder={activeFolder}
          onMove={(toFolder) => {
            moveMessage.mutate({ fromFolder: activeFolder, toFolder, uid: data.uid });
          }}
        />
      )}

      {/* Junk */}
      <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled={disabled || moveMessage.isPending || activeFolder === findJunkFolder(folderData?.folders ?? [])} title={t("Junk")} onClick={handleJunk}>
        <AlertCircle className="size-4" />
        <span className="sr-only">{t("Junk")}</span>
      </Button>

      {/* Star/Unstar */}
      <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled={disabled} title={isFlagged ? t("Unstar") : t("Star")} onClick={handleToggleStar}>
        {shouldAnimate ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={isFlagged ? "flagged" : "unflagged"}
              data-testid="message-action-star-feedback-transition"
              data-motion-props={serializedFeedbackMotionProps}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={feedbackMotionProps}
              className="inline-flex"
            >
              {isFlagged ? (
                <Star className="size-4 fill-primary text-primary" />
              ) : (
                <Star className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        ) : isFlagged ? (
          <Star className="size-4 fill-primary text-primary" />
        ) : (
          <Star className="size-4" />
        )}
        <span className="sr-only">{isFlagged ? t("Unstar") : t("Star")}</span>
      </Button>

      {/* Mark read/unread */}
      <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled={disabled} title={isSeen ? t("Unread") : t("Read")} onClick={handleToggleRead}>
        {shouldAnimate ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={isSeen ? "seen" : "unseen"}
              data-testid="message-action-read-feedback-transition"
              data-motion-props={serializedFeedbackMotionProps}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={feedbackMotionProps}
              className="inline-flex"
            >
              {isSeen ? (
                <MailOpen className="size-4" />
              ) : (
                <Mail className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        ) : isSeen ? (
          <MailOpen className="size-4" />
        ) : (
          <Mail className="size-4" />
        )}
        <span className="sr-only">{isSeen ? t("Unread") : t("Read")}</span>
      </Button>

      {/* Tags */}
      {data && (
        <TagPicker folder={activeFolder} uid={data.uid} />
      )}
    </AnimatedDiv>
  );
}
