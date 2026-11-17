use rusqlite::{params, Connection};
use serde::Serialize;

/// A known address extracted from message headers.
#[derive(Debug, Clone, Serialize)]
pub struct KnownAddress {
    pub email: String,
    pub name: String,
}

/// Escape `%` and `_` in a search term to prevent LIKE wildcard injection.
fn escape_like(term: &str) -> String {
    term.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Search known addresses from the denormalized `known_addresses` table.
/// Returns distinct addresses ordered by email ascending.
pub fn search_known_addresses(
    conn: &Connection,
    query: &str,
    limit: u32,
) -> Result<Vec<KnownAddress>, String> {
    let escaped = escape_like(query);
    let pattern = format!("%{escaped}%");

    let sql = r#"
        SELECT email, name
        FROM known_addresses
        WHERE email LIKE ?1 ESCAPE '\' OR name LIKE ?1 ESCAPE '\'
        ORDER BY email ASC
        LIMIT ?2
    "#;

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare search_known_addresses: {e}"))?;

    let rows = stmt
        .query_map(params![pattern, limit], |row| {
            Ok(KnownAddress {
                email: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| format!("Failed to query known addresses: {e}"))?;

    let mut addresses = Vec::new();
    for row in rows {
        addresses.push(row.map_err(|e| format!("Failed to read known address row: {e}"))?);
    }
    Ok(addresses)
}

/// Populate the `known_addresses` table from a single message's header fields.
/// Existing rows keep their name unless the new one is non-empty.
pub fn populate_known_addresses(
    conn: &Connection,
    from_address: &str,
    from_name: &str,
    to_json: &str,
    cc_json: &str,
) -> Result<(), String> {
    // Insert from address.
    if !from_address.is_empty() {
        conn.execute(
            "INSERT INTO known_addresses (email, name) VALUES (?1, ?2)
             ON CONFLICT(email) DO UPDATE SET name = excluded.name WHERE excluded.name != ''",
            params![from_address, from_name],
        )
        .map_err(|e| format!("Failed to insert known address (from): {e}"))?;
    }

    // Insert to addresses from JSON array.
    insert_addresses_from_json(conn, to_json)?;

    // Insert cc addresses from JSON array.
    insert_addresses_from_json(conn, cc_json)?;

    Ok(())
}

/// Parse a JSON array of `{"address": "...", "name": "..."}` objects and insert
/// each into `known_addresses`.
fn insert_addresses_from_json(conn: &Connection, json: &str) -> Result<(), String> {
    let entries: Vec<serde_json::Value> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Ok(()), // Invalid JSON, skip silently.
    };

    for entry in &entries {
        let email = entry
            .get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if email.is_empty() {
            continue;
        }
        let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
        conn.execute(
            "INSERT INTO known_addresses (email, name) VALUES (?1, ?2)
             ON CONFLICT(email) DO UPDATE SET name = excluded.name WHERE excluded.name != ''",
            params![email, name],
        )
        .map_err(|e| format!("Failed to insert known address (json): {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::pool::open_test_db;

    #[test]
    fn test_search_known_addresses_basic() {
        let conn = open_test_db();

        // Populate known_addresses directly (simulating what happens at sync time).
        populate_known_addresses(&conn, "alice@test.com", "Alice From", "[]", "[]").unwrap();
        populate_known_addresses(
            &conn,
            "sender@other.com",
            "Sender",
            r#"[{"name":"Bob To","address":"bob@test.com"}]"#,
            "[]",
        )
        .unwrap();
        populate_known_addresses(
            &conn,
            "sender@other.com",
            "Sender",
            "[]",
            r#"[{"name":"Charlie Cc","address":"charlie@test.com"}]"#,
        )
        .unwrap();

        let results = search_known_addresses(&conn, "test.com", 10).unwrap();
        assert_eq!(results.len(), 3);

        assert_eq!(results[0].email, "alice@test.com");
        assert_eq!(results[0].name, "Alice From");
        assert_eq!(results[1].email, "bob@test.com");
        assert_eq!(results[1].name, "Bob To");
        assert_eq!(results[2].email, "charlie@test.com");
        assert_eq!(results[2].name, "Charlie Cc");
    }

    #[test]
    fn test_search_known_addresses_matches_name_and_escapes_wildcards() {
        let conn = open_test_db();

        populate_known_addresses(&conn, "alice@test.com", "Alice Smith", "[]", "[]").unwrap();
        populate_known_addresses(&conn, "bob@test.com", "Bob Jones", "[]", "[]").unwrap();

        let results = search_known_addresses(&conn, "Smith", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].email, "alice@test.com");

        // LIKE wildcards in the query are matched literally.
        assert!(search_known_addresses(&conn, "%", 10).unwrap().is_empty());
        assert!(search_known_addresses(&conn, "_", 10).unwrap().is_empty());

        // An empty query matches everything, capped by the limit.
        assert_eq!(search_known_addresses(&conn, "", 10).unwrap().len(), 2);
        assert_eq!(search_known_addresses(&conn, "", 1).unwrap().len(), 1);
    }

    #[test]
    fn test_search_known_addresses_handles_invalid_json() {
        let conn = open_test_db();

        // Populate known_addresses (simulating sync).
        populate_known_addresses(&conn, "valid@test.com", "Valid User", "[]", "[]").unwrap();
        populate_known_addresses(
            &conn,
            "sender@other.com",
            "Sender",
            r#"[{"name":"","address":"emptyname@test.com"}]"#,
            r#"[{"name":"Cc Person","address":"ccperson@test.com"}]"#,
        )
        .unwrap();
        populate_known_addresses(
            &conn,
            "sender@other.com",
            "Sender",
            r#"[{"name":"Json Person","address":"json@test.com"}]"#,
            "[]",
        )
        .unwrap();

        let results = search_known_addresses(&conn, "test.com", 10).unwrap();

        assert_eq!(results.len(), 4);
        let emails: Vec<&str> = results.iter().map(|a| a.email.as_str()).collect();
        assert!(emails.contains(&"valid@test.com"));
        assert!(emails.contains(&"emptyname@test.com"));
        assert!(emails.contains(&"ccperson@test.com"));
        assert!(emails.contains(&"json@test.com"));
    }

    #[test]
    fn test_populate_known_addresses_deduplicates() {
        let conn = open_test_db();

        populate_known_addresses(&conn, "alice@test.com", "Alice", "[]", "[]").unwrap();
        // Same email again with non-empty name -- should update the name.
        populate_known_addresses(&conn, "alice@test.com", "Alice Different", "[]", "[]").unwrap();

        let results = search_known_addresses(&conn, "alice@test.com", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Alice Different");
    }

    #[test]
    fn test_populate_known_addresses_skips_invalid_json() {
        let conn = open_test_db();

        // Invalid JSON in to_addresses should not cause an error.
        populate_known_addresses(&conn, "sender@test.com", "Sender", "not valid json", "[]")
            .unwrap();

        let results = search_known_addresses(&conn, "sender@test.com", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].email, "sender@test.com");
    }
}
