-- Calendar, contacts and contact groups were removed from the app; members use
-- their mail provider for these. Address autocomplete now reads only from
-- known_addresses.
--
-- The contacts, contact_groups, contact_group_members, calendar_events,
-- calendar_settings and meeting_templates tables are kept but unused, so no
-- user data is deleted here. They can be dropped in a later migration.

-- Copy manual contacts into known_addresses so autocomplete keeps them.
-- Emails are stored as-is, matching populate_known_addresses.
INSERT INTO known_addresses (email, name)
SELECT email, name
FROM contacts
WHERE email != ''
ON CONFLICT(email) DO UPDATE SET name = excluded.name WHERE excluded.name != '';

-- Blank stored CalDAV passwords; nothing reads them any more.
UPDATE calendar_settings SET caldav_password = '';
