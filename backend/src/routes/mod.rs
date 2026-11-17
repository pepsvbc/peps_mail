pub mod account;
pub mod addresses;
mod attachment_response;
pub mod attachments;
pub mod auth;
pub mod display_preferences;
pub mod drafts;
mod draft_import;
mod draft_sync;
pub mod folder_mgmt;
pub mod folders;
pub mod health;
pub mod identities;
pub mod messages;
pub mod notification_preferences;
pub mod quota;
pub mod search;
pub mod send;
pub mod setup;
pub mod tags;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderValue, Request, header};
use axum::response::Response;
use axum::routing::{delete, get, patch, post, put};
use axum::{Extension, Router, middleware};
use tower_governor::GovernorError;
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::KeyExtractor;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::auth::csrf::csrf_protection;
use crate::auth::middleware::auth_guard;
use crate::auth::session::SessionStore;
use crate::config::AppConfig;
use crate::imap::client::ImapClient;
use crate::realtime::events::EventBus;
use crate::realtime::idle::IdleManager;
use crate::smtp::client::SmtpClient;

/// An IP network such as `10.0.0.0/8`, or a single address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IpNetwork {
    addr: IpAddr,
    prefix: u8,
}

impl IpNetwork {
    fn parse(s: &str) -> Option<Self> {
        let (addr, prefix) = match s.split_once('/') {
            Some((addr, prefix)) => (addr.trim().parse::<IpAddr>().ok()?, Some(prefix.trim().parse::<u8>().ok()?)),
            None => (s.trim().parse::<IpAddr>().ok()?, None),
        };
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        (prefix <= max).then_some(Self { addr, prefix })
    }

    fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = u32::MAX.checked_shl(32 - u32::from(self.prefix)).unwrap_or(0);
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = u128::MAX.checked_shl(128 - u32::from(self.prefix)).unwrap_or(0);
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

/// Parse `TRUSTED_PROXIES` (comma-separated IPs/CIDRs), skipping invalid entries.
fn parse_trusted_proxies(value: Option<&str>) -> Vec<IpNetwork> {
    value
        .unwrap_or_default()
        .split(',')
        .filter(|entry| !entry.trim().is_empty())
        .filter_map(|entry| {
            let network = IpNetwork::parse(entry);
            if network.is_none() {
                tracing::warn!(entry, "Ignoring invalid TRUSTED_PROXIES entry");
            }
            network
        })
        .collect()
}

/// Per-client key extractor for the login rate limiter.
///
/// Uses the TCP peer address, or — when the peer is a configured trusted
/// proxy — the right-most `X-Forwarded-For` hop that is not itself a trusted
/// proxy, so clients can't spoof the header but proxied users don't all share
/// one bucket. IPv6 clients are grouped by /64, the usual per-host allocation.
/// Falls back to loopback when `ConnectInfo` is missing (unit tests using
/// `oneshot`); production uses `into_make_service_with_connect_info`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClientIpKeyExtractor {
    trusted_proxies: Arc<Vec<IpNetwork>>,
}

impl ClientIpKeyExtractor {
    fn is_trusted(&self, ip: IpAddr) -> bool {
        self.trusted_proxies.iter().any(|network| network.contains(ip))
    }

    fn client_ip<T>(&self, req: &Request<T>) -> IpAddr {
        let peer = req
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci: &ConnectInfo<SocketAddr>| ci.0.ip().to_canonical())
            .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
        if !self.is_trusted(peer) {
            return peer;
        }
        let forwarded: Vec<IpAddr> = req
            .headers()
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .filter_map(|hop| hop.trim().parse::<IpAddr>().ok())
            .map(|ip| ip.to_canonical())
            .collect();
        forwarded
            .into_iter()
            .rev()
            .find(|ip| !self.is_trusted(*ip))
            .unwrap_or(peer)
    }
}

impl KeyExtractor for ClientIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, req: &Request<T>) -> Result<Self::Key, GovernorError> {
        Ok(match self.client_ip(req) {
            IpAddr::V6(ip) => IpAddr::V6(Ipv6Addr::from(u128::from(ip) & (u128::MAX << 64))),
            ip => ip,
        })
    }
}

/// Baseline security headers for every response (static app and API).
///
/// Headers a handler already set win, so attachment downloads keep their
/// stricter sandbox CSP. The CSP leaves scripts/styles alone (the static
/// Next.js export needs inline bootstrap scripts) but blocks plugins, `<base>`
/// hijacking, cross-site form posts and framing by other sites; the email
/// iframe uses `srcdoc`, so it inherits these restrictions too.
async fn security_headers(
    State(hsts): State<bool>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    let defaults = [
        (
            header::CONTENT_SECURITY_POLICY,
            "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
        ),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::X_FRAME_OPTIONS, "SAMEORIGIN"),
        (header::REFERRER_POLICY, "no-referrer"),
    ];
    for (name, value) in defaults {
        headers.entry(name).or_insert(HeaderValue::from_static(value));
    }
    if hsts {
        headers
            .entry(header::STRICT_TRANSPORT_SECURITY)
            .or_insert(HeaderValue::from_static("max-age=31536000"));
    }
    response
}

/// Assembles all application routes into an Axum Router.
///
/// Route layout:
/// - `GET  /api/health`                        — health check (public)
/// - `GET  /api/setup`                         — mail client settings (public)
/// - `GET  /api/setup/apple.mobileconfig`      — Apple mail profile (public)
/// - `POST /api/auth/login`                    — login (public, CSRF only)
/// - `GET  /api/auth/session`                  — get session (auth_guard + CSRF)
/// - `POST /api/auth/logout`                   — logout (CSRF; validates cookies itself)
/// - `GET  /api/account/unread`                — Inbox unread count (auth_guard + CSRF)
/// - `GET  /api/folders`                       — list folders (auth_guard + CSRF)
/// - `GET  /api/folders/:folder/messages`      — list messages (auth_guard + CSRF)
/// - `GET  /api/messages/:folder/:uid`         — get message detail (auth_guard + CSRF)
/// - `PATCH /api/messages/:folder/:uid/flags`  — update flags (auth_guard + CSRF)
/// - `GET  /api/messages/:folder/:uid/attachments/:attachment_id` — download attachment (auth_guard + CSRF)
/// - `POST /api/messages/move`                 — move message (auth_guard + CSRF)
/// - `DELETE /api/messages/:folder/:uid`       — delete message (auth_guard + CSRF)
/// - `GET  /api/addresses/autocomplete`        — search known addresses (auth_guard + CSRF)
/// - `GET  /api/addresses/autocomplete/all`    — all known addresses (auth_guard + CSRF)
///
/// All other paths serve static files from `config.static_dir`.
/// Non-matching static paths fall back to `index.html` (SPA routing).
///
/// Middleware layers:
/// - CORS (permissive defaults in development)
/// - tower-http tracing
/// - CSRF protection on auth routes
/// - auth_guard on protected routes
pub fn create_router(
    config: Arc<AppConfig>,
    store: Arc<SessionStore>,
    imap_client: Arc<dyn ImapClient>,
    smtp_client: Arc<dyn SmtpClient>,
    search_engine: Arc<crate::search::engine::SearchEngine>,
    event_bus: Arc<EventBus>,
    idle_manager: Arc<IdleManager>,
) -> Router {
    // Rate-limit login: replenish 1 token every 12 s, burst of 5.
    let governor_conf = GovernorConfigBuilder::default()
        .key_extractor(ClientIpKeyExtractor {
            trusted_proxies: Arc::new(parse_trusted_proxies(config.trusted_proxies.as_deref())),
        })
        .period(Duration::from_secs(12))
        .burst_size(5)
        .finish()
        .expect("valid governor config");

    // Drop idle per-IP buckets so the limiter's memory doesn't grow forever.
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let limiter = governor_conf.limiter().clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                limiter.retain_recent();
            }
        });
    }

    // Public auth route: GovernorLayer (outermost) -> CSRF -> handler.
    let public_auth = Router::new()
        .route("/login", post(auth::login))
        .layer(middleware::from_fn(csrf_protection))
        .layer(GovernorLayer::new(governor_conf));

    // Browser-bound routes (no auth_guard, no rate limit).
    // Handlers validate the browser cookie and each account's session token.
    let browser_routes = Router::new()
        .route("/accounts", get(auth::list_accounts))
        .route("/accounts/{id}", delete(auth::remove_account).layer(middleware::from_fn(csrf_protection)))
        // Logout validates every session cookie itself, so it must not depend on
        // the active account still being valid (that would leave others signed in).
        .route("/logout", post(auth::logout).layer(middleware::from_fn(csrf_protection)));

    // Protected auth routes (auth_guard + CSRF).
    let protected_auth = Router::new()
        .route("/session", get(auth::get_session))
        .layer(middleware::from_fn(auth_guard))
        .layer(middleware::from_fn(csrf_protection));

    let auth_router = Router::new()
        .merge(public_auth)
        .merge(browser_routes)
        .merge(protected_auth);

    // Protected data routes (auth_guard + CSRF).
    let protected_data = Router::new()
        .route("/account/unread", get(account::get_unread))
        .route(
            "/folders",
            get(folders::list_folders).post(folder_mgmt::create_folder),
        )
        .route(
            "/folders/{name}",
            patch(folder_mgmt::rename_folder).delete(folder_mgmt::delete_folder),
        )
        .route(
            "/folders/{name}/subscribe",
            patch(folder_mgmt::subscribe_folder),
        )
        .route("/folders/{folder}/messages", get(messages::list_messages))
        .route("/folders/{folder}/previews", get(messages::previews::get_previews))
        .route("/messages/{folder}/{uid}", get(messages::get_message))
        .route(
            "/messages/{folder}/{uid}/flags",
            patch(messages::update_flags),
        )
        .route(
            "/messages/{folder}/{uid}/attachments/{attachment_id}",
            get(messages::download_attachment),
        )
        .route("/messages/move", post(messages::move_message_handler))
        .route("/messages/send", post(send::send_message_handler))
        .route(
            "/messages/{folder}/{uid}",
            delete(messages::delete_message_handler),
        )
        .route("/drafts/from-message", post(draft_import::import_draft_handler))
        .route("/drafts", post(drafts::upsert_draft_handler))
        .route("/drafts", get(drafts::list_drafts_handler))
        .route("/drafts/{id}", get(drafts::get_draft_handler))
        .route("/drafts/{id}", delete(drafts::delete_draft_handler))
        .route(
            "/drafts/{draft_id}/attachments",
            // axum's default 2 MB body limit would make the 25 MB attachment cap unreachable.
            post(attachments::upload_attachment)
                .layer(axum::extract::DefaultBodyLimit::max(attachments::MAX_UPLOAD_BODY)),
        )
        .route(
            "/drafts/{draft_id}/attachments/{attachment_id}",
            delete(attachments::delete_attachment),
        )
        .route(
            "/drafts/{draft_id}/attachments/{attachment_id}/content",
            get(attachments::get_attachment_content),
        )
        .route("/search", get(search::search_messages))
        .route(
            "/tags",
            get(tags::list_tags_handler).post(tags::create_tag_handler),
        )
        .route(
            "/tags/{id}",
            put(tags::update_tag_handler).delete(tags::delete_tag_handler),
        )
        .route(
            "/tags/{id}/messages",
            post(tags::tag_message_handler).get(tags::list_tag_messages_handler),
        )
        .route(
            "/tags/{id}/messages/bulk",
            post(tags::bulk_tag_handler),
        )
        .route(
            "/tags/{id}/messages/{folder}/{uid}",
            delete(tags::untag_message_handler),
        )
        .route(
            "/messages/{folder}/{uid}/tags",
            get(tags::get_message_tags_handler),
        )
        .route(
            "/addresses/autocomplete/all",
            get(addresses::autocomplete_all_handler),
        )
        .route(
            "/addresses/autocomplete",
            get(addresses::autocomplete_handler),
        )
        .route(
            "/identities",
            get(identities::list_identities_handler).post(identities::create_identity_handler),
        )
        .route(
            "/identities/{id}",
            get(identities::get_identity_handler)
                .put(identities::update_identity_handler)
                .delete(identities::delete_identity_handler),
        )
        .route(
            "/settings/display",
            get(display_preferences::get_display_preferences)
                .put(display_preferences::update_display_preferences),
        )
        .route(
            "/settings/notifications",
            get(notification_preferences::get_notification_preferences)
                .put(notification_preferences::update_notification_preferences),
        )
        .route("/quota", get(quota::get_quota))
        .layer(middleware::from_fn(auth_guard))
        .layer(middleware::from_fn(csrf_protection));

    // WebSocket route — auth is handled inside the handler via cookie,
    // so it bypasses CSRF and auth_guard middleware.
    let ws_route = Router::new()
        .route("/ws", get(crate::realtime::ws::ws_handler));

    let api_router = Router::new()
        .route("/health", get(health::health_check))
        .route("/setup", get(setup::get_setup))
        .route("/setup/apple.mobileconfig", get(setup::download_apple_profile))
        .nest("/auth", auth_router)
        .merge(ws_route)
        .merge(protected_data);

    let index_path = Path::new(&config.static_dir).join("index.html");
    let static_service = ServeDir::new(&config.static_dir).fallback(ServeFile::new(index_path));

    let inner = Router::new()
        .nest("/api", api_router)
        .fallback_service(static_service);

    // If BASE_PATH is set (e.g. "/mail"), nest the entire app under that prefix.
    let router = match config.base_path.as_deref() {
        Some(bp) if !bp.is_empty() => Router::new().nest(bp, inner),
        _ => inner,
    };

    let router = router
        .layer(Extension(idle_manager))
        .layer(Extension(event_bus))
        .layer(Extension(smtp_client))
        .layer(Extension(search_engine))
        .layer(Extension(imap_client))
        .layer(Extension(store))
        .layer(Extension(config.clone()))
        .layer(middleware::from_fn_with_state(
            config.environment != "development",
            security_headers,
        ))
        .layer(TraceLayer::new_for_http());

    if config.environment == "development" {
        router.layer(CorsLayer::permissive())
    } else {
        router
    }
}

#[cfg(test)]
mod tests;
