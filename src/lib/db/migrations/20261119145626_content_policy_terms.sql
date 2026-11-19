-- Migration: content_policy_terms
-- Version:   20261119145626 (UTC YYYYMMDDHHMMSS; creation order, not merge order)
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

-- Self-growing lexicon for the content-policy guardrail (src/lib/guardrails/contentPolicy/).
-- One row per normalized term (NFKC + lowercase + single spaces). A chat-model moderator
-- reports sexual terms it found in middle-band requests; each adult verdict that reports a
-- term adds one hit. status: 'pending' (stored, not scored), 'active' (scored with the
-- built-in lexicon), 'rejected' (an operator turned it down; never re-activated by learning).
CREATE TABLE IF NOT EXISTS content_policy_terms (
  term TEXT PRIMARY KEY,
  weight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'moderator',
  hits INTEGER NOT NULL DEFAULT 0,
  last_moderator_model TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_policy_terms_status
  ON content_policy_terms(status);
