use std::sync::Arc;
use std::time::Duration;

use dashmap::{DashMap, mapref::entry::Entry};
use futures::StreamExt;
use tokio::task::JoinHandle;

use crate::config::AppConfig;
use crate::imap::client::ImapCredentials;
use crate::imap::connection::ImapStream;
use crate::imap::parse::{decode_rfc2047, flag_to_string, has_attachments, imap_address_to_email};
use crate::realtime::credentials::CredentialSource;
use crate::realtime::events::{EventBus, MailEvent};
use crate::realtime::retry::{AfterAuthFailure, Backoff, TaskError, handle_auth_failure};
use crate::{db, imap};

/// Manages long-lived IMAP IDLE connections, one per (user, folder) pair.
///
/// When a WebSocket client connects, the IdleManager starts IDLE for INBOX.
/// Each socket holds a reference; only the last disconnect stops the watcher.
pub struct IdleManager {
    /// Active IDLE tasks keyed by `(user_hash, folder_name)`.
    tasks: DashMap<(String, String), SharedIdleTask>,
}

struct SharedIdleTask {
    handle: JoinHandle<()>,
    subscribers: usize,
}

impl IdleManager {
    pub fn new() -> Self {
        Self {
            tasks: DashMap::new(),
        }
    }

    /// Start an IDLE task for a specific user + folder.
    /// Reuse an existing watcher and register this socket as a subscriber.
    ///
    /// The watcher looks up fresh credentials from `credentials` on every
    /// (re)connect, so it follows re-logins instead of keeping the first
    /// socket's password. A watcher that stopped (e.g. after the server
    /// rejected the credentials) is restarted by the next subscriber.
    pub async fn start_idle(
        &self,
        user_hash: String,
        folder: String,
        credentials: Arc<dyn CredentialSource>,
        event_bus: Arc<EventBus>,
        config: Arc<AppConfig>,
    ) {
        let key = (user_hash.clone(), folder.clone());
        self.acquire(key, move || tokio::spawn(async move {
            idle_loop(&user_hash, &folder, credentials.as_ref(), &event_bus, &config).await;
        }));
    }

    fn acquire(&self, key: (String, String), start: impl FnOnce() -> JoinHandle<()>) {
        match self.tasks.entry(key) {
            Entry::Occupied(mut entry) => {
                let task = entry.get_mut();
                task.subscribers += 1;
                if task.handle.is_finished() {
                    task.handle = start();
                }
            }
            Entry::Vacant(entry) => {
                entry.insert(SharedIdleTask { handle: start(), subscribers: 1 });
            }
        }
    }

    /// Release one socket's subscription without interrupting other clients.
    pub async fn stop_idle(&self, user_hash: &str, folder: &str) {
        let key = (user_hash.to_string(), folder.to_string());
        if let Entry::Occupied(mut entry) = self.tasks.entry(key) {
            if entry.get().subscribers > 1 {
                entry.get_mut().subscribers -= 1;
            } else {
                entry.remove().handle.abort();
            }
        }
    }

}

impl Default for IdleManager {
    fn default() -> Self {
        Self::new()
    }
}

/// First reconnect delay after an IDLE failure.
const IDLE_INITIAL_BACKOFF: Duration = Duration::from_secs(5);
/// Longest wait between IDLE reconnect attempts.
const IDLE_MAX_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// Consecutive failed (re)connects after which the watcher stops. It is
/// restarted by the next WebSocket connection for the mailbox.
const IDLE_MAX_FAILURES: u32 = 15;
/// A session that ran at least this long before failing counts as healthy:
/// the backoff starts over instead of growing.
const IDLE_STABLE_SESSION: Duration = Duration::from_secs(2 * 60);

/// The inner IDLE loop with auto-reconnect and exponential backoff.
///
/// This opens a dedicated IMAP connection, SELECTs the folder, and enters
/// IDLE mode. When the server notifies of changes, it publishes an event
/// to the EventBus and re-enters IDLE. If the connection drops, it
/// reconnects with exponential backoff, using the current credentials.
async fn idle_loop(
    user_hash: &str,
    folder: &str,
    credentials: &dyn CredentialSource,
    event_bus: &EventBus,
    config: &AppConfig,
) {
    let backoff = Backoff::new(IDLE_INITIAL_BACKOFF, IDLE_MAX_BACKOFF, IDLE_MAX_FAILURES);
    supervise(user_hash, folder, credentials, event_bus, backoff, IDLE_STABLE_SESSION, |creds| async move {
        run_idle_session(user_hash, folder, &creds, event_bus, config).await
    })
    .await;
}

/// Reconnect policy around one long-running session attempt.
///
/// - `Ok(())` ends the loop.
/// - [`TaskError::Auth`] marks the credentials rejected; the loop retries
///   only if newer credentials exist, otherwise it tells the clients to
///   re-authenticate and stops (no retry of a stale password).
/// - Other errors back off exponentially; an attempt that ran for at least
///   `stable_after` restarts the backoff. Too many consecutive failures
///   stop the loop.
async fn supervise<F, Fut>(
    user_hash: &str,
    folder: &str,
    credentials: &dyn CredentialSource,
    event_bus: &EventBus,
    mut backoff: Backoff,
    stable_after: Duration,
    mut attempt: F,
) where
    F: FnMut(ImapCredentials) -> Fut,
    Fut: std::future::Future<Output = Result<(), TaskError>>,
{
    loop {
        let Some(creds) = credentials.current() else {
            tracing::info!(user_hash = %user_hash, folder = %folder, "No usable IMAP credentials; stopping IDLE");
            return;
        };
        let started = tokio::time::Instant::now();
        let error = match attempt(creds.clone()).await {
            Ok(()) => {
                // Session ended normally (shouldn't happen in practice).
                tracing::info!(user_hash = %user_hash, folder = %folder, "IDLE session ended normally");
                return;
            }
            Err(TaskError::Auth) => {
                match handle_auth_failure(credentials, &creds, event_bus, user_hash, "idle").await {
                    AfterAuthFailure::RetryWith => continue,
                    AfterAuthFailure::Stop => return,
                }
            }
            Err(TaskError::Failed(e)) => e,
        };
        if started.elapsed() >= stable_after {
            backoff.reset();
        }
        let Some(delay) = backoff.next_delay() else {
            tracing::warn!(
                user_hash = %user_hash,
                folder = %folder,
                error = %error,
                "IDLE keeps failing; stopping until the next connection"
            );
            return;
        };
        tracing::warn!(
            user_hash = %user_hash,
            folder = %folder,
            error = %error,
            failures = backoff.failures(),
            backoff_secs = delay.as_secs(),
            "IDLE connection failed, will retry"
        );
        tokio::time::sleep(delay).await;
    }
}

/// Run a single IDLE session. Returns Err on connection/protocol errors
/// ([`TaskError::Auth`] if the login was rejected).
///
/// The async-imap IDLE API follows an ownership pattern:
/// `Session` → `.idle()` consumes session → `Handle` → `.init()` sends IDLE
/// → `.wait()` listens → `.done()` sends DONE and returns `Session`.
async fn run_idle_session(
    user_hash: &str,
    folder: &str,
    creds: &ImapCredentials,
    event_bus: &EventBus,
    config: &AppConfig,
) -> Result<(), TaskError> {
    let session = imap::client::connect(creds)
        .await
        .map_err(|e| TaskError::from_imap("IDLE connect failed", e))?;
    run_connected_idle_session(session, user_hash, folder, event_bus, config)
        .await
        .map_err(TaskError::Failed)
}

/// The part of an IDLE session after a successful login.
async fn run_connected_idle_session(
    mut session: async_imap::Session<ImapStream>,
    user_hash: &str,
    folder: &str,
    event_bus: &EventBus,
    config: &AppConfig,
) -> Result<(), String> {

    {
        let conn = db::pool::open_user_db(&config.data_dir, user_hash)
            .map_err(|e| format!("IDLE database error: {e}"))?;
        db::folders::insert_folder_if_new(&conn, folder, None, "")?;
    }

    session
        .select_condstore(folder)
        .await
        .map_err(|e| format!("IDLE SELECT failed: {e}"))?;

    // Catch up an existing Inbox cache immediately after reconnecting. IDLE
    // only reports future changes, so mail received while disconnected would
    // otherwise remain stale until the periodic scan or a folder visit.
    let has_cached_messages = db::pool::open_user_db(&config.data_dir, user_hash)
        .ok()
        .and_then(|conn| db::messages::count_messages(&conn, folder).ok())
        .is_some_and(|count| count > 0);
    if has_cached_messages {
        let changes;
        (session, changes) = fetch_new_after_idle(session, user_hash, folder, config).await;
        publish_reconciliation(event_bus, user_hash, folder, changes).await;
    }

    tracing::info!(user_hash = %user_hash, folder = %folder, "IDLE session started");

    // Re-enter IDLE every 25 minutes (RFC recommends max 29 min).
    let idle_timeout = std::time::Duration::from_secs(25 * 60);

    loop {
        // `.idle()` consumes the session, wrapping it in a Handle.
        let mut idle_handle = session.idle();

        // Initialize the IDLE command with the server.
        idle_handle
            .init()
            .await
            .map_err(|e| format!("IDLE init failed: {e}"))?;

        // Start listening for server notifications.
        // IMPORTANT: `interrupt` must be kept alive — dropping it triggers
        // ManualInterrupt and ends the wait immediately.
        let (idle_wait, interrupt) = idle_handle.wait();

        // Wait for the server to send an unsolicited response, or timeout.
        let result = tokio::time::timeout(idle_timeout, idle_wait).await;

        // Drop the interrupt handle now that we're done waiting.
        drop(interrupt);

        // Send DONE to end IDLE and get the session back.
        session = idle_handle
            .done()
            .await
            .map_err(|e| format!("IDLE done failed: {e}"))?;

        match result {
            Ok(Ok(idle_response)) => {
                use async_imap::extensions::idle::IdleResponse;
                match idle_response {
                    IdleResponse::NewData(_) => {
                        tracing::info!(
                            user_hash = %user_hash,
                            folder = %folder,
                            "IDLE: new data from server"
                        );

                        // CONDSTORE sync is fast (~200-500ms), so run it
                        // BEFORE publishing. This ensures the DB is up-to-date
                        // when the frontend refetches.
                        let result;
                        (session, result) = fetch_new_after_idle(
                            session, user_hash, folder, config,
                        )
                        .await;

                        publish_reconciliation(event_bus, user_hash, folder, result).await;
                    }
                    IdleResponse::Timeout => {
                        tracing::debug!(
                            user_hash = %user_hash,
                            folder = %folder,
                            "IDLE: server-side timeout, re-entering"
                        );
                    }
                    IdleResponse::ManualInterrupt => {
                        tracing::debug!(
                            user_hash = %user_hash,
                            folder = %folder,
                            "IDLE: manual interrupt, re-entering"
                        );
                    }
                }
            }
            Ok(Err(e)) => {
                // IDLE protocol error.
                return Err(format!("IDLE error: {e}"));
            }
            Err(_) => {
                // Our timeout — re-enter IDLE to keep the connection alive.
                tracing::debug!(
                    user_hash = %user_hash,
                    folder = %folder,
                    "IDLE keepalive timeout, re-entering"
                );
            }
        }
    }
}

async fn publish_reconciliation(event_bus: &EventBus, user_hash: &str, folder: &str, result: ReconcileResult) {
    if result.new_count > 0 {
        event_bus.publish(user_hash, MailEvent::NewMessages {
            folder: folder.to_string(), count: result.new_count,
            latest_sender: result.latest_sender, latest_subject: result.latest_subject,
        }).await;
    } else if result.flags_updated > 0 || result.deleted_count > 0 {
        event_bus.publish(user_hash, MailEvent::FlagsChanged { folder: folder.to_string() }).await;
    }
}

/// Summary of what changed during a post-IDLE reconciliation.
struct ReconcileResult {
    new_count: u32,
    flags_updated: u32,
    deleted_count: u32,
    latest_sender: Option<String>,
    latest_subject: Option<String>,
}

impl ReconcileResult {
    fn empty() -> Self {
        Self {
            new_count: 0,
            flags_updated: 0,
            deleted_count: 0,
            latest_sender: None,
            latest_subject: None,
        }
    }
}

/// Reconcile the local cache after IDLE detects new data.
///
/// Uses CONDSTORE when available for fast incremental sync (~200-500ms),
/// falling back to a full UID scan when CONDSTORE is not supported.
///
/// If anything fails, it logs a warning and returns the session unchanged —
/// the periodic sync loop provides a safety net.
async fn fetch_new_after_idle(
    mut session: async_imap::Session<ImapStream>,
    user_hash: &str,
    folder: &str,
    config: &AppConfig,
) -> (async_imap::Session<ImapStream>, ReconcileResult) {
    // Read cached folder state from DB.
    let (cached_modseq, max_cached_uid, cached_count) =
        match db::pool::open_user_db(&config.data_dir, user_hash) {
            Ok(conn) => {
                let modseq = db::folders::get_folder(&conn, folder)
                    .ok()
                    .flatten()
                    .map(|f| f.highest_modseq)
                    .unwrap_or(0);
                let max_uid = db::messages::max_uid(&conn, folder).unwrap_or(0);
                let count = db::messages::count_messages(&conn, folder).unwrap_or(0);
                (modseq, max_uid, count)
            }
            Err(e) => {
                tracing::warn!(error = %e, "IDLE fetch: failed to open DB");
                return (session, ReconcileResult::empty());
            }
        };

    // Re-SELECT with CONDSTORE to get fresh mailbox state.
    let mailbox = match session.select_condstore(folder).await {
        Ok(mb) => mb,
        Err(e) => {
            tracing::warn!(error = %e, "IDLE fetch: select_condstore failed");
            return (session, ReconcileResult::empty());
        }
    };

    let server_exists = mailbox.exists;
    let server_modseq = mailbox.highest_modseq.unwrap_or(0);
    let uid_validity = mailbox.uid_validity.unwrap_or(0);

    // Early exit: nothing changed (CONDSTORE modseq and count both match).
    if server_modseq > 0 && server_modseq == cached_modseq && server_exists == cached_count {
        tracing::debug!(
            user_hash = %user_hash,
            folder = %folder,
            modseq = server_modseq,
            "IDLE fetch: nothing changed (modseq match)"
        );
        return (session, ReconcileResult::empty());
    }

    // ── CONDSTORE fast path ──────────────────────────────────────────
    if cached_modseq > 0 && server_modseq > 0 {
        let fetch_query = format!("(UID FLAGS) (CHANGEDSINCE {})", cached_modseq);
        let changed_items: Option<Vec<(u32, Vec<String>)>> =
            match session.uid_fetch("1:*", &fetch_query).await {
                Ok(stream) => {
                    let mut stream = std::pin::pin!(stream);
                    let mut items = Vec::new();
                    while let Some(result) = stream.next().await {
                        match result {
                            Ok(fetch) => {
                                if let Some(uid) = fetch.uid {
                                    let flags: Vec<String> =
                                        fetch.flags().map(|f| flag_to_string(&f)).collect();
                                    items.push((uid, flags));
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    error = %e,
                                    "IDLE fetch: error reading CHANGEDSINCE stream"
                                );
                                break;
                            }
                        }
                    }
                    Some(items)
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "IDLE fetch: CHANGEDSINCE fetch failed, falling back to full scan"
                    );
                    None
                }
            };

        if let Some(changed) = changed_items {
            // Separate flag changes (uid ≤ max) from new messages (uid > max).
            let mut flag_changes: Vec<(u32, Vec<String>)> = Vec::new();
            let mut has_new = false;
            for (uid, flags) in changed {
                if uid > max_cached_uid {
                    has_new = true;
                } else {
                    flag_changes.push((uid, flags));
                }
            }

            // Apply flag changes to DB.
            let mut flags_updated = 0u32;
            if !flag_changes.is_empty()
                && let Ok(conn) = db::pool::open_user_db(&config.data_dir, user_hash)
            {
                for (uid, flags) in &flag_changes {
                    let mut sorted = flags.clone();
                    sorted.sort();
                    let flags_csv = sorted.join(",");
                    if db::messages::update_message_flags(&conn, folder, *uid, &flags_csv)
                        .is_ok()
                    {
                        flags_updated += 1;
                    }
                }
            }

            // Fetch full headers for new messages.
            let mut new_count = 0u32;
            if has_new {
                let uid_range = format!("{}:*", max_cached_uid + 1);
                new_count = fetch_and_store_headers(
                    &mut session, user_hash, folder, config, &uid_range, max_cached_uid,
                )
                .await;
            }

            // Detect deletions if server count < cached count.
            let mut deleted_count = 0u32;
            if server_exists < cached_count {
                deleted_count =
                    fetch_uids_and_remove_deleted(&mut session, user_hash, folder, config).await;
            }

            // Look up the latest message's sender/subject if new messages arrived.
            let (latest_sender, latest_subject) = if new_count > 0 {
                lookup_latest_message(config, user_hash, folder)
            } else {
                (None, None)
            };

            // Update folder sync status with new modseq.
            if let Ok(conn) = db::pool::open_user_db(&config.data_dir, user_hash) {
                let _ = db::folders::update_folder_sync_status(
                    &conn, folder, uid_validity, server_exists, server_modseq,
                );
                let _ = db::folders::refresh_unread_count(&conn, folder);
            }

            if flags_updated > 0 || new_count > 0 || deleted_count > 0 {
                tracing::info!(
                    user_hash = %user_hash,
                    folder = %folder,
                    flags_updated = flags_updated,
                    new = new_count,
                    deleted = deleted_count,
                    "Reconciled cache after IDLE (CONDSTORE)"
                );
            }

            return (session, ReconcileResult {
                new_count,
                flags_updated,
                deleted_count,
                latest_sender,
                latest_subject,
            });
        }
        // CHANGEDSINCE fetch failed — fall through to full scan below.
    }

    // ── Fallback: full UID scan (no CONDSTORE) ───────────────────────
    let cached_uids: std::collections::HashSet<u32> =
        match db::pool::open_user_db(&config.data_dir, user_hash) {
            Ok(conn) => {
                let uids_flags =
                    db::messages::get_all_uids_and_flags(&conn, folder).unwrap_or_default();
                uids_flags.iter().map(|(uid, _)| *uid).collect()
            }
            Err(e) => {
                tracing::warn!(error = %e, "IDLE fetch: failed to open DB for fallback");
                return (session, ReconcileResult::empty());
            }
        };

    // Fetch all UIDs from server.
    let imap_uids: Option<std::collections::HashSet<u32>> =
        match session.uid_fetch("1:*", "UID").await {
            Ok(stream) => {
                let mut stream = std::pin::pin!(stream);
                let mut uids = std::collections::HashSet::new();
                while let Some(result) = stream.next().await {
                    match result {
                        Ok(fetch) => {
                            if let Some(uid) = fetch.uid {
                                uids.insert(uid);
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "IDLE fetch: error reading UID stream");
                            break;
                        }
                    }
                }
                Some(uids)
            }
            Err(e) => {
                tracing::warn!(error = %e, "IDLE fetch: uid_fetch(UIDs) failed");
                None
            }
        };

    let Some(imap_uids) = imap_uids else {
        return (session, ReconcileResult::empty());
    };

    // Fetch headers for new messages.
    let has_new = imap_uids.iter().any(|&uid| uid > max_cached_uid);
    let mut new_count = 0u32;
    if has_new {
        let uid_range = format!("{}:*", max_cached_uid + 1);
        new_count = fetch_and_store_headers(
            &mut session, user_hash, folder, config, &uid_range, max_cached_uid,
        )
        .await;
    }

    // Delete cached UIDs no longer on server.
    let mut deleted_count = 0u32;
    let deleted_uids: Vec<u32> = cached_uids
        .iter()
        .copied()
        .filter(|uid| !imap_uids.contains(uid))
        .collect();
    if !deleted_uids.is_empty()
        && let Ok(conn) = db::pool::open_user_db(&config.data_dir, user_hash)
    {
        for uid in &deleted_uids {
            if db::messages::delete_message(&conn, folder, *uid).is_ok() {
                deleted_count += 1;
            }
        }
    }

    // Update folder sync status.
    if let Ok(conn) = db::pool::open_user_db(&config.data_dir, user_hash) {
        let _ = db::folders::update_folder_sync_status(
            &conn, folder, uid_validity, server_exists, server_modseq,
        );
        let _ = db::folders::refresh_unread_count(&conn, folder);
    }

    // Look up the latest message's sender/subject if new messages arrived.
    let (latest_sender, latest_subject) = if new_count > 0 {
        lookup_latest_message(config, user_hash, folder)
    } else {
        (None, None)
    };

    if new_count > 0 || deleted_count > 0 {
        tracing::info!(
            user_hash = %user_hash,
            folder = %folder,
            new = new_count,
            deleted = deleted_count,
            "Reconciled cache after IDLE (full scan)"
        );
    }

    (session, ReconcileResult {
        new_count,
        flags_updated: 0,
        deleted_count,
        latest_sender,
        latest_subject,
    })
}

/// Look up the most recent message in the DB for sender/subject details.
fn lookup_latest_message(
    config: &AppConfig,
    user_hash: &str,
    folder: &str,
) -> (Option<String>, Option<String>) {
    let Ok(conn) = db::pool::open_user_db(&config.data_dir, user_hash) else {
        return (None, None);
    };
    let max_uid = db::messages::max_uid(&conn, folder).unwrap_or(0);
    if max_uid == 0 {
        return (None, None);
    }
    match db::messages::get_single_message(&conn, folder, max_uid) {
        Ok(Some(msg)) => {
            let sender = if !msg.from_name.is_empty() {
                Some(msg.from_name)
            } else if !msg.from_address.is_empty() {
                Some(msg.from_address)
            } else {
                None
            };
            let subject = if !msg.subject.is_empty() {
                Some(msg.subject)
            } else {
                None
            };
            (sender, subject)
        }
        _ => (None, None),
    }
}

/// Fetch full headers for messages in the given UID range and store them in the DB.
/// Skips messages with UID ≤ `min_uid` (handles the `*` wildcard returning the last message).
/// Returns the number of new messages stored.
async fn fetch_and_store_headers(
    session: &mut async_imap::Session<ImapStream>,
    user_hash: &str,
    folder: &str,
    config: &AppConfig,
    uid_range: &str,
    min_uid: u32,
) -> u32 {
    let fetches: Option<Vec<_>> = match session
        .uid_fetch(
            uid_range,
            "(UID ENVELOPE FLAGS BODYSTRUCTURE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (Message-ID In-Reply-To References Content-Class x-ms-exchange-generated-message-class)])",
        )
        .await
    {
        Ok(stream) => {
            let mut stream = std::pin::pin!(stream);
            let mut items = Vec::new();
            while let Some(result) = stream.next().await {
                match result {
                    Ok(fetch) => items.push(fetch),
                    Err(e) => {
                        tracing::warn!(error = %e, "IDLE fetch: error reading header stream");
                        break;
                    }
                }
            }
            Some(items)
        }
        Err(e) => {
            tracing::warn!(error = %e, "IDLE fetch: uid_fetch(headers) failed");
            None
        }
    };

    let mut new_count = 0u32;
    if let Some(fetches) = fetches
        && let Ok(conn) = db::pool::open_user_db(&config.data_dir, user_hash)
    {
        for fetch in &fetches {
            let uid = match fetch.uid {
                Some(u) if u > min_uid => u,
                Some(_) => continue, // UID "*" can return the last message
                None => continue,
            };

            // Parse threading headers.
            let raw_header_bytes = fetch.header();
            let parsed_threading = raw_header_bytes
                .and_then(|raw| mail_parser::MessageParser::default().parse(raw));

            let (subject, from, to, cc, date) = if let Some(env) = fetch.envelope() {
                let subject = env
                    .subject
                    .as_ref()
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .map(decode_rfc2047);

                let from: Vec<_> = env
                    .from
                    .as_ref()
                    .map(|addrs| addrs.iter().map(imap_address_to_email).collect())
                    .unwrap_or_default();

                let to: Vec<_> = env
                    .to
                    .as_ref()
                    .map(|addrs| addrs.iter().map(imap_address_to_email).collect())
                    .unwrap_or_default();

                let cc: Vec<_> = env
                    .cc
                    .as_ref()
                    .map(|addrs| addrs.iter().map(imap_address_to_email).collect())
                    .unwrap_or_default();

                let date = env
                    .date
                    .as_ref()
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .map(|s| s.to_string());

                (subject, from, to, cc, date)
            } else {
                (None, vec![], vec![], vec![], None)
            };

            let message_id = parsed_threading
                .as_ref()
                .and_then(|p| p.message_id().map(|s| format!("<{s}>")));
            let in_reply_to = parsed_threading.as_ref().and_then(|p| {
                let val = p.in_reply_to();
                val.as_text().map(|s| format!("<{s}>"))
            });
            let references = parsed_threading.as_ref().and_then(|p| {
                let val = p.references();
                val.as_text_list()
                    .map(|list| {
                        list.iter()
                            .map(|s| format!("<{s}>"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .or_else(|| val.as_text().map(|s| format!("<{s}>")))
            });

            // Detect Outlook/Exchange reaction emails from headers.
            let reaction = raw_header_bytes.and_then(|raw| {
                let header_str = std::str::from_utf8(raw).ok()?;
                let lower = header_str.to_lowercase();
                let is_reaction = lower.contains("content-class: activitynotification")
                    || lower.contains("urn:content-class:reaction");
                if !is_reaction {
                    return None;
                }
                let subj = subject.as_deref().unwrap_or("").to_lowercase();
                let emoji = match subj.trim() {
                    s if s.contains("like") => "\u{1f44d}",
                    s if s.contains("heart") || s.contains("love") => "\u{2764}\u{fe0f}",
                    s if s.contains("laugh") => "\u{1f604}",
                    s if s.contains("surprised") || s.contains("wow") => "\u{1f62e}",
                    s if s.contains("sad") => "\u{1f622}",
                    s if s.contains("angry") => "\u{1f620}",
                    _ => "\u{1f44d}",
                };
                Some(emoji.to_string())
            });

            let flags: Vec<String> = fetch.flags().map(|f| flag_to_string(&f)).collect();
            let has_attach = fetch
                .bodystructure()
                .map(|bs| has_attachments(bs))
                .unwrap_or(false);
            let size = fetch.size.unwrap_or(0);

            let from_address = from.first().map(|a| a.address.as_str()).unwrap_or("");
            let from_name = from.first().and_then(|a| a.name.as_deref()).unwrap_or("");
            let to_json = serde_json::to_string(&to).unwrap_or_else(|_| "[]".to_string());
            let cc_json = serde_json::to_string(&cc).unwrap_or_else(|_| "[]".to_string());
            let subject_str = subject.as_deref().unwrap_or("");
            let date_str = date.as_deref().unwrap_or("");
            let flags_csv = flags.join(",");

            if let Err(e) = db::messages::upsert_message(
                &conn,
                folder,
                uid,
                message_id.as_deref(),
                in_reply_to.as_deref(),
                references.as_deref(),
                subject_str,
                from_address,
                from_name,
                &to_json,
                &cc_json,
                date_str,
                &flags_csv,
                size,
                has_attach,
                "",
                reaction.as_deref(),
            ) {
                tracing::warn!(uid = uid, error = %e, "IDLE fetch: failed to upsert message");
            } else {
                // Populate denormalized known_addresses table.
                if let Err(e) = db::known_addresses::populate_known_addresses(
                    &conn, from_address, from_name, &to_json, &cc_json,
                ) {
                    tracing::warn!(uid = uid, error = %e, "IDLE fetch: failed to populate known addresses");
                }
                new_count += 1;
            }
        }
    }

    new_count
}

/// Fetch all UIDs from the server and remove cached messages no longer present.
/// Used for deletion detection when server count < cached count.
/// Returns the number of deleted messages.
async fn fetch_uids_and_remove_deleted(
    session: &mut async_imap::Session<ImapStream>,
    user_hash: &str,
    folder: &str,
    config: &AppConfig,
) -> u32 {
    let imap_uids: Option<std::collections::HashSet<u32>> =
        match session.uid_fetch("1:*", "UID").await {
            Ok(stream) => {
                let mut stream = std::pin::pin!(stream);
                let mut uids = std::collections::HashSet::new();
                while let Some(result) = stream.next().await {
                    match result {
                        Ok(fetch) => {
                            if let Some(uid) = fetch.uid {
                                uids.insert(uid);
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                "IDLE fetch: error reading UID stream for deletion check"
                            );
                            break;
                        }
                    }
                }
                Some(uids)
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "IDLE fetch: uid_fetch(UIDs) failed for deletion check"
                );
                None
            }
        };

    let Some(imap_uids) = imap_uids else {
        return 0;
    };

    let mut deleted_count = 0u32;
    if let Ok(conn) = db::pool::open_user_db(&config.data_dir, user_hash) {
        let cached = db::messages::get_all_uids_and_flags(&conn, folder).unwrap_or_default();
        for (uid, _) in &cached {
            if !imap_uids.contains(uid)
                && db::messages::delete_message(&conn, folder, *uid).is_ok()
            {
                deleted_count += 1;
            }
        }
    }

    deleted_count
}


#[cfg(test)]
mod shared_idle_tests {
    use super::*;

    #[tokio::test]
    async fn reconnecting_or_closing_one_tab_keeps_other_subscribers_alive() {
        let manager = IdleManager::new();
        let key = ("user".to_string(), "INBOX".to_string());
        manager.acquire(key.clone(), || tokio::spawn(std::future::pending()));
        let watcher = manager.tasks.get(&key).unwrap().handle.abort_handle();
        manager.acquire(key.clone(), || panic!("must share the existing watcher"));
        manager.stop_idle("user", "INBOX").await;
        assert!(manager.tasks.contains_key(&key));
        assert!(!watcher.is_finished());
        manager.stop_idle("user", "INBOX").await;
        assert!(!manager.tasks.contains_key(&key));
        tokio::task::yield_now().await;
        assert!(watcher.is_finished());
    }

    #[tokio::test]
    async fn a_stopped_watcher_is_restarted_by_the_next_subscriber() {
        let manager = IdleManager::new();
        let key = ("user".to_string(), "INBOX".to_string());
        manager.acquire(key.clone(), || tokio::spawn(async {}));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut restarted = false;
        manager.acquire(key.clone(), || {
            restarted = true;
            tokio::spawn(std::future::pending())
        });
        assert!(restarted, "finished watcher must be replaced");
        assert_eq!(manager.tasks.get(&key).unwrap().subscribers, 2);
    }
}

#[cfg(test)]
mod supervise_tests {
    use super::*;
    use crate::realtime::credentials::{CredentialRegistry, test_creds};
    use std::sync::Mutex;

    const USER: &str = "idle-test-user";

    fn fast_backoff(max_failures: u32) -> Backoff {
        Backoff::new(Duration::from_millis(1), Duration::from_millis(5), max_failures)
    }

    /// Run `supervise` with an attempt that records the password it was given
    /// and returns the next scripted result (`Failed` once the script ends).
    async fn run(
        registry: &Arc<CredentialRegistry>,
        event_bus: &EventBus,
        max_failures: u32,
        script: Vec<Result<(), TaskError>>,
    ) -> Vec<String> {
        let source = registry.source(USER);
        let seen = Mutex::new(Vec::new());
        let script = Mutex::new(script.into_iter());
        tokio::time::timeout(
            Duration::from_secs(5),
            supervise(USER, "INBOX", source.as_ref(), event_bus, fast_backoff(max_failures), Duration::from_secs(3600), |creds| {
                seen.lock().unwrap().push(creds.password.clone());
                let next = script
                    .lock()
                    .unwrap()
                    .next()
                    .unwrap_or_else(|| Err(TaskError::Failed("down".into())));
                async move { next }
            }),
        )
        .await
        .expect("supervise must terminate");
        seen.into_inner().unwrap()
    }

    #[tokio::test]
    async fn authentication_failure_stops_without_retrying_and_requests_relogin() {
        let registry = Arc::new(CredentialRegistry::default());
        let _lease = registry.register(USER, test_creds("stale"));
        let event_bus = EventBus::new();
        let mut events = event_bus.subscribe(USER).await;

        let attempts = run(&registry, &event_bus, 100, vec![Err(TaskError::Auth)]).await;

        assert_eq!(attempts, vec!["stale"]);
        assert!(matches!(events.try_recv(), Ok(MailEvent::ReauthRequired)));
    }

    #[tokio::test]
    async fn reconnects_with_the_newest_credentials() {
        let registry = Arc::new(CredentialRegistry::default());
        let _old = registry.register(USER, test_creds("old"));
        let event_bus = EventBus::new();
        let source = registry.source(USER);
        let seen = Mutex::new(Vec::new());
        let registry_for_attempt = registry.clone();
        let leases = Mutex::new(Vec::new());

        supervise(USER, "INBOX", source.as_ref(), &event_bus, fast_backoff(100), Duration::from_secs(3600), |creds| {
            let mut seen = seen.lock().unwrap();
            seen.push(creds.password.clone());
            // The user logs in again while the first connection is down.
            if seen.len() == 1 {
                leases.lock().unwrap().push(registry_for_attempt.register(USER, test_creds("new")));
            }
            let result = if seen.len() == 1 { Err(TaskError::Failed("dropped".into())) } else { Ok(()) };
            async move { result }
        })
        .await;

        assert_eq!(seen.into_inner().unwrap(), vec!["old", "new"]);
    }

    #[tokio::test]
    async fn other_failures_are_capped() {
        let registry = Arc::new(CredentialRegistry::default());
        let _lease = registry.register(USER, test_creds("pw"));
        let event_bus = EventBus::new();
        let mut events = event_bus.subscribe(USER).await;

        let attempts = run(&registry, &event_bus, 6, vec![]).await;

        assert_eq!(attempts.len(), 6);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn stops_when_no_socket_holds_credentials() {
        let registry = Arc::new(CredentialRegistry::default());
        let event_bus = EventBus::new();
        let attempts = run(&registry, &event_bus, 100, vec![]).await;
        assert!(attempts.is_empty());
    }
}
