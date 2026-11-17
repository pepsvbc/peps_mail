import { translate as t, getLocale } from "@/lib/i18n";

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

/**
 * Build a quoted reply body from the original message text.
 */
export function buildReplyBody(
  text: string | null,
  from: string,
  date: string,
): string {
  const formattedDate = formatQuoteDate(date);
  const header = `\n${t("On {date}, {sender} wrote:", { date: formattedDate, sender: from })}\n`;
  const quoted = quoteText(text ?? "");
  return `\n${header}${quoted}`;
}

/**
 * Build a forwarded message body with a preamble.
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
    "",
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

/**
 * Build a quoted reply body in HTML from the original HTML content.
 */
export function buildReplyBodyHtml(
  html: string,
  from: string,
  date: string,
): string {
  const formattedDate = formatQuoteDate(date);
  return [
    '<p><br></p>',
    `<p>${t("On {date}, {sender} wrote:", { date: formattedDate, sender: from })}</p>`,
    `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${html}</blockquote>`,
  ].join("");
}

/**
 * Build a forwarded message body in HTML from the original HTML content.
 */
export function buildForwardBodyHtml(
  html: string,
  from: string,
  date: string,
  subject: string,
  to: string,
): string {
  const formattedDate = formatQuoteDate(date);
  return [
    '<p><br></p>',
    `<p>${t("---------- Forwarded message ----------")}</p>`,
    `<p>${t("From: {sender}", { sender: from })}<br>`,
    `${t("Date: {date}", { date: formattedDate })}<br>`,
    `${t("Subject: {subject}", { subject })}<br>`,
    `${t("To: {recipient}", { recipient: to })}</p>`,
    '<hr>',
    html,
  ].join("");
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
