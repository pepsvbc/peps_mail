ALTER TABLE drafts ADD COLUMN source_folder TEXT;
ALTER TABLE drafts ADD COLUMN source_uid_validity INTEGER;
ALTER TABLE drafts ADD COLUMN source_uid INTEGER;
CREATE UNIQUE INDEX draft_source ON drafts(source_folder, source_uid_validity, source_uid);
-- Keep delayed autosaves from resurrecting discarded or sent drafts.
CREATE TABLE deleted_drafts (id TEXT PRIMARY KEY);
