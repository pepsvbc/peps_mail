use super::*;

struct Fixture {
    _static_dir: TempDir,
    app: Router,
    store: Arc<SessionStore>,
    imap: Arc<MockImapClient>,
}

impl Fixture {
    fn new(imap: MockImapClient) -> Self {
        let static_dir = setup_static_dir();
        // The configured host is deliberately absent: counts must use each
        // account's connection settings, without depending on a local cache.
        let config = test_config(static_dir.path().to_str().unwrap());
        let store = test_store();
        let imap = Arc::new(imap);
        let app = create_router(
            config,
            store.clone(),
            imap.clone(),
            test_smtp_client(),
            test_search_engine(static_dir.path().to_str().unwrap()),
            test_event_bus(),
            test_idle_manager(),
        );
        Self {
            _static_dir: static_dir,
            app,
            store,
            imap,
        }
    }

    async fn get(&self, headers: &[(&str, String)]) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder().uri("/api/account/unread");
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
}

fn with_unread(unread: u32) -> MockImapClient {
    MockImapClient::new().with_unread_count(unread)
}

#[tokio::test]
async fn account_unread_reads_authoritative_inbox_count_without_a_message_cache() {
    for unread in [0, 42] {
        let fixture = Fixture::new(with_unread(unread));
        let (browser, account, token) = setup_test_account(&fixture.store, "alice@example.com");
        let (status, body) = fixture.get(&auth_headers(&browser, &account, &token)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "inbox_unread_count": unread }));
        let calls = fixture.imap.unread_count_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, "INBOX");
        // Counting must not call the extended STATUS method, which requests
        // HIGHESTMODSEQ and can fail on servers without CONDSTORE.
        assert!(fixture.imap.folder_status_calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn account_unread_uses_the_requested_accounts_own_credentials() {
    let fixture = Fixture::new(with_unread(3));
    let browser = fixture.store.create_browser();
    let mut account_tokens = Vec::new();
    for (email, password, host, port, tls) in [
        (
            "alice@example.com",
            "alice-password",
            "alice-imap.example.com",
            993,
            true,
        ),
        (
            "bob@example.com",
            "bob-password",
            "bob-imap.example.com",
            143,
            false,
        ),
    ] {
        let (token, account) = fixture.store.add_account_to_browser(
            &browser,
            email.to_string(),
            password.to_string(),
            crate::auth::user_data::hash_email(email),
            host.to_string(),
            port,
            tls,
            "smtp.example.com".to_string(),
            587,
            true,
        );
        account_tokens.push((account, token, email, password, host, port, tls));
    }
    let cookies = format!(
        "oxi_browser={browser}; oxi_session_{}={}; oxi_session_{}={}",
        account_tokens[0].0, account_tokens[0].1, account_tokens[1].0, account_tokens[1].1,
    );

    for (account, _, email, password, host, port, tls) in &account_tokens {
        let (status, body) = fixture
            .get(&[
                ("cookie", cookies.clone()),
                ("x-active-account", account.clone()),
            ])
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["inbox_unread_count"], 3);
        let calls = fixture.imap.unread_count_calls.lock().unwrap();
        let (creds, folder) = calls.last().unwrap();
        assert_eq!(creds.email, *email);
        assert_eq!(creds.password, *password);
        assert_eq!(creds.host, *host);
        assert_eq!(creds.port, *port);
        assert_eq!(creds.tls, *tls);
        assert_eq!(folder, "INBOX");
    }
    assert_eq!(fixture.imap.unread_count_calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn account_unread_rejects_missing_mismatched_and_expired_auth() {
    let fixture = Fixture::new(with_unread(7));
    let (browser, account, token) = setup_test_account(&fixture.store, "alice@example.com");
    let (other_browser, other_account, other_token) =
        setup_test_account(&fixture.store, "bob@example.com");
    for headers in [
        vec![],
        vec![(
            "cookie",
            format!("oxi_browser={browser}; oxi_session_{account}={token}"),
        )],
        vec![
            ("cookie", format!("oxi_browser={browser}")),
            ("x-active-account", account.clone()),
        ],
        auth_headers(&browser, &account, &other_token),
        auth_headers(&other_browser, &account, &token),
        auth_headers(&browser, &other_account, &other_token),
    ] {
        let (status, body) = fixture.get(&headers).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.get("inbox_unread_count").is_none());
    }

    fixture
        .store
        .set_timeout_override(&token, Some(Duration::ZERO));
    let (status, body) = fixture.get(&auth_headers(&browser, &account, &token)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "ACCOUNT_SESSION_EXPIRED");
    assert!(fixture.imap.folder_status_calls.lock().unwrap().is_empty());
    assert!(fixture.imap.unread_count_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn account_unread_returns_an_error_instead_of_zero_when_imap_fails() {
    let fixture = Fixture::new(
        MockImapClient::new().with_error(ImapError::ConnectionFailed("Unavailable".to_string())),
    );
    let (browser, account, token) = setup_test_account(&fixture.store, "alice@example.com");
    let (status, body) = fixture.get(&auth_headers(&browser, &account, &token)).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "SERVICE_UNAVAILABLE");
    assert!(body.get("inbox_unread_count").is_none());
}
