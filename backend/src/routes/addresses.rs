use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::Query;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::auth::session::SessionState;
use crate::config::AppConfig;
use crate::db;
use crate::db::known_addresses::KnownAddress;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Query / response types
// ---------------------------------------------------------------------------

/// Query parameters for `GET /api/addresses/autocomplete`.
#[derive(Deserialize)]
pub struct AutocompleteParams {
    /// Search query; blank queries return no suggestions.
    pub q: Option<String>,
    /// Maximum number of suggestions (default 10).
    #[serde(default = "default_autocomplete_limit")]
    pub limit: u32,
}

fn default_autocomplete_limit() -> u32 {
    10
}

/// Largest number of suggestions a client may request at once.
const MAX_AUTOCOMPLETE_LIMIT: u32 = 500;

/// Cap on the number of addresses returned for client-side search.
const MAX_ALL_ADDRESSES: u32 = 50000;

/// A single autocomplete suggestion.
#[derive(Serialize)]
pub struct AutocompleteSuggestion {
    pub email: String,
    pub name: String,
    pub source: &'static str,
}

/// Response envelope for the autocomplete endpoints.
#[derive(Serialize)]
pub struct AutocompleteResponse {
    pub suggestions: Vec<AutocompleteSuggestion>,
}

/// Convert known addresses into suggestions, dropping case-insensitive
/// duplicate emails.
fn to_suggestions(known: Vec<KnownAddress>) -> Vec<AutocompleteSuggestion> {
    let mut seen_emails = HashSet::new();
    known
        .into_iter()
        .filter(|k| seen_emails.insert(k.email.to_lowercase()))
        .map(|k| AutocompleteSuggestion {
            email: k.email,
            name: k.name,
            source: "known",
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `GET /api/addresses/autocomplete?q=al&limit=10`
///
/// Returns known addresses (collected from message headers) whose email or
/// name contains `q`.
pub async fn autocomplete_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Query(mut params): Query<AutocompleteParams>,
) -> Result<Response, AppError> {
    params.limit = params.limit.clamp(1, MAX_AUTOCOMPLETE_LIMIT);
    let query = match params.q.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(q) => q,
        None => {
            return Ok(Json(AutocompleteResponse {
                suggestions: vec![],
            })
            .into_response());
        }
    };

    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    let known = db::known_addresses::search_known_addresses(&conn, query, params.limit)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    Ok(Json(AutocompleteResponse {
        suggestions: to_suggestions(known),
    })
    .into_response())
}

/// `GET /api/addresses/autocomplete/all`
///
/// Returns all known addresses for client-side autocomplete.
/// Used for prefetching to enable instant fuzzy search without network latency.
pub async fn autocomplete_all_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
) -> Result<Response, AppError> {
    let conn = db::pool::open_user_db(&config.data_dir, &session.user_hash)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    let known = db::known_addresses::search_known_addresses(&conn, "", MAX_ALL_ADDRESSES)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))?;

    Ok(Json(AutocompleteResponse {
        suggestions: to_suggestions(known),
    })
    .into_response())
}
