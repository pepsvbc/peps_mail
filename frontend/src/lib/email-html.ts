/**
 * DOM-based helpers for untrusted email HTML.
 *
 * Everything here works on a document from `DOMParser`, which is inert: no
 * scripts run and no resources load while it is parsed or modified. Avoid
 * regexes over raw HTML — they are easy to bypass and several of the obvious
 * ones backtrack catastrophically on crafted input.
 */

export const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Elements that are never rendered from an email (the iframe sandbox blocks most of them already). */
const FORBIDDEN_ELEMENTS = "script, iframe, frame, frameset, object, embed, applet, base, meta, portal";

/** Attributes that make the browser fetch something. href on links is handled separately. */
const RESOURCE_ATTRIBUTES = new Set(["src", "srcset", "lowsrc", "dynsrc", "background", "poster", "href", "xlink:href"]);

/** Parse untrusted HTML into an inert document. */
export function parseEmailHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
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
      if (name.startsWith("on") || name === "formaction" || name === "ping") {
        element.removeAttribute(attr.name);
      }
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

/** Remove every resource URL that would be fetched from a server (data:, cid: and blob: stay). */
export function stripRemoteResources(doc: Document): void {
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (isLinkElement(element)) continue;
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (!RESOURCE_ATTRIBUTES.has(name)) continue;
      const value = attr.value.trim();
      if (!value || value.startsWith("#")) continue;
      // data: URIs contain commas, so a srcset only counts as embedded if it starts
      // with an embedded URL and no comma-separated candidate looks remote.
      const embedded = isEmbeddedUrl(value) && !(name === "srcset" && isRemoteAttributeValue(name, value));
      if (!embedded) element.removeAttribute(attr.name);
    }
  }
}

/** True if the document would load anything from a remote server. */
export function documentHasRemoteResources(doc: Document): boolean {
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (element.localName === "style" && cssHasRemoteUrl(element.textContent ?? "")) return true;
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === "style") {
        if (cssHasRemoteUrl(attr.value)) return true;
      } else if (RESOURCE_ATTRIBUTES.has(name) && !isLinkElement(element)) {
        if (isRemoteAttributeValue(name, attr.value)) return true;
      }
    }
  }
  return false;
}

/**
 * Prepare message HTML for quoting in the composer. The editor renders in the
 * app's own origin without the reading pane's sandbox or CSP, so active content
 * is removed and, unless remote content was allowed for the message, remote
 * images are replaced by their alt text.
 */
export function sanitizeQuotedHtml(html: string, allowRemote: boolean): string {
  const doc = parseEmailHtml(html);
  sanitizeEmailDocument(doc);
  if (!allowRemote) {
    stripRemoteResources(doc);
    doc.querySelectorAll("img:not([src])").forEach((img) => {
      img.replaceWith(img.getAttribute("alt") ?? "");
    });
  }
  return doc.body?.innerHTML ?? "";
}
