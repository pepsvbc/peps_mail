use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

mod embedded {
    use refinery::embed_migrations;
    embed_migrations!("migrations");
}

/// Compute a SHA-256 hash of the given email address and return it as a
/// lowercase hex-encoded string (64 characters).
pub fn hash_email(email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.as_bytes());
    let result = hasher.finalize();
    // Format each byte as two lowercase hex digits.
    result.iter().map(|b| format!("{b:02x}")).collect()
}

/// The per-user data key for a login address.
///
/// Mailbox addresses are case-insensitive, so the data directory is keyed by
/// the lower-cased address: every spelling of one mailbox shares one cache,
/// and deleting a mailbox can find its data. Directories created before this
/// (keyed by the address exactly as typed) are moved over on first use.
pub fn user_hash_for_login(data_dir: &str, email: &str) -> String {
    let canonical = hash_email(&email.trim().to_ascii_lowercase());
    let legacy = hash_email(email);
    if legacy != canonical {
        let old_dir = PathBuf::from(data_dir).join(&legacy);
        let new_dir = PathBuf::from(data_dir).join(&canonical);
        if old_dir.is_dir()
            && !new_dir.exists()
            && let Err(error) = fs::rename(&old_dir, &new_dir)
        {
            tracing::warn!(%error, "Could not move legacy user data directory");
        }
    }
    canonical
}

/// Provision a per-user data directory under `data_dir`.
///
/// Creates `{data_dir}/{user_hash}/` with a `tantivy/` subdirectory,
/// opens (or creates) `db.sqlite`, and runs refinery migrations on it.
///
/// This function is idempotent: calling it multiple times with the same
/// arguments is safe and will not produce errors.
///
/// Returns the path to the user directory on success.
pub fn provision_user_data(data_dir: &str, user_hash: &str) -> Result<PathBuf, String> {
    let user_dir = PathBuf::from(data_dir).join(user_hash);

    // Create the user directory and the tantivy subdirectory.
    let tantivy_dir = user_dir.join("tantivy");
    fs::create_dir_all(&tantivy_dir).map_err(|e| format!("failed to create directories: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = fs::metadata(&user_dir).map(|m| m.permissions()) {
            perms.set_mode(0o700); // rwx------
            let _ = fs::set_permissions(&user_dir, perms);
        }
    }

    // Open (or create) the SQLite database.
    let db_path = user_dir.join("db.sqlite");
    let mut conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("failed to open database: {e}"))?;

    // Run refinery migrations.
    embedded::migrations::runner()
        .run(&mut conn)
        .map_err(|e| format!("failed to run migrations: {e}"))?;

    Ok(user_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_hash_ignores_address_case() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        assert_eq!(
            user_hash_for_login(data_dir, "Alice@Example.com"),
            user_hash_for_login(data_dir, "alice@example.com"),
        );
        assert_eq!(user_hash_for_login(data_dir, "alice@example.com"), hash_email("alice@example.com"));
    }

    #[test]
    fn login_hash_moves_legacy_mixed_case_directory() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        let legacy = dir.path().join(hash_email("Alice@Example.com"));
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("db.sqlite"), b"cache").unwrap();

        let hash = user_hash_for_login(data_dir, "Alice@Example.com");

        assert!(!legacy.exists());
        assert_eq!(fs::read(dir.path().join(hash).join("db.sqlite")).unwrap(), b"cache");
    }

    #[test]
    fn hash_email_is_deterministic() {
        let email = "alice@example.com";
        let h1 = hash_email(email);
        let h2 = hash_email(email);
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_email_differs_for_different_emails() {
        let h1 = hash_email("alice@example.com");
        let h2 = hash_email("bob@example.com");
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_email_produces_64_char_hex_string() {
        let h = hash_email("test@example.com");
        assert_eq!(h.len(), 64);
        assert!(
            h.chars().all(|c| c.is_ascii_hexdigit()),
            "hash should be hex-encoded"
        );
    }

    #[test]
    fn provision_creates_directories_and_db() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let data_dir = tmp.path().to_str().unwrap();
        let user_hash = hash_email("test@example.com");

        let user_dir = provision_user_data(data_dir, &user_hash).expect("provisioning failed");

        assert!(user_dir.exists(), "user directory should exist");
        assert!(user_dir.join("db.sqlite").exists(), "db.sqlite should exist");
        assert!(
            user_dir.join("tantivy").is_dir(),
            "tantivy/ subdirectory should exist"
        );
    }

    #[test]
    fn provision_is_idempotent() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let data_dir = tmp.path().to_str().unwrap();
        let user_hash = hash_email("idem@example.com");

        let dir1 = provision_user_data(data_dir, &user_hash).expect("first call failed");
        let dir2 = provision_user_data(data_dir, &user_hash).expect("second call failed");

        assert_eq!(dir1, dir2);
        assert!(dir2.join("db.sqlite").exists());
        assert!(dir2.join("tantivy").is_dir());
    }

    #[test]
    fn migration_creates_user_meta_table() {
        let tmp = tempfile::tempdir().expect("failed to create temp dir");
        let data_dir = tmp.path().to_str().unwrap();
        let user_hash = hash_email("meta@example.com");

        let user_dir = provision_user_data(data_dir, &user_hash).expect("provisioning failed");

        let conn =
            rusqlite::Connection::open(user_dir.join("db.sqlite")).expect("failed to open db");

        let value: String = conn
            .query_row(
                "SELECT value FROM user_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .expect("failed to query user_meta");

        assert_eq!(value, "1");
    }
}
