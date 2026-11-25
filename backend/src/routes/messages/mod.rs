use std::sync::Arc;

use axum::extract::Path;
use axum::extract::Query;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};

pub mod types;
pub mod previews;
use types::*;

use crate::auth::session::SessionState;
use crate::config::AppConfig;
use crate::db;
use crate::email_theme;
use crate::error::AppError;
use crate::imap::client::{ImapClient, ImapCredentials};
use crate::realtime::events::{EventBus, MailEvent};
use crate::search::engine::{IndexableMessage, SearchEngine, UserIndex};

// ---------------------------------------------------------------------------
// Helper: build IMAP credentials from session + config
// ---------------------------------------------------------------------------

fn build_creds(session: &SessionState, config: &AppConfig) -> Result<ImapCredentials, AppError> {
    let imap_host = config
        .imap_host
        .as_deref()
        .ok_or_else(|| AppError::ServiceUnavailable("Mail server not configured".to_string()))?;

    Ok(ImapCredentials {
        host: imap_host.to_string(),
        port: config.imap_port,
        tls: config.tls_enabled,
        email: session.email.clone(),
        password: session.password.clone(),
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// How many seconds a folder's message cache is considered fresh.
const FOLDER_MESSAGES_TTL_SECS: u32 = 30;

/// `GET /api/folders/:folder/messages?page=0&per_page=50`
///
/// Returns paginated messages using a cache-first strategy:
/// 1. If the folder was synced within `FOLDER_MESSAGES_TTL_SECS`, serve from cache.
/// 2. Otherwise do a lightweight IMAP SELECT to check for new messages and sync
///    only what's new.
pub async fn list_messages(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Extension(search_engine): Extension<Arc<SearchEngine>>,
    Extension(event_bus): Extension<Arc<EventBus>>,
    Path(folder): Path<String>,
    Query(mut query): Query<ListMessagesQuery>,
) -> Result<Response, AppError> {
    query.per_page = query.per_page.clamp(1, types::MAX_PER_PAGE);
    let mut syncing = false;

    // Open the per-user database.
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // If this folder was synced recently, skip the IMAP round-trip.
    let folder_fresh = db::folders::is_folder_fresh(&conn, &folder, FOLDER_MESSAGES_TTL_SECS)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    if !folder_fresh {
        let creds = build_creds(&session, &config)?;

        // Check what we have in cache.
        let cached_folder = db::folders::get_folder(&conn, &folder)
            .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
        let cached_uid_validity = cached_folder.as_ref().map(|f| f.uid_validity).unwrap_or(0);

        let cached_count = db::messages::count_messages(&conn, &folder)
            .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

        // Do a lightweight IMAP SELECT to get folder status.
        let status = imap_client
            .folder_status(&creds, &folder)
            .await
            .map_err(|e| AppError::ServiceUnavailable(format!("IMAP error: {e}")))?;

        // Ensure the folder exists in the folders table (for FK constraint),
        // but only once IMAP has confirmed it exists: the name comes straight
        // from the URL, so inserting earlier would let any request add rows.
        if cached_folder.is_none() {
            db::folders::upsert_folder(&conn, &folder, None, None, "", true, 0, 0, 0, 0)
                .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
        }

        tracing::info!(
            folder = %folder,
            cached_uid_validity = cached_uid_validity,
            imap_uid_validity = status.uid_validity,
            cached_count = cached_count,
            imap_exists = status.exists,
            "list_messages: folder status check"
        );

        let needs_full_sync = cached_uid_validity != 0
            && cached_uid_validity != status.uid_validity;

        if needs_full_sync {
            tracing::info!(folder = %folder, "UIDVALIDITY changed, clearing cache");
            db::messages::delete_folder_messages(&conn, &folder)
                .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
        }

        // Force sync when the folder was explicitly invalidated (e.g. after a
        // message move), even if IMAP exists == cached count.
        let folder_invalidated = db::folders::is_folder_messages_invalidated(&conn, &folder)
            .unwrap_or(false);
        let needs_sync = needs_full_sync || cached_count == 0 || status.exists != cached_count || folder_invalidated;

        if needs_sync {
            // Cold start: no cached messages at all — fetch the ~100 most recent
            // synchronously for a fast first paint, then background-sync the rest.
            if (needs_full_sync || cached_count == 0) && status.exists > 0 {
                let recent_start = status.uid_next.saturating_sub(100).max(1);
                let recent_range = format!("{recent_start}:*");

                tracing::info!(folder = %folder, uid_range = %recent_range, "Partial sync: fetching recent headers");

                let headers = imap_client
                    .fetch_headers(&creds, &folder, &recent_range)
                    .await
                    .map_err(|e| AppError::ServiceUnavailable(format!("IMAP error: {e}")))?;

                tracing::info!(folder = %folder, fetched = headers.len(), "Partial sync: fetched recent headers");

                upsert_and_index_headers(&conn, &folder, &headers, &search_engine, &session.user_hash)?;

                // Update folder metadata with UIDVALIDITY and partial count.
                db::folders::update_folder_status(&conn, &folder, status.uid_validity, status.exists)
                    .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
                db::folders::refresh_unread_count(&conn, &folder)
                    .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

                // Spawn background task to fetch the remaining older headers.
                if recent_start > 1 {
                    let remaining_range = format!("1:{}", recent_start - 1);
                    tokio::spawn(sync_remaining_headers(BackgroundSyncParams {
                        creds,
                        folder: folder.clone(),
                        imap_client: imap_client.clone(),
                        config: config.clone(),
                        user_hash: session.user_hash.clone(),
                        search_engine: search_engine.clone(),
                        event_bus: event_bus.clone(),
                        uid_range: remaining_range,
                        uid_validity: status.uid_validity,
                        exists: status.exists,
                    }));
                    syncing = true;
                }
            } else {
                // Stale cache: we have some cached data — determine new UIDs.
                let max_cached_uid = db::messages::max_uid(&conn, &folder)
                    .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
                let uid_range = if max_cached_uid > 0 {
                    format!("{}:*", max_cached_uid + 1)
                } else {
                    "1:*".to_string()
                };

                // Return cached data immediately, sync incrementally in background.
                db::folders::update_folder_status(&conn, &folder, status.uid_validity, status.exists)
                    .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

                tokio::spawn(sync_remaining_headers(BackgroundSyncParams {
                    creds,
                    folder: folder.clone(),
                    imap_client: imap_client.clone(),
                    config: config.clone(),
                    user_hash: session.user_hash.clone(),
                    search_engine: search_engine.clone(),
                    event_bus: event_bus.clone(),
                    uid_range,
                    uid_validity: status.uid_validity,
                    exists: status.exists,
                }));
                syncing = true;
            }
        } else {
            // No sync needed but still update the timestamp so TTL resets.
            db::folders::update_folder_status(&conn, &folder, status.uid_validity, status.exists)
                .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
        }
    }

    // Query paginated results from cache.
    let messages = db::messages::get_messages(&conn, &folder, query.page, query.per_page)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
    let total_count = db::messages::count_messages(&conn, &folder)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    tracing::info!(
        folder = %folder,
        total_count = total_count,
        page_messages = messages.len(),
        page = query.page,
        per_page = query.per_page,
        "list_messages: returning results"
    );

    // Batch-fetch tags for all messages in this page.
    let message_refs: Vec<(u32, &str)> = messages.iter().map(|m| (m.uid, m.folder.as_str())).collect();
    let tags_map = db::tags::get_tags_for_messages(&conn, &message_refs).unwrap_or_default();

    let summaries: Vec<MessageSummary> = messages
        .into_iter()
        .map(|m| {
            let msg_tags = tags_map
                .get(&(m.uid, m.folder.clone()))
                .cloned()
                .unwrap_or_default();
            MessageSummary {
                uid: m.uid,
                folder: m.folder,
                subject: m.subject,
                from_address: m.from_address,
                from_name: m.from_name,
                to_addresses: m.to_addresses,
                date: m.date,
                flags: m.flags,
                size: m.size,
                has_attachments: m.has_attachments,
                snippet: m.snippet,
                reaction: m.reaction,
                tags: msg_tags,
            }
        })
        .collect();

    Ok(Json(ListMessagesResponse {
        messages: summaries,
        total_count,
        page: query.page,
        per_page: query.per_page,
        syncing,
    })
    .into_response())
}

// ---------------------------------------------------------------------------
// Helpers for eager loading
// ---------------------------------------------------------------------------

/// Upsert fetched headers into the database and index them for search.
fn upsert_and_index_headers(
    conn: &rusqlite::Connection,
    folder: &str,
    headers: &[crate::imap::types::ImapMessageHeader],
    search_engine: &Arc<SearchEngine>,
    user_hash: &str,
) -> Result<(), AppError> {
    for header in headers {
        let from_address = header.from.first().map(|a| a.address.as_str()).unwrap_or("");
        let from_name = header.from.first().and_then(|a| a.name.as_deref()).unwrap_or("");
        let to_json = serde_json::to_string(&header.to).unwrap_or_else(|_| "[]".to_string());
        let cc_json = serde_json::to_string(&header.cc).unwrap_or_else(|_| "[]".to_string());
        let subject = header.subject.as_deref().unwrap_or("");
        let date = header.date.as_deref().unwrap_or("");
        let flags_csv = header.flags.join(",");

        db::messages::upsert_message(
            conn, folder, header.uid,
            header.message_id.as_deref(), header.in_reply_to.as_deref(),
            header.references.as_deref(), subject, from_address, from_name,
            &to_json, &cc_json, date, &flags_csv, header.size,
            header.has_attachments, "", header.reaction.as_deref(),
        )
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

        // Populate denormalized known_addresses table.
        db::known_addresses::populate_known_addresses(conn, from_address, from_name, &to_json, &cc_json)
            .map_err(|e| AppError::InternalError(format!("Known addresses error: {e}")))?;
    }

    // Index for search (skip Spam/Junk/Trash).
    if !headers.is_empty()
        && !UserIndex::is_excluded_folder(folder)
        && let Ok(user_index) = search_engine.open_user_index(user_hash)
    {
        let indexable: Vec<IndexableMessage> = headers
            .iter()
            .map(|h| {
                let from_address = h.from.first().map(|a| a.address.as_str()).unwrap_or("");
                let from_name = h.from.first().and_then(|a| a.name.as_deref()).unwrap_or("");
                let subject = h.subject.as_deref().unwrap_or("");
                let date = h.date.as_deref().unwrap_or("");
                let to_json = serde_json::to_string(&h.to).unwrap_or_else(|_| "[]".to_string());
                IndexableMessage {
                    uid: h.uid,
                    folder: folder.to_string(),
                    subject: subject.to_string(),
                    from_address: from_address.to_string(),
                    from_name: from_name.to_string(),
                    to_addresses: to_json,
                    body_text: String::new(),
                    date_epoch: crate::db::messages::parse_date_to_epoch_public(date),
                    has_attachments: h.has_attachments,
                }
            })
            .collect();
        let _ = user_index.index_messages_batch(&indexable);
    }

    Ok(())
}

/// Parameters for a background sync task, bundled to avoid too-many-arguments.
struct BackgroundSyncParams {
    creds: ImapCredentials,
    folder: String,
    imap_client: Arc<dyn ImapClient>,
    config: Arc<AppConfig>,
    user_hash: String,
    search_engine: Arc<SearchEngine>,
    event_bus: Arc<EventBus>,
    uid_range: String,
    uid_validity: u32,
    exists: u32,
}

/// Background task: fetch remaining headers for a folder and notify the
/// frontend via EventBus when done. All errors are logged but non-fatal.
async fn sync_remaining_headers(params: BackgroundSyncParams) {
    let BackgroundSyncParams {
        creds, folder, imap_client, config, user_hash,
        search_engine, event_bus, uid_range, uid_validity, exists,
    } = params;
    let result: Result<(), String> = (async {
        tracing::info!(folder = %folder, uid_range = %uid_range, "Background sync: fetching remaining headers");

        let headers = imap_client
            .fetch_headers(&creds, &folder, &uid_range)
            .await
            .map_err(|e| format!("IMAP error: {e}"))?;

        tracing::info!(folder = %folder, fetched = headers.len(), "Background sync: fetched headers");

        if headers.is_empty() {
            return Ok(());
        }

        // Open a fresh DB connection (can't share across threads).
        let conn = db::pool::open_user_db(&config.data_dir, &user_hash)
            .map_err(|e| format!("Database error: {e}"))?;

        for header in &headers {
            let from_address = header.from.first().map(|a| a.address.as_str()).unwrap_or("");
            let from_name = header.from.first().and_then(|a| a.name.as_deref()).unwrap_or("");
            let to_json = serde_json::to_string(&header.to).unwrap_or_else(|_| "[]".to_string());
            let cc_json = serde_json::to_string(&header.cc).unwrap_or_else(|_| "[]".to_string());
            let subject = header.subject.as_deref().unwrap_or("");
            let date = header.date.as_deref().unwrap_or("");
            let flags_csv = header.flags.join(",");

            db::messages::upsert_message(
                &conn, &folder, header.uid,
                header.message_id.as_deref(), header.in_reply_to.as_deref(),
                header.references.as_deref(), subject, from_address, from_name,
                &to_json, &cc_json, date, &flags_csv, header.size,
                header.has_attachments, "", header.reaction.as_deref(),
            )
            .map_err(|e| format!("Database error: {e}"))?;

            // Populate denormalized known_addresses table.
            db::known_addresses::populate_known_addresses(&conn, from_address, from_name, &to_json, &cc_json)
                .map_err(|e| format!("Known addresses error: {e}"))?;
        }

        // Index for search.
        if !UserIndex::is_excluded_folder(&folder)
            && let Ok(user_index) = search_engine.open_user_index(&user_hash)
        {
            let indexable: Vec<IndexableMessage> = headers
                .iter()
                .map(|h| {
                    let from_address = h.from.first().map(|a| a.address.as_str()).unwrap_or("");
                    let from_name = h.from.first().and_then(|a| a.name.as_deref()).unwrap_or("");
                    let subject = h.subject.as_deref().unwrap_or("");
                    let date = h.date.as_deref().unwrap_or("");
                    let to_json = serde_json::to_string(&h.to).unwrap_or_else(|_| "[]".to_string());
                    IndexableMessage {
                        uid: h.uid,
                        folder: folder.clone(),
                        subject: subject.to_string(),
                        from_address: from_address.to_string(),
                        from_name: from_name.to_string(),
                        to_addresses: to_json,
                        body_text: String::new(),
                        date_epoch: crate::db::messages::parse_date_to_epoch_public(date),
                        has_attachments: h.has_attachments,
                    }
                })
                .collect();
            let _ = user_index.index_messages_batch(&indexable);
        }

        // Update folder status and unread count.
        db::folders::update_folder_status(&conn, &folder, uid_validity, exists)
            .map_err(|e| format!("Database error: {e}"))?;
        db::folders::refresh_unread_count(&conn, &folder)
            .map_err(|e| format!("Database error: {e}"))?;

        Ok(())
    })
    .await;

    match result {
        Ok(()) => {
            tracing::info!(folder = %folder, "Background sync: complete");
            event_bus.publish(&user_hash, MailEvent::FolderUpdated).await;
        }
        Err(e) => {
            tracing::warn!(folder = %folder, error = %e, "Background sync: failed (will retry on next request)");
        }
    }
}

/// `GET /api/messages/:folder/:uid`
///
/// Returns the full message detail including body and attachment metadata.
/// Fetches from IMAP and caches if not already cached.
pub async fn get_message(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Extension(search_engine): Extension<Arc<SearchEngine>>,
    Path((folder, uid)): Path<(String, u32)>,
) -> Result<Response, AppError> {
    let creds = build_creds(&session, &config)?;

    // Open the per-user database.
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // Check SQLite cache first.
    let cached_body = db::messages::get_cached_body(&conn, &folder, uid)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // Treat a cache hit with missing attachments_json as stale (pre-V006 cache,
    // or cleared by V025). Re-fetch from IMAP so attachments and inline images
    // are properly resolved; keep the stale copy to serve if IMAP is down.
    let (usable_cache, stale_cache) = match cached_body {
        Some(c) if c.attachments_json.is_some() => (Some(c), None),
        other => (None, other),
    };
    let mut fetched_body = usable_cache.is_none();

    let (body_html, body_text, attachments, raw_headers, email_theme) = if let Some(cached) = usable_cache {
        serve_cached_body(&conn, &folder, uid, cached)
    } else {
        // Fetch from IMAP.
        match imap_client.fetch_body(&creds, &folder, uid).await {
            Ok(body) => {
                let prepared = prepare_body_for_cache(&body);

                db::messages::cache_message_body(
                    &conn,
                    &folder,
                    uid,
                    prepared.html.as_deref(),
                    body.text_plain.as_deref(),
                    prepared.attachments_json.as_deref(),
                    Some(&body.raw_headers),
                    prepared.email_theme,
                )
                .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

                (prepared.html, body.text_plain, prepared.attachments, body.raw_headers, prepared.email_theme)
            }
            Err(crate::imap::client::ImapError::MessageNotFound { .. }) => {
                // The server says the message is gone — remove the stale
                // cache entry and search index entry, and invalidate the
                // folder so the list refreshes.
                let _ = db::messages::delete_message(&conn, &folder, uid);
                let _ = db::folders::invalidate_folder_freshness(&conn, &folder);
                if let Ok(user_index) = search_engine.open_user_index(&session.user_hash) {
                    let _ = user_index.delete_message(uid, &folder);
                }
                return Err(AppError::NotFound(format!(
                    "Message UID {uid} not found in folder {folder}"
                )));
            }
            Err(other) => {
                // Transient failure (server down, auth, protocol): the message
                // may well still exist, so keep the cached row. Serve the stale
                // body if we have one, otherwise report the outage.
                let Some(stale) = stale_cache else {
                    return Err(AppError::ServiceUnavailable(format!("IMAP error: {other}")));
                };
                tracing::warn!(folder = %folder, uid, error = %other, "IMAP fetch failed; serving stale cached body");
                fetched_body = false;
                serve_cached_body(&conn, &folder, uid, stale)
            }
        }
    };

    // Get the message header from cache (use efficient single-message lookup).
    // If the header hasn't been synced yet (e.g. DB was cleared and sync is
    // still running), fall back to parsing the raw headers we already fetched.
    let msg = db::messages::get_single_message(&conn, &folder, uid)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    let msg = match msg {
        Some(m) => m,
        None => {
            // Parse header fields from raw_headers so we can still return a
            // useful response even when the message list hasn't been synced.
            let parsed = mail_parser::MessageParser::default().parse(raw_headers.as_bytes());
            let subject = parsed.as_ref().and_then(|p| p.subject().map(|s| s.to_string())).unwrap_or_default();
            let (from_address, from_name) = parsed.as_ref()
                .and_then(|p| p.from())
                .and_then(|addr| match addr {
                    mail_parser::Address::List(addrs) => addrs.first().map(|a| {
                        (
                            a.address.as_ref().map(|s| s.to_string()).unwrap_or_default(),
                            a.name.as_ref().map(|s| s.to_string()).unwrap_or_default(),
                        )
                    }),
                    _ => None,
                })
                .unwrap_or_default();
            let date = parsed.as_ref().and_then(|p| p.date()).map(|d| {
                let sign = if d.tz_before_gmt { '-' } else { '+' };
                format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
                    d.year, d.month, d.day, d.hour, d.minute, d.second, sign, d.tz_hour, d.tz_minute)
            }).unwrap_or_default();

            db::messages::CachedMessage {
                uid,
                folder: folder.clone(),
                message_id: parsed.as_ref().and_then(|p| p.message_id().map(|s| format!("<{s}>"))),
                in_reply_to: parsed.as_ref().and_then(|p| p.in_reply_to().as_text().map(|s| format!("<{s}>"))),
                references_header: parsed.as_ref().and_then(|p| {
                    let val = p.references();
                    val.as_text_list()
                        .map(|list| list.iter().map(|s| format!("<{s}>")).collect::<Vec<_>>().join(" "))
                        .or_else(|| val.as_text().map(|s| format!("<{s}>")))
                }),
                subject,
                from_address,
                from_name,
                to_addresses: String::from("[]"),
                cc_addresses: String::from("[]"),
                date,
                flags: String::new(),
                size: 0,
                has_attachments: !attachments.is_empty(),
                snippet: String::new(),
                reaction: None,
            }
        }
    };

    // Re-index message with full body text for search.
    // Skip indexing for Spam/Junk/Trash folders.
    if fetched_body
        && let Some(ref text) = body_text
        && !UserIndex::is_excluded_folder(&folder)
    {
        let indexable = IndexableMessage {
            uid: msg.uid,
            folder: msg.folder.clone(),
            subject: msg.subject.clone(),
            from_address: msg.from_address.clone(),
            from_name: msg.from_name.clone(),
            to_addresses: msg.to_addresses.clone(),
            body_text: text.clone(),
            date_epoch: crate::db::messages::parse_date_to_epoch_public(&msg.date),
            has_attachments: msg.has_attachments,
        };
        let search_engine = Arc::clone(&search_engine);
        let user_hash = session.user_hash.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(user_index) = search_engine.open_user_index(&user_hash) {
                let _ = user_index.index_message(&indexable);
            }
        });
    }

    // Build thread using full References chain. The walk is bounded but still
    // runs several SQLite queries, so keep it off the async runtime threads.
    let thread_messages = if let Some(message_id) = msg.message_id.clone() {
        let references = msg.references_header.clone();
        tokio::task::spawn_blocking(move || {
            db::messages::get_full_thread(&conn, &message_id, references.as_deref())
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
    } else {
        vec![]
    };

    let thread: Vec<ThreadMessage> = thread_messages
        .into_iter()
        .map(|m| ThreadMessage {
            uid: m.uid,
            folder: m.folder,
            message_id: m.message_id,
            in_reply_to: m.in_reply_to,
            subject: m.subject,
            from_address: m.from_address,
            from_name: m.from_name,
            to_addresses: m.to_addresses,
            cc_addresses: m.cc_addresses,
            date: m.date,
            flags: m.flags,
            size: m.size,
            has_attachments: m.has_attachments,
            snippet: m.snippet,
        })
        .collect();

    Ok(Json(MessageDetailResponse {
        uid: msg.uid,
        folder: msg.folder,
        subject: msg.subject,
        from_address: msg.from_address,
        from_name: msg.from_name,
        to_addresses: parse_address_list(&msg.to_addresses),
        cc_addresses: parse_address_list(&msg.cc_addresses),
        date: msg.date,
        flags: parse_flags(&msg.flags),
        has_attachments: msg.has_attachments,
        html: body_html,
        text: body_text,
        raw_headers,
        attachments,
        thread,
        email_theme: email_theme.map(|t| match t {
            0 => EmailTheme::Light,
            1 => EmailTheme::Dark,
            2 => EmailTheme::Transparent,
            3 => EmailTheme::Adaptive,
            _ => EmailTheme::Light,
        }),
    })
    .into_response())
}

/// `PATCH /api/messages/:folder/:uid/flags`
///
/// Updates message flags on the IMAP server and in the SQLite cache.
/// System flags plus IMAP keyword atoms such as `$Label1` or `Junk`.
fn is_valid_flag(flag: &str) -> bool {
    const SYSTEM_FLAGS: [&str; 5] = ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"];
    if SYSTEM_FLAGS.iter().any(|system| system.eq_ignore_ascii_case(flag)) {
        return true;
    }
    (1..=64).contains(&flag.len())
        && flag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '$' | '_' | '-' | '.'))
}

pub async fn update_flags(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Path((folder, uid)): Path<(String, u32)>,
    Json(body): Json<UpdateFlagsRequest>,
) -> Result<Response, AppError> {
    // Flags are joined into the raw STORE command, so only accept standard
    // system flags and keyword atoms (no spaces, parens, quotes or CR/LF).
    if let Some(bad) = body.flags.iter().find(|flag| !is_valid_flag(flag)) {
        return Err(AppError::BadRequest(format!("Invalid flag: {bad:?}")));
    }

    let creds = build_creds(&session, &config)?;

    // Convert flags to &str slices for the IMAP client.
    let flag_refs: Vec<&str> = body.flags.iter().map(|s| s.as_str()).collect();

    if body.add {
        imap_client
            .add_flags(&creds, &folder, uid, &flag_refs)
            .await
            .map_err(|e| AppError::ServiceUnavailable(format!("IMAP error: {e}")))?;
    } else {
        imap_client
            .remove_flags(&creds, &folder, uid, &flag_refs)
            .await
            .map_err(|e| AppError::ServiceUnavailable(format!("IMAP error: {e}")))?;
    }

    // Update SQLite cache: read current flags, add/remove, write back.
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    let current_flags_csv: String = conn
        .query_row(
            "SELECT flags FROM messages WHERE folder = ?1 AND uid = ?2",
            rusqlite::params![&folder, uid],
            |row| row.get(0),
        )
        .unwrap_or_default();

    let mut current_flags: Vec<String> = if current_flags_csv.is_empty() {
        vec![]
    } else {
        current_flags_csv.split(',').map(|s| s.to_string()).collect()
    };

    if body.add {
        for flag in &body.flags {
            if !current_flags.contains(flag) {
                current_flags.push(flag.clone());
            }
        }
    } else {
        current_flags.retain(|f| !body.flags.contains(f));
    }

    let new_flags_csv = current_flags.join(",");
    db::messages::update_message_flags(&conn, &folder, uid, &new_flags_csv)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // Refresh unread count after flag change.
    db::folders::refresh_unread_count(&conn, &folder)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    Ok(Json(serde_json::json!({ "status": "ok" })).into_response())
}

/// `POST /api/messages/move`
///
/// Moves a message from one folder to another on the IMAP server and
/// removes it from the source folder in SQLite cache.
pub async fn move_message_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Extension(search_engine): Extension<Arc<SearchEngine>>,
    Json(body): Json<MoveMessageRequest>,
) -> Result<Response, AppError> {
    let creds = build_creds(&session, &config)?;

    // Move on IMAP server.
    imap_client
        .move_message(&creds, &body.from_folder, body.uid, &body.to_folder)
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("IMAP error: {e}")))?;

    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // Check if the message was unread before removing it from the source cache,
    // so we can adjust the destination folder's unread count.
    let was_unread = db::messages::get_single_message(&conn, &body.from_folder, body.uid)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?
        .map(|m| !m.flags.contains("\\Seen"))
        .unwrap_or(false);

    // Delete from source folder cache. We don't keep the row in the destination
    // because the UID changes after an IMAP MOVE, and a stale UID would cause
    // 404s when trying to fetch the message body.
    db::messages::delete_message(&conn, &body.from_folder, body.uid)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // Remove the old folder/UID pair from search too. Destination UIDs are
    // discovered during folder sync; Spam/Junk intentionally remain unindexed.
    let user_hash = session.user_hash.clone();
    let from_folder = body.from_folder.clone();
    let uid = body.uid;
    let search_result = tokio::task::spawn_blocking(move || {
        let index = search_engine.open_user_index(&user_hash)?;
        index.delete_message(uid, &from_folder)
    }).await;
    if !matches!(search_result, Ok(Ok(()))) {
        // The IMAP move already succeeded: do not trigger a false client rollback.
        tracing::warn!(?search_result, "Failed to remove moved message from search index");
    }

    // Refresh source folder unread count (now accurate since the row is gone).
    db::folders::refresh_unread_count(&conn, &body.from_folder)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // Bump destination folder unread count if the moved message was unread.
    if was_unread {
        db::folders::adjust_unread_count(&conn, &body.to_folder, 1)
            .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
    }

    // Invalidate destination folder cache so the next list request forces an
    // IMAP resync and picks up the moved message with its new UID.
    db::folders::invalidate_folder_freshness(&conn, &body.to_folder)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    Ok(Json(serde_json::json!({ "status": "ok" })).into_response())
}

/// `GET /api/messages/:folder/:uid/attachments/:attachment_id`
///
/// Downloads an attachment by its index from the message.
pub async fn download_attachment(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Path((folder, uid, attachment_id)): Path<(String, u32, String)>,
) -> Result<Response, AppError> {
    let creds = build_creds(&session, &config)?;

    // Parse the attachment index.
    let index: usize = attachment_id
        .parse()
        .map_err(|_| AppError::BadRequest(format!("Invalid attachment id: {attachment_id}")))?;

    // Fetch the full message body from IMAP.
    let body = imap_client
        .fetch_body(&creds, &folder, uid)
        .await
        .map_err(|e| match e {
            crate::imap::client::ImapError::MessageNotFound { .. } => {
                AppError::NotFound(format!("Message UID {uid} not found in folder {folder}"))
            }
            other => AppError::ServiceUnavailable(format!("IMAP error: {other}")),
        })?;

    // Find the attachment by index.
    let attachment = body
        .attachments
        .into_iter()
        .nth(index)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "Attachment {attachment_id} not found on message UID {uid}"
            ))
        })?;

    // Build the response with appropriate headers.
    let filename = attachment
        .filename
        .unwrap_or_else(|| format!("attachment_{index}"));
    let content_type = preview_content_type(&attachment.content_type, Some(&filename), &attachment.data);

    super::attachment_response::attachment_response(&content_type, &filename, attachment.data)
}

/// Fields of a message detail served from the SQLite body cache:
/// `(html, text, attachments, raw_headers, email_theme)`.
type BodyParts = (Option<String>, Option<String>, Vec<AttachmentMeta>, String, Option<i32>);

/// Turn a cached body row into response parts, detecting (and storing) the
/// email theme if it was never computed.
fn serve_cached_body(
    conn: &rusqlite::Connection,
    folder: &str,
    uid: u32,
    cached: db::messages::CachedBody,
) -> BodyParts {
    let attachments: Vec<AttachmentMeta> = cached
        .attachments_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    let mut theme = cached.email_theme;
    if theme.is_none() && let Some(ref html) = cached.html {
        theme = email_theme::detect_email_theme_guarded(html).map(|t| t.as_i32());
        if let Some(t) = theme {
            let _ = db::messages::update_email_theme(conn, folder, uid, t);
        }
    }
    (cached.html, cached.text, attachments, cached.raw_headers.unwrap_or_default(), theme)
}

/// A fetched message body in the shape stored in the SQLite body cache.
pub(crate) struct PreparedBody {
    /// HTML with `cid:` references rewritten to inline `data:` URIs.
    pub(crate) html: Option<String>,
    /// Attachment metadata (no bytes), as returned to the client.
    pub(crate) attachments: Vec<AttachmentMeta>,
    /// `attachments` serialized for the `attachments_json` column.
    pub(crate) attachments_json: Option<String>,
    /// Detected email theme (`EmailTheme::as_i32`).
    pub(crate) email_theme: Option<i32>,
}

/// Build the cacheable form of a fetched body. Shared by `get_message` and
/// the deep-index background task so both write the same metadata shape
/// (never raw attachment bytes) to `attachments_json`.
pub(crate) fn prepare_body_for_cache(body: &crate::imap::client::ImapMessageBody) -> PreparedBody {
    let attachments: Vec<AttachmentMeta> = body
        .attachments
        .iter()
        .enumerate()
        .map(|(i, a)| AttachmentMeta {
            id: i.to_string(),
            filename: a.filename.clone(),
            content_type: preview_content_type(&a.content_type, a.filename.as_deref(), &a.data),
            size: a.size,
            content_id: a.content_id.clone(),
        })
        .collect();

    // Rewrite cid: URLs in the HTML to inline data URIs so the sandboxed
    // iframe can display embedded images without needing network access.
    // (HTML is used directly; the frontend sandbox handles security.)
    let html = body.text_html.clone().map(|mut html| {
        for att in &body.attachments {
            if let Some(ref cid) = att.content_id {
                let cid_url = format!("cid:{cid}");
                if html.contains(&cid_url) {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&att.data);
                    let data_uri = format!("data:{};base64,{}", att.content_type, b64);
                    html = html.replace(&cid_url, &data_uri);
                }
            }
        }
        html
    });

    let attachments_json = serde_json::to_string(&attachments).ok();
    let email_theme = html
        .as_deref()
        .and_then(email_theme::detect_email_theme_guarded)
        .map(|t| t.as_i32());

    PreparedBody { html, attachments, attachments_json, email_theme }
}

fn preview_content_type(content_type: &str, filename: Option<&str>, data: &[u8]) -> String {
    let media_type = content_type.split(';').next().unwrap_or("").trim();
    if media_type.eq_ignore_ascii_case("application/pdf")
        || (media_type.eq_ignore_ascii_case("application/octet-stream")
            && filename.is_some_and(|name| name.to_ascii_lowercase().ends_with(".pdf"))
            && data.starts_with(b"%PDF-"))
    {
        "application/pdf".to_string()
    } else {
        content_type.to_string()
    }
}

#[cfg(test)]
mod preview_tests {
    use super::preview_content_type;

    #[test]
    fn normalizes_pdf_media_types() {
        assert_eq!(preview_content_type("Application/PDF; name=test.pdf", None, b""), "application/pdf");
        assert_eq!(preview_content_type("application/octet-stream", Some("TEST.PDF"), b"%PDF-1.7"), "application/pdf");
    }

    #[test]
    fn does_not_trust_filename_alone() {
        assert_eq!(preview_content_type("application/octet-stream", Some("test.pdf"), b"not a pdf"), "application/octet-stream");
    }
}

/// `DELETE /api/messages/:folder/:uid`
///
/// Permanently removes a message from the IMAP server and SQLite cache.
pub async fn delete_message_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Path((folder, uid)): Path<(String, u32)>,
) -> Result<Response, AppError> {
    let creds = build_creds(&session, &config)?;

    // Expunge on IMAP server.
    imap_client
        .expunge_message(&creds, &folder, uid)
        .await
        .map_err(|e| AppError::ServiceUnavailable(format!("IMAP error: {e}")))?;

    // Delete from SQLite cache.
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;
    db::messages::delete_message(&conn, &folder, uid)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    // Refresh unread count for folder.
    db::folders::refresh_unread_count(&conn, &folder)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    Ok(Json(serde_json::json!({ "status": "ok" })).into_response())
}

#[cfg(test)]
mod flag_tests {
    use super::is_valid_flag;

    #[test]
    fn accepts_system_flags_and_keywords() {
        for flag in [r"\Seen", r"\flagged", "$Junk", "$Label1", "Important", "my_tag-2.0"] {
            assert!(is_valid_flag(flag), "{flag}");
        }
    }

    #[test]
    fn rejects_flags_that_could_break_the_store_command() {
        for flag in ["", r"\Recent", "a b", "x)", "(x", "\"q\"", "a\r\nA1 DELETE INBOX", r"\*"] {
            assert!(!is_valid_flag(flag), "{flag:?}");
        }
        assert!(!is_valid_flag(&"a".repeat(65)));
    }
}
