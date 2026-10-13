use super::*;

#[tokio::test]
async fn incoming_and_draft_active_attachments_are_downloaded_with_isolation_headers() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let config = test_config_with_imap(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    );
    let store = test_store();
    let (browser_id, account_id, token) = setup_test_account(&store, "alice@example.com");
    let user_hash = crate::auth::user_data::hash_email("alice@example.com");
    let conn = crate::db::pool::open_user_db(&config.data_dir, &user_hash).unwrap();
    let payload = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
    let draft_path = data_dir.path().join("untrusted.svg");
    fs::write(&draft_path, payload).unwrap();
    crate::db::drafts::upsert_draft(&conn, "test-draft", "", "", "", "", "", None, None, None)
        .unwrap();
    crate::db::drafts::add_draft_attachment(
        &conn,
        "test-attachment",
        "test-draft",
        "untrusted.svg",
        "IMAGE/SVG+XML",
        payload.len() as i64,
        draft_path.to_str().unwrap(),
    )
    .unwrap();
    let imap = MockImapClient::new().with_bodies(vec![ImapMessageBody {
        uid: 42,
        text_plain: None,
        text_html: None,
        attachments: vec![ImapAttachment {
            filename: Some("untrusted.html".to_string()),
            content_type: "Text/HTML; charset=utf-8".to_string(),
            size: payload.len(),
            data: payload.to_vec(),
            content_id: None,
        }],
        raw_headers: String::new(),
    }]);
    let app = create_router(
        config,
        store,
        Arc::new(imap),
        test_smtp_client(),
        test_search_engine(data_dir.path().to_str().unwrap()),
        test_event_bus(),
        test_idle_manager(),
    );

    for uri in [
        "/api/messages/INBOX/42/attachments/0",
        "/api/drafts/test-draft/attachments/test-attachment/content",
    ] {
        let mut request = Request::builder().uri(uri);
        for (name, value) in auth_headers(&browser_id, &account_id, &token) {
            request = request.header(name, value);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("attachment;"),
            "{uri}"
        );
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("sandbox;")
        );
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            payload
        );
    }
}
