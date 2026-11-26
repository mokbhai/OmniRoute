-- Migration: text_policy_term_languages
-- Version:   20261126184537 (UTC YYYYMMDDHHMMSS; creation order, not merge order)
-- Created by `npm run db:new-migration`. Guide: docs/ops/DATABASE_GUIDE.md
--
-- Rules:
--   * Idempotent DDL: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--     DROP ... IF EXISTS, INSERT OR IGNORE. The runner wraps the file in a transaction.
--   * Do not depend on a migration with a NEWER timestamp: files apply in timestamp
--     order (old 001-241 first, then date-named ones, then ee- ones), so a
--     dependency on a newer file breaks fresh databases.
--   * Regenerate the name only while the migration is not merged. Once merged,
--     never rename or delete it (databases that applied it would run it again):
--     create a new migration instead.
--   * Before opening the PR run: npm run test:migrations:fresh
--     and npm run check:migration-numbering

-- Multilingual learning for the text-policy lexicons (text_policy_terms).
--   language     ISO 639-1 code of the term, as reported by the moderator ("en", "pt", "zh").
--   meaning      short English meaning, so an operator can review words in any language.
--   category     the moderator's classification ("explicit", "slang", ...); sets the weight.
--   source_term  for source 'translation': the accepted term this one translates.
--   translated_at when the term's translations were requested (set once per term).
ALTER TABLE text_policy_terms ADD COLUMN language TEXT;
ALTER TABLE text_policy_terms ADD COLUMN meaning TEXT;
ALTER TABLE text_policy_terms ADD COLUMN category TEXT;
ALTER TABLE text_policy_terms ADD COLUMN source_term TEXT;
ALTER TABLE text_policy_terms ADD COLUMN translated_at TEXT;
