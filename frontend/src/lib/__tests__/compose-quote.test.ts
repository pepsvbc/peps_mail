import { describe, expect, it } from "vitest";
import {
  buildForwardQuote,
  buildReplyQuote,
  htmlToPlainText,
  serializeComposeBody,
  splitQuotedBody,
} from "../compose-quote";

/** A Gmail reply with its own nested history, styles and <div><br></div> spacing. */
const GMAIL_HTML = [
  '<div dir="ltr">ok</div><br>',
  '<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Le lun. 19 oct. 2026 à 21:37, Bob &lt;bob@example.com&gt; a écrit :<br></div>',
  '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">',
  '<div dir="ltr"><div>de rien mec</div><div><br></div></div><br>',
  '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">',
  '<div><span style="color:rgb(255,0,0)">merci</span></div></blockquote></blockquote></div>',
].join("");

const original = {
  html: GMAIL_HTML,
  text: "ok\n\nLe lun. 19 oct. 2026 à 21:37, Bob a écrit :\n> de rien mec",
  fromAddress: "alice@example.com",
  fromName: "Alice",
  date: "2026-10-19T19:54:00Z",
};

describe("reply quotes", () => {
  it("names the sender and keeps the original HTML untouched in the sent body", () => {
    const quote = buildReplyQuote(original);
    expect(quote.kind).toBe("reply");
    expect(quote.html).toContain("Alice &lt;alice@example.com&gt; wrote:");

    const editor = "<p>Thanks!</p>";
    const { html, text } = serializeComposeBody({ body: editor, isHtml: true, quoteKind: quote.kind, quotedHtml: quote.html, quotedText: quote.text });
    expect(html).toBe(`${editor}<div class="peps_quote">${quote.html}</div>`);
    expect(quote.html).toMatch(/^<div class="peps_quote_attr">On .+, Alice &lt;alice@example.com&gt; wrote:<\/div>/);
    // Nested Gmail quotes, classes and inline styles are kept byte for byte.
    expect(quote.html).toContain(`<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${GMAIL_HTML}</blockquote>`);
    // The plain-text alternative also carries the quote, with "> " prefixes.
    expect(text).toMatch(/^Thanks!\n\nOn .+, Alice <alice@example.com> wrote:\n> ok\n/);
    expect(text).toContain("> > de rien mec");
  });

  it("serializes plain-text replies with the attribution and quoted lines", () => {
    const quote = buildReplyQuote({ ...original, html: null, text: "See you\nTuesday" });
    const { html, text } = serializeComposeBody({ body: "Great", isHtml: false, quoteKind: quote.kind, quotedHtml: quote.html, quotedText: quote.text });
    expect(html).toBeNull();
    expect(text).toMatch(/^Great\n\nOn .+, Alice <alice@example.com> wrote:\n> See you\n> Tuesday$/);
    expect(quote.html).toContain("See you<br>Tuesday");
  });

  it("leaves bodies without a quote unchanged", () => {
    expect(serializeComposeBody({ body: "<p>Hi</p>", isHtml: true, quoteKind: null, quotedHtml: null, quotedText: null }))
      .toEqual({ html: "<p>Hi</p>", text: "Hi" });
    expect(serializeComposeBody({ body: "Hi", isHtml: false })).toEqual({ html: null, text: "Hi" });
  });

  it("marks forwards so they reopen as forwards", () => {
    const quote = buildForwardQuote({ ...original, subject: "Training", to: "team@example.com" });
    const { html, text } = serializeComposeBody({ body: "<p>FYI</p>", isHtml: true, quoteKind: quote.kind, quotedHtml: quote.html, quotedText: quote.text });
    expect(html).toContain('<div class="peps_quote peps_forward"><div class="peps_forward_header">---------- Forwarded message ----------<br>From: Alice &lt;alice@example.com&gt;');
    expect(html).toContain(`<hr>${GMAIL_HTML}</div>`);
    expect(text).toContain("Subject: Training\nTo: team@example.com\n\nok");
    expect(splitQuotedBody(html!).quote?.kind).toBe("forward");
  });
});

describe("draft round-trip", () => {
  it("splits a saved draft back into the editor body and the quoted part", () => {
    const quote = buildReplyQuote(original);
    const editor = '<p>My answer</p><div class="email-signature" data-signature="true"><p>-- </p><p>Coach</p></div>';
    const { html } = serializeComposeBody({ body: editor, isHtml: true, quoteKind: quote.kind, quotedHtml: quote.html, quotedText: quote.text });
    const split = splitQuotedBody(html!);
    expect(split.body).toBe(editor);
    expect(split.quote).toMatchObject({ kind: "reply", html: quote.html });
    expect(split.quote?.text).toContain("> ok");
    // Saving again produces the same body.
    expect(serializeComposeBody({ body: split.body, isHtml: true, quoteKind: split.quote!.kind, quotedHtml: split.quote!.html }).html).toBe(html);
  });

  it("opens drafts without a trailing quote marker unchanged", () => {
    expect(splitQuotedBody("<p>Plain draft</p>")).toEqual({ body: "<p>Plain draft</p>", quote: null });
    const middle = '<p>A</p><div class="peps_quote">quoted</div><p>Written after the quote</p>';
    expect(splitQuotedBody(middle)).toEqual({ body: middle, quote: null });
    expect(splitQuotedBody('<div><div class="peps_quote">nested</div></div>').quote).toBeNull();
  });
});

describe("htmlToPlainText", () => {
  it("turns blocks into lines and blockquotes into '> ' prefixes", () => {
    expect(htmlToPlainText("<div>One</div><div>Two<br>Three</div><blockquote><p>Q1</p><blockquote>Q2</blockquote></blockquote><style>p{}</style>"))
      .toBe("One\nTwo\nThree\n> Q1\n> > Q2");
  });
});
