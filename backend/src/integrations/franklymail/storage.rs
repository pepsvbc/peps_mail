//! Provider-owned recovery data, separate from the disposable IMAP cache.
use crate::error::AppError;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Storage {
    path: PathBuf,
}
pub struct Token {
    pub email: String,
    pub destination: String,
}
fn db_error(_: rusqlite::Error) -> AppError {
    AppError::InternalError("Recovery storage unavailable".into())
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

impl Storage {
    pub fn new(data_dir: &str) -> Result<Self, AppError> {
        let dir = PathBuf::from(data_dir).join("integrations");
        std::fs::create_dir_all(&dir)
            .map_err(|_| AppError::InternalError("Recovery storage unavailable".into()))?;
        let store = Self {
            path: dir.join("franklymail.sqlite"),
        };
        store.open()?.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS recovery (email TEXT PRIMARY KEY, destination TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, email TEXT NOT NULL, destination TEXT NOT NULL, purpose TEXT NOT NULL, expires INTEGER NOT NULL, issued INTEGER NOT NULL, UNIQUE(email,purpose));
            CREATE TABLE IF NOT EXISTS cooldowns (email TEXT PRIMARY KEY, until_at INTEGER NOT NULL);") .map_err(db_error)?;
        Ok(store)
    }
    fn open(&self) -> Result<Connection, AppError> {
        let conn = Connection::open(&self.path).map_err(db_error)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        Ok(conn)
    }
    pub fn recovery(&self, email: &str) -> Result<Option<String>, AppError> {
        self.open()?
            .query_row(
                "SELECT destination FROM recovery WHERE email=?1",
                [email],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)
    }
    pub fn issue(
        &self,
        email: &str,
        destination: &str,
        purpose: &str,
    ) -> Result<Option<String>, AppError> {
        let mut conn = self.open()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let now = now();
        tx.execute("DELETE FROM tokens WHERE expires<=?1", [now])
            .map_err(db_error)?;
        tx.execute("DELETE FROM cooldowns WHERE until_at<=?1", [now])
            .map_err(db_error)?;
        if tx
            .execute(
                "INSERT OR IGNORE INTO cooldowns VALUES (?1,?2)",
                params![email, now + 60],
            )
            .map_err(db_error)?
            == 0
        {
            return Ok(None);
        }
        let token = crate::auth::session::SessionStore::generate_token();
        tx.execute(
            "INSERT OR REPLACE INTO tokens VALUES (?1,?2,?3,?4,?5,?6)",
            params![hash(&token), email, destination, purpose, now + 900, now],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(Some(token))
    }
    /// Atomic delete prevents concurrent or repeated use, including uncertain API results.
    pub fn consume(&self, token: &str, purpose: &str) -> Result<Token, AppError> {
        self.open()?.query_row("DELETE FROM tokens WHERE hash=?1 AND purpose=?2 AND expires>?3 RETURNING email,destination", params![hash(token),purpose,now()], |r| Ok(Token {email:r.get(0)?,destination:r.get(1)?})).optional().map_err(db_error)?
            .ok_or_else(|| AppError::BadRequest("This link is invalid or expired. Request a new one.".into()))
    }
    /// Personal addresses are supplied by an authenticated server administrator.
    pub fn set_recovery(&self, email: &str, destination: &str) -> Result<(), AppError> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(db_error)?;
        tx.execute(
            "INSERT OR REPLACE INTO recovery VALUES (?1,?2)",
            params![email, destination],
        )
        .map_err(db_error)?;
        tx.execute("DELETE FROM tokens WHERE email=?1", [email])
            .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    pub fn invalidate_tokens(&self, email: &str) -> Result<(), AppError> {
        self.open()?
            .execute("DELETE FROM tokens WHERE email=?1", [email])
            .map_err(db_error)?;
        Ok(())
    }
    pub fn forget_mailbox(&self, email: &str) -> Result<(), AppError> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(db_error)?;
        for table in ["tokens", "recovery", "cooldowns"] {
            tx.execute(&format!("DELETE FROM {table} WHERE email=?1"), [email])
                .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trusted_recovery_change_revokes_tokens_and_expired_links_fail() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::new(temp.path().to_str().unwrap()).unwrap();
        store
            .set_recovery("me@example.com", "personal@example.org")
            .unwrap();
        let token = store
            .issue("me@example.com", "personal@example.org", "reset")
            .unwrap()
            .unwrap();
        assert!(
            store
                .issue("me@example.com", "personal@example.org", "reset")
                .unwrap()
                .is_none()
        );
        store
            .set_recovery("me@example.com", "new@example.org")
            .unwrap();
        assert!(store.consume(&token, "reset").is_err());
        assert_eq!(
            store.recovery("me@example.com").unwrap().as_deref(),
            Some("new@example.org")
        );
        let token = store
            .issue("other@example.com", "personal@example.org", "reset")
            .unwrap()
            .unwrap();
        store
            .open()
            .unwrap()
            .execute("UPDATE tokens SET expires=0", [])
            .unwrap();
        assert!(store.consume(&token, "reset").is_err());
    }
    #[test]
    fn reset_token_is_hashed_and_consumed_once() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::new(temp.path().to_str().unwrap()).unwrap();
        let raw = store
            .issue("me@example.com", "recovery@example.org", "reset")
            .unwrap()
            .unwrap();
        let saved: String = store
            .open()
            .unwrap()
            .query_row("SELECT hash FROM tokens", [], |r| r.get(0))
            .unwrap();
        assert_ne!(saved, raw);
        assert_eq!(
            store.consume(&raw, "reset").unwrap().email,
            "me@example.com"
        );
        assert!(store.consume(&raw, "reset").is_err());
    }
}
