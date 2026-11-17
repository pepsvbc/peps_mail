import { describe, expect, it } from "vitest";
import { buildForwardBodyHtml, buildReplyBodyHtml } from "../email-utils";

describe("HTML reply/forward bodies", () => {
  const sender = "Evil <img src=x onerror=alert(1)>";

  it("escapes the sender in the reply attribution line", () => {
    const html = buildReplyBodyHtml("<p>Quoted</p>", sender, "2026-01-01T12:00:00Z");
    expect(html).not.toContain("<img");
    expect(html).toContain("Evil &lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<p>Quoted</p>");
  });

  it("escapes the forwarded header fields", () => {
    const html = buildForwardBodyHtml("<p>Body</p>", sender, "2026-01-01T12:00:00Z", "<b>Subject</b>", "a@example.com & b@example.com");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;Subject&lt;/b&gt;");
    expect(html).toContain("a@example.com &amp; b@example.com");
  });
});
