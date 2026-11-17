// 图片虚拟别名（image_map.json）
// 模型只看到 [image_3] 这样的别名，物理路径由主进程查表还原。
//   * 同一物理路径永远复用同一个别名
//   * 只对「真实存在」的图片分配别名，死链不占名额
//   * 容量按 LRU 限制条数，另有最长保留时间；不复制图片本体
const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAP_FILE = 'image_map.json';

// {"C:\...\a.png"} 这种包裹形式：只有它才会在用户/插件文本里被识别
const WRAPPED_RE = /\{("((?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/])[^"\r\n]*?\.(?:png|jpe?g|webp|gif|bmp))")\}/gi;
// 工具结果里的裸绝对路径（含 JSON 转义的双反斜杠）
const BARE_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/])[^\r\n<>"|?*]*?\.(?:png|jpe?g|webp|gif|bmp)/gi;
const ALIAS_RE = /^\[?image_(\d+)\]?$/i;
const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').trim().toLowerCase();
}

// JSON 里的路径可能写成 C:\\Users\\...，还原成真实路径再查文件
function unescapePath(p) {
  return String(p || '').replace(/\\\\/g, '\\');
}

function isRealImage(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch (_) {
    return false;
  }
}

// 代码块 / 行内代码里的路径不碰：避免把示例代码里的路径换掉
function mapOutsideCode(text, fn) {
  let out = '';
  let last = 0;
  for (const hit of text.matchAll(FENCE_RE)) {
    if (hit.index > last) out += mapOutsideInline(text.slice(last, hit.index), fn);
    out += hit[0];
    last = hit.index + hit[0].length;
  }
  if (last < text.length) out += mapOutsideInline(text.slice(last), fn);
  return out;
}

function mapOutsideInline(chunk, fn) {
  if (!chunk) return '';
  let out = '';
  let last = 0;
  for (const hit of chunk.matchAll(INLINE_CODE_RE)) {
    if (hit.index > last) out += fn(chunk.slice(last, hit.index));
    out += hit[0];
    last = hit.index + hit[0].length;
  }
  if (last < chunk.length) out += fn(chunk.slice(last));
  return out;
}

function createImageAlias({ dir, maxItems = MAX_ITEMS, maxAgeMs = MAX_AGE_MS, log = () => {} } = {}) {
  const baseDir = dir || path.join(process.cwd(), 'image-map');
  const file = path.join(baseDir, MAP_FILE);
  /** @type {Map<string, {path: string, added_at: number, last_used: number}>} */
  const items = new Map();
  /** @type {Map<string, string>} 归一化物理路径 → 别名 */
  const byPath = new Map();
  let counter = 1;
  let dirty = false;

  function rebuildIndex() {
    byPath.clear();
    for (const [alias, item] of items) byPath.set(normPath(item.path), alias);
  }

  function persist() {
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      const body = { next: counter, items: Object.fromEntries(items) };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`图片别名表写入失败：${err && err.message ? err.message : err}`);
    }
  }

  function gcItems() {
    const now = Date.now();
    let changed = false;
    for (const [alias, item] of items) {
      if (now - Number(item.added_at || 0) > maxAgeMs || !isRealImage(item.path)) {
        items.delete(alias);
        changed = true;
      }
    }
    if (items.size > maxItems) {
      const ordered = [...items].sort((a, b) => Number(a[1].last_used || 0) - Number(b[1].last_used || 0));
      for (const [alias] of ordered.slice(0, items.size - maxItems)) {
        items.delete(alias);
        changed = true;
      }
    }
    if (changed) {
      rebuildIndex();
      dirty = true;
      persist();
    }
  }

  function load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      raw = null;
    }
    const now = Date.now();
    if (raw && raw.items && typeof raw.items === 'object') {
      for (const [alias, item] of Object.entries(raw.items)) {
        if (!item || typeof item.path !== 'string' || !item.path) continue;
        if (!/^\[image_\d+\]$/.test(alias)) continue;
        items.set(alias, {
          path: item.path,
          added_at: Number(item.added_at) || now,
          last_used: Number(item.last_used) || Number(item.added_at) || now,
        });
      }
    }
    let next = Number(raw && raw.next);
    if (!Number.isFinite(next) || next < 1) next = 1;
    for (const alias of items.keys()) {
      const n = Number(alias.replace(/\D/g, ''));
      if (n >= next) next = n + 1;
    }
    counter = next;
    rebuildIndex();
    gcItems();
  }

  function assign(realPath) {
    const now = Date.now();
    const key = normPath(realPath);
    const existing = byPath.get(key);
    if (existing && items.has(existing)) {
      const item = items.get(existing);
      item.last_used = now;
      dirty = true; // 只在下次落盘时带上新的 last_used，不额外写盘
      return existing;
    }
    const alias = `[image_${counter++}]`;
    items.set(alias, { path: realPath, added_at: now, last_used: now });
    byPath.set(key, alias);
    gcItems();
    dirty = true;
    persist();
    return alias;
  }

  function remove(aliasOrPath) {
    const raw = String(aliasOrPath || '').trim();
    const alias = ALIAS_RE.test(raw) ? `[image_${raw.replace(/\D/g, '')}]` : byPath.get(normPath(raw));
    if (!alias || !items.has(alias)) return false;
    items.delete(alias);
    rebuildIndex();
    dirty = true;
    persist();
    return true;
  }

  load();

  return {
    // 把文本里的图片路径换成别名。
    //   bare=false  只认 {"路径"} 包裹形式（用户消息里的约定写法）
    //   bare=true   额外识别裸绝对路径（插件工具结果本来就这样返回）
    //   onlyPaths   给了就只换列表里的路径，避免误伤正文里的其他路径
    aliasizeText(text, { bare = false, onlyPaths = null } = {}) {
      const src = String(text == null ? '' : text);
      if (!src) return src;
      const allowed = Array.isArray(onlyPaths) && onlyPaths.length ? new Set(onlyPaths.map(normPath)) : null;
      const aliasFor = (candidate) => {
        const real = unescapePath(candidate);
        if (allowed && !allowed.has(normPath(real))) return null;
        if (!isRealImage(real)) return null;
        return assign(real);
      };

      return mapOutsideCode(src, (chunk) => {
        let out = chunk.replace(WRAPPED_RE, (whole, _quoted, candidate) => {
          const alias = aliasFor(candidate);
          return alias || whole;
        });
        if (bare) {
          out = out.replace(BARE_RE, (whole) => {
            const alias = aliasFor(whole);
            return alias || whole;
          });
        }
        return out;
      });
    },

    // 别名 → 物理路径；别名不存在或文件已失效时返回 null，并顺手清掉死链
    resolveAlias(alias) {
      const raw = String(alias || '').trim();
      const m = raw.match(ALIAS_RE);
      if (!m) return null;
      const key = `[image_${m[1]}]`;
      const item = items.get(key);
      if (!item) return null;
      if (!isRealImage(item.path)) {
        remove(key);
        return null;
      }
      item.last_used = Date.now();
      dirty = true;
      return item.path;
    },

    // 物理路径 → 别名（不存在则 null）
    aliasOf(realPath) {
      return byPath.get(normPath(realPath)) || null;
    },

    remove,

    // 最近使用的 N 条：给 @ 引用面板用，列之前先清掉已失效 / 过期的条目
    list(limit = 5) {
      gcItems();
      return [...items]
        .sort((a, b) => Number(b[1].last_used || 0) - Number(a[1].last_used || 0))
        .slice(0, Math.max(1, limit))
        .map(([alias, item]) => ({ alias, path: item.path, added_at: item.added_at, last_used: item.last_used }));
    },

    gc: gcItems,

    // 重置编号：把现有别名按旧编号压紧成 1..N（保留映射），返回 old → new 供上层改写历史
    reset() {
      const ordered = [...items.keys()]
        .map((alias) => ({ alias, n: Number(alias.replace(/\D/g, '')) }))
        .sort((a, b) => a.n - b.n);
      const mapping = {};
      const nextItems = new Map();
      ordered.forEach(({ alias }, i) => {
        const to = `[image_${i + 1}]`;
        if (to !== alias) mapping[alias] = to;
        nextItems.set(to, items.get(alias));
      });
      items.clear();
      for (const [alias, item] of nextItems) items.set(alias, item);
      counter = items.size + 1;
      rebuildIndex();
      dirty = true;
      persist();
      return mapping;
    },

    file,
  };
}

module.exports = { createImageAlias, MAX_ITEMS, MAX_AGE_MS };
