use super::*;

struct Fixture {
    _static_dir: TempDir,
    data_dir: TempDir,
    app: Router,
    store: Arc<SessionStore>,
}

impl Fixture {
    fn new() -> Self {
        let static_dir = setup_static_dir();
        let data_dir = TempDir::new().unwrap();
        let data_path = data_dir.path().to_str().unwrap();
        let config = test_config_with_imap(static_dir.path().to_str().unwrap(), data_path);
        let store = test_store();
        let app = create_router(
            config,
            store.clone(),
            test_imap_client(),
            test_smtp_client(),
            test_search_engine(data_path),
            test_event_bus(),
            test_idle_manager(),
        );
        Self {
            _static_dir: static_dir,
            data_dir,
            app,
            store,
        }
    }

    /// Seed the user's known addresses as message sync would.
    fn seed(&self, email: &str, addresses: &[(&str, &str)]) {
        let conn = crate::db::pool::open_user_db(
            self.data_dir.path().to_str().unwrap(),
            &crate::auth::user_data::hash_email(email),
        )
        .unwrap();
        for (address, name) in addresses {
            crate::db::known_addresses::populate_known_addresses(&conn, address, name, "[]", "[]")
                .unwrap();
        }
    }

    async fn get(&self, uri: &str, headers: &[(&str, String)]) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .uri(uri)
            .header("x-requested-with", "XMLHttpRequest");
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

fn emails(body: &serde_json::Value) -> Vec<&str> {
    body["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["email"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn address_autocomplete_requires_auth() {
    let fixture = Fixture::new();
    for uri in [
        "/api/addresses/autocomplete?q=al",
        "/api/addresses/autocomplete/all",
    ] {
        let (status, body) = fixture.get(uri, &[]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.get("suggestions").is_none());
    }
}

#[tokio::test]
async fn address_autocomplete_returns_matching_known_addresses() {
    let fixture = Fixture::new();
    let (browser, account, token) = setup_test_account(&fixture.store, "alice@example.com");
    fixture.seed(
        "alice@example.com",
        &[
            ("albert@test.com", "Albert"),
            ("bob@test.com", "Bob Alvarez"),
            ("carol@test.com", "Carol"),
        ],
    );
    let headers = auth_headers(&browser, &account, &token);

    let (status, body) = fixture
        .get("/api/addresses/autocomplete?q=al", &headers)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["suggestions"][0],
        serde_json::json!({ "email": "albert@test.com", "name": "Albert", "source": "known" })
    );
    assert_eq!(emails(&body), vec!["albert@test.com", "bob@test.com"]);

    let (status, body) = fixture
        .get("/api/addresses/autocomplete?q=al&limit=1", &headers)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(emails(&body), vec!["albert@test.com"]);

    // A blank query returns no suggestions.
    for uri in ["/api/addresses/autocomplete", "/api/addresses/autocomplete?q=%20"] {
        let (status, body) = fixture.get(uri, &headers).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "suggestions": [] }));
    }
}

#[tokio::test]
async fn address_autocomplete_all_returns_every_known_address() {
    let fixture = Fixture::new();
    let (browser, account, token) = setup_test_account(&fixture.store, "alice@example.com");
    fixture.seed(
        "alice@example.com",
        &[("bob@test.com", "Bob"), ("albert@test.com", "Albert")],
    );

    let (status, body) = fixture
        .get(
            "/api/addresses/autocomplete/all",
            &auth_headers(&browser, &account, &token),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(emails(&body), vec!["albert@test.com", "bob@test.com"]);
    assert!(body["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["source"] == "known"));
}
