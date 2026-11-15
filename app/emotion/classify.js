// ============================================================================
//  事件识别：原型向量 kNN
//
//  给每类事件一组原型句（prototypes.json），首次使用时批量向量化并缓存
//  到 emotion.vectors.json；之后每次只 embed 一条文本（她自己的回复），和原型算余弦取最高分。
//
//  依赖全部由外部注入，本文件不直接碰 petApi / IPC：
//    embed(texts)   → { vectors, dim, model }
//    readCache()    → 向量缓存对象或 null
//    writeCache(obj)→ 落盘
//    getModel()     → 当前 embed 模型名（可选，用于判断缓存是否失效）
// ============================================================================

const DEFAULTS = {
  threshold: 0.62,     // 命中阈值
  maxHits: 2,          // 一句话最多命中几类
  cooldownMs: 90000,   // 同类事件冷却，期间合并
  sceneGateSim: 0.80,  // 场景类事件高于这个相似度才免场景词校验
};

// 场景类事件：光靠「好黑啊」不该触发恐惧
const SCENE_WORDS = {
  horror: ['鬼', '恐怖', '吓人'],
  thunder: ['打雷', '雷'],
  night_walk: ['夜路', '黑', '一个人走', '回家'],
};

// 关键词直通的等效相似度：比向量命中略高，保证它排在第一位
const KEYWORD_SIM = 0.88;

// 关键词匹配（纯函数，导出便于单测）：
// 每类取命中的最长词，按长度优先、最多 maxHits 类
export function matchKeywords(table, text, maxHits = DEFAULTS.maxHits) {
  const q = String(text || '');
  const limit = Math.max(1, Math.floor(Number(maxHits)) || 1);
  const out = [];
  if (!table || typeof table !== 'object') return out;
  for (const kind of Object.keys(table)) {
    if (kind.startsWith('_')) continue;
    const list = table[kind];
    if (!Array.isArray(list)) continue;
    let best = '';
    for (const word of list) {
      if (typeof word === 'string' && word && q.includes(word) && word.length > best.length) best = word;
    }
    if (best) out.push({ kind, sim: KEYWORD_SIM, text: best });
  }
  out.sort((a, b) => b.sim - a.sim || b.text.length - a.text.length);
  return out.slice(0, limit).map((h) => ({ ...h, intensity: intensityOf(h.sim) }));
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function round(v, digits) {
  const p = 10 ** (digits || 0);
  return Math.round(Number(v) * p) / p;
}

function intensityOf(sim) {
  return round(clamp((sim - 0.55) / 0.35, 0.2, 1.6), 2);
}

// 向量都已 L2 归一化，点积即余弦；这里仍做除范数兜底
function cosine(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// 原型内容指纹：改了 prototypes.json 自动重建缓存
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function flatten(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  for (const kind of Object.keys(data)) {
    if (kind.startsWith('_')) continue;
    const list = data[kind];
    if (!Array.isArray(list)) continue;
    for (const text of list) {
      if (typeof text === 'string' && text.trim()) out.push({ kind, text: text.trim() });
    }
  }
  return out;
}

async function loadPrototypesFromAsset() {
  const url = new URL('./prototypes.json', import.meta.url);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`原型文件读取失败：HTTP ${res.status}`);
  return res.json();
}

// 关键词表：常见心情词直接归位，不用向量（短句向量区分度差）
async function loadKeywordsFromAsset() {
  try {
    const url = new URL('./keywords.json', import.meta.url);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return {};
    return await res.json();
  } catch (err) {
    return {};
  }
}

export function createEmotionClassifier(options = {}) {
  const opts = {
    embed: null,
    readCache: null,
    writeCache: null,
    getModel: null,
    log: () => {},
    prototypes: null,
    ...options,
  };
  const cfg = { ...DEFAULTS, ...(options.config || {}) };

  let items = null;          // [{ kind, text, vec: Float32Array }]
  let model = '';
  let dim = 0;
  let building = null;
  let lastResult = null;
  let keywordTable = null;
  const applied = new Map(); // kind -> { at, intensity }

  // 关键词直通：命中直接返回，不再走向量
  async function keywordHits(text) {
    if (!keywordTable) keywordTable = await loadKeywordsFromAsset();
    return matchKeywords(keywordTable, text, cfg.maxHits);
  }

  function passSceneGate(kind, sim, text) {
    const words = SCENE_WORDS[kind];
    if (!words) return true;
    if (sim >= cfg.sceneGateSim) return true;
    return words.some((w) => text.includes(w));
  }

  async function safeRead() {
    if (typeof opts.readCache !== 'function') return null;
    try {
      return await opts.readCache();
    } catch (err) {
      opts.log('[emotion] 读取向量缓存失败', String((err && err.message) || err));
      return null;
    }
  }

  async function safeWrite(data) {
    if (typeof opts.writeCache !== 'function') return;
    try {
      await opts.writeCache(data);
    } catch (err) {
      opts.log('[emotion] 写入向量缓存失败', String((err && err.message) || err));
    }
  }

  async function currentModel() {
    if (typeof opts.getModel !== 'function') return '';
    try {
      return String((await opts.getModel()) || '');
    } catch (_) {
      return '';
    }
  }

  function cacheUsable(cache, hash, modelName) {
    if (!cache || !Array.isArray(cache.items) || !cache.items.length) return false;
    if (cache.hash !== hash) return false;
    if (modelName && cache.model && cache.model !== modelName) return false;
    return cache.items.every((it) => it && it.kind && Array.isArray(it.vec) && it.vec.length);
  }

  // 建立/复用原型向量
  async function ready({ force = false } = {}) {
    if (items && !force) return { ok: true, count: items.length, model, cached: true };
    if (building) return building;
    building = (async () => {
      const started = Date.now();
      let data = opts.prototypes;
      if (typeof data === 'function') data = await data();
      if (!data) data = await loadPrototypesFromAsset();
      const flat = flatten(data);
      if (!flat.length) throw new Error('心情原型为空');
      const hash = fingerprint(JSON.stringify(flat));
      const modelName = await currentModel();

      if (!force) {
        const cached = await safeRead();
        if (cacheUsable(cached, hash, modelName)) {
          items = cached.items.map((it) => ({
            kind: it.kind,
            text: it.text,
            vec: Float32Array.from(it.vec),
          }));
          model = cached.model || modelName;
          dim = cached.dim || (items[0] && items[0].vec.length) || 0;
          const info = { ok: true, count: items.length, model, dim, cached: true, ms: Date.now() - started };
          opts.log(`[emotion] 原型向量缓存命中（${items.length} 条，${info.ms}ms）`);
          return info;
        }
      }

      if (typeof opts.embed !== 'function') throw new Error('向量能力未注入');
      const res = await opts.embed(flat.map((p) => p.text));
      const vectors = (res && res.vectors) || [];
      if (!Array.isArray(vectors) || vectors.length !== flat.length) {
        throw new Error('向量数量与原型数量不符');
      }
      items = flat.map((p, i) => ({ kind: p.kind, text: p.text, vec: Float32Array.from(vectors[i]) }));
      model = res.model || modelName || '';
      dim = res.dim || (items[0] && items[0].vec.length) || 0;

      await safeWrite({
        version: 1,
        model,
        dim,
        hash,
        builtAt: new Date().toISOString(),
        items: items.map((p) => ({
          kind: p.kind,
          text: p.text,
          vec: Array.from(p.vec, (v) => Math.round(v * 1e4) / 1e4),
        })),
      });
      const info = { ok: true, count: items.length, model, dim, rebuilt: true, ms: Date.now() - started };
      opts.log(`[emotion] 原型向量重建完成（${items.length} 条，${info.ms}ms）`);
      return info;
    })()
      .catch((err) => {
        const msg = String((err && err.message) || err);
        opts.log('[emotion] 原型向量准备失败', msg);
        return { ok: false, error: msg };
      })
      .finally(() => { building = null; });
    return building;
  }

  // 单句识别：命中 0~2 类，返回的 intensity 已限制在 0.2~1.6
  // options.noCooldown：自述情绪每轮只来一条，不受 90s 同类冷却影响
  async function classify(text, options = {}) {
    const skipCooldown = !!options.noCooldown;
    const q = String(text || '').trim();
    if (!q) return { hits: [], top: null, reason: 'empty' };

    // 第一路：关键词直通。命中就不走向量，也就不用等模型加载
    const kw = await keywordHits(q);
    if (kw.length) {
      const result = { hits: kw, top: kw[0], model: 'keyword', count: 0, at: Date.now(), byKeyword: true };
      lastResult = result;
      return result;
    }

    // 第二路：原型向量 kNN（同一句只 embed 一次）
    if (options.noVector) return { hits: [], top: null, reason: 'no-keyword' };
    const info = await ready();
    if (!info.ok) return { hits: [], top: null, error: info.error };

    let res;
    try {
      res = await opts.embed([q]);
    } catch (err) {
      const msg = String((err && err.message) || err);
      opts.log('[emotion] 文本向量化失败', msg);
      return { hits: [], top: null, error: msg };
    }
    const vec = (res && res.vectors && res.vectors[0]) || null;
    if (!vec) return { hits: [], top: null, error: '向量为空' };

    // 模型维度变了：缓存作废重建一次
    if (items[0] && vec.length !== items[0].vec.length) {
      items = null;
      const again = await ready({ force: true });
      if (!again.ok) return { hits: [], top: null, error: again.error };
    }

    const best = new Map();
    for (const p of items) {
      const sim = cosine(vec, p.vec);
      const cur = best.get(p.kind);
      if (!cur || sim > cur.sim) best.set(p.kind, { kind: p.kind, sim, text: p.text });
    }
    const ranked = [...best.values()].sort((a, b) => b.sim - a.sim);
    const top = ranked[0] ? { ...ranked[0], sim: round(ranked[0].sim, 3) } : null;

    const now = Date.now();
    const hits = [];
    for (const r of ranked) {
      if (hits.length >= cfg.maxHits) break;
      if (r.sim < cfg.threshold) break;
      if (!passSceneGate(r.kind, r.sim, q)) continue;
      if (!skipCooldown) {
        const rec = applied.get(r.kind);
        if (rec && now - rec.at < cfg.cooldownMs) {
          // 冷却内合并：只把记录强度抬到较大值，不再重复加激素
          rec.intensity = Math.max(rec.intensity, intensityOf(r.sim));
          continue;
        }
      }
      const hit = { kind: r.kind, sim: round(r.sim, 3), intensity: intensityOf(r.sim), text: r.text };
      if (!skipCooldown) applied.set(r.kind, { at: now, intensity: hit.intensity });
      hits.push(hit);
    }

    const result = {
      hits,
      top,
      model,
      count: items.length,
      at: now,
    };
    lastResult = result;
    return result;
  }

  function resetCooldowns() {
    applied.clear();
  }

  function stats() {
    return {
      ready: !!items,
      count: items ? items.length : 0,
      model,
      dim,
      last: lastResult,
      cooldowns: [...applied.entries()].map(([kind, v]) => ({ kind, at: v.at, intensity: v.intensity })),
    };
  }

  return { ready, classify, resetCooldowns, stats };
}

export const EMOTION_CLASSIFY_DEFAULTS = DEFAULTS;
