"use client";

import { translate as t, useTranslation } from "@/lib/i18n";

import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";
import { createFadeSlideVariants, createScaleFadeVariants } from "@/lib/motion/variants";
import { useUiStore } from "@/stores/useUiStore";
import { AnimatePresence } from "framer-motion";
import { AlertDialog } from "radix-ui";
import { useMemo } from "react";

interface DiscardAlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onKeep?: () => void;
}

export function DiscardAlertDialog({
  open,
  onOpenChange,
  onConfirm,
  onKeep,
}: DiscardAlertDialogProps) {
  useTranslation();
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const overlayMotionProps = useMemo(() => createFadeSlideVariants(effectiveAnimationMode, "y"), [effectiveAnimationMode]);
  const contentMotionProps = useMemo(() => createScaleFadeVariants(effectiveAnimationMode), [effectiveAnimationMode]);

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AnimatePresence>
          {open ? (
            <>
              <AlertDialog.Overlay asChild>
                <AnimatedDiv
                  data-testid="discard-alert-overlay-transition"
                  variants={overlayMotionProps}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="fixed inset-0 z-50 bg-black/40"
                />
              </AlertDialog.Overlay>
              <AlertDialog.Content asChild>
                <AnimatedDiv
                  data-testid="discard-alert-content-transition"
                  variants={contentMotionProps}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-6 shadow-2xl"
                >
                  <AlertDialog.Title className="text-base font-semibold">
                    {t(onKeep ? "Keep this message as a draft?" : "Are you sure?")}
                  </AlertDialog.Title>
                  <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
                    {t(onKeep ? "Keep your message to finish later, or discard it." : "The message has not been sent and has unsaved changes. Do you want to discard your changes?")}
                  </AlertDialog.Description>
                  <div className="mt-6 flex flex-row flex-nowrap items-center justify-end gap-3">
                    <AlertDialog.Cancel asChild>
                      <button className="whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                        {t("Cancel")}
                      </button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action asChild>
                      <button
                        onClick={onConfirm}
                        className="whitespace-nowrap rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
                      >
                        {t("Discard")}
                      </button>
                    </AlertDialog.Action>
                    {onKeep && (
                      <AlertDialog.Action asChild>
                        <button onClick={onKeep} className="whitespace-nowrap rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                          {t("Keep draft")}
                        </button>
                      </AlertDialog.Action>
                    )}
                  </div>
                </AnimatedDiv>
              </AlertDialog.Content>
            </>
          ) : null}
        </AnimatePresence>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

