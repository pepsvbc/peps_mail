//! Resume IMAP drafts in the same editor as locally saved drafts.
use std::{path::Path, sync::Arc};

use axum::{Extension, Json, extract::Path as AxumPath, response::Response};
use serde::Deserialize;

use crate::imap::client::{ImapClient, ImapCredentials};
use crate::{auth::session::SessionState, config::AppConfig, db, error::AppError};

#[derive(Deserialize)]
pub struct ImportDraftRequest {
    folder: String,
    uid: u32,
}

pub async fn import_draft_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(imap): Extension<Arc<dyn ImapClient>>,
    Json(req): Json<ImportDraftRequest>,
) -> Result<Response, AppError> {
    let creds = ImapCredentials {
        host: session.imap_host.clone(),
        port: session.imap_port,
        tls: session.imap_tls,
        email: session.email.clone(),
        password: session.password.clone(),
    };
    let folders = imap
        .list_folders(&creds)
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    let draft_folder = folders.iter().any(|f| {
        f.name == req.folder
            && (f
                .attributes
                .iter()
                .any(|a| a.eq_ignore_ascii_case("\\Drafts"))
                || matches!(
                    f.name.to_lowercase().as_str(),
                    "drafts" | "[gmail]/drafts" | "brouillons"
                ))
    });
    if !draft_folder {
        let headers = imap
            .fetch_headers(&creds, &req.folder, &req.uid.to_string())
            .await
            .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
        if !headers
            .iter()
            .any(|h| h.uid == req.uid && h.flags.iter().any(|f| f.eq_ignore_ascii_case("\\Draft")))
        {
            return Err(AppError::BadRequest("Message is not a draft".into()));
        }
    }
    // Include UIDVALIDITY so a rebuilt mailbox cannot reopen an unrelated draft.
    let status = imap
        .folder_status(&creds, &req.folder)
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    let mut conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(e.to_string()))?;
    let id = db::drafts::find_by_source(&conn, &req.folder, status.uid_validity, req.uid)
        .map_err(AppError::InternalError)?
        .unwrap_or_else(|| db::drafts::imported_id(&req.folder, status.uid_validity, req.uid));
    let _guard = super::draft_sync::lock(&session.user_hash, &id).await;
    if db::drafts::get_draft(&conn, &id)
        .map_err(AppError::InternalError)?
        .is_none()
    {
        let body = imap
            .fetch_body(&creds, &req.folder, req.uid)
            .await
            .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
        let parsed = mail_parser::MessageParser::default()
            .parse(body.raw_headers.as_bytes())
            .ok_or_else(|| AppError::BadRequest("Invalid draft headers".into()))?;
        let to = addresses(parsed.to());
        let cc = addresses(parsed.cc());
        let bcc = addresses(parsed.bcc());
        let subject = parsed.subject().unwrap_or_default().to_string();
        let in_reply_to = message_ids(parsed.in_reply_to());
        let references = message_ids(parsed.references());
        let dir = Path::new(&config.data_dir)
            .join(&session.user_hash)
            .join("attachments")
            .join(&id);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| AppError::InternalError(e.to_string()))?;
        let mut html = body.text_html;
        let mut attachments = Vec::new();
        for attachment in body.attachments {
            let attachment_id = uuid::Uuid::new_v4().to_string();
            let file = dir.join(&attachment_id);
            tokio::fs::write(&file, &attachment.data)
                .await
                .map_err(|e| AppError::InternalError(e.to_string()))?;
            if let (Some(html), Some(cid)) = (&mut html, &attachment.content_id) {
                let url = format!(
                    "{}/api/drafts/{id}/attachments/{attachment_id}/content",
                    config.base_path.as_deref().unwrap_or_default()
                );
                *html = html.replace(&format!("cid:{cid}"), &url);
            }
            attachments.push((attachment_id, file, attachment));
        }
        // Do not expose a partially imported draft or overwrite edits on repeat clicks.
        let tx = conn
            .transaction()
            .map_err(|e| AppError::InternalError(e.to_string()))?;
        if db::drafts::get_draft(&tx, &id)
            .map_err(AppError::InternalError)?
            .is_none()
        {
            db::drafts::upsert_draft(
                &tx,
                &id,
                &to,
                &cc,
                &bcc,
                &subject,
                body.text_plain.as_deref().unwrap_or_default(),
                html.as_deref(),
                in_reply_to.as_deref(),
                references.as_deref(),
            )
            .map_err(AppError::InternalError)?;
            for (attachment_id, file, attachment) in &attachments {
                db::drafts::add_draft_attachment(
                    &tx,
                    attachment_id,
                    &id,
                    attachment.filename.as_deref().unwrap_or("attachment"),
                    &attachment.content_type,
                    attachment.data.len() as i64,
                    &file.to_string_lossy(),
                )
                .map_err(AppError::InternalError)?;
            }
        }
        tx.commit()
            .map_err(|e| AppError::InternalError(e.to_string()))?;
    }
    db::drafts::set_source(
        &conn,
        &id,
        &req.folder,
        Some(status.uid_validity),
        Some(req.uid),
    )
    .map_err(AppError::InternalError)?;
    super::drafts::get_draft_handler(Extension(session), Extension(config), AxumPath(id)).await
}

fn addresses(address: Option<&mail_parser::Address<'_>>) -> String {
    address
        .into_iter()
        .flat_map(|a| a.iter())
        .filter_map(|a| a.address.as_deref())
        .collect::<Vec<_>>()
        .join(", ")
}

fn message_ids(value: &mail_parser::HeaderValue<'_>) -> Option<String> {
    value
        .as_text_list()
        .map(|ids| {
            ids.iter()
                .map(|id| format!("<{id}>"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .or_else(|| value.as_text().map(|id| format!("<{id}>")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imap::client::{
        FolderStatus, ImapAttachment, ImapFolder, ImapMessageBody, mock::MockImapClient,
    };

    fn session() -> SessionState {
        SessionState {
            account_id: "account-a".into(),
            email: "alice@example.com".into(),
            password: "test".into(),
            user_hash: "alice".into(),
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_tls: true,
            smtp_host: "smtp.example.com".into(),
            smtp_port: 587,
            smtp_tls: true,
            last_accessed: std::time::Instant::now(),
            timeout_override: None,
        }
    }

    fn imap() -> Arc<MockImapClient> {
        Arc::new(MockImapClient::new()
            .with_folders(vec![ImapFolder { name: "Brouillons".into(), delimiter: None, attributes: vec!["\\Drafts".into()] }])
            .with_folder_status(FolderStatus { uid_validity: 42, exists: 1, uid_next: 8 })
            .with_bodies(vec![ImapMessageBody {
                uid: 7, text_plain: Some("Saved text".into()), text_html: Some("<p>Saved HTML</p><img src=\"cid:logo\">".into()),
                raw_headers: "From: alice@example.com\r\nTo: Bob <bob@example.com>\r\nCc: cc@example.com\r\nBcc: hidden@example.com\r\nSubject: Saved draft\r\nIn-Reply-To: <parent@example.com>\r\nReferences: <first@example.com> <parent@example.com>\r\n\r\n".into(),
                attachments: vec![ImapAttachment { filename: Some("logo.png".into()), content_type: "image/png".into(),
                    size: 3, data: vec![1, 2, 3], content_id: Some("logo".into()) }],
            }]))
    }

    async fn import(
        config: Arc<AppConfig>,
        imap: Arc<dyn ImapClient>,
        folder: &str,
    ) -> Result<serde_json::Value, AppError> {
        let response = import_draft_handler(
            Extension(session()),
            Extension(config),
            Extension(imap),
            Json(ImportDraftRequest {
                folder: folder.into(),
                uid: 7,
            }),
        )
        .await?;
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        Ok(serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn resumes_server_draft_with_recipients_headers_and_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let config: Arc<AppConfig> = Arc::new(
            figment::Figment::new()
                .merge(("data_dir", dir.path().to_str().unwrap()))
                .merge(("base_path", "/mail"))
                .extract()
                .unwrap(),
        );
        let value = import(config.clone(), imap(), "Brouillons").await.unwrap();
        assert_eq!(value["to"], "bob@example.com");
        assert_eq!(value["cc"], "cc@example.com");
        assert_eq!(value["bcc"], "hidden@example.com");
        assert_eq!(value["subject"], "Saved draft");
        assert_eq!(value["text_body"], "Saved text");
        assert_eq!(value["in_reply_to"], "<parent@example.com>");
        assert_eq!(
            value["references"],
            "<first@example.com> <parent@example.com>"
        );
        let id = value["id"].as_str().unwrap();
        let attachment_id = value["attachments"][0]["id"].as_str().unwrap();
        assert_eq!(value["attachments"][0]["filename"], "logo.png");
        assert!(value["html_body"].as_str().unwrap().contains(&format!(
            "/mail/api/drafts/{id}/attachments/{attachment_id}/content"
        )));
        let conn = db::pool::open_user_db(&config.data_dir, "alice").unwrap();
        let attachments = db::drafts::get_draft_attachments(&conn, id).unwrap();
        assert_eq!(
            std::fs::read(&attachments[0].file_path).unwrap(),
            vec![1, 2, 3]
        );
        // Reopening uses the latest local edits, not the older IMAP body.
        db::drafts::upsert_draft(
            &conn,
            id,
            "changed@example.com",
            "",
            "",
            "Edited",
            "New body",
            None,
            None,
            None,
        )
        .unwrap();
        let reopened = import(config.clone(), imap(), "Brouillons").await.unwrap();
        assert_eq!(reopened["id"], id);
        assert_eq!(reopened["subject"], "Edited");
        assert_eq!(reopened["attachments"].as_array().unwrap().len(), 1);
    }

    fn config(dir: &tempfile::TempDir) -> Arc<AppConfig> {
        Arc::new(
            figment::Figment::new()
                .merge(("data_dir", dir.path().to_str().unwrap()))
                .extract()
                .unwrap(),
        )
    }

    fn save_request(id: &str, html: Option<&str>) -> super::super::drafts::UpsertDraftRequest {
        serde_json::from_value(serde_json::json!({
            "id": id, "to": "bob@example.com", "bcc": "hidden@example.com",
            "subject": "Edited draft", "text_body": "Edited text", "html_body": html
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn import_save_reopen_and_discard_keep_one_server_draft() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(&dir);
        let imap = imap();
        let original = import(config.clone(), imap.clone(), "Brouillons")
            .await
            .unwrap();
        let id = original["id"].as_str().unwrap();
        assert_eq!(
            import(config.clone(), imap.clone(), "Brouillons")
                .await
                .unwrap()["id"],
            id
        );
        assert!(
            imap.draft_syncs.lock().unwrap().is_empty(),
            "opening must not append a draft"
        );
        for _ in 0..2 {
            super::super::drafts::upsert_draft_handler(
                Extension(session()),
                Extension(config.clone()),
                Extension(imap.clone()),
                Json(save_request(id, original["html_body"].as_str())),
            )
            .await
            .unwrap();
        }
        let calls = imap.draft_syncs.lock().unwrap().clone();
        assert_eq!(calls[0].uid, Some(7));
        assert_eq!(calls[1].uid, Some(1001));
        assert_eq!(calls[0].message_id, calls[1].message_id);
        assert_eq!(imap.draft_remote.lock().unwrap().len(), 1);
        let saved = mail_parser::MessageParser::default()
            .parse(calls[1].content.as_ref().unwrap())
            .unwrap();
        assert_eq!(addresses(saved.bcc()), "hidden@example.com");
        assert_eq!(saved.attachment_count(), 1);
        assert!(!saved.body_html(0).unwrap().contains("/api/drafts/"));
        assert!(saved.body_html(0).unwrap().contains("cid:"));
        // New IMAP UID reopens the same local draft, not another import.
        let reopened = import_draft_handler(
            Extension(session()),
            Extension(config.clone()),
            Extension(imap.clone()),
            Json(ImportDraftRequest {
                folder: "Brouillons".into(),
                uid: 1002,
            }),
        )
        .await
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(reopened.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["id"], id);
        assert_eq!(value["subject"], "Edited draft");
        super::super::drafts::delete_draft_handler(
            Extension(session()),
            Extension(config.clone()),
            Extension(imap.clone()),
            AxumPath(id.to_string()),
        )
        .await
        .unwrap();
        assert!(imap.draft_remote.lock().unwrap().is_empty());
        assert_eq!(
            imap.draft_syncs.lock().unwrap().last().unwrap().uid,
            Some(1002)
        );
        let conn = db::pool::open_user_db(&config.data_dir, "alice").unwrap();
        assert!(db::drafts::get_draft(&conn, id).unwrap().is_none());
        // Discard from a stale open composer must also succeed after list deletion.
        super::super::drafts::delete_draft_handler(
            Extension(session()),
            Extension(config.clone()),
            Extension(imap.clone()),
            AxumPath(id.to_string()),
        )
        .await
        .unwrap();
        // A delayed save cannot resurrect the discarded draft.
        assert!(
            super::super::drafts::upsert_draft_handler(
                Extension(session()),
                Extension(config),
                Extension(imap.clone()),
                Json(save_request(id, None))
            )
            .await
            .is_err()
        );
        assert_eq!(imap.draft_syncs.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn new_draft_without_recipients_replaces_its_first_server_copy() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(&dir);
        let imap = imap();
        for _ in 0..2 {
            let mut req = save_request("new-empty-recipients", None);
            req.to.clear();
            req.cc.clear();
            req.bcc.clear();
            super::super::drafts::upsert_draft_handler(
                Extension(session()),
                Extension(config.clone()),
                Extension(imap.clone()),
                Json(req),
            )
            .await
            .unwrap();
        }
        let calls = imap.draft_syncs.lock().unwrap();
        assert_eq!(calls[0].uid, None);
        assert_eq!(calls[1].uid, Some(1001));
        assert_eq!(calls[0].folder, "Brouillons");
        assert_eq!(imap.draft_remote.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn legacy_imports_recover_the_original_and_delete_failure_keeps_local_edits() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(&dir);
        let original = import(config.clone(), imap(), "Brouillons").await.unwrap();
        let id = original["id"].as_str().unwrap();
        let conn = db::pool::open_user_db(&config.data_dir, "alice").unwrap();
        db::folders::upsert_folder(
            &conn,
            "Brouillons",
            None,
            None,
            "\\Drafts",
            true,
            1,
            0,
            42,
            0,
        )
        .unwrap();
        db::messages::upsert_message(
            &conn,
            "Brouillons",
            7,
            None,
            None,
            None,
            "Original",
            "alice@example.com",
            "",
            "[]",
            "[]",
            "",
            "\\Draft",
            1,
            false,
            "",
            None,
        )
        .unwrap();
        conn.execute(
            "UPDATE drafts SET source_folder=NULL,source_uid_validity=NULL,source_uid=NULL",
            [],
        )
        .unwrap();
        let offline = Arc::new(MockImapClient::new().with_error(
            crate::imap::client::ImapError::ConnectionFailed("Offline".into()),
        ));
        assert!(
            super::super::drafts::delete_draft_handler(
                Extension(session()),
                Extension(config.clone()),
                Extension(offline),
                AxumPath(id.to_string())
            )
            .await
            .is_err()
        );
        let recovered = db::drafts::get_draft(&conn, id).unwrap().unwrap();
        assert_eq!(recovered.source_uid, Some(7));
        let imap = imap();
        super::super::drafts::delete_draft_handler(
            Extension(session()),
            Extension(config),
            Extension(imap.clone()),
            AxumPath(id.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(imap.draft_syncs.lock().unwrap()[0].uid, Some(7));
        assert!(
            db::messages::get_single_message(&conn, "Brouillons", 7)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn failed_save_and_uidvalidity_change_never_remove_original() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(&dir);
        let original = import(config.clone(), imap(), "Brouillons").await.unwrap();
        let id = original["id"].as_str().unwrap();
        let failing = Arc::new(MockImapClient::new().with_append_error(
            crate::imap::client::ImapError::ConnectionFailed("Offline".into()),
        ));
        assert!(
            super::super::drafts::upsert_draft_handler(
                Extension(session()),
                Extension(config.clone()),
                Extension(failing.clone()),
                Json(save_request(id, None))
            )
            .await
            .is_err()
        );
        let conn = db::pool::open_user_db(&config.data_dir, "alice").unwrap();
        let draft = db::drafts::get_draft(&conn, id).unwrap().unwrap();
        assert_eq!(draft.subject, "Edited draft");
        assert_eq!(draft.source_uid, Some(7));
        assert!(failing.draft_syncs.lock().unwrap().is_empty());
        let replaced_mailbox = Arc::new(MockImapClient::new().with_folder_status(FolderStatus {
            uid_validity: 99,
            exists: 1,
            uid_next: 8,
        }));
        assert!(
            super::super::drafts::delete_draft_handler(
                Extension(session()),
                Extension(config),
                Extension(replaced_mailbox.clone()),
                AxumPath(id.to_string())
            )
            .await
            .is_err()
        );
        assert!(replaced_mailbox.draft_syncs.lock().unwrap().is_empty());
        assert!(db::drafts::get_draft(&conn, id).unwrap().is_some());
    }

    #[tokio::test]
    async fn rejects_ordinary_messages() {
        let dir = tempfile::tempdir().unwrap();
        let config = Arc::new(
            figment::Figment::new()
                .merge(("data_dir", dir.path().to_str().unwrap()))
                .extract()
                .unwrap(),
        );
        assert!(matches!(
            import(config, imap(), "INBOX").await,
            Err(AppError::BadRequest(_))
        ));
    }
}
