use super::*;
use crate::smtp::client::mock::MockSmtpClient;
use std::sync::Mutex as StdMutex;

struct RecordingSmtp {
    messages: MockSmtpClient,
    credentials: StdMutex<Vec<SmtpCredentials>>,
    all: StdMutex<Vec<SendableMessage>>,
}
impl RecordingSmtp {
    fn new() -> Self {
        Self {
            messages: MockSmtpClient::new(),
            credentials: StdMutex::new(vec![]),
            all: StdMutex::new(vec![]),
        }
    }
    /// (recipient, subject) of every message so far, then forget them.
    fn take(&self) -> Vec<(String, String)> {
        self.all
            .lock()
            .unwrap()
            .drain(..)
            .map(|m| (m.to.join(","), m.subject))
            .collect()
    }
}
#[async_trait::async_trait]
impl SmtpClient for RecordingSmtp {
    async fn send_message(
        &self,
        creds: &SmtpCredentials,
        message: &SendableMessage,
    ) -> Result<String, crate::smtp::client::SmtpError> {
        self.credentials.lock().unwrap().push(creds.clone());
        self.all.lock().unwrap().push(message.clone());
        self.messages.send_message(creds, message).await
    }
}

fn session(store: &SessionStore, email: &str) -> SessionState {
    let browser = store.create_browser();
    let (token, account) = store.add_account_to_browser(
        &browser,
        email.into(),
        "password".into(),
        crate::auth::user_data::hash_email(email),
        "imap.example.com".into(),
        993,
        true,
        "smtp.example.com".into(),
        587,
        true,
    );
    store
        .get_account_session(&browser, &account, &token)
        .unwrap()
}

fn integration(base: String, temp: &tempfile::TempDir, config: config::Config) -> Arc<Integration> {
    Arc::new(
        Integration::new(
            config,
            client::ManagementClient::test_client(base),
            storage::Storage::new(temp.path().to_str().unwrap()).unwrap(),
        )
        .unwrap(),
    )
}

fn recovery_config(admins: &str) -> config::Config {
    config::Config {
        enabled: true,
        api_key: "test-secret".into(),
        domains: "example.com".into(),
        public_url: "https://mail.example.com".into(),
        mail_from: "noreply@example.com".into(),
        smtp_username: "noreply@example.com".into(),
        smtp_password: "sender-secret".into(),
        admin_emails: admins.into(),
        ..Default::default()
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
    let i = integration(
        base,
        &temp,
        config::Config {
            domains: " EXAMPLE.COM, excluded.example ".into(),
            public_url: "https://mail.example.com/mail".into(),
            ..recovery_config("admin@example.com")
        },
    );
    let smtp = Arc::new(RecordingSmtp::new());
    let smtp_client: Arc<dyn SmtpClient> = smtp.clone();
    let admin_store = SessionStore::new(std::time::Duration::from_secs(3600));
    let admin = session(&admin_store, "admin@example.com");
    // A former owner's cache under the same address must not survive.
    let stale = temp
        .path()
        .join(crate::auth::user_data::hash_email("new@example.com"));
    std::fs::create_dir_all(stale.join("tantivy")).unwrap();
    std::fs::write(stale.join("db.sqlite"), "former owner").unwrap();
    let response = create_mailbox(
        Extension(i.clone()),
        Extension(app.clone()),
        Extension(admin.clone()),
        Extension(smtp_client),
        Json(Invitation {
            email: "new@example.com".into(),
            personal_email: "person@personal.org".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.0, json!({"ok":true}));
    assert!(!stale.exists());
    let available = mailboxes(Extension(i.clone()), Extension(app.clone()), Extension(admin))
        .await
        .unwrap();
    assert_eq!(available.0["domains"], json!(["example.com"]));
    assert_eq!(available.0["mailboxes"][0]["protected"], false);

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
    let i = integration(
        base,
        &temp,
        config::Config {
            enabled: true,
            domains: "example.com".into(),
            ..Default::default()
        },
    );
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
        .issue("member@example.com", "person@other.org", "reset", Origin::Admin)
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
    let i = integration(
        base,
        &temp,
        config::Config {
            enabled: true,
            domains: "example.com".into(),
            admin_emails: "admin@example.com".into(),
            ..Default::default()
        },
    );
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
            .issue("member@example.com", "personal@other.org", "reset", Origin::Admin)
            .unwrap()
            .unwrap();
        let caches: Vec<_> = ["member@example.com", "Member@example.com"]
            .iter()
            .map(|spelling| temp.path().join(crate::auth::user_data::hash_email(spelling)))
            .collect();
        for cache in &caches {
            std::fs::create_dir_all(cache.join("tantivy")).unwrap();
            std::fs::write(cache.join("db.sqlite"), "cached mail").unwrap();
        }
        let result = delete_mailbox(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(s.clone()),
            Extension(store.clone()),
            Json(DeleteMailbox {
                email: "Member@example.com".into(),
                confirmation: "MEMBER@example.com".into(),
                mailbox_id: id,
            }),
        )
        .await;
        assert_eq!(result.is_err(), should_fail);
        // Local data goes only once the provider confirms deletion.
        for cache in &caches {
            assert_eq!(cache.exists(), should_fail);
            let _ = std::fs::remove_dir_all(cache);
        }
        assert!(
            std::fs::read_dir(temp.path())
                .unwrap()
                .all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".deleted-"))
        );
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

/// Provider with three mailboxes and one shared Sieve script.
async fn sieve_provider() -> (String, tokio::task::JoinHandle<()>) {
    let script = Arc::new(StdMutex::new(String::new()));
    let (read, write) = (script.clone(), script);
    let provider = Router::new()
        .route(
            "/mailboxes",
            get(|| async {
                Json(json!({"mailboxes":[
                    {"id":uuid::Uuid::from_u128(2),"address":"member@example.com"},
                    {"id":uuid::Uuid::from_u128(3),"address":"boss@example.com"},
                    {"id":uuid::Uuid::from_u128(4),"address":"admin@example.com"},
                ]}))
            }),
        )
        .route(
            "/mailboxes/{id}/sieve",
            get(move || {
                let script = read.lock().unwrap().clone();
                async move { Json(json!({"script":script,"managedRulesPresent":false})) }
            })
            .put(move |Json(body): Json<Value>| {
                *write.lock().unwrap() = body["script"].as_str().unwrap().to_string();
                async { Json(json!({"ok":true})) }
            }),
        )
        .route(
            "/sieve/validate",
            post(|| async { Json(json!({"valid":true})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    (base, server)
}

fn shared_app(temp: &tempfile::TempDir) -> Arc<AppConfig> {
    Arc::new(
        serde_json::from_value(json!({"data_dir":temp.path().to_str().unwrap(),"imap_host":"imap.example.com","smtp_host":"smtp.example.com"}))
            .unwrap(),
    )
}

#[tokio::test]
async fn other_admins_are_protected_and_owners_are_told_about_changes() {
    let (base, server) = sieve_provider().await;
    let temp = tempfile::tempdir().unwrap();
    let app = shared_app(&temp);
    let i = integration(
        base,
        &temp,
        recovery_config("admin@example.com, boss@example.com, chief@example.com"),
    );
    let store = Arc::new(SessionStore::new(std::time::Duration::from_secs(3600)));
    let admin = session(&store, "admin@example.com");
    let smtp = Arc::new(RecordingSmtp::new());
    let smtp_client: Arc<dyn SmtpClient> = smtp.clone();
    let recovery = |email: &str, personal: &str| {
        admin_recovery(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(admin.clone()),
            Extension(smtp_client.clone()),
            Json(Invitation {
                email: email.into(),
                personal_email: personal.into(),
            }),
        )
    };
    let forward = |email: &str, revision: String, address: &str, keep_copy: bool| {
        forwarding(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(admin.clone()),
            Extension(smtp_client.clone()),
            Json(ForwardRequest {
                email: email.into(),
                revision,
                forwarding: sieve::Forwarding {
                    enabled: true,
                    address: address.into(),
                    keep_copy,
                },
            }),
        )
    };
    let revision = |email: &str| {
        settings(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(admin.clone()),
            Query(Target {
                email: email.into(),
            }),
        )
    };

    // Another administrator's mailbox: no recovery, forwarding, deletion or
    // creation (for a listed address that does not exist yet).
    assert!(matches!(
        recovery("boss@example.com", "attacker@other.org").await,
        Err(AppError::Forbidden(_))
    ));
    let boss = revision("BOSS@example.com").await.unwrap().0;
    assert_eq!(boss["protected"], true);
    let boss_revision = boss["revision"].as_str().unwrap().to_string();
    assert!(matches!(
        forward("boss@example.com", boss_revision, "attacker@other.org", true).await,
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        delete_mailbox(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(admin.clone()),
            Extension(store.clone()),
            Json(DeleteMailbox {
                email: "boss@example.com".into(),
                mailbox_id: uuid::Uuid::from_u128(3),
                confirmation: "boss@example.com".into(),
            }),
        )
        .await,
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        create_mailbox(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(admin.clone()),
            Extension(smtp_client.clone()),
            Json(Invitation {
                email: "Chief@example.com".into(),
                personal_email: "attacker@other.org".into(),
            }),
        )
        .await,
        Err(AppError::Forbidden(_))
    ));
    let listed = mailboxes(
        Extension(i.clone()),
        Extension(app.clone()),
        Extension(admin.clone()),
    )
    .await
    .unwrap()
    .0;
    let protected: Vec<_> = listed["mailboxes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["address"].as_str().unwrap(), m["protected"].as_bool().unwrap()))
        .collect();
    assert_eq!(
        protected,
        vec![
            ("member@example.com", false),
            ("boss@example.com", true),
            ("admin@example.com", false)
        ]
    );
    assert!(smtp.take().is_empty());
    assert!(i.storage.recovery("boss@example.com").unwrap().is_none());

    // The recovery address must differ from the normalized mailbox.
    assert!(matches!(
        recovery("Member@Example.com", " MEMBER@example.COM ").await,
        Err(AppError::BadRequest(_))
    ));

    // First address: the mailbox is told, the link goes to the new address.
    let _ = recovery("member@example.com", "first@other.org").await.unwrap();
    let reset = "Reset your mailbox password".to_string();
    let changed = "Your mailbox recovery address was changed".to_string();
    assert_eq!(
        smtp.take(),
        vec![
            ("member@example.com".into(), changed.clone()),
            ("first@other.org".into(), reset.clone()),
        ]
    );
    // Changing it tells the mailbox and the previous address. The new address
    // gets a link at once despite the administrator cooldown.
    let _ = recovery("member@example.com", "second@other.org").await.unwrap();
    assert_eq!(
        smtp.take(),
        vec![
            ("member@example.com".into(), changed.clone()),
            ("first@other.org".into(), changed),
            ("second@other.org".into(), reset),
        ]
    );
    // Resending to the same address changes nothing and is throttled.
    assert!(matches!(
        recovery("member@example.com", "second@other.org").await,
        Err(AppError::BadRequest(_))
    ));
    assert!(smtp.take().is_empty());

    // New forwarding: the mailbox and its recovery address are told.
    let rev = revision("member@example.com").await.unwrap().0["revision"]
        .as_str()
        .unwrap()
        .to_string();
    let _ = forward("member@example.com", rev, "Elsewhere@other.org", false)
        .await
        .unwrap();
    let forwarded = "Automatic forwarding was changed for your mailbox".to_string();
    let sent = smtp.all.lock().unwrap().clone();
    assert!(sent[0].text_body.contains("elsewhere@other.org"));
    assert_eq!(
        smtp.take(),
        vec![
            ("member@example.com".into(), forwarded.clone()),
            ("second@other.org".into(), forwarded),
        ]
    );
    // Saving the same rule again is not a change.
    let rev = revision("member@example.com").await.unwrap().0["revision"]
        .as_str()
        .unwrap()
        .to_string();
    let _ = forward("member@example.com", rev, "elsewhere@other.org", false)
        .await
        .unwrap();
    assert!(smtp.take().is_empty());

    // Administrators still manage their own mailbox.
    let _ = recovery("admin@example.com", "mine@other.org").await.unwrap();
    // Locks are released and their entries removed.
    assert!(i.locks.is_empty());
    server.abort();
}

#[tokio::test]
async fn anonymous_requests_do_not_block_or_revoke_administrator_links() {
    let (base, server) = sieve_provider().await;
    let temp = tempfile::tempdir().unwrap();
    let app = shared_app(&temp);
    let i = integration(base, &temp, recovery_config("admin@example.com"));
    let store = Arc::new(SessionStore::new(std::time::Duration::from_secs(3600)));
    let admin = session(&store, "admin@example.com");
    let smtp = Arc::new(RecordingSmtp::new());
    let smtp_client: Arc<dyn SmtpClient> = smtp.clone();
    let _ = admin_recovery(
        Extension(i.clone()),
        Extension(app.clone()),
        Extension(admin.clone()),
        Extension(smtp_client.clone()),
        Json(Invitation {
            email: "member@example.com".into(),
            personal_email: "owner@other.org".into(),
        }),
    )
    .await
    .unwrap();
    let admin_link = smtp.all.lock().unwrap().last().unwrap().text_body.clone();
    let admin_token = admin_link
        .split_once("#token=")
        .unwrap()
        .1
        .split_whitespace()
        .next()
        .unwrap()
        .to_string();
    smtp.take();
    for _ in 0..3 {
        let response = request_reset(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(smtp_client.clone()),
            Json(Target {
                email: "member@example.com".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(response.0, json!({"ok":true}));
    }
    // Requests for unknown or foreign addresses look the same.
    for email in ["nobody@example.com", "victim@elsewhere.org", "not an address"] {
        let response = request_reset(
            Extension(i.clone()),
            Extension(app.clone()),
            Extension(smtp_client.clone()),
            Json(Target {
                email: email.into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(response.0, json!({"ok":true}));
    }
    // Wait for the background deliveries to finish.
    for _ in 0..100 {
        if i.recovery_tasks.available_permits() == MAX_RECOVERY_TASKS {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // Only one public email: later requests hit the public cooldown.
    assert_eq!(
        smtp.take(),
        vec![(
            "owner@other.org".into(),
            "Reset your mailbox password".into()
        )]
    );
    // The administrator link still works.
    assert_eq!(
        i.storage.consume(&admin_token, "reset").unwrap().email,
        "member@example.com"
    );
    server.abort();
}

#[test]
fn account_capabilities_report_franklymail_admins_only() {
    let temp = tempfile::tempdir().unwrap();
    let mut app = (*shared_app(&temp)).clone();
    // ADMIN_EMAILS (distribution lists) grants nothing here.
    app.admin_emails = Some("lists@example.com".into());
    let i = Integration::new(
        recovery_config("Admin@Example.com"),
        client::ManagementClient::test_client("http://127.0.0.1:9".into()),
        storage::Storage::new(temp.path().to_str().unwrap()).unwrap(),
    )
    .unwrap();
    let store = SessionStore::new(std::time::Duration::from_secs(3600));
    assert!(is_admin_session(&i, &app, &session(&store, "admin@example.com")));
    assert!(!is_admin_session(&i, &app, &session(&store, "lists@example.com")));
    assert!(!is_admin_session(&i, &app, &session(&store, "member@example.com")));
    let mut other_port = session(&store, "admin@example.com");
    other_port.imap_port = 143;
    assert!(!is_admin_session(&i, &app, &other_port));
}
