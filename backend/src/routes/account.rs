use std::sync::Arc;

use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Serialize;

use crate::auth::session::SessionState;
use crate::error::AppError;
use crate::imap::client::{ImapClient, ImapCredentials};

#[derive(Serialize)]
struct UnreadResponse {
    inbox_unread_count: u32,
}

/// `GET /api/account/unread`
///
/// Read the authenticated account's Inbox count directly from IMAP. Other
/// accounts may not have a populated message cache yet, so cached folder counts
/// cannot reliably show their unread mail.
pub async fn get_unread(
    Extension(session): Extension<SessionState>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
) -> Result<Response, AppError> {
    let creds = ImapCredentials {
        host: session.imap_host,
        port: session.imap_port,
        tls: session.imap_tls,
        email: session.email,
        password: session.password,
    };
    let inbox_unread_count = imap_client
        .folder_unread_count(&creds, "INBOX")
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("IMAP error: {e}")))?;

    Ok(Json(UnreadResponse { inbox_unread_count }).into_response())
}
