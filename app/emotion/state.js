// ============================================================================
//  情感状态存取（主进程）
//
//  - 每个角色一份：<DataRoot>/characters/<id>/emotion.json
//  - 读：缺字段按默认补齐、数值夹取、坏文件不抛错（当作新档案并备份）
//  - 写：原子落盘 + 短防抖（每轮对话都会更新，没必要次次同步写）
//  - 心情原型向量缓存：emotion.vectors.json，同一个目录
// ============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const engine = require('./engine');

const FILE_NAME = 'emotion.json';
const VECTORS_FILE = 'emotion.vectors.json';
const SAVE_DEBOUNCE_MS = 800;

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// 原子写：先写临时文件再改名，避免半截 JSON
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function isIsoLike(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

function num(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 性格：接受 0~1 或 0~100 两种写法，统一成 0~1
function personalityValue(v, fallback) {
  const n = num(v, fallback);
  return engine.clamp(n > 1 ? n / 100 : n, 0, 1);
}

// 校验 + 补齐，返回 { state, repaired }
// repaired 表示修了多少项，面板可以提示「已用默认值修复 N 项」
function sanitize(raw, character) {
  const now = new Date();
  const base = engine.defaultState(now);
  let repaired = 0;
  const bump = () => { repaired += 1; };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: base, repaired: 0, fresh: true };
  }

  const s = base;

  // 时间戳
  if (isIsoLike(raw.updated)) s.updated = raw.updated;
  else if (raw.updated != null) bump();
  if (isIsoLike(raw.startedAt)) s.startedAt = raw.startedAt;
  else s.startedAt = s.updated;
  s.version = 1;

  // 底色
  const profile = raw.profile && typeof raw.profile === 'object' ? raw.profile : {};
  const charName = (character && character.name) || '';
  s.profile.name = typeof profile.name === 'string' ? profile.name : charName;
  if (!s.profile.name && charName) s.profile.name = charName;
  s.profile.together_since = isIsoLike(profile.together_since) ? profile.together_since : null;
  if (profile.together_since != null && !s.profile.together_since) bump();

  for (const key of engine.PERSONALITY_KEYS) {
    const v = raw.personality && raw.personality[key];
    const def = engine.PERSONALITY_DEFAULT[key];
    if (v != null && !Number.isFinite(Number(v))) bump();
    s.personality[key] = personalityValue(v, def);
  }

  // 四组 0~100 数值
  const groups = [
    ['body', engine.BODY_REST],
    ['hormones', engine.HORMONE_REST],
    ['relation', engine.RELATION_REST],
    ['talents', engine.TALENT_DEFAULT],
  ];
  for (const [group, rest] of groups) {
    const src = raw[group] && typeof raw[group] === 'object' ? raw[group] : {};
    for (const key of Object.keys(rest)) {
      const v = num(src[key], rest[key]);
      s[group][key] = engine.clamp(v, 0, 100);
    }
  }

  // 恐惧
  const fear = raw.fear && typeof raw.fear === 'object' ? raw.fear : null;
  if (fear && num(fear.v, 0) >= engine.FEAR_SHOW) {
    s.fear = {
      v: engine.clamp(num(fear.v, 0), 0, 100),
      why: typeof fear.why === 'string' ? fear.why : '',
      t: isIsoLike(fear.t) ? fear.t : now.toISOString(),
    };
  } else {
    s.fear = null;
  }

  // 上一次情绪
  s.last_inner = typeof raw.last_inner === 'string' ? raw.last_inner : null;
  s.last_valence = engine.clamp(num(raw.last_valence, 50), 0, 100);
  s.last_signed = Number.isFinite(Number(raw.last_signed)) ? Number(raw.last_signed) : null;

  // 今日额度
  const today = raw.today && typeof raw.today === 'object' ? raw.today : {};
  s.today = {
    date: typeof today.date === 'string' ? today.date : engine.dateKey(now),
    sent: Math.round(engine.clamp(num(today.sent, 0), 0, 99)),
  };

  s.lastProactiveAt = isIsoLike(raw.lastProactiveAt) ? raw.lastProactiveAt : null;
  s.lastCheckAt = isIsoLike(raw.lastCheckAt) ? raw.lastCheckAt : null;
  s.lastUserAt = isIsoLike(raw.lastUserAt) ? raw.lastUserAt : null;
  s.lastIgnoredProactiveAt = isIsoLike(raw.lastIgnoredProactiveAt) ? raw.lastIgnoredProactiveAt : null;

  // 回复统计：只影响雷达展示
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  s.stats = {
    replies: Math.round(engine.clamp(num(stats.replies, 0), 0, 1e7)),
    intimate: Math.round(engine.clamp(num(stats.intimate, 0), 0, 1e7)),
    cold: Math.round(engine.clamp(num(stats.cold, 0), 0, 1e7)),
    questions: Math.round(engine.clamp(num(stats.questions, 0), 0, 1e7)),
    tsundere: Math.round(engine.clamp(num(stats.tsundere, 0), 0, 1e7)),
    valenceSum: engine.clamp(num(stats.valenceSum, 0), 0, 1e9),
    valenceSqSum: engine.clamp(num(stats.valenceSqSum, 0), 0, 1e9),
  };

  // 事件流水：只认需要的最小字段，滚动 40 条
  if (Array.isArray(raw.events)) {
    s.events = raw.events
      .filter((e) => e && typeof e === 'object' && typeof e.kind === 'string')
      .map((e) => {
        const ev = {
          t: isIsoLike(e.t) ? e.t : now.toISOString(),
          kind: String(e.kind),
          intensity: engine.clamp(num(e.intensity, 1), 0, 2),
          src: typeof e.src === 'string' ? e.src : 'vector',
        };
        if (Number.isFinite(Number(e.sim))) ev.sim = Number(e.sim);
        return ev;
      })
      .slice(-40);
  }

  return { state: s, repaired, fresh: false };
}

// 角色目录：优先用角色对象里的绝对 dir，其次按 DataRoot/characters/<id>
function createEmotionStore({ dataRoot, log = () => {} } = {}) {
  const charactersDir = dataRoot ? path.join(dataRoot, 'characters') : '';
  const pending = new Map(); // id -> { timer, state }

  function dirFor(id, character) {
    if (character && character.dir) return character.dir;
    if (!charactersDir) return '';
    const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!safe) return '';
    return path.join(charactersDir, safe);
  }

  function fileFor(id, character) {
    const dir = dirFor(id, character);
    return dir ? path.join(dir, FILE_NAME) : '';
  }

  function vectorsFileFor(id, character) {
    const dir = dirFor(id, character);
    return dir ? path.join(dir, VECTORS_FILE) : '';
  }

  function load(id, character) {
    const file = fileFor(id, character);
    if (!file) return { ok: false, error: '角色目录不可用', state: engine.defaultState(new Date()) };
    let raw = null;
    if (exists(file)) {
      raw = readJson(file);
      if (raw == null) {
        // 文件坏了：备份一份，后面按默认值重建
        try {
          fs.renameSync(file, `${file}.broken-${Date.now()}`);
        } catch (_) { /* 备份失败也不影响继续 */ }
        log('[emotion] 状态文件损坏，已按默认值重建', file);
      }
    }
    const result = sanitize(raw, character);
    return {
      ok: true,
      state: result.state,
      repaired: result.repaired,
      fresh: result.fresh || !raw,
      path: file,
    };
  }

  // 防抖落盘：同一角色 800ms 内的多次更新合并成一次
  function save(id, state, { immediate = false } = {}) {
    const file = fileFor(id);
    if (!file || !state) return { ok: false, error: '角色目录不可用' };
    const slot = pending.get(id) || {};
    if (slot.timer) clearTimeout(slot.timer);
    slot.state = state;
    slot.file = file;
    slot.timer = null;
    pending.set(id, slot);
    if (immediate) return flush(id);
    slot.timer = setTimeout(() => {
      flush(id);
    }, SAVE_DEBOUNCE_MS);
    if (slot.timer.unref) slot.timer.unref();
    return { ok: true, deferred: true, path: file };
  }

  function flush(id) {
    const slot = pending.get(id);
    if (!slot || !slot.file || !slot.state) return { ok: true, skipped: true };
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    try {
      writeJsonAtomic(slot.file, slot.state);
      pending.delete(id);
      return { ok: true, path: slot.file };
    } catch (err) {
      const msg = String((err && err.message) || err);
      log('[emotion] 状态落盘失败', msg);
      return { ok: false, error: msg };
    }
  }

  function flushAll() {
    for (const id of [...pending.keys()]) flush(id);
  }

  function reset(id, character) {
    const state = engine.defaultState(new Date());
    const file = fileFor(id, character);
    if (!file) return { ok: false, error: '角色目录不可用' };
    try {
      writeJsonAtomic(file, state);
      const slot = pending.get(id);
      if (slot && slot.timer) clearTimeout(slot.timer);
      pending.delete(id);
      return { ok: true, state, path: file };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // 心情原型向量缓存
  function readVectors(id, character) {
    const file = vectorsFileFor(id, character);
    if (!file || !exists(file)) return null;
    const raw = readJson(file);
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  }

  function writeVectors(id, character, data) {
    const file = vectorsFileFor(id, character);
    if (!file) return { ok: false, error: '角色目录不可用' };
    try {
      writeJsonAtomic(file, data);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  return {
    dirFor, fileFor, vectorsFileFor,
    load, save, flush, flushAll, reset,
    readVectors, writeVectors,
  };
}

module.exports = { createEmotionStore, sanitize, FILE_NAME, VECTORS_FILE };
