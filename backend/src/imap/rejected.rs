//! Passwords the mail server has rejected for a signed-in session.
//!
//! When a user's password changes elsewhere, their open sessions still hold
//! the old one. Every IMAP login made with it fails, and repeated failures
//! from this server's IP can get it banned by fail2ban or the provider. The
//! IMAP connection helper records each rejected login here; the auth guard
//! then revokes any session still holding those credentials, so the browser
//! is told to sign in again instead of retrying.
//!
//! Only a keyed hash is stored (the key is random per process), never the
//! password. Entries are cleared when the same credentials log in again,
//! e.g. after the password was changed back.

use std::hash::{BuildHasher, RandomState};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use dashmap::DashMap;

/// Longer than the longest session ("remember me", 30 days).
const REMEMBER_FOR: Duration = Duration::from_secs(31 * 24 * 3600);
/// Bound on memory; only signed-in sessions can add entries.
const MAX_ENTRIES: usize = 10_000;

static KEY: LazyLock<RandomState> = LazyLock::new(RandomState::new);
static REJECTED: LazyLock<DashMap<u64, Instant>> = LazyLock::new(DashMap::new);

fn fingerprint(host: &str, port: u16, email: &str, password: &str) -> u64 {
    KEY.hash_one((host.to_ascii_lowercase(), port, email.to_ascii_lowercase(), password))
}

/// Remember that the server rejected these credentials.
pub(crate) fn record(host: &str, port: u16, email: &str, password: &str) {
    if REJECTED.len() >= MAX_ENTRIES {
        REJECTED.retain(|_, at| at.elapsed() < REMEMBER_FOR);
        if REJECTED.len() >= MAX_ENTRIES {
            REJECTED.clear();
        }
    }
    REJECTED.insert(fingerprint(host, port, email, password), Instant::now());
}

/// The server accepted these credentials again.
pub(crate) fn forget(host: &str, port: u16, email: &str, password: &str) {
    REJECTED.remove(&fingerprint(host, port, email, password));
}

/// Whether the server has rejected these credentials since they last worked.
pub(crate) fn is_rejected(host: &str, port: u16, email: &str, password: &str) -> bool {
    REJECTED
        .get(&fingerprint(host, port, email, password))
        .is_some_and(|at| at.elapsed() < REMEMBER_FOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejection_is_remembered_until_the_credentials_work_again() {
        let (host, email) = ("imap.rejected-test.example", "carol@rejected-test.example");
        assert!(!is_rejected(host, 993, email, "old"));

        record(host, 993, email, "old");
        assert!(is_rejected(host, 993, email, "old"));
        assert!(is_rejected("IMAP.rejected-test.example", 993, "Carol@rejected-test.example", "old"));
        assert!(!is_rejected(host, 993, email, "new"), "a different password is unaffected");
        assert!(!is_rejected(host, 143, email, "old"), "a different server is unaffected");

        forget(host, 993, email, "old");
        assert!(!is_rejected(host, 993, email, "old"));
    }
}
