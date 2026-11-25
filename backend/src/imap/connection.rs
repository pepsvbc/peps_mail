use std::time::Duration;

use super::error::ImapError;
use super::types::ImapCredentials;

// ---- Timeouts ---------------------------------------------------------------

/// Budget for the TCP connect to the IMAP server.
pub(crate) const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Budget for the TLS handshake once TCP is up.
pub(crate) const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Budget for the server greeting plus LOGIN.
pub(crate) const LOGIN_TIMEOUT: Duration = Duration::from_secs(20);

// ---- Mailbox name helpers ---------------------------------------------------

/// Reject mailbox names that could break out of an IMAP command line.
///
/// async-imap quotes most mailbox arguments, but some commands (SUBSCRIBE,
/// RENAME, APPEND) do not reject CR/LF and UID COPY does not quote at all,
/// so a name containing a line break would let a caller inject raw IMAP
/// commands. Every mailbox argument goes through this check first.
pub(crate) fn validate_mailbox(name: &str) -> Result<(), ImapError> {
    if name.contains(['\r', '\n', '\0']) {
        return Err(ImapError::ProtocolError(
            "Mailbox name contains a line break or NUL character".to_string(),
        ));
    }
    Ok(())
}

/// Escape a mailbox name for use inside an IMAP quoted string, without the
/// surrounding quotes. Callers must run [`validate_mailbox`] first.
pub(crate) fn escape_quoted(name: &str) -> String {
    name.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Render a mailbox name as a complete IMAP quoted string.
pub(crate) fn quote_mailbox(name: &str) -> Result<String, ImapError> {
    validate_mailbox(name)?;
    Ok(format!("\"{}\"", escape_quoted(name)))
}

// ---- Connection helper ----------------------------------------------------

/// Establish an authenticated IMAP session.
///
/// Returns a `Session` over a TLS stream (when `creds.tls` is true) or a
/// plain TCP stream.  Because the two stream types are different concrete
/// types we use an enum wrapper that implements the traits `async-imap`
/// requires (`tokio::io::AsyncRead + AsyncWrite + Unpin + Debug`).
///
/// Each step (TCP connect, TLS handshake, LOGIN) has its own timeout so a
/// stalled server can't pin a task forever. Commands run afterwards are
/// bounded by the caller: the IDLE manager reuses this function and keeps
/// its session open for a long time on purpose.
pub(crate) async fn connect(
    creds: &ImapCredentials,
) -> Result<async_imap::Session<ImapStream>, ImapError> {
    connect_with_timeouts(creds, TLS_HANDSHAKE_TIMEOUT, LOGIN_TIMEOUT).await
}

async fn connect_with_timeouts(
    creds: &ImapCredentials,
    tls_timeout: Duration,
    login_timeout: Duration,
) -> Result<async_imap::Session<ImapStream>, ImapError> {
    let connect_future = tokio::net::TcpStream::connect((creds.host.as_str(), creds.port));
    let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, connect_future)
        .await
        .map_err(|_| ImapError::ConnectionFailed("connection timed out".to_string()))?
        .map_err(|e| ImapError::ConnectionFailed(e.to_string()))?;

    let stream = if creds.tls {
        let tls = async_native_tls::TlsConnector::new();
        let tls_stream =
            tokio::time::timeout(tls_timeout, tls.connect(&creds.host, tcp))
                .await
                .map_err(|_| ImapError::ConnectionFailed("TLS handshake timed out".to_string()))?
                .map_err(|e| ImapError::ConnectionFailed(e.to_string()))?;
        ImapStream::Tls(tls_stream)
    } else {
        ImapStream::Plain(tcp)
    };

    let client = async_imap::Client::new(stream);
    let session = tokio::time::timeout(login_timeout, client.login(&creds.email, &creds.password))
        .await
        .map_err(|_| ImapError::ConnectionFailed("login timed out".to_string()))?
        .map_err(|(e, _)| classify_login_error(e));
    // Let the auth guard sign out sessions whose saved password stopped working.
    match &session {
        Ok(_) => super::rejected::forget(&creds.host, creds.port, &creds.email, &creds.password),
        Err(ImapError::AuthenticationFailed) => {
            super::rejected::record(&creds.host, creds.port, &creds.email, &creds.password)
        }
        Err(_) => {}
    }
    session
}

/// Classify an `async_imap::error::Error` that occurred during LOGIN.
pub(crate) fn classify_login_error(err: async_imap::error::Error) -> ImapError {
    match err {
        async_imap::error::Error::No(_) => ImapError::AuthenticationFailed,
        async_imap::error::Error::Io(e) => ImapError::ConnectionFailed(e.to_string()),
        async_imap::error::Error::ConnectionLost => {
            ImapError::ConnectionFailed("connection lost".to_string())
        }
        other => ImapError::ProtocolError(other.to_string()),
    }
}

/// Map a generic `async_imap` error to our `ImapError`.
pub(crate) fn map_imap_error(err: async_imap::error::Error) -> ImapError {
    match err {
        async_imap::error::Error::No(msg) => ImapError::ProtocolError(format!("NO: {msg}")),
        async_imap::error::Error::Io(e) => ImapError::ConnectionFailed(e.to_string()),
        async_imap::error::Error::ConnectionLost => {
            ImapError::ConnectionFailed("connection lost".to_string())
        }
        other => ImapError::ProtocolError(other.to_string()),
    }
}

// ---- Stream enum ----------------------------------------------------------

/// A wrapper enum so that `Session` can be generic over a single type
/// regardless of whether TLS is used.
#[derive(Debug)]
pub(crate) enum ImapStream {
    Tls(async_native_tls::TlsStream<tokio::net::TcpStream>),
    Plain(tokio::net::TcpStream),
}

impl tokio::io::AsyncRead for ImapStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for ImapStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_flush(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailbox_names_with_line_breaks_are_rejected() {
        for bad in ["a\r\nb", "a\nb", "a\rb", "a\0b", "INBOX\r\nA1 LOGOUT"] {
            assert!(validate_mailbox(bad).is_err(), "{bad:?} should be rejected");
            assert!(quote_mailbox(bad).is_err());
        }
        assert!(validate_mailbox("Projects/2024 Q1").is_ok());
    }

    #[test]
    fn mailbox_names_are_quoted_and_escaped() {
        assert_eq!(quote_mailbox("My Folder").unwrap(), "\"My Folder\"");
        assert_eq!(quote_mailbox(r#"a"b\c"#).unwrap(), r#""a\"b\\c""#);
    }

    #[tokio::test]
    async fn stalled_server_times_out_during_login() {
        // A server that accepts TCP but never answers LOGIN.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let creds = ImapCredentials {
            host: "127.0.0.1".into(),
            port,
            tls: false,
            email: "a@example.com".into(),
            password: "p".into(),
        };
        let short = Duration::from_millis(200);
        let result = connect_with_timeouts(&creds, short, short).await;
        assert!(matches!(result, Err(ImapError::ConnectionFailed(ref m)) if m.contains("timed out")));
        task.abort();
    }
}
