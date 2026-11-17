//! SMTP data types.

/// Parameters needed to establish an SMTP connection.
/// Passed explicitly to every trait method so the trait stays stateless.
#[derive(Clone)]
pub struct SmtpCredentials {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub email: String,
    pub password: String,
}

// Hand-written so a stray `?creds` in a log line never prints the password.
impl std::fmt::Debug for SmtpCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpCredentials")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("tls", &self.tls)
            .field("email", &self.email)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// A message ready to be sent via SMTP.
#[derive(Debug, Clone)]
pub struct SendableMessage {
    /// Sender email address.
    pub from: String,
    /// Primary recipients.
    pub to: Vec<String>,
    /// CC recipients.
    pub cc: Vec<String>,
    /// BCC recipients.
    pub bcc: Vec<String>,
    /// Subject line.
    pub subject: String,
    /// Plain-text body.
    pub text_body: String,
    /// Optional HTML body.
    pub html_body: Option<String>,
    /// In-Reply-To header value for threading.
    pub in_reply_to: Option<String>,
    /// References header value for threading.
    pub references: Option<String>,
    /// File attachments.
    pub attachments: Vec<AttachmentData>,
}

/// A single file attachment to include in an outgoing message.
#[derive(Debug, Clone)]
pub struct AttachmentData {
    /// Filename as it should appear to the recipient.
    pub filename: String,
    /// MIME content type (e.g. "application/pdf").
    pub content_type: String,
    /// Raw file content.
    pub data: Vec<u8>,
    /// Optional Content-ID for inline images (referenced via `cid:` in HTML).
    /// When set, the attachment is treated as an inline image rather than a
    /// regular file attachment.
    pub content_id: Option<String>,
}
