use figment::{Figment, providers::Env};
use serde::Deserialize;

/// Application configuration loaded via figment.
///
/// Layers (lowest to highest priority):
///   1. Serde defaults
///   2. Environment variables (flat, e.g. `PORT`, `IMAP_HOST`)
#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct AppConfig {
    /// Bind address for the HTTP server.
    #[serde(default = "default_host")]
    pub host: String,

    /// Port for the HTTP server.
    #[serde(default = "default_port")]
    pub port: u16,

    /// IMAP server hostname. Required in production.
    #[serde(default)]
    pub imap_host: Option<String>,

    /// IMAP server port.
    #[serde(default = "default_imap_port")]
    pub imap_port: u16,

    /// SMTP server hostname. Required in production.
    #[serde(default)]
    pub smtp_host: Option<String>,

    /// SMTP server port.
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,

    /// Whether TLS is enabled for mail connections.
    #[serde(default = "default_tls_enabled")]
    pub tls_enabled: bool,

    /// Directory for persistent data storage.
    #[serde(default = "default_data_dir")]
    pub data_dir: String,

    /// Session timeout in hours.
    #[serde(default = "default_session_timeout_hours")]
    pub session_timeout_hours: u64,

    /// Directory to serve static frontend files from.
    #[serde(default = "default_static_dir")]
    pub static_dir: String,

    /// Environment the application is running in (development, production).
    /// Anything other than `development` enables Secure cookies, HSTS and
    /// disables permissive CORS, so the default fails safe.
    #[serde(default = "default_environment")]
    pub environment: String,

    /// Optional base path prefix (e.g. "/mail") for serving behind a reverse proxy subpath.
    #[serde(default)]
    pub base_path: Option<String>,

    /// Comma-separated IPs or CIDR ranges of reverse proxies whose
    /// `X-Forwarded-For` header is trusted for the login rate limiter.
    #[serde(default)]
    pub trusted_proxies: Option<String>,

    /// Allow sender identities with any email address. Only enable this when
    /// the SMTP server itself rejects From addresses the login does not own.
    #[serde(default)]
    pub allow_any_sender: bool,

    /// Comma-separated email domains allowed to sign in (e.g.
    /// `pepsvbc.ch,pepsvolley.ch`). Empty allows any mailbox the IMAP server
    /// accepts — on a shared provider that means other customers too.
    #[serde(default)]
    pub allowed_email_domains: Option<String>,

    /// Domain appended to short login names. Otherwise use the sole allowed domain.
    #[serde(default)]
    pub login_default_domain: Option<String>,

    /// Comma-separated admin email addresses (e.g. may manage shared lists).
    #[serde(default)]
    pub admin_emails: Option<String>,
}

/// Split a comma-separated setting into trimmed, lower-cased, non-empty items.
fn csv_items(value: Option<&str>) -> impl Iterator<Item = String> + '_ {
    value
        .unwrap_or_default()
        .split(',')
        .map(|item| item.trim().to_ascii_lowercase())
        .filter(|item| !item.is_empty())
}

fn default_host() -> String {
    "0.0.0.0".to_string()
}

fn default_port() -> u16 {
    3001
}

fn default_imap_port() -> u16 {
    993
}

fn default_smtp_port() -> u16 {
    587
}

fn default_tls_enabled() -> bool {
    true
}

fn default_data_dir() -> String {
    "/data".to_string()
}

fn default_session_timeout_hours() -> u64 {
    24
}

fn default_static_dir() -> String {
    "./static".to_string()
}

fn default_environment() -> String {
    "production".to_string()
}

impl AppConfig {
    pub fn login_domain(&self) -> Option<String> {
        let domain = match self
            .login_default_domain
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(domain) => domain.to_ascii_lowercase(),
            None => {
                let domains: std::collections::BTreeSet<_> =
                    csv_items(self.allowed_email_domains.as_deref()).collect();
                if domains.len() != 1 {
                    return None;
                }
                domains.into_iter().next()?
            }
        };
        let probe = format!("login@{domain}");
        if domain.contains('@')
            || domain.chars().any(char::is_whitespace)
            || probe.parse::<lettre::Address>().is_err()
            || !self.is_email_domain_allowed(&probe)
        {
            return None;
        }
        Some(domain)
    }

    /// Load configuration by layering serde defaults with environment variables.
    ///
    /// Environment variables are read without a prefix and mapped directly to
    /// struct fields via case-insensitive matching (e.g. `IMAP_HOST` → `imap_host`).
    #[allow(clippy::result_large_err)]
    pub fn load() -> Result<Self, figment::Error> {
        Figment::new().merge(Env::raw()).extract()
    }

    /// Whether `email` may sign in under `ALLOWED_EMAIL_DOMAINS` (exact domain
    /// match, case-insensitive; no restriction when the setting is empty).
    pub fn is_email_domain_allowed(&self, email: &str) -> bool {
        let mut domains = csv_items(self.allowed_email_domains.as_deref()).peekable();
        if domains.peek().is_none() {
            return true;
        }
        let Some((_, domain)) = email.trim().rsplit_once('@') else {
            return false;
        };
        let domain = domain.to_ascii_lowercase();
        domains.any(|allowed| allowed == domain)
    }

    /// Whether `email` is listed in `ADMIN_EMAILS` (case-insensitive).
    pub fn is_admin(&self, email: &str) -> bool {
        let email = email.trim().to_ascii_lowercase();
        csv_items(self.admin_emails.as_deref()).any(|admin| admin == email)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_values_load_correctly() {
        // With no env vars set, all defaults should apply.
        // We use figment with no providers (only serde defaults).
        let config: AppConfig = Figment::new().extract().expect("defaults should load");

        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 3001);
        assert!(config.imap_host.is_none());
        assert_eq!(config.imap_port, 993);
        assert!(config.smtp_host.is_none());
        assert_eq!(config.smtp_port, 587);
        assert!(config.tls_enabled);
        assert_eq!(config.data_dir, "/data");
        assert_eq!(config.session_timeout_hours, 24);
        assert_eq!(config.static_dir, "./static");
        assert_eq!(config.environment, "production");
        assert!(config.trusted_proxies.is_none());
        assert!(!config.allow_any_sender);
        assert!(config.is_email_domain_allowed("anyone@anywhere.example"));
        assert!(!config.is_admin("anyone@anywhere.example"));
    }

    #[test]
    fn email_domain_and_admin_checks() {
        let config: AppConfig = Figment::new()
            .merge(("allowed_email_domains", " PEPSvbc.ch, pepsvolley.ch ,"))
            .merge(("admin_emails", "Coach@pepsvbc.ch"))
            .extract()
            .unwrap();

        assert!(config.is_email_domain_allowed("anna@pepsvbc.ch"));
        assert!(config.is_email_domain_allowed("Ben@PEPSVOLLEY.CH"));
        assert!(!config.is_email_domain_allowed("eve@franklymail.com"));
        assert!(!config.is_email_domain_allowed("eve@evil.pepsvbc.ch"));
        assert!(!config.is_email_domain_allowed("eve@pepsvbc.ch.evil.com"));
        assert!(!config.is_email_domain_allowed("no-at-sign"));

        assert!(config.is_admin(" coach@PEPSVBC.ch "));
        assert!(!config.is_admin("anna@pepsvbc.ch"));
    }

    #[test]
    fn env_var_overrides_work() {
        // Simulate env overrides via figment's tuple provider
        // to verify all fields are overridable.
        let config: AppConfig = Figment::new()
            .merge(("host", "127.0.0.1"))
            .merge(("port", 8080u16))
            .merge(("imap_host", "mail.example.com"))
            .merge(("imap_port", 143u16))
            .merge(("smtp_host", "smtp.example.com"))
            .merge(("smtp_port", 465u16))
            .merge(("tls_enabled", false))
            .merge(("data_dir", "/var/peps-mail"))
            .merge(("session_timeout_hours", 48u64))
            .merge(("static_dir", "/srv/static"))
            .merge(("environment", "production"))
            .extract()
            .expect("overrides should load");

        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 8080);
        assert_eq!(config.imap_host.as_deref(), Some("mail.example.com"));
        assert_eq!(config.imap_port, 143);
        assert_eq!(config.smtp_host.as_deref(), Some("smtp.example.com"));
        assert_eq!(config.smtp_port, 465);
        assert!(!config.tls_enabled);
        assert_eq!(config.data_dir, "/var/peps-mail");
        assert_eq!(config.session_timeout_hours, 48);
        assert_eq!(config.static_dir, "/srv/static");
        assert_eq!(config.environment, "production");
    }

    #[test]
    fn real_env_vars_override_multi_word_fields() {
        // Verify that actual environment variables with underscores
        // (e.g. IMAP_HOST) correctly map to struct fields (imap_host).
        // SAFETY: This test runs single-threaded (--test-threads=1)
        // and cleans up env vars after use.
        unsafe {
            std::env::set_var("IMAP_HOST", "test-imap.example.com");
            std::env::set_var("DATA_DIR", "/tmp/peps-mail-test");
        }

        let config = AppConfig::load().expect("load with env vars should succeed");

        assert_eq!(config.imap_host.as_deref(), Some("test-imap.example.com"));
        assert_eq!(config.data_dir, "/tmp/peps-mail-test");

        // Clean up
        unsafe {
            std::env::remove_var("IMAP_HOST");
            std::env::remove_var("DATA_DIR");
        }
    }
}
