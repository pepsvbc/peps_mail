-- English was a placeholder before interface translations existed. Let existing
-- accounts follow the browser until the user explicitly chooses a language.
UPDATE display_preferences SET language = 'system' WHERE language = 'en';
