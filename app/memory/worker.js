// ============================================================================
//  记忆 Worker：embedding + SQLite 全部在这里跑，主进程只做消息转发。
//
//  协议（parentPort）：
//    收：{ id, cmd, args }
//    发：{ id, ok: true, result } / { id, ok: false, error }
//  Step 1：init / embed / upsert / addVector / search / searchVector /
//           searchText / list / stats / reset / close
//  Step 2：upsertFacts（归一化 + 哈希/向量三层合并，事务写入）
// ============================================================================

const { parentPort, workerData } = require('worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, dot } = require('./db');
const { createEmbedder } = require('./embed');
const { resolveModelDir } = require('./tokenizer');
const { normalizeFact, normalizeText, registerCharacterName } = require('./normalize');
const { keywordTerms, selectMemories, formatMemoryBlock, DEFAULTS } = require('./retrieve');
const { settleMemory, DEFAULTS: LIFE_DEFAULTS } = require('./lifecycle');

let store = null;
let embedder = null;
let modelDir = resolveModelDir(workerData && workerData.modelDir);
let bootInfo = {};
// 角色名由主进程从角色定义带进来：记忆里用角色名当主语时归一到 char
if (workerData && workerData.charName) registerCharacterName(workerData.charName);
// Step 4：最近一次检索的候选 / 注入主键，轮次结束结算时区分「未注入」与「未进候选」
let lastCandidateKeys = [];
let lastInjectedKeys = [];
// 记忆块模板：用户维护的 si/app/preset-memory.md，每次检索现读，改文件即生效
function memoryPromptTemplate() {
  const file = (workerData && workerData.promptFile) || '';
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

// 主进程 spawn 时直接给 dbPath，Worker 一启动就有库可用；也保留 init 命令给自测用
if (workerData && workerData.dbPath) {
  try {
    const started = Date.now();
    store = openDatabase(workerData.dbPath);
    bootInfo.dbOpenMs = Date.now() - started;
    // 老库里可能有「同 fact 文本、不同主键」的重复条目（同义表达各自建行），启动时合并一次
    try {
      const dedup = dedupeExactMemories(store);
      bootInfo.deduped = dedup.merged;
      bootInfo.dedupeGroups = dedup.groups;
    } catch (err) {
      bootInfo.dedupeError = String((err && err.message) || err);
    }
  } catch (err) {
    bootInfo.dbError = String((err && err.message) || err);
  }
}

async function getEmbedder() {
  if (!embedder) {
    const started = Date.now();
    embedder = await createEmbedder({ modelDir });
    if (store) {
      store.setMeta('embed_model', embedder.model);
      store.setMeta('embed_dim', embedder.dim);
    }
    bootInfo.modelLoadMs = Date.now() - started;
  }
  return embedder;
}

function needStore() {
  if (!store) throw new Error(bootInfo.dbError ? `记忆库初始化失败：${bootInfo.dbError}` : '记忆库未初始化，先调用 init');
  return store;
}

// ------------------------------------------------------------------ Step 2 写入
const VECTOR_DUPLICATE = 0.97; // 同一主键下，向量几乎一样就不再新增

function numbersIn(text) {
  const found = String(text || '').match(/\d+(?:\.\d+)?/g);
  return found ? found.map((n) => Number(n)) : [];
}

// 数值规则：两边都带数字且没有交集 → 视为不同事实（不合并）
function numbersConflict(a, b) {
  const na = numbersIn(a);
  const nb = numbersIn(b);
  if (!na.length || !nb.length) return false;
  return na.some((x) => !nb.includes(x));
}

function isDuplicateVector(vectors, vec) {
  if (!vec) return true;
  return vectors.some((v) => dot(vec, v.vector) > VECTOR_DUPLICATE);
}

// 合并：保留信息更完整的一条；极性冲突时新表述覆盖旧表述
function mergeRecord(existing, fact, turn, lifeTurn) {
  const polarityConflict = String(existing.polarity) !== fact.polarity;
  const keepNew = polarityConflict || String(fact.fact).length > String(existing.fact || '').length;
  const sources = [...new Set([existing.source_text, fact.source_text].map((s) => String(s || '').trim()).filter(Boolean))];
  return {
    ...existing,
    fact: keepNew ? fact.fact : existing.fact,
    polarity: polarityConflict ? fact.polarity : existing.polarity,
    truth: polarityConflict ? fact.truth : Math.max(Number(existing.truth) || 0, fact.truth),
    activation: Math.min(3, (Number(existing.activation) || 0) + 0.35),
    last_update_turn: Number(turn) || 0,
    // 重新被压缩提到 = 再次确认，生命周期上按「刚命中」计时，避免一边刷新一边衰减
    last_hit_turn: Number.isFinite(Number(lifeTurn)) ? Number(lifeTurn) : existing.last_hit_turn,
    layer: 'hot',
    source_text: sources.join(' / ').slice(0, 600),
  };
}

async function upsertFacts(args = {}) {
  const db = needStore();
  const rawFacts = Array.isArray(args.facts) ? args.facts : [];
  const facts = rawFacts.map((f) => normalizeFact(f, { defaultSource: args.sourceText })).filter(Boolean);
  const rejected = rawFacts.length - facts.length;
  if (!facts.length) {
    return { inserted: 0, mergedHash: 0, mergedExact: 0, mergedVector: 0, rejected, keys: [], items: [] };
  }

  const turn = Number(args.turn) || Number(db.getMeta('turn_counter', 0)) || 0;
  // Step 4：写入是「刚学到」，生命周期从当前结算轮次起算，不和旧记忆一起按 0 轮衰减
  const lifeTurn = Number(db.getMeta('life_turn', 0)) || 0;
  const threshold = Number.isFinite(Number(args.similarity)) ? Number(args.similarity) : 0.88;
  const embedModel = (embedder && embedder.model) || db.getMeta('embed_model', '') || '';

  // 向量化放在事务外（异步），事务里只做同步写
  const e = await getEmbedder();
  const emb = await e.embed(facts.map((f) => f.fact));
  const vectors = emb.vectors;

  const result = { inserted: 0, mergedHash: 0, mergedExact: 0, mergedVector: 0, rejected, keys: [], items: [] };

  const tx = db.transaction(() => {
    facts.forEach((fact, i) => {
      const vec = vectors[i];
      const existing = db.getMemory(fact.key);
      let target = existing;
      let mode = 'inserted';

      if (target) {
        mode = 'mergedHash';
      } else {
        // 第二层（兜底）：主键不同、但 fact 文本完全一样 —— 同义 object 归一化不同导致的重复行
        const exact = db.findByFact(fact.fact);
        if (
          exact &&
          exact.subject === fact.subject &&
          exact.relation === fact.relation &&
          String(exact.polarity) === fact.polarity
        ) {
          target = db.getMemory(exact.key);
          mode = 'mergedExact';
        }
      }

      if (!target && vec && vec.length) {
        // 第三层：向量兜底。relation / subject / polarity 必须一致，数值不能冲突
        const hit = db
          .searchVectors(vec, { limit: 5 })
          .find(
            (c) =>
              c.score >= threshold &&
              c.relation === fact.relation &&
              c.subject === fact.subject &&
              String(c.polarity) === fact.polarity &&
              !numbersConflict(c.fact, fact.fact),
          );
        if (hit) {
          target = db.getMemory(hit.key);
          mode = 'mergedVector';
        }
      }

      if (!target) {
        db.upsertMemory({
          ...fact,
          activation: args.activation != null ? Number(args.activation) : 1,
          pinned: 0,
          layer: 'hot',
          created_turn: turn,
          last_update_turn: turn,
          last_hit_turn: lifeTurn,
        });
        target = db.getMemory(fact.key);
        mode = 'inserted';
        result.inserted += 1;
      } else {
        const merged = mergeRecord(target, fact, turn, lifeTurn);
        db.upsertMemory(merged);
        target = db.getMemory(target.key);
        if (mode === 'mergedVector') result.mergedVector += 1;
        else if (mode === 'mergedExact') result.mergedExact += 1;
        else result.mergedHash += 1;
      }

      if (vec && vec.length && !isDuplicateVector(db.getVectors(target.key), vec)) {
        db.addVector(target.key, vec, { embedModel, createdTurn: turn, maxVectors: 5 });
      }

      result.keys.push(target.key);
      result.items.push({
        key: target.key,
        mode,
        fact: target.fact,
        relation: target.relation,
        polarity: target.polarity,
        truth: target.truth,
        activation: target.activation,
      });
    });
    db.setMeta('turn_counter', String(turn));
  });
  tx();

  return { ...result, turn, embedMs: emb.ms };
}

// 合并老库里的重复行：同 fact 文本 + 同 subject/relation/polarity 视为同一条。
// 保留 pinned / 激活度 / 置信度最高的那行，激活度求和（上限 3），向量挪过去再删重复行。
function dedupeExactMemories(db = needStore()) {
  const groups = new Map();
  for (const row of db.allMemories()) {
    const text = normalizeText(row.fact);
    if (!text) continue;
    const groupKey = `${text}|${row.subject}|${row.relation}|${row.polarity}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(row);
  }

  let merged = 0;
  let affected = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    affected += 1;
    const best = group
      .slice()
      .sort(
        (a, b) =>
          Number(!!b.pinned) - Number(!!a.pinned) ||
          (Number(b.activation) || 0) - (Number(a.activation) || 0) ||
          (Number(b.truth) || 0) - (Number(a.truth) || 0) ||
          (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0),
      )[0];

    let activation = 0;
    let truth = 0;
    let createdTurn = Infinity;
    let lastTurn = 0;
    let lastHitTurn = 0;
    let hitCount = 0;
    let missCount = 0;
    let pinned = false;
    const sources = new Set();
    for (const row of group) {
      activation += Number(row.activation) || 0;
      truth = Math.max(truth, Number(row.truth) || 0);
      createdTurn = Math.min(createdTurn, Number(row.created_turn) || 0);
      lastTurn = Math.max(lastTurn, Number(row.last_update_turn) || 0);
      lastHitTurn = Math.max(lastHitTurn, Number(row.last_hit_turn) || 0);
      hitCount += Number(row.hit_count) || 0;
      missCount += Number(row.miss_count) || 0;
      pinned = pinned || !!row.pinned;
      String(row.source_text || '')
        .split(' / ')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => sources.add(s));
    }

    db.upsertMemory({
      ...best,
      activation: Math.min(3, activation),
      truth: Math.max(truth, Number(best.truth) || 0),
      pinned: pinned ? 1 : 0,
      created_turn: Number.isFinite(createdTurn) ? createdTurn : Number(best.created_turn) || 0,
      last_update_turn: Math.max(lastTurn, Number(best.last_update_turn) || 0),
      last_hit_turn: Math.max(lastHitTurn, Number(best.last_hit_turn) || 0),
      hit_count: hitCount,
      miss_count: missCount,
      source_text: [...sources].join(' / ').slice(0, 600),
    });

    for (const row of group) {
      if (row.key === best.key) continue;
      db.moveVectors(row.key, best.key);
      db.deleteMemory(row.key);
      merged += 1;
    }
    db.trimVectors(best.key, 5);
  }

  return { merged, groups: affected, memories: db.stats().memories };
}

const handlers = {
  async init(args = {}) {
    if (store) store.close();
    const dbPath = args.dbPath || path.join(process.cwd(), 'memory.db');
    store = openDatabase(dbPath);
    if (args.modelDir) modelDir = resolveModelDir(args.modelDir);
    return {
      ...store.stats(),
      modelDir,
      modelReady: !!embedder,
      modelLoadMs: bootInfo.modelLoadMs || 0,
    };
  },
  async embed(args = {}) {
    const e = await getEmbedder();
    const texts = Array.isArray(args.texts) ? args.texts : [args.text];
    const out = await e.embed(texts);
    return {
      ...out,
      model: e.model,
      dim: e.dim,
      loadMs: e.loadMs,
      modelLoadMs: bootInfo.modelLoadMs || 0,
    };
  },
  async upsert(args = {}) {
    const db = needStore();
    const record = db.upsertMemory(args.memory || args);
    let vectorId = 0;
    if (args.vector && args.vector.length) {
      vectorId = db.addVector(record.key, args.vector, {
        embedModel: args.embedModel || (embedder && embedder.model) || db.getMeta('embed_model', ''),
        createdTurn: args.createdTurn || 0,
        maxVectors: args.maxVectors || 5,
      });
    }
    return { record, vectorId };
  },
  async upsertFacts(args = {}) {
    return upsertFacts(args);
  },
  async addVector(args = {}) {
    const db = needStore();
    const id = db.addVector(args.key || args.memoryKey, args.vector, {
      embedModel: args.embedModel || (embedder && embedder.model) || db.getMeta('embed_model', ''),
      createdTurn: args.createdTurn || 0,
      maxVectors: args.maxVectors || 5,
    });
    return { id };
  },
  async search(args = {}) {
    const db = needStore();
    const e = await getEmbedder();
    const out = await e.embed(args.query || args.text || '');
    const vector = out.vectors[0];
    return {
      query: args.query || args.text || '',
      embedMs: out.ms,
      results: db.searchVectors(vector, {
        limit: args.limit || 10,
        relations: args.relations || null,
        includeCold: !!args.includeCold,
      }),
    };
  },
  async searchVector(args = {}) {
    const db = needStore();
    return {
      results: db.searchVectors(args.vector, {
        limit: args.limit || 10,
        relations: args.relations || null,
        includeCold: !!args.includeCold,
      }),
    };
  },
  async searchText(args = {}) {
    const db = needStore();
    return { results: db.searchText(args.query || args.text || '', args) };
  },
  // Step 3：双路召回 + 阈值 + VIP + 打分 + 截断 + Prompt 拼装
  async retrieve(args = {}) {
    const db = needStore();
    const query = String(args.query || args.text || '').trim();
    if (!query) {
      lastCandidateKeys = [];
      lastInjectedKeys = [];
      return {
        query: '',
        block: '',
        items: [],
        dropped: { belowTheta: 0, overLimit: 0, vipOverLimit: 0 },
        params: {},
        keywordTerms: [],
        embedMs: 0,
      };
    }
    const e = await getEmbedder();
    const q = await e.embed(query);
    const qv = q.vectors[0];
    const vectorTopK = Math.max(1, Math.min(30, Number(args.vectorTopK) || 12));
    const textTopK = Math.max(1, Math.min(30, Number(args.textTopK) || 12));
    const terms = keywordTerms(query, Math.max(1, Math.min(20, Number(args.maxKeywordTerms) || DEFAULTS.maxKeywordTerms)));

    const vectorHits = db.searchVectors(qv, { limit: vectorTopK });
    const textHits = terms.length ? db.searchTextAny(terms, { limit: textTopK }) : [];

    // 按主键合并两路召回；关键词命中但没进向量 Top-K 的，补算一次相似度
    const byKey = new Map();
    for (const hit of vectorHits) {
      const prev = byKey.get(hit.key);
      if (!prev || hit.score > prev.similarity) byKey.set(hit.key, { ...hit, similarity: hit.score });
    }
    const missing = textHits.filter((hit) => !byKey.has(hit.key));
    let textEmbedMs = 0;
    if (missing.length) {
      const emb = await e.embed(missing.map((hit) => hit.fact));
      textEmbedMs = emb.ms;
      missing.forEach((hit, i) => {
        const sim = dot(qv, emb.vectors[i]);
        if (sim >= 0) byKey.set(hit.key, { ...hit, similarity: sim });
      });
    }

    const opts = {};
    ['thetaSim', 'maxInject', 'maxChars', 'maxVip'].forEach((key) => {
      if (args[key] != null && Number.isFinite(Number(args[key]))) opts[key] = Number(args[key]);
    });
    const selected = selectMemories([...byKey.values()], opts);
    lastCandidateKeys = selected.candidateKeys || [];
    lastInjectedKeys = selected.items.map((m) => m.key);
    return {
      query,
      block: formatMemoryBlock(selected.items, memoryPromptTemplate()),
      items: selected.items,
      candidateCount: lastCandidateKeys.length,
      dropped: selected.dropped,
      params: selected.params,
      keywordTerms: terms,
      vectorHits: vectorHits.length,
      textHits: textHits.length,
      embedMs: q.ms + textEmbedMs,
    };
  },
  async list(args = {}) {
    return { results: needStore().listMemories(args.limit || 50) };
  },
  async delete(args = {}) {
    const db = needStore();
    const key = String(args.key || '').trim();
    if (!key) throw new Error('缺少 key');
    const deleted = db.deleteMemory(key);
    return { key, deleted, memories: db.stats().memories };
  },
  async pin(args = {}) {
    const db = needStore();
    const key = String(args.key || '').trim();
    if (!key) throw new Error('缺少 key');
    const pinned = args.pinned == null ? true : !!args.pinned;
    const record = db.setPinned(key, pinned);
    if (!record) throw new Error('记忆不存在：' + key);
    return { record };
  },
  // 手动整理：合并同 fact 文本的重复行（启动时也会自动跑一次）
  async dedupe() {
    return dedupeExactMemories(needStore());
  },
  // Step 4：轮次结束结算（MEM_MARK）+ 幂律衰减 + 分层 + 挂起删除
  async settle(args = {}) {
    const db = needStore();
    const num = (value, fallback, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, n));
    };
    const thetaCold = num(args.thetaCold, LIFE_DEFAULTS.thetaCold, 0.01, 0.9);
    const policy = {
      boost: num(args.boost, LIFE_DEFAULTS.boost, 0, 2),
      penalty: num(args.penalty, LIFE_DEFAULTS.penalty, 0, 2),
      thetaWarm: num(args.thetaWarm, LIFE_DEFAULTS.thetaWarm, thetaCold, 2),
      thetaCold,
      deleteTurns: Math.round(num(args.deleteTurns, LIFE_DEFAULTS.deleteTurns, 1, 500)),
      lowTruth: num(args.lowTruth, LIFE_DEFAULTS.lowTruth, 0, 1),
      decayScale: num(args.decayScale, LIFE_DEFAULTS.decayScale, 0.2, 3),
      minActivation: LIFE_DEFAULTS.minActivation,
      maxActivation: LIFE_DEFAULTS.maxActivation,
    };
    const rawTurn = Number(args.turn);
    const prevTurn = Number(db.getMeta('life_turn', 0)) || 0;
    const turn = Number.isFinite(rawTurn) && rawTurn > 0 ? Math.round(rawTurn) : prevTurn + 1;
    const toKeys = (input) => new Set((Array.isArray(input) ? input : []).map((k) => String(k || '')).filter(Boolean));
    const injected = toKeys(Array.isArray(args.injectedKeys) ? args.injectedKeys : lastInjectedKeys);
    const wrong = toKeys(args.wrongKeys);
    const candidates = toKeys(Array.isArray(args.candidateKeys) ? args.candidateKeys : lastCandidateKeys);

    const stats = {
      turn,
      updated: 0,
      boosted: 0,
      penalized: 0,
      decayed: 0,
      layerChanged: 0,
      deleted: 0,
      hot: 0,
      warm: 0,
      cold: 0,
    };

    const tx = db.transaction(() => {
      for (const row of db.allMemories()) {
        const next = settleMemory(row, { turn, injected, wrong, candidates, policy });
        if (next.deleted) {
          db.deleteMemory(row.key);
          stats.deleted += 1;
          continue;
        }
        const changed =
          Number(row.activation) !== Number(next.activation) ||
          String(row.layer) !== String(next.layer) ||
          Number(row.last_hit_turn) !== Number(next.last_hit_turn) ||
          Number(row.hit_count) !== Number(next.hit_count) ||
          Number(row.miss_count) !== Number(next.miss_count) ||
          Number(row.delete_streak) !== Number(next.delete_streak);
        if (changed) {
          // 衰减不改 updated_at；被命中 / 被标记才刷新修改时间
          const touched = injected.has(row.key) || wrong.has(row.key);
          db.updateLifecycle(row.key, { ...next, updated_at: touched ? Date.now() : row.updated_at });
          stats.updated += 1;
          if (String(row.layer) !== String(next.layer)) stats.layerChanged += 1;
        }
        if (injected.has(row.key) && !wrong.has(row.key)) stats.boosted += 1;
        if (wrong.has(row.key)) stats.penalized += 1;
        if (!injected.has(row.key) && !wrong.has(row.key) && row.relation !== 'constraint' && !row.pinned) {
          stats.decayed += 1;
        }
        if (next.layer === 'cold') stats.cold += 1;
        else if (next.layer === 'warm') stats.warm += 1;
        else stats.hot += 1;
      }
      db.setMeta('life_turn', String(turn));
    });
    tx();

    lastCandidateKeys = [];
    lastInjectedKeys = [];
    return stats;
  },
  async stats() {
    const db = needStore();
    const base = db.stats();
    base.lifeTurn = Number(db.getMeta('life_turn', 0)) || 0;
    if (embedder) {
      base.embedModel = embedder.model;
      base.embedDim = embedder.dim;
      base.modelLoadMs = bootInfo.modelLoadMs || 0;
    }
    return { ...base, modelDir, modelReady: !!embedder, bootInfo };
  },
  async reset(args = {}) {
    return needStore().reset(args);
  },
  async close() {
    if (store) {
      store.close();
      store = null;
    }
    return { closed: true };
  },
};

parentPort.on('message', async (msg) => {
  const { id, cmd, args } = msg || {};
  try {
    const handler = handlers[cmd];
    if (!handler) throw new Error('未知命令：' + cmd);
    const result = await handler(args);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: (err && err.message) || String(err),
      stack: err && err.stack ? String(err.stack) : '',
    });
  }
});
