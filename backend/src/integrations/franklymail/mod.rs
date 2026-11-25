//! Optional FranklyMail administration; core IMAP/SMTP never depends on it.
mod client;
pub mod config;
mod emails;
mod sieve;
mod storage;

use crate::{
    auth::{
        csrf::csrf_protection,
        middleware::auth_guard,
        session::{SessionState, SessionStore},
    },
    config::AppConfig,
    error::AppError,
    imap::client::{ImapClient, ImapCredentials, ImapError},
    smtp::client::{SendableMessage, SmtpClient, SmtpCredentials},
};
use axum::{
    Extension, Json, Router,
    extract::{Query, Request},
    middleware::{self, Next},
    response::Response,
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

struct Integration {
    config: config::Config,
    client: client::ManagementClient,
    storage: storage::Storage,
    welcome: emails::EmailTemplate,
    reset: emails::EmailTemplate,
    // Serialize this process's writes. The provider API does not document CAS.
    writes: Mutex<()>,
}

pub fn router(config: config::Config, app: &AppConfig) -> Result<Router, AppError> {
    config
        .validate(app)
        .map_err(|e| AppError::InternalError(e.into()))?;
    let enabled = config.enabled;
    let recovery = config.recovery_enabled();
    let caps =
        Router::new().route(
            "/capabilities",
            get(move || async move {
                Json(json!({"franklymail":enabled,"franklymail_recovery":recovery}))
            }),
        );
    if !enabled {
        return Ok(Router::new().nest("/integrations", caps));
    }
    let integration = Arc::new(Integration {
        client: client::ManagementClient::new(config.api_key.clone())
            .map_err(|_| AppError::InternalError("Cannot initialize FranklyMail client".into()))?,
        storage: storage::Storage::new(&app.data_dir)?,
        welcome: emails::EmailTemplate::welcome(&config)?,
        reset: emails::EmailTemplate::reset(&config)?,
        config,
        writes: Mutex::new(()),
    });
    let protected = Router::new()
        .route("/mailboxes", get(mailboxes).post(create_mailbox))
        .route("/mailboxes/delete", post(delete_mailbox))
        .route("/settings", get(settings))
        .route("/forwarding", put(forwarding))
        .route("/recovery", post(admin_recovery))
        .layer(middleware::from_fn(admin_guard))
        .layer(middleware::from_fn(auth_guard));
    let public = Router::new()
        .route("/recovery/request", post(request_reset))
        .route("/recovery/reset", post(reset_password));
    let account = Router::new()
        .route("/account", get(account_capabilities))
        .route("/password", post(change_password))
        .layer(middleware::from_fn(auth_guard));
    let limit = tower_governor::governor::GovernorConfigBuilder::default()
        .key_extractor(crate::routes::ClientIpKeyExtractor {
            trusted_proxies: Arc::new(crate::routes::parse_trusted_proxies(
                app.trusted_proxies.as_deref(),
            )),
        })
        .period(std::time::Duration::from_secs(12))
        .burst_size(10)
        .finish()
        .expect("valid limiter");
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let limiter = limit.limiter().clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                limiter.retain_recent();
            }
        });
    }
    let routes = protected
        .merge(account)
        .merge(public)
        .layer(middleware::from_fn(csrf_protection))
        .layer(tower_governor::GovernorLayer::new(limit))
        .layer(Extension(integration));
    Ok(Router::new().nest("/integrations", caps.nest("/franklymail", routes)))
}

async fn admin_guard(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(s): Extension<SessionState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    if !app.is_admin(&s.email)
        || !i.config.allows(&s.email)
        || !app
            .imap_host
            .as_deref()
            .is_some_and(|host| host.eq_ignore_ascii_case(&s.imap_host))
        || !s.imap_tls
    {
        return Err(AppError::Forbidden(
            "FranklyMail administration requires a server administrator".into(),
        ));
    }
    Ok(next.run(req).await)
}

fn target(i: &Integration, app: &AppConfig, value: &str) -> Result<String, AppError> {
    let email = sieve::email(value)?;
    if !i.config.allows(&email) || !app.is_email_domain_allowed(&email) {
        return Err(AppError::Forbidden(
            "This mailbox is outside the configured FranklyMail domains".into(),
        ));
    }
    Ok(email)
}

fn own_mailbox(i: &Integration, app: &AppConfig, s: &SessionState) -> Result<String, AppError> {
    if !s.imap_tls
        || s.imap_port != app.imap_port
        || !app
            .imap_host
            .as_deref()
            .is_some_and(|host| host.eq_ignore_ascii_case(&s.imap_host))
    {
        return Err(AppError::Forbidden(
            "Password changes are not available for this account".into(),
        ));
    }
    target(i, app, &s.email)
}

async fn account_capabilities(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(s): Extension<SessionState>,
) -> Json<Value> {
    Json(json!({"change_password":own_mailbox(&i, &app, &s).is_ok()}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangePassword {
    current_password: String,
    new_password: String,
}

async fn change_password(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(s): Extension<SessionState>,
    Extension(store): Extension<Arc<SessionStore>>,
    Extension(imap): Extension<Arc<dyn ImapClient>>,
    Json(body): Json<ChangePassword>,
) -> Result<Json<Value>, AppError> {
    let email = own_mailbox(&i, &app, &s)?;
    validate_password(&body.new_password)?;
    if body.current_password.is_empty() || body.current_password.len() > 4096 {
        return Err(AppError::BadRequest("Enter your current password".into()));
    }
    if body.current_password == body.new_password {
        return Err(AppError::BadRequest(
            "Choose a different new password".into(),
        ));
    }
    let _lock = i.writes.lock().await;
    // A fresh authenticated connection verifies the supplied password, even if
    // the password stored in this browser session has become stale.
    let credentials = ImapCredentials {
        host: s.imap_host.clone(),
        port: s.imap_port,
        tls: s.imap_tls,
        email: s.email.clone(),
        password: body.current_password,
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(20),
        imap.list_folders(&credentials),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(ImapError::AuthenticationFailed)) => {
            return Err(AppError::BadRequest(
                "The current password is incorrect".into(),
            ));
        }
        _ => {
            return Err(AppError::ServiceUnavailable(
                "Unable to verify the current password. Please try again.".into(),
            ));
        }
    }
    let id = i.client.mailbox(&email).await?;
    let result = i.client.password(id, &body.new_password).await;
    // The provider may have applied a change even if its response was lost.
    store.revoke_mailbox(&email, &s.imap_host);
    i.storage.invalidate_tokens(&email)?;
    result?;
    Ok(Json(json!({"ok":true})))
}

async fn mailboxes(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
) -> Result<Json<Value>, AppError> {
    let list: Vec<_> = i
        .client
        .mailboxes()
        .await?
        .into_iter()
        .filter(|m| target(&i, &app, &m.address).is_ok())
        .collect();
    let domains: Vec<_> = i
        .config
        .domains
        .split(',')
        .map(|domain| domain.trim().to_lowercase())
        .filter(|domain| target(&i, &app, &format!("mailbox@{domain}")).is_ok())
        .collect();
    Ok(Json(
        json!({"mailboxes":list,"domains":domains,"recovery_enabled":i.config.recovery_enabled()}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    email: String,
}
async fn settings(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Query(query): Query<Target>,
) -> Result<Json<Value>, AppError> {
    let email = target(&i, &app, &query.email)?;
    let id = i.client.mailbox(&email).await?;
    let script = i.client.script(id).await?;
    let (original, forwarding) = sieve::split(&script.script)?;
    Ok(Json(
        json!({"forwarding":forwarding, "revision":sieve::revision(&script.script), "existing_rules":!original.trim().is_empty(), "externally_managed":script.managed_rules_present, "recovery_email":i.storage.recovery(&email)?}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForwardRequest {
    email: String,
    revision: String,
    forwarding: sieve::Forwarding,
}
async fn forwarding(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Json(body): Json<ForwardRequest>,
) -> Result<Json<Value>, AppError> {
    let email = target(&i, &app, &body.email)?;
    let _lock = i.writes.lock().await;
    let id = i.client.mailbox(&email).await?;
    let current = i.client.script(id).await?;
    if current.managed_rules_present {
        return Err(AppError::BadRequest("This mailbox has rules managed by FranklyMail Agentic Inbox. Manage them in FranklyMail to avoid replacing them.".into()));
    }
    if sieve::revision(&current.script) != body.revision {
        return Err(AppError::BadRequest(
            "Server rules changed. Refresh settings before saving.".into(),
        ));
    }
    let next = sieve::replace(&current.script, &body.forwarding, &email)?;
    if next != current.script {
        i.client.save_script(id, &next).await?;
    }
    let saved = i.client.script(id).await?;
    if saved.script != next {
        return Err(AppError::ServiceUnavailable(
            "The server did not confirm the saved rule. Refresh settings before retrying.".into(),
        ));
    }
    Ok(Json(json!({"ok":true})))
}

fn validate_password(password: &str) -> Result<(), AppError> {
    if password.chars().count() < 12
        || password.len() > 256
        || password.chars().any(char::is_control)
    {
        return Err(AppError::BadRequest(
            "Use a password of 12–256 characters without control characters".into(),
        ));
    }
    Ok(())
}
fn recovery_enabled(i: &Integration) -> Result<(), AppError> {
    if !i.config.recovery_enabled() {
        return Err(AppError::NotFound(
            "Password recovery email delivery is not configured".into(),
        ));
    }
    Ok(())
}
async fn send_link(
    i: &Integration,
    app: &AppConfig,
    smtp: &dyn SmtpClient,
    mailbox: &str,
    destination: &str,
    token: &str,
    welcome: bool,
) -> Result<(), AppError> {
    let link = format!(
        "{}/franklymail-recovery#token={token}",
        i.config.public_url.trim_end_matches('/')
    );
    let (subject, template) = if welcome {
        ("Welcome — choose your mailbox password", &i.welcome)
    } else {
        ("Reset your mailbox password", &i.reset)
    };
    let creds = SmtpCredentials {
        host: app
            .smtp_host
            .clone()
            .ok_or_else(|| AppError::ServiceUnavailable("SMTP server is not configured".into()))?,
        port: app.smtp_port,
        tls: app.tls_enabled,
        email: i.config.smtp_username.clone(),
        password: i.config.smtp_password.clone(),
    };
    let (text_body, html_body) = template.render(mailbox, &link);
    let message = SendableMessage {
        from: i.config.mail_from.clone(),
        to: vec![destination.into()],
        cc: vec![],
        bcc: vec![],
        subject: subject.into(),
        text_body,
        html_body: Some(html_body),
        in_reply_to: None,
        references: None,
        attachments: vec![],
    };
    smtp.send_message(&creds,&message).await.map_err(|_| AppError::ServiceUnavailable("The mailbox is saved, but email delivery could not be confirmed. Wait one minute, then send a new link from administration.".into()))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invitation {
    email: String,
    personal_email: String,
}
fn personal_email(body: &Invitation) -> Result<String, AppError> {
    let email = sieve::email(&body.personal_email)?;
    if email.eq_ignore_ascii_case(&body.email) {
        return Err(AppError::BadRequest(
            "Use a separate personal email address for password recovery".into(),
        ));
    }
    Ok(email)
}
async fn invite(
    i: &Integration,
    app: &AppConfig,
    smtp: &dyn SmtpClient,
    email: &str,
    personal: &str,
    welcome: bool,
) -> Result<(), AppError> {
    // This mapping is an explicit assertion by an authenticated administrator.
    if i.storage.recovery(email)?.as_deref() != Some(personal) {
        i.storage.set_recovery(email, personal)?;
    }
    let token = i.storage.issue(email, personal, "reset")?.ok_or_else(|| {
        AppError::BadRequest("Please wait one minute before requesting another email".into())
    })?;
    send_link(i, app, smtp, email, personal, &token, welcome).await
}
async fn create_mailbox(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(smtp): Extension<Arc<dyn SmtpClient>>,
    Json(body): Json<Invitation>,
) -> Result<Json<Value>, AppError> {
    recovery_enabled(&i)?;
    let email = target(&i, &app, &body.email)?;
    let personal = personal_email(&body)?;
    let _lock = i.writes.lock().await;
    if i.client
        .mailboxes()
        .await?
        .iter()
        .any(|m| m.address.eq_ignore_ascii_case(&email))
    {
        return Err(AppError::BadRequest(
            "This mailbox already exists. Select it to send a password link.".into(),
        ));
    }
    i.client.create_mailbox(&email).await?;
    invite(&i, &app, smtp.as_ref(), &email, &personal, true).await?;
    Ok(Json(json!({"ok":true})))
}
async fn admin_recovery(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(smtp): Extension<Arc<dyn SmtpClient>>,
    Json(body): Json<Invitation>,
) -> Result<Json<Value>, AppError> {
    recovery_enabled(&i)?;
    let email = target(&i, &app, &body.email)?;
    let personal = personal_email(&body)?;
    let _lock = i.writes.lock().await;
    i.client.mailbox(&email).await?;
    invite(&i, &app, smtp.as_ref(), &email, &personal, false).await?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteMailbox {
    email: String,
    mailbox_id: uuid::Uuid,
    confirmation: String,
}
async fn delete_mailbox(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(s): Extension<SessionState>,
    Extension(store): Extension<Arc<SessionStore>>,
    Json(body): Json<DeleteMailbox>,
) -> Result<Json<Value>, AppError> {
    let email = target(&i, &app, &body.email)?;
    if !body.confirmation.trim().eq_ignore_ascii_case(&email) {
        return Err(AppError::BadRequest(
            "Enter the mailbox address to confirm deletion".into(),
        ));
    }
    if s.email.eq_ignore_ascii_case(&email) {
        return Err(AppError::BadRequest(
            "You cannot delete the account you are currently using".into(),
        ));
    }
    let _lock = i.writes.lock().await;
    let id = i.client.mailbox(&email).await?;
    if id != body.mailbox_id {
        return Err(AppError::BadRequest(
            "This mailbox has changed. Refresh users before trying again.".into(),
        ));
    }
    // Clear recovery before sending a destructive request: even an ambiguous
    // provider result must not leave the former owner's recovery access behind.
    i.storage.forget_mailbox(&email)?;
    let result = i.client.delete_mailbox(id).await;
    store.revoke_mailbox(&email, app.imap_host.as_deref().unwrap_or(""));
    result?;
    Ok(Json(json!({"ok":true})))
}

async fn request_reset(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(smtp): Extension<Arc<dyn SmtpClient>>,
    Json(body): Json<Target>,
) -> Result<Json<Value>, AppError> {
    recovery_enabled(&i)?;
    // Uniform response and background delivery avoid revealing registered addresses.
    tokio::spawn(async move {
        let result = async {
            let email = target(&i, &app, &body.email)?;
            let _lock = i.writes.lock().await;
            if let Some(destination) = i.storage.recovery(&email)?
                && let Some(token) = i.storage.issue(&email, &destination, "reset")?
            {
                send_link(&i, &app, smtp.as_ref(), &email, &destination, &token, false).await?;
            }
            Ok::<(), AppError>(())
        }
        .await;
        if result.is_err() {
            tracing::warn!("FranklyMail recovery request could not be completed");
        }
    });
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetPassword {
    token: String,
    new_password: String,
}
async fn reset_password(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(store): Extension<Arc<SessionStore>>,
    Json(body): Json<ResetPassword>,
) -> Result<Json<Value>, AppError> {
    recovery_enabled(&i)?;
    validate_password(&body.new_password)?;
    let _lock = i.writes.lock().await;
    let token = i.storage.consume(&body.token, "reset")?;
    target(&i, &app, &token.email)?;
    if i.storage.recovery(&token.email)?.as_deref() != Some(&token.destination) {
        return Err(AppError::Forbidden(
            "Recovery is no longer available for this mailbox".into(),
        ));
    }
    let id = i.client.mailbox(&token.email).await?;
    // Revoke on ambiguous failures too: the provider may have applied the change.
    let result = i.client.password(id, &body.new_password).await;
    store.revoke_mailbox(&token.email, app.imap_host.as_deref().unwrap_or(""));
    i.storage.invalidate_tokens(&token.email)?;
    result?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests;
