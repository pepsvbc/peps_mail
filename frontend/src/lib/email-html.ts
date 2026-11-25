/**
 * DOM-based helpers for untrusted email HTML.
 *
 * Everything here works on a document from `DOMParser`, which is inert: no
 * scripts run and no resources load while it is parsed or modified. Avoid
 * regexes over raw HTML — they are easy to bypass and several of the obvious
 * ones backtrack catastrophically on crafted input.
 *
 * Untrusted HTML first goes through DOMPurify (allowlist of elements and
 * attributes, protection against mutation XSS when the result is re-parsed),
 * then through the email-specific rules below (links, forms, remote content).
 */

import DOMPurify, { type DOMPurify as DOMPurifyInstance } from "dompurify";

export const XHTML_NS = "http://www.w3.org/1999/xhtml";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/**
 * Elements that are never rendered from an email (the iframe sandbox blocks most of them already).
 * `template` is listed because `querySelectorAll` never looks inside template contents, and a
 * `<template shadowrootmode>` becomes a live, unsanitized shadow root when the HTML is parsed again.
 */
const FORBIDDEN_ELEMENTS = "script, iframe, frame, frameset, object, embed, applet, base, meta, portal, template, noscript";

/** Attributes that make the browser fetch something. href on links is handled separately. */
const RESOURCE_ATTRIBUTES = new Set(["src", "srcset", "lowsrc", "dynsrc", "background", "poster", "href", "xlink:href"]);

/** Attributes whose value is CSS that can reference URLs (inline styles and SVG presentation attributes). */
const CSS_URL_ATTRIBUTES = new Set([
  "style", "fill", "stroke", "filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end", "cursor",
]);

/** Replacement for URLs that must not load: never fetched and blocked by the iframe CSP anyway. */
const BLOCKED_URL = "about:invalid";

/** Parse untrusted HTML into an inert document. */
export function parseEmailHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

let purifier: DOMPurifyInstance | null = null;

/** A DOMPurify instance of our own, so its hook does not affect other users of the library. */
function getPurifier(): DOMPurifyInstance {
  if (purifier) return purifier;
  if (typeof window === "undefined") throw new Error("Email HTML can only be sanitized in the browser");
  const instance = DOMPurify(window);
  // DOMPurify returns its input unchanged when it cannot run; never let that through.
  if (!instance.isSupported) throw new Error("HTML sanitizer is not supported in this browser");
  // Many emails wrap their CSS in <!-- --> (CDO/CDC tokens, ignored by CSS); DOMPurify drops
  // <style> elements whose text looks like markup, so remove those tokens first.
  instance.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && (node as Element).namespaceURI === XHTML_NS) {
      const css = node.textContent ?? "";
      const cleaned = css.replace(/<!--|-->/g, "");
      if (cleaned !== css) node.textContent = cleaned;
    }
  });
  purifier = instance;
  return instance;
}

let lastPurified: { html: string; result: string } | null = null;

/**
 * First sanitization layer: DOMPurify over the whole document (the email's
 * <head> styles are kept). The email rules below are applied afterwards.
 */
export function purifyEmailHtml(html: string): string {
  // The reading pane checks for remote content and renders the same message.
  if (lastPurified?.html === html) return lastPurified.result;
  const result = getPurifier().sanitize(html, {
    WHOLE_DOCUMENT: true,
    // Remote stylesheets cannot be checked for URLs, so <link> stays out (DOMPurify drops it by default).
    FORBID_TAGS: ["template", "noscript", "link", "base", "meta", "form"],
    FORBID_ATTR: ["shadowroot", "shadowrootmode", "shadowrootdelegatesfocus", "shadowrootclonable", "shadowrootserializable"],
    KEEP_CONTENT: true,
    // DOMPurify's default URI allowlist, plus blob: for inline images.
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
  lastPurified = { html, result };
  return result;
}

/** Parse untrusted email HTML and apply every sanitization layer (DOMPurify, then the email rules). */
export function parseSanitizedEmailHtml(html: string): Document {
  const doc = parseEmailHtml(purifyEmailHtml(html));
  sanitizeEmailDocument(doc);
  return doc;
}

/** Browsers ignore whitespace and control characters around (and tabs/newlines inside) URL schemes. */
function normalizeUrl(value: string): string {
  return value.replace(/[\u0000- ]+/g, "").toLowerCase();
}

/** http(s) and protocol-relative URLs, i.e. anything fetched from a remote server. */
export function isRemoteUrl(value: string): boolean {
  return /^(?:https?:|[\\/]{2})/.test(normalizeUrl(value));
}

/** Image sources that never leave the client (inline cid: parts are served as data: URIs). */
function isEmbeddedUrl(value: string): boolean {
  return /^(?:data|cid|blob):/.test(normalizeUrl(value));
}

/** Link targets that may be opened from an email: absolute http(s) URLs and mailto:. */
export function isSafeLinkHref(value: string): boolean {
  return /^(?:https?:[\\/]{2}|mailto:)/.test(normalizeUrl(value));
}

/**
 * Whether an email may load a resource from this URL. Fragment references
 * (`url(#gradient)`) and embedded data:/cid:/blob: URLs always may. Remote URLs
 * may only when remote content is allowed, and only if they point to another
 * site: email HTML is rendered in the app's origin, so a relative URL or one on
 * the app's own origin would make the browser send authenticated requests to
 * the API.
 */
export function isAllowedResourceUrl(value: string, allowRemote: boolean): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#") || isEmbeddedUrl(trimmed)) return true;
  if (!allowRemote) return false;
  const base = typeof window === "undefined" ? null : window.location;
  if (!base) return /^https?:[\\/]{2}/.test(normalizeUrl(trimmed));
  let url: URL;
  try {
    url = new URL(trimmed, base.href);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== base.origin;
}

/** The URLs of a srcset attribute (candidates are "url [descriptor]" separated by commas). */
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !/\s/.test(value[i])) i++;
    const url = value.slice(start, i);
    if (url.endsWith(",")) {
      urls.push(url.replace(/,+$/, ""));
      continue;
    }
    urls.push(url);
    while (i < value.length && value[i] !== ",") i++;
  }
  return urls;
}

/** Accept only plain colour values so an email's colour can be embedded in our own CSS. */
export function isSafeCssColor(value: string): boolean {
  const color = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(color)
    || /^(?:rgba?|hsla?)\([\d\s.,%/+a-z-]*\)$/i.test(color)
    || /^[a-z]+$/i.test(color);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Decode CSS escapes (`\68 ttp`, `\/`) so obfuscated URLs are still recognised. */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (_match, hex: string | undefined, char: string | undefined) => {
    if (!hex) return char ?? "";
    const codePoint = parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "�";
  });
}

/** True if CSS references a remote URL via url(), image-set(), @import or a quoted string. */
export function cssHasRemoteUrl(css: string): boolean {
  return /(?:url\(|['"])\s*(?:https?:|[\\/]{2})/i.test(decodeCssEscapes(css));
}

/** Rewrite CSS text so it cannot terminate the <style> element it is serialized into. */
export function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

const isCssWhitespace = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
const isCssNewline = (char: string | undefined) => char === "\n" || char === "\r" || char === "\f";

/** A CSS escape starts here: a backslash not followed by a newline. */
function isCssEscape(css: string, i: number): boolean {
  return css[i] === "\\" && i + 1 < css.length && !isCssNewline(css[i + 1]);
}

function isIdentChar(css: string, i: number): boolean {
  const char = css[i];
  return char !== undefined && (/[\w-]/.test(char) || char.charCodeAt(0) > 0x7f || isCssEscape(css, i));
}

/** Index after an escape starting at `i` (a backslash). */
function skipCssEscape(css: string, i: number): number {
  let j = i + 1;
  const hex = /^[0-9a-f]{1,6}/i.exec(css.slice(j, j + 6));
  if (!hex) return j + 1;
  j += hex[0].length;
  if (css[j] === "\r" && css[j + 1] === "\n") return j + 2;
  return isCssWhitespace(css[j]) ? j + 1 : j;
}

/** Index after an identifier starting at `i`. */
function skipIdent(css: string, i: number): number {
  let j = i;
  while (j < css.length && isIdentChar(css, j)) j = css[j] === "\\" ? skipCssEscape(css, j) : j + 1;
  return j;
}

/** Index after a quoted string starting at `i` (an unterminated string ends before the newline). */
function skipCssString(css: string, i: number): number {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length) {
    const char = css[j];
    if (char === quote) return j + 1;
    if (isCssNewline(char)) return j;
    j += char === "\\" ? 2 : 1;
  }
  return j;
}

/** Index after an unquoted url( token whose content starts at `i`. */
function skipUrlToken(css: string, i: number): number {
  let j = i;
  while (j < css.length && css[j] !== ")") j += css[j] === "\\" ? 2 : 1;
  return Math.min(j + 1, css.length);
}

/**
 * Replace URLs in CSS that `isAllowed` rejects with about:invalid, which is
 * never fetched. Covers url() (also escaped, e.g. `u\72l(`), src(), the
 * strings of image-set() and every @import, which is always blocked: an
 * imported stylesheet could load anything without being checked.
 *
 * A small tokenizer following the CSS Syntax rules for comments, strings,
 * escapes and url tokens, so URLs are found where the browser finds them.
 */
export function filterCssUrls(css: string, isAllowed: (url: string) => boolean): string {
  let out = "";
  let i = 0;
  // Enclosing functions: URL strings appear directly inside url()/src() and image-set().
  const functions: ("url" | "image-set" | "other")[] = [];
  let inImport = false;

  while (i < css.length) {
    const char = css[i];

    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = skipCssString(css, i);
      const raw = css.slice(i, end);
      const current = functions[functions.length - 1];
      const isUrl = (inImport && functions.length === 0) || current === "url" || current === "image-set";
      if (isUrl) {
        const inner = raw.length > 1 && raw.endsWith(char) ? raw.slice(1, -1) : raw.slice(1);
        out += inImport || !isAllowed(decodeCssEscapes(inner)) ? `${char}${BLOCKED_URL}${char}` : raw;
      } else {
        out += raw;
      }
      i = end;
      continue;
    }

    if (char === "@" && isIdentChar(css, i + 1)) {
      const end = skipIdent(css, i + 1);
      if (decodeCssEscapes(css.slice(i + 1, end)).toLowerCase() === "import") inImport = true;
      out += css.slice(i, end);
      i = end;
      continue;
    }

    if (char === "{" || char === "}") {
      functions.length = 0;
      inImport = false;
    } else if (char === ";" && functions.length === 0) {
      inImport = false;
    } else if (char === "(") {
      functions.push("other");
    } else if (char === ")") {
      functions.pop();
    }

    if (isIdentChar(css, i) && !/[0-9]/.test(char)) {
      const end = skipIdent(css, i);
      const name = decodeCssEscapes(css.slice(i, end)).toLowerCase();
      if (css[end] !== "(") {
        out += css.slice(i, end);
        i = end;
        continue;
      }
      if (name === "url") {
        let contentStart = end + 1;
        while (isCssWhitespace(css[contentStart])) contentStart++;
        if (css[contentStart] !== '"' && css[contentStart] !== "'") {
          // Unquoted url( token: everything up to the closing parenthesis.
          const stop = skipUrlToken(css, end + 1);
          const value = decodeCssEscapes(css.slice(end + 1, css[stop - 1] === ")" ? stop - 1 : stop)).trim();
          out += inImport || !isAllowed(value) ? `url(${BLOCKED_URL})` : css.slice(i, stop);
          i = stop;
          continue;
        }
      }
      functions.push(name === "url" || name === "src" ? "url" : name.endsWith("image-set") ? "image-set" : "other");
      out += css.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (char === "\\") {
      // A lone backslash (or an escape not starting an identifier) is copied as is.
      out += css.slice(i, i + 2);
      i += 2;
      continue;
    }

    out += char;
    i++;
  }
  return out;
}

function isLinkElement(element: Element): boolean {
  return element.localName === "a" || element.localName === "area";
}

function isRemoteAttributeValue(name: string, value: string): boolean {
  if (name === "srcset") return value.split(",").some((candidate) => isRemoteUrl(candidate));
  return isRemoteUrl(value);
}

/**
 * Remove active content and make links safe to click. Defence in depth: the
 * reading-pane iframe sandbox already blocks scripts, forms and plugins.
 */
export function sanitizeEmailDocument(doc: Document): void {
  doc.querySelectorAll(FORBIDDEN_ELEMENTS).forEach((element) => element.remove());

  // Keep form contents visible but drop the form itself so nothing can be submitted.
  doc.querySelectorAll("form").forEach((form) => form.replaceWith(...Array.from(form.childNodes)));

  // Only stylesheets are useful; prefetch/preconnect/icon links just leak requests.
  doc.querySelectorAll("link").forEach((link) => {
    if (link.getAttribute("rel")?.trim().toLowerCase() !== "stylesheet") link.remove();
  });

  // SVG animations can rewrite a link's href after sanitization.
  doc.querySelectorAll("set, animate").forEach((animation) => {
    if (/href$/i.test(animation.getAttribute("attributeName") ?? "")) animation.remove();
  });

  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name.startsWith("shadowroot") || name === "formaction" || name === "ping") {
        element.removeAttribute(attr.name);
      }
    }

    // Some browsers make any MathML element with an href a link that navigates the iframe.
    if (element.namespaceURI === MATHML_NS) {
      element.removeAttribute("href");
      element.removeAttribute("xlink:href");
    }

    if (!isLinkElement(element)) continue;
    for (const attrName of ["href", "xlink:href"]) {
      const href = element.getAttribute(attrName);
      if (href === null) continue;
      const trimmed = href.trim();
      if (trimmed.startsWith("#")) continue;
      if (/^[\\/]{2}/.test(normalizeUrl(trimmed))) {
        element.setAttribute(attrName, `https:${trimmed}`);
      } else if (!isSafeLinkHref(trimmed)) {
        element.removeAttribute(attrName);
        continue;
      }
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }
}

/**
 * Remove every resource URL the email may not load (see isAllowedResourceUrl)
 * from attributes, inline styles and <style> elements. With `allowRemote`
 * false only embedded data:, cid: and blob: URLs stay; with it true, remote
 * URLs on other sites stay as well, but relative URLs and URLs on the app's own
 * origin are still removed.
 */
export function restrictResourceUrls(doc: Document, allowRemote: boolean): void {
  const isAllowed = (url: string) => isAllowedResourceUrl(url, allowRemote);
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (element.localName === "style") {
      const css = element.textContent ?? "";
      const filtered = filterCssUrls(css, isAllowed);
      if (filtered !== css) element.textContent = escapeStyleText(filtered);
    }
    const linkElement = isLinkElement(element);
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (CSS_URL_ATTRIBUTES.has(name)) {
        const filtered = filterCssUrls(attr.value, isAllowed);
        if (filtered !== attr.value) element.setAttribute(attr.name, filtered);
        continue;
      }
      if (linkElement || !RESOURCE_ATTRIBUTES.has(name)) continue;
      const allowed = name === "srcset"
        ? srcsetUrls(attr.value).every(isAllowed)
        : isAllowed(attr.value);
      if (!allowed) element.removeAttribute(attr.name);
    }
  }
}

/** Remove every resource URL that would be fetched from a server (data:, cid: and blob: stay). */
export function stripRemoteResources(doc: Document): void {
  restrictResourceUrls(doc, false);
}

/** True if the document would load anything from a remote server. */
export function documentHasRemoteResources(doc: Document): boolean {
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (element.localName === "style" && cssHasRemoteUrl(element.textContent ?? "")) return true;
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (CSS_URL_ATTRIBUTES.has(name)) {
        if (cssHasRemoteUrl(attr.value)) return true;
      } else if (RESOURCE_ATTRIBUTES.has(name) && !isLinkElement(element)) {
        if (isRemoteAttributeValue(name, attr.value)) return true;
      }
    }
  }
  return false;
}

/**
 * Prepare message HTML for quoting in a reply or forward. The quote is sent to
 * the recipients and shown in the composer's sandboxed preview, so active
 * content is removed. Unless remote content was allowed for the message, remote
 * images (and CSS backgrounds, fonts and imports) are removed and images are
 * replaced by their alt text, so the reply neither shows nor resends trackers
 * the user blocked. When it was allowed, remote images on other sites are kept,
 * as the user saw them; relative and same-origin URLs never are.
 */
export function sanitizeQuotedHtml(html: string, allowRemote: boolean): string {
  const doc = parseSanitizedEmailHtml(html);
  restrictResourceUrls(doc, allowRemote);
  doc.querySelectorAll("img:not([src]):not([srcset])").forEach((img) => {
    img.replaceWith(img.getAttribute("alt") ?? "");
  });
  return doc.body?.innerHTML ?? "";
}
