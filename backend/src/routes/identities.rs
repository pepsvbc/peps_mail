use std::sync::Arc;

use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};

use crate::auth::session::SessionState;
use crate::config::AppConfig;
use crate::db;
use crate::db::identities::{CreateIdentity, UpdateIdentity};
use crate::error::AppError;

/// Reject sender addresses the signed-in mailbox does not own.
///
/// Without this, any user could send mail "From" any address and rely on
/// the SMTP server to catch it. `ALLOW_ANY_SENDER=true` lifts the check for
/// servers that enforce sender ownership themselves.
pub(crate) fn ensure_sender_allowed(
    config: &AppConfig,
    session: &SessionState,
    email: &str,
) -> Result<(), AppError> {
    if config.allow_any_sender || email.trim().eq_ignore_ascii_case(session.email.trim()) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Identities can only use the address you signed in with".to_string(),
        ))
    }
}

/// Longest display name accepted for an identity, in characters.
const MAX_DISPLAY_NAME_CHARS: usize = 100;

/// Reject display names that could pass for a different sender.
///
/// The name is free text shown by recipients' mail clients, so a name such
/// as `CEO <ceo@example.com>` would display as another address even though
/// lettre quotes it correctly. Angle brackets, `@` and control characters
/// have no place in a person's name.
pub(crate) fn validate_display_name(name: &str) -> Result<(), AppError> {
    if name.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(AppError::BadRequest(format!(
            "Display name must be {MAX_DISPLAY_NAME_CHARS} characters or fewer"
        )));
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | '@') || c.is_control())
    {
        return Err(AppError::BadRequest(
            "Display name cannot contain <, >, @ or control characters".to_string(),
        ));
    }
    Ok(())
}

/// `GET /api/identities` — list all sender identities.
pub async fn list_identities_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
) -> Result<Response, AppError> {
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Failed to open database: {e}")))?;

    let identities = db::identities::list_identities(&conn)
        .map_err(AppError::InternalError)?;

    Ok(Json(serde_json::json!({ "identities": identities })).into_response())
}

/// `GET /api/identities/:id` — get a single identity.
pub async fn get_identity_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Path(id): Path<i64>,
) -> Result<Response, AppError> {
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Failed to open database: {e}")))?;

    let identity = db::identities::get_identity(&conn, id)
        .map_err(AppError::InternalError)?;

    match identity {
        Some(i) => Ok(Json(i).into_response()),
        None => Err(AppError::NotFound("Identity not found".to_string())),
    }
}

/// `POST /api/identities` — create a new identity.
pub async fn create_identity_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Json(data): Json<CreateIdentity>,
) -> Result<Response, AppError> {
    if data.email.trim().is_empty() {
        return Err(AppError::BadRequest("Email is required".to_string()));
    }
    validate_display_name(&data.display_name)?;
    ensure_sender_allowed(&config, &session, &data.email)?;

    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Failed to open database: {e}")))?;

    let identity = db::identities::create_identity(&conn, &data)
        .map_err(AppError::InternalError)?;

    Ok((axum::http::StatusCode::CREATED, Json(identity)).into_response())
}

/// `PUT /api/identities/:id` — update an identity.
pub async fn update_identity_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Path(id): Path<i64>,
    Json(data): Json<UpdateIdentity>,
) -> Result<Response, AppError> {
    if let Some(name) = &data.display_name {
        validate_display_name(name)?;
    }
    if let Some(email) = &data.email {
        ensure_sender_allowed(&config, &session, email)?;
    }
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Failed to open database: {e}")))?;

    match db::identities::update_identity(&conn, id, &data)
        .map_err(AppError::InternalError)?
    {
        Some(identity) => Ok(Json(identity).into_response()),
        None => Err(AppError::NotFound("Identity not found".to_string())),
    }
}

/// `DELETE /api/identities/:id` — delete an identity.
pub async fn delete_identity_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Path(id): Path<i64>,
) -> Result<Response, AppError> {
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Failed to open database: {e}")))?;

    if db::identities::delete_identity(&conn, id)
        .map_err(AppError::InternalError)?
    {
        Ok(Json(serde_json::json!({ "status": "deleted" })).into_response())
    } else {
        Err(AppError::NotFound("Identity not found".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_display_names_are_accepted() {
        for name in ["", "Alice Smith", "Zoë O'Brien-Müller", "Support (Acme)", "\"Al\" Capone"] {
            assert!(validate_display_name(name).is_ok(), "{name:?}");
        }
    }

    #[test]
    fn spoofing_display_names_are_rejected() {
        for name in [
            "CEO <ceo@example.com>",
            "ceo@example.com",
            "Alice <",
            "Alice >",
            "Alice\r\nBcc: victim@example.com",
            "Alice\u{7}",
        ] {
            assert!(
                matches!(validate_display_name(name), Err(AppError::BadRequest(_))),
                "{name:?} should be rejected"
            );
        }
        assert!(validate_display_name(&"a".repeat(MAX_DISPLAY_NAME_CHARS)).is_ok());
        assert!(validate_display_name(&"a".repeat(MAX_DISPLAY_NAME_CHARS + 1)).is_err());
    }
}
