use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;

use crate::auth::imap_auth::{self, AuthResult};
use crate::auth::session::{SessionState, SessionStore};
use crate::auth::user_data;
use crate::config::AppConfig;
use crate::db;

pub const BROWSER_COOKIE: &str = "oxi_browser";

/// JSON body expected on `POST /api/auth/login`.
#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub remember: bool,
}

fn browser_cookie(browser_id: &str, max_age_secs: u64, secure: bool) -> String {
    let secure_flag = if secure { " Secure;" } else { "" };
    format!(
        "{}={};{} HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        BROWSER_COOKIE, browser_id, secure_flag, max_age_secs
    )
}

fn account_session_cookie(
    account_id: &str,
    token: &str,
    max_age_secs: u64,
    secure: bool,
) -> String {
    let secure_flag = if secure { " Secure;" } else { "" };
    format!(
        "oxi_session_{}={};{} HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        account_id, token, secure_flag, max_age_secs
    )
}

fn clearing_browser_cookie(secure: bool) -> String {
    let secure_flag = if secure { " Secure;" } else { "" };
    format!(
        "{}=;{} HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        BROWSER_COOKIE, secure_flag
    )
}

fn clearing_account_cookie(account_id: &str, secure: bool) -> String {
    let secure_flag = if secure { " Secure;" } else { "" };
    format!(
        "oxi_session_{}=;{} HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        account_id, secure_flag
    )
}

pub(crate) fn extract_browser_id(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|cookie| {
            for segment in cookie.split(';') {
                let trimmed = segment.trim();
                if let Some(id) = trimmed.strip_prefix("oxi_browser=") {
                    let id = id.trim();
                    if !id.is_empty() {
                        return Some(id.to_string());
                    }
                }
            }
            None
        })
}

pub(crate) fn extract_session_cookies(headers: &axum::http::HeaderMap) -> Vec<(String, String)> {
    let prefix = "oxi_session_";
    let mut sessions = Vec::new();

    for cookie in headers
        .get_all("cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
    {
        for segment in cookie.split(';') {
            let trimmed = segment.trim();
            if let Some(rest) = trimmed.strip_prefix(prefix)
                && let Some(eq_pos) = rest.find('=')
            {
                let account_id = &rest[..eq_pos];
                let token = &rest[eq_pos + 1..];
                if !account_id.is_empty() && !token.is_empty() {
                    sessions.push((account_id.to_string(), token.to_string()));
                }
            }
        }
    }
    sessions
}

/// `POST /api/auth/login`
///
/// Validates the user's credentials against the configured IMAP server.
/// On success, creates a session, provisions the user's data directory,
/// and returns session cookies.
pub async fn login(
    Extension(store): Extension<Arc<SessionStore>>,
    Extension(config): Extension<Arc<AppConfig>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Response {
    if body.email.trim().is_empty() || body.password.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            serde_json::json!({
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "Email and password are required",
                    "status": 400
                }
            })
            .to_string(),
        )
            .into_response();
    }

    // Mailbox caches are keyed by email address, so authentication must use the
    // same administrator-configured server as all subsequent mailbox requests.
    let imap_host = config
        .imap_host
        .as_ref()
        .filter(|host| !host.trim().is_empty());
    let Some(imap_host) = imap_host else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "application/json")],
            serde_json::json!({
                "error": {
                    "code": "SERVICE_UNAVAILABLE",
                    "message": "IMAP server not configured",
                    "status": 503
                }
            })
            .to_string(),
        )
            .into_response();
    };

    let smtp_host = config
        .smtp_host
        .as_ref()
        .filter(|host| !host.trim().is_empty());
    let Some(smtp_host) = smtp_host else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": {
                    "code": "SERVICE_UNAVAILABLE",
                    "message": "SMTP server not configured",
                    "status": 503
                }
            })),
        )
            .into_response();
    };

    let imap_port = config.imap_port;
    let imap_tls = config.tls_enabled;
    let smtp_port = config.smtp_port;
    let smtp_tls = config.tls_enabled;

    let result = imap_auth::validate_imap_credentials(
        imap_host,
        imap_port,
        imap_tls,
        &body.email,
        &body.password,
    )
    .await;

    match result {
        AuthResult::Success => {
            // A browser identifier alone is not proof of ownership. Only reuse
            // a browser when a matching account session cookie authenticates it.
            let existing_browser_id = extract_browser_id(&headers).filter(|browser_id| {
                extract_session_cookies(&headers)
                    .iter()
                    .any(|(account_id, token)| {
                        store
                            .get_account_session(browser_id, account_id, token)
                            .is_some()
                    })
            });

            if let Some(ref browser_id) = existing_browser_id {
                let existing_accounts: Vec<_> = extract_session_cookies(&headers)
                    .into_iter()
                    .filter_map(|(account_id, token)| {
                        store.get_account_session(browser_id, &account_id, &token)
                    })
                    .collect();
                let duplicate = existing_accounts
                    .iter()
                    .find(|a| a.email == body.email && a.imap_host == *imap_host);

                if let Some(dup) = duplicate {
                    tracing::debug!(
                        email = %body.email,
                        imap_host = %imap_host,
                        existing_account_id = %dup.account_id,
                        "login: duplicate account detected"
                    );
                    return (
                        StatusCode::CONFLICT,
                        [("content-type", "application/json")],
                        serde_json::json!({
                            "error": {
                                "code": "DUPLICATE_ACCOUNT",
                                "message": "This account is already logged in",
                                "status": 409
                            }
                        })
                        .to_string(),
                    )
                        .into_response();
                }
            }

            let user_hash = user_data::hash_email(&body.email);
            if let Err(e) = user_data::provision_user_data(&config.data_dir, &user_hash) {
                tracing::error!(error = %e, "failed to provision user data directory");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    [("content-type", "application/json")],
                    serde_json::json!({
                        "error": {
                            "code": "INTERNAL_ERROR",
                            "message": "Failed to provision user data",
                            "status": 500
                        }
                    })
                    .to_string(),
                )
                    .into_response();
            }

            if let Ok(conn) = db::pool::open_user_db(&config.data_dir, &user_hash) {
                match db::identities::has_identities(&conn) {
                    Ok(false) => {
                        let default_identity = db::identities::CreateIdentity {
                            email: body.email.clone(),
                            display_name: String::new(),
                            signature_html: String::new(),
                            is_default: true,
                        };
                        if let Err(e) = db::identities::create_identity(&conn, &default_identity) {
                            tracing::warn!(error = %e, "Failed to auto-create default identity");
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Failed to check for existing identities");
                    }
                    _ => {}
                }
            }

            const REMEMBER_ME_HOURS: u64 = 30 * 24;
            let session_hours = if body.remember {
                REMEMBER_ME_HOURS
            } else {
                config.session_timeout_hours
            };

            let browser_id = existing_browser_id.unwrap_or_else(|| store.create_browser());
            tracing::debug!(
                email = %body.email,
                "login: creating session"
            );

            let (token, account_id) = store.add_account_to_browser(
                &browser_id,
                body.email.clone(),
                body.password,
                user_hash,
                imap_host.clone(),
                imap_port,
                imap_tls,
                smtp_host.clone(),
                smtp_port,
                smtp_tls,
            );

            let max_age = session_hours * 3600;
            store.set_timeout_override(&token, Some(std::time::Duration::from_secs(max_age)));
            let secure = config.environment != "development";
            let browser_cookie_header = browser_cookie(&browser_id, max_age, secure);
            let session_cookie_header =
                account_session_cookie(&account_id, &token, max_age, secure);

            let response = (
                StatusCode::CREATED,
                [("content-type", "application/json")],
                serde_json::json!({
                    "account": {
                        "id": account_id,
                        "email": body.email,
                        "imapHost": imap_host,
                        "smtpHost": smtp_host
                    }
                })
                .to_string(),
            )
                .into_response();

            let mut response = response;
            let headers = response.headers_mut();
            if let Ok(header_value) = browser_cookie_header.parse() {
                headers.append("set-cookie", header_value);
            }
            if let Ok(header_value) = session_cookie_header.parse() {
                headers.append("set-cookie", header_value);
            }

            response
        }
        AuthResult::InvalidCredentials => (
            StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            serde_json::json!({
                "error": {
                    "code": "UNAUTHORIZED",
                    "message": "Invalid email or password",
                    "status": 401
                }
            })
            .to_string(),
        )
            .into_response(),
        AuthResult::ServerUnreachable(msg) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "application/json")],
            serde_json::json!({
                "error": {
                    "code": "SERVER_UNREACHABLE",
                    "message": msg,
                    "status": 503
                }
            })
            .to_string(),
        )
            .into_response(),
    }
}

/// `GET /api/auth/session`
///
/// Returns the current user's session information. Requires authentication
/// (the `auth_guard` middleware injects `SessionState` into extensions).
pub async fn get_session(Extension(session): Extension<SessionState>) -> Response {
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        serde_json::json!({ "user": { "email": session.email } }).to_string(),
    )
        .into_response()
}

pub async fn list_accounts(
    Extension(store): Extension<Arc<SessionStore>>,
    Extension(config): Extension<Arc<AppConfig>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let secure = config.environment != "development";
    let browser_id = extract_browser_id(&headers);
    let mut seen_accounts = std::collections::HashSet::new();
    let mut valid_accounts = Vec::new();
    let mut clear_cookies = Vec::new();

    // Missing or forged cookies must never revoke another client's sessions.
    // Validate the browser, account ID and token together before returning data.
    for (account_id, token) in extract_session_cookies(&headers) {
        if !seen_accounts.insert(account_id.clone()) {
            continue;
        }
        let session = browser_id
            .as_deref()
            .and_then(|browser_id| store.get_account_session(browser_id, &account_id, &token));
        if let Some(session) = session {
            valid_accounts.push(serde_json::json!({
                "id": session.account_id,
                "email": session.email,
                "imapHost": session.imap_host,
                "smtpHost": session.smtp_host
            }));
        } else {
            clear_cookies.push(clearing_account_cookie(&account_id, secure));
        }
    }

    let body = if valid_accounts.is_empty() {
        clear_cookies.push(clearing_browser_cookie(secure));
        serde_json::json!({ "accounts": [], "browserSessionExpired": true })
    } else {
        serde_json::json!({ "accounts": valid_accounts })
    };
    let mut response = Json(body).into_response();
    for cookie in clear_cookies {
        if let Ok(value) = cookie.parse() {
            response.headers_mut().append("set-cookie", value);
        }
    }
    response
}

pub async fn remove_account(
    Extension(store): Extension<Arc<SessionStore>>,
    Extension(config): Extension<Arc<AppConfig>>,
    Path(account_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let browser_id = extract_browser_id(&headers);

    let Some(browser_id) = browser_id else {
        return (
            StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            serde_json::json!({
                "error": {
                    "code": "UNAUTHORIZED",
                    "message": "No browser session",
                    "status": 401
                }
            })
            .to_string(),
        )
            .into_response();
    };

    let owns_account = extract_session_cookies(&headers)
        .into_iter()
        .filter(|(cookie_account_id, _)| cookie_account_id == &account_id)
        .any(|(_, token)| {
            store
                .get_account_session(&browser_id, &account_id, &token)
                .is_some()
        });

    if !owns_account {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": {
                    "code": "FORBIDDEN",
                    "message": "A valid account session is required",
                    "status": 403
                }
            })),
        )
            .into_response();
    }

    store.remove_account(&account_id);

    let secure = config.environment != "development";
    let cookie = clearing_account_cookie(&account_id, secure);

    (
        StatusCode::OK,
        [
            ("content-type", "application/json"),
            ("set-cookie", &cookie),
        ],
        serde_json::json!({ "status": "logged_out" }).to_string(),
    )
        .into_response()
}

/// `POST /api/auth/logout`
///
/// Removes the current session from the store and clears the session cookie.
/// Requires authentication.
pub async fn logout(
    Extension(store): Extension<Arc<SessionStore>>,
    Extension(config): Extension<Arc<AppConfig>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let browser_id = extract_browser_id(&headers);

    let mut cookies_to_clear: Vec<String> = Vec::new();

    if let Some(ref browser_id) = browser_id {
        for (account_id, token) in extract_session_cookies(&headers) {
            if store
                .get_account_session(browser_id, &account_id, &token)
                .is_some()
            {
                store.remove_account(&account_id);
            }
            cookies_to_clear.push(clearing_account_cookie(
                &account_id,
                config.environment != "development",
            ));
        }
    }

    let secure = config.environment != "development";
    cookies_to_clear.push(clearing_browser_cookie(secure));

    let response = (
        StatusCode::OK,
        [("content-type", "application/json")],
        serde_json::json!({ "status": "logged_out" }).to_string(),
    )
        .into_response();

    let mut response = response;
    let headers = response.headers_mut();
    for cookie in cookies_to_clear {
        if let Ok(header_value) = cookie.parse() {
            headers.append("set-cookie", header_value);
        }
    }

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    #[derive(Serialize)]
    struct UserResponse {
        user: UserInfo,
    }

    #[derive(Serialize)]
    struct UserInfo {
        email: String,
    }

    #[derive(Serialize)]
    struct LogoutResponse {
        status: &'static str,
    }

    #[test]
    fn user_response_serialization() {
        let resp = UserResponse {
            user: UserInfo {
                email: "test@example.com".to_string(),
            },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["user"]["email"], "test@example.com");
    }

    #[test]
    fn logout_response_serialization() {
        let resp = LogoutResponse {
            status: "logged_out",
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "logged_out");
    }

    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{delete, get, post};
    use http_body_util::BodyExt;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    fn test_config(data_dir: &tempfile::TempDir) -> AppConfig {
        let mut config: AppConfig = figment::Figment::new().extract().unwrap();
        config.data_dir = data_dir.path().to_str().unwrap().to_string();
        config.imap_host = Some("127.0.0.1".to_string());
        config.smtp_host = Some("smtp.example.com".to_string());
        config.smtp_port = 2525;
        config.tls_enabled = false;
        config.environment = "production".to_string();
        config
    }

    fn test_store() -> Arc<SessionStore> {
        Arc::new(SessionStore::new(Duration::from_secs(3600)))
    }

    fn test_router(store: Arc<SessionStore>, config: AppConfig) -> Router {
        Router::new()
            .route("/login", post(login))
            .route("/accounts", get(list_accounts))
            .route("/accounts/{id}", delete(remove_account))
            .route(
                "/logout",
                post(logout).layer(axum::middleware::from_fn(
                    crate::auth::middleware::auth_guard,
                )),
            )
            .layer(Extension(store))
            .layer(Extension(Arc::new(config)))
    }

    async fn request(
        app: Router,
        method: &str,
        path: &str,
        cookie: &str,
        body: serde_json::Value,
    ) -> (StatusCode, axum::http::HeaderMap, serde_json::Value) {
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            app.oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("cookie", cookie)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            ),
        )
        .await
        .expect("auth request must finish")
        .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, serde_json::from_slice(&bytes).unwrap())
    }

    // A real TCP IMAP peer makes the route tests exercise credential validation,
    // including which endpoint and transport the route actually chooses.
    async fn accepting_imap() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            stream
                .get_mut()
                .write_all(b"* OK test IMAP ready\r\n")
                .await
                .unwrap();
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            assert!(line.contains(" LOGIN "), "expected an IMAP LOGIN command");
            let tag = line.split_whitespace().next().unwrap();
            stream
                .get_mut()
                .write_all(format!("{tag} OK authenticated\r\n").as_bytes())
                .await
                .unwrap();
            line.clear();
            stream.read_line(&mut line).await.unwrap();
            assert!(line.contains(" LOGOUT"));
            let tag = line.split_whitespace().next().unwrap();
            stream
                .get_mut()
                .write_all(format!("* BYE logging out\r\n{tag} OK logout complete\r\n").as_bytes())
                .await
                .unwrap();
        });
        (port, handle)
    }

    fn add_test_account(store: &SessionStore, browser_id: &str, email: &str) -> (String, String) {
        store.add_account_to_browser(
            browser_id,
            email.to_string(),
            "password".to_string(),
            user_data::hash_email(email),
            "127.0.0.1".to_string(),
            993,
            true,
            "smtp.example.com".to_string(),
            587,
            true,
        )
    }

    fn response_cookie(headers: &axum::http::HeaderMap, name: &str) -> String {
        headers
            .get_all("set-cookie")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find_map(|value| value.strip_prefix(&format!("{name}=")))
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn login_ignores_client_mail_servers_and_browser_id() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut config = test_config(&data_dir);
        let (port, imap) = accepting_imap().await;
        config.imap_port = port;
        let store = test_store();
        let attacker_browser = store.create_browser();
        let (status, headers, json) = request(
            test_router(store.clone(), config),
            "POST",
            "/login",
            "",
            serde_json::json!({
                "email": "member@example.com", "password": "password", "remember": true,
                "imap_host": "127.0.0.2", "imap_port": 1, "imap_tls": true,
                "smtp_host": "attacker.example", "smtp_port": 1, "smtp_tls": true,
                "browser_id": attacker_browser,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{json}");
        imap.await.unwrap();
        let browser_id = response_cookie(&headers, BROWSER_COOKIE);
        assert_ne!(browser_id, attacker_browser);
        assert!(store.get_browser_accounts(&attacker_browser).is_empty());
        let account_id = json["account"]["id"].as_str().unwrap();
        let token = response_cookie(&headers, &format!("oxi_session_{account_id}"));
        let session = store
            .get_account_session(&browser_id, account_id, &token)
            .unwrap();
        assert_eq!(session.imap_host, "127.0.0.1");
        assert_eq!(session.imap_port, port);
        assert!(!session.imap_tls);
        assert_eq!(session.smtp_host, "smtp.example.com");
        assert_eq!(session.smtp_port, 2525);
        assert!(!session.smtp_tls);
        assert_eq!(
            session.timeout_override,
            Some(Duration::from_secs(30 * 24 * 3600))
        );
        for cookie in headers.get_all("set-cookie") {
            let cookie = cookie.to_str().unwrap();
            assert!(cookie.contains("HttpOnly"));
            assert!(cookie.contains("Secure"));
            assert!(cookie.contains("SameSite=Strict"));
        }
    }

    #[tokio::test]
    async fn login_cannot_disable_configured_tls() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut config = test_config(&data_dir);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        config.imap_port = listener.local_addr().unwrap().port();
        config.tls_enabled = true;
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut record = [0; 5];
            stream.read_exact(&mut record).await.unwrap();
            // TLS handshake record; plaintext LOGIN credentials must not be sent.
            assert_eq!(record[0], 22);
            assert_eq!(record[1], 3);
        });
        let store = test_store();
        let (status, _, _) = request(
            test_router(store.clone(), config), "POST", "/login", "",
            serde_json::json!({"email": "member@example.com", "password": "password", "imap_tls": false}),
        ).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        peer.await.unwrap();
        assert!(store.is_empty());
    }

    #[tokio::test]
    async fn login_requires_nonblank_configured_mail_servers() {
        let data_dir = tempfile::tempdir().unwrap();
        for (imap_host, smtp_host, expected_message) in [
            (None, Some("smtp.example.com"), "IMAP server not configured"),
            (
                Some(" "),
                Some("smtp.example.com"),
                "IMAP server not configured",
            ),
            (Some("127.0.0.1"), None, "SMTP server not configured"),
            (Some("127.0.0.1"), Some(" "), "SMTP server not configured"),
        ] {
            let mut config = test_config(&data_dir);
            config.imap_host = imap_host.map(str::to_string);
            config.smtp_host = smtp_host.map(str::to_string);
            let store = test_store();
            let (status, _, json) = request(
                test_router(store.clone(), config),
                "POST",
                "/login",
                "",
                serde_json::json!({
                    "email": "member@example.com", "password": "password",
                    "imap_host": "127.0.0.1", "smtp_host": "smtp.example.com",
                }),
            )
            .await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(json["error"]["message"], expected_message);
            assert!(store.is_empty());
        }
    }

    #[tokio::test]
    async fn login_requires_account_proof_to_reuse_browser() {
        let data_dir = tempfile::tempdir().unwrap();
        let store = test_store();
        let browser_id = store.create_browser();
        let (token, account_id) = add_test_account(&store, &browser_id, "first@example.com");
        for (cookie, reuses_browser) in [
            (format!("oxi_browser={browser_id}"), false),
            (
                format!("oxi_browser={browser_id}; oxi_session_{account_id}={token}"),
                true,
            ),
        ] {
            let mut config = test_config(&data_dir);
            let (port, imap) = accepting_imap().await;
            config.imap_port = port;
            let (status, headers, json) = request(
                test_router(store.clone(), config),
                "POST",
                "/login",
                &cookie,
                serde_json::json!({"email": "second@example.com", "password": "password"}),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "{json}");
            imap.await.unwrap();
            assert_eq!(
                response_cookie(&headers, BROWSER_COOKIE) == browser_id,
                reuses_browser
            );
        }
        assert_eq!(store.get_browser_accounts(&browser_id).len(), 2);
    }

    #[tokio::test]
    async fn login_allows_reauthentication_when_an_account_cookie_is_missing_or_expired() {
        let data_dir = tempfile::tempdir().unwrap();
        for expired in [false, true] {
            let store = test_store();
            let browser_id = store.create_browser();
            let (first_token, first_account) =
                add_test_account(&store, &browser_id, "first@example.com");
            let (second_token, second_account) =
                add_test_account(&store, &browser_id, "second@example.com");
            let mut cookie =
                format!("oxi_browser={browser_id}; oxi_session_{first_account}={first_token}");
            if expired {
                store.set_timeout_override(&second_token, Some(Duration::ZERO));
                cookie.push_str(&format!("; oxi_session_{second_account}={second_token}"));
            }
            let mut config = test_config(&data_dir);
            let (port, imap) = accepting_imap().await;
            config.imap_port = port;
            let (status, headers, json) = request(
                test_router(store.clone(), config),
                "POST",
                "/login",
                &cookie,
                serde_json::json!({"email": "second@example.com", "password": "password"}),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "{json}");
            imap.await.unwrap();
            assert_eq!(response_cookie(&headers, BROWSER_COOKIE), browser_id);
            assert_ne!(json["account"]["id"], second_account);
            assert!(store.get(&first_token).is_some());
        }
    }

    #[tokio::test]
    async fn account_listing_does_not_revoke_sessions_without_valid_cookies() {
        let data_dir = tempfile::tempdir().unwrap();
        let store = test_store();
        let browser_id = store.create_browser();
        let (token, account_id) = add_test_account(&store, &browser_id, "member@example.com");
        for cookie in [
            format!("oxi_browser={browser_id}"),
            format!("oxi_browser={browser_id}; oxi_session_{account_id}=forged"),
        ] {
            let (status, _, json) = request(
                test_router(store.clone(), test_config(&data_dir)),
                "GET",
                "/accounts",
                &cookie,
                serde_json::Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(json["accounts"], serde_json::json!([]));
            assert!(
                store
                    .get_account_session(&browser_id, &account_id, &token)
                    .is_some()
            );
        }
    }

    #[tokio::test]
    async fn account_listing_binds_tokens_to_the_requested_browser_and_account() {
        let data_dir = tempfile::tempdir().unwrap();
        let store = test_store();
        let browser_id = store.create_browser();
        let (token, account_id) = add_test_account(&store, &browser_id, "member@example.com");
        let other_browser = store.create_browser();
        let (other_token, other_account) =
            add_test_account(&store, &other_browser, "other@example.com");
        for cookie in [
            format!("oxi_browser={browser_id}; oxi_session_{account_id}={other_token}"),
            format!("oxi_browser={browser_id}; oxi_session_{other_account}={other_token}"),
        ] {
            let (_, _, json) = request(
                test_router(store.clone(), test_config(&data_dir)),
                "GET",
                "/accounts",
                &cookie,
                serde_json::Value::Null,
            )
            .await;
            assert_eq!(json["accounts"], serde_json::json!([]));
        }
        let (_, _, json) = request(
            test_router(store.clone(), test_config(&data_dir)),
            "GET",
            "/accounts",
            &format!("oxi_browser={browser_id}; oxi_session_{account_id}={token}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(json["accounts"][0]["email"], "member@example.com");
        assert!(store.get(&other_token).is_some());
    }

    #[tokio::test]
    async fn removing_account_requires_its_own_session_cookie() {
        let data_dir = tempfile::tempdir().unwrap();
        let store = test_store();
        let browser_id = store.create_browser();
        let (token, account_id) = add_test_account(&store, &browser_id, "member@example.com");
        let (other_token, _) = add_test_account(&store, &browser_id, "other@example.com");
        for cookie in [
            format!("oxi_browser={browser_id}"),
            format!("oxi_browser={browser_id}; oxi_session_{account_id}={other_token}"),
        ] {
            let (status, _, _) = request(
                test_router(store.clone(), test_config(&data_dir)),
                "DELETE",
                &format!("/accounts/{account_id}"),
                &cookie,
                serde_json::Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert!(store.get(&token).is_some());
        }
        let (status, _, _) = request(
            test_router(store.clone(), test_config(&data_dir)),
            "DELETE",
            &format!("/accounts/{account_id}"),
            &format!("oxi_browser={browser_id}; oxi_session_{account_id}={token}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(store.get(&token).is_none());
        assert!(store.get(&other_token).is_some());
    }

    #[tokio::test]
    async fn logout_revokes_only_accounts_with_matching_session_cookies() {
        let data_dir = tempfile::tempdir().unwrap();
        let store = test_store();
        let browser_id = store.create_browser();
        let (token, account_id) = add_test_account(&store, &browser_id, "member@example.com");
        let (other_token, _) = add_test_account(&store, &browser_id, "other@example.com");
        let (status, _, _) = request(
            test_router(store.clone(), test_config(&data_dir)),
            "POST",
            &format!("/logout?account_id={account_id}"),
            &format!("oxi_browser={browser_id}; oxi_session_{account_id}={token}"),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(store.get(&token).is_none());
        assert!(store.get(&other_token).is_some());
    }
}
