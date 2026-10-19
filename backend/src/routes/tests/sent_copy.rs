use super::*;
use crate::db;

fn folder(name: &str, attributes: &[&str]) -> ImapFolder {
    ImapFolder {
        name: name.to_string(),
        delimiter: Some(".".to_string()),
        attributes: attributes.iter().map(|value| value.to_string()).collect(),
    }
}

async fn send_with_clients(
    data_dir: &TempDir,
    imap: Arc<MockImapClient>,
    smtp: Arc<MockSmtpClient>,
) -> (StatusCode, serde_json::Value) {
    let static_dir = setup_static_dir();
    let config = test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    );
    let store = test_store();
    let (browser_id, account_id, token) = setup_test_account(&store, "alice@example.com");
    let user_hash = crate::auth::user_data::hash_email("alice@example.com");
    provision_user_db(data_dir.path().to_str().unwrap(), &user_hash);
    let app = create_router(
        config,
        store,
        imap,
        smtp,
        test_search_engine(data_dir.path().to_str().unwrap()),
        test_event_bus(),
        test_idle_manager(),
    );
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/messages/send")
        .header("x-requested-with", "XMLHttpRequest")
        .header("content-type", "application/json");
    for (name, value) in auth_headers(&browser_id, &account_id, &token) {
        request = request.header(name, value);
    }
    let response = app
        .oneshot(
            request
                .body(Body::from(
                    r#"{"to":["bob@example.com"],"subject":"Hello","text_body":"Hi Bob"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn sent_copy_uses_special_use_then_legacy_names_and_invalidates_only_that_cache() {
    for (folders, expected) in [
        (
            vec![folder("Sent", &[]), folder("INBOX.Envoyés", &["\\Sent"])],
            "INBOX.Envoyés",
        ),
        (
            vec![folder("Sent", &["\\Noselect"]), folder("INBOX.Sent", &[])],
            "INBOX.Sent",
        ),
        (vec![folder("Sent Items", &[])], "Sent Items"),
        (vec![folder("sent", &[])], "sent"),
    ] {
        let data_dir = TempDir::new().unwrap();
        let user_hash = crate::auth::user_data::hash_email("alice@example.com");
        provision_user_db(data_dir.path().to_str().unwrap(), &user_hash);
        let conn = db::pool::open_user_db(data_dir.path().to_str().unwrap(), &user_hash).unwrap();
        for name in [expected, "INBOX"] {
            db::folders::insert_folder_if_new(&conn, name, None, "").unwrap();
            db::folders::update_folder_status(&conn, name, 1, 0).unwrap();
            assert!(db::folders::is_folder_fresh(&conn, name, 30).unwrap());
        }
        let imap = Arc::new(MockImapClient::new().with_folders(folders));
        let smtp = Arc::new(MockSmtpClient::new());
        let (status, result) = send_with_clients(&data_dir, imap.clone(), smtp.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["sent_copy_saved"], true);
        assert_eq!(smtp.sent_count(), 1);
        assert!(imap.created_folders.lock().unwrap().is_empty());
        let appended = imap.appended.lock().unwrap();
        assert_eq!(appended.len(), 1);
        assert_eq!(appended[0].0, expected);
        let raw = String::from_utf8_lossy(&appended[0].1);
        assert!(raw.contains(result["message_id"].as_str().unwrap()));
        assert!(raw.contains("Hi Bob"));
        assert!(!db::folders::is_folder_fresh(&conn, expected, 30).unwrap());
        assert!(db::folders::is_folder_fresh(&conn, "INBOX", 30).unwrap());
    }
}

#[tokio::test]
async fn sent_copy_creates_missing_sent_folder_and_adds_it_to_the_cache() {
    let data_dir = TempDir::new().unwrap();
    let imap = Arc::new(MockImapClient::new().with_folders(vec![folder("INBOX", &[])]));
    let smtp = Arc::new(MockSmtpClient::new());
    let (status, result) = send_with_clients(&data_dir, imap.clone(), smtp).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["sent_copy_saved"], true);
    assert_eq!(*imap.created_folders.lock().unwrap(), vec!["Sent"]);
    assert_eq!(imap.appended.lock().unwrap()[0].0, "Sent");
    let user_hash = crate::auth::user_data::hash_email("alice@example.com");
    let conn = db::pool::open_user_db(data_dir.path().to_str().unwrap(), &user_hash).unwrap();
    assert!(db::folders::get_folder(&conn, "Sent").unwrap().is_some());
    assert!(!db::folders::is_folder_fresh(&conn, "Sent", 30).unwrap());
}

#[tokio::test]
async fn sent_copy_failure_reports_delivery_success_without_resending() {
    for imap in [
        MockImapClient::new()
            .with_folders(vec![folder("Sent", &[])])
            .with_append_error(ImapError::ProtocolError("APPEND rejected".to_string())),
        MockImapClient::new().with_error(ImapError::ConnectionFailed("unavailable".to_string())),
    ] {
        let data_dir = TempDir::new().unwrap();
        let imap = Arc::new(imap);
        let smtp = Arc::new(MockSmtpClient::new());
        let (status, result) = send_with_clients(&data_dir, imap.clone(), smtp.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["status"], "sent");
        assert_eq!(result["sent_copy_saved"], false);
        assert_eq!(smtp.sent_count(), 1);
        assert!(imap.appended.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn sent_copy_is_not_created_when_smtp_rejects_the_message() {
    let data_dir = TempDir::new().unwrap();
    let imap = Arc::new(MockImapClient::new());
    let smtp =
        Arc::new(MockSmtpClient::new().with_error(SmtpError::SendFailed("rejected".to_string())));
    let (status, _) = send_with_clients(&data_dir, imap.clone(), smtp).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(imap.appended.lock().unwrap().is_empty());
    assert!(imap.created_folders.lock().unwrap().is_empty());
}
