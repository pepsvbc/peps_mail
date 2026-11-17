use super::*;
use serde_json::{Value, json};

const ADMIN: &str = "admin@example.com";

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
        let mut config = (*test_config_with_imap(static_dir.path().to_str().unwrap(), data_path)).clone();
        config.admin_emails = Some(format!("{ADMIN},other-admin@example.com"));
        config.allowed_email_domains = Some("example.com".to_string());
        let store = test_store();
        let app = create_router(
            Arc::new(config),
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

    /// Sign `email` in and return its request headers.
    fn login(&self, email: &str) -> Vec<(&'static str, String)> {
        let (browser, account, token) = setup_test_account(&self.store, email);
        auth_headers(&browser, &account, &token)
    }

    async fn request(
        &self,
        method: &str,
        uri: &str,
        headers: &[(&str, String)],
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-requested-with", "XMLHttpRequest")
            .header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
        let response = self
            .app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn get(&self, uri: &str, headers: &[(&str, String)]) -> (StatusCode, Value) {
        self.request("GET", uri, headers, None).await
    }

    async fn post(&self, headers: &[(&str, String)], body: Value) -> (StatusCode, Value) {
        self.request("POST", "/api/lists", headers, Some(body)).await
    }

    async fn put(&self, id: &str, headers: &[(&str, String)], body: Value) -> (StatusCode, Value) {
        self.request("PUT", &format!("/api/lists/{id}"), headers, Some(body)).await
    }

    async fn delete(&self, id: &str, headers: &[(&str, String)]) -> (StatusCode, Value) {
        self.request("DELETE", &format!("/api/lists/{id}"), headers, None).await
    }

    async fn list_names(&self, headers: &[(&str, String)]) -> Vec<String> {
        let (status, body) = self.get("/api/lists", headers).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["lists"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["name"].as_str().unwrap().to_string())
            .collect()
    }
}

fn error_message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap()
}

#[tokio::test]
async fn lists_require_auth() {
    let fixture = Fixture::new();
    for (method, uri) in [
        ("GET", "/api/lists"),
        ("POST", "/api/lists"),
        ("PUT", "/api/lists/some-id"),
        ("DELETE", "/api/lists/some-id"),
        ("GET", "/api/lists/users"),
    ] {
        let (status, body) = fixture.request(method, uri, &[], Some(json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(body["error"]["code"], "UNAUTHORIZED");
    }
}

#[tokio::test]
async fn personal_list_crud_by_owner_is_private() {
    let fixture = Fixture::new();
    let alice = fixture.login("Alice@Example.com");
    let bob = fixture.login("bob@example.com");
    let admin = fixture.login(ADMIN);

    let (status, list) = fixture
        .post(
            &alice,
            json!({
                "name": "  Family  ",
                "kind": "personal",
                "display_mode": "list",
                "members": [
                    { "email": "mum@home.org", "name": "Mum" },
                    { "email": " dad@home.org " },
                    { "email": "MUM@home.org", "name": "Duplicate" }
                ]
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{list}");
    let id = list["id"].as_str().unwrap().to_string();
    assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
    assert_eq!(list["name"], "Family");
    assert_eq!(list["kind"], "personal");
    assert_eq!(list["display_mode"], "list");
    assert_eq!(list["owner_email"], "alice@example.com");
    assert_eq!(
        list["members"],
        json!([
            { "email": "mum@home.org", "name": "Mum" },
            { "email": "dad@home.org", "name": "" }
        ])
    );
    assert_eq!(list["can_edit"], true);
    assert_eq!(list["can_manage"], true);
    assert_eq!(list["access"], Value::Null);
    assert!(list["created_at"].as_str().unwrap().ends_with('Z'));
    assert!(list["updated_at"].as_str().unwrap().ends_with('Z'));

    // Lists are sorted by name, case-insensitively.
    let (status, _) = fixture
        .post(&alice, json!({ "name": "book club", "kind": "personal", "display_mode": "expanded", "members": [] }))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(fixture.list_names(&alice).await, vec!["book club", "Family"]);

    // Other users — admins included — neither see nor touch it.
    assert!(fixture.list_names(&bob).await.is_empty());
    assert!(fixture.list_names(&admin).await.is_empty());
    for headers in [&bob, &admin] {
        let (status, body) = fixture.put(&id, headers, json!({ "name": "Mine" })).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_message(&body), "List not found");
        let (status, _) = fixture.delete(&id, headers).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // The owner updates it; members replace the whole set.
    let (status, updated) = fixture
        .put(
            &id,
            &alice,
            json!({ "name": "Family!", "display_mode": "expanded", "members": [{ "email": "kid@home.org", "name": "Kid" }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["name"], "Family!");
    assert_eq!(updated["display_mode"], "expanded");
    assert_eq!(updated["members"], json!([{ "email": "kid@home.org", "name": "Kid" }]));
    assert_eq!(updated["created_at"], list["created_at"]);

    // A partial update leaves other fields alone.
    let (status, updated) = fixture.put(&id, &alice, json!({ "display_mode": "list" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "Family!");
    assert_eq!(updated["members"].as_array().unwrap().len(), 1);

    // Access can't be set on personal lists.
    let (status, body) = fixture
        .put(&id, &alice, json!({ "access": [{ "email": "bob@example.com", "can_edit": false }] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_message(&body), "Access can only be set on shared lists");

    let (status, body) = fixture.delete(&id, &alice).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "status": "deleted" }));
    assert_eq!(fixture.list_names(&alice).await, vec!["book club"]);
    let (status, _) = fixture.delete(&id, &alice).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn only_admins_create_shared_lists() {
    let fixture = Fixture::new();
    let bob = fixture.login("bob@example.com");
    let (status, body) = fixture
        .post(&bob, json!({ "name": "Club", "kind": "shared", "display_mode": "list", "members": [] }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_message(&body), "Only admins can create shared lists");
    assert!(fixture.list_names(&bob).await.is_empty());

    let (status, body) = fixture
        .post(
            &bob,
            json!({
                "name": "Mine", "kind": "personal", "display_mode": "list", "members": [],
                "access": [{ "email": "carol@example.com", "can_edit": true }]
            }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_message(&body), "Access can only be set on shared lists");

    // An empty access array on a personal list is fine.
    let (status, _) = fixture
        .post(&bob, json!({ "name": "Mine", "kind": "personal", "display_mode": "list", "members": [], "access": [] }))
        .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn shared_list_permissions_follow_access_entries() {
    let fixture = Fixture::new();
    let admin = fixture.login(ADMIN);
    let other_admin = fixture.login("Other-Admin@example.com");
    let user = fixture.login("User@Example.com");
    let editor = fixture.login("editor@example.com");
    let stranger = fixture.login("stranger@example.com");

    let (status, list) = fixture
        .post(
            &admin,
            json!({
                "name": "Club",
                "kind": "shared",
                "display_mode": "expanded",
                "members": [{ "email": "m1@club.org", "name": "M1" }],
                "access": [
                    { "email": " user@EXAMPLE.com ", "can_edit": false },
                    { "email": "editor@example.com", "can_edit": false },
                    { "email": "Editor@example.com", "can_edit": true }
                ]
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{list}");
    let id = list["id"].as_str().unwrap().to_string();
    assert_eq!(list["owner_email"], ADMIN);
    assert_eq!((list["can_edit"].clone(), list["can_manage"].clone()), (json!(true), json!(true)));
    let expected_access = json!([
        { "email": "editor@example.com", "can_edit": true },
        { "email": "user@example.com", "can_edit": false }
    ]);
    assert_eq!(list["access"], expected_access);

    // Every admin sees shared lists, with the access array.
    let (_, body) = fixture.get("/api/lists", &other_admin).await;
    assert_eq!(body["lists"][0]["id"], id.as_str());
    assert_eq!(body["lists"][0]["can_manage"], true);
    assert_eq!(body["lists"][0]["access"], expected_access);

    // Use-only member: sees it, can't change it, gets no access array.
    let (_, body) = fixture.get("/api/lists", &user).await;
    let seen = &body["lists"][0];
    assert_eq!(seen["id"], id.as_str());
    assert_eq!(seen["members"], json!([{ "email": "m1@club.org", "name": "M1" }]));
    assert_eq!(seen["can_edit"], false);
    assert_eq!(seen["can_manage"], false);
    assert_eq!(seen["access"], Value::Null);
    let (status, body) = fixture.put(&id, &user, json!({ "members": [] })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_message(&body), "You can't edit this list");
    let (status, body) = fixture
        .put(&id, &user, json!({ "access": [{ "email": "user@example.com", "can_edit": true }] }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_message(&body), "Only admins can manage list access");
    let (status, body) = fixture.delete(&id, &user).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_message(&body), "You can't delete this list");

    // Editor: may change members and display mode, but not access, and can't delete.
    let (status, body) = fixture
        .put(
            &id,
            &editor,
            json!({ "display_mode": "list", "members": [{ "email": "m2@club.org", "name": "M2" }] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["display_mode"], "list");
    assert_eq!(body["members"], json!([{ "email": "m2@club.org", "name": "M2" }]));
    assert_eq!(body["can_edit"], true);
    assert_eq!(body["can_manage"], false);
    assert_eq!(body["access"], Value::Null);
    let (status, body) = fixture.put(&id, &editor, json!({ "access": [] })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_message(&body), "Only admins can manage list access");
    let (status, body) = fixture.delete(&id, &editor).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_message(&body), "You can't delete this list");

    // Unlisted user: invisible.
    assert!(fixture.list_names(&stranger).await.is_empty());
    let (status, _) = fixture.put(&id, &stranger, json!({ "name": "Taken" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = fixture.delete(&id, &stranger).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Admin replaces access: the use-only user loses it, the stranger gains it.
    let (status, body) = fixture
        .put(&id, &other_admin, json!({ "access": [{ "email": "stranger@example.com", "can_edit": false }] }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["access"], json!([{ "email": "stranger@example.com", "can_edit": false }]));
    assert!(fixture.list_names(&user).await.is_empty());
    assert_eq!(fixture.list_names(&stranger).await, vec!["Club"]);

    // Access must stay on this server's domains.
    let (status, body) = fixture
        .put(&id, &admin, json!({ "access": [{ "email": "eve@elsewhere.com", "can_edit": false }] }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_message(&body), "Access can only be given to addresses allowed on this server");

    let (status, _) = fixture.delete(&id, &other_admin).await;
    assert_eq!(status, StatusCode::OK);
    assert!(fixture.list_names(&stranger).await.is_empty());
}

#[tokio::test]
async fn list_validation_errors() {
    let fixture = Fixture::new();
    let alice = fixture.login("alice@example.com");
    let valid = json!({ "name": "Team", "kind": "personal", "display_mode": "list", "members": [] });
    let with = |key: &str, value: Value| {
        let mut body = valid.clone();
        body[key] = value;
        body
    };
    let too_many: Vec<Value> = (0..501).map(|i| json!({ "email": format!("m{i}@example.com") })).collect();

    for (body, message) in [
        (with("name", json!("   ")), "List name is required"),
        (with("name", json!("x".repeat(101))), "List name is too long"),
        (with("kind", json!("public")), "Invalid list settings"),
        (with("display_mode", json!("grid")), "Invalid list settings"),
        (with("members", json!(too_many)), "A list can have at most 500 members"),
        (with("members", json!([{ "email": "bad address@example.com" }])), "A list member has an invalid email address"),
        (with("members", json!([{ "email": "a@b@c" }])), "A list member has an invalid email address"),
    ] {
        let (status, response) = fixture.post(&alice, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(error_message(&response), message);
    }
    let mut missing_name = valid.clone();
    missing_name.as_object_mut().unwrap().remove("name");
    let (status, response) = fixture.post(&alice, missing_name).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error_message(&response), "List name is required");

    let (status, list) = fixture.post(&alice, valid.clone()).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = list["id"].as_str().unwrap();
    for (body, message) in [
        (json!({ "name": "" }), "List name is required"),
        (json!({ "display_mode": "grid" }), "Invalid list settings"),
        (json!({ "members": [{ "email": "<x@y.z>" }] }), "A list member has an invalid email address"),
    ] {
        let (status, response) = fixture.put(id, &alice, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(error_message(&response), message);
    }
    // Nothing was changed by the rejected updates.
    let (_, body) = fixture.get("/api/lists", &alice).await;
    assert_eq!(body["lists"][0]["name"], "Team");
    assert_eq!(body["lists"][0]["display_mode"], "list");
}

#[tokio::test]
async fn users_endpoint_is_admin_only_and_lists_sign_ins() {
    let fixture = Fixture::new();
    let admin = fixture.login(ADMIN);
    let bob = fixture.login("bob@example.com");

    let (status, body) = fixture.get("/api/lists/users", &bob).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error_message(&body), "Only admins can manage list access");

    let (status, body) = fixture.get("/api/lists/users", &admin).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "users": [] }));

    // The login handler records sign-ins like this.
    let shared = crate::db::shared_pool::open_shared_db(fixture.data_dir.path().to_str().unwrap()).unwrap();
    crate::db::lists::record_login(&shared, "carol@example.com").unwrap();
    crate::db::lists::record_login(&shared, "bob@example.com").unwrap();

    let (status, body) = fixture.get("/api/lists/users", &admin).await;
    assert_eq!(status, StatusCode::OK);
    let users = body["users"].as_array().unwrap();
    let emails: Vec<&str> = users.iter().map(|u| u["email"].as_str().unwrap()).collect();
    assert_eq!(emails, vec!["bob@example.com", "carol@example.com"]);
    assert!(users.iter().all(|u| u["last_login"].as_str().unwrap().ends_with('Z')));
}
