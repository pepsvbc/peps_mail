//! Cache integrity of the message routes: no folder rows from unverified URL
//! names, no cache deletion on transient IMAP errors, bounded threading, and
//! panic-free theme detection on hostile HTML.

use super::*;

const EMAIL: &str = "cache@example.com";

struct Fixture {
    _static_dir: TempDir,
    data_dir: TempDir,
    app: Router,
    auth: Vec<(&'static str, String)>,
}

impl Fixture {
    fn new(imap: MockImapClient) -> Self {
        let static_dir = setup_static_dir();
        let data_dir = TempDir::new().unwrap();
        let config = test_config_with_imap(
            static_dir.path().to_str().unwrap(),
            data_dir.path().to_str().unwrap(),
        );
        let store = test_store();
        let (browser_id, account_id, token) = setup_test_account(&store, EMAIL);
        provision_user_db(data_dir.path().to_str().unwrap(), &user_hash());
        let app = create_router(
            config,
            store,
            Arc::new(imap),
            test_smtp_client(),
            test_search_engine(data_dir.path().to_str().unwrap()),
            test_event_bus(),
            test_idle_manager(),
        );
        Self {
            _static_dir: static_dir,
            data_dir,
            app,
            auth: auth_headers(&browser_id, &account_id, &token),
        }
    }

    fn conn(&self) -> rusqlite::Connection {
        crate::db::pool::open_user_db(self.data_dir.path().to_str().unwrap(), &user_hash()).unwrap()
    }

    async fn get(&self, uri: &str) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .uri(uri)
            .header("x-requested-with", "XMLHttpRequest");
        for (name, value) in &self.auth {
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
        (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }

    /// Seed a cached message header (and optionally a cached body).
    fn seed(&self, uid: u32, message_id: &str, references: Option<&str>) {
        let conn = self.conn();
        crate::db::folders::insert_folder_if_new(&conn, "INBOX", None, "").unwrap();
        crate::db::messages::upsert_message(
            &conn, "INBOX", uid, Some(message_id), None, references, "Subject",
            "a@example.com", "A", "[]", "[]", "2024-01-01T10:00:00Z", "", 100, false, "", None,
        )
        .unwrap();
    }

    fn message_exists(&self, uid: u32) -> bool {
        crate::db::messages::get_single_message(&self.conn(), "INBOX", uid)
            .unwrap()
            .is_some()
    }
}

fn user_hash() -> String {
    crate::auth::user_data::hash_email(EMAIL)
}

#[tokio::test]
async fn listing_an_unknown_folder_does_not_create_a_folder_row() {
    let fixture = Fixture::new(
        MockImapClient::new().with_error(ImapError::FolderNotFound("Nope".into())),
    );
    let (status, _) = fixture.get("/api/folders/Nope-12345/messages").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        crate::db::folders::get_folder(&fixture.conn(), "Nope-12345")
            .unwrap()
            .is_none(),
        "unverified folder name from the URL was stored"
    );
}

#[tokio::test]
async fn transient_imap_failure_keeps_the_cached_message() {
    let fixture = Fixture::new(
        MockImapClient::new().with_error(ImapError::ConnectionFailed("down".into())),
    );
    fixture.seed(5, "<m5@ex>", None);

    let (status, _) = fixture.get("/api/messages/INBOX/5").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(fixture.message_exists(5), "transient error must not delete the cache row");
}

#[tokio::test]
async fn message_gone_from_server_is_removed_from_the_cache() {
    // No bodies: the mock answers fetch_body with MessageNotFound.
    let fixture = Fixture::new(MockImapClient::new());
    fixture.seed(6, "<m6@ex>", None);

    let (status, _) = fixture.get("/api/messages/INBOX/6").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!fixture.message_exists(6));
}

#[tokio::test]
async fn stale_cached_body_is_served_while_imap_is_down() {
    let fixture = Fixture::new(
        MockImapClient::new().with_error(ImapError::ConnectionFailed("down".into())),
    );
    fixture.seed(7, "<m7@ex>", None);
    // A body cached without attachment metadata (e.g. cleared by V025).
    crate::db::messages::cache_message_body(
        &fixture.conn(), "INBOX", 7, Some("<p>cached</p>"), Some("cached"), None, Some(""), None,
    )
    .unwrap();

    let (status, json) = fixture.get("/api/messages/INBOX/7").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["html"], "<p>cached</p>");
    assert!(fixture.message_exists(7));
}

#[tokio::test]
async fn hostile_colour_and_references_are_handled_safely() {
    let fixture = Fixture::new(MockImapClient::new());
    // A mailbox of unrelated messages...
    for uid in 1..=300u32 {
        fixture.seed(uid, &format!("<m{uid}@ex>"), None);
    }
    // ...and a hostile message that references all of them plus junk tokens,
    // with a non-ASCII bgcolor that used to panic theme detection.
    let mut refs: Vec<String> = (1..=300u32).map(|uid| format!("<m{uid}@ex>")).collect();
    refs.extend((0..5_000).map(|i| format!("<j{i}@x>")));
    refs.push("@".into());
    let refs = refs.join(" ");
    fixture.seed(999, "<evil@ex>", Some(&refs));
    crate::db::messages::cache_message_body(
        &fixture.conn(),
        "INBOX",
        999,
        Some(r##"<html><body bgcolor="#aéaaaa">hi</body></html>"##),
        Some("hi"),
        Some("[]"),
        Some(""),
        None,
    )
    .unwrap();

    let (status, json) = fixture.get("/api/messages/INBOX/999").await;
    assert_eq!(status, StatusCode::OK);
    let thread = json["thread"].as_array().unwrap();
    assert!(
        thread.len() <= crate::db::messages::MAX_THREAD_MESSAGES,
        "thread pulled in {} messages",
        thread.len()
    );
    assert!(thread.len() < 300, "thread pulled in the whole mailbox");
}
