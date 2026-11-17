import { describe, expect, it } from "vitest";
import {
  cssHasRemoteUrl,
  documentHasRemoteResources,
  escapeHtml,
  isSafeCssColor,
  isSafeLinkHref,
  parseEmailHtml,
  sanitizeEmailDocument,
  sanitizeQuotedHtml,
  stripRemoteResources,
} from "../email-html";

function hasRemote(html: string): boolean {
  const doc = parseEmailHtml(html);
  sanitizeEmailDocument(doc);
  return documentHasRemoteResources(doc);
}

function sanitize(html: string): Document {
  const doc = parseEmailHtml(html);
  sanitizeEmailDocument(doc);
  return doc;
}

describe("remote resource detection", () => {
  it.each([
    ["unquoted src", "<img src=https://t.example/p.gif>"],
    ["protocol-relative src", '<img src="//t.example/p.gif">'],
    ["whitespace-obfuscated scheme", '<img src=" ht\ttps://t.example/p.gif">'],
    ["srcset", '<img srcset="a.png 1x, https://t.example/b.png 2x">'],
    ["picture source", '<picture><source srcset="https://t.example/a.webp"><img src="data:image/png;base64,AA"></picture>'],
    ["background attribute", '<table background="https://t.example/bg.png"><tr><td>x</td></tr></table>'],
    ["video poster", '<video poster="https://t.example/poster.png"></video>'],
    ["input image", '<input type="image" src="https://t.example/btn.png">'],
    ["svg image", '<svg><image href="https://t.example/i.png"/></svg>'],
    ["svg xlink image", '<svg><image xlink:href="https://t.example/i.png"/></svg>'],
    ["stylesheet link", '<link rel="stylesheet" href="https://t.example/s.css">'],
    ["@import", '<style>@import "https://t.example/s.css";</style>'],
    ["url() in style element", "<style>td { background: url(https://t.example/bg.png) }</style>"],
    ["url() in style attribute", "<div style=\"background-image: url('//t.example/bg.png')\"></div>"],
    ["CSS escapes", "<div style=\"background: url(\\68ttps://t.example/bg.png)\"></div>"],
    ["image-set()", '<div style="background-image: image-set(&quot;https://t.example/a.png&quot; 1x)"></div>'],
  ])("detects %s", (_name, html) => {
    expect(hasRemote(html)).toBe(true);
  });

  it.each([
    ["data: image", '<img src="data:image/png;base64,AAAA">'],
    ["cid: image", '<img src="cid:logo@example">'],
    ["plain links", '<a href="https://example.com">site</a>'],
    ["fragment url() in CSS", '<svg><rect style="fill: url(#grad)"/></svg>'],
    ["removed iframe", '<iframe src="https://t.example/frame"></iframe>'],
    ["removed dns-prefetch link", '<link rel="dns-prefetch" href="//t.example">'],
  ])("ignores %s", (_name, html) => {
    expect(hasRemote(html)).toBe(false);
  });

  it("decodes escapes before matching CSS", () => {
    expect(cssHasRemoteUrl("a { background: url(\\2f\\2ft.example/x.png) }")).toBe(true);
    expect(cssHasRemoteUrl("a { color: red }")).toBe(false);
  });
});

describe("sanitizeEmailDocument", () => {
  it("removes active content and event handlers", () => {
    const doc = sanitize(`
      <head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example"></head>
      <body onload="x()">
        <script>alert(1)</script>
        <iframe src="https://evil.example"></iframe>
        <object data="x"></object><embed src="x">
        <form action="https://evil.example"><input name="q"><button formaction="https://evil.example">Go</button></form>
        <img src="data:image/png;base64,AA" onerror="alert(1)">
      </body>`);
    expect(doc.querySelector("script, iframe, object, embed, base, meta, form")).toBeNull();
    expect(doc.body.hasAttribute("onload")).toBe(false);
    expect(doc.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(doc.querySelector("button")?.hasAttribute("formaction")).toBe(false);
    // Form contents stay visible
    expect(doc.querySelector("input[name=q]")).not.toBeNull();
  });

  it("keeps only http(s), mailto and fragment links and opens them in a new tab", () => {
    const doc = sanitize(`
      <a id="web" href="https://example.com">web</a>
      <a id="mail" href="mailto:a@example.com">mail</a>
      <a id="frag" href="#top">top</a>
      <a id="js" href=" java&#9;script:alert(1)">js</a>
      <a id="data" href="data:text/html,<script>alert(1)</script>">data</a>
      <a id="rel" href="/api/logout">relative</a>
      <a id="proto" href="//example.com/x">proto</a>
      <a id="ping" href="https://example.com" ping="https://t.example/ping">ping</a>`);
    const link = (id: string) => doc.getElementById(id)!;
    expect(link("web").getAttribute("target")).toBe("_blank");
    expect(link("web").getAttribute("rel")).toBe("noopener noreferrer");
    expect(link("mail").getAttribute("href")).toBe("mailto:a@example.com");
    expect(link("frag").getAttribute("href")).toBe("#top");
    expect(link("frag").hasAttribute("target")).toBe(false);
    expect(link("js").hasAttribute("href")).toBe(false);
    expect(link("data").hasAttribute("href")).toBe(false);
    expect(link("rel").hasAttribute("href")).toBe(false);
    expect(link("proto").getAttribute("href")).toBe("https://example.com/x");
    expect(link("ping").hasAttribute("ping")).toBe(false);
  });

  it("removes SVG animations that rewrite link targets", () => {
    const doc = sanitize('<svg><a href="https://example.com"><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>');
    expect(doc.querySelector("animate")).toBeNull();
  });
});

describe("stripRemoteResources", () => {
  it("removes remote URLs but keeps embedded images", () => {
    const doc = sanitize(`
      <img id="remote" src="https://t.example/p.gif" srcset="https://t.example/p2.gif 2x">
      <img id="inline" src="data:image/png;base64,AAAA">
      <img id="cid" src="cid:logo">
      <td id="bg" background="//t.example/bg.png"></td>
      <video id="video" poster="https://t.example/poster.png"></video>`);
    stripRemoteResources(doc);
    expect(doc.getElementById("remote")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("remote")?.hasAttribute("srcset")).toBe(false);
    expect(doc.getElementById("inline")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(doc.getElementById("cid")?.getAttribute("src")).toBe("cid:logo");
    expect(doc.getElementById("video")?.hasAttribute("poster")).toBe(false);
  });
});

describe("sanitizeQuotedHtml", () => {
  const html = '<p>Hi</p><img src="https://t.example/p.gif" alt="Logo"><img src="https://t.example/q.gif"><img src="data:image/png;base64,AAAA"><a href="javascript:alert(1)">x</a>';

  it("replaces remote images with their alt text unless remote content is allowed", () => {
    const blocked = sanitizeQuotedHtml(html, false);
    expect(blocked).not.toContain("t.example");
    expect(blocked).toContain("Logo");
    expect(blocked).toContain('src="data:image/png;base64,AAAA"');
    expect(blocked).not.toContain("javascript:");

    const allowed = sanitizeQuotedHtml(html, true);
    expect(allowed).toContain('src="https://t.example/p.gif"');
    expect(allowed).not.toContain("javascript:");
  });

  it("drops the email's head and scripts", () => {
    const quoted = sanitizeQuotedHtml("<html><head><title>T</title><script>x()</script></head><body><p>Body</p></body></html>", false);
    expect(quoted).toBe("<p>Body</p>");
  });
});

describe("small validators", () => {
  it("accepts only plain CSS colours", () => {
    for (const ok of ["#fff", "#A1B2C3", "rgb(1, 2, 3)", "rgba(1,2,3,0.5)", "hsl(120deg 50% 50%)", "white", "transparent"]) {
      expect(isSafeCssColor(ok)).toBe(true);
    }
    for (const bad of ["red}</style><img src=x>", "url(https://t.example)", "red; background: url(x)", "rgb(1,2,3) }", "#fff;"]) {
      expect(isSafeCssColor(bad)).toBe(false);
    }
  });

  it("checks link schemes after URL normalisation", () => {
    expect(isSafeLinkHref("https://example.com")).toBe(true);
    expect(isSafeLinkHref("MAILTO:a@example.com")).toBe(true);
    expect(isSafeLinkHref("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("java\nscript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("https:evil.example")).toBe(false);
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<b a="1">'&'</b>`)).toBe("&lt;b a=&quot;1&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;");
  });
});
