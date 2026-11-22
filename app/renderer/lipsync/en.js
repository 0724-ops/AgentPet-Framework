// 英文读音 → 口型：CMUdict（构建期生成的 JSON，懒加载）+ 规则 G2P 兜底
// 音素一律使用 ARPAbet 基名（去掉重音数字）。

const VOWELS = {
  AA: ['a'], AE: ['a'], AH: ['a'], AO: ['o'], AW: ['a', 'u'], AY: ['a', 'i'],
  EH: ['e'], ER: ['e'], EY: ['e', 'i'], IH: ['i'], IY: ['i'], OW: ['o', 'u'],
  OY: ['o', 'i'], UH: ['u'], UW: ['u'],
};

const CONS = {
  M: { close: true },
  B: { close: true },
  P: { close: true },
  F: { v: 'i', w: 0.25 },
  V: { v: 'i', w: 0.25 },
  W: { v: 'u', w: 0.5 },
  L: { v: 'e', w: 0.3 },
  R: { v: 'e', w: 0.3 },
};

// 单元音 / 双元音 → 口型步进；辅音按类型给闭唇或轻微开口
export function phonemeSteps(phone) {
  const p = String(phone || '').toUpperCase().replace(/[0-2]$/, '');
  if (!p) return [];
  const vowels = VOWELS[p];
  if (vowels) {
    const dur = vowels.length > 1 ? 0.06 : 0.1;
    return vowels.map((v) => ({ v, w: 1, dur }));
  }
  const c = CONS[p];
  if (c) {
    if (c.close) return [{ close: true, dur: 0.055 }];
    return [{ v: c.v, w: c.w, dur: 0.055 }];
  }
  return [{ v: 'a', w: 0.15, dur: 0.05 }];
}

export function phonemesToSteps(phones) {
  const out = [];
  for (const p of phones || []) out.push(...phonemeSteps(p));
  return out;
}

// ------------------------------------------------------------------ 词典
let enDict = null;
let enDictLoading = null;

export function setEnDictionary(obj) {
  enDict = obj && typeof obj === 'object' ? obj : null;
  return enDict;
}

export async function loadEnDictionary() {
  if (enDict) return enDict;
  if (enDictLoading) return enDictLoading;
  if (typeof fetch !== 'function') return {};
  enDictLoading = fetch(new URL('../lipsync-en.json', import.meta.url))
    .then((res) => (res && res.ok ? res.json() : {}))
    .catch(() => ({}))
    .then((obj) => {
      enDict = obj || {};
      enDictLoading = null;
      return enDict;
    });
  return enDictLoading;
}

// ------------------------------------------------------------------ 规则 G2P
const QUADS = {
  eigh: ['EY'],
  ough: ['AO'],
  augh: ['AO'],
};

const TRIPLES = {
  igh: ['AY'],
  air: ['EH', 'R'],
  ear: ['IH', 'R'],
  oor: ['AO', 'R'],
  dge: ['JH'],
};

const PAIRS = {
  ee: ['IY'], ea: ['IY'], ie: ['IY'], ei: ['EY'], ey: ['EY'], ai: ['EY'], ay: ['EY'],
  oo: ['UW'], ou: ['AW'], ow: ['OW'], oa: ['OW'], oi: ['OY'], oy: ['OY'],
  au: ['AO'], aw: ['AO'], ue: ['UW'], ew: ['UW'], ui: ['UW'], eu: ['UW'],
  ch: ['CH'], sh: ['SH'], th: ['TH'], ph: ['F'], wh: ['W'], ck: ['K'],
  ng: ['NG'], qu: ['K', 'W'], gh: [],
  ar: ['AA', 'R'], er: ['ER'], ir: ['ER'], ur: ['ER'], or: ['AO', 'R'],
};

const LONG_VOWEL = { a: 'EY', e: 'IY', i: 'AY', o: 'OW', u: 'UW' };

const SINGLE_CONS = {
  b: 'B', d: 'D', f: 'F', h: 'HH', j: 'JH', k: 'K', l: 'L', m: 'M', n: 'N',
  p: 'P', r: 'R', t: 'T', v: 'V', w: 'W', z: 'Z',
};

const VOICELESS = new Set(['P', 'T', 'K', 'F', 'S', 'SH', 'CH', 'TH']);

function isVowelLetter(ch) {
  return 'aeiou'.includes(ch);
}

function coreG2P(input) {
  let w = input;
  const out = [];
  // 静音 e：make / time / note，把前一个元音拉长
  let longIdx = -1;
  if (w.length > 3 && w.endsWith('e') && /[^aeiou]e$/.test(w) && /[aeiou]/.test(w.slice(0, -2))) {
    const vowelIdx = w.length - 3;
    if (isVowelLetter(w[vowelIdx])) longIdx = vowelIdx;
    w = w.slice(0, -1);
  }
  let i = 0;
  while (i < w.length) {
    if (i === longIdx) {
      out.push(LONG_VOWEL[w[i]]);
      i += 1;
      continue;
    }
    // 词尾 e 不发音（apple / the）
    if (i === w.length - 1 && w[i] === 'e' && w.length > 2 && !longIdx) {
      i += 1;
      continue;
    }
    const four = w.slice(i, i + 4);
    if (QUADS[four]) {
      out.push(...QUADS[four]);
      i += 4;
      continue;
    }
    const three = w.slice(i, i + 3);
    if (TRIPLES[three]) {
      out.push(...TRIPLES[three]);
      i += 3;
      continue;
    }
    const two = w.slice(i, i + 2);
    // 双写辅音只发一次：rabbit / letter
    if (two.length === 2 && two[0] === two[1] && /[bcdfghjklmnpqrstvwxz]/.test(two[0])) {
      i += 1;
      continue;
    }
    if (PAIRS[two]) {
      out.push(...PAIRS[two]);
      i += 2;
      continue;
    }
    const ch = w[i];
    if (isVowelLetter(ch)) {
      if (ch === 'a') out.push('AE');
      else if (ch === 'e') out.push('EH');
      else if (ch === 'i') out.push('IH');
      else if (ch === 'o') out.push('AA');
      else out.push('AH');
      i += 1;
      continue;
    }
    if (ch === 'c') {
      out.push(/[eiy]/.test(w[i + 1] || '') ? 'S' : 'K');
    } else if (ch === 'g') {
      out.push(/[eiy]/.test(w[i + 1] || '') ? 'JH' : 'G');
    } else if (ch === 's') {
      const betweenVowels = i > 0 && i < w.length - 1 && isVowelLetter(w[i - 1]) && isVowelLetter(w[i + 1]);
      out.push(betweenVowels ? 'Z' : 'S');
    } else if (ch === 'x') {
      out.push('K', 'S');
    } else if (ch === 'q') {
      out.push('K');
    } else if (ch === 'y') {
      out.push(i === 0 ? 'Y' : 'IY');
    } else if (SINGLE_CONS[ch]) {
      out.push(SINGLE_CONS[ch]);
    }
    i += 1;
  }
  return out;
}

// 规则 G2P：先处理常见词尾，再走拼写规则
export function g2p(word, depth = 0) {
  const w = String(word || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!w || depth > 3) return [];
  if (w.length > 3) {
    const m = w.match(/(ies|es|ed|ing|ly|s)$/);
    if (m) {
      const suffix = m[1];
      const root = w.slice(0, -suffix.length);
      if (root.length >= 2) {
        const base = g2p(root, depth + 1);
        const last = base[base.length - 1] || '';
        if (suffix === 'ies') return [...g2p(root.slice(0, -1), depth + 1), 'IY', 'Z'];
        if (suffix === 'es') {
          return [...base, ...(/[sxz]$/.test(root) || /(ch|sh)$/.test(root) ? ['IH', 'Z'] : ['Z'])];
        }
        if (suffix === 'ed') {
          if (last === 'T' || last === 'D') return [...base, 'IH', 'D'];
          return [...base, VOICELESS.has(last) ? 'T' : 'D'];
        }
        if (suffix === 'ing') return [...base, 'IH', 'NG'];
        if (suffix === 'ly') return [...base, 'L', 'IY'];
        return [...base, VOICELESS.has(last) ? 'S' : 'Z'];
      }
    }
  }
  return coreG2P(w);
}

// 词 → ARPAbet 音素：词典优先，缩写拆词，最后 G2P
export function enPhonemes(word, dict) {
  const raw = String(word || '').toLowerCase().replace(/[’]/g, "'");
  if (!raw) return [];
  const table = dict || enDict;
  const hit = table && (table[raw] || table[raw.replace(/^'+|'+$/g, '')]);
  if (hit) return String(hit).split(/\s+/).map((p) => p.replace(/[0-2]$/, '')).filter(Boolean);
  // 缩写：don't / I'm / we'll
  const apos = raw.indexOf("'");
  if (apos > 0) {
    const head = raw.slice(0, apos);
    const tail = raw.slice(apos + 1);
    const tailMap = { s: ['S'], re: ['R'], ve: ['V'], ll: ['L'], m: ['M'], d: ['D'], t: ['T'] };
    const tailPhones = tailMap[tail];
    if (head && tailPhones) return [...enPhonemes(head, table), ...tailPhones];
  }
  return g2p(raw);
}
