use super::*;
use crate::smtp::client::mock::MockSmtpClient;
use std::sync::Mutex as StdMutex;

struct RecordingSmtp {
    messages: MockSmtpClient,
    credentials: StdMutex<Vec<SmtpCredentials>>,
}
#[async_trait::async_trait]
impl SmtpClient for RecordingSmtp {
    async fn send_message(
        &self,
        creds: &SmtpCredentials,
        message: &SendableMessage,
    ) -> Result<String, crate::smtp::client::SmtpError> {
        self.credentials.lock().unwrap().push(creds.clone());
        self.messages.send_message(creds, message).await
    }
}

#[tokio::test]
async fn welcome_link_sets_password_once_without_exposing_initial_credentials() {
    let provisioned = Arc::new(StdMutex::new(Vec::<Value>::new()));
    let passwords = Arc::new(StdMutex::new(Vec::<Value>::new()));
    let list_state = provisioned.clone();
    let create_state = provisioned.clone();
    let password_state = passwords.clone();
    let provider = Router::new()
        .route("/domains", get(|| async { Json(json!({"domains":[{"id":"00000000-0000-0000-0000-000000000001","domain":"example.com"}]})) }))
        .route("/mailboxes", get(move || {
            let exists = !list_state.lock().unwrap().is_empty();
            async move { Json(if exists {json!({"mailboxes":[{"id":"00000000-0000-0000-0000-000000000002","address":"new@example.com"}]})} else { json!({"mailboxes":[]}) }) }
        }).post(move |Json(body): Json<Value>| {
            create_state.lock().unwrap().push(body);
            async { Json(json!({"status":"provisioning","password":"upstream-password"})) }
        }))
        .route("/mailboxes/{id}/password", post(move |Json(body): Json<Value>| {
            password_state.lock().unwrap().push(body);
            async { Json(json!({"status":"provisioning","password":"upstream-password"})) }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let app: AppConfig = serde_json::from_value(
        json!({"data_dir":temp.path().to_str().unwrap(),"imap_host":"imap.example.com","smtp_host":"smtp.shared.example.com","smtp_port":465,"allowed_email_domains":"example.com"}),
    )
    .unwrap();
    let app = Arc::new(app);
    let i = Arc::new(Integration {
        config: config::Config {
            enabled: true,
            api_key: "test-secret".into(),
            domains: " EXAMPLE.COM, excluded.example ".into(),
            public_url: "https://mail.example.com/mail".into(),
            mail_from: "noreply@example.com".into(),
            smtp_username: "noreply@example.com".into(),
            smtp_password: "sender-secret".into(),
            ..Default::default()
        },
        client: client::ManagementClient::test_client(base),
        storage: storage::Storage::new(temp.path().to_str().unwrap()).unwrap(),
        welcome: emails::EmailTemplate::welcome(&config::Config::default()).unwrap(),
        reset: emails::EmailTemplate::reset(&config::Config::default()).unwrap(),
        writes: Mutex::new(()),
    });
    let smtp = Arc::new(RecordingSmtp {
        messages: MockSmtpClient::new(),
        credentials: StdMutex::new(vec![]),
    });
    let smtp_client: Arc<dyn SmtpClient> = smtp.clone();
    let response = create_mailbox(
        Extension(i.clone()),
        Extension(app.clone()),
        Extension(smtp_client),
        Json(Invitation {
            email: "new@example.com".into(),
            personal_email: "person@personal.org".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.0, json!({"ok":true}));
    let available = mailboxes(Extension(i.clone()), Extension(app.clone()))
        .await
        .unwrap();
    assert_eq!(available.0["domains"], json!(["example.com"]));

    let message = smtp.messages.last_sent().unwrap();
    {
        let credentials = smtp.credentials.lock().unwrap();
        assert_eq!(credentials[0].host, "smtp.shared.example.com");
        assert_eq!(credentials[0].port, 465);
        assert!(credentials[0].tls);
        assert_eq!(credentials[0].email, "noreply@example.com");
    }
    assert_eq!(message.from, "noreply@example.com");
    assert_eq!(message.to, vec!["person@personal.org"]);
    assert!(message.text_body.contains("new@example.com"));
    assert!(!message.text_body.contains("upstream-password"));
    let initial = provisioned.lock().unwrap()[0]["password"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(initial.len() >= 32);
    assert!(!message.text_body.contains(&initial));
    let link = message
        .text_body
        .lines()
        .find(|s| s.starts_with("https://"))
        .unwrap();
    assert!(link.starts_with("https://mail.example.com/mail/franklymail-recovery#token="));
    let html = message
        .html_body
        .as_ref()
        .expect("welcome HTML alternative");
    assert!(html.contains("Choose my password"));
    assert_eq!(html.matches(link).count(), 3);
    assert!(!html.contains(&initial));
    send_link(
        &i,
        &app,
        smtp.as_ref(),
        "new@example.com",
        "person@personal.org",
        "reset-example-token",
        false,
    )
    .await
    .unwrap();
    let reset_message = smtp.messages.last_sent().unwrap();
    assert!(
        reset_message
            .text_body
            .contains("#token=reset-example-token")
    );
    assert!(
        reset_message
            .html_body
            .as_ref()
            .unwrap()
            .contains("Reset my password")
    );
    assert_eq!(
        reset_message
            .html_body
            .as_ref()
            .unwrap()
            .matches("#token=reset-example-token")
            .count(),
        3
    );
    let token = link.split_once("#token=").unwrap().1.to_string();
    let store = Arc::new(SessionStore::new(std::time::Duration::from_secs(3600)));
    let browser = store.create_browser();
    let (_, account) = store.add_account_to_browser(
        &browser,
        "new@example.com".into(),
        "old-password".into(),
        "hash".into(),
        "imap.example.com".into(),
        993,
        true,
        "smtp.example.com".into(),
        587,
        true,
    );
    let response = reset_password(
        Extension(i.clone()),
        Extension(app.clone()),
        Extension(store.clone()),
        Json(ResetPassword {
            token: token.clone(),
            new_password: "chosen-by-recipient".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.0, json!({"ok":true}));
    assert!(!store.remove_account(&account));
    assert_eq!(
        passwords.lock().unwrap()[0],
        json!({"password":"chosen-by-recipient"})
    );
    assert!(
        reset_password(
            Extension(i),
            Extension(app),
            Extension(store),
            Json(ResetPassword {
                token,
                new_password: "another-password".into()
            })
        )
        .await
        .is_err()
    );
    assert_eq!(passwords.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn self_service_password_requires_reauthentication_and_revokes_sessions_and_links() {
    use crate::imap::client::mock::MockImapClient;
    let passwords = Arc::new(StdMutex::new(Vec::<Value>::new()));
    let recorded = passwords.clone();
    let provider = Router::new()
        .route("/mailboxes", get(|| async { Json(json!({"mailboxes":[{"id":"00000000-0000-0000-0000-000000000002","address":"member@example.com"}]})) }))
        .route("/mailboxes/{id}/password", post(move |Json(body): Json<Value>| {
            recorded.lock().unwrap().push(body);
            async { Json(json!({"status":"provisioning"})) }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(
        serde_json::from_value::<AppConfig>(
            json!({"data_dir":temp.path().to_str().unwrap(),"imap_host":"imap.example.com"}),
        )
        .unwrap(),
    );
    let i = Arc::new(Integration {
        config: config::Config {
            enabled: true,
            domains: "example.com".into(),
            ..Default::default()
        },
        client: client::ManagementClient::test_client(base),
        storage: storage::Storage::new(temp.path().to_str().unwrap()).unwrap(),
        welcome: emails::EmailTemplate::welcome(&config::Config::default()).unwrap(),
        reset: emails::EmailTemplate::reset(&config::Config::default()).unwrap(),
        writes: Mutex::new(()),
    });
    let store = Arc::new(SessionStore::new(std::time::Duration::from_secs(3600)));
    let browser = store.create_browser();
    let (token, account) = store.add_account_to_browser(
        &browser,
        "member@example.com".into(),
        "old-password".into(),
        "hash".into(),
        "imap.example.com".into(),
        993,
        true,
        "smtp.example.com".into(),
        587,
        true,
    );
    let (_, duplicate) = store.add_account_to_browser(
        &store.create_browser(),
        "member@example.com".into(),
        "old-password".into(),
        "hash".into(),
        "imap.example.com".into(),
        993,
        true,
        "smtp.example.com".into(),
        587,
        true,
    );
    let (_, other) = store.add_account_to_browser(
        &browser,
        "other@example.com".into(),
        "other-password".into(),
        "hash2".into(),
        "imap.example.com".into(),
        993,
        true,
        "smtp.example.com".into(),
        587,
        true,
    );
    let s = store
        .get_account_session(&browser, &account, &token)
        .unwrap();
    let reset = i
        .storage
        .issue("member@example.com", "person@other.org", "reset")
        .unwrap()
        .unwrap();
    for error in [
        ImapError::AuthenticationFailed,
        ImapError::ConnectionFailed("private server detail".into()),
    ] {
        let expected_auth_error = matches!(error, ImapError::AuthenticationFailed);
        let result = change_password(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(s.clone()),
            Extension(store.clone()),
            Extension(Arc::new(MockImapClient::new().with_error(error))),
            Json(ChangePassword {
                current_password: "wrong-password".into(),
                new_password: "new-secret-password".into(),
            }),
        )
        .await;
        assert!(if expected_auth_error {
            matches!(result, Err(AppError::BadRequest(_)))
        } else {
            matches!(result, Err(AppError::ServiceUnavailable(_)))
        });
        assert!(passwords.lock().unwrap().is_empty());
        assert!(
            store
                .get_account_session(&browser, &account, &token)
                .is_some()
        );
    }
    let result = change_password(
        Extension(i.clone()),
        Extension(app),
        Extension(s),
        Extension(store.clone()),
        Extension(Arc::new(MockImapClient::new())),
        Json(ChangePassword {
            current_password: "old-password".into(),
            new_password: "new-secret-password".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(result.0, json!({"ok":true}));
    assert_eq!(
        *passwords.lock().unwrap(),
        vec![json!({"password":"new-secret-password"})]
    );
    assert!(!store.remove_account(&account));
    assert!(!store.remove_account(&duplicate));
    assert!(store.remove_account(&other));
    assert!(i.storage.consume(&reset, "reset").is_err());
    server.abort();
}

#[tokio::test]
async fn deleting_a_mailbox_checks_identity_and_confirmation_and_clears_access() {
    use axum::http::StatusCode;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let deletes = Arc::new(AtomicUsize::new(0));
    let fail = Arc::new(AtomicBool::new(false));
    let recorded = deletes.clone();
    let failing = fail.clone();
    let id = uuid::Uuid::from_u128(2);
    let provider = Router::new()
        .route(
            "/mailboxes",
            get(move || async move {
                Json(json!({"mailboxes":[{"id":id,"address":"member@example.com"}]}))
            }),
        )
        .route(
            "/mailboxes/{id}",
            axum::routing::delete(move |request: Request| {
                recorded.fetch_add(1, Ordering::SeqCst);
                let fail = failing.load(Ordering::SeqCst);
                async move {
                    assert!(
                        request.uri().query().is_none(),
                        "Never request mail destruction"
                    );
                    assert_eq!(request.headers()["authorization"], "Bearer test-secret");
                    assert!(
                        axum::body::to_bytes(request.into_body(), 1024)
                            .await
                            .unwrap()
                            .is_empty()
                    );
                    if fail {
                        StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        StatusCode::NO_CONTENT
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(
        serde_json::from_value::<AppConfig>(
            json!({"data_dir":temp.path().to_str().unwrap(),"imap_host":"imap.example.com"}),
        )
        .unwrap(),
    );
    let i = Arc::new(Integration {
        config: config::Config {
            enabled: true,
            domains: "example.com".into(),
            ..Default::default()
        },
        client: client::ManagementClient::test_client(base),
        storage: storage::Storage::new(temp.path().to_str().unwrap()).unwrap(),
        welcome: emails::EmailTemplate::welcome(&config::Config::default()).unwrap(),
        reset: emails::EmailTemplate::reset(&config::Config::default()).unwrap(),
        writes: Mutex::new(()),
    });
    let store = Arc::new(SessionStore::new(std::time::Duration::from_secs(3600)));
    let browser = store.create_browser();
    let (token, admin) = store.add_account_to_browser(
        &browser,
        "admin@example.com".into(),
        "password".into(),
        "hash".into(),
        "imap.example.com".into(),
        993,
        true,
        "smtp.example.com".into(),
        587,
        true,
    );
    let s = store.get_account_session(&browser, &admin, &token).unwrap();
    for (email, confirmation, mailbox_id) in [
        ("member@example.com", "wrong@example.com", id),
        ("admin@example.com", "admin@example.com", id),
        ("outside@elsewhere.org", "outside@elsewhere.org", id),
        (
            "member@example.com",
            "member@example.com",
            uuid::Uuid::from_u128(3),
        ),
    ] {
        assert!(
            delete_mailbox(
                Extension(i.clone()),
                Extension(app.clone()),
                Extension(s.clone()),
                Extension(store.clone()),
                Json(DeleteMailbox {
                    email: email.into(),
                    confirmation: confirmation.into(),
                    mailbox_id
                })
            )
            .await
            .is_err()
        );
        assert_eq!(deletes.load(Ordering::SeqCst), 0);
    }
    for should_fail in [false, true] {
        fail.store(should_fail, Ordering::SeqCst);
        let (_, member) = store.add_account_to_browser(
            &browser,
            "member@example.com".into(),
            "password".into(),
            "hash2".into(),
            "imap.example.com".into(),
            993,
            true,
            "smtp.example.com".into(),
            587,
            true,
        );
        i.storage
            .set_recovery("member@example.com", "personal@other.org")
            .unwrap();
        let reset = i
            .storage
            .issue("member@example.com", "personal@other.org", "reset")
            .unwrap()
            .unwrap();
        let result = delete_mailbox(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(s.clone()),
            Extension(store.clone()),
            Json(DeleteMailbox {
                email: "member@example.com".into(),
                confirmation: "MEMBER@example.com".into(),
                mailbox_id: id,
            }),
        )
        .await;
        assert_eq!(result.is_err(), should_fail);
        assert!(!store.remove_account(&member));
        assert!(
            store
                .get_account_session(&browser, &admin, &token)
                .is_some()
        );
        assert!(i.storage.recovery("member@example.com").unwrap().is_none());
        assert!(i.storage.consume(&reset, "reset").is_err());
    }
    assert_eq!(deletes.load(Ordering::SeqCst), 2);
    server.abort();
}
