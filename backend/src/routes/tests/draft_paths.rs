use super::*;

struct DraftFixture {
    _static_dir: TempDir,
    data_dir: TempDir,
    app: Router,
    headers: Vec<(&'static str, String)>,
    user_hash: String,
    smtp: Arc<MockSmtpClient>,
}

impl DraftFixture {
    fn new() -> Self {
        let static_dir = setup_static_dir();
        let data_dir = TempDir::new().unwrap();
        let config = test_config_with_smtp(
            static_dir.path().to_str().unwrap(),
            data_dir.path().to_str().unwrap(),
        );
        let store = test_store();
        let (browser_id, account_id, token) = setup_test_account(&store, "alice@example.com");
        let user_hash = crate::auth::user_data::hash_email("alice@example.com");
        provision_user_db(&config.data_dir, &user_hash);
        fs::create_dir_all(data_dir.path().join(&user_hash).join("attachments")).unwrap();
        fs::create_dir_all(data_dir.path().join("victim")).unwrap();
        fs::write(data_dir.path().join("victim/sentinel"), "keep").unwrap();
        let smtp = Arc::new(MockSmtpClient::new());
        let app = create_router(
            config,
            store,
            test_imap_client(),
            smtp.clone(),
            test_search_engine(data_dir.path().to_str().unwrap()),
            test_event_bus(),
            test_idle_manager(),
        );
        Self {
            _static_dir: static_dir,
            data_dir,
            app,
            headers: auth_headers(&browser_id, &account_id, &token),
            user_hash,
            smtp,
        }
    }

    async fn request(
        &self,
        method: &str,
        uri: &str,
        content_type: &str,
        body: String,
    ) -> axum::response::Response {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-requested-with", "XMLHttpRequest")
            .header("content-type", content_type);
        for (name, value) in &self.headers {
            request = request.header(*name, value);
        }
        self.app
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap()
    }

    fn assert_sentinel_untouched(&self) {
        assert_eq!(
            fs::read_to_string(self.data_dir.path().join("victim/sentinel")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_dir(self.data_dir.path().join("victim"))
                .unwrap()
                .count(),
            1
        );
    }
}

fn upload_body() -> String {
    "--draft-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\nContent-Type: text/plain\r\n\r\nattachment\r\n--draft-test--\r\n".to_string()
}

#[tokio::test]
async fn draft_upsert_rejects_paths_before_persisting() {
    let fixture = DraftFixture::new();
    for id in [
        "",
        ".",
        "..",
        "../../victim",
        "/tmp/victim",
        "..\\victim",
        "a/b",
        "a\0b",
    ] {
        let response = fixture
            .request(
                "POST",
                "/api/drafts",
                "application/json",
                serde_json::json!({"id": id}).to_string(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "ID {id:?}");
    }
    let conn = crate::db::pool::open_user_db(
        fixture.data_dir.path().to_str().unwrap(),
        &fixture.user_hash,
    )
    .unwrap();
    assert!(crate::db::drafts::list_drafts(&conn).unwrap().is_empty());
    fixture.assert_sentinel_untouched();
}

#[tokio::test]
async fn draft_routes_reject_encoded_traversal_even_for_existing_records() {
    let fixture = DraftFixture::new();
    let conn = crate::db::pool::open_user_db(
        fixture.data_dir.path().to_str().unwrap(),
        &fixture.user_hash,
    )
    .unwrap();
    // Simulate a malicious record saved before validation was added. All
    // filesystem targets are confined to this test's temporary directory.
    crate::db::drafts::upsert_draft(&conn, "../../victim", "", "", "", "", "", None, None, None)
        .unwrap();
    for (method, suffix) in [
        ("GET", ""),
        ("DELETE", ""),
        ("GET", "/attachments/test/content"),
        ("DELETE", "/attachments/test"),
    ] {
        let uri = format!("/api/drafts/%2e%2e%2f%2e%2e%2fvictim{suffix}");
        let response = fixture
            .request(method, &uri, "application/json", String::new())
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{method} {uri}");
        fixture.assert_sentinel_untouched();
    }
    assert!(
        crate::db::drafts::get_draft(&conn, "../../victim")
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn attachment_upload_rejects_encoded_traversal_without_writing_files() {
    let fixture = DraftFixture::new();
    let response = fixture
        .request(
            "POST",
            "/api/drafts/%2e%2e%2f%2e%2e%2fvictim/attachments",
            "multipart/form-data; boundary=draft-test",
            upload_body(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    fixture.assert_sentinel_untouched();
    let conn = crate::db::pool::open_user_db(
        fixture.data_dir.path().to_str().unwrap(),
        &fixture.user_hash,
    )
    .unwrap();
    assert!(crate::db::drafts::list_drafts(&conn).unwrap().is_empty());
}

#[tokio::test]
async fn send_rejects_traversal_before_smtp_or_cleanup() {
    let fixture = DraftFixture::new();
    let response = fixture
        .request(
            "POST",
            "/api/messages/send",
            "application/json",
            serde_json::json!({
                "to": ["bob@example.com"], "subject": "hello", "draft_id": "../../victim",
            })
            .to_string(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(fixture.smtp.sent_count(), 0);
    fixture.assert_sentinel_untouched();
}

#[tokio::test]
async fn simple_draft_ids_still_allow_attachment_upload_and_cleanup() {
    let fixture = DraftFixture::new();
    let response = fixture
        .request(
            "POST",
            "/api/drafts/draft-123_abc.v1/attachments",
            "multipart/form-data; boundary=draft-test",
            upload_body(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let attachment_id = json["attachments"][0]["id"].as_str().unwrap();
    let path = fixture
        .data_dir
        .path()
        .join(&fixture.user_hash)
        .join("attachments/draft-123_abc.v1");
    assert_eq!(
        fs::read_to_string(path.join(attachment_id)).unwrap(),
        "attachment"
    );

    let response = fixture
        .request(
            "DELETE",
            "/api/drafts/draft-123_abc.v1",
            "application/json",
            String::new(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!path.exists());
    fixture.assert_sentinel_untouched();
}
