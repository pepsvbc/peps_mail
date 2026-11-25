//! Paired HTML/plain-text templates used by SMTP's multipart/alternative builder.
use super::config::Config;
use crate::error::AppError;

pub struct EmailTemplate {
    text: String,
    html: String,
}

fn load(path: &str, default: &str) -> Result<String, AppError> {
    let content = if path.is_empty() {
        default.into()
    } else {
        std::fs::read_to_string(path)
            .map_err(|_| AppError::InternalError("Cannot read FranklyMail email template".into()))?
    };
    if !content.contains("{{link}}") {
        return Err(AppError::InternalError(
            "Each FranklyMail email template must contain {{link}}".into(),
        ));
    }
    Ok(content)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

impl EmailTemplate {
    pub fn welcome(config: &Config) -> Result<Self, AppError> {
        Ok(Self {
            text: load(
                &config.welcome_template_path,
                include_str!("templates/welcome.txt"),
            )?,
            html: load(
                &config.welcome_html_template_path,
                include_str!("templates/welcome.html"),
            )?,
        })
    }

    pub fn reset(config: &Config) -> Result<Self, AppError> {
        Ok(Self {
            text: load(
                &config.reset_template_path,
                include_str!("templates/reset.txt"),
            )?,
            html: load(
                &config.reset_html_template_path,
                include_str!("templates/reset.html"),
            )?,
        })
    }

    pub fn render(&self, mailbox: &str, link: &str) -> (String, String) {
        let text = self
            .text
            .replace("{{mailbox}}", mailbox)
            .replace("{{link}}", link);
        let html = self
            .html
            .replace("{{mailbox}}", &escape_html(mailbox))
            .replace("{{link}}", &escape_html(link));
        (text, html)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_templates_have_a_button_visible_url_and_matching_plain_text() {
        let config = Config::default();
        for template in [
            EmailTemplate::welcome(&config).unwrap(),
            EmailTemplate::reset(&config).unwrap(),
        ] {
            let link = "https://mail.example.com/franklymail-recovery#token=example-token";
            let (text, html) = template.render("member@example.com", link);
            assert!(text.contains(link));
            assert_eq!(html.matches(&format!("href=\"{link}\"")).count(), 2);
            assert!(html.contains(&format!(">{link}</a>")));
            assert!(html.contains("bgcolor=\"#2457d6\""));
            assert!(text.contains("member@example.com"));
            assert!(html.contains("member@example.com"));
            assert!(!html.contains("{{"));
        }
    }

    #[test]
    fn html_substitutions_are_escaped_without_changing_plain_text() {
        let template = EmailTemplate::reset(&Config::default()).unwrap();
        let (text, html) = template.render(
            "a&b@example.com",
            "https://example.com/a?x=1&y=\"quoted\"#token=x",
        );
        assert!(text.contains("a&b@example.com"));
        assert!(html.contains("a&amp;b@example.com"));
        assert!(html.contains("x=1&amp;y=&quot;quoted&quot;#token=x"));
        assert!(!html.contains("y=\"quoted\""));
    }

    #[test]
    fn custom_html_and_text_paths_are_independent_and_require_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("welcome.html");
        std::fs::write(
            &path,
            "<p>Custom {{mailbox}} <a href=\"{{link}}\">Open</a></p>",
        )
        .unwrap();
        let config = Config {
            welcome_html_template_path: path.to_str().unwrap().into(),
            ..Default::default()
        };
        let (text, html) = EmailTemplate::welcome(&config)
            .unwrap()
            .render("a@example.com", "https://example.com/reset");
        assert!(text.starts_with("Welcome!"));
        assert!(html.starts_with("<p>Custom a@example.com"));
        std::fs::write(path, "<p>Missing link</p>").unwrap();
        assert!(EmailTemplate::welcome(&config).is_err());
    }
}
