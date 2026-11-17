use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, TransactionBehavior};

/// Migration scripts for the instance-wide shared database, in order.
/// Each entry is (version, sql); the applied version is kept in `user_version`.
const SHARED_MIGRATIONS: &[(u32, &str)] = &[(
    1,
    include_str!("../../migrations/shared/S001__lists.sql"),
)];

/// How long a connection waits for another user's write lock before failing.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

fn user_version(conn: &Connection) -> Result<u32, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("Failed to read user_version: {e}"))
}

/// Run any pending shared migrations.
///
/// Several users can open the shared database at once, so each migration is
/// applied inside an IMMEDIATE transaction that re-checks `user_version`
/// first: only one connection applies it, the others wait and skip it.
fn run_shared_migrations(conn: &mut Connection) -> Result<(), String> {
    let latest = SHARED_MIGRATIONS.last().map_or(0, |&(version, _)| version);
    if user_version(conn)? >= latest {
        return Ok(());
    }

    for &(version, sql) in SHARED_MIGRATIONS {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("Failed to start migration transaction: {e}"))?;
        if version > user_version(&tx)? {
            tx.execute_batch(sql)
                .map_err(|e| format!("Shared migration S{version:03} failed: {e}"))?;
            tx.execute_batch(&format!("PRAGMA user_version = {version};"))
                .map_err(|e| format!("Failed to set user_version to {version}: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit shared migration S{version:03}: {e}"))?;
    }

    Ok(())
}

/// Opens the instance-wide SQLite database at `{data_dir}/shared.sqlite`.
///
/// Holds data shared between users (distribution lists, known sign-ins).
/// Creates the data directory if needed, restricts the file to the server
/// user, enables WAL, a busy timeout and foreign keys, then runs any pending
/// shared migrations.
pub fn open_shared_db(data_dir: &str) -> Result<Connection, String> {
    let dir = Path::new(data_dir);
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create data dir: {e}"))?;

    let db_path = dir.join("shared.sqlite");
    let mut conn =
        Connection::open(&db_path).map_err(|e| format!("Failed to open shared SQLite: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&db_path, fs::Permissions::from_mode(0o600)); // rw-------
    }

    // Other users may be writing; wait for their lock instead of failing.
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("Failed to set busy timeout: {e}"))?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {e}"))?;

    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Failed to enable foreign keys: {e}"))?;

    run_shared_migrations(&mut conn)?;

    Ok(conn)
}

/// Opens an in-memory shared database with all shared migrations applied.
#[cfg(test)]
pub fn open_test_shared_db() -> Connection {
    let mut conn = Connection::open_in_memory().expect("Failed to open in-memory SQLite");
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .expect("Failed to enable foreign keys");
    run_shared_migrations(&mut conn).expect("Shared test migrations failed");
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_shared_db_creates_file_with_schema() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_str().unwrap();

        let conn = open_shared_db(data_dir).unwrap();
        let db_file = tmp.path().join("shared.sqlite");
        assert!(db_file.exists());

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for table in ["list_access", "list_members", "lists", "users"] {
            assert!(tables.contains(&table.to_string()), "missing {table}");
        }

        let fk: i32 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(user_version(&conn).unwrap(), 1);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&db_file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        drop(conn);

        // Re-opening is idempotent.
        let conn = open_shared_db(data_dir).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 1);
    }
}
