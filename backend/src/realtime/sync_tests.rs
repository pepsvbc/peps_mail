use super::*;
use crate::imap::client::mock::MockImapClient;
use crate::imap::client::{ImapAttachment, ImapMessageBody};
use crate::realtime::credentials::{CredentialRegistry, test_creds};
use tempfile::TempDir;

const USER: &str = "sync-test-user";

fn config(data_dir: &TempDir) -> Arc<AppConfig> {
    Arc::new(
        serde_json::from_value(serde_json::json!({
            "data_dir": data_dir.path().to_str().unwrap(),
        }))
        .unwrap(),
    )
}

fn fast_timing() -> SyncTiming {
    SyncTiming {
        interval: Duration::from_millis(5),
        max_backoff: Duration::from_millis(20),
        max_failures: 4,
    }
}

struct Harness {
    _data_dir: TempDir,
    config: Arc<AppConfig>,
    event_bus: Arc<EventBus>,
    search: Arc<SearchEngine>,
    registry: Arc<CredentialRegistry>,
}

impl Harness {
    fn new() -> Self {
        let data_dir = TempDir::new().unwrap();
        // A user DB with cached folders so the loop has something to check.
        let conn = db::pool::open_user_db(data_dir.path().to_str().unwrap(), USER).unwrap();
        db::folders::insert_folder_if_new(&conn, "INBOX", None, "").unwrap();
        db::folders::insert_folder_if_new(&conn, "Archive", None, "").unwrap();
        drop(conn);
        Self {
            config: config(&data_dir),
            search: Arc::new(SearchEngine::new(data_dir.path().to_path_buf())),
            _data_dir: data_dir,
            event_bus: Arc::new(EventBus::new()),
            registry: Arc::new(CredentialRegistry::default()),
        }
    }

    fn spawn(&self, imap: Arc<MockImapClient>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(run_sync_loop(
            USER.to_string(),
            self.registry.source(USER),
            self.config.clone(),
            imap,
            self.event_bus.clone(),
            self.search.clone(),
            fast_timing(),
        ))
    }
}

fn passwords_used(imap: &MockImapClient) -> Vec<String> {
    imap.folder_status_calls
        .lock()
        .unwrap()
        .iter()
        .map(|(creds, _)| creds.password.clone())
        .collect()
}

#[tokio::test]
async fn stops_on_authentication_failure_and_asks_clients_to_relogin() {
    let harness = Harness::new();
    let _lease = harness.registry.register(USER, test_creds("stale"));
    let mut events = harness.event_bus.subscribe(USER).await;
    let imap = Arc::new(MockImapClient::new().with_error(ImapError::AuthenticationFailed));

    tokio::time::timeout(Duration::from_secs(5), harness.spawn(imap.clone()))
        .await
        .expect("loop must stop after an authentication failure")
        .unwrap();

    // One rejected login, not one per folder and not one per interval.
    assert_eq!(passwords_used(&imap), vec!["stale"]);
    assert!(matches!(events.try_recv(), Ok(MailEvent::ReauthRequired)));
    assert!(harness.registry.current(USER).is_none());
}

#[tokio::test]
async fn switches_to_newer_credentials_after_a_rejection() {
    let harness = Harness::new();
    let _fresh = harness.registry.register(USER, test_creds("fresh"));
    let _stale = harness.registry.register(USER, test_creds("stale"));
    let imap = Arc::new(MockImapClient::new().with_error(ImapError::AuthenticationFailed));

    tokio::time::timeout(Duration::from_secs(5), harness.spawn(imap.clone()))
        .await
        .expect("loop must stop once every credential was rejected")
        .unwrap();

    // Each password is tried exactly once.
    assert_eq!(passwords_used(&imap), vec!["stale", "fresh"]);
}

#[tokio::test]
async fn gives_up_after_too_many_connection_failures() {
    let harness = Harness::new();
    let _lease = harness.registry.register(USER, test_creds("pw"));
    let mut events = harness.event_bus.subscribe(USER).await;
    let imap = Arc::new(
        MockImapClient::new().with_error(ImapError::ConnectionFailed("down".into())),
    );

    tokio::time::timeout(Duration::from_secs(5), harness.spawn(imap.clone()))
        .await
        .expect("loop must stop after max_failures consecutive failures")
        .unwrap();

    // One connect attempt per cycle (not per folder), max_failures cycles.
    assert_eq!(passwords_used(&imap).len(), 4);
    // Outages are not credential problems: no re-login prompt.
    assert!(events.try_recv().is_err());
    assert!(harness.registry.current(USER).is_some());
}

#[tokio::test]
async fn picks_up_credentials_from_a_later_login() {
    let harness = Harness::new();
    let first = harness.registry.register(USER, test_creds("old"));
    let imap = Arc::new(MockImapClient::new());
    let handle = harness.spawn(imap.clone());

    async fn wait_for(imap: &MockImapClient, password: &str) -> bool {
        for _ in 0..500 {
            if passwords_used(imap).iter().any(|used| used == password) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    assert!(wait_for(&imap, "old").await);
    let _second = harness.registry.register(USER, test_creds("new"));
    drop(first);
    assert!(
        wait_for(&imap, "new").await,
        "loop kept using the first socket's credentials"
    );
    handle.abort();
}

#[tokio::test]
async fn deep_index_caches_attachment_metadata_not_bytes() {
    let harness = Harness::new();
    let data_dir = harness.config.data_dir.clone();
    {
        let conn = db::pool::open_user_db(&data_dir, USER).unwrap();
        let prefs: db::display_preferences::UpdateDisplayPreferences =
            serde_json::from_value(serde_json::json!({ "deep_index": true })).unwrap();
        db::display_preferences::update_preferences(&conn, &prefs).unwrap();
        db::messages::upsert_message(
            &conn, "INBOX", 7, Some("<m@ex>"), None, None, "Subject", "a@ex", "A",
            "[]", "[]", "2024-01-01T10:00:00Z", "", 100, true, "", None,
        )
        .unwrap();
    }
    let imap = MockImapClient::new().with_bodies(vec![ImapMessageBody {
        uid: 7,
        text_plain: Some("hello".into()),
        // Non-ASCII colour value: used to panic theme detection and kill the loop.
        text_html: Some(r##"<body bgcolor="#aéaaaa"><img src="cid:img1"></body>"##.into()),
        attachments: vec![
            ImapAttachment {
                filename: Some("big.bin".into()),
                content_type: "application/octet-stream".into(),
                size: 4096,
                data: vec![42u8; 4096],
                content_id: None,
            },
            ImapAttachment {
                filename: None,
                content_type: "image/png".into(),
                size: 3,
                data: vec![1, 2, 3],
                content_id: Some("img1".into()),
            },
        ],
        raw_headers: "Subject: Subject".into(),
    }]);
    let creds = test_creds("pw");

    index_message_bodies(USER, &creds, &harness.config, &imap, &harness.search)
        .await
        .unwrap();

    let conn = db::pool::open_user_db(&data_dir, USER).unwrap();
    let cached = db::messages::get_cached_body(&conn, "INBOX", 7).unwrap().unwrap();
    let json = cached.attachments_json.unwrap();
    assert!(!json.contains("\"data\""), "raw bytes leaked into the cache: {json}");
    assert!(json.len() < 1024, "attachment JSON is bloated: {} bytes", json.len());
    let meta: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
    assert_eq!(meta.len(), 2);
    assert_eq!(meta[0]["id"], "0");
    assert_eq!(meta[1]["content_id"], "img1");
    // Inline images are resolved the same way get_message does it.
    assert!(cached.html.unwrap().contains("data:image/png;base64,AQID"));
}

#[test]
fn imap_attachment_serialization_never_includes_bytes() {
    let attachment = ImapAttachment {
        filename: Some("a.bin".into()),
        content_type: "application/octet-stream".into(),
        size: 3,
        data: vec![1, 2, 3],
        content_id: None,
    };
    let json = serde_json::to_string(&attachment).unwrap();
    assert!(!json.contains("data"), "{json}");
}
