import { describe, expect, it } from "vitest";
import { parseEmailHtml } from "../email-html";
import { findPlainTextQuote, removeTrailingQuote } from "../quote-detection";

function collapse(html: string): { found: boolean; text: string; html: string } {
  const doc = parseEmailHtml(html);
  const found = removeTrailingQuote(doc);
  return { found, text: (doc.body.textContent ?? "").trim(), html: doc.body.innerHTML };
}

describe("HTML quote detection", () => {
  it("collapses a Gmail quote including its attribution", () => {
    const result = collapse('<div dir="ltr">Sounds good</div><br><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Mon, Bob wrote:<br></div><blockquote class="gmail_quote"><div>Earlier</div></blockquote></div>');
    expect(result).toMatchObject({ found: true, text: "Sounds good" });
  });

  it("collapses Apple/Thunderbird cite blockquotes with the attribution before them", () => {
    const result = collapse('<p>Yes</p><div class="moz-cite-prefix">On 1/1/26 Bob wrote:<br></div><blockquote type="cite"><p>Question?</p></blockquote>');
    expect(result).toMatchObject({ found: true, text: "Yes" });
    const apple = collapse('<div>Reply</div><div><br><div>On 1 Jan 2026, at 10:00, Bob &lt;bob@example.com&gt; wrote:</div><br></div><blockquote type="cite"><div>Original</div></blockquote>');
    expect(apple).toMatchObject({ found: true, text: "Reply" });
  });

  it("collapses our own quote but keeps the outermost history together", () => {
    const result = collapse('<p>Newest</p><div class="gmail_quote"><div class="gmail_attr">On X wrote:</div><blockquote class="gmail_quote"><p>Middle</p><div class="peps_quote"><div class="peps_quote_attr">On Y wrote:</div><blockquote type="cite">Oldest</blockquote></div></blockquote></div>');
    expect(result).toMatchObject({ found: true, text: "Newest" });
    expect(collapse('<p>Answer</p><div class="peps_quote"><div class="peps_quote_attr">On Y wrote:</div><blockquote type="cite">Question</blockquote></div>'))
      .toMatchObject({ found: true, text: "Answer" });
  });

  it("collapses Outlook and Yahoo history", () => {
    expect(collapse('<div>Fine</div><div id="appendonsend"></div><hr style="display:inline-block"><div id="divRplyFwdMsg"><b>From:</b> Bob</div><div>Original text</div>'))
      .toMatchObject({ found: true, text: "Fine" });
    expect(collapse('<p>Merci</p><hr><p><b>De :</b> Bob<br><b>Envoyé :</b> lundi</p><p>Original</p>'))
      .toMatchObject({ found: true, text: "Merci" });
    expect(collapse('<div>Ok</div><div class="yahoo_quoted"><div>On Monday, Bob wrote:</div><div>Old</div></div>'))
      .toMatchObject({ found: true, text: "Ok" });
  });

  it("keeps messages that are only a quote, quotes followed by text and forwards", () => {
    expect(collapse('<div class="gmail_quote"><div class="gmail_attr">On X wrote:</div><blockquote class="gmail_quote">Only quote</blockquote></div>').found).toBe(false);
    expect(collapse('<blockquote type="cite">Question 1</blockquote><p>Answer 1</p>').found).toBe(false);
    expect(collapse('<p>FYI</p><div class="gmail_quote">---------- Forwarded message ---------<br>From: Bob<br><div>Content</div></div>').found).toBe(false);
    expect(collapse('<p>FYI</p><div class="peps_quote peps_forward"><div class="peps_forward_header">Header</div><hr><p>Content</p></div>').found).toBe(false);
    expect(collapse("<p>No quotes</p><hr><p>Just a rule</p>").found).toBe(false);
  });

  it("collapses a plain blockquote only when an attribution line introduces it", () => {
    // Replies sent by earlier versions of this app (Tiptap output).
    expect(collapse("<p>ok</p><p></p><p>On 19 Oct 2026, 21:54, bob@example.com wrote:</p><blockquote><p>merci</p></blockquote>"))
      .toMatchObject({ found: true, text: "ok" });
    expect(collapse("<p>As the poet said:</p><blockquote><p>A passage</p></blockquote>").found).toBe(false);
  });

  it("only collapses the trailing part of interleaved replies", () => {
    const result = collapse('<blockquote type="cite">Q1</blockquote><p>A1</p><blockquote type="cite">Rest of history</blockquote>');
    expect(result).toMatchObject({ found: true, text: "Q1A1" });
  });

  it("stays fast on large and deeply nested messages", () => {
    const nested = `<p>Top</p>${'<blockquote type="cite"><div>level</div>'.repeat(400)}${"</blockquote>".repeat(400)}`;
    const wide = `<p>Top</p>${"<div><br></div>".repeat(20000)}${'<blockquote type="cite">x</blockquote><p>between</p>'.repeat(500)}<div class="gmail_quote">${"<p>old</p>".repeat(20000)}</div>`;
    const started = performance.now();
    expect(collapse(nested)).toMatchObject({ found: true, text: "Top" });
    expect(collapse(wide).found).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("plain-text quote detection", () => {
  it("finds a trailing attribution followed by quoted lines", () => {
    const text = "Thanks!\n\nOn Mon, 19 Oct 2026 at 21:37, Bob <bob@example.com> wrote:\n> de rien\n>\n> > merci\n";
    expect(findPlainTextQuote(text)).toBe(2);
    expect(findPlainTextQuote("Merci\n\nLe lun. 19 oct. 2026 à 21:37, Bob <bob@example.com> a écrit :\n> salut")).toBe(2);
  });

  it("handles wrapped attribution lines and Outlook separators", () => {
    expect(findPlainTextQuote("Ok\n\nOn Mon, 19 Oct 2026 at 21:37, Bob\n<bob@example.com> wrote:\n> hi")).toBe(2);
    expect(findPlainTextQuote("Ok\n\n-----Original Message-----\nFrom: Bob\nSent: Monday\n\nHello")).toBe(2);
  });

  it("does not collapse when nothing would remain, when text follows, or for forwards", () => {
    expect(findPlainTextQuote("On Mon, Bob wrote:\n> only quote")).toBeNull();
    expect(findPlainTextQuote("Hi\n\nOn Mon, Bob wrote:\n> question\nmy answer")).toBeNull();
    expect(findPlainTextQuote("Hi\n> quoted without attribution")).toBeNull();
    expect(findPlainTextQuote("FYI\n\n---------- Forwarded message ---------\nFrom: Bob\n\nOn Sun, Carol wrote:\n> older")).toBeNull();
  });

  it("scans long lines without backtracking", () => {
    const text = `Reply\n\nOn ${"x ".repeat(50000)}\n> quoted`;
    const started = performance.now();
    expect(findPlainTextQuote(text)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
