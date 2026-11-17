-- Instance-wide data shared by every user (stored in {DATA_DIR}/shared.sqlite).
--
-- The file name deliberately avoids refinery's `V###__name.sql` pattern:
-- refinery scans `migrations/` recursively for the per-user databases, and
-- these migrations are applied by `db::shared_pool` instead.

-- People who have signed in to this instance (emails lower-cased).
CREATE TABLE IF NOT EXISTS users (
    email      TEXT PRIMARY KEY,
    last_login TEXT NOT NULL
);

-- Distribution lists: personal (owner only) or shared (admins + list_access).
CREATE TABLE IF NOT EXISTS lists (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    display_mode TEXT NOT NULL CHECK (display_mode IN ('list', 'expanded')),
    owner_email  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists (owner_email);

-- List members in their saved order.
CREATE TABLE IF NOT EXISTS list_members (
    list_id  TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    email    TEXT NOT NULL,
    name     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (list_id, position)
);

-- Who may use (and optionally edit) a shared list.
CREATE TABLE IF NOT EXISTS list_access (
    list_id  TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    email    TEXT NOT NULL,
    can_edit INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (list_id, email)
);

CREATE INDEX IF NOT EXISTS idx_list_access_email ON list_access (email);
