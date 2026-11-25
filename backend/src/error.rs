use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Structured JSON error envelope returned to clients.
#[derive(Debug, Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

/// Body of the error envelope.
#[derive(Debug, Serialize)]
struct ErrorBody {
    code: String,
    message: String,
    status: u16,
}

/// Client-facing text for 500 responses whose detail stays in the logs.
/// The frontend already localizes this string.
pub const GENERIC_INTERNAL_MESSAGE: &str = "An unexpected error occurred";

/// Client-facing text for 503 responses whose detail stays in the logs.
/// The frontend already localizes this string.
pub const GENERIC_UNAVAILABLE_MESSAGE: &str = "Unable to reach the mail server";

/// Fixed server-error messages that reveal nothing about internals and that
/// the frontend shows (and translates) as-is. Every other 5xx message is
/// replaced by a generic one.
const PUBLIC_SERVER_MESSAGES: &[&str] = &[
    "Mail server not configured",
    "IMAP server not configured",
    "SMTP server not configured",
    "Secure mail setup is not configured on this server.",
    "No Drafts folder found; draft retained locally",
];

/// Application-level error type that converts into an Axum response
/// with a structured JSON error envelope.
///
/// 4xx messages are user-facing validation text and are returned verbatim.
/// 5xx messages often embed IMAP server replies, SQLite or I/O errors, so
/// they are logged server-side and replaced by a generic message (unless the
/// variant is explicitly public, or the text is in `PUBLIC_SERVER_MESSAGES`).
#[derive(Debug)]
#[allow(dead_code)]
pub enum AppError {
    /// Internal server error (500). Message is logged, not returned.
    InternalError(String),
    /// Resource not found (404).
    NotFound(String),
    /// Unauthorized access (401).
    Unauthorized(String),
    /// Bad request (400).
    BadRequest(String),
    /// Forbidden (403).
    Forbidden(String),
    /// Service unavailable (503). Message is logged, not returned.
    ServiceUnavailable(String),
    /// Too many requests (429).
    TooManyRequests(String),
    /// Service unavailable (503) whose message was written for the user and
    /// is safe to return, e.g. the reason the mail server refused a message.
    MailServerRejected(String),
}

impl AppError {
    /// Returns the HTTP status code for this error variant.
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::InternalError(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::ServiceUnavailable(_) | AppError::MailServerRejected(_) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            AppError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
        }
    }

    /// Returns the error code string for this error variant.
    fn error_code(&self) -> &'static str {
        match self {
            AppError::InternalError(_) => "INTERNAL_ERROR",
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::Unauthorized(_) => "UNAUTHORIZED",
            AppError::BadRequest(_) => "BAD_REQUEST",
            AppError::Forbidden(_) => "FORBIDDEN",
            AppError::ServiceUnavailable(_) | AppError::MailServerRejected(_) => {
                "SERVICE_UNAVAILABLE"
            }
            AppError::TooManyRequests(_) => "TOO_MANY_REQUESTS",
        }
    }

    /// Returns the detailed message for this error variant (for logs).
    fn message(&self) -> &str {
        match self {
            AppError::InternalError(msg)
            | AppError::NotFound(msg)
            | AppError::Unauthorized(msg)
            | AppError::BadRequest(msg)
            | AppError::Forbidden(msg)
            | AppError::ServiceUnavailable(msg)
            | AppError::TooManyRequests(msg)
            | AppError::MailServerRejected(msg) => msg,
        }
    }

    /// Returns the message that may be shown to the client.
    fn public_message(&self) -> &str {
        let msg = self.message();
        match self {
            AppError::InternalError(_) if !PUBLIC_SERVER_MESSAGES.contains(&msg) => {
                GENERIC_INTERNAL_MESSAGE
            }
            AppError::ServiceUnavailable(_) if !PUBLIC_SERVER_MESSAGES.contains(&msg) => {
                GENERIC_UNAVAILABLE_MESSAGE
            }
            _ => msg,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let code = self.error_code();
        let public = self.public_message();
        if public != self.message() {
            // The detail is withheld from the client; keep it for operators.
            if status.is_server_error() && status != StatusCode::SERVICE_UNAVAILABLE {
                tracing::error!(status = status.as_u16(), code, detail = %self.message(), "Request failed");
            } else {
                tracing::warn!(status = status.as_u16(), code, detail = %self.message(), "Request failed");
            }
        }
        let envelope = ErrorEnvelope {
            error: ErrorBody {
                code: code.to_string(),
                message: public.to_string(),
                status: status.as_u16(),
            },
        };

        let body = serde_json::to_string(&envelope).unwrap_or_else(|_| {
            r#"{"error":{"code":"INTERNAL_ERROR","message":"Failed to serialize error","status":500}}"#
                .to_string()
        });

        (status, [("content-type", "application/json")], body).into_response()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.error_code(), self.message())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn error_to_json(error: AppError) -> (StatusCode, serde_json::Value) {
        let response = error.into_response();
        let status = response.status();
        let body = response.into_body()
            .collect()
            .await
            .expect("body should collect")
            .to_bytes();
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("body should be valid JSON");
        (status, json)
    }

    #[tokio::test]
    async fn internal_error_returns_500_without_detail() {
        let (status, json) = error_to_json(AppError::InternalError(
            "Database error: no such table: secrets at /data/abc/db.sqlite".into(),
        ))
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(json["error"]["code"], "INTERNAL_ERROR");
        assert_eq!(json["error"]["message"], GENERIC_INTERNAL_MESSAGE);
        assert_eq!(json["error"]["status"], 500);
    }

    #[tokio::test]
    async fn not_found_returns_404() {
        let (status, json) = error_to_json(AppError::NotFound("mailbox missing".into())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json["error"]["code"], "NOT_FOUND");
        assert_eq!(json["error"]["message"], "mailbox missing");
        assert_eq!(json["error"]["status"], 404);
    }

    #[tokio::test]
    async fn unauthorized_returns_401() {
        let (status, json) = error_to_json(AppError::Unauthorized("bad token".into())).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"]["code"], "UNAUTHORIZED");
        assert_eq!(json["error"]["message"], "bad token");
        assert_eq!(json["error"]["status"], 401);
    }

    #[tokio::test]
    async fn bad_request_returns_400() {
        let (status, json) = error_to_json(AppError::BadRequest("invalid input".into())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"]["code"], "BAD_REQUEST");
        assert_eq!(json["error"]["message"], "invalid input");
        assert_eq!(json["error"]["status"], 400);
    }

    #[tokio::test]
    async fn service_unavailable_returns_503_without_detail() {
        let (status, json) = error_to_json(AppError::ServiceUnavailable(
            "IMAP error: Protocol error: NO [SERVERBUG] internal error at 10.0.0.5".into(),
        ))
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json["error"]["code"], "SERVICE_UNAVAILABLE");
        assert_eq!(json["error"]["message"], GENERIC_UNAVAILABLE_MESSAGE);
        assert_eq!(json["error"]["status"], 503);
    }

    #[tokio::test]
    async fn known_safe_server_messages_are_kept() {
        let (_, json) = error_to_json(AppError::ServiceUnavailable(
            "Secure mail setup is not configured on this server.".into(),
        ))
        .await;
        assert_eq!(
            json["error"]["message"],
            "Secure mail setup is not configured on this server."
        );
    }

    #[tokio::test]
    async fn explicitly_public_variants_keep_their_message() {
        let (status, json) =
            error_to_json(AppError::MailServerRejected("relay denied".into())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(json["error"]["message"], "relay denied");

        let (status, json) =
            error_to_json(AppError::TooManyRequests("slow down".into())).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(json["error"]["code"], "TOO_MANY_REQUESTS");
        assert_eq!(json["error"]["message"], "slow down");
    }
}
