"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPost } from "@/lib/api";
import { translate as t } from "@/lib/i18n";
import { useAuthStore } from "@/stores/useAuthStore";
import { useComposeStore } from "@/stores/useComposeStore";
import type { DraftDetail } from "./useCompose";

type DraftSource = { id: string } | { folder: string; uid: number };

/** Resume saved drafts without replacing an unsaved composer or crossing accounts. */
export function useOpenDraft() {
  const queryClient = useQueryClient();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);

  const openDraft = async (source: DraftSource) => {
    const accountId = useAuthStore.getState().activeAccountId;
    const restoreExisting = (id?: string) => {
      const composer = useComposeStore.getState();
      if (!composer.isOpen) return false;
      composer.restoreCompose();
      if (composer.draftId !== id || composer.accountId !== accountId) {
        toast.info(t("Save and close your current message before opening another draft."));
      }
      return true;
    };
    if (restoreExisting("id" in source ? source.id : undefined) || pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const draft = "id" in source
        ? await apiGet<DraftDetail>(`/drafts/${encodeURIComponent(source.id)}`)
        : await apiPost<DraftDetail>("/drafts/from-message", source);
      if (accountId !== useAuthStore.getState().activeAccountId) return;
      if (restoreExisting(draft.id)) return;
      useComposeStore.getState().openDraft({
        id: draft.id,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.html_body ?? draft.text_body,
        isHtml: draft.html_body !== null,
        inReplyTo: draft.in_reply_to,
        references: draft.references,
        attachments: draft.attachments.map((a) => ({
          id: a.id, filename: a.filename, contentType: a.content_type, size: a.size,
        })),
      });
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    } catch {
      if (accountId === useAuthStore.getState().activeAccountId) {
        toast.error(t("Could not open this draft. Please try again."));
      }
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };
  return { openDraft, isPending };
}
