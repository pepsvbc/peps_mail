use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use dashmap::DashMap;
use futures::StreamExt;
use tokio::sync::Semaphore;

use super::connection::{escape_quoted, map_imap_error, quote_mailbox, validate_mailbox};
use super::parse::{
    decode_rfc2047, flag_to_string, has_attachments, imap_address_to_email, name_attribute_to_string,
};

pub use super::error::ImapError;
pub use super::types::{
    DraftSyncRequest, DraftSyncResult, EmailAddress, FolderStatus, FolderStatusExtended, ImapAttachment, ImapCredentials, ImapFolder,
    ImapMessageBody, ImapMessageHeader, MailboxQuota,
};

pub(crate) use super::connection::connect;

#[cfg(test)]
#[path = "mock.rs"]
pub mod mock;

/// Abstraction over IMAP operations.
///
/// Every method receives explicit connection parameters so that the trait
/// remains stateless — no persistent connections are held.
///
/// The `Send + Sync` bounds allow implementations to be shared across
/// Tokio tasks and stored in `Arc`.
#[allow(dead_code)]
// async_trait adds #[must_use] to methods returning already must-use futures.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait ImapClient: Send + Sync {
    /// List all folders (mailboxes) on the server.
    async fn list_folders(&self, creds: &ImapCredentials) -> Result<Vec<ImapFolder>, ImapError>;

    /// Read unread mail using the standard STATUS UNSEEN item only, without
    /// requiring optional extensions such as CONDSTORE.
    async fn folder_unread_count(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<u32, ImapError>;

    /// Perform a lightweight `SELECT` on a folder to get its status
    /// (UIDVALIDITY, EXISTS count, UIDNEXT) without fetching any messages.
    async fn folder_status(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<FolderStatus, ImapError>;

    /// Fetch message headers (envelopes) for a range of UIDs in a folder.
    async fn fetch_headers(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid_range: &str,
    ) -> Result<Vec<ImapMessageHeader>, ImapError>;

    /// Fetch bounded text previews without marking messages read.
    async fn fetch_previews(
        &self,
        _creds: &ImapCredentials,
        _folder: &str,
        _uids: &[u32],
    ) -> Result<Vec<(u32, String)>, ImapError> {
        Ok(Vec::new())
    }

    /// Fetch the full body of a single message by UID.
    async fn fetch_body(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
    ) -> Result<ImapMessageBody, ImapError>;

    /// Add flags to a message (IMAP +FLAGS).
    async fn add_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError>;

    /// Remove flags from a message (IMAP -FLAGS).
    async fn remove_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError>;

    /// Set (replace) the flags on a message.
    async fn set_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError>;

    /// Move a message from one folder to another.
    async fn move_message(
        &self,
        creds: &ImapCredentials,
        from_folder: &str,
        uid: u32,
        to_folder: &str,
    ) -> Result<(), ImapError>;

    /// Permanently remove a message that has the `\Deleted` flag.
    async fn expunge_message(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
    ) -> Result<(), ImapError>;

    /// Append a raw RFC822 message to a folder (e.g. saving sent mail to "Sent").
    async fn append_message(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        message_bytes: &[u8],
        flags: &[&str],
    ) -> Result<(), ImapError>;

    /// Save or remove a tracked draft, preserving unrelated mailbox contents.
    async fn sync_draft(&self, creds: &ImapCredentials, request: &DraftSyncRequest) -> Result<DraftSyncResult, ImapError>;

    /// Create a new folder (mailbox) and subscribe to it.
    async fn create_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
    ) -> Result<(), ImapError>;

    /// Rename an existing folder.
    async fn rename_folder(
        &self,
        creds: &ImapCredentials,
        from: &str,
        to: &str,
    ) -> Result<(), ImapError>;

    /// Permanently delete a folder (mailbox).
    async fn delete_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
    ) -> Result<(), ImapError>;

    /// Subscribe to or unsubscribe from a folder.
    async fn subscribe_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
        subscribe: bool,
    ) -> Result<(), ImapError>;

    /// Fetch only UIDs and FLAGS for all messages in a folder.
    /// Used for periodic reconciliation to detect flag changes and deletions.
    async fn fetch_uids_and_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<Vec<(u32, Vec<String>)>, ImapError>;

    /// Lightweight STATUS command to get folder metadata without SELECT.
    /// Returns UIDVALIDITY, EXISTS, UIDNEXT, UNSEEN, and HIGHESTMODSEQ.
    async fn folder_status_extended(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<FolderStatusExtended, ImapError>;

    /// Fetch only messages whose flags changed since `since_modseq` using CONDSTORE.
    /// Returns (vec of (uid, flags), new_highest_modseq).
    async fn fetch_changed_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        since_modseq: u64,
    ) -> Result<(Vec<(u32, Vec<String>)>, u64), ImapError>;

    /// Fetch mailbox quota via IMAP GETQUOTAROOT.
    /// Returns `None` if the server doesn't support quotas.
    async fn get_quota(
        &self,
        creds: &ImapCredentials,
    ) -> Result<Option<MailboxQuota>, ImapError>;

    /// Fetch the total size of all messages in a folder via UID FETCH 1:* (RFC822.SIZE).
    async fn fetch_folder_size(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<u64, ImapError>;
}

// ---------------------------------------------------------------------------
// Real implementation backed by async-imap
// ---------------------------------------------------------------------------

/// Production IMAP client that uses `async-imap` and `mail-parser`.
///
/// This is a stateless unit struct — every method creates a fresh connection,
/// performs the operation, and disconnects.
///
/// Every call validates its mailbox/flag arguments, waits for one of the
/// account's request-path connection slots and runs under an overall
/// deadline (see [`guarded`]).
pub struct RealImapClient;

// ---- Connection budget ------------------------------------------------------

/// Request-path IMAP connections one account may hold open at once.
///
/// Every HTTP request (and the per-WebSocket periodic sync, which runs one
/// operation at a time) opens its own short-lived IMAP login through this
/// client. IDLE sessions are deliberately *not* counted: they connect through
/// `connection::connect` directly, stay open for up to 25 minutes per folder
/// and are already bounded by the IDLE manager, so counting them here would
/// starve interactive requests.
const MAX_CONNECTIONS_PER_ACCOUNT: usize = 6;
/// How long a request waits for a free slot before giving up.
const SLOT_WAIT: Duration = Duration::from_secs(20);
/// Deadline for small commands (STATUS, STORE, MOVE, folder management...).
const SHORT_OP_TIMEOUT: Duration = Duration::from_secs(60);
/// Deadline for operations that can transfer a lot of data (FETCH, APPEND).
const LONG_OP_TIMEOUT: Duration = Duration::from_secs(300);

/// Message returned when an account has too many IMAP operations in flight.
pub(crate) const TOO_MANY_CONNECTIONS: &str =
    "Too many concurrent mail server connections for this account";

type SlotMap = DashMap<String, Arc<Semaphore>>;

static ACCOUNT_SLOTS: LazyLock<SlotMap> = LazyLock::new(DashMap::new);

fn slot_key(creds: &ImapCredentials) -> String {
    format!(
        "{}|{}:{}",
        creds.email.trim().to_lowercase(),
        creds.host.trim().to_lowercase(),
        creds.port
    )
}

/// Run `op` while holding one of the account's connection slots, under an
/// overall deadline. Dropping `op` on timeout closes its IMAP connection.
async fn guarded<T>(
    creds: &ImapCredentials,
    deadline: Duration,
    op: impl Future<Output = Result<T, ImapError>>,
) -> Result<T, ImapError> {
    run_limited(
        &ACCOUNT_SLOTS,
        slot_key(creds),
        MAX_CONNECTIONS_PER_ACCOUNT,
        SLOT_WAIT,
        deadline,
        op,
    )
    .await
}

async fn run_limited<T>(
    slots: &SlotMap,
    key: String,
    max: usize,
    wait: Duration,
    deadline: Duration,
    op: impl Future<Output = Result<T, ImapError>>,
) -> Result<T, ImapError> {
    // Cloned while the shard lock is held, so the cleanup below can trust
    // the reference count.
    let semaphore = slots
        .entry(key.clone())
        .or_insert_with(|| Arc::new(Semaphore::new(max)))
        .clone();
    let result = match tokio::time::timeout(wait, semaphore.clone().acquire_owned()).await {
        Ok(Ok(_permit)) => tokio::time::timeout(deadline, op).await.unwrap_or_else(|_| {
            Err(ImapError::ConnectionFailed(format!(
                "IMAP operation timed out after {}s",
                deadline.as_secs()
            )))
        }),
        Ok(Err(_)) => Err(ImapError::ConnectionFailed(
            "IMAP connection limiter closed".to_string(),
        )),
        Err(_) => Err(ImapError::ConnectionFailed(TOO_MANY_CONNECTIONS.to_string())),
    };
    drop(semaphore);
    // Forget idle accounts so the map doesn't grow without bound.
    slots.remove_if(&key, |_, s| Arc::strong_count(s) == 1);
    result
}

/// Reject flags that are not a system flag (`\Seen`) or a keyword atom.
///
/// Flags are joined verbatim into STORE/APPEND commands, so anything that
/// isn't an IMAP atom (spaces, parentheses, quotes, CR/LF...) could change
/// the command.
fn validate_flags(flags: &[&str]) -> Result<(), ImapError> {
    let is_atom = |s: &str| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes().all(|b| {
                b.is_ascii_graphic() && !matches!(b, b'(' | b')' | b'{' | b'%' | b'*' | b'"' | b'\\' | b']')
            })
    };
    for flag in flags {
        let ok = match flag.strip_prefix('\\') {
            Some(system) => is_atom(system),
            None => is_atom(flag),
        };
        if !ok {
            return Err(ImapError::ProtocolError(format!("Invalid IMAP flag: {flag:?}")));
        }
    }
    Ok(())
}

/// Accept only IMAP sequence sets such as `1:*`, `5` or `3,7:9`.
fn validate_uid_set(set: &str) -> Result<(), ImapError> {
    if set.is_empty() || !set.bytes().all(|b| b.is_ascii_digit() || matches!(b, b':' | b',' | b'*')) {
        return Err(ImapError::ProtocolError(format!("Invalid UID set: {set:?}")));
    }
    Ok(())
}

/// Ensure the server can expunge single messages by UID (RFC 4315).
///
/// Without UIDPLUS the only way to remove a `\Deleted` message is a
/// mailbox-wide EXPUNGE, which also permanently removes every message other
/// clients have flagged `\Deleted`. Refuse instead.
async fn require_uidplus(
    session: &mut async_imap::Session<super::connection::ImapStream>,
) -> Result<(), ImapError> {
    if session
        .capabilities()
        .await
        .map_err(map_imap_error)?
        .has_str("UIDPLUS")
    {
        Ok(())
    } else {
        Err(ImapError::ProtocolError(
            "Server does not support removing a single message (UIDPLUS); nothing was changed"
                .to_string(),
        ))
    }
}

// ---- Trait implementation -------------------------------------------------

#[async_trait]
impl ImapClient for RealImapClient {
    async fn list_folders(&self, creds: &ImapCredentials) -> Result<Vec<ImapFolder>, ImapError> {
        guarded(creds, SHORT_OP_TIMEOUT, Ops.list_folders(creds)).await
    }

    async fn folder_unread_count(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<u32, ImapError> {
        validate_mailbox(folder)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.folder_unread_count(creds, folder)).await
    }

    async fn folder_status(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<FolderStatus, ImapError> {
        validate_mailbox(folder)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.folder_status(creds, folder)).await
    }

    async fn fetch_headers(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid_range: &str,
    ) -> Result<Vec<ImapMessageHeader>, ImapError> {
        validate_mailbox(folder)?;
        validate_uid_set(uid_range)?;
        guarded(creds, LONG_OP_TIMEOUT, Ops.fetch_headers(creds, folder, uid_range)).await
    }

    async fn fetch_previews(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uids: &[u32],
    ) -> Result<Vec<(u32, String)>, ImapError> {
        validate_mailbox(folder)?;
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        guarded(creds, LONG_OP_TIMEOUT, super::previews::fetch(creds, folder, uids)).await
    }

    async fn fetch_body(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
    ) -> Result<ImapMessageBody, ImapError> {
        validate_mailbox(folder)?;
        guarded(creds, LONG_OP_TIMEOUT, Ops.fetch_body(creds, folder, uid)).await
    }

    async fn add_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError> {
        validate_mailbox(folder)?;
        validate_flags(flags)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.add_flags(creds, folder, uid, flags)).await
    }

    async fn remove_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError> {
        validate_mailbox(folder)?;
        validate_flags(flags)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.remove_flags(creds, folder, uid, flags)).await
    }

    async fn set_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError> {
        validate_mailbox(folder)?;
        validate_flags(flags)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.set_flags(creds, folder, uid, flags)).await
    }

    async fn move_message(
        &self,
        creds: &ImapCredentials,
        from_folder: &str,
        uid: u32,
        to_folder: &str,
    ) -> Result<(), ImapError> {
        validate_mailbox(from_folder)?;
        validate_mailbox(to_folder)?;
        guarded(
            creds,
            SHORT_OP_TIMEOUT,
            Ops.move_message(creds, from_folder, uid, to_folder),
        )
        .await
    }

    async fn expunge_message(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
    ) -> Result<(), ImapError> {
        validate_mailbox(folder)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.expunge_message(creds, folder, uid)).await
    }

    async fn append_message(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        message_bytes: &[u8],
        flags: &[&str],
    ) -> Result<(), ImapError> {
        validate_mailbox(folder)?;
        validate_flags(flags)?;
        guarded(
            creds,
            LONG_OP_TIMEOUT,
            Ops.append_message(creds, folder, message_bytes, flags),
        )
        .await
    }

    async fn sync_draft(
        &self,
        creds: &ImapCredentials,
        request: &DraftSyncRequest,
    ) -> Result<DraftSyncResult, ImapError> {
        validate_mailbox(&request.folder)?;
        guarded(creds, LONG_OP_TIMEOUT, super::drafts::sync(creds, request)).await
    }

    async fn create_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
    ) -> Result<(), ImapError> {
        validate_mailbox(folder_name)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.create_folder(creds, folder_name)).await
    }

    async fn rename_folder(
        &self,
        creds: &ImapCredentials,
        from: &str,
        to: &str,
    ) -> Result<(), ImapError> {
        validate_mailbox(from)?;
        validate_mailbox(to)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.rename_folder(creds, from, to)).await
    }

    async fn delete_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
    ) -> Result<(), ImapError> {
        validate_mailbox(folder_name)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.delete_folder(creds, folder_name)).await
    }

    async fn subscribe_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
        subscribe: bool,
    ) -> Result<(), ImapError> {
        validate_mailbox(folder_name)?;
        guarded(
            creds,
            SHORT_OP_TIMEOUT,
            Ops.subscribe_folder(creds, folder_name, subscribe),
        )
        .await
    }

    async fn fetch_uids_and_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<Vec<(u32, Vec<String>)>, ImapError> {
        validate_mailbox(folder)?;
        guarded(creds, LONG_OP_TIMEOUT, Ops.fetch_uids_and_flags(creds, folder)).await
    }

    async fn folder_status_extended(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<FolderStatusExtended, ImapError> {
        validate_mailbox(folder)?;
        guarded(creds, SHORT_OP_TIMEOUT, Ops.folder_status_extended(creds, folder)).await
    }

    async fn fetch_changed_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        since_modseq: u64,
    ) -> Result<(Vec<(u32, Vec<String>)>, u64), ImapError> {
        validate_mailbox(folder)?;
        guarded(
            creds,
            LONG_OP_TIMEOUT,
            Ops.fetch_changed_flags(creds, folder, since_modseq),
        )
        .await
    }

    async fn get_quota(
        &self,
        creds: &ImapCredentials,
    ) -> Result<Option<MailboxQuota>, ImapError> {
        guarded(creds, SHORT_OP_TIMEOUT, Ops.get_quota(creds)).await
    }

    async fn fetch_folder_size(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<u64, ImapError> {
        validate_mailbox(folder)?;
        // fetch_folder_size bounds its own FETCH at 60 s; allow for login too.
        guarded(creds, SHORT_OP_TIMEOUT * 2, Ops.fetch_folder_size(creds, folder)).await
    }
}

// ---- Unguarded operations ---------------------------------------------------

/// The protocol work behind [`RealImapClient`]. Callers go through the trait
/// implementation above, which validates arguments, limits concurrency and
/// applies deadlines.
struct Ops;

impl Ops {
    async fn folder_unread_count(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<u32, ImapError> {
        let mut session = connect(creds).await?;
        let status = session
            .status(folder, "(UNSEEN)")
            .await
            .map_err(map_imap_error);
        let _ = session.logout().await;

        status?.unseen.ok_or_else(|| {
            ImapError::ProtocolError("IMAP STATUS response is missing UNSEEN".to_string())
        })
    }

    async fn folder_status(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<FolderStatus, ImapError> {
        let mut session = connect(creds).await?;

        let mailbox = session
            .select(folder)
            .await
            .map_err(|e| match &e {
                async_imap::error::Error::No(msg)
                    if msg.to_lowercase().contains("not found")
                        || msg.to_lowercase().contains("doesn't exist")
                        || msg.to_lowercase().contains("does not exist")
                        || msg.to_lowercase().contains("no such") =>
                {
                    ImapError::FolderNotFound(folder.to_string())
                }
                _ => map_imap_error(e),
            })?;

        let uid_validity = mailbox.uid_validity.unwrap_or(0);
        let exists = mailbox.exists;
        let uid_next = mailbox.uid_next.unwrap_or(0);

        let _ = session.logout().await;
        Ok(FolderStatus {
            uid_validity,
            exists,
            uid_next,
        })
    }

    async fn list_folders(&self, creds: &ImapCredentials) -> Result<Vec<ImapFolder>, ImapError> {
        let mut session = connect(creds).await?;

        let folders = {
            let names_stream = session
                .list(Some(""), Some("*"))
                .await
                .map_err(map_imap_error)?;

            let mut names_stream = std::pin::pin!(names_stream);
            let mut names = Vec::new();
            while let Some(result) = names_stream.next().await {
                names.push(result.map_err(map_imap_error)?);
            }

            names
                .iter()
                .map(|n| ImapFolder {
                    name: n.name().to_string(),
                    delimiter: n.delimiter().map(|d| d.to_string()),
                    attributes: n
                        .attributes()
                        .iter()
                        .map(name_attribute_to_string)
                        .collect(),
                })
                .collect()
        };

        let _ = session.logout().await;
        Ok(folders)
    }

    async fn fetch_headers(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid_range: &str,
    ) -> Result<Vec<ImapMessageHeader>, ImapError> {
        let mut session = connect(creds).await?;

        session
            .select(folder)
            .await
            .map_err(|e| match &e {
                async_imap::error::Error::No(msg)
                    if msg.to_lowercase().contains("not found")
                        || msg.to_lowercase().contains("doesn't exist")
                        || msg.to_lowercase().contains("does not exist")
                        || msg.to_lowercase().contains("no such") =>
                {
                    ImapError::FolderNotFound(folder.to_string())
                }
                _ => map_imap_error(e),
            })?;

        let headers = {
            // Fetch ENVELOPE, FLAGS, BODYSTRUCTURE, RFC822.SIZE, and threading headers.
            // We only fetch Message-ID, In-Reply-To, and References (a few bytes per message)
            // rather than full raw headers, to keep bulk syncs lightweight.
            let mut fetch_stream = session
                .uid_fetch(
                    uid_range,
                    "(UID ENVELOPE FLAGS BODYSTRUCTURE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (Message-ID In-Reply-To References Content-Class x-ms-exchange-generated-message-class)])",
                )
                .await
                .map_err(map_imap_error)?;

            let mut fetches = Vec::new();
            while let Some(result) = fetch_stream.next().await {
                fetches.push(result.map_err(map_imap_error)?);
            }

            let mut headers = Vec::with_capacity(fetches.len());
            for fetch in &fetches {
                let uid = match fetch.uid {
                    Some(u) => u,
                    None => continue,
                };

                // Parse threading headers from the small HEADER.FIELDS response.
                let raw_header_bytes = fetch.header();
                let parsed_threading = raw_header_bytes.and_then(|raw| {
                    mail_parser::MessageParser::default().parse(raw)
                });

                let (subject, from, to, cc, date) = if let Some(env) = fetch.envelope() {
                    let subject = env
                        .subject
                        .as_ref()
                        .and_then(|b| std::str::from_utf8(b).ok())
                        .map(decode_rfc2047);

                    let from: Vec<EmailAddress> = env
                        .from
                        .as_ref()
                        .map(|addrs| addrs.iter().map(imap_address_to_email).collect())
                        .unwrap_or_default();

                    let to: Vec<EmailAddress> = env
                        .to
                        .as_ref()
                        .map(|addrs| addrs.iter().map(imap_address_to_email).collect())
                        .unwrap_or_default();

                    let cc: Vec<EmailAddress> = env
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
                    // No envelope — we can't fill subject/from/to/date from the
                    // small threading-only header fetch, so leave them empty.
                    // They'll be populated when the user opens the message body.
                    tracing::warn!(
                        uid = uid,
                        folder = %folder,
                        "ENVELOPE missing for message, headers will be empty until body is fetched"
                    );
                    (None, vec![], vec![], vec![], None)
                };

                // Extract threading headers from the small HEADER.FIELDS response.
                let message_id = parsed_threading.as_ref().and_then(|p| {
                    p.message_id().map(|s| format!("<{s}>"))
                });
                let in_reply_to = parsed_threading.as_ref().and_then(|p| {
                    let val = p.in_reply_to();
                    val.as_text().map(|s| format!("<{s}>"))
                });
                let references = parsed_threading.as_ref().and_then(|p| {
                    let val = p.references();
                    val.as_text_list()
                        .map(|list| list.iter().map(|s| format!("<{s}>")).collect::<Vec<_>>().join(" "))
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

                headers.push(ImapMessageHeader {
                    uid,
                    subject,
                    from,
                    to,
                    date,
                    flags,
                    has_attachments: has_attach,
                    size,
                    message_id,
                    in_reply_to,
                    references,
                    cc,
                    reaction,
                });
            }
            headers
        };

        let _ = session.logout().await;
        Ok(headers)
    }

    async fn fetch_body(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
    ) -> Result<ImapMessageBody, ImapError> {
        let mut session = connect(creds).await?;

        session
            .select(folder)
            .await
            .map_err(|e| match &e {
                async_imap::error::Error::No(msg)
                    if msg.to_lowercase().contains("not found")
                        || msg.to_lowercase().contains("doesn't exist")
                        || msg.to_lowercase().contains("does not exist")
                        || msg.to_lowercase().contains("no such") =>
                {
                    ImapError::FolderNotFound(folder.to_string())
                }
                _ => map_imap_error(e),
            })?;

        let uid_str = uid.to_string();
        let body = {
            let mut fetch_stream = session
                .uid_fetch(&uid_str, "(UID BODY[])")
                .await
                .map_err(map_imap_error)?;

            let mut fetches = Vec::new();
            while let Some(result) = fetch_stream.next().await {
                fetches.push(result.map_err(map_imap_error)?);
            }

            let fetch = fetches.first().ok_or(ImapError::MessageNotFound {
                uid,
                folder: folder.to_string(),
            })?;

            let raw = fetch.body().ok_or_else(|| {
                ImapError::ProtocolError("BODY[] not returned by server".to_string())
            })?;

            use mail_parser::MimeHeaders;

            let parsed = mail_parser::MessageParser::default()
                .parse(raw)
                .ok_or_else(|| {
                    ImapError::ProtocolError("failed to parse RFC822 message".to_string())
                })?;

            let text_plain: Option<String> = parsed.body_text(0).map(|s| s.to_string());

            let has_html_part = parsed.parts.iter().any(|part| {
                part.content_type().is_some_and(|ct| ct.ctype() == "text" && ct.subtype() == Some("html"))
            });

            let text_html: Option<String> = if has_html_part {
                parsed.body_html(0).map(|s| s.to_string())
            } else {
                None
            };

            tracing::debug!(
                uid = uid,
                folder = %folder,
                total_parts = parsed.parts.len(),
                attachment_count = parsed.attachments().count(),
                has_text = text_plain.is_some(),
                has_html = text_html.is_some(),
                "fetch_body: parsed message structure"
            );

            let mut attachments = Vec::new();

            // Collect explicit attachments.
            for attachment in parsed.attachments() {
                let filename: Option<String> =
                    attachment.attachment_name().map(|s| s.to_string());
                let content_type: String = attachment.content_type().map_or_else(
                    || "application/octet-stream".to_string(),
                    |ct: &mail_parser::ContentType<'_>| {
                        if let Some(subtype) = ct.subtype() {
                            format!("{}/{}", ct.ctype(), subtype)
                        } else {
                            ct.ctype().to_string()
                        }
                    },
                );
                let content_id = attachment
                    .content_id()
                    .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string());
                let data = attachment.contents().to_vec();
                let size = data.len();
                attachments.push(ImapAttachment {
                    filename,
                    content_type,
                    size,
                    data,
                    content_id,
                });
            }

            // Also collect inline parts with Content-ID (e.g. embedded images
            // referenced via cid: URLs in the HTML body).
            for part in parsed.parts.iter() {
                if part.content_id().is_none() {
                    continue;
                }
                // Skip if this is a text/html or text/plain body part.
                let is_text = part
                    .content_type()
                    .is_some_and(|ct| ct.ctype() == "text");
                if is_text {
                    continue;
                }
                let cid = part
                    .content_id()
                    .unwrap()
                    .trim_matches(|c| c == '<' || c == '>')
                    .to_string();
                // Skip if we already captured this part via attachments().
                if attachments.iter().any(|a| a.content_id.as_deref() == Some(&cid)) {
                    continue;
                }
                let content_type: String = part.content_type().map_or_else(
                    || "application/octet-stream".to_string(),
                    |ct: &mail_parser::ContentType<'_>| {
                        if let Some(subtype) = ct.subtype() {
                            format!("{}/{}", ct.ctype(), subtype)
                        } else {
                            ct.ctype().to_string()
                        }
                    },
                );
                let data = part.contents().to_vec();
                let size = data.len();
                attachments.push(ImapAttachment {
                    filename: part.attachment_name().map(|s| s.to_string()),
                    content_type,
                    size,
                    data,
                    content_id: Some(cid),
                });
            }

            // Extract raw headers from the RFC 822 message.
            let raw_str = String::from_utf8_lossy(raw);
            let raw_headers = raw_str
                .split_once("\r\n\r\n")
                .or_else(|| raw_str.split_once("\n\n"))
                .map_or_else(|| raw_str.to_string(), |(h, _)| h.to_string());

            ImapMessageBody {
                uid,
                text_plain,
                text_html,
                attachments,
                raw_headers,
            }
        };

        let _ = session.logout().await;
        Ok(body)
    }

    async fn add_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;
        session.select(folder).await.map_err(map_imap_error)?;

        let uid_str = uid.to_string();
        let flags_str = format!("+FLAGS ({})", flags.join(" "));
        {
            let mut store_stream = session
                .uid_store(&uid_str, &flags_str)
                .await
                .map_err(map_imap_error)?;
            while let Some(result) = store_stream.next().await {
                result.map_err(map_imap_error)?;
            }
        }

        let _ = session.logout().await;
        Ok(())
    }

    async fn remove_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;
        session.select(folder).await.map_err(map_imap_error)?;

        let uid_str = uid.to_string();
        let flags_str = format!("-FLAGS ({})", flags.join(" "));
        {
            let mut store_stream = session
                .uid_store(&uid_str, &flags_str)
                .await
                .map_err(map_imap_error)?;
            while let Some(result) = store_stream.next().await {
                result.map_err(map_imap_error)?;
            }
        }

        let _ = session.logout().await;
        Ok(())
    }

    async fn set_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
        flags: &[&str],
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;

        session.select(folder).await.map_err(map_imap_error)?;

        let uid_str = uid.to_string();
        let flags_str = format!("FLAGS ({})", flags.join(" "));
        {
            let mut store_stream = session
                .uid_store(&uid_str, &flags_str)
                .await
                .map_err(map_imap_error)?;

            // Consume the stream to completion so the command finishes.
            while let Some(result) = store_stream.next().await {
                result.map_err(map_imap_error)?;
            }
        }

        let _ = session.logout().await;
        Ok(())
    }

    async fn move_message(
        &self,
        creds: &ImapCredentials,
        from_folder: &str,
        uid: u32,
        to_folder: &str,
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;

        session
            .select(from_folder)
            .await
            .map_err(map_imap_error)?;

        let uid_str = uid.to_string();

        // Try UID MOVE first; fall back to COPY + \Deleted + UID EXPUNGE if
        // the server does not support the MOVE extension.
        match session.uid_mv(&uid_str, to_folder).await {
            Ok(()) => {}
            Err(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_)) => {
                // Check before copying so a refusal leaves no duplicate behind.
                if let Err(e) = require_uidplus(&mut session).await {
                    let _ = session.logout().await;
                    return Err(e);
                }
                // async-imap sends the UID COPY mailbox verbatim: quote it.
                session
                    .uid_copy(&uid_str, quote_mailbox(to_folder)?)
                    .await
                    .map_err(map_imap_error)?;

                {
                    let mut store_stream = session
                        .uid_store(&uid_str, "+FLAGS (\\Deleted)")
                        .await
                        .map_err(map_imap_error)?;
                    while let Some(r) = store_stream.next().await {
                        r.map_err(map_imap_error)?;
                    }
                }

                {
                    // Never a mailbox-wide EXPUNGE: it would also remove
                    // messages other clients flagged \Deleted.
                    let expunge_stream =
                        session.uid_expunge(&uid_str).await.map_err(map_imap_error)?;
                    let mut expunge_stream = std::pin::pin!(expunge_stream);
                    while let Some(r) = expunge_stream.next().await {
                        r.map_err(map_imap_error)?;
                    }
                }
            }
            Err(e) => return Err(map_imap_error(e)),
        }

        let _ = session.logout().await;
        Ok(())
    }

    async fn expunge_message(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        uid: u32,
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;

        session.select(folder).await.map_err(map_imap_error)?;

        let uid_str = uid.to_string();

        // Check before flagging so a refusal changes nothing on the server.
        if let Err(e) = require_uidplus(&mut session).await {
            let _ = session.logout().await;
            return Err(e);
        }

        // Mark the message as \Deleted.
        {
            let mut store_stream = session
                .uid_store(&uid_str, "+FLAGS (\\Deleted)")
                .await
                .map_err(map_imap_error)?;
            while let Some(r) = store_stream.next().await {
                r.map_err(map_imap_error)?;
            }
        }

        // UID EXPUNGE only; a mailbox-wide EXPUNGE would also permanently
        // remove messages other clients flagged \Deleted.
        {
            let stream = session.uid_expunge(&uid_str).await.map_err(map_imap_error)?;
            let mut stream = std::pin::pin!(stream);
            while let Some(r) = stream.next().await {
                r.map_err(map_imap_error)?;
            }
        }

        let _ = session.logout().await;
        Ok(())
    }

    async fn append_message(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        message_bytes: &[u8],
        flags: &[&str],
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;

        let flags_str: Vec<String> = flags.iter().map(|f| f.to_string()).collect();
        let flags_joined = if flags_str.is_empty() {
            None
        } else {
            Some(format!("({})", flags_str.join(" ")))
        };
        // async-imap wraps the APPEND mailbox in quotes without escaping it.
        session
            .append(
                escape_quoted(folder),
                flags_joined.as_deref(),
                None,
                message_bytes,
            )
            .await
            .map_err(map_imap_error)?;

        let _ = session.logout().await;
        Ok(())
    }

    async fn create_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;
        session.create(folder_name).await.map_err(map_imap_error)?;
        session
            .subscribe(folder_name)
            .await
            .map_err(map_imap_error)?;
        session.logout().await.ok();
        Ok(())
    }

    async fn rename_folder(
        &self,
        creds: &ImapCredentials,
        from: &str,
        to: &str,
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;
        session.rename(from, to).await.map_err(map_imap_error)?;
        session.logout().await.ok();
        Ok(())
    }

    async fn delete_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;
        session.delete(folder_name).await.map_err(map_imap_error)?;
        session.logout().await.ok();
        Ok(())
    }

    async fn subscribe_folder(
        &self,
        creds: &ImapCredentials,
        folder_name: &str,
        subscribe: bool,
    ) -> Result<(), ImapError> {
        let mut session = connect(creds).await?;
        if subscribe {
            session
                .subscribe(folder_name)
                .await
                .map_err(map_imap_error)?;
        } else {
            session
                .unsubscribe(folder_name)
                .await
                .map_err(map_imap_error)?;
        }
        session.logout().await.ok();
        Ok(())
    }

    async fn fetch_uids_and_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<Vec<(u32, Vec<String>)>, ImapError> {
        let mut session = connect(creds).await?;

        session
            .select(folder)
            .await
            .map_err(|e| match &e {
                async_imap::error::Error::No(msg)
                    if msg.to_lowercase().contains("not found")
                        || msg.to_lowercase().contains("doesn't exist")
                        || msg.to_lowercase().contains("does not exist")
                        || msg.to_lowercase().contains("no such") =>
                {
                    ImapError::FolderNotFound(folder.to_string())
                }
                _ => map_imap_error(e),
            })?;

        let results = {
            let mut fetch_stream = session
                .uid_fetch("1:*", "(UID FLAGS)")
                .await
                .map_err(map_imap_error)?;

            let mut items = Vec::new();
            while let Some(result) = fetch_stream.next().await {
                let fetch = result.map_err(map_imap_error)?;
                if let Some(uid) = fetch.uid {
                    let flags: Vec<String> = fetch.flags().map(|f| flag_to_string(&f)).collect();
                    items.push((uid, flags));
                }
            }
            items
        };

        let _ = session.logout().await;
        Ok(results)
    }

    async fn folder_status_extended(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<FolderStatusExtended, ImapError> {
        let mut session = connect(creds).await?;

        let mailbox = session
            .status(folder, "(MESSAGES UIDNEXT UIDVALIDITY UNSEEN HIGHESTMODSEQ)")
            .await
            .map_err(map_imap_error)?;

        let result = FolderStatusExtended {
            uid_validity: mailbox.uid_validity.unwrap_or(0),
            exists: mailbox.exists,
            uid_next: mailbox.uid_next.unwrap_or(0),
            unseen: mailbox.unseen.unwrap_or(0),
            highest_modseq: mailbox.highest_modseq.unwrap_or(0),
        };

        let _ = session.logout().await;
        Ok(result)
    }

    async fn fetch_changed_flags(
        &self,
        creds: &ImapCredentials,
        folder: &str,
        since_modseq: u64,
    ) -> Result<(Vec<(u32, Vec<String>)>, u64), ImapError> {
        let mut session = connect(creds).await?;

        let mailbox = session
            .select_condstore(folder)
            .await
            .map_err(map_imap_error)?;

        let new_modseq = mailbox.highest_modseq.unwrap_or(0);

        let items = {
            let mut fetch_stream = session
                .uid_fetch("1:*", format!("(UID FLAGS) (CHANGEDSINCE {})", since_modseq))
                .await
                .map_err(map_imap_error)?;

            let mut items = Vec::new();
            while let Some(result) = fetch_stream.next().await {
                let fetch = result.map_err(map_imap_error)?;
                if let Some(uid) = fetch.uid {
                    let flags: Vec<String> = fetch.flags().map(|f| flag_to_string(&f)).collect();
                    items.push((uid, flags));
                }
            }
            items
        };

        let _ = session.logout().await;
        Ok((items, new_modseq))
    }

    async fn get_quota(
        &self,
        creds: &ImapCredentials,
    ) -> Result<Option<MailboxQuota>, ImapError> {
        let mut session = connect(creds).await?;

        // Send GETQUOTAROOT INBOX — the server responds with QUOTAROOT + QUOTA lines.
        // If the server doesn't support QUOTA, it returns NO — we treat that as None.
        let req_id = match session.run_command("GETQUOTAROOT INBOX").await {
            Ok(id) => id,
            Err(_) => {
                let _ = session.logout().await;
                return Ok(None);
            }
        };

        let mut quota_result: Option<MailboxQuota> = None;

        // Read responses until we get the tagged OK/NO/BAD (15s timeout).
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            async {
                while let Some(resp) = session.read_response().await {
                    let resp = match resp {
                        Ok(r) => r,
                        Err(_) => break,
                    };
                    match resp.parsed() {
                        async_imap::imap_proto::Response::Quota(q) => {
                            for resource in &q.resources {
                                if matches!(resource.name, async_imap::imap_proto::types::QuotaResourceName::Storage) {
                                    quota_result = Some(MailboxQuota {
                                        usage_bytes: resource.usage * 1024,
                                        limit_bytes: resource.limit * 1024,
                                    });
                                }
                            }
                        }
                        async_imap::imap_proto::Response::Done { tag, .. } if *tag == req_id => break,
                        _ => {}
                    }
                }
            },
        ).await;

        if read_result.is_err() {
            tracing::warn!("GETQUOTAROOT timed out after 15s");
        }

        let _ = session.logout().await;
        Ok(quota_result)
    }

    async fn fetch_folder_size(
        &self,
        creds: &ImapCredentials,
        folder: &str,
    ) -> Result<u64, ImapError> {
        let mut session = connect(creds).await?;

        let mailbox = session.select(folder).await.map_err(map_imap_error)?;
        if mailbox.exists == 0 {
            let _ = session.logout().await;
            return Ok(0);
        }

        let mut total: u64 = 0;

        // 60s timeout for fetching all sizes in a folder.
        let fetch_result = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            async {
                let mut fetch_stream = session
                    .uid_fetch("1:*", "RFC822.SIZE")
                    .await
                    .map_err(map_imap_error)?;

                while let Some(result) = fetch_stream.next().await {
                    let fetch = result.map_err(map_imap_error)?;
                    total += fetch.size.unwrap_or(0) as u64;
                }
                Ok::<(), ImapError>(())
            },
        ).await;

        match fetch_result {
            Ok(Err(e)) => {
                let _ = session.logout().await;
                return Err(e);
            }
            Err(_) => {
                tracing::warn!(folder = %folder, "fetch_folder_size timed out after 60s");
            }
            _ => {}
        }

        let _ = session.logout().await;
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    type Commands = Arc<Mutex<Vec<String>>>;

    /// Minimal scripted IMAP server that records every command it receives.
    async fn server(
        uidplus: bool,
        supports_move: bool,
    ) -> (ImapCredentials, Commands, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let commands: Commands = Arc::new(Mutex::new(Vec::new()));
        let shared = commands.clone();
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let commands = shared.clone();
                tokio::spawn(async move {
                    let (reader, mut writer) = stream.into_split();
                    let mut reader = BufReader::new(reader);
                    writer.write_all(b"* OK Test server ready\r\n").await.unwrap();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap() == 0 {
                            break;
                        }
                        let (tag, command) = line.trim_end().split_once(' ').unwrap();
                        commands.lock().unwrap().push(command.to_string());
                        let reply = if command.starts_with("LOGIN ") {
                            format!("{tag} OK Logged in\r\n")
                        } else if command.starts_with("SELECT ") {
                            format!(
                                "* 3 EXISTS\r\n* OK [UIDVALIDITY 42] Ok\r\n{tag} OK [READ-WRITE] Selected\r\n"
                            )
                        } else if command == "CAPABILITY" {
                            format!(
                                "* CAPABILITY IMAP4rev1{}\r\n{tag} OK Capabilities\r\n",
                                if uidplus { " UIDPLUS" } else { "" }
                            )
                        } else if command.starts_with("UID MOVE ") && !supports_move {
                            format!("{tag} BAD Unknown command\r\n")
                        } else if command.starts_with("UID ")
                            || command == "EXPUNGE"
                            || command.starts_with("SUBSCRIBE ")
                        {
                            format!("{tag} OK Done\r\n")
                        } else if command == "LOGOUT" {
                            format!("* BYE Closing\r\n{tag} OK Logout\r\n")
                        } else {
                            format!("{tag} BAD Unexpected command\r\n")
                        };
                        writer.write_all(reply.as_bytes()).await.unwrap();
                        if command == "LOGOUT" {
                            break;
                        }
                    }
                });
            }
        });
        let creds = ImapCredentials {
            host: "127.0.0.1".into(),
            port,
            tls: false,
            email: "test@example.com".into(),
            password: "test".into(),
        };
        (creds, commands, task)
    }

    fn recorded(commands: &Commands) -> Vec<String> {
        commands.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn move_fallback_quotes_target_and_expunges_only_that_uid() {
        let (creds, commands, task) = server(true, false).await;
        RealImapClient
            .move_message(&creds, "INBOX", 5, "My \"Old\" Mail")
            .await
            .unwrap();
        let seen = recorded(&commands);
        assert!(seen.iter().any(|c| c == r#"UID COPY 5 "My \"Old\" Mail""#), "{seen:?}");
        assert!(seen.iter().any(|c| c == "UID EXPUNGE 5"), "{seen:?}");
        assert!(!seen.iter().any(|c| c == "EXPUNGE"), "{seen:?}");
        task.abort();
    }

    #[tokio::test]
    async fn move_fallback_without_uidplus_changes_nothing() {
        let (creds, commands, task) = server(false, false).await;
        assert!(RealImapClient.move_message(&creds, "INBOX", 5, "Archive").await.is_err());
        let seen = recorded(&commands);
        assert!(
            !seen.iter().any(|c| c.starts_with("UID COPY")
                || c.starts_with("UID STORE")
                || c.contains("EXPUNGE")),
            "{seen:?}"
        );
        task.abort();
    }

    #[tokio::test]
    async fn delete_never_falls_back_to_mailbox_wide_expunge() {
        let (creds, commands, task) = server(false, true).await;
        assert!(RealImapClient.expunge_message(&creds, "Trash", 9).await.is_err());
        let seen = recorded(&commands);
        assert!(
            !seen.iter().any(|c| c.starts_with("UID STORE") || c.contains("EXPUNGE")),
            "{seen:?}"
        );
        task.abort();

        let (creds, commands, task) = server(true, true).await;
        RealImapClient.expunge_message(&creds, "Trash", 9).await.unwrap();
        let seen = recorded(&commands);
        assert!(seen.iter().any(|c| c == "UID EXPUNGE 9"), "{seen:?}");
        assert!(!seen.iter().any(|c| c == "EXPUNGE"), "{seen:?}");
        task.abort();
    }

    #[tokio::test]
    async fn mailbox_names_with_crlf_never_reach_the_server() {
        let (creds, commands, task) = server(true, true).await;
        let evil = "Archive\r\nA1 DELETE INBOX";
        assert!(RealImapClient.subscribe_folder(&creds, evil, true).await.is_err());
        assert!(RealImapClient.subscribe_folder(&creds, evil, false).await.is_err());
        assert!(RealImapClient.rename_folder(&creds, "A", evil).await.is_err());
        assert!(RealImapClient.move_message(&creds, "INBOX", 1, evil).await.is_err());
        assert!(RealImapClient.append_message(&creds, evil, b"x", &[]).await.is_err());
        assert!(RealImapClient.folder_status(&creds, evil).await.is_err());
        let seen = recorded(&commands);
        assert!(seen.is_empty(), "{seen:?}");
        task.abort();
    }

    #[test]
    fn flags_must_be_system_flags_or_atoms() {
        assert!(validate_flags(&["\\Seen", "\\Deleted", "$Label1", "Junk"]).is_ok());
        for bad in ["\\Seen)", "a b", "x\r\nA1 LOGOUT", "\"q\"", "", "\\", "(x"] {
            assert!(validate_flags(&[bad]).is_err(), "{bad:?}");
        }
        assert!(validate_uid_set("1:*").is_ok());
        assert!(validate_uid_set("3,7:9").is_ok());
        assert!(validate_uid_set("1 (BODY[])").is_err());
        assert!(validate_uid_set("").is_err());
    }

    #[tokio::test]
    async fn account_connections_are_capped_and_released() {
        let slots = SlotMap::new();
        let key = "alice|imap:993".to_string();
        let short = Duration::from_millis(50);
        // Occupy the only slot.
        slots.insert(key.clone(), Arc::new(Semaphore::new(1)));
        let semaphore = slots.get(&key).unwrap().clone();
        let held = semaphore.acquire_owned().await.unwrap();
        let busy = run_limited(&slots, key.clone(), 1, short, short, async { Ok(()) }).await;
        assert!(
            matches!(busy, Err(ImapError::ConnectionFailed(ref m)) if m == TOO_MANY_CONNECTIONS)
        );
        drop(held);
        run_limited(&slots, key.clone(), 1, short, short, async { Ok(()) })
            .await
            .unwrap();
        assert!(slots.get(&key).is_none(), "idle accounts are forgotten");
    }

    #[tokio::test]
    async fn stalled_operations_hit_their_deadline() {
        let slots = SlotMap::new();
        let short = Duration::from_millis(50);
        let result: Result<(), ImapError> =
            run_limited(&slots, "bob".into(), 1, short, short, std::future::pending()).await;
        assert!(
            matches!(result, Err(ImapError::ConnectionFailed(ref m)) if m.contains("timed out"))
        );
    }
}
