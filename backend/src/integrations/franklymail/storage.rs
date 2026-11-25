//! Provider-owned recovery data, separate from the disposable IMAP cache.
use crate::error::AppError;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Storage {
    path: PathBuf,
}
pub struct Token {
    pub email: String,
    pub destination: String,
}
/// Who asked for a link. Each origin has its own cooldown and token slots, so
/// anonymous recovery requests can neither block nor revoke administrator links.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Admin,
    Public,
}
impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::Admin => "admin",
            Origin::Public => "public",
        }
    }
}
/// Links stay valid for 15 minutes.
const TOKEN_TTL_SECS: i64 = 900;
/// A new link never revokes a still-valid one; only the oldest beyond this many
/// per mailbox, purpose and origin is evicted.
const MAX_LIVE_TOKENS: i64 = 3;
/// Minimum delay between two administrator-sent links for one mailbox.
const ADMIN_COOLDOWN_SECS: i64 = 60;
/// Anonymous recovery emails per mailbox per rolling 24 hours. The delay
/// between them doubles each time: 1, 2, 4, 8, then 16 minutes.
const PUBLIC_DAILY_CAP: i64 = 5;
const PUBLIC_BASE_COOLDOWN_SECS: i64 = 60;
const DAY_SECS: i64 = 86_400;
const SCHEMA_VERSION: i64 = 1;

fn db_error(_: rusqlite::Error) -> AppError {
    AppError::InternalError("Recovery storage unavailable".into())
}
fn io_error(_: std::io::Error) -> AppError {
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

/// Recovery data lets its holder reset passwords: keep it owner-only on disk,
/// including databases created by earlier versions with the default umask.
#[cfg(unix)]
fn restrict_permissions(dir: &Path, db: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(io_error)?;
    // Create the file ourselves so it never exists with umask permissions.
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(db)
        .map_err(io_error)?;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = db.as_os_str().to_owned();
        name.push(suffix);
        let path = PathBuf::from(name);
        if path.exists() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(io_error)?;
        }
    }
    Ok(())
}
#[cfg(not(unix))]
fn restrict_permissions(_: &Path, _: &Path) -> Result<(), AppError> {
    Ok(())
}

const TOKENS_TABLE: &str = "CREATE TABLE tokens (hash TEXT PRIMARY KEY, email TEXT NOT NULL, destination TEXT NOT NULL, purpose TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL, issued INTEGER NOT NULL);
    CREATE INDEX tokens_mailbox ON tokens(email, purpose, origin);";
const COOLDOWNS_TABLE: &str = "CREATE TABLE cooldowns (email TEXT NOT NULL, origin TEXT NOT NULL, until_at INTEGER NOT NULL, PRIMARY KEY(email, origin));";
const PUBLIC_SENDS_TABLE: &str = "CREATE TABLE public_sends (email TEXT NOT NULL, sent_at INTEGER NOT NULL);
    CREATE INDEX public_sends_mailbox ON public_sends(email, sent_at);";

fn table_exists(tx: &rusqlite::Transaction, name: &str) -> Result<bool, AppError> {
    tx.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(db_error)
}

/// Schema versions are tracked with `PRAGMA user_version`. Version 0 (the
/// original schema) had no version and kept one token per mailbox and purpose.
fn migrate(conn: &mut Connection) -> Result<(), AppError> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let version: i64 = tx
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(db_error)?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS recovery (email TEXT PRIMARY KEY, destination TEXT NOT NULL);",
    )
    .map_err(db_error)?;
    // UNIQUE(email,purpose) made every new link replace the outstanding one.
    // SQLite cannot drop a constraint, so rebuild the table, keeping
    // outstanding links. Their origin is unknown; treat them as admin links.
    if table_exists(&tx, "tokens")? {
        tx.execute_batch(&format!(
            "ALTER TABLE tokens RENAME TO tokens_v0;
            {TOKENS_TABLE}
            INSERT INTO tokens SELECT hash, email, destination, purpose, 'admin', expires, issued FROM tokens_v0;
            DROP TABLE tokens_v0;"
        ))
        .map_err(db_error)?;
    } else {
        tx.execute_batch(TOKENS_TABLE).map_err(db_error)?;
    }
    // Old cooldowns lasted at most a minute; they are safe to drop.
    tx.execute_batch("DROP TABLE IF EXISTS cooldowns;")
        .map_err(db_error)?;
    tx.execute_batch(COOLDOWNS_TABLE).map_err(db_error)?;
    if !table_exists(&tx, "public_sends")? {
        tx.execute_batch(PUBLIC_SENDS_TABLE).map_err(db_error)?;
    }
    tx.execute_batch(&format!("PRAGMA user_version={SCHEMA_VERSION};"))
        .map_err(db_error)?;
    tx.commit().map_err(db_error)
}

impl Storage {
    pub fn new(data_dir: &str) -> Result<Self, AppError> {
        let dir = PathBuf::from(data_dir).join("integrations");
        std::fs::create_dir_all(&dir).map_err(io_error)?;
        let path = dir.join("franklymail.sqlite");
        restrict_permissions(&dir, &path)?;
        let store = Self { path };
        let mut conn = store.open()?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(db_error)?;
        migrate(&mut conn)?;
        drop(conn);
        // SQLite gives WAL/SHM files the database's mode; check them anyway.
        restrict_permissions(&dir, &store.path)?;
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
    /// Issue a one-time link, or `None` while this origin is throttled for the
    /// mailbox. Valid links already sent stay usable: only the oldest beyond
    /// `MAX_LIVE_TOKENS` of the same origin is evicted.
    pub fn issue(
        &self,
        email: &str,
        destination: &str,
        purpose: &str,
        origin: Origin,
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
        tx.execute(
            "DELETE FROM public_sends WHERE sent_at<=?1",
            [now - DAY_SECS],
        )
        .map_err(db_error)?;
        let cooldown = match origin {
            Origin::Admin => ADMIN_COOLDOWN_SECS,
            Origin::Public => {
                let sent: i64 = tx
                    .query_row(
                        "SELECT count(*) FROM public_sends WHERE email=?1",
                        [email],
                        |r| r.get(0),
                    )
                    .map_err(db_error)?;
                if sent >= PUBLIC_DAILY_CAP {
                    return Ok(None);
                }
                PUBLIC_BASE_COOLDOWN_SECS << sent
            }
        };
        if tx
            .execute(
                "INSERT OR IGNORE INTO cooldowns VALUES (?1,?2,?3)",
                params![email, origin.as_str(), now + cooldown],
            )
            .map_err(db_error)?
            == 0
        {
            return Ok(None);
        }
        if origin == Origin::Public {
            tx.execute(
                "INSERT INTO public_sends VALUES (?1,?2)",
                params![email, now],
            )
            .map_err(db_error)?;
        }
        let token = crate::auth::session::SessionStore::generate_token();
        tx.execute(
            "INSERT INTO tokens VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                hash(&token),
                email,
                destination,
                purpose,
                origin.as_str(),
                now + TOKEN_TTL_SECS,
                now
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "DELETE FROM tokens WHERE email=?1 AND purpose=?2 AND origin=?3 AND rowid NOT IN
                (SELECT rowid FROM tokens WHERE email=?1 AND purpose=?2 AND origin=?3
                 ORDER BY issued DESC, rowid DESC LIMIT ?4)",
            params![email, purpose, origin.as_str(), MAX_LIVE_TOKENS],
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
        // Links sent to the previous address must stop working, and the new
        // address may receive a link straight away.
        tx.execute("DELETE FROM tokens WHERE email=?1", [email])
            .map_err(db_error)?;
        tx.execute(
            "DELETE FROM cooldowns WHERE email=?1 AND origin='admin'",
            [email],
        )
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
        for table in ["tokens", "recovery", "cooldowns", "public_sends"] {
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
            .issue("me@example.com", "personal@example.org", "reset", Origin::Admin)
            .unwrap()
            .unwrap();
        assert!(
            store
                .issue("me@example.com", "personal@example.org", "reset", Origin::Admin)
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
            .issue("other@example.com", "personal@example.org", "reset", Origin::Admin)
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
            .issue("me@example.com", "recovery@example.org", "reset", Origin::Admin)
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

    fn expire_cooldowns(store: &Storage) {
        store
            .open()
            .unwrap()
            .execute("UPDATE cooldowns SET until_at=0", [])
            .unwrap();
    }

    #[test]
    fn public_requests_neither_revoke_nor_block_admin_links_and_are_capped() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::new(temp.path().to_str().unwrap()).unwrap();
        let (email, dest) = ("me@example.com", "personal@example.org");
        let admin = store
            .issue(email, dest, "reset", Origin::Admin)
            .unwrap()
            .unwrap();
        // The public cooldown is separate from the administrator's.
        let first = store
            .issue(email, dest, "reset", Origin::Public)
            .unwrap()
            .unwrap();
        assert!(store.issue(email, dest, "reset", Origin::Public).unwrap().is_none());
        let mut public = vec![first];
        for _ in 1..PUBLIC_DAILY_CAP {
            expire_cooldowns(&store);
            public.push(
                store
                    .issue(email, dest, "reset", Origin::Public)
                    .unwrap()
                    .unwrap(),
            );
        }
        // Backoff doubles: after the fifth email the wait is 16 minutes.
        let until: i64 = store
            .open()
            .unwrap()
            .query_row(
                "SELECT until_at FROM cooldowns WHERE origin='public'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(until >= now() + 15 * 60);
        // Daily cap reached, even once cooldowns lapse.
        expire_cooldowns(&store);
        assert!(store.issue(email, dest, "reset", Origin::Public).unwrap().is_none());
        // The administrator can still send a link, and the earlier admin link
        // survives every public request.
        let admin_again = store
            .issue(email, dest, "reset", Origin::Admin)
            .unwrap()
            .unwrap();
        assert_eq!(store.consume(&admin, "reset").unwrap().email, email);
        assert_eq!(store.consume(&admin_again, "reset").unwrap().email, email);
        // At most three public links stay valid: the oldest two were evicted.
        assert!(store.consume(&public[0], "reset").is_err());
        assert!(store.consume(&public[1], "reset").is_err());
        for token in &public[2..] {
            assert!(store.consume(token, "reset").is_ok());
        }
    }

    #[test]
    fn concurrent_links_stay_valid_until_three_newer_exist() {
        let temp = tempfile::tempdir().unwrap();
        let store = Storage::new(temp.path().to_str().unwrap()).unwrap();
        let mut tokens = vec![];
        for _ in 0..4 {
            expire_cooldowns(&store);
            tokens.push(
                store
                    .issue("me@example.com", "p@example.org", "reset", Origin::Admin)
                    .unwrap()
                    .unwrap(),
            );
        }
        assert!(store.consume(&tokens[0], "reset").is_err());
        for token in &tokens[1..] {
            assert!(store.consume(token, "reset").is_ok());
        }
    }

    #[test]
    fn version_zero_database_is_migrated_and_permissions_are_restricted() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("integrations");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("franklymail.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE recovery (email TEXT PRIMARY KEY, destination TEXT NOT NULL);
                CREATE TABLE tokens (hash TEXT PRIMARY KEY, email TEXT NOT NULL, destination TEXT NOT NULL, purpose TEXT NOT NULL, expires INTEGER NOT NULL, issued INTEGER NOT NULL, UNIQUE(email,purpose));
                CREATE TABLE cooldowns (email TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
                INSERT INTO recovery VALUES ('me@example.com','p@example.org');").unwrap();
            conn.execute(
                "INSERT INTO tokens VALUES (?1,'me@example.com','p@example.org','reset',?2,?3)",
                params![hash("old-link"), now() + 600, now()],
            )
            .unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let store = Storage::new(temp.path().to_str().unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&path), 0o600);
        }
        assert_eq!(
            store.recovery("me@example.com").unwrap().as_deref(),
            Some("p@example.org")
        );
        // Outstanding links survive; new ones no longer replace them.
        let new = store
            .issue("me@example.com", "p@example.org", "reset", Origin::Admin)
            .unwrap()
            .unwrap();
        assert!(store.consume("old-link", "reset").is_ok());
        assert!(store.consume(&new, "reset").is_ok());
        // Reopening a migrated database is a no-op.
        drop(store);
        let store = Storage::new(temp.path().to_str().unwrap()).unwrap();
        assert!(store.recovery("me@example.com").unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn new_database_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        Storage::new(temp.path().to_str().unwrap()).unwrap();
        let dir = temp.path().join("integrations");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("franklymail.sqlite")), 0o600);
    }
}
