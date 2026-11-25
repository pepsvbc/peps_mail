use std::num::NonZeroU32;
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use serde::{Deserialize, Serialize};

use super::drafts::validate_draft_id;
use crate::auth::session::SessionState;
use crate::config::AppConfig;
use crate::db;
use crate::error::AppError;
use crate::imap::client::{ImapClient, ImapCredentials, ImapFolder};
use crate::smtp::client::{
    AttachmentData, MAX_RECIPIENTS, SendableMessage, SmtpClient, SmtpCredentials, SmtpError,
};

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
    pub draft_removed: bool,
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

    let _draft_guard = if let Some(id) = &req.draft_id {
        Some(super::draft_sync::lock(&session.user_hash, id).await)
    } else {
        None
    };

    // Validate: at least one recipient, and not a bulk mailing.
    if req.to.is_empty() && req.cc.is_empty() && req.bcc.is_empty() {
        return Err(AppError::BadRequest(
            "At least one recipient is required".to_string(),
        ));
    }
    let recipient_count = check_recipients(&req.to, &req.cc, &req.bcc)?;

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
        // Re-checked here so identities saved before the checks existed can't be used.
        crate::routes::identities::ensure_sender_allowed(&config, &session, &identity.email)?;
        crate::routes::identities::validate_display_name(&identity.display_name)?;
        if identity.display_name.is_empty() {
            identity.email
        } else {
            // Let lettre quote the display name so it can't smuggle in another address.
            let address: lettre::Address = identity
                .email
                .trim()
                .parse()
                .map_err(|_| AppError::BadRequest("Identity email is invalid".to_string()))?;
            lettre::message::Mailbox::new(Some(identity.display_name), address).to_string()
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

    // Charge the per-account budget only once the request is known to be
    // well-formed, immediately before handing it to SMTP.
    check_send_rate(&session.email, recipient_count)?;

    // Send via SMTP.
    let message_id = smtp_client
        .send_message(&smtp_creds, &message)
        .await
        .map_err(smtp_error_to_app_error)?;

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

    // Never report SMTP failure if only post-send draft cleanup fails.
    let draft_removed = if let Some(ref draft_id) = req.draft_id {
        match super::draft_sync::sync(&session, &config, imap_client.as_ref(), draft_id, None).await
        {
            Ok(()) => {
                cleanup_draft(&config.data_dir, &session.user_hash, draft_id).await;
                true
            }
            Err(error) => {
                tracing::warn!(%error, "Message sent but original draft could not be removed; retained for retry");
                false
            }
        }
    } else {
        true
    };

    Ok(Json(SendResponse {
        status: "sent".to_string(),
        message_id,
        sent_copy_saved,
        draft_removed,
    })
    .into_response())
}

// ---------------------------------------------------------------------------
// Sending limits
// ---------------------------------------------------------------------------

/// Per-account sending budget, so a stolen session can't turn the account
/// into a bulk relay. Kept in memory and keyed by the mailbox address, so it
/// is shared by every session of that mailbox.
struct SendLimiter {
    messages: DefaultKeyedRateLimiter<String>,
    recipients: DefaultKeyedRateLimiter<String>,
}

impl SendLimiter {
    fn new() -> Self {
        // Messages: a burst of 30, refilled at one every 20 s
        // (30 per 10 minutes sustained).
        let messages = Quota::with_period(Duration::from_secs(20))
            .expect("non-zero period")
            .allow_burst(NonZeroU32::new(30).expect("non-zero"));
        // Recipients: a burst of 1000 (two sends to a full 500-member list),
        // refilled at one every 4 s (900 per hour sustained).
        let recipients = Quota::with_period(Duration::from_secs(4))
            .expect("non-zero period")
            .allow_burst(NonZeroU32::new(1000).expect("non-zero"));
        Self {
            messages: RateLimiter::keyed(messages),
            recipients: RateLimiter::keyed(recipients),
        }
    }

    fn check(&self, email: &str, recipients: usize) -> Result<(), AppError> {
        let key = email.trim().to_lowercase();
        let limited = || {
            AppError::TooManyRequests(
                "Sending limit reached for this account. Please wait a few minutes and try again."
                    .to_string(),
            )
        };
        self.messages.check_key(&key).map_err(|_| limited())?;
        let n = NonZeroU32::new(u32::try_from(recipients.max(1)).unwrap_or(u32::MAX))
            .expect("non-zero");
        match self.recipients.check_key_n(&key, n) {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => return Err(limited()),
        }
        // Forget accounts whose budget has fully refilled.
        if self.messages.len() > 10_000 {
            self.messages.retain_recent();
            self.recipients.retain_recent();
        }
        Ok(())
    }
}

static SEND_LIMITS: LazyLock<SendLimiter> = LazyLock::new(SendLimiter::new);

fn check_send_rate(email: &str, recipients: usize) -> Result<(), AppError> {
    SEND_LIMITS.check(email, recipients)
}

/// Enforce the per-message recipient cap and reject unparseable addresses
/// up front with a 400. Returns the total number of recipients.
fn check_recipients(to: &[String], cc: &[String], bcc: &[String]) -> Result<usize, AppError> {
    let total = to.len() + cc.len() + bcc.len();
    if total > MAX_RECIPIENTS {
        return Err(AppError::BadRequest(format!(
            "A message can have at most {MAX_RECIPIENTS} recipients (To, Cc and Bcc combined)"
        )));
    }
    for address in to.iter().chain(cc).chain(bcc) {
        if address.parse::<lettre::message::Mailbox>().is_err() {
            let shown: String = address.chars().take(100).collect();
            return Err(AppError::BadRequest(format!(
                "Invalid recipient address: {shown}"
            )));
        }
    }
    Ok(total)
}

/// Map an SMTP failure to a response without leaking connection details.
///
/// The SMTP server's own refusal (e.g. "550 relay denied", "552 message too
/// large") is the only explanation the user gets for an undelivered message,
/// so it is returned, cleaned of control characters and truncated.
/// Connection-level failures (DNS, TLS, socket errors) are logged only.
fn smtp_error_to_app_error(error: SmtpError) -> AppError {
    match error {
        SmtpError::SendFailed(reason) => {
            let reason: String = reason
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .take(300)
                .collect();
            AppError::MailServerRejected(format!("The mail server refused the message: {reason}"))
        }
        SmtpError::AuthenticationFailed => AppError::MailServerRejected(
            "The mail server rejected the sign-in for sending".to_string(),
        ),
        SmtpError::ConnectionFailed(detail) => {
            AppError::ServiceUnavailable(format!("Failed to send email: {detail}"))
        }
    }
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
pub(super) fn load_draft_attachments(
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
    build_message_bytes(message, message_id, false)
}

pub(super) fn build_message_bytes(
    message: &SendableMessage,
    message_id: &str,
    draft: bool,
) -> Result<Vec<u8>, String> {
    use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType};

    let from_mailbox: Mailbox = message
        .from
        .parse()
        .map_err(|e: lettre::address::AddressError| e.to_string())?;

    let draft_envelope_address = from_mailbox.email.clone();
    let mut builder = lettre::Message::builder()
        .from(from_mailbox)
        .subject(&message.subject)
        .message_id(Some(message_id.to_string()));
    if draft {
        // Drafts may be incomplete and must retain Bcc for later editing.
        builder = builder.keep_bcc().envelope(
            lettre::address::Envelope::new(None, vec![draft_envelope_address])
                .map_err(|e| e.to_string())?,
        );
    }

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

    fn addresses(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("user{i}@example.com")).collect()
    }

    #[test]
    fn recipient_cap_counts_to_cc_and_bcc_together() {
        let third = MAX_RECIPIENTS / 3;
        let rest = MAX_RECIPIENTS - 2 * third;
        assert_eq!(
            check_recipients(&addresses(third), &addresses(third), &addresses(rest)).unwrap(),
            MAX_RECIPIENTS
        );
        let err = check_recipients(&addresses(third), &addresses(third), &addresses(rest + 1))
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(ref m) if m.contains("at most")));
    }

    #[test]
    fn malformed_recipients_are_a_bad_request() {
        let err = check_recipients(&["not an address".to_string()], &[], &[]).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
        assert!(check_recipients(&["Bob <bob@example.com>".to_string()], &[], &[]).is_ok());
    }

    #[test]
    fn send_rate_is_limited_per_account() {
        let limiter = SendLimiter::new();
        for _ in 0..30 {
            limiter.check("Mallory@example.com", 1).unwrap();
        }
        assert!(matches!(
            limiter.check("mallory@example.com ", 1),
            Err(AppError::TooManyRequests(_))
        ));
        // Another account has its own budget.
        assert!(limiter.check("alice@example.com", 1).is_ok());
    }

    #[test]
    fn recipient_volume_is_limited_per_account() {
        let limiter = SendLimiter::new();
        limiter.check("bulk@example.com", MAX_RECIPIENTS).unwrap();
        limiter.check("bulk@example.com", MAX_RECIPIENTS).unwrap();
        assert!(matches!(
            limiter.check("bulk@example.com", MAX_RECIPIENTS),
            Err(AppError::TooManyRequests(_))
        ));
    }

    #[test]
    fn smtp_connection_details_are_not_public() {
        use axum::response::IntoResponse;
        let response = smtp_error_to_app_error(SmtpError::ConnectionFailed(
            "Connection refused (os error 111) to 10.1.2.3:587".into(),
        ))
        .into_response();
        assert_eq!(response.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
        let rejected = smtp_error_to_app_error(SmtpError::SendFailed(
            "permanent error (550): relay denied\r\nX".into(),
        ));
        assert!(
            matches!(rejected, AppError::MailServerRejected(ref m) if m.contains("relay denied") && !m.contains('\n'))
        );
    }
}
