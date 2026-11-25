use crate::error::AppError;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub struct ManagementClient {
    http: Client,
    key: String,
    base: String,
}

#[derive(Deserialize)]
struct Mailboxes {
    mailboxes: Vec<Mailbox>,
}
#[derive(Deserialize, Serialize)]
pub struct Mailbox {
    pub id: uuid::Uuid,
    pub address: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub script: String,
    pub managed_rules_present: bool,
}

fn unavailable() -> AppError {
    AppError::ServiceUnavailable("FranklyMail could not confirm this operation. Refresh settings before retrying; contact your administrator if it persists.".into())
}

impl ManagementClient {
    #[cfg(test)]
    pub(super) fn test_client(base: String) -> Self {
        let mut client = Self::new("test-secret".into()).unwrap();
        client.base = base;
        client
    }
    pub fn new(key: String) -> Result<Self, reqwest::Error> {
        Ok(Self {
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            key,
            base: "https://franklymail.com/api".into(),
        })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.key);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| unavailable())?;
        if !response.status().is_success() {
            // Never forward raw provider responses: password endpoints may contain secrets.
            tracing::warn!(
                status = response.status().as_u16(),
                "FranklyMail management request failed"
            );
            return Err(unavailable());
        }
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response.json().await.map_err(|_| unavailable())
    }

    /// Resolve an authorized address to a provider ID; callers enforce domain/admin access.
    pub async fn mailbox(&self, email: &str) -> Result<uuid::Uuid, AppError> {
        let matches: Vec<_> = self
            .mailboxes()
            .await?
            .into_iter()
            .filter(|m| m.address.eq_ignore_ascii_case(email))
            .collect();
        if matches.len() != 1 {
            return Err(AppError::Forbidden(
                "This mailbox is not managed by this FranklyMail integration".into(),
            ));
        }
        Ok(matches[0].id)
    }

    pub async fn mailboxes(&self) -> Result<Vec<Mailbox>, AppError> {
        let list: Mailboxes =
            serde_json::from_value(self.request(Method::GET, "/mailboxes", None).await?)
                .map_err(|_| unavailable())?;
        Ok(list.mailboxes)
    }

    pub async fn create_mailbox(&self, email: &str) -> Result<(), AppError> {
        #[derive(Deserialize)]
        struct Domain {
            id: uuid::Uuid,
            domain: String,
        }
        #[derive(Deserialize)]
        struct Domains {
            domains: Vec<Domain>,
        }
        let (local, domain) = email
            .rsplit_once('@')
            .ok_or_else(|| AppError::BadRequest("Invalid mailbox address".into()))?;
        let domains: Domains =
            serde_json::from_value(self.request(Method::GET, "/domains", None).await?)
                .map_err(|_| unavailable())?;
        let domain = domains
            .domains
            .into_iter()
            .find(|d| d.domain.eq_ignore_ascii_case(domain))
            .ok_or_else(|| {
                AppError::BadRequest("This domain is not configured in FranklyMail".into())
            })?;
        // Nobody receives this initial credential. The recipient chooses their
        // password using a short-lived token delivered to their personal address.
        let password = crate::auth::session::SessionStore::generate_token();
        self.request(
            Method::POST,
            "/mailboxes",
            Some(json!({"domainId":domain.id,"localPart":local,"password":password})),
        )
        .await?;
        Ok(())
    }

    pub async fn password(&self, id: uuid::Uuid, password: &str) -> Result<(), AppError> {
        self.request(
            Method::POST,
            &format!("/mailboxes/{id}/password"),
            Some(json!({"password":password})),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_mailbox(&self, id: uuid::Uuid) -> Result<(), AppError> {
        // No destruction options: FranklyMail retains the mailbox's mail.
        self.request(Method::DELETE, &format!("/mailboxes/{id}"), None)
            .await?;
        Ok(())
    }

    pub async fn script(&self, id: uuid::Uuid) -> Result<Script, AppError> {
        serde_json::from_value(
            self.request(Method::GET, &format!("/mailboxes/{id}/sieve"), None)
                .await?,
        )
        .map_err(|_| unavailable())
    }

    pub async fn save_script(&self, id: uuid::Uuid, script: &str) -> Result<(), AppError> {
        let validation = self
            .request(
                Method::POST,
                "/sieve/validate",
                Some(json!({"script":script})),
            )
            .await?;
        if validation.get("valid") == Some(&Value::Bool(false)) {
            return Err(AppError::BadRequest(
                "FranklyMail rejected the forwarding script".into(),
            ));
        }
        self.request(
            Method::PUT,
            &format!("/mailboxes/{id}/sieve"),
            Some(json!({"script":script})),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing::{get, post, put},
    };
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn management_contract_and_failed_validation_never_write() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let router = Router::new()
            .route("/mailboxes", get(|headers: HeaderMap| async move {
                assert_eq!(headers["authorization"],"Bearer test-secret");
                Json(json!({"mailboxes":[{"id":"00000000-0000-0000-0000-000000000001","address":"user@example.com"}]}))
            }))
            .route("/mailboxes/{id}/password", post(|Json(body): Json<Value>| async move {
                assert_eq!(body["password"],"my-new-password");
                Json(json!({"password":"must-never-reach-browser","status":"provisioning"}))
            }))
            .route("/mailboxes/{id}/sieve", get(|| async { Json(json!({"script":"keep;","managedRulesPresent":false})) }).merge(put(move |Json(body): Json<Value>| {
                recorded.lock().unwrap().push(body);
                async { Json(json!({"ok":true})) }
            })))
            .route("/sieve/validate", post(|Json(body): Json<Value>| async move {
                if body["script"] == "bad" { (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"error":{"message":"secret upstream detail"}}))) }
                else { (StatusCode::OK,Json(json!({"valid":true}))) }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut client = ManagementClient::new("test-secret".into()).unwrap();
        client.base = base;
        let id = client.mailbox("USER@example.com").await.unwrap();
        assert!(client.mailbox("other@example.com").await.is_err());
        client.password(id, "my-new-password").await.unwrap();
        assert_eq!(client.script(id).await.unwrap().script, "keep;");
        assert!(client.save_script(id, "bad").await.is_err());
        assert!(calls.lock().unwrap().is_empty());
        client.save_script(id, "keep;").await.unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1);
        server.abort();
    }
}
