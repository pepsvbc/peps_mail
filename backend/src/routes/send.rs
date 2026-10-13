use std::path::Path;
use std::sync::Arc;

use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use super::drafts::validate_draft_id;
use crate::auth::session::SessionState;
use crate::config::AppConfig;
use crate::db;
use crate::error::AppError;
use crate::imap::client::{ImapClient, ImapCredentials, ImapFolder};
use crate::smtp::client::{AttachmentData, SendableMessage, SmtpClient, SmtpCredentials};

#[derive(Debug, Deserialize)]
pub struct SendRequest {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub subject: String,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    /// If sending from a draft, include the draft ID to load attachments
    /// and clean up after send.
    pub draft_id: Option<String>,
    /// Optional identity ID to use as the From address.
    /// If not provided, falls back to the session email.
    pub from_identity_id: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct SendResponse {
    pub status: String,
    pub message_id: String,
    pub sent_copy_saved: bool,
}

/// Handler for `POST /api/messages/send`.
///
/// Validates the request, sends the message via SMTP, and appends a copy
/// to the server's Sent folder, reporting copy failures separately from delivery.
pub async fn send_message_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(smtp_client): Extension<Arc<dyn SmtpClient>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Json(req): Json<SendRequest>,
) -> Result<Response, AppError> {
    if let Some(draft_id) = &req.draft_id {
        validate_draft_id(draft_id)?;
    }

    // Validate: at least one recipient.
    if req.to.is_empty() && req.cc.is_empty() && req.bcc.is_empty() {
        return Err(AppError::BadRequest(
            "At least one recipient is required".to_string(),
        ));
    }

    // Validate: subject or body must be non-empty.
    let has_subject = !req.subject.trim().is_empty();
    let has_text = req
        .text_body
        .as_deref()
        .is_some_and(|t| !t.trim().is_empty());
    let has_html = req
        .html_body
        .as_deref()
        .is_some_and(|h| !h.trim().is_empty());
    if !has_subject && !has_text && !has_html {
        return Err(AppError::BadRequest(
            "Subject or body is required".to_string(),
        ));
    }

    // Check that SMTP is configured.
    let smtp_host = config
        .smtp_host
        .as_deref()
        .ok_or_else(|| AppError::ServiceUnavailable("SMTP server not configured".to_string()))?;

    // Build SMTP credentials from config + session.
    let smtp_creds = SmtpCredentials {
        host: smtp_host.to_string(),
        port: config.smtp_port,
        tls: config.tls_enabled,
        email: session.email.clone(),
        password: session.password.clone(),
    };

    // Resolve the From address: use identity if specified, else session email.
    let from_address = if let Some(identity_id) = req.from_identity_id {
        let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
            .map_err(|e| AppError::InternalError(format!("Failed to open database: {e}")))?;
        let identity = db::identities::get_identity(&conn, identity_id)
            .map_err(AppError::InternalError)?
            .ok_or_else(|| AppError::NotFound("Identity not found".to_string()))?;
        if identity.display_name.is_empty() {
            identity.email
        } else {
            format!("\"{}\" <{}>", identity.display_name, identity.email)
        }
    } else {
        session.email.clone()
    };

    // Load attachments from draft if draft_id is provided.
    let attachments = if let Some(ref draft_id) = req.draft_id {
        load_draft_attachments(&config.data_dir, &session.user_hash, draft_id)?
    } else {
        vec![]
    };

    // Build the sendable message.
    let message = SendableMessage {
        from: from_address,
        to: req.to,
        cc: req.cc,
        bcc: req.bcc,
        subject: req.subject,
        text_body: req.text_body.unwrap_or_default(),
        html_body: req.html_body,
        in_reply_to: req.in_reply_to,
        references: req.references,
        attachments,
    };

    // Send via SMTP.
    let message_id = smtp_client
        .send_message(&smtp_creds, &message)
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("Failed to send email: {e}")))?;

    // SMTP has already accepted the message. Never report a send failure or
    // retry SMTP if saving the Sent copy fails: that could cause duplicate mail.
    let sent_copy_saved = match save_sent_copy(
        imap_client.as_ref(),
        &session,
        &config,
        &message,
        &message_id,
    )
    .await
    {
        Ok(folder) => {
            if let Err(error) = invalidate_sent_cache(&config, &session, &folder) {
                tracing::warn!(%error, "Sent copy saved, but cache invalidation failed");
            }
            true
        }
        Err(error) => {
            tracing::warn!(%error, "Message sent, but failed to save IMAP Sent copy");
            false
        }
    };

    // Clean up draft and attachment files after successful send.
    if let Some(ref draft_id) = req.draft_id {
        cleanup_draft(&config.data_dir, &session.user_hash, draft_id).await;
    }

    Ok(Json(SendResponse {
        status: "sent".to_string(),
        message_id,
        sent_copy_saved,
    })
    .into_response())
}

/// Prefer the server's special-use folder; legacy servers may only expose names.
fn find_sent_folder(folders: &[ImapFolder]) -> Option<&ImapFolder> {
    let selectable = |folder: &&ImapFolder| {
        !folder
            .attributes
            .iter()
            .any(|flag| flag.eq_ignore_ascii_case("\\Noselect"))
    };
    folders
        .iter()
        .filter(selectable)
        .find(|folder| {
            folder
                .attributes
                .iter()
                .any(|flag| flag.eq_ignore_ascii_case("\\Sent"))
        })
        .or_else(|| {
            folders
                .iter()
                .filter(selectable)
                .find(|folder| folder.name.eq_ignore_ascii_case("Sent"))
        })
        .or_else(|| {
            folders.iter().filter(selectable).find(|folder| {
                let name = folder
                    .delimiter
                    .as_deref()
                    .filter(|delimiter| !delimiter.is_empty())
                    .and_then(|delimiter| folder.name.rsplit(delimiter).next())
                    .unwrap_or(&folder.name);
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    "sent" | "sent mail" | "sent items" | "sent messages"
                )
            })
        })
}

async fn save_sent_copy(
    imap_client: &dyn ImapClient,
    session: &SessionState,
    config: &AppConfig,
    message: &SendableMessage,
    message_id: &str,
) -> Result<ImapFolder, String> {
    let creds = ImapCredentials {
        host: config
            .imap_host
            .clone()
            .ok_or("IMAP server not configured")?,
        port: config.imap_port,
        tls: config.tls_enabled,
        email: session.email.clone(),
        password: session.password.clone(),
    };
    let bytes = build_rfc822_bytes(message, message_id)?;
    let folders = imap_client
        .list_folders(&creds)
        .await
        .map_err(|error| error.to_string())?;
    let folder = if let Some(folder) = find_sent_folder(&folders) {
        folder.clone()
    } else {
        imap_client
            .create_folder(&creds, "Sent")
            .await
            .map_err(|error| error.to_string())?;
        ImapFolder {
            name: "Sent".to_string(),
            delimiter: None,
            attributes: vec![],
        }
    };
    imap_client
        .append_message(&creds, &folder.name, &bytes, &["\\Seen"])
        .await
        .map_err(|error| error.to_string())?;
    Ok(folder)
}

fn invalidate_sent_cache(
    config: &AppConfig,
    session: &SessionState,
    folder: &ImapFolder,
) -> Result<(), String> {
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)?;
    db::folders::insert_folder_if_new(
        &conn,
        &folder.name,
        folder.delimiter.as_deref(),
        &folder.attributes.join(","),
    )?;
    db::folders::invalidate_folder_freshness(&conn, &folder.name)
}

/// Load attachment data from disk for a given draft.
fn load_draft_attachments(
    data_dir: &str,
    user_hash: &str,
    draft_id: &str,
) -> Result<Vec<AttachmentData>, AppError> {
    let conn = db::pool::open_user_db(data_dir, user_hash)
        .map_err(|e| AppError::InternalError(format!("Failed to open database: {e}")))?;

    let db_attachments =
        db::drafts::get_draft_attachments(&conn, draft_id).map_err(AppError::InternalError)?;

    let mut attachments = Vec::new();
    for att in db_attachments {
        let data = std::fs::read(&att.file_path).map_err(|e| {
            AppError::InternalError(format!(
                "Failed to read attachment file '{}': {e}",
                att.filename
            ))
        })?;
        attachments.push(AttachmentData {
            filename: att.filename,
            content_type: att.content_type,
            data,
            content_id: Some(att.id),
        });
    }
    Ok(attachments)
}

/// Clean up draft record and attachment files from disk after successful send.
async fn cleanup_draft(data_dir: &str, user_hash: &str, draft_id: &str) {
    // Delete draft from DB (cascade deletes attachment records).
    if let Ok(conn) = db::pool::open_user_db(data_dir, user_hash)
        && let Err(e) = db::drafts::delete_draft(&conn, draft_id)
    {
        tracing::warn!(error = %e, "Failed to delete draft after send");
    }

    // Remove the attachment directory from disk.
    let att_dir = Path::new(data_dir)
        .join(user_hash)
        .join("attachments")
        .join(draft_id);
    if att_dir.exists()
        && let Err(e) = tokio::fs::remove_dir_all(&att_dir).await
    {
        tracing::warn!(error = %e, path = %att_dir.display(), "Failed to clean up attachment directory");
    }
}

/// Build RFC822 bytes from a SendableMessage for IMAP APPEND.
fn build_rfc822_bytes(message: &SendableMessage, message_id: &str) -> Result<Vec<u8>, String> {
    use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType};

    let from_mailbox: Mailbox = message
        .from
        .parse()
        .map_err(|e: lettre::address::AddressError| e.to_string())?;

    let mut builder = lettre::Message::builder()
        .from(from_mailbox)
        .subject(&message.subject)
        .message_id(Some(message_id.to_string()));

    for addr in &message.to {
        let mailbox: Mailbox = addr
            .parse()
            .map_err(|e: lettre::address::AddressError| e.to_string())?;
        builder = builder.to(mailbox);
    }
    for addr in &message.cc {
        let mailbox: Mailbox = addr
            .parse()
            .map_err(|e: lettre::address::AddressError| e.to_string())?;
        builder = builder.cc(mailbox);
    }
    // The builder needs envelope recipients even for Bcc-only messages.
    // Lettre removes the Bcc header when serializing, as it does for SMTP.
    for addr in &message.bcc {
        let mailbox: Mailbox = addr
            .parse()
            .map_err(|e: lettre::address::AddressError| e.to_string())?;
        builder = builder.bcc(mailbox);
    }
    if let Some(ref irt) = message.in_reply_to {
        builder = builder.in_reply_to(irt.clone());
    }
    if let Some(ref refs) = message.references {
        builder = builder.references(refs.clone());
    }

    // Separate inline images from regular file attachments.
    let html_body = message.html_body.as_deref().unwrap_or("");
    let (inline_atts, file_atts): (Vec<_>, Vec<_>) = message.attachments.iter().partition(|att| {
        att.content_id
            .as_ref()
            .is_some_and(|cid| html_body.contains(&format!("cid:{cid}")))
    });

    let body_part = if let Some(ref html) = message.html_body {
        if inline_atts.is_empty() {
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .content_type(ContentType::TEXT_PLAIN)
                        .body(message.text_body.clone()),
                )
                .singlepart(
                    SinglePart::builder()
                        .content_type(ContentType::TEXT_HTML)
                        .body(html.clone()),
                )
        } else {
            let mut related = MultiPart::related().singlepart(
                SinglePart::builder()
                    .content_type(ContentType::TEXT_HTML)
                    .body(html.clone()),
            );
            for att in &inline_atts {
                let ct: ContentType = att.content_type.parse().unwrap_or(ContentType::TEXT_PLAIN);
                let cid = att.content_id.as_deref().unwrap_or("unknown");
                let inline_part =
                    Attachment::new_inline(cid.to_string()).body(att.data.clone(), ct);
                related = related.singlepart(inline_part);
            }

            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .content_type(ContentType::TEXT_PLAIN)
                        .body(message.text_body.clone()),
                )
                .multipart(related)
        }
    } else {
        MultiPart::alternative().singlepart(
            SinglePart::builder()
                .content_type(ContentType::TEXT_PLAIN)
                .body(message.text_body.clone()),
        )
    };

    // Wrap in mixed multipart if there are file attachments.
    let email = if file_atts.is_empty() {
        builder.multipart(body_part).map_err(|e| e.to_string())?
    } else {
        let mut mixed = MultiPart::mixed().multipart(body_part);
        for att in &file_atts {
            let ct: ContentType = att.content_type.parse().unwrap_or(ContentType::TEXT_PLAIN);
            let attachment = Attachment::new(att.filename.clone()).body(att.data.clone(), ct);
            mixed = mixed.singlepart(attachment);
        }
        builder.multipart(mixed).map_err(|e| e.to_string())?
    };

    Ok(email.formatted())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sent_copy_can_be_built_for_bcc_only_mail() {
        let message = SendableMessage {
            from: "alice@example.com".to_string(),
            to: vec![],
            cc: vec![],
            bcc: vec!["bob@example.com".to_string()],
            subject: "Hello".to_string(),
            text_body: "Hi Bob".to_string(),
            html_body: None,
            in_reply_to: None,
            references: None,
            attachments: vec![],
        };
        let bytes = build_rfc822_bytes(&message, "<bcc@example.com>").unwrap();
        let raw = String::from_utf8(bytes).unwrap();
        assert!(raw.contains("<bcc@example.com>"));
        assert!(raw.contains("Hi Bob"));
        assert!(!raw.contains("Bcc:"));
    }
}
