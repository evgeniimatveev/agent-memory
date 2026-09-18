CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  type TEXT NOT NULL,                 -- preference | fact | event | correction
  importance INTEGER NOT NULL DEFAULT 3,  -- 1 (trivial) .. 5 (critical)
  source TEXT,                        -- free-text tag for where this came from
  superseded_by TEXT,                 -- id of the fact that replaced this one (nullable)
  created_at TEXT NOT NULL,
  last_accessed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts (created_at);
CREATE INDEX IF NOT EXISTS idx_facts_superseded_by ON facts (superseded_by);
