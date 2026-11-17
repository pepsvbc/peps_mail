//! Keep one local editing identity linked to one IMAP draft.
use crate::{
    auth::session::SessionState,
    config::AppConfig,
    db,
    error::AppError,
    imap::client::{DraftSyncRequest, ImapClient, ImapCredentials},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};

type Locks = Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>;
static LOCKS: OnceLock<Locks> = OnceLock::new();

pub async fn lock(user: &str, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let mutex = {
        let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
        locks.retain(|_, value| value.strong_count() > 0);
        let key = format!("{user}\0{id}");
        let mutex = locks.get(&key).and_then(Weak::upgrade).unwrap_or_default();
        locks.insert(key, Arc::downgrade(&mutex));
        mutex
    };
    mutex.lock_owned().await
}

pub fn message_id(id: &str) -> String {
    format!("<{:x}@draft.peps-mail.invalid>", Sha256::digest(id))
}

pub async fn sync(
    session: &SessionState,
    config: &AppConfig,
    imap: &dyn ImapClient,
    id: &str,
    content: Option<Vec<u8>>,
) -> Result<(), AppError> {
    let (draft, default_folder) = {
        let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
            .map_err(AppError::InternalError)?;
        db::drafts::recover_sources(&conn).map_err(AppError::InternalError)?;
        (
            db::drafts::get_draft(&conn, id)
                .map_err(AppError::InternalError)?
                .ok_or_else(|| AppError::NotFound("Draft not found".into()))?,
            db::folders::find_folder_by_attribute(&conn, "\\Drafts")
                .map_err(AppError::InternalError)?,
        )
    };
    // A local draft which never attempted synchronization has nothing on IMAP.
    if content.is_none() && draft.source_folder.is_none() {
        return Ok(());
    }
    let creds = ImapCredentials {
        host: session.imap_host.clone(),
        port: session.imap_port,
        tls: session.imap_tls,
        email: session.email.clone(),
        password: session.password.clone(),
    };
    let folder = if let Some(folder) = draft.source_folder.or(default_folder) {
        folder
    } else {
        let folders = imap
            .list_folders(&creds)
            .await
            .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
        folders
            .iter()
            .find(|f| {
                f.attributes
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case("\\Drafts"))
            })
            .or_else(|| {
                folders.iter().find(|f| {
                    matches!(
                        f.name.to_lowercase().as_str(),
                        "drafts" | "[gmail]/drafts" | "brouillons"
                    )
                })
            })
            .map(|f| f.name.clone())
            .ok_or_else(|| {
                AppError::ServiceUnavailable(
                    "No Drafts folder found; draft retained locally".into(),
                )
            })?
    };
    {
        let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
            .map_err(AppError::InternalError)?;
        // Preserve the destination even if APPEND succeeds but its response is lost.
        db::drafts::set_source(
            &conn,
            id,
            &folder,
            draft.source_uid_validity,
            draft.source_uid,
        )
        .map_err(AppError::InternalError)?;
    }
    let result = imap
        .sync_draft(
            &creds,
            &DraftSyncRequest {
                folder: folder.clone(),
                uid_validity: draft.source_uid_validity,
                uid: draft.source_uid,
                message_id: message_id(id),
                content,
            },
        )
        .await
        .map_err(|e| {
            AppError::ServiceUnavailable(format!(
                "Could not synchronize draft; local copy retained: {e}"
            ))
        })?;
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(AppError::InternalError)?;
    db::drafts::set_source(&conn, id, &folder, Some(result.uid_validity), result.uid)
        .map_err(AppError::InternalError)?;
    for uid in result.removed_uids {
        db::messages::delete_message(&conn, &folder, uid).map_err(AppError::InternalError)?;
    }
    db::folders::invalidate_folder_freshness(&conn, &folder).map_err(AppError::InternalError)?;
    db::folders::refresh_unread_count(&conn, &folder).map_err(AppError::InternalError)?;
    Ok(())
}
