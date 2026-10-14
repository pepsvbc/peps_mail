use super::{
    connection::{connect, map_imap_error},
    error::ImapError,
    types::ImapCredentials,
};
use futures::StreamExt;
use mail_parser::MimeHeaders;

/// Read a bounded message prefix with PEEK, without marking it read.
pub async fn fetch(
    creds: &ImapCredentials,
    folder: &str,
    uids: &[u32],
) -> Result<Vec<(u32, String)>, ImapError> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let mut session = connect(creds).await?;
    session.select(folder).await.map_err(map_imap_error)?;
    let set = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut previews = Vec::new();
    {
        let mut stream = session
            .uid_fetch(set, "(UID BODY.PEEK[]<0.16384>)")
            .await
            .map_err(map_imap_error)?;
        while let Some(result) = stream.next().await {
            let message = result.map_err(map_imap_error)?;
            if let Some(uid) = message.uid {
                previews.push((uid, message.body().map(snippet).unwrap_or_default()));
            }
        }
    }
    let _ = session.logout().await;
    Ok(previews)
}

fn snippet(raw: &[u8]) -> String {
    let Some(message) = mail_parser::MessageParser::default().parse(raw) else {
        return String::new();
    };
    if let Some(text) = message.body_text(0).filter(|text| !text.trim().is_empty()) {
        return shorten(&text);
    }
    // A partial FETCH can end before the MIME boundary closing the first text
    // part. Complete only the local parsing buffer; never fetch the attachment.
    let mut completed = raw.to_vec();
    for part in message.parts.iter().rev() {
        if let Some(boundary) = part
            .content_type()
            .and_then(|content_type| content_type.attribute("boundary"))
        {
            completed.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        }
    }
    mail_parser::MessageParser::default()
        .parse(&completed)
        .and_then(|parsed| parsed.body_text(0).map(|text| shorten(&text)))
        .unwrap_or_default()
}

fn shorten(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fetches_bounded_peek_previews_in_one_batch() {
        use tokio::{
            io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            writer.write_all(b"* OK Ready\r\n").await.unwrap();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let (tag, command) = line.trim_end().split_once(' ').unwrap();
                let reply = if command.starts_with("LOGIN ") {
                    format!("{tag} OK Logged in\r\n")
                } else if command.starts_with("SELECT ") {
                    format!("* 1 EXISTS\r\n* OK [UIDVALIDITY 42] Stable\r\n{tag} OK Selected\r\n")
                } else if command.starts_with("UID FETCH ") {
                    assert_eq!(command, "UID FETCH 7 (UID BODY.PEEK[]<0.16384>)");
                    let raw = "Content-Type: text/plain\r\n\r\nThe opening of this email";
                    format!(
                        "* 1 FETCH (UID 7 BODY[]<0> {{{}}}\r\n{raw})\r\n{tag} OK Fetched\r\n",
                        raw.len()
                    )
                } else {
                    assert_eq!(command, "LOGOUT");
                    format!("* BYE Closing\r\n{tag} OK Logout\r\n")
                };
                writer.write_all(reply.as_bytes()).await.unwrap();
                if command == "LOGOUT" {
                    break;
                }
            }
        });
        let creds = ImapCredentials {
            host: "127.0.0.1".into(),
            port,
            tls: false,
            email: "test@example.com".into(),
            password: "test".into(),
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fetch(&creds, "INBOX", &[7]),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, vec![(7, "The opening of this email".into())]);
        task.await.unwrap();
    }

    #[test]
    fn decodes_plain_html_and_mime_text_without_displaying_markup() {
        assert_eq!(snippet(b"Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello=20team!\r\n Next week"), "Hello team! Next week");
        assert_eq!(
            snippet(b"Content-Type: text/html\r\n\r\n<p>Hello <b>team</b>!</p>"),
            "Hello team!"
        );
        assert_eq!(snippet(b"Content-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBeginning of the email\r\n--x--"), "Beginning of the email");
    }

    #[test]
    fn extracts_text_from_a_truncated_multipart_prefix() {
        let raw = b"Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gdGVhbSE=";
        assert_eq!(snippet(raw), "Hello team!");
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode("Hello team! ".repeat(3000));
        let raw = format!(
            "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n--x--"
        );
        assert!(snippet(&raw.as_bytes()[..16384]).starts_with("Hello team!"));
    }

    #[test]
    fn limits_preview_length_without_splitting_unicode() {
        let raw = format!(
            "Content-Type: text/plain; charset=utf-8\r\n\r\n{}",
            "é".repeat(300)
        );
        assert_eq!(snippet(raw.as_bytes()), "é".repeat(240));
    }
}
