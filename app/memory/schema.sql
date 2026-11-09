-- ============================================================================
--  长程记忆库 schema（SQLite）
--
--  memories ：一条记忆 = 一个主键（key）+ 1~5 条表述向量（vectors）
--  meta     ：schema 版本、轮次计数、FTS 分词器等小型状态
--  FTS 表在 db.js 里单独建：优先 trigram（中文），不支持时回落到 unicode61
-- ============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  key              TEXT PRIMARY KEY,
  subject          TEXT NOT NULL DEFAULT 'user',
  relation         TEXT NOT NULL DEFAULT 'fact',
  object_norm      TEXT NOT NULL DEFAULT '',
  fact             TEXT NOT NULL,
  polarity         TEXT NOT NULL DEFAULT 'positive',
  truth            REAL NOT NULL DEFAULT 1.0,
  activation       REAL NOT NULL DEFAULT 1.0,
  pinned           INTEGER NOT NULL DEFAULT 0,
  layer            TEXT NOT NULL DEFAULT 'hot',
  created_turn     INTEGER NOT NULL DEFAULT 0,
  last_update_turn INTEGER NOT NULL DEFAULT 0,
  last_hit_turn    INTEGER NOT NULL DEFAULT 0,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  miss_count       INTEGER NOT NULL DEFAULT 0,
  delete_streak    INTEGER NOT NULL DEFAULT 0,
  source_text      TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_relation ON memories(relation);
CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer, activation);
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);

CREATE TABLE IF NOT EXISTS vectors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_key  TEXT NOT NULL REFERENCES memories(key) ON DELETE CASCADE,
  vec         BLOB NOT NULL,
  dim         INTEGER NOT NULL,
  embed_model TEXT NOT NULL,
  created_turn INTEGER NOT NULL DEFAULT 0,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vectors_memory ON vectors(memory_key);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
