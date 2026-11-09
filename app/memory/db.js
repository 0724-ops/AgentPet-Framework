// ============================================================================
//  SQLite 记忆库（better-sqlite3）
//
//  Step 1 只提供基础设施：建表、Upsert、向量暴力检索、FTS/BM25 文本检索、
//  统计与清空。归一化、三层合并、打分、衰减在后续 Step 实现。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

function now() {
  return Date.now();
}

function toBuffer(vec) {
  if (vec instanceof Buffer) return vec;
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec || []);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function fromBuffer(buf) {
  if (!buf || !buf.length) return new Float32Array(0);
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

function dot(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function openDatabase(file, { readOnly = false } = {}) {
  if (!file || file === ':memory:') {
    // 允许内存库，测试用
  } else if (!readOnly) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file, { readonly: readOnly, fileMustExist: readOnly });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  if (!readOnly) initSchema(db);

  const MEMORY_COLS =
    'm.key, m.fact, m.relation, m.polarity, m.truth, m.subject, m.object_norm, ' +
    'm.pinned, m.layer, m.activation, m.created_turn';

  const stmt = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    upsert: db.prepare(`
      INSERT INTO memories (
        key, subject, relation, object_norm, fact, polarity, truth, activation, pinned, layer,
        created_turn, last_update_turn, last_hit_turn, hit_count, miss_count, delete_streak,
        source_text, created_at, updated_at
      ) VALUES (
        @key, @subject, @relation, @object_norm, @fact, @polarity, @truth, @activation, @pinned, @layer,
        @created_turn, @last_update_turn, @last_hit_turn, @hit_count, @miss_count, @delete_streak,
        @source_text, @created_at, @updated_at
      )
      ON CONFLICT(key) DO UPDATE SET
        subject = excluded.subject,
        relation = excluded.relation,
        object_norm = excluded.object_norm,
        fact = excluded.fact,
        polarity = excluded.polarity,
        truth = excluded.truth,
        activation = excluded.activation,
        pinned = excluded.pinned,
        layer = excluded.layer,
        last_update_turn = excluded.last_update_turn,
        last_hit_turn = excluded.last_hit_turn,
        hit_count = excluded.hit_count,
        miss_count = excluded.miss_count,
        delete_streak = excluded.delete_streak,
        source_text = excluded.source_text,
        updated_at = excluded.updated_at
    `),
    getMemory: db.prepare('SELECT * FROM memories WHERE key = ?'),
    findByFact: db.prepare(
      'SELECT * FROM memories WHERE fact = ? ORDER BY pinned DESC, activation DESC, truth DESC, updated_at DESC LIMIT 1',
    ),
    deleteMemory: db.prepare('DELETE FROM memories WHERE key = ?'),
    updateLifecycle: db.prepare(`
      UPDATE memories SET
        activation = @activation,
        layer = @layer,
        last_hit_turn = @last_hit_turn,
        hit_count = @hit_count,
        miss_count = @miss_count,
        delete_streak = @delete_streak,
        updated_at = @updated_at
      WHERE key = @key
    `),
    updatePinned: db.prepare('UPDATE memories SET pinned = ?, updated_at = ? WHERE key = ?'),
    moveVectors: db.prepare('UPDATE vectors SET memory_key = ? WHERE memory_key = ?'),
    addVector: db.prepare(`
      INSERT INTO vectors(memory_key, vec, dim, embed_model, created_turn, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    vectorsOf: db.prepare('SELECT * FROM vectors WHERE memory_key = ? ORDER BY id'),
    deleteVector: db.prepare('DELETE FROM vectors WHERE id = ?'),
    allVectors: db.prepare(`
      SELECT v.id, v.memory_key, v.vec, v.dim, m.fact, m.relation, m.polarity, m.truth,
             m.subject, m.object_norm, m.layer, m.pinned, m.activation
      FROM vectors v JOIN memories m ON m.key = v.memory_key
    `),
    countMemories: db.prepare('SELECT COUNT(*) AS n FROM memories'),
    countVectors: db.prepare('SELECT COUNT(*) AS n FROM vectors'),
    clearMemories: db.prepare('DELETE FROM memories'),
    listMemories: db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?'),
    allMemories: db.prepare('SELECT * FROM memories ORDER BY updated_at DESC'),
  };

  function getMeta(key, fallback = null) {
    const row = stmt.getMeta.get(key);
    return row ? row.value : fallback;
  }

  function setMeta(key, value) {
    stmt.setMeta.run(key, String(value));
  }

  function upsertMemory(input) {
    const t = now();
    const record = {
      key: String(input.key || '').trim(),
      subject: String(input.subject || 'user'),
      relation: String(input.relation || 'fact'),
      object_norm: String(input.object_norm || ''),
      fact: String(input.fact || '').trim(),
      polarity: String(input.polarity || 'positive'),
      truth: Number.isFinite(Number(input.truth)) ? Number(input.truth) : 1,
      activation: Number.isFinite(Number(input.activation)) ? Number(input.activation) : 1,
      pinned: input.pinned ? 1 : 0,
      layer: String(input.layer || 'hot'),
      created_turn: Number(input.created_turn) || 0,
      last_update_turn: Number(input.last_update_turn) || 0,
      last_hit_turn: Number(input.last_hit_turn) || 0,
      hit_count: Number(input.hit_count) || 0,
      miss_count: Number(input.miss_count) || 0,
      delete_streak: Number(input.delete_streak) || 0,
      source_text: String(input.source_text || ''),
      created_at: Number(input.created_at) || t,
      updated_at: t,
    };
    if (!record.key) throw new Error('memory.key 不能为空');
    if (!record.fact) throw new Error('memory.fact 不能为空');
    stmt.upsert.run(record);
    return record;
  }

  function addVector(memoryKey, vec, { embedModel = '', createdTurn = 0, maxVectors = 0 } = {}) {
    const key = String(memoryKey || '');
    if (!key) throw new Error('memoryKey 不能为空');
    if (!stmt.getMemory.get(key)) throw new Error('memory 不存在：' + key);
    const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec || []);
    if (!arr.length) throw new Error('向量为空');
    const info = stmt.addVector.run(key, toBuffer(arr), arr.length, String(embedModel || ''), Number(createdTurn) || 0, now());
    if (maxVectors > 0) trimVectors(key, maxVectors);
    return Number(info.lastInsertRowid);
  }

  // 超出上限时删最旧的：Step 2 会按「最低激活」细化，这里先保底
  function trimVectors(memoryKey, maxVectors = 5) {
    const rows = stmt.vectorsOf.all(memoryKey);
    if (rows.length <= maxVectors) return 0;
    const drop = rows.slice(0, rows.length - maxVectors);
    const tx = db.transaction((items) => items.forEach((r) => stmt.deleteVector.run(r.id)));
    tx(drop);
    return drop.length;
  }

  function searchVectors(queryVec, { limit = 10, relations = null, includeCold = false } = {}) {
    const q = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec || []);
    if (!q.length) return [];
    const rows = stmt.allVectors.all();
    const out = [];
    for (const row of rows) {
      if (!includeCold && row.layer === 'cold') continue;
      if (relations && relations.length && !relations.includes(row.relation)) continue;
      const vec = fromBuffer(row.vec);
      const score = dot(q, vec);
      if (score < 0) continue;
      out.push({
        key: row.memory_key,
        score,
        fact: row.fact,
        relation: row.relation,
        polarity: row.polarity,
        truth: row.truth,
        subject: row.subject,
        object_norm: row.object_norm,
        pinned: !!row.pinned,
        layer: row.layer,
        activation: row.activation,
        vectorId: row.id,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, Math.max(1, limit));
  }

  function searchText(query, { limit = 10, includeCold = false } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokenizer = getMeta('fts_tokenizer', '');
    const chars = [...q].length;
    if (tokenizer && chars >= 3) {
      const match = '"' + q.replace(/"/g, '""') + '"';
      const sql =
        `SELECT ${MEMORY_COLS}, bm25(memories_fts) AS bm25 ` +
        `FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid ` +
        `WHERE memories_fts MATCH ? ${includeCold ? '' : "AND m.layer <> 'cold'"} ` +
        `ORDER BY bm25 LIMIT ?`;
      return db.prepare(sql).all(match, Math.max(1, limit));
    }
    // 两字词 trigram 匹配不到，退回 LIKE；数据量小时足够
    const like = `%${q.replace(/[%_]/g, '')}%`;
    return db
      .prepare(
        `SELECT ${MEMORY_COLS}, NULL AS bm25 FROM memories m ` +
          `WHERE (m.fact LIKE ? OR m.source_text LIKE ?) ${includeCold ? '' : "AND m.layer <> 'cold'"} ` +
          `ORDER BY m.updated_at DESC LIMIT ?`,
      )
      .all(like, like, Math.max(1, limit));
  }

  // Step 3：自然语言关键词召回。>=3 字的词走 FTS trigram（OR），2 字词走 LIKE；
  // 每条命中返回完整记忆字段，供打分与 VIP 判定使用。
  function searchTextAny(terms, { limit = 12, includeCold = false } = {}) {
    const list = (Array.isArray(terms) ? terms : [])
      .map((t) => String(t || '').trim())
      .filter((t) => t && [...t].length >= 2);
    const out = new Map();
    const max = Math.max(1, limit);
    const tokenizer = getMeta('fts_tokenizer', '');

    const longTerms = [...new Set(list.filter((t) => [...t].length >= 3))].slice(0, 12);
    if (tokenizer && longTerms.length) {
      const match = longTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      const rows = db
        .prepare(
          `SELECT ${MEMORY_COLS}, bm25(memories_fts) AS bm25 ` +
            `FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid ` +
            `WHERE memories_fts MATCH ? ${includeCold ? '' : "AND m.layer <> 'cold'"} ` +
            `ORDER BY bm25 LIMIT ?`,
        )
        .all(match, max);
      rows.forEach((row) => out.set(row.key, row));
    }

    if (out.size < max) {
      const shortTerms = [...new Set(list.filter((t) => [...t].length === 2))].slice(0, 12);
      if (shortTerms.length) {
        const clauses = shortTerms.map(() => '(m.fact LIKE ? OR m.source_text LIKE ?)').join(' OR ');
        const args = [];
        shortTerms.forEach((t) => {
          const like = `%${t.replace(/[%_]/g, '')}%`;
          args.push(like, like);
        });
        const rows = db
          .prepare(
            `SELECT ${MEMORY_COLS}, NULL AS bm25 FROM memories m ` +
              `WHERE (${clauses}) ${includeCold ? '' : "AND m.layer <> 'cold'"} ` +
              `ORDER BY m.updated_at DESC LIMIT ?`,
          )
          .all(...args, max);
        rows.forEach((row) => {
          if (!out.has(row.key)) out.set(row.key, row);
        });
      }
    }

    return [...out.values()].slice(0, max);
  }

  function stats() {
    const size = file && file !== ':memory:' && fs.existsSync(file) ? fs.statSync(file).size : 0;
    return {
      dbPath: path.resolve(file),
      schemaVersion: Number(getMeta('schema_version', 0)),
      ftsTokenizer: getMeta('fts_tokenizer', ''),
      embedModel: getMeta('embed_model', ''),
      embedDim: Number(getMeta('embed_dim', 0)),
      turn: Number(getMeta('turn_counter', 0)),
      memories: stmt.countMemories.get().n,
      vectors: stmt.countVectors.get().n,
      bytes: size,
    };
  }

  function listMemories(limit = 50) {
    return stmt.listMemories.all(Math.max(1, Math.min(500, limit)));
  }

  function allMemories() {
    return stmt.allMemories.all();
  }

  function reset({ keepModelMeta = true } = {}) {
    const model = getMeta('embed_model', '');
    const dim = getMeta('embed_dim', 0);
    stmt.clearMemories.run();
    setMeta('turn_counter', 0);
    setMeta('life_turn', 0);
    if (keepModelMeta) {
      setMeta('embed_model', model || '');
      setMeta('embed_dim', dim || 0);
    }
    return stats();
  }

  function getMemory(key) {
    return stmt.getMemory.get(String(key || '')) || null;
  }

  // 完全相同的表述可能来自不同的 object 归一化结果（两条主键），写入前用它兜底合并
  function findByFact(fact) {
    const text = String(fact || '').trim();
    if (!text) return null;
    return stmt.findByFact.get(text) || null;
  }

  function deleteMemory(key) {
    return stmt.deleteMemory.run(String(key || '')).changes > 0;
  }

  // Step 4：只更新生命周期字段，不覆盖 fact / 向量 / created_turn 等
  function updateLifecycle(key, fields = {}) {
    const k = String(key || '');
    if (!k) return false;
    return (
      stmt.updateLifecycle.run({
        key: k,
        activation: Number(fields.activation) || 0,
        layer: String(fields.layer || 'hot'),
        last_hit_turn: Number(fields.last_hit_turn) || 0,
        hit_count: Number(fields.hit_count) || 0,
        miss_count: Number(fields.miss_count) || 0,
        delete_streak: Number(fields.delete_streak) || 0,
        updated_at: Number(fields.updated_at) || now(),
      }).changes > 0
    );
  }

  function setPinned(key, pinned) {
    const k = String(key || '');
    if (!k) return null;
    const changed = stmt.updatePinned.run(pinned ? 1 : 0, now(), k).changes;
    return changed ? getMemory(k) : null;
  }

  // 合并重复条目时把表述向量挪到保留的那条上（避免删行时级联丢掉向量）
  function moveVectors(fromKey, toKey) {
    const from = String(fromKey || '');
    const to = String(toKey || '');
    if (!from || !to || from === to) return 0;
    return stmt.moveVectors.run(to, from).changes;
  }

  function getVectors(memoryKey) {
    return stmt.vectorsOf.all(String(memoryKey || '')).map((row) => ({
      id: row.id,
      dim: row.dim,
      embedModel: row.embed_model,
      createdTurn: row.created_turn,
      vector: fromBuffer(row.vec),
    }));
  }

  return {
    db,
    file,
    getMeta,
    setMeta,
    getMemory,
    findByFact,
    deleteMemory,
    setPinned,
    updateLifecycle,
    moveVectors,
    getVectors,
    upsertMemory,
    addVector,
    trimVectors,
    searchVectors,
    searchText,
    searchTextAny,
    listMemories,
    allMemories,
    stats,
    reset,
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}

function initSchema(db) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  // FTS 优先 trigram（中文子串召回）；老 SQLite 不支持时退 unicode61
  let tokenizer = '';
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact, source_text,
        content='memories', content_rowid='rowid',
        tokenize='trigram'
      );
    `);
    tokenizer = 'trigram';
  } catch (err) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        fact, source_text,
        content='memories', content_rowid='rowid'
      );
    `);
    tokenizer = 'unicode61';
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, fact, source_text) VALUES (new.rowid, new.fact, new.source_text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, fact, source_text) VALUES ('delete', old.rowid, old.fact, old.source_text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, fact, source_text) VALUES ('delete', old.rowid, old.fact, old.source_text);
      INSERT INTO memories_fts(rowid, fact, source_text) VALUES (new.rowid, new.fact, new.source_text);
    END;
  `);
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'fts_tokenizer',
    tokenizer,
  );
}

module.exports = { openDatabase, SCHEMA_VERSION, dot, toBuffer, fromBuffer };
