use figment::{Figment, providers::Env};
use serde::Deserialize;

/// Deliberately neither Debug nor Serialize: credentials never enter API responses/logs.
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    pub enabled: bool,
    pub api_key: String,
    pub domains: String,
    pub public_url: String,
    pub mail_from: String,
    pub smtp_username: String,
    pub smtp_password: String,
    pub welcome_template_path: String,
    pub reset_template_path: String,
    pub welcome_html_template_path: String,
    pub reset_html_template_path: String,
    /// FRANKLYMAIL_ADMIN_EMAILS: comma-separated mailboxes allowed to administer
    /// FranklyMail. Deliberately separate from ADMIN_EMAILS (distribution lists).
    pub admin_emails: String,
}

impl Config {
    #[allow(clippy::result_large_err)]
    pub fn load() -> Result<Self, figment::Error> {
        Figment::new()
            .merge(Env::prefixed("FRANKLYMAIL_"))
            .extract()
    }

    pub fn validate(&self, app: &crate::config::AppConfig) -> Result<(), &'static str> {
        if !self.enabled {
            return Ok(());
        }
        if self.api_key.trim().is_empty()
            || app
                .imap_host
                .as_deref()
                .is_none_or(|host| host.trim().is_empty())
            || self.domains.trim().is_empty()
        {
            return Err(
                "FranklyMail requires FRANKLYMAIL_API_KEY, FRANKLYMAIL_DOMAINS and the shared IMAP_HOST",
            );
        }
        let recovery_fields = [
            &self.public_url,
            &self.mail_from,
            &self.smtp_username,
            &self.smtp_password,
        ];
        if recovery_fields.iter().any(|v| !v.is_empty()) {
            if recovery_fields.iter().any(|v| v.is_empty()) {
                return Err(
                    "FranklyMail recovery requires PUBLIC_URL, MAIL_FROM, SMTP_USERNAME, SMTP_PASSWORD",
                );
            }
            if app
                .smtp_host
                .as_deref()
                .is_none_or(|host| host.trim().is_empty())
                || !app.tls_enabled
            {
                return Err(
                    "FranklyMail email delivery requires the shared SMTP_HOST and TLS_ENABLED=true",
                );
            }
            let url = reqwest::Url::parse(&self.public_url)
                .map_err(|_| "Invalid FranklyMail PUBLIC_URL")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(
                    "FranklyMail PUBLIC_URL must be an HTTPS application URL without credentials, query or fragment",
                );
            }
            super::sieve::email(&self.mail_from).map_err(|_| "Invalid FranklyMail MAIL_FROM")?;
        }
        Ok(())
    }

    pub fn recovery_enabled(&self) -> bool {
        self.enabled && !self.public_url.is_empty()
    }

    /// Exact, case-insensitive match against FRANKLYMAIL_ADMIN_EMAILS. Empty
    /// means nobody administers FranklyMail; there is no ADMIN_EMAILS fallback.
    pub fn is_admin(&self, email: &str) -> bool {
        let email = email.trim();
        self.enabled
            && !email.is_empty()
            && self
                .admin_emails
                .split(',')
                .map(str::trim)
                .any(|admin| !admin.is_empty() && admin.eq_ignore_ascii_case(email))
    }

    pub fn has_admins(&self) -> bool {
        self.admin_emails.split(',').any(|a| !a.trim().is_empty())
    }

    pub fn allows(&self, email: &str) -> bool {
        self.enabled
            && email.rsplit_once('@').is_some_and(|(_, domain)| {
                self.domains
                    .split(',')
                    .any(|d| d.trim().eq_ignore_ascii_case(domain))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_list_is_exact_case_insensitive_and_has_no_fallback() {
        let config = Config {
            enabled: true,
            admin_emails: " Boss@Example.com , ,ops@example.com".into(),
            ..Default::default()
        };
        assert!(config.has_admins());
        assert!(config.is_admin("boss@example.com"));
        assert!(config.is_admin(" OPS@example.com "));
        assert!(!config.is_admin("boss@example.com.evil.org"));
        assert!(!config.is_admin("xboss@example.com"));
        assert!(!config.is_admin(""));
        let unset = Config {
            enabled: true,
            ..Default::default()
        };
        assert!(!unset.has_admins());
        assert!(!unset.is_admin("boss@example.com"));
        let disabled = Config {
            enabled: false,
            ..config
        };
        assert!(!disabled.is_admin("boss@example.com"));
    }
}
