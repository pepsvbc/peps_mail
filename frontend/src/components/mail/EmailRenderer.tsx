"use client";

import { translate as t, useTranslation } from "@/lib/i18n";

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { useUiStore } from "@/stores/useUiStore";
import {
  XHTML_NS,
  documentHasRemoteResources,
  escapeStyleText,
  isSafeCssColor,
  isSafeLinkHref,
  parseEmailHtml,
  sanitizeEmailDocument,
  stripRemoteResources,
} from "@/lib/email-html";
import { findPlainTextQuote, findTrailingQuote } from "@/lib/quote-detection";
import { QuoteToggle } from "./QuoteToggle";
import type { AnimationMode } from "@/lib/motion/config";

interface EmailRendererProps {
  autoHeight?: boolean;
  html: string | null;
  text: string | null;
  blockRemoteResources?: boolean;
  theme?: "light" | "dark" | "auto";
  emailTheme?: 'light' | 'dark' | 'transparent' | 'adaptive';
  /** Hide trailing quoted history behind a "•••" toggle (reading pane). */
  collapseQuotes?: boolean;
}

const WHITE_COLOR_RE = /^(#fff(fff)?|white)$/i;

/** CSS color-scheme declarations, but not `prefers-color-scheme` inside @media queries. */
const COLOR_SCHEME_DECLARATION_RE = /(?<![-])(?:supported-)?color-schemes?\s*:[^;}"']+[;]?/gi;

/**
 * Content-Security-Policy for the email iframe. It is the real remote-content
 * block: attribute stripping is only cosmetic, while the CSP also covers CSS
 * imports, fonts, media and anything the stripping does not know about.
 * Inline images are served as data: URIs (the backend rewrites cid: URLs).
 */
function buildEmailCsp(allowRemote: boolean): string {
  const remote = allowRemote ? " https: http:" : "";
  return [
    "default-src 'none'",
    `img-src data: cid: blob:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    `media-src data:${remote}`,
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

let lastRemoteCheck: { html: string; result: boolean } | null = null;

/** Check if HTML would load anything from a remote server (http/https or protocol-relative). */
export function hasRemoteResources(html: string | null): boolean {
  if (!html) return false;
  // Called on every ReadingPane render, so remember the last message's answer.
  if (lastRemoteCheck?.html === html) return lastRemoteCheck.result;
  const doc = parseEmailHtml(html);
  sanitizeEmailDocument(doc);
  const result = documentHasRemoteResources(doc);
  lastRemoteCheck = { html, result };
  return result;
}

/**
 * Replace `@media (prefers-color-scheme: dark) { ... }` blocks in a stylesheet.
 * Hand-rolled instead of a regex: nested-brace regexes backtrack catastrophically
 * on crafted CSS.
 */
function replaceDarkMediaBlocks(css: string, replace: (innerCss: string) => string): string {
  const lower = css.toLowerCase();
  let out = "";
  let pos = 0;
  for (;;) {
    const at = lower.indexOf("@media", pos);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    if (open === -1) break;
    if (!/^\s*\([^)]*prefers-color-scheme\s*:\s*dark[^)]*\)/.test(lower.slice(at + 6, open))) {
      out += css.slice(pos, open + 1);
      pos = open + 1;
      continue;
    }
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth > 0; end++) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
    }
    if (depth !== 0) break;
    out += css.slice(pos, at) + replace(css.slice(open + 1, end - 1));
    pos = end;
  }
  return out + css.slice(pos);
}

/**
 * Sanitize the email and flatten it for embedding in our wrapper document:
 * the email's own <html>/<head>/<body> are dropped (their content is kept) so
 * the browser cannot create a second document root that bypasses the inversion
 * filter, and so nothing in the email can precede our CSP <meta>.
 */
function processEmailHtml(
  html: string,
  blockRemoteResources: boolean,
  adaptiveMode: "dark" | "light" | null,
  quoteMode: "keep" | "detect" | "collapse" = "keep",
): { bodyHtml: string; emailBgColor: string | null; adaptiveDarkCSS: string; hasQuote: boolean } {
  const doc = parseEmailHtml(html);
  sanitizeEmailDocument(doc);
  if (blockRemoteResources) stripRemoteResources(doc);

  // Trailing quoted history (detected by DOM traversal, see lib/quote-detection.ts).
  const quoteNodes = quoteMode === "keep" ? null : findTrailingQuote(doc);
  if (quoteMode === "collapse") quoteNodes?.forEach((node) => node.parentNode?.removeChild(node));

  // Strip email's own CSS color-scheme declarations — we set our own in the wrapper.
  // (The email's color-scheme <meta> tags are removed with all other <meta>s.)
  for (const element of Array.from(doc.querySelectorAll("[style]"))) {
    const style = element.getAttribute("style") ?? "";
    const cleaned = style.replace(COLOR_SCHEME_DECLARATION_RE, "");
    if (cleaned !== style) element.setAttribute("style", cleaned);
  }

  // For adaptive emails, we can't rely on @media(prefers-color-scheme:dark)
  // because browsers evaluate it against OS preference, not the iframe's
  // color-scheme meta tag. Instead:
  // - In dark mode: extract rules from @media dark blocks and inject as unconditional CSS
  // - In light mode: strip the blocks entirely so they don't fire from OS dark mode
  const extractedRules: string[] = [];
  for (const styleElement of Array.from(doc.querySelectorAll("style"))) {
    const original = styleElement.textContent ?? "";
    let css = original.replace(COLOR_SCHEME_DECLARATION_RE, "");
    if (adaptiveMode === "dark") {
      css = replaceDarkMediaBlocks(css, (innerCss) => {
        extractedRules.push(innerCss.trim());
        return "/* dark mode CSS extracted and applied unconditionally */";
      });
    } else if (adaptiveMode === "light") {
      css = replaceDarkMediaBlocks(css, () => "/* dark mode CSS stripped for light mode */");
    }
    if (css !== original) styleElement.textContent = escapeStyleText(css);
  }
  const adaptiveDarkCSS = extractedRules.length > 0
    ? `\n/* Adaptive dark mode CSS applied unconditionally */\n${escapeStyleText(extractedRules.join("\n"))}`
    : "";

  // Move the body's inline style and bgcolor to a wrapper div, and extract the
  // email's background color for padding matching.
  const body = doc.body;
  let wrapperStyle = body?.getAttribute("style") ?? "";
  const bodyBgAttr = body?.getAttribute("bgcolor")?.trim() || null;
  if (bodyBgAttr && !wrapperStyle.includes("background")) {
    wrapperStyle += (wrapperStyle ? "; " : "") + "background-color: " + bodyBgAttr;
  }
  let emailBgColor: string | null = null;
  // Prefer background-color over background shorthand (which may have gradients).
  const bgcMatch = wrapperStyle.match(/background-color\s*:\s*([^;!]+)/i);
  const bgShorthandMatch = wrapperStyle.match(/background\s*:\s*([^;!]+)/i);
  if (bgcMatch) {
    emailBgColor = bgcMatch[1].trim();
  } else if (bgShorthandMatch) {
    // Extract a hex or rgb color from background shorthand (skip gradients)
    const colorInShorthand = bgShorthandMatch[1].match(/(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))/);
    if (colorInShorthand) {
      emailBgColor = colorInShorthand[1];
    }
  } else if (bodyBgAttr) {
    emailBgColor = bodyBgAttr;
  }

  // If body tag had a plain white background (#ffffff/white), the actual visible
  // background is likely on the first wrapper table/td with a non-white bg.
  // Prefer that for padding matching since white on body is often just a boilerplate reset.
  const bodyBgIsWhite = emailBgColor && WHITE_COLOR_RE.test(emailBgColor);
  if (bodyBgIsWhite || !emailBgColor) {
    for (const cell of Array.from(body?.querySelectorAll("table, td") ?? [])) {
      const styleBg = cell.getAttribute("style")?.match(/background(?:-color)?\s*:\s*([^;!"]+)/i);
      const color = (styleBg?.[1] ?? cell.getAttribute("bgcolor") ?? "").trim();
      if (color && !WHITE_COLOR_RE.test(color)) {
        emailBgColor = color;
        break;
      }
    }
  }

  // The color is interpolated into the wrapper's <style>, so anything that is
  // not a plain color value (e.g. "red}</style>...") is dropped.
  if (emailBgColor && !isSafeCssColor(emailBgColor)) emailBgColor = null;

  let contentHtml = body?.innerHTML ?? "";
  if (body && wrapperStyle) {
    const wrapper = doc.createElement("div");
    wrapper.setAttribute("style", wrapperStyle);
    wrapper.append(...Array.from(body.childNodes));
    contentHtml = wrapper.outerHTML;
  }

  // Keep the email's <head> content (mostly <style> blocks) ahead of its body.
  return { bodyHtml: (doc.head?.innerHTML ?? "") + contentHtml, emailBgColor, adaptiveDarkCSS, hasQuote: !!quoteNodes };
}

/**
 * Click handler for the email document. Static sanitization already gives safe
 * links target="_blank" and removes unsafe hrefs; this also covers hrefs that
 * change after load (SVG) and fragment links, which in a srcdoc document would
 * otherwise resolve against the app URL and load the app inside the iframe.
 */
function handleEmailLinkClick(event: MouseEvent) {
  const link = (event.target as Element | null)?.closest?.("a, area");
  if (!link) return;
  const svgHref = (link as unknown as { href?: unknown }).href;
  const href = typeof svgHref === "object" && svgHref !== null
    ? (svgHref as SVGAnimatedString).animVal
    : link.getAttribute("href");
  if (!href) return;

  if (href.trim().startsWith("#")) {
    event.preventDefault();
    let id = href.trim().slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the raw fragment
    }
    const doc = link.ownerDocument;
    if (id) (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView();
    return;
  }

  if (!isSafeLinkHref(href)) {
    event.preventDefault();
    return;
  }

  if (link.namespaceURI !== XHTML_NS || link.getAttribute("target") !== "_blank") {
    event.preventDefault();
    window.open(href.trim(), "_blank", "noopener,noreferrer");
  }
}

export function EmailRenderer({
  html,
  text,
  autoHeight = false,
  blockRemoteResources = false,
  theme = "auto",
  emailTheme,
  collapseQuotes = false,
}: EmailRendererProps) {
  useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Quoted history starts collapsed and resets whenever another message is shown.
  const quoteSource = collapseQuotes ? (html ?? text) : null;
  const [quoteToggle, setQuoteToggle] = useState<{ source: string | null; expanded: boolean }>({ source: null, expanded: false });
  const quoteExpanded = quoteToggle.source === quoteSource && quoteToggle.expanded;
  const toggleQuote = () => setQuoteToggle({ source: quoteSource, expanded: !quoteExpanded });
  const quoteMode = !collapseQuotes ? "keep" : quoteExpanded ? "detect" : "collapse";

  const appTheme = useUiStore((state) => state.theme);
  const effectiveAnimationMode = useUiStore((state) => state.effectiveAnimationMode);
  const resolvedTheme = theme === "auto" ? appTheme : theme;
  const [prevTrack, setPrevTrack] = useState<{
    surface: "html" | "text" | "empty" | null;
    textSignature: string | null;
    richStreamSession: number;
    shouldAnimate: boolean;
  }>({ surface: null, textSignature: null, richStreamSession: 0, shouldAnimate: false });

  const [isSystemDark, setIsSystemDark] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setIsSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const isDark = resolvedTheme === "dark" || (resolvedTheme === "system" && isSystemDark);

   const shouldInvert = useMemo(() => {
    // Adaptive emails handle their own dark mode via CSS media queries
    if (emailTheme === 'adaptive') return false;
    // Transparent emails use direct theme application, not inversion
    if (!emailTheme || emailTheme === 'transparent') return false;

    const isAppDark = resolvedTheme === "dark" || (resolvedTheme === "system" && isSystemDark);

    return (emailTheme === 'dark' && !isAppDark) || (emailTheme === 'light' && isAppDark);
  }, [emailTheme, resolvedTheme, isSystemDark]);

  // Compute a stable key for the iframe — when this changes, React remounts the iframe
  // (Toggling the quote remounts the iframe too, so its height can shrink again.)
  const iframeKey = `${shouldInvert ? "inverted" : "normal"}-${isDark ? "dark" : "light"}-${blockRemoteResources}-${autoHeight}-${quoteMode}`;

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    try {
      const doc = iframe.contentDocument;
      const body = doc?.body;
      if (doc) {
        doc.addEventListener("click", handleEmailLinkClick, true);
        doc.addEventListener("auxclick", handleEmailLinkClick, true);
      }
      if (body) {
        // Use the container height as a minimum so email bg fills the pane
        const containerHeight = autoHeight ? 0 : iframe.parentElement?.clientHeight ?? 0;
        let lastHeight = 0;
        const updateHeight = () => {
          const docEl = doc?.documentElement;
          const contentHeight = Math.max(
            body.scrollHeight,
            body.offsetHeight,
            docEl?.clientHeight ?? 0,
            docEl?.scrollHeight ?? 0,
            docEl?.offsetHeight ?? 0
          );
          const height = Math.max(contentHeight, containerHeight);

          if (Math.abs(height - lastHeight) > 2) {
            iframe.style.height = `${height}px`;
            lastHeight = height;
          }
        };

        updateHeight();

        const images = body.querySelectorAll("img");
        images.forEach((img) => {
          if (!img.complete) {
            img.addEventListener("load", updateHeight);
            img.addEventListener("error", updateHeight);
          }
        });

        if (typeof ResizeObserver !== "undefined") {
          const resizeObserver = new ResizeObserver(() => {
            updateHeight();
          });
          resizeObserver.observe(body);
        }
      }
    } catch {
      iframe.style.height = "600px";
    }
  }, [autoHeight]);

  // Memoize the heavy HTML processing — DOM sanitization, CSS generation, etc.
  // This only re-runs when the actual inputs change, not on every render.
  const rendered = useMemo(() => {
    if (!html) return null;

    const { bodyHtml: cleanedHtml, emailBgColor, adaptiveDarkCSS, hasQuote } = processEmailHtml(
      html,
      blockRemoteResources,
      emailTheme === 'adaptive' ? (isDark ? 'dark' : 'light') : null,
      quoteMode,
    );

    // App theme colors (must match globals.css --background / --foreground)
    const appDarkBg = '#09090b';
    const appDarkFg = '#fafafa';
    const appLightBg = '#ffffff';  // hsl(0 0% 100%)
    const appLightFg = '#18181b';

    // Set color-scheme to match the visual appearance of the iframe content.
    // This affects browser chrome like scrollbars and form controls.
    let iframeColorScheme: string;
    if (emailTheme === 'adaptive') {
      // Adaptive emails respond to the app's theme via their own CSS
      iframeColorScheme = isDark ? 'dark' : 'light';
    } else if (shouldInvert) {
      // Inverted content: visual result is opposite of email's original theme
      iframeColorScheme = emailTheme === 'dark' ? 'light' : 'dark';
    } else {
      // Not inverting: transparent uses app theme, others match email theme
      if (!emailTheme || emailTheme === 'transparent') {
        iframeColorScheme = isDark ? 'dark' : 'light';
      } else {
        iframeColorScheme = emailTheme === 'dark' ? 'dark' : 'light';
      }
    }

    // Determine iframe background-color and text color based on scenario:
    // - Inverted: use body's OWN bg (not wrapper override) so white→black inversion is clean
    // - Transparent/text-only: inherit app theme colors directly (no inversion)
    // - Adaptive: let email handle it, but set fallback to app colors
    // - Normal (no invert, not transparent): use emailBgColor (may be wrapper override) for padding match
    let iframeBg: string;
    let iframeFg: string;

    if (shouldInvert) {
      // When inverting, use emailBgColor (which includes the wrapper non-white override)
      // so the 16px padding bg matches the email's visible content bg through the filter.
      // e.g. light-10 wrapper bg #edf2f7 inverts to #090e13 — padding must match.
      if (emailTheme === 'light') {
        iframeBg = emailBgColor || appLightBg;
        iframeFg = appLightFg;
      } else {
        iframeBg = emailBgColor || appDarkBg;
        iframeFg = appDarkFg;
      }
    } else if (!emailTheme || emailTheme === 'transparent') {
      // Transparent: no inversion, directly apply app theme
      iframeBg = isDark ? appDarkBg : appLightBg;
      iframeFg = isDark ? appDarkFg : appLightFg;
    } else if (emailTheme === 'adaptive') {
      // Adaptive: the email's own CSS sets backgrounds (we've injected dark rules unconditionally).
      // Try to extract the email's dark body background from the injected CSS for padding matching.
      // Fall back to app theme colors.
      if (isDark && adaptiveDarkCSS) {
        // Look for the first background color in the adaptive dark CSS rules
        const darkBgMatch = adaptiveDarkCSS.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\([^()]*\))/i);
        iframeBg = darkBgMatch && isSafeCssColor(darkBgMatch[1]) ? darkBgMatch[1].trim() : appDarkBg;
      } else {
        iframeBg = isDark ? appDarkBg : appLightBg;
      }
      iframeFg = isDark ? appDarkFg : appLightFg;
    } else {
      // Normal: email theme matches app theme — use email's own bg for seamless padding
      iframeBg = emailBgColor || (isDark ? appDarkBg : appLightBg);
      iframeFg = isDark ? appDarkFg : appLightFg;
    }

    // For transparent emails in dark mode, we need to force text color since
    // these emails have inline color:black that would be invisible on dark bg.
    // We can't use CSS inversion (that produces pure black bg, not app dark bg),
    // so we override text colors directly.
    const isTransparentDark = (!emailTheme || emailTheme === 'transparent') && isDark;
    const transparentDarkCSS = isTransparentDark ? `
    /* Force light text on dark bg for transparent emails */
    body, body * {
      color: ${iframeFg} !important;
    }
    /* Force transparent backgrounds so email wrapper divs/tables don't
       cover our dark bg (e.g. Odoo's background-color:white on wrapper table) */
    body div, body table, body td, body th, body tr, body tbody {
      background-color: transparent !important;
      background: transparent !important;
    }
    /* Preserve link colors */
    a, a * {
      color: #6ba3e8 !important;
    }
    ` : '';

    const srcDoc = `<!DOCTYPE html>
<html class="${shouldInvert ? 'invert' : ''}">
<head>
  <meta http-equiv="Content-Security-Policy" content="${buildEmailCsp(!blockRemoteResources)}" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="x-dns-prefetch-control" content="off" />
  <meta charset="utf-8" />
  <meta name="color-scheme" content="${iframeColorScheme}" />
  <style>
    html {
      background-color: ${iframeBg};
      color: ${iframeFg};
      color-scheme: ${iframeColorScheme} !important;
    }
    html, body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        Helvetica, Arial, sans-serif;
      margin: 0 !important;
      padding: 0 !important;
      height: auto !important;
      width: auto !important;
      min-height: 100% !important;
      box-sizing: border-box;
      overflow-y: hidden !important;
      overflow-x: auto;
    }
    body {
      padding: 8px 16px 16px !important;
      background-color: ${iframeBg};
      color: ${iframeFg};
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    img { max-width: 100%; height: auto; }
    pre { white-space: pre-wrap; word-break: break-word; }
    a { overflow-wrap: break-word; word-break: break-all; }
    ${transparentDarkCSS}

    /* Inversion filter - inverts all rendered colors including text */
    html.invert {
      filter: invert(1) hue-rotate(180deg);
    }

    /* Double-invert media to preserve original appearance */
    html.invert img,
    html.invert picture,
    html.invert video,
    html.invert canvas,
    html.invert svg,
    html.invert [style*="background-image"] {
      filter: invert(1) hue-rotate(180deg);
    }

    /* Remove shadows that look wrong when inverted */
    html.invert * {
      box-shadow: none !important;
      text-shadow: none !important;
    }

    /* Override CSS system colors (windowtext, window, buttonface, etc.)
       that don't render correctly in modern browsers and can make text
       invisible against certain backgrounds */
    [style*="windowtext" i] { color: inherit !important; }
    [style*="WindowText" i] { color: inherit !important; }
    [style*="window;" i] { background-color: inherit !important; }
    [style*="buttonface" i] { background-color: inherit !important; }
    [style*="InfoBackground" i] { background-color: inherit !important; }
    ${adaptiveDarkCSS}
  </style>
</head>
<body>
  ${cleanedHtml}

  <!-- Re-assert layout rules after email content to override email <style> blocks
       that may set html/body { height: 100%; margin: 0; width: 100%; } etc. -->
  <style>
    html {
      color-scheme: ${iframeColorScheme} !important;
    }
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      height: auto !important;
      width: auto !important;
      min-height: 100% !important;
      overflow-y: hidden !important;
    }
    body {
      padding: 8px 16px 16px !important;
    }
    ${transparentDarkCSS}
    ${adaptiveDarkCSS}
  </style>
</body>
</html>`;
    return { srcDoc, hasQuote };
  }, [html, blockRemoteResources, emailTheme, shouldInvert, isDark, quoteMode]);
  const wrappedHtml = rendered?.srcDoc ?? null;

  // Plain-text messages: trailing "On … wrote:" + "> " lines (see lib/quote-detection.ts).
  const textQuoteStart = useMemo(
    () => (collapseQuotes && text && !wrappedHtml ? findPlainTextQuote(text) : null),
    [collapseQuotes, text, wrappedHtml],
  );
  const displayText = text && textQuoteStart !== null && !quoteExpanded
    ? text.split(/\r?\n/).slice(0, textQuoteStart).join("\n").trimEnd()
    : text;
  const quoteToggleButton = (rendered?.hasQuote || textQuoteStart !== null) ? (
    <div className="px-4 pb-3">
      <QuoteToggle expanded={quoteExpanded} onToggle={toggleQuote} />
    </div>
  ) : null;

  const surface: "html" | "text" | "empty" = wrappedHtml ? "html" : text ? "text" : "empty";
  const textSignature = text ? `${text.length}:${text}` : null;

  // Adjust state during render (React-recommended pattern for "previous value" tracking).
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const needsUpdate =
    prevTrack.surface !== surface ||
    (surface === "text" && prevTrack.textSignature !== textSignature);

  let shouldStartRichStream = prevTrack.shouldAnimate;
  let richStreamSession = prevTrack.richStreamSession;

  if (needsUpdate) {
    shouldStartRichStream =
      surface === "text" &&
      effectiveAnimationMode === "rich" &&
      (
        prevTrack.surface == null ||
        prevTrack.surface === "html" ||
        prevTrack.textSignature !== textSignature
      );

    if (shouldStartRichStream) {
      richStreamSession = prevTrack.richStreamSession + 1;
    }

    setPrevTrack({
      surface,
      textSignature: surface === "text" ? textSignature : null,
      richStreamSession,
      shouldAnimate: shouldStartRichStream,
    });
  }

  if (wrappedHtml) {
    return (
      <div className={autoHeight ? "w-full bg-background" : "h-full w-full overflow-auto bg-background"}>
        {/*
         * SECURITY: iframe sandbox attribute rationale
         *
         * allow-same-origin — Required so the parent can access iframe.contentDocument
         *   to measure content height (ResizeObserver, scrollHeight), attach image
         *   load listeners, and dynamically resize the iframe. Without it, the
         *   browser blocks all cross-document DOM access and the auto-height logic
         *   in handleIframeLoad breaks entirely.
         *
         * allow-popups / allow-popups-to-escape-sandbox — Lets mailto: and http(s)
         *   links open in new tabs/windows as users expect. Sanitization keeps only
         *   http(s)/mailto/fragment hrefs and marks links target="_blank"
         *   rel="noopener noreferrer"; handleEmailLinkClick catches the rest, so
         *   the iframe itself never navigates.
         *
         * RISK: allow-same-origin combined with allow-scripts would let embedded
         *   content access the parent page's cookies, localStorage, and DOM — a
         *   full same-origin escalation. This is safe ONLY because allow-scripts
         *   is deliberately omitted: the sandbox blocks all script execution
         *   (<script> tags, inline handlers, javascript: URLs, etc.), so even if
         *   email HTML contains malicious JS it cannot run.
         *
         * If a future browser bug or spec change weakens the script-blocking
         *   guarantee, this would become exploitable. Mitigations considered:
         *
         *   - Removing allow-same-origin and using postMessage for height: would
         *     require injecting a <script> into srcdoc (reintroducing allow-scripts),
         *     which is strictly worse — it trades a theoretical risk for a concrete one.
         *
         *   - Serving email HTML from a separate origin (e.g., blob: URL on a
         *     different subdomain): adds deployment complexity and CORS overhead
         *     for marginal benefit given the current sandbox guarantees.
         *
         *   - Using shadow DOM instead of an iframe: does not provide the same
         *     style/script isolation as the sandbox attribute.
         *
         * Conclusion: the current sandbox="allow-popups allow-popups-to-escape-sandbox
         *   allow-same-origin" (without allow-scripts) is the best tradeoff. It
         *   provides full script isolation while preserving the DOM access needed
         *   for responsive iframe sizing. Re-evaluate if the HTML Sandbox spec
         *   changes or if we move to a separate-origin rendering service.
         */}
        <iframe
          key={iframeKey}
          ref={iframeRef}
          scrolling="no"
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          srcDoc={wrappedHtml}
          className="w-full border-none"
          style={{
            minHeight: autoHeight ? undefined : "100%",
          }}
          title={t("Email content")}
          onLoad={handleIframeLoad}
        />
        {quoteToggleButton}
      </div>
    );
  }

  if (text) {
    return (
      <>
        <PlainTextBody
          text={displayText ?? text}
          animationMode={effectiveAnimationMode}
          shouldAnimateRich={shouldStartRichStream}
          richStreamSession={richStreamSession}
        />
        {quoteToggleButton}
      </>
    );
  }

  return (
    <p className="p-4 text-sm text-muted-foreground">
      {t("No content available for this message.")}
    </p>
  );
}

/** Plain-text message body with the animation for the current animation mode. */
function PlainTextBody({
  text,
  animationMode,
  shouldAnimateRich,
  richStreamSession,
}: {
  text: string;
  animationMode: AnimationMode;
  shouldAnimateRich: boolean;
  richStreamSession: number;
}) {
  if (animationMode === "off") {
    return (
      <pre
        data-testid="email-renderer-plaintext-static"
        className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed text-foreground"
      >
        {text}
      </pre>
    );
  }

  if (animationMode === "rich") {
    const lines = text.split(/\r?\n/);
    const isLargeBody = text.length > 6000 || lines.length > 180;

    if (isLargeBody) {
      return (
        <pre
          data-testid="email-renderer-plaintext-large-reveal"
          data-stream-session={String(richStreamSession)}
          className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed text-foreground transition-opacity duration-200"
          style={{
            animationName: shouldAnimateRich ? "email-plaintext-container-reveal" : "none",
            animationDuration: shouldAnimateRich ? "220ms" : "0ms",
            animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
            animationFillMode: "both",
          }}
        >
          {text}
        </pre>
      );
    }

    return (
      <pre
        data-testid="email-renderer-plaintext-rich-stream"
        data-stream-session={String(richStreamSession)}
        className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed text-foreground"
      >
        {lines.map((line, index) => (
          <span
            key={`${richStreamSession}-${index}`}
            data-testid="email-renderer-plaintext-line"
            style={{
              display: "inline-block",
              width: "100%",
              animationName: shouldAnimateRich ? "email-plaintext-line-reveal" : "none",
              animationDuration: shouldAnimateRich ? "260ms" : "0ms",
              animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
              animationFillMode: "both",
              animationDelay: shouldAnimateRich ? `${Math.min(index * 18, 320)}ms` : "0ms",
            }}
          >
            {line}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </pre>
    );
  }

  const simpleAnimationName =
    animationMode === "medium"
      ? "email-plaintext-medium-reveal"
      : "email-plaintext-subtle-reveal";
  const simpleAnimationDuration = animationMode === "medium" ? "170ms" : "110ms";

  return (
    <pre
      data-testid="email-renderer-plaintext-simple-transition"
      className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed text-foreground transition-opacity duration-150"
      style={{
        animationName: simpleAnimationName,
        animationDuration: simpleAnimationDuration,
        animationTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
        animationFillMode: "both",
      }}
    >
      {text}
    </pre>
  );
}
