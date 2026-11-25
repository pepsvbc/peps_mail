//! Content-Security-Policy for the static app.
//!
//! The Next.js static export bootstraps itself with inline `<script>`
//! elements, so `script-src` allows `'self'` plus the SHA-256 hash of every
//! inline script found in the exported HTML at startup. Nothing else runs:
//! in particular nothing from the email iframe (which is sandboxed without
//! scripts anyway, and inherits this policy because it uses `srcdoc`).
//!
//! Only scripts and plugins are restricted. Images, styles, fonts, media and
//! connections stay unrestricted on purpose: the email iframe inherits this
//! policy and has its own, stricter one for remote content, and the app needs
//! `blob:`/`data:` previews and the WebSocket.

use std::collections::BTreeSet;
use std::path::Path;

use axum::http::HeaderValue;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};

/// Directives besides `script-src`.
const OTHER_DIRECTIVES: &str =
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

/// State of the `security_headers` middleware.
#[derive(Clone)]
pub struct SecurityHeaders {
    /// Send `Strict-Transport-Security`.
    pub hsts: bool,
    /// The app-wide `Content-Security-Policy`.
    pub csp: HeaderValue,
}

impl SecurityHeaders {
    /// Build the headers for the app served from `static_dir`.
    pub fn new(hsts: bool, static_dir: &Path) -> Self {
        let csp = app_csp(&inline_script_hashes(static_dir));
        let csp = HeaderValue::from_str(&csp).expect("CSP is built from ASCII only");
        Self { hsts, csp }
    }
}

/// The app's CSP, allowing same-origin scripts and the given inline script hashes.
pub fn app_csp(hashes: &BTreeSet<String>) -> String {
    let mut script_src = String::from("script-src 'self'");
    for hash in hashes {
        script_src.push_str(" '");
        script_src.push_str(hash);
        script_src.push('\'');
    }
    format!("{script_src}; {OTHER_DIRECTIVES}")
}

/// `sha256-…` sources for every inline script in the HTML files under
/// `static_dir` (recursively). A missing directory (tests, API-only
/// deployments) yields none.
pub fn inline_script_hashes(static_dir: &Path) -> BTreeSet<String> {
    let mut hashes = BTreeSet::new();
    let mut pending = vec![static_dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("html"))
            {
                match std::fs::read_to_string(&path) {
                    Ok(html) => hashes.extend(inline_scripts(&html).iter().map(|s| script_hash(s))),
                    Err(err) => {
                        tracing::warn!(path = %path.display(), error = %err, "cannot read HTML for CSP hashes")
                    }
                }
            }
        }
    }
    hashes
}

/// CSP hash source (`sha256-<base64>`) of a script's text.
///
/// Browsers hash the element's text after HTML input preprocessing, which
/// turns CRLF and lone CR into LF, so the same is done here.
pub fn script_hash(script: &str) -> String {
    let normalized = script.replace("\r\n", "\n").replace('\r', "\n");
    format!(
        "sha256-{}",
        STANDARD.encode(Sha256::digest(normalized.as_bytes()))
    )
}

/// Text of every `<script>` element without a `src` attribute.
///
/// A small scanner for the HTML Next.js generates: it skips comments, honours
/// quoted attribute values and ends script text at `</script` followed by
/// whitespace, `/` or `>`, as the HTML tokenizer does.
pub fn inline_scripts(html: &str) -> Vec<&str> {
    let bytes = html.as_bytes();
    let mut scripts = Vec::new();
    let mut i = 0;
    while let Some(offset) = html[i..].find('<') {
        let start = i + offset;
        if html[start..].starts_with("<!--") {
            i = html[start + 4..]
                .find("-->")
                .map_or(html.len(), |end| start + 4 + end + 3);
            continue;
        }
        if !starts_with_tag(bytes, start + 1, b"script") {
            i = start + 1;
            continue;
        }
        let Some((tag_end, has_src)) = scan_start_tag(bytes, start + 7) else {
            break;
        };
        let content_end = find_script_end(bytes, tag_end).unwrap_or(html.len());
        if !has_src {
            scripts.push(&html[tag_end..content_end]);
        }
        i = content_end;
    }
    scripts
}

/// `bytes[at..]` starts with `name` (ASCII case-insensitive) followed by a tag-name terminator.
fn starts_with_tag(bytes: &[u8], at: usize, name: &[u8]) -> bool {
    bytes.len() >= at + name.len()
        && bytes[at..at + name.len()].eq_ignore_ascii_case(name)
        && bytes
            .get(at + name.len())
            .is_none_or(|b| b.is_ascii_whitespace() || *b == b'>' || *b == b'/')
}

/// Scan a start tag's attributes from `at`; returns the index after `>` and whether it has `src`.
fn scan_start_tag(bytes: &[u8], mut at: usize) -> Option<(usize, bool)> {
    let mut has_src = false;
    loop {
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b'/') {
            at += 1;
        }
        match bytes.get(at)? {
            b'>' => return Some((at + 1, has_src)),
            _ => {
                let name_start = at;
                while at < bytes.len()
                    && !bytes[at].is_ascii_whitespace()
                    && !matches!(bytes[at], b'=' | b'>' | b'/')
                {
                    at += 1;
                }
                if bytes[name_start..at].eq_ignore_ascii_case(b"src") {
                    has_src = true;
                }
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                if bytes.get(at) != Some(&b'=') {
                    continue;
                }
                at += 1;
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                match bytes.get(at)? {
                    quote @ (b'"' | b'\'') => {
                        let quote = *quote;
                        at += 1;
                        while at < bytes.len() && bytes[at] != quote {
                            at += 1;
                        }
                        at += 1;
                    }
                    _ => {
                        while at < bytes.len()
                            && !bytes[at].is_ascii_whitespace()
                            && bytes[at] != b'>'
                        {
                            at += 1;
                        }
                    }
                }
            }
        }
    }
}

/// Index of the `</script` that ends script text starting at `from`.
fn find_script_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while at + 1 < bytes.len() {
        if bytes[at] == b'<' && bytes[at + 1] == b'/' && starts_with_tag(bytes, at + 2, b"script") {
            return Some(at);
        }
        at += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn extracts_only_inline_scripts() {
        let html = concat!(
            "<!DOCTYPE html><html><head>",
            "<script src=\"/_next/static/chunks/a.js\" async=\"\"></script>",
            "<script>self.__next_f=self.__next_f||[]</script>",
            "<SCRIPT type=\"text/javascript\" data-x='a>b'>one()</SCRIPT >",
            "<!-- <script>commented()</script> -->",
            "<script\tid=\"x\" nomodule>two(\"</scriptx>\")</script>",
            "<scripts>not a script</scripts>",
            "<script src=x.js></script><script>",
            "</head></html>",
        );
        assert_eq!(
            inline_scripts(html),
            vec![
                "self.__next_f=self.__next_f||[]",
                "one()",
                "two(\"</scriptx>\")",
                "</head></html>",
            ]
        );
    }

    #[test]
    fn hashes_like_the_browser() {
        // printf '%s' "alert('Hello, world.');" | openssl dgst -sha256 -binary | base64
        assert_eq!(
            script_hash("alert('Hello, world.');"),
            "sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng="
        );
        // The HTML parser normalizes newlines before the script text is hashed.
        assert_eq!(
            script_hash("a();\r\nb();\rc();"),
            script_hash("a();\nb();\nc();")
        );
    }

    #[test]
    fn builds_script_src_from_every_html_file() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("mail/sub")).unwrap();
        std::fs::write(
            dir.path().join("index.html"),
            "<script>a()</script><script>b()</script>",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("mail/sub/page.HTML"),
            "<script>b()</script><script>c()</script>",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("mail/data.txt"),
            "<script>ignored()</script>",
        )
        .unwrap();

        let hashes = inline_script_hashes(dir.path());
        let expected: BTreeSet<String> = ["a()", "b()", "c()"]
            .iter()
            .map(|s| script_hash(s))
            .collect();
        assert_eq!(hashes, expected);

        let csp = SecurityHeaders::new(false, dir.path()).csp;
        let csp = csp.to_str().unwrap();
        assert!(csp.starts_with("script-src 'self' 'sha256-"));
        for hash in &expected {
            assert_eq!(csp.matches(hash.as_str()).count(), 1);
        }
        assert!(csp.ends_with(OTHER_DIRECTIVES));
    }

    #[test]
    fn missing_static_dir_allows_only_same_origin_scripts() {
        let csp = SecurityHeaders::new(true, Path::new("/nonexistent/peps-mail-static")).csp;
        assert_eq!(
            csp.to_str().unwrap(),
            format!("script-src 'self'; {OTHER_DIRECTIVES}")
        );
    }
}
