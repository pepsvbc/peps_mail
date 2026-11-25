mod config;
mod error;
mod db;
mod email_theme;
mod imap;
mod smtp;
mod auth;
mod realtime;
mod routes;
mod search;
mod integrations;

use std::sync::Arc;
use std::time::Duration;

use config::AppConfig;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use crate::auth::session::SessionStore;
use crate::imap::client::RealImapClient;
use crate::smtp::client::RealSmtpClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize structured JSON logging with env filter.
    // Default to INFO level; override with RUST_LOG env var.
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().json())
        .init();

    // Load configuration via figment (serde defaults + env vars).
    let config = Arc::new(AppConfig::load()?);

    if config.environment == "development" {
        tracing::warn!("ENVIRONMENT=development: cookies are not Secure and CORS is permissive; never use this behind a public URL");
    }
    if !config.tls_enabled {
        tracing::warn!("TLS_ENABLED=false: mail passwords are sent to the IMAP/SMTP servers in plaintext");
    }
    if config.allow_any_sender {
        tracing::warn!("ALLOW_ANY_SENDER=true: users can send from any address unless the SMTP server enforces sender ownership");
    }

    // Create the in-memory session store with the configured timeout.
    let store = Arc::new(SessionStore::new(Duration::from_secs(
        config.session_timeout_hours * 3600,
    )));

    // Spawn a background task that periodically purges expired sessions.
    {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            loop {
                interval.tick().await;
                store.purge_expired();
                tracing::debug!("Purged expired sessions");
            }
        });
    }

    // Create the IMAP and SMTP clients for production use.
    let imap_client: Arc<dyn imap::client::ImapClient> = Arc::new(RealImapClient);
    let smtp_client: Arc<dyn smtp::client::SmtpClient> = Arc::new(RealSmtpClient);

    // Create the Tantivy search engine for full-text indexing.
    let search_engine = Arc::new(search::engine::SearchEngine::new(
        std::path::PathBuf::from(&config.data_dir),
    ));

    // Create the real-time event bus and IDLE manager.
    let event_bus = Arc::new(realtime::events::EventBus::new());
    let idle_manager = Arc::new(realtime::idle::IdleManager::new());

    // Build the application router with auth, session, and static file serving.
    let provider_config = integrations::franklymail::config::Config::load()
        .map_err(|_| "Invalid FranklyMail environment configuration")?;
    let provider_routes = integrations::franklymail::router(provider_config, &config)
        .map_err(|e| e.to_string())?;
    let app = routes::create_router_with_integrations(
        config.clone(),
        store,
        imap_client,
        smtp_client,
        search_engine,
        event_bus,
        idle_manager,
        provider_routes,
    );

    // Bind to the configured host and port.
    let bind_addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;

    tracing::info!(
        host = %config.host,
        port = %config.port,
        static_dir = %config.static_dir,
        "PEPS Mail server starting"
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}
