"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiGetBlob, apiPost, apiPostFormData } from "@/lib/api";
import { useUiStore } from "@/stores/useUiStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { replaceSignatureInBody, useComposeStore, type ComposeAttachment } from "@/stores/useComposeStore";
import { generateId, stripHtml } from "@/components/mail/ComposeDialog/utils";
import type { Identity } from "@/types/identity";

/** Move the editing copy before switching accounts; a failed copy leaves the composer intact. */
export function useComposeAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (targetAccountId: string) => {
      const source = useComposeStore.getState();
      const auth = useAuthStore.getState();
      const sourceAccountId = source.accountId ?? auth.activeAccountId;
      const targetAccount = auth.accounts.find((a) => a.id === targetAccountId);
      if (!targetAccount || !sourceAccountId || sourceAccountId !== auth.activeAccountId) throw new Error("Account unavailable");
      if (targetAccountId === sourceAccountId) return;
      const targetDraftId = generateId();
      const options = { accountId: targetAccountId };
      let created = false;
      try {
        const { identities } = await apiGet<{ identities: Identity[] }>("/identities", options);
        const identity = identities.find((i) => i.email.toLowerCase() === targetAccount.email.toLowerCase())
          ?? identities.find((i) => i.is_default) ?? identities[0];
        const signature = identity?.signature_html ?? "";
        let body = source.isHtml && source.signatureEnabled
          ? replaceSignatureInBody(source.body, signature) : source.body;
        const attachments: ComposeAttachment[] = [];
        for (const attachment of source.attachments) {
          if (!source.draftId) throw new Error("Attachment draft unavailable");
          const blob = await apiGetBlob(`/drafts/${source.draftId}/attachments/${attachment.id}/content`, sourceAccountId);
          const form = new FormData();
          form.append("file", new File([blob], attachment.filename, { type: attachment.contentType }));
          created = true;
          const uploaded = await apiPostFormData<{ attachments: { id: string; filename: string; content_type: string; size: number }[] }>(
            `/drafts/${targetDraftId}/attachments`, form, options,
          );
          const copy = uploaded.attachments[0];
          if (!copy) throw new Error("Attachment copy failed");
          attachments.push({ id: copy.id, filename: copy.filename, contentType: copy.content_type, size: copy.size });
          body = body.replaceAll(`/api/drafts/${source.draftId}/attachments/${attachment.id}/content`, `/api/drafts/${targetDraftId}/attachments/${copy.id}/content`);
        }
        const hasContent = !!(source.to.trim() || source.cc.trim() || source.bcc.trim() || source.subject.trim() || (source.isHtml ? stripHtml(body) : body).trim() || attachments.length);
        if (hasContent) {
          created = true;
          await apiPost("/drafts", {
            id: targetDraftId, to: source.to, cc: source.cc, bcc: source.bcc, subject: source.subject,
            text_body: source.isHtml ? stripHtml(body) : body, html_body: source.isHtml ? body : null,
            in_reply_to: source.inReplyTo, references: source.references,
          }, options);
        }
        await queryClient.cancelQueries({ predicate: (q) => q.queryKey[0] !== "account-unread" });
        // The mailbox may have been switched elsewhere while files were copying.
        const current = useComposeStore.getState();
        if (useAuthStore.getState().activeAccountId !== sourceAccountId || !current.isOpen || current.draftId !== source.draftId) {
          throw new Error("The active draft changed");
        }
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "account-unread" });
        queryClient.setQueryData(["identities"], identities);
        useComposeStore.setState({
          accountId: targetAccountId, draftId: hasContent ? targetDraftId : null, attachments, body,
          fromIdentityId: identity?.id ?? null, signatureHtml: signature,
        });
        useAuthStore.getState().setActiveAccount(targetAccountId);
        useUiStore.getState().setActiveFolder("INBOX");
      } catch (error) {
        if (created) await apiDelete(`/drafts/${targetDraftId}`, options).catch(() => {});
        throw error;
      }
      // The editing copy is safely stored in the destination account now.
      if (source.draftId) await apiDelete(`/drafts/${source.draftId}`, { accountId: sourceAccountId }).catch(() => {});
    },
  });
}
