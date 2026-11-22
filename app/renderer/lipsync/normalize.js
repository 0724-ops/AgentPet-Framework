// 嘴型同步：朗读稿规范化（纯函数，无 DOM 依赖，浏览器与 Node 单测共用）
// 流程：Markdown 清洗 → 全角转半角 → 数字/日期/单位转写 → 分段
// 只处理朗读稿副本，显示用原文不受影响。

const CJK_RE = /[\u3400-\u9fff]/;

const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_UNIT = ['', '十', '百', '千'];

const EN_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// 停顿时长（毫秒）：只表达「这里该停多久」，口型由时间轴统一换算
export const PAUSE_MS = {
  '，': 180, ',': 180, '、': 180,
  '；': 220, ';': 220, '：': 220, ':': 220,
  '。': 320, '.': 320, '！': 320, '!': 320, '？': 320, '?': 320,
  '…': 250, '—': 200, '-': 90, '\n': 200,
};

export function hasCJK(text) {
  return CJK_RE.test(String(text || ''));
}

// 全角 ASCII → 半角；中文标点保持原样作为停顿信号
export function toHalfWidth(src) {
  return String(src == null ? '' : src)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

// 去掉 Markdown 语法噪音，只留能念出来的内容
export function stripMarkdown(src) {
  let s = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  s = s.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/<?https?:\/\/\S+>?/g, '');
  s = s.replace(/<[^>\n]+>/g, ' ');
  s = s.replace(/^[ \t]*[|: -]{3,}[ \t]*$/gm, '');
  s = s.replace(/^[ \t]*[#>\-*+•]+[ \t]*/gm, '');
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
  s = s.replace(/[*_~]{1,3}/g, '');
  s = s.replace(/\[(\d+)\]/g, '');
  // Emoji 与零宽字符：不发声，直接丢
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, ' ');
  s = s.replace(/[\u200B-\u200F\uFEFF]/g, '');
  return s;
}

function groupToZh(g) {
  const digits = [Math.floor(g / 1000) % 10, Math.floor(g / 100) % 10, Math.floor(g / 10) % 10, g % 10];
  let out = '';
  let pendingZero = false;
  for (let i = 0; i < 4; i += 1) {
    const d = digits[i];
    if (d) {
      if (pendingZero && out) out += '零';
      out += CN_DIGIT[d] + CN_UNIT[3 - i];
      pendingZero = false;
    } else if (out) {
      pendingZero = true;
    }
  }
  return out;
}

// 整数读法：123 → 一百二十三；200 → 两百；1005 → 一千零五
export function intToZh(n) {
  const num = Math.floor(Number(n));
  if (!Number.isFinite(num) || num < 0) return '';
  if (num === 0) return '零';
  const bigUnits = ['', '万', '亿', '万亿'];
  const groups = [];
  let rest = num;
  while (rest > 0) {
    groups.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let out = '';
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (!group) {
      // 高位组全部为零但低位还有内容时补一个零：100000001 → 一亿零一
      if (out && groups.slice(0, i).some((x) => x > 0) && !out.endsWith('零')) out += '零';
      continue;
    }
    // 组内不足四位：一万零一 / 一亿零一万
    if (out && group < 1000 && !out.endsWith('零')) out += '零';
    out += groupToZh(group) + bigUnits[i];
  }
  return out
    .replace(/零+/g, '零')
    .replace(/零+$/, '')
    .replace(/^一十/, '十')
    .replace(/(^|[^十])二(?=[百千万亿])/g, '$1两');
}

// 逐位读：2026 → 二零二六（年份 / 电话 / 编号）
export function digitsToZh(str) {
  return String(str)
    .split('')
    .map((c) => (/[0-9]/.test(c) ? CN_DIGIT[Number(c)] : ''))
    .join('');
}

// 数字串读法：12.5 → 十二点五
export function numToZh(raw) {
  const s = String(raw).replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(s)) return s;
  const [int, frac] = s.split('.');
  if (/^0\d/.test(int)) return digitsToZh(int) + (frac ? '点' + digitsToZh(frac) : '');
  let out = intToZh(Number(int));
  if (frac) out += '点' + digitsToZh(frac);
  return out;
}

function below1000En(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  let r = n % 100;
  if (h) parts.push(EN_ONES[h] + ' hundred');
  if (r) {
    if (r < 20) parts.push(EN_ONES[r]);
    else parts.push(EN_TENS[Math.floor(r / 10)] + (r % 10 ? ' ' + EN_ONES[r % 10] : ''));
  }
  return parts.join(' ');
}

// 英文整数读法：123 → one hundred twenty three
export function intToEn(n) {
  const num = Math.floor(Number(n));
  if (!Number.isFinite(num) || num < 0) return '';
  if (num === 0) return 'zero';
  const scales = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  let rest = num;
  const parts = [];
  for (const [value, name] of scales) {
    if (rest >= value) {
      parts.push(below1000En(Math.floor(rest / value)) + ' ' + name);
      rest %= value;
    }
  }
  if (rest) parts.push(below1000En(rest));
  return parts.join(' ');
}

export function numToEn(raw) {
  const s = String(raw).replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(s)) return s;
  const [int, frac] = s.split('.');
  const intPart = /^0\d/.test(int) ? digitsToEn(int) : intToEn(Number(int));
  return intPart + (frac ? ' point ' + digitsToEn(frac) : '');
}

function digitsToEn(str) {
  return String(str)
    .split('')
    .map((c) => (/[0-9]/.test(c) ? EN_ONES[Number(c)] : ''))
    .filter(Boolean)
    .join(' ');
}

// 英文序数：first / second / twenty-third
export function ordinalEn(n) {
  const num = Math.floor(Number(n));
  if (!Number.isFinite(num) || num <= 0) return String(n);
  const special = { 1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth', 9: 'ninth', 11: 'eleventh', 12: 'twelfth' };
  if (special[num]) return special[num];
  if (num < 20) return EN_ONES[num] + 'th';
  const last = num % 10;
  if (!last) {
    return intToEn(num).replace(/y$/, 'ieth');
  }
  return intToEn(num).replace(/(one|two|three|five|eight|nine)$/, (word) =>
    ({ one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth' }[word] || word + 'th')
  );
}

// 数字读法取决于它落在中文还是英文语境里
function cjkNear(text, start, end, radius = 3) {
  for (let i = start - 1; i >= Math.max(0, start - radius); i -= 1) if (CJK_RE.test(text[i])) return true;
  for (let i = end; i < Math.min(text.length, end + radius); i += 1) if (CJK_RE.test(text[i])) return true;
  return false;
}

const UNITS = {
  km: ['公里', 'kilometers'],
  kg: ['千克', 'kilograms'],
  cm: ['厘米', 'centimeters'],
  mm: ['毫米', 'millimeters'],
  ml: ['毫升', 'milliliters'],
  kpa: ['千帕', 'kilopascals'],
  l: ['升', 'liters'],
  m: ['米', 'meters'],
  g: ['克', 'grams'],
  '℃': ['摄氏度', 'degrees Celsius'],
  '°c': ['摄氏度', 'degrees Celsius'],
};
const UNIT_KEYS = Object.keys(UNITS).sort((a, b) => b.length - a.length);

// 数字与符号转写：日期 / 时间 / 百分比 / 货币 / 单位 / 电话 / 序号
export function expandNumbers(src) {
  let s = String(src == null ? '' : src);
  // 千分位先合并，避免被拆成一串小数字
  s = s.replace(/(\d),(?=\d{3})/g, '$1');

  // 日期：2026-11-22 / 2026/11/22 / 2026年11月22日
  s = s.replace(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})[日号]?/g, (m, y, mo, d) =>
    digitsToZh(y) + '年' + intToZh(Number(mo)) + '月' + intToZh(Number(d)) + '日'
  );

  // 年份：2026年 → 二零二六年（逐位）
  s = s.replace(/(\d{4})年/g, (m, y) => digitsToZh(y) + '年');

  // 时间：14:30 / 14:30:05
  s = s.replace(/(\d{1,2})[:：](\d{2})(?::(\d{2}))?/g, (m, h, mi, sec, offset) => {
    if (!cjkNear(s, offset, offset + m.length)) {
      const en = intToEn(Number(h)) + ' ' + (Number(mi) < 10 ? 'oh ' : '') + intToEn(Number(mi));
      return en + (sec ? ' ' + intToEn(Number(sec)) : '');
    }
    let out = intToZh(Number(h)) + '点';
    out += Number(mi) === 0 ? '整' : intToZh(Number(mi)) + '分';
    if (sec) out += intToZh(Number(sec)) + '秒';
    return out;
  });

  // 百分比
  s = s.replace(/(\d+(?:\.\d+)?)\s*[%％]/g, (m, num, offset) =>
    cjkNear(s, offset, offset + m.length) ? '百分之' + numToZh(num) : numToEn(num) + ' percent'
  );

  // 货币
  s = s.replace(/([$￥¥€])\s*(\d+(?:\.\d+)?)/g, (m, sym, num, offset) => {
    const zh = cjkNear(s, offset, offset + m.length);
    const word = numToZh(num) + (sym === '$' ? (zh ? '美元' : ' dollars') : sym === '€' ? (zh ? '欧元' : ' euros') : '元');
    return zh ? word : numToEn(num) + (sym === '$' ? ' dollars' : sym === '€' ? ' euros' : ' yuan');
  });

  // 单位：3km / 12.5kg / 30℃
  const unitRe = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + UNIT_KEYS.map((k) => k.replace(/[℃]/g, '\\$&')).join('|') + ')(?![a-z])', 'gi');
  s = s.replace(unitRe, (m, num, unit, offset) => {
    const pair = UNITS[String(unit).toLowerCase()] || UNITS[unit] || ['', ''];
    return cjkNear(s, offset, offset + m.length) ? numToZh(num) + pair[0] : numToEn(num) + ' ' + pair[1];
  });

  // 电话 / 长编号：逐位读
  s = s.replace(/\d{7,}/g, (m, offset) =>
    cjkNear(s, offset, offset + m.length) ? digitsToZh(m) : digitsToEn(m)
  );

  // 英文序数：1st / 2nd / 3rd
  s = s.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, (m, n) => ordinalEn(n));

  // 兜底：普通整数与小数
  s = s.replace(/\d+(?:\.\d+)?/g, (m, offset) =>
    cjkNear(s, offset, offset + m.length) ? numToZh(m) : numToEn(m)
  );

  return s;
}

// 规范化朗读稿：清洗 + 半角 + 引号统一 + 数字转写 + 空白收敛
export function normalizeForLipsync(src) {
  let s = stripMarkdown(src);
  s = toHalfWidth(s);
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  s = expandNumbers(s);
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n');
  return s.trim();
}

// 分段：中文段 / 英文段 / 停顿。只给时间轴提供「按什么顺序发声」
export function splitSegments(text) {
  const out = [];
  let buf = '';
  let kind = '';

  const flush = () => {
    if (!buf) return;
    out.push({ kind, text: buf });
    buf = '';
  };

  for (const ch of String(text || '')) {
    if (Object.prototype.hasOwnProperty.call(PAUSE_MS, ch)) {
      flush();
      out.push({ kind: 'pause', pause: PAUSE_MS[ch] });
      kind = '';
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      kind = '';
      if (ch === '\n') out.push({ kind: 'pause', pause: PAUSE_MS['\n'] });
      continue;
    }
    const k = CJK_RE.test(ch) ? 'zh' : /[a-zA-Z'’\-]/.test(ch) ? 'en' : 'other';
    if (k !== kind) {
      flush();
      kind = k;
    }
    if (k !== 'other') buf += ch;
  }
  flush();
  return out;
}
