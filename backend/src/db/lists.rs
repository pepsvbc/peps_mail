use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

/// Current time as an RFC 3339 UTC timestamp, computed by SQLite.
const NOW_SQL: &str = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

/// A list member, in the list's saved order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListMember {
    pub email: String,
    pub name: String,
}

/// Someone allowed to use a shared list (and, with `can_edit`, edit it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListAccess {
    pub email: String,
    pub can_edit: bool,
}

/// A distribution list as stored, with its members and access entries.
#[derive(Debug, Clone)]
pub struct DistributionList {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub display_mode: String,
    pub owner_email: String,
    pub members: Vec<ListMember>,
    pub access: Vec<ListAccess>,
    pub created_at: String,
    pub updated_at: String,
}

/// Someone who has signed in to this instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KnownUser {
    pub email: String,
    pub last_login: String,
}

/// Data for a new list (already validated).
pub struct NewList<'a> {
    pub name: &'a str,
    pub kind: &'a str,
    pub display_mode: &'a str,
    pub owner_email: &'a str,
    pub members: &'a [ListMember],
    pub access: &'a [ListAccess],
}

/// Changes to an existing list (already validated). `members` and `access`
/// replace the whole set.
#[derive(Default)]
pub struct ListChanges {
    pub name: Option<String>,
    pub display_mode: Option<String>,
    pub members: Option<Vec<ListMember>>,
    pub access: Option<Vec<ListAccess>>,
}

/// Record a successful sign-in (email is lower-cased by the caller).
pub fn record_login(conn: &Connection, email: &str) -> Result<(), String> {
    conn.execute(
        &format!(
            "INSERT INTO users (email, last_login) VALUES (?1, {NOW_SQL})
             ON CONFLICT(email) DO UPDATE SET last_login = excluded.last_login"
        ),
        params![email],
    )
    .map_err(|e| format!("Failed to record login: {e}"))?;
    Ok(())
}

/// Everyone who has signed in, sorted by email.
pub fn list_users(conn: &Connection) -> Result<Vec<KnownUser>, String> {
    let mut stmt = conn
        .prepare("SELECT email, last_login FROM users ORDER BY email")
        .map_err(|e| format!("Failed to list users: {e}"))?;
    stmt.query_map([], |row| {
        Ok(KnownUser {
            email: row.get(0)?,
            last_login: row.get(1)?,
        })
    })
    .and_then(|rows| rows.collect())
    .map_err(|e| format!("Failed to list users: {e}"))
}

fn load_members(conn: &Connection, list_id: &str) -> rusqlite::Result<Vec<ListMember>> {
    let mut stmt = conn.prepare(
        "SELECT email, name FROM list_members WHERE list_id = ?1 ORDER BY position",
    )?;
    stmt.query_map(params![list_id], |row| {
        Ok(ListMember {
            email: row.get(0)?,
            name: row.get(1)?,
        })
    })?
    .collect()
}

fn load_access(conn: &Connection, list_id: &str) -> rusqlite::Result<Vec<ListAccess>> {
    let mut stmt = conn
        .prepare("SELECT email, can_edit FROM list_access WHERE list_id = ?1 ORDER BY email")?;
    stmt.query_map(params![list_id], |row| {
        Ok(ListAccess {
            email: row.get(0)?,
            can_edit: row.get(1)?,
        })
    })?
    .collect()
}

/// Fetch one list with its members and access entries.
pub fn get_list(conn: &Connection, id: &str) -> Result<Option<DistributionList>, String> {
    let list = conn
        .query_row(
            "SELECT id, name, kind, display_mode, owner_email, created_at, updated_at
             FROM lists WHERE id = ?1",
            params![id],
            |row| {
                Ok(DistributionList {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: row.get(2)?,
                    display_mode: row.get(3)?,
                    owner_email: row.get(4)?,
                    members: Vec::new(),
                    access: Vec::new(),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to load list: {e}"))?;
    let Some(mut list) = list else {
        return Ok(None);
    };
    list.members =
        load_members(conn, &list.id).map_err(|e| format!("Failed to load list members: {e}"))?;
    list.access =
        load_access(conn, &list.id).map_err(|e| format!("Failed to load list access: {e}"))?;
    Ok(Some(list))
}

/// Lists visible to `email`: their own personal lists, plus shared lists
/// they have an access entry for (every shared list for admins). Sorted by
/// name, case-insensitively.
pub fn visible_lists(
    conn: &Connection,
    email: &str,
    is_admin: bool,
) -> Result<Vec<DistributionList>, String> {
    let ids: Vec<String> = conn
        .prepare(
            "SELECT l.id FROM lists l
             WHERE (l.kind = 'personal' AND l.owner_email = ?1)
                OR (l.kind = 'shared' AND (?2 OR EXISTS (
                       SELECT 1 FROM list_access a WHERE a.list_id = l.id AND a.email = ?1)))",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![email, is_admin], |row| row.get(0))?
                .collect()
        })
        .map_err(|e| format!("Failed to list lists: {e}"))?;

    let mut lists = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(list) = get_list(conn, &id)? {
            lists.push(list);
        }
    }
    lists.sort_by_cached_key(|list| (list.name.to_lowercase(), list.id.clone()));
    Ok(lists)
}

fn replace_members(conn: &Connection, list_id: &str, members: &[ListMember]) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM list_members WHERE list_id = ?1", params![list_id])?;
    let mut stmt = conn.prepare(
        "INSERT INTO list_members (list_id, position, email, name) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (position, member) in members.iter().enumerate() {
        stmt.execute(params![list_id, position as i64, member.email, member.name])?;
    }
    Ok(())
}

fn replace_access(conn: &Connection, list_id: &str, access: &[ListAccess]) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM list_access WHERE list_id = ?1", params![list_id])?;
    let mut stmt = conn
        .prepare("INSERT INTO list_access (list_id, email, can_edit) VALUES (?1, ?2, ?3)")?;
    for entry in access {
        stmt.execute(params![list_id, entry.email, entry.can_edit])?;
    }
    Ok(())
}

/// Create a list with its members and access entries in one transaction.
pub fn create_list(conn: &mut Connection, new: &NewList) -> Result<DistributionList, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {e}"))?;
    tx.execute(
        &format!(
            "INSERT INTO lists (id, name, kind, display_mode, owner_email, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, {NOW_SQL}, {NOW_SQL})"
        ),
        params![id, new.name, new.kind, new.display_mode, new.owner_email],
    )
    .map_err(|e| format!("Failed to create list: {e}"))?;
    replace_members(&tx, &id, new.members)
        .map_err(|e| format!("Failed to save list members: {e}"))?;
    replace_access(&tx, &id, new.access)
        .map_err(|e| format!("Failed to save list access: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit list: {e}"))?;

    get_list(conn, &id)?.ok_or_else(|| "Created list not found".to_string())
}

/// Apply `changes` to a list in one transaction. Returns `None` when the
/// list does not exist.
pub fn update_list(
    conn: &mut Connection,
    id: &str,
    changes: &ListChanges,
) -> Result<Option<DistributionList>, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {e}"))?;
    let updated = tx
        .execute(
            &format!(
                "UPDATE lists SET name = COALESCE(?2, name),
                                  display_mode = COALESCE(?3, display_mode),
                                  updated_at = {NOW_SQL}
                 WHERE id = ?1"
            ),
            params![id, changes.name, changes.display_mode],
        )
        .map_err(|e| format!("Failed to update list: {e}"))?;
    if updated == 0 {
        return Ok(None);
    }
    if let Some(members) = &changes.members {
        replace_members(&tx, id, members)
            .map_err(|e| format!("Failed to save list members: {e}"))?;
    }
    if let Some(access) = &changes.access {
        replace_access(&tx, id, access)
            .map_err(|e| format!("Failed to save list access: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit list: {e}"))?;

    get_list(conn, id)
}

/// Delete a list (members and access cascade). Returns whether it existed.
pub fn delete_list(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.execute("DELETE FROM lists WHERE id = ?1", params![id])
        .map(|deleted| deleted > 0)
        .map_err(|e| format!("Failed to delete list: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::shared_pool::open_test_shared_db;

    fn member(email: &str, name: &str) -> ListMember {
        ListMember {
            email: email.to_string(),
            name: name.to_string(),
        }
    }

    fn create(conn: &mut Connection, name: &str, kind: &str, owner: &str, access: &[ListAccess]) -> DistributionList {
        create_list(
            conn,
            &NewList {
                name,
                kind,
                display_mode: "list",
                owner_email: owner,
                members: &[member("b@x.com", "B"), member("a@x.com", "")],
                access,
            },
        )
        .unwrap()
    }

    #[test]
    fn record_login_upserts_last_login() {
        let conn = open_test_shared_db();
        record_login(&conn, "bob@example.com").unwrap();
        record_login(&conn, "alice@example.com").unwrap();
        conn.execute("UPDATE users SET last_login = 'old' WHERE email = 'bob@example.com'", [])
            .unwrap();
        record_login(&conn, "bob@example.com").unwrap();

        let users = list_users(&conn).unwrap();
        assert_eq!(
            users.iter().map(|u| u.email.as_str()).collect::<Vec<_>>(),
            vec!["alice@example.com", "bob@example.com"]
        );
        assert_ne!(users[1].last_login, "old");
        assert!(users[1].last_login.ends_with('Z'));
    }

    #[test]
    fn create_update_delete_round_trip() {
        let mut conn = open_test_shared_db();
        let list = create(&mut conn, "Team", "personal", "owner@x.com", &[]);
        assert_eq!(list.members, vec![member("b@x.com", "B"), member("a@x.com", "")]);
        assert_eq!(list.created_at, list.updated_at);

        let changes = ListChanges {
            name: Some("Renamed".to_string()),
            members: Some(vec![member("c@x.com", "C")]),
            ..Default::default()
        };
        let updated = update_list(&mut conn, &list.id, &changes).unwrap().unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.display_mode, "list");
        assert_eq!(updated.members, vec![member("c@x.com", "C")]);

        assert!(update_list(&mut conn, "missing", &changes).unwrap().is_none());
        assert!(delete_list(&conn, &list.id).unwrap());
        assert!(!delete_list(&conn, &list.id).unwrap());
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM list_members", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn visibility_follows_kind_owner_and_access() {
        let mut conn = open_test_shared_db();
        create(&mut conn, "zeta", "personal", "owner@x.com", &[]);
        create(&mut conn, "Alpha", "shared", "admin@x.com", &[ListAccess {
            email: "user@x.com".to_string(),
            can_edit: false,
        }]);
        create(&mut conn, "beta", "shared", "admin@x.com", &[]);

        let names = |lists: Vec<DistributionList>| {
            lists.into_iter().map(|l| l.name).collect::<Vec<_>>()
        };
        assert_eq!(names(visible_lists(&conn, "owner@x.com", false).unwrap()), vec!["zeta"]);
        assert_eq!(names(visible_lists(&conn, "user@x.com", false).unwrap()), vec!["Alpha"]);
        // Admins see every shared list, but not other people's personal lists.
        assert_eq!(
            names(visible_lists(&conn, "admin@x.com", true).unwrap()),
            vec!["Alpha", "beta"]
        );
        assert!(visible_lists(&conn, "nobody@x.com", false).unwrap().is_empty());
    }
}
