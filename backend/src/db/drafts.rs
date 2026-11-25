use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// A locally-saved draft message.
#[derive(Debug, Clone, Serialize)]
pub struct Draft {
    pub id: String,
    pub to_addresses: String,
    pub cc_addresses: String,
    pub bcc_addresses: String,
    pub subject: String,
    pub text_body: String,
    pub html_body: Option<String>,
    pub in_reply_to: Option<String>,
    pub references_header: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub source_folder: Option<String>,
    pub source_uid_validity: Option<u32>,
    pub source_uid: Option<u32>,
}

/// An attachment associated with a draft.
#[derive(Debug, Clone, Serialize)]
pub struct DraftAttachment {
    pub id: String,
    pub draft_id: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub file_path: String,
    pub created_at: String,
}

/// Insert or update a draft while retaining its source and attachment records.
#[allow(clippy::too_many_arguments)]
pub fn upsert_draft(
    conn: &Connection,
    id: &str,
    to_addresses: &str,
    cc_addresses: &str,
    bcc_addresses: &str,
    subject: &str,
    text_body: &str,
    html_body: Option<&str>,
    in_reply_to: Option<&str>,
    references_header: Option<&str>,
) -> Result<(), String> {
    let changed = conn.execute(
        "INSERT INTO drafts (id, to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, in_reply_to, references_header, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now')
         WHERE NOT EXISTS (SELECT 1 FROM deleted_drafts WHERE id = ?1)
         ON CONFLICT(id) DO UPDATE SET
             to_addresses = excluded.to_addresses,
             cc_addresses = excluded.cc_addresses,
             bcc_addresses = excluded.bcc_addresses,
             subject = excluded.subject,
             text_body = excluded.text_body,
             html_body = excluded.html_body,
             in_reply_to = excluded.in_reply_to,
             references_header = excluded.references_header,
             updated_at = datetime('now')",
        params![
            id,
            to_addresses,
            cc_addresses,
            bcc_addresses,
            subject,
            text_body,
            html_body,
            in_reply_to,
            references_header,
        ],
    )
    .map_err(|e| format!("Failed to upsert draft: {e}"))?;
    if changed == 0 {
        return Err("Draft has already been deleted".into());
    }
    Ok(())
}

/// Retrieve a single draft by ID.
pub fn get_draft(conn: &Connection, id: &str) -> Result<Option<Draft>, String> {
    let result = conn.query_row(
        "SELECT id, to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, in_reply_to, references_header, created_at, updated_at, source_folder, source_uid_validity, source_uid
         FROM drafts WHERE id = ?1",
        params![id],
        |row| {
            Ok(Draft {
                id: row.get(0)?,
                to_addresses: row.get(1)?,
                cc_addresses: row.get(2)?,
                bcc_addresses: row.get(3)?,
                subject: row.get(4)?,
                text_body: row.get(5)?,
                html_body: row.get(6)?,
                in_reply_to: row.get(7)?,
                references_header: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                source_folder: row.get(11)?,
                source_uid_validity: row.get(12)?,
                source_uid: row.get(13)?,
            })
        },
    );

    match result {
        Ok(draft) => Ok(Some(draft)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Failed to get draft: {e}")),
    }
}

/// List all drafts, ordered by updated_at descending.
pub fn list_drafts(conn: &Connection) -> Result<Vec<Draft>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, in_reply_to, references_header, created_at, updated_at, source_folder, source_uid_validity, source_uid
             FROM drafts ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("Failed to prepare list_drafts: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Draft {
                id: row.get(0)?,
                to_addresses: row.get(1)?,
                cc_addresses: row.get(2)?,
                bcc_addresses: row.get(3)?,
                subject: row.get(4)?,
                text_body: row.get(5)?,
                html_body: row.get(6)?,
                in_reply_to: row.get(7)?,
                references_header: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                source_folder: row.get(11)?,
                source_uid_validity: row.get(12)?,
                source_uid: row.get(13)?,
            })
        })
        .map_err(|e| format!("Failed to query drafts: {e}"))?;

    let mut drafts = Vec::new();
    for row in rows {
        drafts.push(row.map_err(|e| format!("Failed to read draft row: {e}"))?);
    }
    Ok(drafts)
}

/// Delete a draft by ID. Cascade will handle attachments in DB.
pub fn delete_draft(conn: &Connection, id: &str) -> Result<bool, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO deleted_drafts(id) SELECT id FROM drafts WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    let deleted = tx
        .execute("DELETE FROM drafts WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(deleted > 0)
}

/// Add an attachment record for a draft.
pub fn add_draft_attachment(
    conn: &Connection,
    id: &str,
    draft_id: &str,
    filename: &str,
    content_type: &str,
    size: i64,
    file_path: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO draft_attachments (id, draft_id, filename, content_type, size, file_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, draft_id, filename, content_type, size, file_path],
    )
    .map_err(|e| format!("Failed to add draft attachment: {e}"))?;
    Ok(())
}

/// Total bytes of all stored draft attachments for this user.
pub fn total_attachment_bytes(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COALESCE(SUM(size), 0) FROM draft_attachments", [], |row| row.get(0))
        .map_err(|e| format!("Failed to sum draft attachments: {e}"))
}

/// Add an attachment record only if the user's stored total stays within
/// `max_total_bytes`. Returns `Ok(false)` (and stores nothing) when it would
/// not fit.
///
/// The check and the insert run in one `BEGIN IMMEDIATE` transaction, which
/// takes SQLite's write lock up front, so parallel uploads on other
/// connections can't all pass the check against the same old total.
#[allow(clippy::too_many_arguments)]
pub fn add_draft_attachment_within_quota(
    conn: &Connection,
    id: &str,
    draft_id: &str,
    filename: &str,
    content_type: &str,
    size: i64,
    file_path: &str,
    max_total_bytes: i64,
) -> Result<bool, String> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| format!("Failed to start attachment transaction: {e}"))?;
    if total_attachment_bytes(&tx)?.saturating_add(size) > max_total_bytes {
        return Ok(false); // dropping `tx` rolls back
    }
    add_draft_attachment(&tx, id, draft_id, filename, content_type, size, file_path)?;
    tx.commit()
        .map_err(|e| format!("Failed to commit draft attachment: {e}"))?;
    Ok(true)
}

/// Get all attachments for a draft.
pub fn get_draft_attachments(
    conn: &Connection,
    draft_id: &str,
) -> Result<Vec<DraftAttachment>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, draft_id, filename, content_type, size, file_path, created_at
             FROM draft_attachments WHERE draft_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| format!("Failed to prepare get_draft_attachments: {e}"))?;

    let rows = stmt
        .query_map(params![draft_id], |row| {
            Ok(DraftAttachment {
                id: row.get(0)?,
                draft_id: row.get(1)?,
                filename: row.get(2)?,
                content_type: row.get(3)?,
                size: row.get(4)?,
                file_path: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("Failed to query draft attachments: {e}"))?;

    let mut attachments = Vec::new();
    for row in rows {
        attachments.push(row.map_err(|e| format!("Failed to read attachment row: {e}"))?);
    }
    Ok(attachments)
}

/// Delete a single attachment by ID.
pub fn delete_draft_attachment(conn: &Connection, id: &str) -> Result<bool, String> {
    let deleted = conn
        .execute("DELETE FROM draft_attachments WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete draft attachment: {e}"))?;
    Ok(deleted > 0)
}

/// Stable identity used by older imports as well as new ones.
pub fn imported_id(folder: &str, uid_validity: u32, uid: u32) -> String {
    format!(
        "imap-{:x}",
        Sha256::digest(format!("{folder}\0{uid_validity}\0{uid}"))
    )
}

pub fn set_source(
    conn: &Connection,
    id: &str,
    folder: &str,
    uid_validity: Option<u32>,
    uid: Option<u32>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE drafts SET source_folder=?2, source_uid_validity=?3, source_uid=?4 WHERE id=?1",
        params![id, folder, uid_validity, uid],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn find_by_source(
    conn: &Connection,
    folder: &str,
    uid_validity: u32,
    uid: u32,
) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT id FROM drafts WHERE source_folder=?1 AND source_uid_validity=?2 AND source_uid=?3",
        params![folder, uid_validity, uid],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Recover exact folder/UID links for drafts imported before source tracking.
/// Never guess from subjects, senders, or message contents.
pub fn recover_sources(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT m.folder,m.uid,f.uid_validity FROM messages m JOIN folders f ON f.name=m.folder WHERE m.flags LIKE '%\\Draft%' OR f.flags LIKE '%\\Drafts%' OR lower(m.folder) IN ('drafts','[gmail]/drafts','brouillons')").map_err(|e| e.to_string())?;
    let sources = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, u32>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for source in sources {
        let (folder, uid, validity) = source.map_err(|e| e.to_string())?;
        conn.execute("UPDATE drafts SET source_folder=?2,source_uid_validity=?3,source_uid=?4 WHERE id=?1 AND source_folder IS NULL", params![imported_id(&folder, validity, uid),folder,validity,uid]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::pool::open_test_db;

    #[test]
    fn test_upsert_and_get_draft() {
        let conn = open_test_db();

        upsert_draft(
            &conn,
            "draft-1",
            "bob@example.com",
            "",
            "",
            "Hello",
            "Hi Bob",
            None,
            None,
            None,
        )
        .unwrap();

        let draft = get_draft(&conn, "draft-1").unwrap().unwrap();
        assert_eq!(draft.id, "draft-1");
        assert_eq!(draft.to_addresses, "bob@example.com");
        assert_eq!(draft.subject, "Hello");
        assert_eq!(draft.text_body, "Hi Bob");
        assert!(draft.html_body.is_none());
    }

    #[test]
    fn test_upsert_updates_existing() {
        let conn = open_test_db();

        upsert_draft(
            &conn,
            "draft-1",
            "bob@example.com",
            "",
            "",
            "v1",
            "body1",
            None,
            None,
            None,
        )
        .unwrap();
        upsert_draft(
            &conn,
            "draft-1",
            "carol@example.com",
            "",
            "",
            "v2",
            "body2",
            None,
            None,
            None,
        )
        .unwrap();

        let draft = get_draft(&conn, "draft-1").unwrap().unwrap();
        assert_eq!(draft.to_addresses, "carol@example.com");
        assert_eq!(draft.subject, "v2");
        assert_eq!(draft.text_body, "body2");
    }

    #[test]
    fn test_list_drafts_returns_all() {
        let conn = open_test_db();

        upsert_draft(&conn, "draft-a", "", "", "", "First", "", None, None, None).unwrap();
        upsert_draft(&conn, "draft-b", "", "", "", "Second", "", None, None, None).unwrap();

        let drafts = list_drafts(&conn).unwrap();
        assert_eq!(drafts.len(), 2);
        let ids: Vec<&str> = drafts.iter().map(|d| d.id.as_str()).collect();
        assert!(ids.contains(&"draft-a"));
        assert!(ids.contains(&"draft-b"));
    }

    #[test]
    fn test_delete_draft() {
        let conn = open_test_db();

        upsert_draft(&conn, "draft-1", "", "", "", "Test", "", None, None, None).unwrap();
        assert!(get_draft(&conn, "draft-1").unwrap().is_some());

        let deleted = delete_draft(&conn, "draft-1").unwrap();
        assert!(deleted);
        assert!(get_draft(&conn, "draft-1").unwrap().is_none());
    }

    #[test]
    fn test_delete_nonexistent_draft() {
        let conn = open_test_db();
        let deleted = delete_draft(&conn, "no-such-draft").unwrap();
        assert!(!deleted);
    }

    #[test]
    fn test_get_nonexistent_draft() {
        let conn = open_test_db();
        assert!(get_draft(&conn, "no-such-draft").unwrap().is_none());
    }

    #[test]
    fn test_add_and_get_attachments() {
        let conn = open_test_db();

        upsert_draft(&conn, "draft-1", "", "", "", "Test", "", None, None, None).unwrap();

        add_draft_attachment(
            &conn,
            "att-1",
            "draft-1",
            "file.pdf",
            "application/pdf",
            1024,
            "/data/abc/attachments/draft-1/att-1",
        )
        .unwrap();

        add_draft_attachment(
            &conn,
            "att-2",
            "draft-1",
            "photo.jpg",
            "image/jpeg",
            2048,
            "/data/abc/attachments/draft-1/att-2",
        )
        .unwrap();

        let atts = get_draft_attachments(&conn, "draft-1").unwrap();
        assert_eq!(atts.len(), 2);
        assert_eq!(atts[0].filename, "file.pdf");
        assert_eq!(atts[0].size, 1024);
        assert_eq!(atts[1].filename, "photo.jpg");
    }

    #[test]
    fn test_delete_attachment() {
        let conn = open_test_db();

        upsert_draft(&conn, "draft-1", "", "", "", "Test", "", None, None, None).unwrap();
        add_draft_attachment(
            &conn,
            "att-1",
            "draft-1",
            "file.pdf",
            "application/pdf",
            100,
            "/path",
        )
        .unwrap();

        let deleted = delete_draft_attachment(&conn, "att-1").unwrap();
        assert!(deleted);

        let atts = get_draft_attachments(&conn, "draft-1").unwrap();
        assert!(atts.is_empty());
    }

    #[test]
    fn test_cascade_delete_attachments_on_draft_delete() {
        let conn = open_test_db();

        upsert_draft(&conn, "draft-1", "", "", "", "Test", "", None, None, None).unwrap();
        add_draft_attachment(
            &conn,
            "att-1",
            "draft-1",
            "file.pdf",
            "application/pdf",
            100,
            "/path",
        )
        .unwrap();
        add_draft_attachment(
            &conn,
            "att-2",
            "draft-1",
            "pic.jpg",
            "image/jpeg",
            200,
            "/path2",
        )
        .unwrap();

        delete_draft(&conn, "draft-1").unwrap();

        let atts = get_draft_attachments(&conn, "draft-1").unwrap();
        assert!(atts.is_empty());
    }

    #[test]
    fn quota_checked_insert_refuses_what_does_not_fit() {
        let conn = open_test_db();
        upsert_draft(&conn, "d", "", "", "", "", "", None, None, None).unwrap();
        assert!(add_draft_attachment_within_quota(&conn, "a", "d", "a", "x/y", 60, "/a", 100).unwrap());
        assert!(!add_draft_attachment_within_quota(&conn, "b", "d", "b", "x/y", 41, "/b", 100).unwrap());
        assert!(add_draft_attachment_within_quota(&conn, "c", "d", "c", "x/y", 40, "/c", 100).unwrap());
        assert_eq!(total_attachment_bytes(&conn).unwrap(), 100);
        assert_eq!(get_draft_attachments(&conn, "d").unwrap().len(), 2);
    }

    /// Parallel uploads on separate connections must not all pass the check
    /// against the same stale total.
    #[test]
    fn quota_checked_insert_is_atomic_across_connections() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap().to_string();
        let conn = crate::db::pool::open_user_db(&data_dir, "u").unwrap();
        upsert_draft(&conn, "d", "", "", "", "", "", None, None, None).unwrap();
        drop(conn);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let data_dir = data_dir.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let conn = crate::db::pool::open_user_db(&data_dir, "u").unwrap();
                    barrier.wait();
                    let id = format!("att-{i}");
                    add_draft_attachment_within_quota(&conn, &id, "d", &id, "x/y", 30, "/p", 100)
                        .unwrap()
                })
            })
            .collect();
        let stored = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(stored, 3);
        let conn = crate::db::pool::open_user_db(&data_dir, "u").unwrap();
        assert_eq!(total_attachment_bytes(&conn).unwrap(), 90);
    }
}
