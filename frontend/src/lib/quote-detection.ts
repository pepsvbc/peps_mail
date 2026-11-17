/**
 * Detect the quoted history at the end of a received message so the reading
 * pane can collapse it behind a "•••" toggle, like Gmail.
 *
 * Everything works by walking the inert DOMParser document (or by scanning
 * lines for plain text). Regexes only ever run on short, bounded strings so
 * crafted messages cannot trigger catastrophic backtracking, and every DOM
 * check stops at the first visible content it finds.
 */

/**
 * Elements that start quoted history, by mail client. `querySelectorAll`
 * returns them in document order, so outer (earlier) quotes are tried first.
 *  - ours: `.peps_quote`
 *  - Gmail: `.gmail_quote_container`, `.gmail_quote`
 *  - Yahoo: `.yahoo_quoted`
 *  - Outlook on the web: `#appendonsend`, `#divRplyFwdMsg`; other Outlooks: `<hr>` + "From:" block
 *  - Apple Mail / Thunderbird: `blockquote[type=cite]`
 *  - anything else (e.g. replies sent by older versions of this app): a plain
 *    `<blockquote>` right after an "On … wrote:" line
 */
const QUOTE_SELECTOR = [
  ".peps_quote",
  ".gmail_quote_container",
  ".gmail_quote",
  ".yahoo_quoted",
  "#appendonsend",
  "#divRplyFwdMsg",
  "blockquote",
  "hr",
].join(", ");

/** Outlook-style markers: the quote is the marker and everything after it in the same parent. */
const RANGE_MARKERS = new Set(["appendonsend", "divrplyfwdmsg"]);

/** Bounds the work on messages with many candidate elements. */
const MAX_CANDIDATES = 40;
const MAX_ATTRIBUTION_LENGTH = 400;

const MEDIA_ELEMENTS = new Set(["img", "video", "picture", "svg", "canvas"]);
const IGNORED_ELEMENTS = new Set(["br", "style", "script", "meta", "link", "title", "template", "head"]);

/** Attribution lines written by common clients and languages. Only tested on short strings. */
const ATTRIBUTION_RE = /(?:wrote|a écrit|schrieb|escribió|ha scritto|schreef|escreveu)\s?:$/i;
const HEADER_LINE_RE = /^(?:From|De|Von|Da|Van|Från)\s?:/i;
const FORWARD_RE = /^(?:-{2,}\s?(?:Forwarded message|Message transféré|Weitergeleitete Nachricht|Mensaje reenviado|Messaggio inoltrato|Doorgestuurd bericht)|Begin forwarded message|Début du message (?:réexpédié|transféré)|Anfang der weitergeleiteten)/i;

const SHOW_ELEMENT_AND_TEXT = 0x1 | 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/** Walk the text and elements under `node`, skipping styles and scripts. Stops when `visit` returns true. */
function walk(node: Node, visit: (node: Node) => boolean): boolean {
  if (node.nodeType === 3) return visit(node);
  if (!isElement(node) || IGNORED_ELEMENTS.has(node.localName)) return false;
  if (visit(node)) return true;
  const walker = node.ownerDocument.createTreeWalker(node, SHOW_ELEMENT_AND_TEXT, {
    acceptNode: (child) => isElement(child) && IGNORED_ELEMENTS.has(child.localName) ? FILTER_REJECT : FILTER_ACCEPT,
  });
  for (let child = walker.nextNode(); child; child = walker.nextNode()) {
    if (visit(child)) return true;
  }
  return false;
}

/** The first `length` characters of a node's visible text, without reading all of it. */
function textHead(node: Node, length = 200): string {
  let out = "";
  walk(node, (child) => {
    if (child.nodeType === 3) out += child.textContent ?? "";
    else if (isElement(child) && (child.localName === "div" || child.localName === "p") && out) out += "\n";
    return out.length >= length;
  });
  return out.slice(0, length).trim();
}

/** Nothing a reader would miss: whitespace, comments, line breaks, empty wrappers. */
function isBlank(node: Node): boolean {
  if (node.nodeType !== 1 && node.nodeType !== 3) return true;
  return !walk(node, (child) => child.nodeType === 3
    ? /\S/.test(child.textContent ?? "")
    : MEDIA_ELEMENTS.has((child as Element).localName));
}

function isAttribution(node: Node): boolean {
  if (isElement(node) && (node.classList.contains("moz-cite-prefix") || node.classList.contains("gmail_attr"))) return true;
  const text = textHead(node, MAX_ATTRIBUTION_LENGTH + 1);
  return text.length > 0 && text.length <= MAX_ATTRIBUTION_LENGTH && ATTRIBUTION_RE.test(text);
}

function isRule(node: Node): boolean {
  return isElement(node) && (node.localName === "hr" || node.id.toLowerCase() === "appendonsend");
}

/** The last text or media node a reader would see, searched backwards from the end. */
function lastVisibleNode(node: Node): Node | null {
  for (let child = node.lastChild; child; child = child.previousSibling) {
    if (child.nodeType === 3) {
      if (/\S/.test(child.textContent ?? "")) return child;
    } else if (isElement(child) && !IGNORED_ELEMENTS.has(child.localName)) {
      if (MEDIA_ELEMENTS.has(child.localName)) return child;
      const found = lastVisibleNode(child);
      if (found) return found;
    }
  }
  return null;
}

function hasContentBefore(node: Node, root: Node): boolean {
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (!isBlank(sibling)) return true;
    }
  }
  return false;
}

/** Include the attribution line ("On … wrote:"), an Outlook rule and blank lines just before the quote. */
function extendStart(start: Node): { first: Node; attributed: boolean } {
  let first = start;
  let attributed = false;
  for (let sibling = start.previousSibling; sibling; sibling = sibling.previousSibling) {
    if (isBlank(sibling) || isRule(sibling)) {
      first = sibling;
    } else if (!attributed && isAttribution(sibling)) {
      first = sibling;
      attributed = true;
    } else {
      break;
    }
  }
  return { first, attributed };
}

/** A blockquote no mail client marked as quoted history (it may just quote a passage). */
function isPlainBlockquote(element: Element): boolean {
  return element.localName === "blockquote"
    && element.getAttribute("type")?.toLowerCase() !== "cite"
    && !element.classList.contains("gmail_quote");
}

/** The nodes making up the quote: `start` and every following sibling. */
function rangeFrom(start: Node): Node[] {
  const nodes: Node[] = [];
  for (let node: Node | null = start; node; node = node.nextSibling) nodes.push(node);
  return nodes;
}

function isForward(nodes: Node[]): boolean {
  for (const node of nodes) {
    if (isBlank(node) || isRule(node)) continue;
    if (isElement(node) && node.classList.contains("peps_forward")) return true;
    return FORWARD_RE.test(textHead(node));
  }
  return false;
}

/** Outlook markers (and an <hr> before a "From:" header) start a quote made of all following siblings. */
function isRangeCandidate(element: Element): boolean {
  if (RANGE_MARKERS.has(element.id.toLowerCase())) return true;
  if (element.localName !== "hr") return false;
  let next = element.nextSibling;
  while (next && isBlank(next)) next = next.nextSibling;
  return !!next && HEADER_LINE_RE.test(textHead(next, 40));
}

const DOCUMENT_POSITION_FOLLOWING = 4;

/**
 * Whether the quote starting at `candidate` holds the last visible content of
 * the message, i.e. nothing a reader would see comes after it. O(depth).
 */
function endsMessage(candidate: Element, last: Node): boolean {
  if (candidate.contains(last)) return true;
  const rangeMarker = candidate.localName === "hr" || RANGE_MARKERS.has(candidate.id.toLowerCase());
  return rangeMarker
    && !!candidate.parentNode?.contains(last)
    && (candidate.compareDocumentPosition(last) & DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Find the quoted history that ends a message body. Returns the nodes to hide
 * (siblings, in order), or null when there is none, when it is not the
 * trailing content, when it is a forwarded message, or when hiding it would
 * leave nothing visible.
 */
export function findTrailingQuote(doc: Document): Node[] | null {
  const root = doc.body;
  const last = root && lastVisibleNode(root);
  if (!root || !last) return null;
  const rejected: Element[] = [];
  let checked = 0;
  for (const candidate of Array.from(root.querySelectorAll(QUOTE_SELECTOR))) {
    if (!endsMessage(candidate, last)) continue;
    if (rejected.some((outer) => outer.contains(candidate))) continue;
    const range = isRangeCandidate(candidate);
    if (candidate.localName === "hr" && !range) continue;
    if (checked++ >= MAX_CANDIDATES) break;
    // Element quotes must contain the end of the message; range quotes run to the end of their parent.
    if (!range && !candidate.contains(last)) continue;
    const { first, attributed } = extendStart(candidate);
    // Plain blockquotes only count as history when an attribution line introduces them.
    if (isPlainBlockquote(candidate) && !attributed) continue;
    const nodes = rangeFrom(first);
    const quoteParts = nodes.slice(nodes.indexOf(candidate));
    if (hasContentBefore(nodes[0], root) && !isForward(quoteParts)) return nodes;
    rejected.push(candidate);
  }
  return null;
}

/** Remove the trailing quote from the document. Returns true when one was found. */
export function removeTrailingQuote(doc: Document): boolean {
  const nodes = findTrailingQuote(doc);
  nodes?.forEach((node) => node.parentNode?.removeChild(node));
  return !!nodes;
}

const TEXT_ATTRIBUTION_RE = /^(?:On\s.+\swrote|Le\s.+\sa écrit|Am\s.+\sschrieb|El\s.+\sescribió|Il\s.+\sha scritto)\s?:$/i;
const TEXT_ORIGINAL_RE = /^-{2,}\s?(?:Original Message|Message d'origine|Message d’origine|Ursprüngliche Nachricht|Mensaje original)\s?-{2,}$/i;

function isTextAttribution(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ATTRIBUTION_LENGTH && TEXT_ATTRIBUTION_RE.test(trimmed);
}

function isForwardLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && FORWARD_RE.test(trimmed);
}

/** Gmail/Apple style: an attribution line followed only by "> " lines at the end. */
function findCitedBlock(lines: string[]): number | null {
  let index = lines.length - 1;
  let quoted = 0;
  while (index >= 0 && (lines[index].startsWith(">") || !lines[index].trim())) {
    if (lines[index].startsWith(">")) quoted++;
    index--;
  }
  if (quoted === 0 || index < 0) return null;
  if (isTextAttribution(lines[index])) return index;
  // Attribution lines are often wrapped before the address or "wrote:".
  if (index > 0 && isTextAttribution(`${lines[index - 1].trim()} ${lines[index].trim()}`)) return index - 1;
  return null;
}

/**
 * Find the line where trailing quoted history starts in a plain-text message:
 * an attribution line ("On … wrote:", "Le … a écrit :", possibly wrapped over
 * two lines) followed only by "> " lines, or an Outlook "-----Original
 * Message-----" separator. Returns null when there is no such block, when
 * nothing would remain visible above it, or when the message is a forward.
 */
export function findPlainTextQuote(text: string): number | null {
  const lines = text.split(/\r?\n/);
  let start = findCitedBlock(lines);
  // Outlook style: the separator line, then headers and the unquoted original.
  const limit = start ?? lines.length;
  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim();
    if (line.length <= 80 && TEXT_ORIGINAL_RE.test(line)) {
      start = i;
      break;
    }
  }
  if (start === null) return null;
  let visible = false;
  for (let i = 0; i < start; i++) {
    if (isForwardLine(lines[i])) return null;
    if (lines[i].trim()) visible = true;
  }
  return visible ? start : null;
}
