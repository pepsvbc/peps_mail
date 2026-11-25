import { describe, expect, it } from "vitest";
import {
  filterCssUrls,
  isAllowedResourceUrl,
  parseEmailHtml,
  parseSanitizedEmailHtml,
  purifyEmailHtml,
  restrictResourceUrls,
  sanitizeEmailDocument,
  sanitizeQuotedHtml,
} from "../email-html";

const self = window.location.origin;

/** Serialize the sanitized body and parse it again, as the iframe srcdoc and outgoing mail do. */
function reparsedBody(html: string): Document {
  return parseEmailHtml(parseSanitizedEmailHtml(html).body.innerHTML);
}

describe("declarative shadow DOM", () => {
  const shadowHtml = `<div id="host"><template shadowrootmode="open"><a id="evil" href="https://evil.example" target="_self" rel="opener">Click</a><img src="https://t.example/p.gif"></template></div><p>after</p>`;

  it("never reaches the rendered document", () => {
    const doc = reparsedBody(shadowHtml);
    expect(doc.querySelector("template")).toBeNull();
    expect(doc.body.innerHTML).not.toContain("evil.example");
    expect(doc.body.innerHTML).not.toContain("t.example");
    expect(doc.body.innerHTML).not.toContain("shadowroot");
    expect(doc.body.textContent).toContain("after");
  });

  it("is removed by the email rules on their own too", () => {
    const doc = parseEmailHtml(shadowHtml.replace("<div", "<div shadowrootmode=\"open\""));
    sanitizeEmailDocument(doc);
    expect(doc.querySelector("template")).toBeNull();
    expect(doc.querySelector("[shadowrootmode]")).toBeNull();
  });

  it("never reaches a quoted reply", () => {
    for (const allowRemote of [false, true]) {
      const quoted = sanitizeQuotedHtml(shadowHtml, allowRemote);
      expect(quoted).not.toContain("template");
      expect(quoted).not.toContain("evil.example");
      expect(quoted).toContain("after");
    }
  });
});

describe("mutation XSS", () => {
  it.each([
    ["svg style", '<svg><style><img src=x onerror=alert(1)></style></svg>'],
    ["noscript attribute", '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
    ["math style", '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>'],
    ["form nesting", '<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=alert(1)>'],
    ["svg title", '<svg></p><title><a id="</title><img src=x onerror=alert(1)>"></a></title></svg>'],
  ])("re-parsing the sanitized %s never yields an event handler", (_name, html) => {
    for (const doc of [reparsedBody(html), parseEmailHtml(sanitizeQuotedHtml(html, true))]) {
      expect(doc.querySelector("[onerror], script, noscript, template")).toBeNull();
    }
  });

  it("removes href from MathML elements, which can act as links", () => {
    const doc = reparsedBody('<math><mi href="https://phish.example">m</mi></math>');
    expect(doc.body.innerHTML).not.toContain("phish.example");
  });

  it("keeps <style> blocks wrapped in HTML comments", () => {
    const doc = parseSanitizedEmailHtml("<html><head><style><!-- p.MsoNormal { margin: 0 } --></style></head><body><p>x</p></body></html>");
    expect(doc.head.querySelector("style")?.textContent).toContain("p.MsoNormal { margin: 0 }");
  });

  it("keeps ordinary email markup", () => {
    const html = '<table background="https://t.example/bg.png" cellpadding="0"><tr><td bgcolor="#eeeeee" style="color: red">x</td></tr></table><font face="Arial" color="red">f</font><center>c</center><blockquote type="cite" class="gmail_quote">q</blockquote><img src="cid:logo"><img src="blob:https://app.example/1"><svg><rect fill="url(#g)"></rect></svg>';
    const out = purifyEmailHtml(html);
    for (const kept of ['background="https://t.example/bg.png"', 'bgcolor="#eeeeee"', 'style="color: red"', '<font face="Arial" color="red">', "<center>", 'class="gmail_quote"', 'src="cid:logo"', 'src="blob:https://app.example/1"', 'fill="url(#g)"']) {
      expect(out).toContain(kept);
    }
  });
});

describe("isAllowedResourceUrl", () => {
  it("always allows embedded and fragment URLs", () => {
    for (const url of ["data:image/png;base64,AA", "cid:logo", "blob:x", "#grad", ""]) {
      expect(isAllowedResourceUrl(url, false)).toBe(true);
      expect(isAllowedResourceUrl(url, true)).toBe(true);
    }
  });

  it("allows remote URLs on other sites only when remote content is allowed", () => {
    expect(isAllowedResourceUrl("https://t.example/a.png", false)).toBe(false);
    expect(isAllowedResourceUrl("https://t.example/a.png", true)).toBe(true);
    expect(isAllowedResourceUrl("http://t.example/a.png", true)).toBe(true);
    expect(isAllowedResourceUrl("//t.example/a.png", true)).toBe(true);
  });

  it.each([
    "/api/messages/INBOX/1",
    "api/messages/INBOX/1",
    "../api/auth/session",
    "?x=1",
    `${self}/api/messages/INBOX/1`,
    `//${window.location.host}/api/messages/INBOX/1`,
    `${window.location.protocol}api/messages`,
    " \t/api/x",
    "javascript:alert(1)",
    "ftp://t.example/a.png",
  ])("never allows %s, which would hit the app itself or is not http(s)", (url) => {
    expect(isAllowedResourceUrl(url, true)).toBe(false);
  });
});

describe("filterCssUrls", () => {
  const allowRemote = (css: string) => filterCssUrls(css, (url) => isAllowedResourceUrl(url, true));
  const blockRemote = (css: string) => filterCssUrls(css, (url) => isAllowedResourceUrl(url, false));

  it("keeps allowed URLs and other CSS unchanged", () => {
    const css = 'p { color: red; content: "/api/x"; background: url(https://t.example/a.png) } svg { fill: url(#g) } i { background: url("data:image/png;base64,AA") }';
    expect(allowRemote(css)).toBe(css);
  });

  it.each([
    ["unquoted url()", "a { background: url(/api/x) }"],
    ["quoted url()", 'a { background: url( "/api/x" ) }'],
    ["escaped function name", "a { background: u\\72l(/api/x) }"],
    ["upper-case function name", "a { background: URL(/api/x) }"],
    ["escaped URL", "a { background: url(\\2f api/x) }"],
    ["same origin", `a { background: url(${self}/api/x) }`],
    ["image-set() string", 'a { background-image: image-set("/api/x" 1x) }'],
    ["-webkit-image-set()", 'a { background-image: -webkit-image-set(url(/api/x) 1x) }'],
    ["font-face src", "@font-face { font-family: x; src: url(/api/x) format('woff') }"],
  ])("neutralizes a relative or same-origin %s", (_name, css) => {
    const out = allowRemote(css);
    expect(out).toContain("about:invalid");
    expect(out).not.toContain("api/x");
  });

  it("always neutralizes @import, whose stylesheet could load anything", () => {
    for (const css of ['@import "https://t.example/s.css";', "@import url(https://t.example/s.css) screen;", "@\\69mport 'https://t.example/s.css';"]) {
      expect(allowRemote(css)).not.toContain("t.example");
    }
    // Rules after the import are not affected.
    expect(allowRemote('@import "x.css"; p { content: "x.css" }')).toContain('p { content: "x.css" }');
  });

  it("removes every remote URL when remote content is blocked", () => {
    const css = "a { background: url(https://t.example/a.png); cursor: url('//t.example/c.cur'), auto } b { background: url(\\68ttps://t.example/b.png) }";
    expect(blockRemote(css)).not.toContain("t.example");
    expect(blockRemote("a { background: url(data:image/png;base64,AA) }")).toBe("a { background: url(data:image/png;base64,AA) }");
  });

  it("ignores URLs in comments and is not fooled by strings or escapes", () => {
    expect(allowRemote("/* url(/api/x) */ a{}")).toBe("/* url(/api/x) */ a{}");
    expect(allowRemote('a { content: "url(" } b { background: url(/api/x) }')).not.toContain("/api/x");
    expect(allowRemote("a { background: url(/api/x\\)) }")).not.toContain("/api/x");
  });

  it("handles pathological input quickly", () => {
    const started = performance.now();
    allowRemote("url(".repeat(50000));
    allowRemote("image-set(".repeat(50000) + '"/a"');
    allowRemote('"'.repeat(50000));
    allowRemote("\\".repeat(50000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("restrictResourceUrls", () => {
  function restricted(html: string, allowRemote: boolean): Document {
    const doc = parseSanitizedEmailHtml(html);
    restrictResourceUrls(doc, allowRemote);
    return doc;
  }

  it("drops relative and same-origin resources even when remote content is allowed", () => {
    const doc = restricted(`
      <img id="rel" src="/api/messages/INBOX/1">
      <img id="self" src="${self}/api/x">
      <img id="proto" src="//${window.location.host}/api/x">
      <img id="remote" src="https://t.example/a.png">
      <img id="srcset" src="https://t.example/a.png" srcset="https://t.example/a.png 1x, /api/x 2x">
      <table id="bg" background="/api/x"><tr><td>x</td></tr></table>
      <div id="styled" style="background: url('/api/x'); color: red"></div>
      <svg><rect id="fill" fill="url(/api/x#p)"></rect><rect id="grad" fill="url(#g)"></rect></svg>
      <style>p { background: url(/api/x) } q { background: url(https://t.example/q.png) }</style>`, true);
    const el = (id: string) => doc.getElementById(id)!;
    expect(el("rel").hasAttribute("src")).toBe(false);
    expect(el("self").hasAttribute("src")).toBe(false);
    expect(el("proto").hasAttribute("src")).toBe(false);
    expect(el("remote").getAttribute("src")).toBe("https://t.example/a.png");
    expect(el("srcset").hasAttribute("srcset")).toBe(false);
    expect(el("srcset").getAttribute("src")).toBe("https://t.example/a.png");
    expect(el("bg").hasAttribute("background")).toBe(false);
    expect(el("styled").getAttribute("style")).toBe("background: url('about:invalid'); color: red");
    expect(el("fill").getAttribute("fill")).toBe("url(about:invalid)");
    expect(el("grad").getAttribute("fill")).toBe("url(#g)");
    const css = doc.querySelector("style")!.textContent!;
    expect(css).not.toContain("/api/x");
    expect(css).toContain("https://t.example/q.png");
  });

  it("keeps srcsets made of data: URIs, whose commas do not split candidates", () => {
    const doc = parseEmailHtml('<img srcset="data:image/png;base64,AA 1x, data:image/png;base64,BB 2x">');
    restrictResourceUrls(doc, false);
    expect(doc.querySelector("img")!.getAttribute("srcset")).toContain("data:image/png;base64,BB 2x");
  });

  it("keeps links: relative ones are removed by the link rules instead", () => {
    const doc = restricted('<a id="rel" href="/api/logout">x</a><a id="abs" href="https://example.com">y</a>', true);
    expect(doc.getElementById("rel")!.hasAttribute("href")).toBe(false);
    expect(doc.getElementById("abs")!.getAttribute("href")).toBe("https://example.com");
  });
});

describe("sanitizeQuotedHtml remote content", () => {
  const html = `
    <style>td { background: url(https://t.example/bg.png) } @import "https://t.example/s.css";</style>
    <div style="background-image: url('https://t.example/div.png')">x</div>
    <img src="https://t.example/p.gif" alt="Logo"><img src="/api/x" alt="Rel">`;

  it("removes remote CSS URLs and imports unless remote content was allowed", () => {
    const quoted = sanitizeQuotedHtml(html, false);
    expect(quoted).not.toContain("t.example");
    expect(quoted).toContain("Logo");
  });

  it("keeps remote images on other sites when allowed, but never relative ones", () => {
    const quoted = sanitizeQuotedHtml(html, true);
    expect(quoted).toContain('src="https://t.example/p.gif"');
    expect(quoted).toContain("https://t.example/div.png");
    expect(quoted).not.toContain("/api/x");
    expect(quoted).not.toContain("s.css");
    expect(quoted).toContain("Rel");
  });
});
