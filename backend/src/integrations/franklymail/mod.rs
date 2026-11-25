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
    routes::ClientIpKeyExtractor,
    smtp::client::{SendableMessage, SmtpClient, SmtpCredentials},
};
use axum::{
    Extension, Json, Router,
    extract::{Query, Request},
    middleware::{self, Next},
    response::Response,
    routing::{get, post, put},
};
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use storage::Origin;
use tokio::sync::{Mutex, OwnedMutexGuard, Semaphore};
use tower_governor::{GovernorLayer, governor::GovernorConfig};

/// Upper bound for one outgoing email, so a stalled SMTP server cannot pin a
/// request or a background task.
const SMTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Concurrent background deliveries for anonymous recovery requests. Requests
/// beyond this are dropped; the response stays the same.
const MAX_RECOVERY_TASKS: usize = 4;

struct Integration {
    config: config::Config,
    client: client::ManagementClient,
    storage: storage::Storage,
    welcome: emails::EmailTemplate,
    reset: emails::EmailTemplate,
    // Serialize this process's writes per mailbox: the provider API does not
    // document CAS. Held only around provider writes and token bookkeeping,
    // never during IMAP checks or SMTP deliveries.
    locks: DashMap<String, Arc<Mutex<()>>>,
    recovery_tasks: Arc<Semaphore>,
}

/// Per-mailbox write lock; its map entry goes away with the last holder.
struct MailboxLock<'a> {
    locks: &'a DashMap<String, Arc<Mutex<()>>>,
    key: String,
    guard: Option<OwnedMutexGuard<()>>,
}
impl Drop for MailboxLock<'_> {
    fn drop(&mut self) {
        self.guard.take();
        self.locks
            .remove_if(&self.key, |_, lock| Arc::strong_count(lock) == 1);
    }
}

impl Integration {
    fn new(
        config: config::Config,
        client: client::ManagementClient,
        storage: storage::Storage,
    ) -> Result<Self, AppError> {
        Ok(Self {
            welcome: emails::EmailTemplate::welcome(&config)?,
            reset: emails::EmailTemplate::reset(&config)?,
            config,
            client,
            storage,
            locks: DashMap::new(),
            recovery_tasks: Arc::new(Semaphore::new(MAX_RECOVERY_TASKS)),
        })
    }
    async fn lock(&self, email: &str) -> MailboxLock<'_> {
        let key = email.to_ascii_lowercase();
        let lock = self.locks.entry(key.clone()).or_default().clone();
        MailboxLock {
            locks: &self.locks,
            key,
            guard: Some(lock.lock_owned().await),
        }
    }
}

type Limiter = Arc<GovernorConfig<ClientIpKeyExtractor, ::governor::middleware::NoOpMiddleware>>;
fn limiter(app: &AppConfig, period: Duration, burst: u32) -> Limiter {
    let config = tower_governor::governor::GovernorConfigBuilder::default()
        .key_extractor(ClientIpKeyExtractor {
            trusted_proxies: Arc::new(crate::routes::parse_trusted_proxies(
                app.trusted_proxies.as_deref(),
            )),
        })
        .period(period)
        .burst_size(burst)
        .finish()
        .expect("valid limiter");
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let limiter = config.limiter().clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                limiter.retain_recent();
            }
        });
    }
    Arc::new(config)
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
    if !config.has_admins() {
        tracing::warn!(
            "FRANKLYMAIL_ADMIN_EMAILS is empty: FranklyMail user administration is disabled. ADMIN_EMAILS does not grant it."
        );
    }
    let client = client::ManagementClient::new(config.api_key.clone())
        .map_err(|_| AppError::InternalError("Cannot initialize FranklyMail client".into()))?;
    let storage = storage::Storage::new(&app.data_dir)?;
    let integration = Arc::new(Integration::new(config, client, storage)?);
    // Signed-in routes use their own bucket, consulted only after
    // authentication, so anonymous recovery floods cannot lock users out.
    let signed_in = limiter(app, Duration::from_secs(2), 30);
    let protected = Router::new()
        .route("/mailboxes", get(mailboxes).post(create_mailbox))
        .route("/mailboxes/delete", post(delete_mailbox))
        .route("/settings", get(settings))
        .route("/forwarding", put(forwarding))
        .route("/recovery", post(admin_recovery))
        .layer(GovernorLayer::new(signed_in.clone()))
        .layer(middleware::from_fn(admin_guard))
        .layer(middleware::from_fn(auth_guard));
    let account = Router::new()
        .route("/account", get(account_capabilities))
        .route("/password", post(change_password))
        .layer(GovernorLayer::new(signed_in))
        .layer(middleware::from_fn(auth_guard));
    let public = Router::new()
        .route("/recovery/request", post(request_reset))
        .route("/recovery/reset", post(reset_password))
        .layer(GovernorLayer::new(limiter(
            app,
            Duration::from_secs(12),
            10,
        )));
    let routes = protected
        .merge(account)
        .merge(public)
        .layer(middleware::from_fn(csrf_protection))
        .layer(Extension(integration));
    Ok(Router::new().nest("/integrations", caps.nest("/franklymail", routes)))
}

/// Structured audit trail for security-relevant changes. Never pass secrets.
fn audit<T>(actor: &str, action: &'static str, mailbox: &str, result: &Result<T, AppError>) {
    let outcome = match result {
        Ok(_) => "success",
        Err(AppError::Forbidden(_)) | Err(AppError::Unauthorized(_)) => "denied",
        Err(AppError::BadRequest(_)) | Err(AppError::NotFound(_)) => "rejected",
        Err(_) => "failed",
    };
    audit_event(actor, action, mailbox, outcome);
}
fn audit_event(actor: &str, action: &'static str, mailbox: &str, outcome: &'static str) {
    // Debug formatting escapes control characters in user-supplied values.
    tracing::info!(
        target: "audit",
        integration = "franklymail",
        actor = ?actor,
        action,
        mailbox = ?mailbox,
        outcome,
        "FranklyMail audit"
    );
}

fn is_admin_session(i: &Integration, app: &AppConfig, s: &SessionState) -> bool {
    i.config.is_admin(&s.email)
        && i.config.allows(&s.email)
        && s.imap_tls
        && s.imap_port == app.imap_port
        && app
            .imap_host
            .as_deref()
            .is_some_and(|host| host.eq_ignore_ascii_case(&s.imap_host))
}

async fn admin_guard(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(s): Extension<SessionState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    if !is_admin_session(&i, &app, &s) {
        if !req.method().is_safe() {
            audit_event(&s.email, "admin.access", req.uri().path(), "denied");
        }
        return Err(AppError::Forbidden(
            "FranklyMail administration requires a FranklyMail administrator".into(),
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

/// Another FranklyMail administrator's mailbox: only its owner may change its
/// recovery address, forwarding or existence.
fn is_other_admin(i: &Integration, actor: &str, mailbox: &str) -> bool {
    i.config.is_admin(mailbox) && !actor.trim().eq_ignore_ascii_case(mailbox)
}
fn not_other_admin(i: &Integration, actor: &str, mailbox: &str) -> Result<(), AppError> {
    if is_other_admin(i, actor, mailbox) {
        return Err(AppError::Forbidden(
            "Only its owner can change another FranklyMail administrator's mailbox".into(),
        ));
    }
    Ok(())
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
    Json(json!({
        "change_password": own_mailbox(&i, &app, &s).is_ok(),
        "admin": is_admin_session(&i, &app, &s),
    }))
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
    let actor = s.email.clone();
    let result = change_password_inner(&i, &app, s, &store, imap.as_ref(), body).await;
    audit(&actor, "password.change", &actor, &result);
    result
}
async fn change_password_inner(
    i: &Integration,
    app: &AppConfig,
    s: SessionState,
    store: &SessionStore,
    imap: &dyn ImapClient,
    body: ChangePassword,
) -> Result<Json<Value>, AppError> {
    let email = own_mailbox(i, app, &s)?;
    validate_password(&body.new_password)?;
    if body.current_password.is_empty() || body.current_password.len() > 4096 {
        return Err(AppError::BadRequest("Enter your current password".into()));
    }
    if body.current_password == body.new_password {
        return Err(AppError::BadRequest(
            "Choose a different new password".into(),
        ));
    }
    // A fresh authenticated connection verifies the supplied password, even if
    // the password stored in this browser session has become stale. This runs
    // before taking the mailbox lock: it can take up to 20 seconds.
    let credentials = ImapCredentials {
        host: s.imap_host.clone(),
        port: s.imap_port,
        tls: s.imap_tls,
        email: s.email.clone(),
        password: body.current_password,
    };
    match tokio::time::timeout(Duration::from_secs(20), imap.list_folders(&credentials)).await {
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
    let _lock = i.lock(&email).await;
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
    Extension(s): Extension<SessionState>,
) -> Result<Json<Value>, AppError> {
    let list: Vec<_> = i
        .client
        .mailboxes()
        .await?
        .into_iter()
        .filter(|m| target(&i, &app, &m.address).is_ok())
        .map(|m| {
            let protected = is_other_admin(&i, &s.email, &m.address);
            json!({"id":m.id,"address":m.address,"protected":protected})
        })
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
    Extension(s): Extension<SessionState>,
    Query(query): Query<Target>,
) -> Result<Json<Value>, AppError> {
    let email = target(&i, &app, &query.email)?;
    let id = i.client.mailbox(&email).await?;
    let script = i.client.script(id).await?;
    let (original, forwarding) = sieve::split(&script.script)?;
    Ok(Json(json!({
        "forwarding": forwarding,
        "revision": sieve::revision(&script.script),
        "existing_rules": !original.trim().is_empty(),
        "externally_managed": script.managed_rules_present,
        "recovery_email": i.storage.recovery(&email)?,
        "protected": is_other_admin(&i, &s.email, &email),
    })))
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
    Extension(s): Extension<SessionState>,
    Extension(smtp): Extension<Arc<dyn SmtpClient>>,
    Json(body): Json<ForwardRequest>,
) -> Result<Json<Value>, AppError> {
    let requested = body.email.clone();
    let result = forwarding_inner(&i, &app, &s, smtp.as_ref(), body).await;
    audit(&s.email, "forwarding.update", &requested, &result);
    result
}
async fn forwarding_inner(
    i: &Integration,
    app: &AppConfig,
    s: &SessionState,
    smtp: &dyn SmtpClient,
    body: ForwardRequest,
) -> Result<Json<Value>, AppError> {
    let email = target(i, app, &body.email)?;
    not_other_admin(i, &s.email, &email)?;
    let (previous, saved_rule) = {
        let _lock = i.lock(&email).await;
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
        let (_, previous) = sieve::split(&current.script)?;
        let next = sieve::replace(&current.script, &body.forwarding, &email)?;
        if next != current.script {
            i.client.save_script(id, &next).await?;
        }
        let saved = i.client.script(id).await?;
        if saved.script != next {
            return Err(AppError::ServiceUnavailable(
                "The server did not confirm the saved rule. Refresh settings before retrying."
                    .into(),
            ));
        }
        (previous, sieve::split(&next)?.1)
    };
    // Tell the owner when mail starts going somewhere new. Redirect rules may
    // forward the notice itself, so the recovery address is told as well.
    if saved_rule.enabled && (!previous.enabled || previous != saved_rule) {
        let mut recipients = vec![email.clone()];
        recipients.extend(i.storage.recovery(&email).ok().flatten());
        notify(
            i,
            app,
            smtp,
            &emails::Notice::ForwardingChanged {
                address: &saved_rule.address,
                keep_copy: saved_rule.keep_copy,
            },
            &email,
            &recipients,
        )
        .await;
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

/// Send one email from the integration's sender, bounded by `SMTP_TIMEOUT`.
async fn deliver(
    i: &Integration,
    app: &AppConfig,
    smtp: &dyn SmtpClient,
    destination: &str,
    subject: &str,
    text_body: String,
    html_body: String,
) -> Result<(), ()> {
    let creds = SmtpCredentials {
        host: app.smtp_host.clone().ok_or(())?,
        port: app.smtp_port,
        tls: app.tls_enabled,
        email: i.config.smtp_username.clone(),
        password: i.config.smtp_password.clone(),
    };
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
    match tokio::time::timeout(SMTP_TIMEOUT, smtp.send_message(&creds, &message)).await {
        Ok(Ok(_)) => Ok(()),
        _ => Err(()),
    }
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
    let (text_body, html_body) = template.render(mailbox, &link);
    deliver(i, app, smtp, destination, subject, text_body, html_body).await.map_err(|_| AppError::ServiceUnavailable("The mailbox is saved, but email delivery could not be confirmed. Wait one minute, then send a new link from administration.".into()))
}

/// Best effort: a failed notice is logged and never fails the change itself.
async fn notify(
    i: &Integration,
    app: &AppConfig,
    smtp: &dyn SmtpClient,
    notice: &emails::Notice<'_>,
    mailbox: &str,
    recipients: &[String],
) {
    if !i.config.recovery_enabled() {
        tracing::warn!(
            "FranklyMail email delivery is not configured; a security notice was not sent"
        );
        return;
    }
    let rendered = notice.render(mailbox);
    let mut sent: Vec<&str> = vec![];
    for recipient in recipients {
        if sent.iter().any(|s| s.eq_ignore_ascii_case(recipient)) {
            continue;
        }
        sent.push(recipient);
        if deliver(
            i,
            app,
            smtp,
            recipient,
            rendered.subject,
            rendered.text.clone(),
            rendered.html.clone(),
        )
        .await
        .is_err()
        {
            tracing::warn!(mailbox = ?mailbox, "FranklyMail security notice could not be delivered");
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invitation {
    email: String,
    personal_email: String,
}
/// `mailbox` is the normalized target address.
fn personal_email(value: &str, mailbox: &str) -> Result<String, AppError> {
    let email = sieve::email(value)?;
    if email.eq_ignore_ascii_case(mailbox) {
        return Err(AppError::BadRequest(
            "Use a separate personal email address for password recovery".into(),
        ));
    }
    Ok(email)
}

struct Assigned {
    /// `None` while administrator links are throttled for this mailbox.
    token: Option<String>,
    /// `Some(previous address)` when the recovery address changed.
    changed_from: Option<Option<String>>,
}
impl Assigned {
    fn token(self) -> Result<String, AppError> {
        self.token.ok_or_else(|| {
            AppError::BadRequest("Please wait one minute before requesting another email".into())
        })
    }
}
/// Record the recovery address and issue an administrator link. Call with the
/// mailbox lock held.
fn assign_recovery(i: &Integration, email: &str, personal: &str) -> Result<Assigned, AppError> {
    // This mapping is an explicit assertion by an authenticated administrator.
    let previous = i.storage.recovery(email)?;
    let changed = previous.as_deref() != Some(personal);
    if changed {
        i.storage.set_recovery(email, personal)?;
    }
    Ok(Assigned {
        token: i.storage.issue(email, personal, "reset", Origin::Admin)?,
        changed_from: changed.then_some(previous),
    })
}

async fn create_mailbox(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(s): Extension<SessionState>,
    Extension(smtp): Extension<Arc<dyn SmtpClient>>,
    Json(body): Json<Invitation>,
) -> Result<Json<Value>, AppError> {
    let requested = body.email.clone();
    let result = create_mailbox_inner(&i, &app, &s, smtp.as_ref(), body).await;
    audit(&s.email, "mailbox.create", &requested, &result);
    result
}
async fn create_mailbox_inner(
    i: &Integration,
    app: &AppConfig,
    s: &SessionState,
    smtp: &dyn SmtpClient,
    body: Invitation,
) -> Result<Json<Value>, AppError> {
    recovery_enabled(i)?;
    let email = target(i, app, &body.email)?;
    // Creating a listed administrator's address would hand its recovery, and
    // so its administrator rights, to whoever creates it.
    not_other_admin(i, &s.email, &email)?;
    let personal = personal_email(&body.personal_email, &email)?;
    let assigned = {
        let _lock = i.lock(&email).await;
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
        // A reused address must not inherit a former owner's cached mail,
        // drafts, identities or search index.
        wipe_local_data(&app.data_dir, [email.as_str(), body.email.trim()]).await;
        i.client.create_mailbox(&email).await?;
        assign_recovery(i, &email, &personal)?
    };
    // A leftover address from a former mailbox is told it no longer applies.
    if let Some(Some(old)) = &assigned.changed_from {
        notify(i, app, smtp, &emails::Notice::RecoveryChanged, &email, std::slice::from_ref(old)).await;
    }
    let token = assigned.token()?;
    send_link(i, app, smtp, &email, &personal, &token, true).await?;
    audit_event(&s.email, "invite.send", &email, "success");
    Ok(Json(json!({"ok":true})))
}

async fn admin_recovery(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(s): Extension<SessionState>,
    Extension(smtp): Extension<Arc<dyn SmtpClient>>,
    Json(body): Json<Invitation>,
) -> Result<Json<Value>, AppError> {
    let requested = body.email.clone();
    let result = admin_recovery_inner(&i, &app, &s, smtp.as_ref(), body).await;
    audit(&s.email, "recovery.set_and_send_link", &requested, &result);
    result
}
async fn admin_recovery_inner(
    i: &Integration,
    app: &AppConfig,
    s: &SessionState,
    smtp: &dyn SmtpClient,
    body: Invitation,
) -> Result<Json<Value>, AppError> {
    recovery_enabled(i)?;
    let email = target(i, app, &body.email)?;
    not_other_admin(i, &s.email, &email)?;
    let personal = personal_email(&body.personal_email, &email)?;
    let assigned = {
        let _lock = i.lock(&email).await;
        i.client.mailbox(&email).await?;
        assign_recovery(i, &email, &personal)?
    };
    if let Some(old) = &assigned.changed_from {
        audit_event(&s.email, "recovery.change", &email, "success");
        // Tell the mailbox and whoever controlled recovery until now.
        let mut recipients = vec![email.clone()];
        recipients.extend(old.clone());
        notify(i, app, smtp, &emails::Notice::RecoveryChanged, &email, &recipients).await;
    }
    let token = assigned.token()?;
    send_link(i, app, smtp, &email, &personal, &token, false).await?;
    audit_event(&s.email, "reset_link.send", &email, "success");
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
    let requested = body.email.clone();
    let result = delete_mailbox_inner(&i, &app, &s, &store, body).await;
    audit(&s.email, "mailbox.delete", &requested, &result);
    result
}
async fn delete_mailbox_inner(
    i: &Integration,
    app: &AppConfig,
    s: &SessionState,
    store: &SessionStore,
    body: DeleteMailbox,
) -> Result<Json<Value>, AppError> {
    let email = target(i, app, &body.email)?;
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
    not_other_admin(i, &s.email, &email)?;
    let provider_address = {
        let _lock = i.lock(&email).await;
        let mailbox = i.client.find_mailbox(&email).await?;
        if mailbox.id != body.mailbox_id {
            return Err(AppError::BadRequest(
                "This mailbox has changed. Refresh users before trying again.".into(),
            ));
        }
        // Clear recovery before sending a destructive request: even an ambiguous
        // provider result must not leave the former owner's recovery access behind.
        i.storage.forget_mailbox(&email)?;
        let result = i.client.delete_mailbox(mailbox.id).await;
        store.revoke_mailbox(&email, app.imap_host.as_deref().unwrap_or(""));
        result?;
        mailbox.address
    };
    // Revoked sessions also end the user's WebSocket (and its IMAP IDLE
    // watcher) at its next heartbeat. Remove the local cache now; creating
    // the address again wipes it once more.
    wipe_local_data(
        &app.data_dir,
        [email.as_str(), body.email.trim(), provider_address.as_str()],
    )
    .await;
    Ok(Json(json!({"ok":true})))
}

/// Remove per-user cache directories (SQLite cache, drafts, identities, tags,
/// Tantivy index) for each spelling of an address. Logins hash the address as
/// typed, so each distinct spelling has its own directory. Failures are
/// logged, never fatal: open handles on Unix do not prevent removal.
async fn wipe_local_data<'a>(data_dir: &str, addresses: impl IntoIterator<Item = &'a str>) {
    let mut hashes: Vec<String> = addresses
        .into_iter()
        .filter(|a| !a.is_empty())
        .map(crate::auth::user_data::hash_email)
        .collect();
    hashes.sort();
    hashes.dedup();
    let data_dir = data_dir.to_string();
    let removal = tokio::task::spawn_blocking(move || {
        for hash in hashes {
            remove_user_dir(Path::new(&data_dir), &hash);
        }
    });
    if removal.await.is_err() {
        tracing::warn!("FranklyMail could not finish removing local mailbox data");
    }
}
fn remove_user_dir(data_dir: &Path, hash: &str) {
    let dir = data_dir.join(hash);
    // Never follow a symlink out of the data directory.
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            let _ = std::fs::remove_file(&dir);
            return;
        }
        Err(_) => return,
    }
    // Move it aside first so a concurrent login provisions a fresh directory
    // instead of reusing a half-deleted one.
    let suffix = crate::auth::session::SessionStore::generate_token();
    let trash = data_dir.join(format!(".deleted-{hash}-{}", &suffix[..suffix.len().min(16)]));
    let doomed = if std::fs::rename(&dir, &trash).is_ok() {
        trash
    } else {
        dir
    };
    if let Err(error) = std::fs::remove_dir_all(&doomed) {
        tracing::warn!(%error, "FranklyMail could not remove a deleted mailbox's local data");
    }
}

async fn request_reset(
    Extension(i): Extension<Arc<Integration>>,
    Extension(app): Extension<Arc<AppConfig>>,
    Extension(smtp): Extension<Arc<dyn SmtpClient>>,
    Json(body): Json<Target>,
) -> Result<Json<Value>, AppError> {
    recovery_enabled(&i)?;
    // Uniform response and background delivery avoid revealing registered
    // addresses. A bounded number of deliveries run at once; the rest are
    // dropped, which per-mailbox caps would mostly refuse anyway.
    let Ok(permit) = i.recovery_tasks.clone().try_acquire_owned() else {
        tracing::warn!("FranklyMail recovery request dropped: too many in progress");
        return Ok(Json(json!({"ok":true})));
    };
    tokio::spawn(async move {
        let _permit = permit;
        let mut mailbox = String::new();
        let result = async {
            let email = target(&i, &app, &body.email)?;
            mailbox.clone_from(&email);
            let issued = {
                let _lock = i.lock(&email).await;
                match i.storage.recovery(&email)? {
                    Some(destination) => i
                        .storage
                        .issue(&email, &destination, "reset", Origin::Public)?
                        .map(|token| (destination, token)),
                    None => return Ok("no_recovery"),
                }
            };
            let Some((destination, token)) = issued else {
                return Ok("throttled");
            };
            send_link(&i, &app, smtp.as_ref(), &email, &destination, &token, false).await?;
            Ok::<_, AppError>("sent")
        }
        .await;
        match result {
            Ok(outcome) => audit_event("anonymous", "recovery.request", &mailbox, outcome),
            Err(AppError::Forbidden(_) | AppError::BadRequest(_)) => {}
            Err(_) => {
                audit_event("anonymous", "recovery.request", &mailbox, "failed");
                tracing::warn!("FranklyMail recovery request could not be completed");
            }
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
    // Consuming is atomic, so the mailbox lock is not needed for it.
    let token = i.storage.consume(&body.token, "reset")?;
    let result = async {
        let email = target(&i, &app, &token.email)?;
        let _lock = i.lock(&email).await;
        if i.storage.recovery(&email)?.as_deref() != Some(&token.destination) {
            return Err(AppError::Forbidden(
                "Recovery is no longer available for this mailbox".into(),
            ));
        }
        let id = i.client.mailbox(&email).await?;
        // Revoke on ambiguous failures too: the provider may have applied the change.
        let result = i.client.password(id, &body.new_password).await;
        store.revoke_mailbox(&email, app.imap_host.as_deref().unwrap_or(""));
        i.storage.invalidate_tokens(&email)?;
        result?;
        Ok(Json(json!({"ok":true})))
    }
    .await;
    audit("recovery-link", "password.reset", &token.email, &result);
    result
}

#[cfg(test)]
mod tests;
