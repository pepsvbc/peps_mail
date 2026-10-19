"use client";

import { useTranslation } from "@/lib/i18n";
import { formatRecipient } from "@/lib/recipients";
import { Reply, ReplyAll, Forward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/stores/useUiStore";
import { useMessage } from "@/hooks/useMessages";
import { composeMessageKey } from "@/stores/useInlineComposeHost";
import { useComposeStore } from "@/stores/useComposeStore";
import { useAuthStore } from "@/stores/useAuthStore";
import {
  extractHeader,
  buildReplySubject,
  buildForwardSubject,
  buildReplyBody,
  buildForwardBody,
  buildReplyBodyHtml,
  buildForwardBodyHtml,
  buildReferences,
} from "@/lib/email-utils";
import type { EmailAddress } from "@/types/message";
import { useIdentities } from "@/hooks/useIdentities";
import type { Identity } from "@/types/identity";

/** Find the identity whose email matches one of the To/CC addresses. */
function findMatchingIdentity(
  identities: Identity[] | undefined,
  toAddresses: EmailAddress[],
  ccAddresses: EmailAddress[],
): number | null {
  if (!identities || identities.length === 0) return null;
  const allRecipientEmails = [...toAddresses, ...ccAddresses].map((a) =>
    a.address.toLowerCase(),
  );
  const match = identities.find((i) =>
    allRecipientEmails.includes(i.email.toLowerCase()),
  );
  return match?.id ?? null;
}

function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .map((a) => formatRecipient(a.address, a.name))
    .join(", ");
}

export function MessageReplyActions({ labeled = false }: { labeled?: boolean }) {
  const { t } = useTranslation();
  const activeFolder = useUiStore((s) => s.activeFolder);
  const selectedMessageUid = useUiStore((s) => s.selectedMessageUid);
  const { data } = useMessage(activeFolder, selectedMessageUid ?? 0);
  const { data: identities } = useIdentities();
  // Reply All is redundant for 1-to-1 conversations (no other recipients besides sender + me)
  const isDirectConversation = (() => {
    if (!data) return false;
    const myEmail = useAuthStore.getState().activeAccount()?.email ?? "";
    const otherRecipients = [...data.to_addresses, ...data.cc_addresses].filter(
      (a) =>
        a.address.toLowerCase() !== myEmail.toLowerCase() &&
        a.address.toLowerCase() !== data.from_address.toLowerCase(),
    );
    return otherRecipients.length === 0;
  })();

  const handleReply = () => {
    if (!data) return;
    const messageId = extractHeader(data.raw_headers, "Message-ID");
    const refs = extractHeader(data.raw_headers, "References");
    const matchedId = findMatchingIdentity(identities, data.to_addresses, data.cc_addresses);
    const hasHtml = !!(data.html && data.html.trim());
    useComposeStore.getState().openReply({
      to: data.from_address,
      cc: "",
      sourceMessageKey: composeMessageKey(useAuthStore.getState().activeAccountId, activeFolder, selectedMessageUid),
      subject: buildReplySubject(data.subject),
      body: hasHtml
        ? buildReplyBodyHtml(data.html!, data.from_address, data.date)
        : buildReplyBody(data.text, data.from_address, data.date),
      inReplyTo: messageId,
      references: buildReferences(refs, messageId),
      fromIdentityId: matchedId,
      isHtml: hasHtml,
    });
  };

  const handleReplyAll = () => {
    if (!data) return;
    const myEmail = useAuthStore.getState().activeAccount()?.email ?? "";
    const messageId = extractHeader(data.raw_headers, "Message-ID");
    const refs = extractHeader(data.raw_headers, "References");
    const replyTo = data.from_address;
    const allRecipients = [
      ...data.to_addresses,
      ...data.cc_addresses,
    ].filter(
      (a) =>
        a.address.toLowerCase() !== myEmail.toLowerCase() &&
        a.address.toLowerCase() !== data.from_address.toLowerCase(),
    );
    const ccList = allRecipients.map((a) => a.address).join(", ");
    const matchedId = findMatchingIdentity(identities, data.to_addresses, data.cc_addresses);
    const hasHtml = !!(data.html && data.html.trim());
    useComposeStore.getState().openReply({
      to: replyTo,
      cc: ccList,
      sourceMessageKey: composeMessageKey(useAuthStore.getState().activeAccountId, activeFolder, selectedMessageUid),
      subject: buildReplySubject(data.subject),
      body: hasHtml
        ? buildReplyBodyHtml(data.html!, data.from_address, data.date)
        : buildReplyBody(data.text, data.from_address, data.date),
      inReplyTo: messageId,
      references: buildReferences(refs, messageId),
      fromIdentityId: matchedId,
      isHtml: hasHtml,
    });
  };

  const handleForward = () => {
    if (!data) return;
    const toList = formatAddressList(data.to_addresses);
    const hasHtml = !!(data.html && data.html.trim());
    useComposeStore.getState().openForward({
      sourceMessageKey: composeMessageKey(useAuthStore.getState().activeAccountId, activeFolder, selectedMessageUid),
      subject: buildForwardSubject(data.subject),
      body: hasHtml
        ? buildForwardBodyHtml(data.html!, data.from_address, data.date, data.subject, toList)
        : buildForwardBody(data.text, data.from_address, data.date, data.subject, toList),
      isHtml: hasHtml,
    });
  };

  const actions = [
    { label: t("Reply"), Icon: Reply, onClick: handleReply, disabled: !data, hidden: false },
    { label: t("Reply all"), Icon: ReplyAll, onClick: handleReplyAll, disabled: !data || isDirectConversation, hidden: labeled && isDirectConversation },
    { label: t("Forward"), Icon: Forward, onClick: handleForward, disabled: !data, hidden: false },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {actions.filter((action) => !action.hidden).map(({ label, Icon, onClick, disabled }) => (
        <Button
          key={label}
          variant={labeled ? "outline" : "ghost"}
          size={labeled ? "sm" : "icon"}
          className={labeled ? "gap-2 rounded-full px-4" : "size-8 shrink-0"}
          disabled={disabled}
          title={label}
          onClick={onClick}
        >
          <Icon className="size-4" />
          <span className={labeled ? undefined : "sr-only"}>{label}</span>
        </Button>
      ))}
    </div>
  );
}
