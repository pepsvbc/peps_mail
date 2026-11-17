import { translate as t, getLocale } from "@/lib/i18n";
import { escapeHtml } from "@/lib/email-html";

/**
 * Email utility functions for reply, reply-all, and forward.
 */

/**
 * Extract a header value from raw email headers.
 * Returns the first match or null.
 */
export function extractHeader(
  rawHeaders: string,
  name: string,
): string | null {
  // Headers can be folded (continued on next line with leading whitespace).
  // Unfold first, then search.
  const unfolded = rawHeaders.replace(/\r?\n(?=[ \t])/g, " ");
  const regex = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const match = unfolded.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Prepend "Re: " to a subject if not already present.
 */
export function buildReplySubject(subject: string): string {
  if (/^re:\s/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

/**
 * Prepend "Fwd: " to a subject if not already present.
 */
export function buildForwardSubject(subject: string): string {
  if (/^fwd?:\s/i.test(subject)) return subject;
  return `Fwd: ${subject}`;
}

/** "Name <email>" when the sender has a display name, otherwise just the address. */
export function formatQuoteSender(address: string, name?: string | null): string {
  const displayName = name?.trim();
  return displayName && displayName.toLowerCase() !== address.toLowerCase()
    ? `${displayName} <${address}>`
    : address;
}

/** The "On {date}, {sender} wrote:" line above a quoted reply (plain text, unescaped). */
export function buildReplyAttribution(from: string, date: string): string {
  return t("On {date}, {sender} wrote:", { date: formatQuoteDate(date), sender: from });
}

/**
 * Build the quoted part of a plain-text reply: the attribution line followed by
 * the original text with every line prefixed by "> ".
 */
export function buildReplyBody(
  text: string | null,
  from: string,
  date: string,
): string {
  return `${buildReplyAttribution(from, date)}\n${quoteText(text ?? "")}`;
}

/**
 * Build the forwarded part of a plain-text message: a header block and the original text.
 */
export function buildForwardBody(
  text: string | null,
  from: string,
  date: string,
  subject: string,
  to: string,
): string {
  const formattedDate = formatQuoteDate(date);
  const lines = [
    t("---------- Forwarded message ----------"),
    t("From: {sender}", { sender: from }),
    t("Date: {date}", { date: formattedDate }),
    t("Subject: {subject}", { subject }),
    t("To: {recipient}", { recipient: to }),
    "",
    text ?? "",
  ];
  return lines.join("\n");
}

/**
 * Build the References header for a reply.
 * Appends the current message's Message-ID to the existing References.
 */
export function buildReferences(
  existingReferences: string | null,
  messageId: string | null,
): string | null {
  if (!messageId) return existingReferences;
  if (!existingReferences) return messageId;
  return `${existingReferences} ${messageId}`;
}

/** Inline style of the reply quote, so the left border survives in every mail client. */
export const QUOTE_BLOCKQUOTE_STYLE = "margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex";

/**
 * Build the content of a reply's quoted part in HTML: the attribution line and
 * the original message in a cite blockquote. The result goes inside the
 * `.peps_quote` wrapper (see lib/compose-quote.ts), never into the editor.
 * `html` must already be sanitized (see sanitizeQuotedHtml); header fields are escaped here.
 */
export function buildReplyQuoteHtml(
  html: string,
  from: string,
  date: string,
): string {
  return [
    `<div class="peps_quote_attr">${escapeHtml(buildReplyAttribution(from, date))}</div>`,
    `<blockquote type="cite" style="${QUOTE_BLOCKQUOTE_STYLE}">${html}</blockquote>`,
  ].join("");
}

/**
 * Build the content of a forward's quoted part in HTML: the forwarded-message
 * header block, a rule and the original message.
 * `html` must already be sanitized (see sanitizeQuotedHtml); header fields are escaped here.
 */
export function buildForwardQuoteHtml(
  html: string,
  from: string,
  date: string,
  subject: string,
  to: string,
): string {
  const formattedDate = formatQuoteDate(date);
  const header = [
    t("---------- Forwarded message ----------"),
    t("From: {sender}", { sender: from }),
    t("Date: {date}", { date: formattedDate }),
    t("Subject: {subject}", { subject }),
    t("To: {recipient}", { recipient: to }),
  ].map(escapeHtml).join("<br>");
  return `<div class="peps_forward_header">${header}</div><hr>${html}`;
}

/** Turn an original plain-text message into HTML for the quoted part (escaped, line breaks kept). */
export function plainTextToQuoteHtml(text: string | null): string {
  return (text ?? "").split(/\r?\n/).map(escapeHtml).join("<br>");
}

// --- Internal helpers ---

function quoteText(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatQuoteDate(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString(getLocale(), {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
