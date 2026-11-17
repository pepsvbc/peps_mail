/**
 * Quoted history of replies and forwards.
 *
 * The quoted message is kept outside the rich-text editor: Tiptap would
 * re-parse it into its own schema (dropping styles, flattening nested quotes
 * and turning `<div><br></div>` runs into empty paragraphs). It is stored next
 * to the editor body and only joined with it, as plain strings, when a message
 * is sent or a draft is saved.
 */
import { parseEmailHtml } from "@/lib/email-html";
import {
  buildForwardBody,
  buildForwardQuoteHtml,
  buildReplyBody,
  buildReplyQuoteHtml,
  formatQuoteSender,
  plainTextToQuoteHtml,
} from "@/lib/email-utils";

export type QuoteKind = "reply" | "forward";

/** Class of the wrapper element that marks our quoted part inside a saved or sent body. */
export const QUOTE_CLASS = "peps_quote";
export const FORWARD_QUOTE_CLASS = "peps_forward";

export interface ComposeQuote {
  kind: QuoteKind;
  /** Inner HTML of the `.peps_quote` wrapper (attribution + quoted original). */
  html: string;
  /** Plain-text equivalent, appended to plain-text bodies and the text alternative. */
  text: string;
}

/** The quote-related part of the compose state. */
export interface ComposeQuoteState {
  quoteKind: QuoteKind | null;
  quotedHtml: string | null;
  quotedText: string | null;
}

interface OriginalMessage {
  /** Sanitized original HTML (see sanitizeQuotedHtml), or null for text-only messages. */
  html: string | null;
  text: string | null;
  fromAddress: string;
  fromName?: string | null;
  date: string;
}

/** Quoted part of a reply: "On {date}, {name} <{email}> wrote:" and the original in a cite blockquote. */
export function buildReplyQuote(original: OriginalMessage): ComposeQuote {
  const sender = formatQuoteSender(original.fromAddress, original.fromName);
  const html = original.html ?? plainTextToQuoteHtml(original.text);
  const text = original.text ?? htmlToPlainText(html);
  return {
    kind: "reply",
    html: buildReplyQuoteHtml(html, sender, original.date),
    text: buildReplyBody(text, sender, original.date),
  };
}

/** Forwarded part of a message: the forwarded-message header block and the original. */
export function buildForwardQuote(original: OriginalMessage & { subject: string; to: string }): ComposeQuote {
  const sender = formatQuoteSender(original.fromAddress, original.fromName);
  const html = original.html ?? plainTextToQuoteHtml(original.text);
  const text = original.text ?? htmlToPlainText(html);
  return {
    kind: "forward",
    html: buildForwardQuoteHtml(html, sender, original.date, original.subject, original.to),
    text: buildForwardBody(text, sender, original.date, original.subject, original.to),
  };
}

export function hasQuote(state: Partial<ComposeQuoteState>): boolean {
  return state.quotedHtml != null || state.quotedText != null;
}

/** The `.peps_quote` block appended after the editor HTML. */
export function wrapQuoteHtml(kind: QuoteKind | null, quotedHtml: string): string {
  const className = kind === "forward" ? `${QUOTE_CLASS} ${FORWARD_QUOTE_CLASS}` : QUOTE_CLASS;
  return `<div class="${className}">${quotedHtml}</div>`;
}

function editorHtmlToText(html: string): string {
  return parseEmailHtml(html).body?.textContent ?? "";
}

/**
 * Final message bodies: the editor content followed by the quoted part. The
 * quote's HTML is concatenated as a string so the original markup survives
 * exactly. `html` is null for plain-text messages.
 */
export function serializeComposeBody(
  state: { body: string; isHtml: boolean } & Partial<ComposeQuoteState>,
): { html: string | null; text: string } {
  const quotedText = state.quotedText ?? (state.quotedHtml != null ? htmlToPlainText(state.quotedHtml) : null);
  const ownText = state.isHtml ? editorHtmlToText(state.body) : state.body;
  const text = quotedText == null
    ? ownText
    : ownText.trim() ? `${ownText.trimEnd()}\n\n${quotedText}` : quotedText;
  if (!state.isHtml) return { html: null, text };
  const quotedHtml = state.quotedHtml ?? (quotedText != null ? plainTextToQuoteHtml(quotedText) : null);
  const html = quotedHtml == null ? state.body : state.body + wrapQuoteHtml(state.quoteKind ?? "reply", quotedHtml);
  return { html, text };
}

function isBlankNode(node: Node): boolean {
  if (node.nodeType === 3) return !(node.textContent ?? "").trim();
  return node.nodeType !== 1 && node.nodeType !== 3;
}

/**
 * Split a saved HTML draft back into the editor body and the quoted part: a
 * top-level `.peps_quote` element that ends the body. Drafts without it (or
 * with content after it) open unchanged.
 */
export function splitQuotedBody(html: string): { body: string; quote: ComposeQuote | null } {
  const unchanged = { body: html, quote: null };
  if (!html.includes(QUOTE_CLASS)) return unchanged;
  const doc = parseEmailHtml(html);
  const root = doc.body;
  if (!root) return unchanged;
  const children = Array.from(root.childNodes);
  let index = children.length - 1;
  while (index >= 0 && isBlankNode(children[index])) index--;
  const quote = children[index];
  if (!quote || quote.nodeType !== 1 || !(quote as Element).classList.contains(QUOTE_CLASS)) return unchanged;
  const quoteElement = quote as Element;
  const container = doc.createElement("div");
  container.append(...children.slice(0, index));
  const quotedHtml = quoteElement.innerHTML;
  return {
    body: container.innerHTML,
    quote: {
      kind: quoteElement.classList.contains(FORWARD_QUOTE_CLASS) ? "forward" : "reply",
      html: quotedHtml,
      text: htmlToPlainText(quotedHtml),
    },
  };
}

const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
  "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const SKIPPED_ELEMENTS = new Set(["head", "script", "style", "template", "title"]);

function cleanLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendNewline(out: string): string {
  return out && !out.endsWith("\n") ? `${out}\n` : out;
}

function nodeToText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += (child.textContent ?? "").replace(/\s+/g, " ");
      continue;
    }
    if (child.nodeType !== 1) continue;
    const name = (child as Element).localName;
    if (SKIPPED_ELEMENTS.has(name)) continue;
    if (name === "br") {
      out += "\n";
    } else if (name === "blockquote") {
      const inner = cleanLines(nodeToText(child));
      out = appendNewline(out) + inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") + "\n";
    } else if (BLOCK_ELEMENTS.has(name)) {
      out = appendNewline(appendNewline(out) + nodeToText(child));
    } else {
      out += nodeToText(child);
    }
  }
  return out;
}

/** Readable plain text from HTML: block elements become lines and blockquotes get "> " prefixes. */
export function htmlToPlainText(html: string): string {
  const doc = parseEmailHtml(html);
  return doc.body ? cleanLines(nodeToText(doc.body)) : "";
}
