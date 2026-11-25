//! Failure handling shared by the background IMAP tasks (IDLE and sync).

use std::time::Duration;

use crate::imap::client::{ImapCredentials, ImapError};
use crate::realtime::credentials::CredentialSource;
use crate::realtime::events::{EventBus, MailEvent};

/// Why one attempt of a background task failed.
#[derive(Debug)]
pub(crate) enum TaskError {
    /// The IMAP server rejected the credentials. Never retried with the same
    /// credentials: each retry is a failed login that counts towards bans.
    Auth,
    /// Any other failure (server unreachable, protocol error, DB error, ...).
    Failed(String),
}

impl From<String> for TaskError {
    fn from(message: String) -> Self {
        TaskError::Failed(message)
    }
}

impl TaskError {
    /// Classify an IMAP error: authentication failures are special.
    pub(crate) fn from_imap(context: &str, err: ImapError) -> Self {
        match err {
            ImapError::AuthenticationFailed => TaskError::Auth,
            other => TaskError::Failed(format!("{context}: {other}")),
        }
    }
}

impl std::fmt::Display for TaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskError::Auth => write!(f, "IMAP authentication failed"),
            TaskError::Failed(msg) => write!(f, "{msg}"),
        }
    }
}

/// Exponential backoff that gives up after too many consecutive failures.
#[derive(Debug, Clone)]
pub(crate) struct Backoff {
    initial: Duration,
    max: Duration,
    max_failures: u32,
    failures: u32,
    next: Duration,
}

impl Backoff {
    pub(crate) fn new(initial: Duration, max: Duration, max_failures: u32) -> Self {
        Self { initial, max, max_failures, failures: 0, next: initial }
    }

    /// Forget past failures (after a success).
    pub(crate) fn reset(&mut self) {
        self.failures = 0;
        self.next = self.initial;
    }

    /// Record a failure. Returns the delay before the next attempt, or `None`
    /// once `max_failures` consecutive failures have happened.
    pub(crate) fn next_delay(&mut self) -> Option<Duration> {
        self.failures += 1;
        if self.failures >= self.max_failures {
            return None;
        }
        let delay = self.next;
        self.next = (self.next * 2).min(self.max);
        Some(delay)
    }

    pub(crate) fn failures(&self) -> u32 {
        self.failures
    }
}

/// What to do after the server rejected `creds`.
pub(crate) enum AfterAuthFailure {
    /// Other, not-yet-rejected credentials are available (e.g. the user
    /// logged in again in another tab): retry right away with them.
    RetryWith,
    /// Nothing usable is left: the task must stop.
    Stop,
}

/// Mark `creds` as rejected and, if no other credentials remain, tell the
/// user's clients that they must log in again.
pub(crate) async fn handle_auth_failure(
    credentials: &dyn CredentialSource,
    creds: &ImapCredentials,
    event_bus: &EventBus,
    user_hash: &str,
    task: &str,
) -> AfterAuthFailure {
    credentials.reject(creds);
    if credentials.current().is_some() {
        tracing::info!(user_hash = %user_hash, task, "IMAP rejected credentials; switching to newer ones");
        return AfterAuthFailure::RetryWith;
    }
    tracing::warn!(
        user_hash = %user_hash,
        task,
        "IMAP rejected the session credentials; stopping background task until the user logs in again"
    );
    event_bus.publish(user_hash, MailEvent::ReauthRequired).await;
    AfterAuthFailure::Stop
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_the_cap_then_gives_up() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(4), 5);
        assert_eq!(backoff.next_delay(), Some(Duration::from_secs(1)));
        assert_eq!(backoff.next_delay(), Some(Duration::from_secs(2)));
        assert_eq!(backoff.next_delay(), Some(Duration::from_secs(4)));
        assert_eq!(backoff.next_delay(), Some(Duration::from_secs(4)));
        assert_eq!(backoff.next_delay(), None);
        backoff.reset();
        assert_eq!(backoff.failures(), 0);
        assert_eq!(backoff.next_delay(), Some(Duration::from_secs(1)));
    }

    #[test]
    fn only_authentication_failures_are_classified_as_auth() {
        assert!(matches!(
            TaskError::from_imap("x", ImapError::AuthenticationFailed),
            TaskError::Auth
        ));
        assert!(matches!(
            TaskError::from_imap("x", ImapError::ConnectionFailed("down".into())),
            TaskError::Failed(_)
        ));
        assert!(matches!(
            TaskError::from_imap("x", ImapError::ProtocolError("NO: quota".into())),
            TaskError::Failed(_)
        ));
    }
}
