-- The deep-index background task used to serialize full attachments, raw
-- bytes included (`"data":[1,2,3,...]`), into attachments_json. Those rows
-- are huge and, lacking an `id`, do not parse as attachment metadata, so the
-- message showed no attachments. Clearing the column makes get_message treat
-- the cached body as stale and re-fetch it from IMAP, which rewrites proper
-- metadata (and resolves inline cid: images in the HTML).
--
-- In well-formed metadata JSON, quotes inside string values are escaped, so
-- the unescaped key pattern `"data":[` can only appear in bloated rows.
UPDATE messages
SET attachments_json = NULL
WHERE attachments_json IS NOT NULL
  AND attachments_json LIKE '%"data":[%';
