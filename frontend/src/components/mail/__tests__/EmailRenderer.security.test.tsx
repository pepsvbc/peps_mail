import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUiState } = vi.hoisted(() => ({
  mockUiState: {
    theme: "light" as "light" | "dark" | "system",
    effectiveAnimationMode: "off" as "rich" | "medium" | "subtle" | "off",
  },
}));

vi.mock("@/stores/useUiStore", () => ({
  useUiStore: (selector: (state: typeof mockUiState) => unknown) => selector(mockUiState),
}));

import { EmailRenderer, hasRemoteResources } from "../EmailRenderer";

type RendererProps = Partial<Parameters<typeof EmailRenderer>[0]>;

function renderSrcdoc(html: string, props: RendererProps = {}): string {
  const { container } = render(<EmailRenderer html={html} text={null} {...props} />);
  return container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

function headOf(srcdoc: string): string {
  return srcdoc.slice(0, srcdoc.indexOf("</head>"));
}

describe("EmailRenderer security", () => {
  beforeEach(() => {
    mockUiState.theme = "light";
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation(() => ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      });
    }
  });

  it("starts the document with a CSP that blocks remote content", () => {
    const srcdoc = renderSrcdoc("<p>Hello</p>", { blockRemoteResources: true });
    const firstElement = srcdoc.match(/<head>\s*(<meta[^>]*>)/)?.[1] ?? "";
    expect(firstElement).toContain('http-equiv="Content-Security-Policy"');
    expect(firstElement).toContain("default-src 'none'");
    expect(firstElement).toContain("img-src data: cid: blob:;");
    expect(firstElement).not.toContain("https:");
    expect(headOf(srcdoc)).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("allows http(s) resources in the CSP once remote content is allowed", () => {
    const srcdoc = renderSrcdoc("<p>Hello</p>", { blockRemoteResources: false });
    expect(headOf(srcdoc)).toContain("img-src data: cid: blob: https: http:");
    expect(headOf(srcdoc)).toContain("style-src 'unsafe-inline' https: http:");
  });

  it("keeps the email's own head content out of the wrapper head", () => {
    const srcdoc = renderSrcdoc(
      '<html><head><meta http-equiv="Content-Security-Policy" content="img-src *"><meta name="referrer" content="unsafe-url"><base href="https://evil.example/"><style>p{color:red}</style></head><body><p>Hi</p></body></html>',
      { blockRemoteResources: true },
    );
    expect(headOf(srcdoc)).not.toContain("img-src *");
    expect(srcdoc).not.toContain("unsafe-url");
    expect(srcdoc).not.toContain("<base");
    // The email's styles are kept, in the body
    expect(srcdoc.slice(srcdoc.indexOf("<body>"))).toContain("<style>p{color:red}</style>");
  });

  it("strips remote image URLs and keeps inline ones when blocked", () => {
    const srcdoc = renderSrcdoc(
      '<img src=https://t.example/a.gif><img src="//t.example/b.gif"><img src="data:image/png;base64,AAAA">',
      { blockRemoteResources: true },
    );
    expect(srcdoc).not.toContain("t.example");
    expect(srcdoc).toContain('src="data:image/png;base64,AAAA"');
  });

  it("sanitizes links and removes active content", () => {
    const srcdoc = renderSrcdoc(
      '<a href="https://example.com">ok</a><a href="javascript:alert(1)">bad</a><img src="data:image/png;base64,AA" onerror="alert(1)"><script>alert(2)</script>',
    );
    expect(srcdoc).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(srcdoc).not.toContain("javascript:");
    expect(srcdoc).not.toContain("onerror");
    expect(srcdoc).not.toContain("alert(2)");
  });

  it("does not copy an invalid body colour into the wrapper styles", () => {
    const srcdoc = renderSrcdoc(
      '<body bgcolor="red}</style><img src=x onerror=alert(1)><style>"><p>Hi</p></body>',
      { emailTheme: "light" },
    );
    expect(headOf(srcdoc)).not.toContain("<img");
    expect(headOf(srcdoc)).toContain("background-color: #ffffff;");
  });

  it("keeps a valid body colour and moves body styles to a wrapper div", () => {
    const srcdoc = renderSrcdoc(
      '<html><body style="background-color: #123456; padding: 4px"><p>Hi</p></body></html>',
      { emailTheme: "light" },
    );
    expect(headOf(srcdoc)).toContain("background-color: #123456;");
    expect(srcdoc).toContain('<div style="background-color: #123456; padding: 4px"><p>Hi</p></div>');
  });

  it("falls back to the first non-white wrapper table colour", () => {
    const srcdoc = renderSrcdoc(
      '<body bgcolor="#ffffff"><table bgcolor="white"><tr><td style="background-color: #edf2f7">x</td></tr></table></body>',
      { emailTheme: "light" },
    );
    expect(headOf(srcdoc)).toContain("background-color: #edf2f7;");
  });

  it("strips the email's color-scheme declarations but not prefers-color-scheme queries", () => {
    const srcdoc = renderSrcdoc(
      '<head><meta name="color-scheme" content="light dark"><style>:root { color-scheme: light dark; } @media (prefers-color-scheme: dark) { p { color: white } }</style></head><p style="color-scheme: dark">x</p>',
    );
    expect(srcdoc).not.toContain('content="light dark"');
    expect(srcdoc).not.toContain("color-scheme: light dark");
    expect(srcdoc).not.toContain('style="color-scheme: dark"');
    expect(srcdoc).toContain("@media (prefers-color-scheme: dark) { p { color: white } }");
  });

  it("applies adaptive dark-mode rules unconditionally in dark mode and strips them in light mode", () => {
    const html = "<style>p { color: black } @media (prefers-color-scheme: dark) { body { background-color: #111111 } p { color: white } }</style><p>x</p>";

    const dark = renderSrcdoc(html, { emailTheme: "adaptive", theme: "dark" });
    expect(dark).toContain("/* dark mode CSS extracted and applied unconditionally */");
    expect(dark).toContain("/* Adaptive dark mode CSS applied unconditionally */");
    expect(dark).toContain("p { color: white }");
    expect(headOf(dark)).toContain("background-color: #111111;");

    const light = renderSrcdoc(html, { emailTheme: "adaptive", theme: "light" });
    expect(light).toContain("/* dark mode CSS stripped for light mode */");
    expect(light).not.toContain("color: white");
  });

  it("cannot break out of the wrapper style through adaptive CSS", () => {
    const srcdoc = renderSrcdoc(
      "<svg><style>@media (prefers-color-scheme: dark) { p { color: red } &lt;/style&gt;&lt;img src=x&gt; }</style></svg>",
      { emailTheme: "adaptive", theme: "dark" },
    );
    expect(headOf(srcdoc)).not.toContain("</style><img");
  });

  it("detects remote content that the old patterns missed", () => {
    expect(hasRemoteResources("<img src=https://t.example/a.gif>")).toBe(true);
    expect(hasRemoteResources('<link rel="stylesheet" href="//t.example/s.css">')).toBe(true);
    expect(hasRemoteResources('<style>@import "https://t.example/s.css";</style>')).toBe(true);
    expect(hasRemoteResources('<img src="data:image/png;base64,AAAA">')).toBe(false);
    expect(hasRemoteResources(null)).toBe(false);
  });

  it.each([
    ["<html", "<html".repeat(80000)],
    ["<meta color-scheme", "<meta color-scheme".repeat(4000)],
    ["<td", "<td".repeat(80000)],
    ["<body", "<body".repeat(80000)],
    ["@media", `<style>${"@media (prefers-color-scheme: dark".repeat(20000)}</style>`],
    ["url(", `<div style="${"url( ".repeat(50000)}"></div>`],
    ["background:rgb(", `<body style="background:${"rgb(".repeat(50000)}">x</body>`],
  ])("processes pathological %s input quickly", (_name, html) => {
    const started = performance.now();
    renderSrcdoc(html, { blockRemoteResources: true, emailTheme: "adaptive", theme: "dark" });
    hasRemoteResources(html);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
