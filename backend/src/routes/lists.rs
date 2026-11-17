use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::auth::session::SessionState;
use crate::config::AppConfig;
use crate::db;
use crate::db::lists::{DistributionList, ListAccess, ListChanges, ListMember, NewList};
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Limits and messages
// ---------------------------------------------------------------------------

const MAX_NAME_CHARS: usize = 100;
const MAX_MEMBERS: usize = 500;
const MAX_MEMBER_NAME_CHARS: usize = 200;
const MAX_ACCESS_ENTRIES: usize = 500;
const MAX_EMAIL_CHARS: usize = 254;

// The frontend translates these by their exact text.
const NAME_REQUIRED: &str = "List name is required";
const NAME_TOO_LONG: &str = "List name is too long";
const INVALID_SETTINGS: &str = "Invalid list settings";
const TOO_MANY_MEMBERS: &str = "A list can have at most 500 members";
const INVALID_MEMBER: &str = "A list member has an invalid email address";
const INVALID_ACCESS: &str = "Access can only be given to addresses allowed on this server";
const ACCESS_ON_PERSONAL: &str = "Access can only be set on shared lists";
const SHARED_ADMIN_ONLY: &str = "Only admins can create shared lists";
const ACCESS_ADMIN_ONLY: &str = "Only admins can manage list access";
const CANNOT_EDIT: &str = "You can't edit this list";
const CANNOT_DELETE: &str = "You can't delete this list";
const NOT_FOUND: &str = "List not found";

const KINDS: [&str; 2] = ["personal", "shared"];
const DISPLAY_MODES: [&str; 2] = ["list", "expanded"];

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

/// A member as sent by the client.
#[derive(Deserialize)]
pub struct MemberInput {
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// An access entry as sent by the client.
#[derive(Deserialize)]
pub struct AccessInput {
    pub email: String,
    #[serde(default)]
    pub can_edit: bool,
}

/// Body of `POST /api/lists`.
#[derive(Deserialize)]
pub struct CreateListRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub display_mode: Option<String>,
    #[serde(default)]
    pub members: Vec<MemberInput>,
    #[serde(default)]
    pub access: Option<Vec<AccessInput>>,
}

/// Body of `PUT /api/lists/{id}`; omitted fields are left unchanged.
#[derive(Deserialize)]
pub struct UpdateListRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub display_mode: Option<String>,
    #[serde(default)]
    pub members: Option<Vec<MemberInput>>,
    #[serde(default)]
    pub access: Option<Vec<AccessInput>>,
}

/// A distribution list as seen by the caller.
#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub display_mode: String,
    pub owner_email: String,
    pub members: Vec<ListMember>,
    /// The caller may change name, display mode and members.
    pub can_edit: bool,
    /// The caller may delete the list (and manage access on shared lists).
    pub can_manage: bool,
    /// Access entries; only for shared lists viewed by an admin.
    pub access: Option<Vec<ListAccess>>,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/// The signed-in user acting on lists.
struct Caller {
    email: String,
    is_admin: bool,
}

impl Caller {
    fn new(session: &SessionState, config: &AppConfig) -> Self {
        let email = session.email.trim().to_ascii_lowercase();
        let is_admin = config.is_admin(&email);
        Self { email, is_admin }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Permissions {
    can_edit: bool,
    can_manage: bool,
}

/// What `caller` may do with `list`; `None` when the list is invisible to them.
fn permissions(list: &DistributionList, caller: &Caller) -> Option<Permissions> {
    let full = Permissions {
        can_edit: true,
        can_manage: true,
    };
    match list.kind.as_str() {
        "personal" => (list.owner_email == caller.email).then_some(full),
        "shared" if caller.is_admin => Some(full),
        "shared" => list
            .access
            .iter()
            .find(|entry| entry.email == caller.email)
            .map(|entry| Permissions {
                can_edit: entry.can_edit,
                can_manage: false,
            }),
        _ => None,
    }
}

fn to_response(list: DistributionList, perms: Permissions, caller: &Caller) -> ListResponse {
    let access = (list.kind == "shared" && caller.is_admin).then_some(list.access);
    ListResponse {
        id: list.id,
        name: list.name,
        kind: list.kind,
        display_mode: list.display_mode,
        owner_email: list.owner_email,
        members: list.members,
        can_edit: perms.can_edit,
        can_manage: perms.can_manage,
        access,
        created_at: list.created_at,
        updated_at: list.updated_at,
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// The kind of a list that is (or is not) shared with someone.
fn kind_for_access(shared: bool) -> &'static str {
    if shared { "shared" } else { "personal" }
}

fn bad_request(message: &str) -> AppError {
    AppError::BadRequest(message.to_string())
}

/// Trimmed list name of 1..=100 characters.
pub(crate) fn validate_name(name: Option<&str>) -> Result<String, AppError> {
    let name = name.unwrap_or_default().trim();
    if name.is_empty() {
        return Err(bad_request(NAME_REQUIRED));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(bad_request(NAME_TOO_LONG));
    }
    Ok(name.to_string())
}

/// `value` when it is one of `allowed`.
pub(crate) fn validate_choice(value: Option<&str>, allowed: &[&str]) -> Result<String, AppError> {
    match value {
        Some(value) if allowed.contains(&value) => Ok(value.to_string()),
        _ => Err(bad_request(INVALID_SETTINGS)),
    }
}

/// Basic address check for an already-trimmed email: at most 254 chars,
/// exactly one `@` with a non-empty local part and domain, and no
/// whitespace, control characters or address punctuation.
pub(crate) fn is_valid_address(email: &str) -> bool {
    const FORBIDDEN: &[char] = &['<', '>', ',', ';', ':', '"', '(', ')', '[', ']', '\\'];
    if email.chars().count() > MAX_EMAIL_CHARS
        || email
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || FORBIDDEN.contains(&c))
    {
        return false;
    }
    match email.split_once('@') {
        Some((local, domain)) => !local.is_empty() && !domain.is_empty() && !domain.contains('@'),
        None => false,
    }
}

/// Trim and check members, truncate long names and drop case-insensitive
/// duplicate emails (keeping the first).
pub(crate) fn validate_members(members: Vec<MemberInput>) -> Result<Vec<ListMember>, AppError> {
    if members.len() > MAX_MEMBERS {
        return Err(bad_request(TOO_MANY_MEMBERS));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(members.len());
    for member in members {
        let email = member.email.trim();
        if !is_valid_address(email) {
            return Err(bad_request(INVALID_MEMBER));
        }
        if !seen.insert(email.to_lowercase()) {
            continue;
        }
        let name: String = member
            .name
            .unwrap_or_default()
            .trim()
            .chars()
            .take(MAX_MEMBER_NAME_CHARS)
            .collect();
        result.push(ListMember {
            email: email.to_string(),
            name: name.trim_end().to_string(),
        });
    }
    Ok(result)
}

/// Trim and lower-case access emails, require addresses allowed on this
/// server, and collapse duplicates (editing wins).
pub(crate) fn validate_access(
    access: Vec<AccessInput>,
    config: &AppConfig,
) -> Result<Vec<ListAccess>, AppError> {
    if access.len() > MAX_ACCESS_ENTRIES {
        return Err(bad_request(INVALID_SETTINGS));
    }
    let mut result: Vec<ListAccess> = Vec::with_capacity(access.len());
    for entry in access {
        let email = entry.email.trim().to_ascii_lowercase();
        if !is_valid_address(&email) || !config.is_email_domain_allowed(&email) {
            return Err(bad_request(INVALID_ACCESS));
        }
        match result.iter_mut().find(|existing| existing.email == email) {
            Some(existing) => existing.can_edit |= entry.can_edit,
            None => result.push(ListAccess {
                email,
                can_edit: entry.can_edit,
            }),
        }
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn open_db(config: &AppConfig) -> Result<Connection, AppError> {
    db::shared_pool::open_shared_db(&config.data_dir)
        .map_err(|e| AppError::InternalError(format!("Database error: {e}")))
}

/// Load a list the caller can see, with their permissions on it.
fn load_visible(
    conn: &Connection,
    id: &str,
    caller: &Caller,
) -> Result<(DistributionList, Permissions), AppError> {
    let list = db::lists::get_list(conn, id)
        .map_err(AppError::InternalError)?
        .ok_or_else(|| AppError::NotFound(NOT_FOUND.to_string()))?;
    let perms =
        permissions(&list, caller).ok_or_else(|| AppError::NotFound(NOT_FOUND.to_string()))?;
    Ok((list, perms))
}

/// `GET /api/lists` — every list visible to the caller, sorted by name.
pub async fn list_lists_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
) -> Result<Response, AppError> {
    let caller = Caller::new(&session, &config);
    let conn = open_db(&config)?;
    let lists = db::lists::visible_lists(&conn, &caller.email, caller.is_admin)
        .map_err(AppError::InternalError)?
        .into_iter()
        .filter_map(|list| {
            let perms = permissions(&list, &caller)?;
            Some(to_response(list, perms, &caller))
        })
        .collect::<Vec<_>>();
    Ok(Json(serde_json::json!({ "lists": lists })).into_response())
}

/// `POST /api/lists` — create a list owned by the caller.
pub async fn create_list_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Json(data): Json<CreateListRequest>,
) -> Result<Response, AppError> {
    let caller = Caller::new(&session, &config);
    let name = validate_name(data.name.as_deref())?;
    let access = data.access.unwrap_or_default();
    // Without an explicit kind, a list is shared exactly when it is shared with someone.
    let kind = match data.kind.as_deref() {
        None => kind_for_access(!access.is_empty()).to_string(),
        kind => validate_choice(kind, &KINDS)?,
    };
    let display_mode = validate_choice(data.display_mode.as_deref(), &DISPLAY_MODES)?;
    if kind == "shared" && !caller.is_admin {
        return Err(AppError::Forbidden(SHARED_ADMIN_ONLY.to_string()));
    }
    if kind == "personal" && !access.is_empty() {
        return Err(bad_request(ACCESS_ON_PERSONAL));
    }
    let members = validate_members(data.members)?;
    let access = validate_access(access, &config)?;

    let mut conn = open_db(&config)?;
    let list = db::lists::create_list(
        &mut conn,
        &NewList {
            name: &name,
            kind: &kind,
            display_mode: &display_mode,
            owner_email: &caller.email,
            members: &members,
            access: &access,
        },
    )
    .map_err(AppError::InternalError)?;
    let perms = permissions(&list, &caller)
        .ok_or_else(|| AppError::InternalError("Created list is not visible".to_string()))?;

    Ok((StatusCode::CREATED, Json(to_response(list, perms, &caller))).into_response())
}

/// `PUT /api/lists/{id}` — change name, display mode, members and/or access.
pub async fn update_list_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Path(id): Path<String>,
    Json(data): Json<UpdateListRequest>,
) -> Result<Response, AppError> {
    let caller = Caller::new(&session, &config);
    let mut conn = open_db(&config)?;
    let (list, perms) = load_visible(&conn, &id, &caller)?;

    let edits_content = data.name.is_some() || data.display_mode.is_some() || data.members.is_some();
    if edits_content && !perms.can_edit {
        return Err(AppError::Forbidden(CANNOT_EDIT.to_string()));
    }
    // Only admins share lists. Sharing a personal list with someone makes it
    // shared; removing everyone makes it personal again for its owner (another
    // admin's list stays shared so that it does not vanish from their view).
    let (access, kind) = match data.access {
        Some(access) if list.kind == "personal" && access.is_empty() => (None, None),
        Some(_) if !caller.is_admin => {
            return Err(AppError::Forbidden(ACCESS_ADMIN_ONLY.to_string()));
        }
        Some(access) => {
            let shared = !access.is_empty() || list.owner_email != caller.email;
            let kind = (kind_for_access(shared) != list.kind).then(|| kind_for_access(shared).to_string());
            (Some(access), kind)
        }
        None => (None, None),
    };

    let changes = ListChanges {
        name: data.name.as_deref().map(|name| validate_name(Some(name))).transpose()?,
        kind,
        display_mode: data
            .display_mode
            .as_deref()
            .map(|mode| validate_choice(Some(mode), &DISPLAY_MODES))
            .transpose()?,
        members: data.members.map(validate_members).transpose()?,
        access: access.map(|access| validate_access(access, &config)).transpose()?,
    };

    let list = db::lists::update_list(&mut conn, &id, &changes)
        .map_err(AppError::InternalError)?
        .ok_or_else(|| AppError::NotFound(NOT_FOUND.to_string()))?;
    let perms =
        permissions(&list, &caller).ok_or_else(|| AppError::NotFound(NOT_FOUND.to_string()))?;

    Ok(Json(to_response(list, perms, &caller)).into_response())
}

/// `DELETE /api/lists/{id}` — personal lists by their owner, shared lists by admins.
pub async fn delete_list_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    let caller = Caller::new(&session, &config);
    let conn = open_db(&config)?;
    let (_, perms) = load_visible(&conn, &id, &caller)?;
    if !perms.can_manage {
        return Err(AppError::Forbidden(CANNOT_DELETE.to_string()));
    }
    if !db::lists::delete_list(&conn, &id).map_err(AppError::InternalError)? {
        return Err(AppError::NotFound(NOT_FOUND.to_string()));
    }
    Ok(Json(serde_json::json!({ "status": "deleted" })).into_response())
}

/// `GET /api/lists/users` — people who have signed in here (admins only),
/// for picking who may use a shared list.
pub async fn list_users_handler(
    Extension(session): Extension<SessionState>,
    Extension(config): Extension<Arc<AppConfig>>,
) -> Result<Response, AppError> {
    let caller = Caller::new(&session, &config);
    if !caller.is_admin {
        return Err(AppError::Forbidden(ACCESS_ADMIN_ONLY.to_string()));
    }
    let conn = open_db(&config)?;
    let users = db::lists::list_users(&conn).map_err(AppError::InternalError)?;
    Ok(Json(serde_json::json!({ "users": users })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(err: AppError) -> String {
        match err {
            AppError::BadRequest(msg) => msg,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    fn member(email: &str, name: Option<&str>) -> MemberInput {
        MemberInput {
            email: email.to_string(),
            name: name.map(str::to_string),
        }
    }

    fn access(email: &str, can_edit: bool) -> AccessInput {
        AccessInput {
            email: email.to_string(),
            can_edit,
        }
    }

    fn config(allowed_domains: Option<&str>) -> AppConfig {
        let mut config: AppConfig = figment::Figment::new().extract().unwrap();
        config.allowed_email_domains = allowed_domains.map(str::to_string);
        config
    }

    #[test]
    fn name_is_trimmed_and_bounded() {
        assert_eq!(validate_name(Some("  Team  ")).unwrap(), "Team");
        assert_eq!(message(validate_name(None).unwrap_err()), NAME_REQUIRED);
        assert_eq!(message(validate_name(Some("   ")).unwrap_err()), NAME_REQUIRED);
        assert!(validate_name(Some(&"é".repeat(100))).is_ok());
        assert_eq!(message(validate_name(Some(&"a".repeat(101))).unwrap_err()), NAME_TOO_LONG);
    }

    #[test]
    fn choices_must_be_allowed_values() {
        assert_eq!(validate_choice(Some("shared"), &KINDS).unwrap(), "shared");
        assert_eq!(validate_choice(Some("expanded"), &DISPLAY_MODES).unwrap(), "expanded");
        for value in [None, Some(""), Some("Shared"), Some("public")] {
            assert_eq!(message(validate_choice(value, &KINDS).unwrap_err()), INVALID_SETTINGS);
        }
    }

    #[test]
    fn address_check() {
        for ok in ["a@b", "first.last+tag@example.com", "ünï@例え.jp"] {
            assert!(is_valid_address(ok), "{ok}");
        }
        let long = format!("{}@example.com", "a".repeat(250));
        for bad in [
            "", "plain", "@example.com", "a@", "a@b@c", "a b@c.com", "a@c.com\n", "a\u{7}@c.com",
            "<a@c.com>", "a,b@c.com", "a;b@c.com", "a:b@c.com", "\"a\"@c.com", "a(b)@c.com",
            "a[b]@c.com", "a\\b@c.com", &long,
        ] {
            assert!(!is_valid_address(bad), "{bad:?}");
        }
    }

    #[test]
    fn members_are_trimmed_deduplicated_and_truncated() {
        let long_name = "n".repeat(250);
        let members = validate_members(vec![
            member("  Bob@Example.com ", Some("  Bob  ")),
            member("bob@example.COM", Some("Duplicate")),
            member("carol@example.com", None),
            member("dave@example.com", Some(&long_name)),
        ])
        .unwrap();
        assert_eq!(
            members,
            vec![
                ListMember { email: "Bob@Example.com".into(), name: "Bob".into() },
                ListMember { email: "carol@example.com".into(), name: String::new() },
                ListMember { email: "dave@example.com".into(), name: "n".repeat(200) },
            ]
        );
        assert!(validate_members(vec![]).unwrap().is_empty());
        assert_eq!(
            message(validate_members(vec![member("not-an-address", None)]).unwrap_err()),
            INVALID_MEMBER
        );
        let too_many = (0..501).map(|i| member(&format!("m{i}@example.com"), None)).collect();
        assert_eq!(message(validate_members(too_many).unwrap_err()), TOO_MANY_MEMBERS);
        let max = (0..500).map(|i| member(&format!("m{i}@example.com"), None)).collect();
        assert_eq!(validate_members(max).unwrap().len(), 500);
    }

    #[test]
    fn access_is_normalized_and_restricted_to_allowed_domains() {
        let config = config(Some("example.com"));
        let entries = validate_access(
            vec![
                access(" Ann@Example.com ", false),
                access("bob@example.com", false),
                access("ann@example.com", true),
            ],
            &config,
        )
        .unwrap();
        assert_eq!(
            entries,
            vec![
                ListAccess { email: "ann@example.com".into(), can_edit: true },
                ListAccess { email: "bob@example.com".into(), can_edit: false },
            ]
        );
        for bad in ["eve@elsewhere.com", "not-an-address", "a b@example.com"] {
            assert_eq!(
                message(validate_access(vec![access(bad, false)], &config).unwrap_err()),
                INVALID_ACCESS
            );
        }
        // Without ALLOWED_EMAIL_DOMAINS any valid address is accepted.
        assert!(validate_access(vec![access("eve@elsewhere.com", false)], &self::config(None)).is_ok());
        let too_many = (0..501).map(|i| access(&format!("u{i}@example.com"), false)).collect();
        assert!(validate_access(too_many, &config).is_err());
    }

    #[test]
    fn permissions_by_kind_and_role() {
        let list = |kind: &str| DistributionList {
            id: "id".into(),
            name: "L".into(),
            kind: kind.into(),
            display_mode: "list".into(),
            owner_email: "owner@x.com".into(),
            members: vec![],
            access: vec![
                ListAccess { email: "user@x.com".into(), can_edit: false },
                ListAccess { email: "editor@x.com".into(), can_edit: true },
            ],
            created_at: String::new(),
            updated_at: String::new(),
        };
        let caller = |email: &str, is_admin: bool| Caller { email: email.into(), is_admin };
        let perms = |can_edit, can_manage| Some(Permissions { can_edit, can_manage });

        let personal = list("personal");
        assert_eq!(permissions(&personal, &caller("owner@x.com", false)), perms(true, true));
        assert_eq!(permissions(&personal, &caller("admin@x.com", true)), None);
        assert_eq!(permissions(&personal, &caller("user@x.com", false)), None);

        let shared = list("shared");
        assert_eq!(permissions(&shared, &caller("admin@x.com", true)), perms(true, true));
        assert_eq!(permissions(&shared, &caller("editor@x.com", false)), perms(true, false));
        assert_eq!(permissions(&shared, &caller("user@x.com", false)), perms(false, false));
        assert_eq!(permissions(&shared, &caller("owner@x.com", false)), None);
    }
}
