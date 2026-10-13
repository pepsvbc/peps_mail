use super::*;

fn setup_router(config: AppConfig) -> Router {
    let search_engine = test_search_engine(&config.data_dir);
    create_router(
        Arc::new(config),
        test_store(),
        test_imap_client(),
        test_smtp_client(),
        search_engine,
        test_event_bus(),
        test_idle_manager(),
    )
}

async fn public_get(app: Router, uri: &str) -> axum::response::Response {
    app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn setup_settings_are_public_and_expose_only_connection_details() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let mut config = (*test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    ))
    .clone();
    config.imap_host = Some("imap.purelymail.com".to_string());
    config.smtp_host = Some("smtp.purelymail.com".to_string());

    let response = public_get(setup_router(config), "/api/setup").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "imap": {"host": "imap.purelymail.com", "port": 993, "security": "SSL/TLS"},
            "smtp": {"host": "smtp.purelymail.com", "port": 587, "security": "STARTTLS"},
            "apple_profile_url": "/api/setup/apple.mobileconfig"
        })
    );
}

#[tokio::test]
async fn setup_settings_and_download_support_base_path_and_smtp_tls_port() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let mut config = (*test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    ))
    .clone();
    config.base_path = Some("/mail".to_string());
    config.imap_port = 1993;
    config.smtp_port = 465;
    let app = setup_router(config);

    let response = public_get(app.clone(), "/mail/api/setup").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["smtp"]["security"], "SSL/TLS");
    assert_eq!(json["imap"]["port"], 1993);
    let download_url = json["apple_profile_url"].as_str().unwrap();
    assert_eq!(download_url, "/mail/api/setup/apple.mobileconfig");

    let response = public_get(app, download_url).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let xml = std::str::from_utf8(&body).unwrap();
    assert!(xml.contains("<key>IncomingMailServerPortNumber</key><integer>1993</integer>"));
    assert!(xml.contains("<key>OutgoingMailServerPortNumber</key><integer>465</integer>"));
}

#[tokio::test]
async fn setup_settings_match_smtp_client_tls_behavior_on_custom_ports() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let mut config = (*test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    ))
    .clone();
    config.smtp_port = 1465;

    let response = public_get(setup_router(config), "/api/setup").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["smtp"]["port"], 1465);
    assert_eq!(json["smtp"]["security"], "SSL/TLS");
}

#[tokio::test]
async fn setup_profile_is_public_mail_only_and_prompts_for_credentials() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let config = (*test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    ))
    .clone();

    let response = public_get(
        setup_router(config),
        "/api/setup/apple.mobileconfig?email=private%40example.com&password=do-not-include&host=evil.example.com",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        "application/x-apple-aspen-config"
    );
    assert_eq!(
        response.headers()["content-disposition"],
        "attachment; filename=\"peps-vbc-mail.mobileconfig\""
    );
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let xml = std::str::from_utf8(&body).unwrap();
    assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
    assert!(xml.contains("<plist version=\"1.0\">"));
    assert!(xml.ends_with("</plist>\n"));
    assert!(xml.contains("<key>PayloadType</key><string>Configuration</string>"));
    assert!(xml.contains("<key>PayloadType</key><string>com.apple.mail.managed</string>"));
    assert_eq!(xml.matches("<key>PayloadType</key>").count(), 2);
    assert!(xml.contains("<key>EmailAccountType</key><string>EmailTypeIMAP</string>"));
    assert!(xml.contains("<key>IncomingMailServerHostName</key><string>imap.example.com</string>"));
    assert!(xml.contains("<key>OutgoingMailServerHostName</key><string>smtp.example.com</string>"));
    assert!(xml.contains("<key>IncomingMailServerPortNumber</key><integer>993</integer>"));
    assert!(xml.contains("<key>OutgoingMailServerPortNumber</key><integer>587</integer>"));
    for key in [
        "IncomingMailServerUseSSL",
        "OutgoingMailServerUseSSL",
        "OutgoingPasswordSameAsIncomingPassword",
    ] {
        assert!(xml.contains(&format!("<key>{key}</key><true/>")));
    }
    for key in [
        "IncomingMailServerAuthentication",
        "OutgoingMailServerAuthentication",
    ] {
        assert!(xml.contains(&format!(
            "<key>{key}</key><string>EmailAuthPassword</string>"
        )));
    }
    for key in [
        "EmailAddress",
        "EmailAccountName",
        "IncomingMailServerUsername",
        "OutgoingMailServerUsername",
        "IncomingPassword",
        "OutgoingPassword",
    ] {
        assert!(!xml.contains(&format!("<key>{key}</key>")));
    }
    for query_value in ["private", "do-not-include", "evil.example.com"] {
        assert!(!xml.contains(query_value));
    }
    let uuid_pattern = regex::Regex::new("<key>PayloadUUID</key><string>([^<]+)</string>").unwrap();
    let uuids: Vec<_> = uuid_pattern
        .captures_iter(xml)
        .map(|capture| uuid::Uuid::parse_str(&capture[1]).unwrap())
        .collect();
    assert_eq!(uuids.len(), 2);
    assert_ne!(uuids[0], uuids[1]);
}

#[tokio::test]
async fn setup_profile_downloads_have_distinct_identifiers_for_multiple_accounts() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let config = (*test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    ))
    .clone();
    let app = setup_router(config);
    let mut identifiers = std::collections::HashSet::new();
    let mut uuids = std::collections::HashSet::new();
    let identifier_pattern =
        regex::Regex::new("<key>PayloadIdentifier</key><string>([^<]+)</string>").unwrap();
    let uuid_pattern = regex::Regex::new("<key>PayloadUUID</key><string>([^<]+)</string>").unwrap();
    for _ in 0..2 {
        let response = public_get(app.clone(), "/api/setup/apple.mobileconfig").await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let xml = std::str::from_utf8(&body).unwrap();
        for capture in identifier_pattern.captures_iter(xml) {
            assert!(identifiers.insert(capture[1].to_string()));
        }
        for capture in uuid_pattern.captures_iter(xml) {
            assert!(uuids.insert(uuid::Uuid::parse_str(&capture[1]).unwrap()));
        }
    }
    assert_eq!(identifiers.len(), 4);
    assert_eq!(uuids.len(), 4);
}

#[tokio::test]
async fn setup_profile_escapes_configured_hosts_as_xml_text() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let mut config = (*test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    ))
    .clone();
    config.imap_host = Some("imap</string><key>Injected</key><true/>\"'&.example.com".into());
    config.smtp_host = Some("smtp&<>'\".example.com".into());

    let response = public_get(setup_router(config), "/api/setup/apple.mobileconfig").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let xml = std::str::from_utf8(&body).unwrap();
    assert!(xml.contains("imap&lt;/string&gt;&lt;key&gt;Injected&lt;/key&gt;&lt;true/&gt;&quot;&apos;&amp;.example.com"));
    assert!(xml.contains("smtp&amp;&lt;&gt;&apos;&quot;.example.com"));
    assert!(!xml.contains("<key>Injected</key>"));
}

#[tokio::test]
async fn setup_endpoints_reject_missing_or_insecure_configuration() {
    let static_dir = setup_static_dir();
    let data_dir = TempDir::new().unwrap();
    let config = (*test_config_with_smtp(
        static_dir.path().to_str().unwrap(),
        data_dir.path().to_str().unwrap(),
    ))
    .clone();

    for invalid_case in 0..8 {
        let mut config = config.clone();
        match invalid_case {
            0 => config.imap_host = None,
            1 => config.smtp_host = None,
            2 => config.imap_host = Some("  ".into()),
            3 => config.smtp_host = Some("smtp\0.example.com".into()),
            4 => config.tls_enabled = false,
            5 => config.imap_port = 0,
            6 => config.smtp_port = 0,
            7 => config.imap_host = Some("imap\u{ffff}.example.com".into()),
            _ => unreachable!(),
        }
        let app = setup_router(config);
        for uri in ["/api/setup", "/api/setup/apple.mobileconfig"] {
            let response = public_get(app.clone(), uri).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["error"]["code"], "SERVICE_UNAVAILABLE");
            assert_eq!(
                json["error"]["message"],
                "Secure mail setup is not configured on this server."
            );
        }
    }
}
