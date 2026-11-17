import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUiState } = vi.hoisted(() => ({
  mockUiState: {
    theme: "light" as "light" | "dark" | "system",
    effectiveAnimationMode: "off" as "rich" | "medium" | "subtle" | "off",
    collapseQuotes: true,
  },
}));

vi.mock("@/stores/useUiStore", () => ({
  useUiStore: (selector: (state: typeof mockUiState) => unknown) => selector(mockUiState),
}));

import { EmailRenderer } from "../EmailRenderer";

function srcdoc(container: HTMLElement): string {
  return container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

const GMAIL = '<div dir="ltr">Latest reply</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Bob wrote:</div><blockquote class="gmail_quote" style="border-left:1px solid #ccc">Earlier message</blockquote></div>';

describe("EmailRenderer quoted history", () => {
  beforeEach(() => {
    mockUiState.effectiveAnimationMode = "off";
    mockUiState.collapseQuotes = true;
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
      });
    }
  });

  it.each([
    ["Gmail", GMAIL],
    ["cite blockquote", '<p>Latest reply</p><blockquote type="cite"><p>Earlier message</p></blockquote>'],
    ["our own", '<p>Latest reply</p><div class="peps_quote"><div class="peps_quote_attr">On Mon, Bob wrote:</div><blockquote type="cite">Earlier message</blockquote></div>'],
  ])("collapses a trailing %s quote behind a toggle and shows it again when expanded", (_name, html) => {
    const { container } = render(<EmailRenderer html={html} text={null} collapseQuotes />);
    expect(srcdoc(container)).toContain("Latest reply");
    expect(srcdoc(container)).not.toContain("Earlier message");

    fireEvent.click(screen.getByRole("button", { name: "Show previous messages" }));
    expect(srcdoc(container)).toContain("Earlier message");
    expect(srcdoc(container)).toContain("Latest reply");

    fireEvent.click(screen.getByRole("button", { name: "Hide previous messages" }));
    expect(srcdoc(container)).not.toContain("Earlier message");
  });

  it("never hides a message that is only a quote", () => {
    const html = '<div class="gmail_quote"><div class="gmail_attr">On Mon, Bob wrote:</div><blockquote class="gmail_quote">Only quoted text</blockquote></div>';
    const { container } = render(<EmailRenderer html={html} text={null} collapseQuotes />);
    expect(srcdoc(container)).toContain("Only quoted text");
    expect(screen.queryByRole("button", { name: "Show previous messages" })).toBeNull();
  });

  it("keeps quotes when collapsing is not requested", () => {
    const { container } = render(<EmailRenderer html={GMAIL} text={null} />);
    expect(srcdoc(container)).toContain("Earlier message");
    expect(screen.queryByRole("button", { name: "Show previous messages" })).toBeNull();
  });

  it("starts collapsed again for the next message", () => {
    const { container, rerender } = render(<EmailRenderer html={GMAIL} text={null} collapseQuotes />);
    fireEvent.click(screen.getByRole("button", { name: "Show previous messages" }));
    rerender(<EmailRenderer html={GMAIL.replace("Latest reply", "Another reply")} text={null} collapseQuotes />);
    expect(srcdoc(container)).not.toContain("Earlier message");
    expect(screen.getByRole("button", { name: "Show previous messages" })).toBeTruthy();
  });

  it("starts expanded with a hide toggle when the preference keeps quotes open", () => {
    mockUiState.collapseQuotes = false;
    const { container } = render(<EmailRenderer html={GMAIL} text={null} collapseQuotes />);
    expect(srcdoc(container)).toContain("Earlier message");
    fireEvent.click(screen.getByRole("button", { name: "Hide previous messages" }));
    expect(srcdoc(container)).not.toContain("Earlier message");
    expect(srcdoc(container)).toContain("Latest reply");
  });

  it("collapses the quoted part of plain-text messages", () => {
    const text = "Sure, see you then.\n\nOn Mon, 19 Oct 2026 at 21:37, Bob <bob@example.com> wrote:\n> Are you coming?\n";
    render(<EmailRenderer html={null} text={text} collapseQuotes />);
    const body = screen.getByTestId("email-renderer-plaintext-static");
    expect(body.textContent).toBe("Sure, see you then.");
    fireEvent.click(screen.getByRole("button", { name: "Show previous messages" }));
    expect(screen.getByTestId("email-renderer-plaintext-static").textContent).toBe(text);
  });
});
