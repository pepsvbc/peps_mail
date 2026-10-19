use axum::body::Body;
use axum::http::HeaderValue;
use axum::response::Response;

use crate::error::AppError;

/// Untrusted mail and uploaded attachments must never execute in the webmail
/// origin. Only passive preview formats may render inline; all responses are
/// sandboxed as a second boundary, including direct navigation to their URLs.
pub(super) fn attachment_response(
    content_type: &str,
    filename: &str,
    data: Vec<u8>,
) -> Result<Response, AppError> {
    let content_type = HeaderValue::from_str(content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let media_type = content_type
        .to_str()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let inline = matches!(
        media_type.as_str(),
        "application/pdf"
            | "text/plain"
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "image/bmp"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    );
    let disposition = if inline { "inline" } else { "attachment" };

    // Keep the quoted fallback ASCII and free of header delimiters, while
    // preserving the original Unicode filename in the RFC 5987 parameter.
    let fallback: String = filename
        .chars()
        .map(|c| {
            if (c.is_ascii_graphic() && !matches!(c, '"' | '\\')) || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = filename
        .bytes()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    let disposition = format!("{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}");

    Response::builder()
        .header("content-type", content_type)
        .header("content-disposition", disposition)
        .header(
            "content-security-policy",
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
        )
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .body(Body::from(data))
        .map_err(|e| AppError::InternalError(format!("Failed to build attachment response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_content_is_downloaded_and_sandboxed() {
        for content_type in [
            "text/html",
            "Text/HTML; charset=utf-8",
            "image/svg+xml",
            "IMAGE/SVG+XML",
            "application/xhtml+xml",
            "text/xml",
        ] {
            let response = attachment_response(
                content_type,
                "untrusted.html",
                b"<script>alert(1)</script>".to_vec(),
            )
            .unwrap();
            assert!(
                response.headers()["content-disposition"]
                    .to_str()
                    .unwrap()
                    .starts_with("attachment;"),
                "{content_type}"
            );
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert!(
                response.headers()["content-security-policy"]
                    .to_str()
                    .unwrap()
                    .starts_with("sandbox;")
            );
        }
    }

    #[test]
    fn passive_types_still_preview_inline() {
        for content_type in [
            "application/pdf",
            "IMAGE/PNG",
            "image/jpeg",
            "text/plain; charset=utf-8",
        ] {
            let response = attachment_response(content_type, "preview", vec![]).unwrap();
            assert!(
                response.headers()["content-disposition"]
                    .to_str()
                    .unwrap()
                    .starts_with("inline;"),
                "{content_type}"
            );
        }
    }

    #[test]
    fn malformed_metadata_cannot_inject_headers_or_panic() {
        let response = attachment_response(
            "text/html\r\nx-bad: injected",
            "résumé\"\r\nx-bad: injected.txt",
            vec![],
        )
        .unwrap();
        assert_eq!(
            response.headers()["content-type"],
            "application/octet-stream"
        );
        assert!(!response.headers().contains_key("x-bad"));
        let disposition = response.headers()["content-disposition"].to_str().unwrap();
        assert!(disposition.contains("filename*=UTF-8''%72%C3%A9"));
        assert!(!disposition.contains('\r'));
        assert!(!disposition.contains('\n'));
    }
}
