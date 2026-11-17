import { describe, expect, it } from "vitest";
import { buildForwardQuoteHtml, buildReplyQuoteHtml, formatQuoteSender } from "../email-utils";

describe("HTML reply/forward quotes", () => {
  const sender = "Evil <img src=x onerror=alert(1)>";

  it("escapes the sender in the reply attribution line", () => {
    const html = buildReplyQuoteHtml("<p>Quoted</p>", sender, "2026-01-01T12:00:00Z");
    expect(html).not.toContain("<img");
    expect(html).toContain("Evil &lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex"><p>Quoted</p></blockquote>');
  });

  it("escapes the forwarded header fields", () => {
    const html = buildForwardQuoteHtml("<p>Body</p>", sender, "2026-01-01T12:00:00Z", "<b>Subject</b>", "a@example.com & b@example.com");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;Subject&lt;/b&gt;");
    expect(html).toContain("a@example.com &amp; b@example.com");
    expect(html).toContain("<hr><p>Body</p>");
  });

  it("names the sender with their address when a display name is known", () => {
    expect(formatQuoteSender("coach@example.com", "Coach")).toBe("Coach <coach@example.com>");
    expect(formatQuoteSender("coach@example.com", "")).toBe("coach@example.com");
    expect(formatQuoteSender("coach@example.com", "coach@example.com")).toBe("coach@example.com");
  });
});
