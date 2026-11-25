use super::*;
use crate::integrations::franklymail::{self, config::Config};

fn app(temp: &TempDir, enabled: bool, store: Arc<SessionStore>) -> Router {
    app_with_admins(temp, enabled, store, "admin@example.com")
}

fn app_with_admins(
    temp: &TempDir,
    enabled: bool,
    store: Arc<SessionStore>,
    franklymail_admins: &str,
) -> Router {
    let mut config = (*test_config_with_imap("nonexistent", temp.path().to_str().unwrap())).clone();
    // Distribution-list administrators; deliberately not FranklyMail admins.
    config.admin_emails = Some("admin@example.com,lists@example.com".into());
    let provider = Config {
        enabled,
        api_key: "server-only-test-secret".into(),
        domains: "example.com".into(),
        admin_emails: franklymail_admins.into(),
        ..Default::default()
    };
    let extension = franklymail::router(provider, &config).unwrap();
    create_router_with_integrations(
        Arc::new(config),
        store,
        test_imap_client(),
        test_smtp_client(),
        test_search_engine(temp.path().to_str().unwrap()),
        test_event_bus(),
        test_idle_manager(),
        extension,
    )
}

#[tokio::test]
async fn disabled_integration_has_no_private_routes_or_storage() {
    let temp = TempDir::new().unwrap();
    let router = app(&temp, false, test_store());
    let res = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/integrations/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["franklymail"], false);
    assert!(!temp.path().join("integrations").exists());
    assert!(!String::from_utf8_lossy(&body).contains("server-only-test-secret"));
    let res = router
        .oneshot(
            Request::builder()
                .uri("/api/integrations/franklymail/mailboxes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn non_admin_cannot_read_or_mutate_provider_settings() {
    let temp = TempDir::new().unwrap();
    let store = test_store();
    let (browser, account, token) = setup_test_account(&store, "member@example.com");
    let router = app(&temp, true, store);
    for (method, path, body) in [
        ("GET", "/mailboxes", ""),
        ("GET", "/settings?email=admin@example.com", ""),
        (
            "POST",
            "/mailboxes",
            r#"{"email":"new@example.com","personal_email":"owner@other.org"}"#,
        ),
        (
            "POST",
            "/recovery",
            r#"{"email":"admin@example.com","personal_email":"attacker@other.org"}"#,
        ),
        (
            "POST",
            "/mailboxes/delete",
            r#"{"email":"admin@example.com","mailbox_id":"00000000-0000-0000-0000-000000000002","confirmation":"admin@example.com"}"#,
        ),
        (
            "PUT",
            "/forwarding",
            r#"{"email":"admin@example.com","revision":"x","forwarding":{"enabled":true,"address":"attacker@other.org","keep_copy":false}}"#,
        ),
    ] {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/integrations/franklymail{path}"))
            .header("content-type", "application/json")
            .header("x-requested-with", "XMLHttpRequest");
        for (name, value) in auth_headers(&browser, &account, &token) {
            request = request.header(name, value);
        }
        let res = router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} {path}");
    }
}

async fn account_flags(router: &Router, store: &Arc<SessionStore>, email: &str) -> serde_json::Value {
    let (browser, account, token) = setup_test_account(store, email);
    let mut request = Request::builder().uri("/api/integrations/franklymail/account");
    for (name, value) in auth_headers(&browser, &account, &token) {
        request = request.header(name, value);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn distribution_list_admins_are_not_franklymail_admins() {
    let temp = TempDir::new().unwrap();
    let store = test_store();
    // FRANKLYMAIL_ADMIN_EMAILS unset: nobody administers FranklyMail, even
    // though ADMIN_EMAILS lists this address.
    let router = app_with_admins(&temp, true, store.clone(), "");
    assert_eq!(account_flags(&router, &store, "admin@example.com").await["admin"], false);
    let (browser, account, token) = setup_test_account(&store, "admin@example.com");
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/integrations/franklymail/recovery")
        .header("content-type", "application/json")
        .header("x-requested-with", "XMLHttpRequest");
    for (name, value) in auth_headers(&browser, &account, &token) {
        request = request.header(name, value);
    }
    let res = router
        .oneshot(
            request
                .body(Body::from(
                    r#"{"email":"member@example.com","personal_email":"attacker@other.org"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    let store = test_store();
    let router = app_with_admins(&temp, true, store.clone(), "ADMIN@example.com");
    assert_eq!(account_flags(&router, &store, "admin@example.com").await["admin"], true);
    assert_eq!(account_flags(&router, &store, "lists@example.com").await["admin"], false);
    assert_eq!(account_flags(&router, &store, "member@example.com").await["admin"], false);
}

#[tokio::test]
async fn anonymous_recovery_floods_do_not_rate_limit_signed_in_routes() {
    let temp = TempDir::new().unwrap();
    let store = test_store();
    let router = app(&temp, true, store.clone());
    let mut limited = false;
    for _ in 0..15 {
        let res = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/integrations/franklymail/recovery/request")
                    .header("content-type", "application/json")
                    .header("x-requested-with", "XMLHttpRequest")
                    .body(Body::from(r#"{"email":"member@example.com"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        limited |= res.status() == StatusCode::TOO_MANY_REQUESTS;
    }
    assert!(limited, "the public bucket should be exhausted");
    assert_eq!(account_flags(&router, &store, "admin@example.com").await["admin"], true);
}

#[tokio::test]
async fn admin_is_still_bound_to_allowed_domains_and_csrf() {
    let temp = TempDir::new().unwrap();
    let store = test_store();
    let (browser, account, token) = setup_test_account(&store, "admin@example.com");
    let router = app(&temp, true, store.clone());
    let mut request =
        Request::builder().uri("/api/integrations/franklymail/settings?email=victim@elsewhere.org");
    for (name, value) in auth_headers(&browser, &account, &token) {
        request = request.header(name, value);
    }
    let res = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let mut request = Request::builder()
        .method("PUT")
        .uri("/api/integrations/franklymail/forwarding")
        .header("content-type", "application/json");
    for (name, value) in auth_headers(&browser, &account, &token) {
        request = request.header(name, value);
    }
    let res = router
        .oneshot(request.body(Body::from("{}")).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let (_, other_account, _) = setup_test_account(&store, "other@example.com");
    let (_, second_admin, _) = setup_test_account(&store, "admin@example.com");
    store.revoke_mailbox("ADMIN@example.com", "imap.example.com");
    assert!(!store.remove_account(&account));
    assert!(!store.remove_account(&second_admin));
    assert!(store.remove_account(&other_account));
}

#[tokio::test]
async fn self_password_routes_allow_members_but_enforce_target_and_csrf() {
    let temp = TempDir::new().unwrap();
    let store = test_store();
    let (browser, account, token) = setup_test_account(&store, "member@example.com");
    let router = app(&temp, true, store.clone());
    let mut request = Request::builder().uri("/api/integrations/franklymail/account");
    for (name, value) in auth_headers(&browser, &account, &token) {
        request = request.header(name, value);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["change_password"], true);
    for (body, csrf, status) in [
        (
            r#"{"current_password":"old","new_password":"short"}"#,
            true,
            StatusCode::BAD_REQUEST,
        ),
        (
            r#"{"email":"admin@example.com","current_password":"old","new_password":"new-long-password"}"#,
            true,
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            r#"{"current_password":"old","new_password":"new-long-password"}"#,
            false,
            StatusCode::FORBIDDEN,
        ),
    ] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/integrations/franklymail/password")
            .header("content-type", "application/json");
        if csrf {
            request = request.header("x-requested-with", "XMLHttpRequest");
        }
        for (name, value) in auth_headers(&browser, &account, &token) {
            request = request.header(name, value);
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let (browser, account, token) = setup_test_account(&store, "outsider@other.org");
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/integrations/franklymail/password")
        .header("content-type", "application/json")
        .header("x-requested-with", "XMLHttpRequest");
    for (name, value) in auth_headers(&browser, &account, &token) {
        request = request.header(name, value);
    }
    let response = router
        .oneshot(
            request
                .body(Body::from(
                    r#"{"current_password":"old","new_password":"new-long-password"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn delete_mailbox_requires_authentication_and_csrf() {
    let temp = TempDir::new().unwrap();
    let store = test_store();
    let (browser, account, token) = setup_test_account(&store, "admin@example.com");
    let router = app(&temp, true, store);
    for authenticated in [false, true] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/integrations/franklymail/mailboxes/delete")
            .header("content-type", "application/json");
        if authenticated {
            for (name, value) in auth_headers(&browser, &account, &token) {
                request = request.header(name, value);
            }
        } else {
            request = request.header("x-requested-with", "XMLHttpRequest");
        }
        let response = router.clone().oneshot(request.body(Body::from(r#"{"email":"member@example.com","mailbox_id":"00000000-0000-0000-0000-000000000002","confirmation":"member@example.com"}"#)).unwrap()).await.unwrap();
        assert_eq!(
            response.status(),
            if authenticated {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
}
