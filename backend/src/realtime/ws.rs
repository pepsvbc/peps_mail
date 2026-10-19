use std::collections::HashMap;
use std::sync::Arc;

use axum::Extension;
use axum::extract::WebSocketUpgrade;
use axum::extract::ws::{Message, WebSocket};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};

use crate::auth::session::{AccountSession, SessionStore};
use crate::config::AppConfig;
use crate::imap::client::{ImapClient, ImapCredentials};
use crate::realtime::events::EventBus;
use crate::realtime::idle::IdleManager;
use crate::routes::auth::{extract_browser_id, extract_session_cookies};
use crate::search::engine::SearchEngine;

struct SocketAccount {
    session: AccountSession,
    token: String,
}

struct SocketAuth {
    browser_id: String,
    accounts: Vec<SocketAccount>,
}

impl SocketAuth {
    fn is_valid(&self, store: &SessionStore) -> bool {
        !self.accounts.is_empty()
            && self.accounts.iter().all(|account| {
                store.is_account_session_valid(
                    &self.browser_id,
                    &account.session.account_id,
                    &account.token,
                )
            })
    }
}

fn authenticate_socket(headers: &HeaderMap, store: &SessionStore) -> Option<SocketAuth> {
    let browser_id = extract_browser_id(headers)?;
    let tokens: HashMap<String, String> = extract_session_cookies(headers).into_iter().collect();
    let accounts: Vec<SocketAccount> = store
        .get_browser_accounts(&browser_id)
        .into_iter()
        .filter_map(|session| {
            let token = tokens.get(&session.account_id)?;
            store
                .is_account_session_valid(&browser_id, &session.account_id, token)
                .then(|| SocketAccount {
                    session,
                    token: token.clone(),
                })
        })
        .collect();
    if accounts.is_empty() {
        return None;
    }
    Some(SocketAuth {
        browser_id,
        accounts,
    })
}

fn is_same_origin(headers: &HeaderMap) -> bool {
    if headers.get_all("origin").iter().count() != 1 || headers.get_all("host").iter().count() != 1
    {
        return false;
    }
    let Some(host) = headers.get("host").and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let Some(origin) = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<Uri>().ok())
    else {
        return false;
    };
    // Behind an HTTPS proxy, Host must retain the public authority. Do not trust
    // arbitrary Forwarded/X-Forwarded headers supplied with the request.
    matches!(origin.scheme_str(), Some("http" | "https"))
        && origin
            .authority()
            .is_some_and(|authority| authority.as_str().eq_ignore_ascii_case(host))
        && origin.path() == "/"
        && origin.query().is_none()
}

#[allow(clippy::too_many_arguments)]
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    Extension(store): Extension<Arc<SessionStore>>,
    Extension(config): Extension<Arc<AppConfig>>,
    Extension(event_bus): Extension<Arc<EventBus>>,
    Extension(idle_manager): Extension<Arc<IdleManager>>,
    Extension(imap_client): Extension<Arc<dyn ImapClient>>,
    Extension(search_engine): Extension<Arc<SearchEngine>>,
) -> Response {
    if !is_same_origin(&headers) {
        return (StatusCode::FORBIDDEN, "WebSocket origin is not allowed").into_response();
    }
    let Some(auth) = authenticate_socket(&headers, &store) else {
        return (StatusCode::UNAUTHORIZED, "No authenticated accounts").into_response();
    };

    ws.on_upgrade(move |socket| {
        handle_socket_multi_account(
            socket,
            auth,
            store,
            config,
            event_bus,
            idle_manager,
            imap_client,
            search_engine,
        )
    })
}

#[allow(clippy::too_many_arguments)]
async fn handle_socket_multi_account(
    socket: WebSocket,
    auth: SocketAuth,
    store: Arc<SessionStore>,
    config: Arc<AppConfig>,
    event_bus: Arc<EventBus>,
    idle_manager: Arc<IdleManager>,
    imap_client: Arc<dyn ImapClient>,
    search_engine: Arc<SearchEngine>,
) {
    if !auth.is_valid(&store) {
        return;
    }
    tracing::info!(account_count = auth.accounts.len(), "WebSocket connected");

    let mut sync_handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    let mut forward_handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    let (event_tx, mut event_rx) =
        mpsc::channel::<(String, crate::realtime::events::MailEvent)>(64);

    for account in &auth.accounts {
        let session = &account.session;
        let user_hash = session.user_hash.clone();
        let account_id = session.account_id.clone();

        let mut rx = event_bus.subscribe(&user_hash).await;
        let tx = event_tx.clone();
        let aid = account_id.clone();

        let forward_handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if tx.send((aid.clone(), event)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
        });
        forward_handles.push(forward_handle);

        let creds = ImapCredentials {
            host: session.imap_host.clone(),
            port: session.imap_port,
            tls: session.imap_tls,
            email: session.email.clone(),
            password: session.password.clone(),
        };

        idle_manager
            .start_idle(
                user_hash.clone(),
                "INBOX".to_string(),
                creds.clone(),
                event_bus.clone(),
                config.clone(),
            )
            .await;

        let handle = tokio::spawn(super::sync::sync_loop(
            user_hash,
            creds,
            config.clone(),
            imap_client.clone(),
            event_bus.clone(),
            search_engine.clone(),
        ));
        sync_handles.push(handle);
    }

    drop(event_tx);

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));

    loop {
        tokio::select! {
            Some((account_id, mail_event)) = event_rx.recv() => {
                // Recheck even queued events: logout/expiry must stop delivery
                // immediately, without waiting for the next heartbeat.
                if !auth.is_valid(&store) {
                    break;
                }
                let msg = serde_json::json!({
                    "accountId": account_id,
                    "event": mail_event,
                });
                if let Ok(json) = serde_json::to_string(&msg)
                    && ws_tx.send(Message::Text(json.into())).await.is_err()
                {
                    break;
                }
            }

            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }

            _ = ping_interval.tick() => {
                // Heartbeats observe expiry; they must not extend idle sessions.
                if !auth.is_valid(&store) {
                    break;
                }
                if ws_tx.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
        }
    }

    tracing::info!("WebSocket disconnected");

    for handle in sync_handles {
        handle.abort();
    }

    for handle in forward_handles {
        handle.abort();
    }

    for account in &auth.accounts {
        let session = &account.session;
        idle_manager.stop_idle(&session.user_hash, "INBOX").await;
        event_bus.cleanup(&session.user_hash).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn add_account(store: &SessionStore, browser_id: &str) -> (String, String) {
        store.add_account_to_browser(
            browser_id,
            "member@example.com".to_string(),
            "password".to_string(),
            "user-hash".to_string(),
            "imap.example.com".to_string(),
            993,
            true,
            "smtp.example.com".to_string(),
            587,
            true,
        )
    }

    fn cookies(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("cookie", value.parse().unwrap());
        headers
    }

    fn account_cookies(browser_id: &str, account_id: &str, token: &str) -> HeaderMap {
        cookies(&format!(
            "peps_mail_browser={browser_id}; peps_mail_session_{account_id}={token}"
        ))
    }

    #[test]
    fn browser_cookie_alone_cannot_subscribe_to_accounts() {
        let store = SessionStore::new(Duration::from_secs(60));
        let browser_id = store.create_browser();
        let (token, account_id) = add_account(&store, &browser_id);

        assert!(
            authenticate_socket(&cookies(&format!("peps_mail_browser={browser_id}")), &store).is_none()
        );
        assert!(
            authenticate_socket(
                &cookies(&format!("peps_mail_session_{account_id}={token}")),
                &store
            )
            .is_none()
        );
        assert!(
            authenticate_socket(
                &account_cookies(&browser_id, &account_id, "invalid"),
                &store
            )
            .is_none()
        );
    }

    #[test]
    fn session_tokens_must_match_both_account_and_browser() {
        let store = SessionStore::new(Duration::from_secs(60));
        let first_browser = store.create_browser();
        let second_browser = store.create_browser();
        let (first_token, first_id) = add_account(&store, &first_browser);
        let (second_token, second_id) = add_account(&store, &first_browser);
        let (other_token, other_id) = add_account(&store, &second_browser);

        assert!(
            authenticate_socket(
                &account_cookies(&first_browser, &first_id, &second_token),
                &store
            )
            .is_none()
        );
        assert!(
            authenticate_socket(
                &account_cookies(&first_browser, &second_id, &first_token),
                &store
            )
            .is_none()
        );
        assert!(
            authenticate_socket(
                &account_cookies(&second_browser, &first_id, &first_token),
                &store
            )
            .is_none()
        );
        assert!(
            authenticate_socket(
                &account_cookies(&first_browser, &other_id, &other_token),
                &store
            )
            .is_none()
        );
    }

    #[test]
    fn subscribes_only_to_the_cookie_proven_account_subset() {
        let store = SessionStore::new(Duration::from_secs(60));
        let browser_id = store.create_browser();
        let (first_token, first_id) = add_account(&store, &browser_id);
        let (_, missing_id) = add_account(&store, &browser_id);
        let (third_token, third_id) = add_account(&store, &browser_id);
        let mut headers = account_cookies(&browser_id, &first_id, &first_token);
        headers.append(
            "cookie",
            format!("peps_mail_session_{third_id}={third_token}")
                .parse()
                .unwrap(),
        );

        let auth = authenticate_socket(&headers, &store).unwrap();
        let ids: Vec<&str> = auth
            .accounts
            .iter()
            .map(|a| a.session.account_id.as_str())
            .collect();
        assert_eq!(ids, vec![first_id.as_str(), third_id.as_str()]);
        assert!(!ids.contains(&missing_id.as_str()));
        assert!(auth.is_valid(&store));
    }

    #[test]
    fn expired_and_revoked_sessions_cannot_connect_or_continue_streaming() {
        let store = SessionStore::new(Duration::from_secs(60));
        let browser_id = store.create_browser();
        let (token, account_id) = add_account(&store, &browser_id);
        let headers = account_cookies(&browser_id, &account_id, &token);
        let auth = authenticate_socket(&headers, &store).unwrap();

        store.set_timeout_override(&token, Some(Duration::ZERO));
        assert!(!auth.is_valid(&store));
        assert!(authenticate_socket(&headers, &store).is_none());

        store.set_timeout_override(&token, None);
        assert!(auth.is_valid(&store));
        store.remove_account(&account_id);
        assert!(!auth.is_valid(&store));
        assert!(authenticate_socket(&headers, &store).is_none());
    }

    #[test]
    fn revoking_any_subscribed_account_invalidates_the_entire_socket() {
        let store = SessionStore::new(Duration::from_secs(60));
        let browser_id = store.create_browser();
        let (first_token, first_id) = add_account(&store, &browser_id);
        let (second_token, second_id) = add_account(&store, &browser_id);
        let headers = cookies(&format!(
            "peps_mail_browser={browser_id}; peps_mail_session_{first_id}={first_token}; peps_mail_session_{second_id}={second_token}"
        ));
        let auth = authenticate_socket(&headers, &store).unwrap();

        store.remove_account(&second_id);
        assert!(!auth.is_valid(&store));
        // Reconnecting with the same cookies can subscribe to the remaining account.
        let reconnected = authenticate_socket(&headers, &store).unwrap();
        assert_eq!(reconnected.accounts.len(), 1);
        assert_eq!(reconnected.accounts[0].session.account_id, first_id);
        assert!(reconnected.is_valid(&store));

        store.remove_browser(&browser_id);
        assert!(!reconnected.is_valid(&store));
    }

    #[test]
    fn socket_authentication_and_heartbeat_checks_do_not_refresh_idle_timeout() {
        let store = SessionStore::new(Duration::from_secs(60));
        let browser_id = store.create_browser();
        let (token, account_id) = add_account(&store, &browser_id);
        let last_accessed = store.get_browser_accounts(&browser_id)[0].last_accessed;
        let auth = authenticate_socket(&account_cookies(&browser_id, &account_id, &token), &store)
            .unwrap();

        for _ in 0..3 {
            assert!(auth.is_valid(&store));
        }
        assert_eq!(
            store.get_browser_accounts(&browser_id)[0].last_accessed,
            last_accessed
        );
    }

    fn origin_headers(host: &str, origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("host", host.parse().unwrap());
        headers.insert("origin", origin.parse().unwrap());
        headers
    }

    #[test]
    fn accepts_browser_origins_with_the_public_proxy_host_and_local_development_port() {
        assert!(is_same_origin(&origin_headers(
            "inbox.example.com",
            "https://inbox.example.com"
        )));
        assert!(is_same_origin(&origin_headers(
            "localhost:3000",
            "http://localhost:3000"
        )));
        assert!(is_same_origin(&origin_headers(
            "[::1]:3000",
            "http://[::1]:3000"
        )));
    }

    #[test]
    fn rejects_cross_origin_and_malformed_websocket_requests() {
        for origin in [
            "https://sibling.example.com",
            "https://inbox.example.com.attacker.test",
            "https://inbox.example.com:8443",
            "https://inbox.example.com/path",
            "https://inbox.example.com?query",
            "file://inbox.example.com",
            "null",
            "inbox.example.com",
        ] {
            assert!(
                !is_same_origin(&origin_headers("inbox.example.com", origin)),
                "accepted {origin}"
            );
        }
        assert!(!is_same_origin(&HeaderMap::new()));
        let mut missing_origin = origin_headers("inbox.example.com", "https://inbox.example.com");
        missing_origin.remove("origin");
        assert!(!is_same_origin(&missing_origin));

        let mut duplicate_origin = origin_headers("inbox.example.com", "https://inbox.example.com");
        duplicate_origin.append("origin", "https://sibling.example.com".parse().unwrap());
        assert!(!is_same_origin(&duplicate_origin));
    }

    #[test]
    fn forwarded_host_cannot_authorize_a_different_origin() {
        let mut headers = origin_headers("inbox.example.com", "https://sibling.example.com");
        headers.insert("x-forwarded-host", "sibling.example.com".parse().unwrap());
        headers.insert(
            "forwarded",
            "host=sibling.example.com;proto=https".parse().unwrap(),
        );
        assert!(!is_same_origin(&headers));
    }
}
