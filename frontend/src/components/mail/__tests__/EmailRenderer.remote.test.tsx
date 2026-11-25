import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUiState } = vi.hoisted(() => ({
  mockUiState: {
    theme: "light" as "light" | "dark" | "system",
    effectiveAnimationMode: "off" as "rich" | "medium" | "subtle" | "off",
  },
}));

vi.mock("@/stores/useUiStore", () => ({
  useUiStore: (selector: (state: typeof mockUiState) => unknown) => selector(mockUiState),
}));

import { EmailRenderer, handleEmailLinkClick } from "../EmailRenderer";

function renderSrcdoc(html: string, blockRemoteResources: boolean): string {
  const { container } = render(<EmailRenderer html={html} text={null} blockRemoteResources={blockRemoteResources} />);
  return container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

function bodyOf(srcdoc: string): string {
  return srcdoc.slice(srcdoc.indexOf("<body>"));
}

beforeEach(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  }
});

describe("EmailRenderer remote content", () => {
  it("never loads relative or same-origin URLs, even after remote content is allowed", () => {
    const srcdoc = bodyOf(renderSrcdoc(
      `<img src="/api/messages/INBOX/1"><img src="${window.location.origin}/api/x"><img src="https://t.example/ok.png">` +
      `<div style="background: url(/api/bg)"></div><style>p { background: url(api/style) }</style>`,
      false,
    ));
    expect(srcdoc).not.toContain("/api/");
    expect(srcdoc).toContain('src="https://t.example/ok.png"');
  });

  it("removes remote CSS URLs when remote content is blocked", () => {
    const srcdoc = bodyOf(renderSrcdoc(
      '<div style="background: url(https://t.example/a.png)"></div><style>@import "https://t.example/s.css"; p { background: url(https://t.example/b.png) }</style>',
      true,
    ));
    expect(srcdoc).not.toContain("t.example");
  });

  it("drops declarative shadow roots from the rendered document", () => {
    const srcdoc = renderSrcdoc('<div><template shadowrootmode="open"><a href="https://evil.example" rel="opener">x</a></template></div>', false);
    expect(srcdoc).not.toContain("<template");
    expect(srcdoc).not.toContain("evil.example");
  });
});

describe("handleEmailLinkClick", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    document.addEventListener("click", handleEmailLinkClick, true);
  });

  afterEach(() => {
    document.removeEventListener("click", handleEmailLinkClick, true);
    host.remove();
    vi.restoreAllMocks();
  });

  function clickInShadowRoot(markup: string): { event: MouseEvent; open: ReturnType<typeof vi.spyOn> } {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = markup;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
    root.querySelector("span")!.dispatchEvent(event);
    return { event, open };
  }

  it("finds links inside shadow roots and opens them in a new tab only", () => {
    const { event, open } = clickInShadowRoot('<a href="https://evil.example/phish"><span>x</span></a>');
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("https://evil.example/phish", "_blank", "noopener,noreferrer");
  });

  it("blocks unsafe links inside shadow roots", () => {
    const { event, open } = clickInShadowRoot('<a href="/api/auth/logout"><span>x</span></a>');
    expect(event.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
