//! Live IMAP credentials for the per-mailbox background tasks.
//!
//! The IDLE watcher and the periodic sync loop are shared by every socket of
//! a mailbox and outlive the socket that started them. Instead of holding
//! that first socket's password forever, they ask this registry for the
//! current credentials before every (re)connect:
//!
//! - each open socket registers its account's credentials and keeps a
//!   [`CredentialLease`] that removes them again when the socket closes;
//! - the newest registered credentials win, so re-logging in (which opens a
//!   new socket) is picked up by the already-running tasks;
//! - credentials the IMAP server rejected are remembered and never handed out
//!   again, so a stale password is not retried in a loop (repeated failed
//!   logins can get the server's IP banned for every user).

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use crate::imap::client::ImapCredentials;

/// Most rejected credential fingerprints remembered per mailbox.
const MAX_REJECTED: usize = 8;

/// Process-wide registry used by WebSocket handlers.
pub static CREDENTIALS: LazyLock<Arc<CredentialRegistry>> =
    LazyLock::new(|| Arc::new(CredentialRegistry::default()));

/// Where a background task gets the credentials for its next connection.
pub trait CredentialSource: Send + Sync {
    /// The newest credentials not known to be rejected, if any.
    fn current(&self) -> Option<ImapCredentials>;
    /// Record that the IMAP server rejected these credentials.
    fn reject(&self, creds: &ImapCredentials);
}

#[derive(Default)]
struct UserEntry {
    /// `(lease id, credentials)` in registration order.
    entries: Vec<(u64, ImapCredentials)>,
    /// Fingerprints of credentials the server rejected.
    rejected: Vec<u64>,
}

/// Credentials registered by open sockets, keyed by `user_hash`.
#[derive(Default)]
pub struct CredentialRegistry {
    users: Mutex<HashMap<String, UserEntry>>,
    next_id: AtomicU64,
}

/// Fingerprint used to remember rejected credentials without keeping
/// another copy of the password around.
fn fingerprint(creds: &ImapCredentials) -> u64 {
    let mut hasher = DefaultHasher::new();
    (&creds.host, creds.port, creds.tls, &creds.email, &creds.password).hash(&mut hasher);
    hasher.finish()
}

impl CredentialRegistry {
    /// Register a socket's credentials for `user_hash` until the lease drops.
    pub fn register(self: &Arc<Self>, user_hash: &str, creds: ImapCredentials) -> CredentialLease {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut users = self.users.lock().unwrap_or_else(|e| e.into_inner());
        users
            .entry(user_hash.to_string())
            .or_default()
            .entries
            .push((id, creds));
        CredentialLease {
            registry: Arc::clone(self),
            user_hash: user_hash.to_string(),
            id,
        }
    }

    /// The newest registered credentials for `user_hash` that were not rejected.
    pub fn current(&self, user_hash: &str) -> Option<ImapCredentials> {
        let users = self.users.lock().unwrap_or_else(|e| e.into_inner());
        let user = users.get(user_hash)?;
        user.entries
            .iter()
            .rev()
            .map(|(_, creds)| creds)
            .find(|creds| !user.rejected.contains(&fingerprint(creds)))
            .cloned()
    }

    /// Remember that the server rejected `creds` for `user_hash`.
    pub fn reject(&self, user_hash: &str, creds: &ImapCredentials) {
        let mut users = self.users.lock().unwrap_or_else(|e| e.into_inner());
        let Some(user) = users.get_mut(user_hash) else {
            return;
        };
        let print = fingerprint(creds);
        if !user.rejected.contains(&print) {
            if user.rejected.len() >= MAX_REJECTED {
                user.rejected.remove(0);
            }
            user.rejected.push(print);
        }
    }

    /// A [`CredentialSource`] bound to one mailbox of this registry.
    pub fn source(self: &Arc<Self>, user_hash: &str) -> Arc<dyn CredentialSource> {
        Arc::new(UserCredentials {
            registry: Arc::clone(self),
            user_hash: user_hash.to_string(),
        })
    }

    fn release(&self, user_hash: &str, id: u64) {
        let mut users = self.users.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(user) = users.get_mut(user_hash) {
            user.entries.retain(|(entry_id, _)| *entry_id != id);
            if user.entries.is_empty() {
                users.remove(user_hash);
            }
        }
    }
}

/// Keeps a socket's credentials registered; dropping it unregisters them.
pub struct CredentialLease {
    registry: Arc<CredentialRegistry>,
    user_hash: String,
    id: u64,
}

impl Drop for CredentialLease {
    fn drop(&mut self) {
        self.registry.release(&self.user_hash, self.id);
    }
}

struct UserCredentials {
    registry: Arc<CredentialRegistry>,
    user_hash: String,
}

impl CredentialSource for UserCredentials {
    fn current(&self) -> Option<ImapCredentials> {
        self.registry.current(&self.user_hash)
    }

    fn reject(&self, creds: &ImapCredentials) {
        self.registry.reject(&self.user_hash, creds);
    }
}

#[cfg(test)]
pub(crate) fn test_creds(password: &str) -> ImapCredentials {
    ImapCredentials {
        host: "imap.example.com".to_string(),
        port: 993,
        tls: true,
        email: "user@example.com".to_string(),
        password: password.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_registration_wins_and_leases_release() {
        let registry = Arc::new(CredentialRegistry::default());
        let first = registry.register("u", test_creds("old"));
        assert_eq!(registry.current("u").unwrap().password, "old");
        let second = registry.register("u", test_creds("new"));
        assert_eq!(registry.current("u").unwrap().password, "new");
        drop(second);
        assert_eq!(registry.current("u").unwrap().password, "old");
        drop(first);
        assert!(registry.current("u").is_none());
        assert!(registry.users.lock().unwrap().is_empty());
    }

    #[test]
    fn rejected_credentials_are_never_handed_out_again() {
        let registry = Arc::new(CredentialRegistry::default());
        let source = registry.source("u");
        let _old = registry.register("u", test_creds("old"));
        source.reject(&test_creds("old"));
        assert!(source.current().is_none());

        // Re-registering the same stale password (another tab) does not help.
        let _stale = registry.register("u", test_creds("old"));
        assert!(source.current().is_none());

        // Logging in again with the new password does.
        let _new = registry.register("u", test_creds("new"));
        assert_eq!(source.current().unwrap().password, "new");

        // A newer stale socket falls back to the working credentials.
        let _stale_again = registry.register("u", test_creds("old"));
        assert_eq!(source.current().unwrap().password, "new");
    }

    #[test]
    fn mailboxes_are_isolated() {
        let registry = Arc::new(CredentialRegistry::default());
        let _a = registry.register("a", test_creds("pa"));
        let _b = registry.register("b", test_creds("pb"));
        registry.reject("a", &test_creds("pa"));
        assert!(registry.current("a").is_none());
        assert_eq!(registry.current("b").unwrap().password, "pb");
    }
}
