use std::sync::Arc;

use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Serialize;

use crate::config::AppConfig;
use crate::error::AppError;

#[derive(Serialize)]
pub struct MailServerSettings {
    host: String,
    port: u16,
    security: &'static str,
}

#[derive(Serialize)]
pub struct SetupSettings {
    imap: MailServerSettings,
    smtp: MailServerSettings,
    apple_profile_url: String,
}

fn unavailable() -> AppError {
    AppError::ServiceUnavailable("Secure mail setup is not configured on this server.".to_string())
}

fn configured_host(host: Option<&str>) -> Result<String, AppError> {
    let host = host.map(str::trim).filter(|host| !host.is_empty());
    match host {
        Some(host)
            if !host.chars().any(|character| {
                character.is_control() || matches!(character, '\u{fffe}' | '\u{ffff}')
            }) =>
        {
            Ok(host.to_string())
        }
        _ => Err(unavailable()),
    }
}

fn settings(config: &AppConfig) -> Result<SetupSettings, AppError> {
    if !config.tls_enabled || config.imap_port == 0 || config.smtp_port == 0 {
        return Err(unavailable());
    }

    Ok(SetupSettings {
        imap: MailServerSettings {
            host: configured_host(config.imap_host.as_deref())?,
            port: config.imap_port,
            security: "SSL/TLS",
        },
        smtp: MailServerSettings {
            host: configured_host(config.smtp_host.as_deref())?,
            port: config.smtp_port,
            security: if config.smtp_port == 587 {
                "STARTTLS"
            } else {
                "SSL/TLS"
            },
        },
        apple_profile_url: format!(
            "{}/api/setup/apple.mobileconfig",
            config
                .base_path
                .as_deref()
                .unwrap_or("")
                .trim_end_matches('/')
        ),
    })
}

/// Public connection details only; no account or server-internal configuration.
pub async fn get_setup(
    Extension(config): Extension<Arc<AppConfig>>,
) -> Result<impl IntoResponse, AppError> {
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(settings(&config)?),
    ))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// A mail-only profile. Apple prompts for the omitted email address, usernames,
/// and password during installation; no credentials pass through this endpoint.
pub async fn download_apple_profile(
    Extension(config): Extension<Arc<AppConfig>>,
) -> Result<Response, AppError> {
    let settings = settings(&config)?;
    let imap_host = xml_escape(&settings.imap.host);
    let smtp_host = xml_escape(&settings.smtp.host);
    let imap_port = settings.imap.port;
    let smtp_port = settings.smtp.port;
    // Distinct identifiers let someone install more than one mailbox profile.
    let profile_uuid = uuid::Uuid::new_v4();
    let account_uuid = uuid::Uuid::new_v4();

    let profile = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadType</key><string>Configuration</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>PayloadIdentifier</key><string>ch.pepsvbc.mail.{profile_uuid}</string>
    <key>PayloadUUID</key><string>{profile_uuid}</string>
    <key>PayloadDisplayName</key><string>PEPS VBC Mail</string>
    <key>PayloadDescription</key><string>Add your PEPS VBC email account to Mail.</string>
    <key>PayloadOrganization</key><string>PEPS VBC</string>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key><string>com.apple.mail.managed</string>
            <key>PayloadVersion</key><integer>1</integer>
            <key>PayloadIdentifier</key><string>ch.pepsvbc.mail.account.{account_uuid}</string>
            <key>PayloadUUID</key><string>{account_uuid}</string>
            <key>PayloadDisplayName</key><string>PEPS VBC Mail</string>
            <key>EmailAccountDescription</key><string>PEPS VBC Mail</string>
            <key>EmailAccountType</key><string>EmailTypeIMAP</string>
            <key>IncomingMailServerHostName</key><string>{imap_host}</string>
            <key>IncomingMailServerPortNumber</key><integer>{imap_port}</integer>
            <key>IncomingMailServerAuthentication</key><string>EmailAuthPassword</string>
            <key>IncomingMailServerUseSSL</key><true/>
            <key>OutgoingMailServerHostName</key><string>{smtp_host}</string>
            <key>OutgoingMailServerPortNumber</key><integer>{smtp_port}</integer>
            <key>OutgoingMailServerAuthentication</key><string>EmailAuthPassword</string>
            <key>OutgoingMailServerUseSSL</key><true/>
            <key>OutgoingPasswordSameAsIncomingPassword</key><true/>
        </dict>
    </array>
</dict>
</plist>
"#
    );

    Ok((
        [
            (header::CONTENT_TYPE, "application/x-apple-aspen-config"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"peps-vbc-mail.mobileconfig\"",
            ),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        profile,
    )
        .into_response())
}
