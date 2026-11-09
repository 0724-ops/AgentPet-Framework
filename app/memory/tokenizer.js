// ============================================================================
//  bge-small-zh-v1.5 的 BERT WordPiece 分词器
//
//  只依赖 tokenizer.json，不引入 transformers / tokenizers 原生库：
//    - BertNormalizer: 去控制符、统一空白、中文两侧加空格
//    - BertPreTokenizer: 按空白和标点切
//    - WordPiece: 贪心最长匹配，## 前缀表示子词
//  bge-small-zh 的 tokenizer 配置是 lowercase=false / strip_accents=null，
//  这里按配置读取，不写死。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

function isControl(cp) {
  if (cp === 0 || cp === 0xfffd) return true;
  if (cp === 9 || cp === 10 || cp === 13) return false;
  if (cp < 32) return true;
  return cp >= 0x7f && cp <= 0x9f;
}

function isWhitespace(cp) {
  return cp === 32 || cp === 9 || cp === 10 || cp === 13 || /\s/.test(String.fromCodePoint(cp));
}

const CJK_RANGES = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];

function isCjk(cp) {
  return CJK_RANGES.some(([a, b]) => cp >= a && cp <= b);
}

function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true;
  }
  return /^\p{P}$/u.test(ch);
}

function normalize(text, opts) {
  let out = '';
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    if (isControl(cp)) continue;
    if (isWhitespace(cp)) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  if (opts.handleChineseChars) {
    let spaced = '';
    for (const ch of out) {
      if (isCjk(ch.codePointAt(0))) spaced += ` ${ch} `;
      else spaced += ch;
    }
    out = spaced;
  }
  if (opts.lowercase) out = out.toLowerCase();
  if (opts.stripAccents) out = out.normalize('NFD').replace(/\p{Mn}/gu, '');
  if (opts.cleanup) out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function preTokenize(text) {
  const words = [];
  for (const piece of text.split(/\s+/)) {
    if (!piece) continue;
    let buf = '';
    for (const ch of piece) {
      if (isPunctuation(ch)) {
        if (buf) {
          words.push(buf);
          buf = '';
        }
        words.push(ch);
      } else {
        buf += ch;
      }
    }
    if (buf) words.push(buf);
  }
  return words;
}

function wordPiece(word, vocab, prefix, unkId, maxChars) {
  if (word.length > maxChars) return [unkId];
  const out = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let id = -1;
    while (start < end) {
      const piece = (start > 0 ? prefix : '') + word.slice(start, end);
      const found = vocab.get(piece);
      if (found != null) {
        id = found;
        break;
      }
      end -= 1;
    }
    if (id < 0) return [unkId];
    out.push(id);
    start = end;
  }
  return out;
}

function createTokenizer(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const model = raw.model || {};
  const vocab = new Map(Object.entries(model.vocab || {}).map(([k, v]) => [k, Number(v)]));
  const prefix = model.continuing_subword_prefix || '##';
  const maxChars = Number(model.max_input_chars_per_word) || 100;

  const added = new Map();
  (raw.added_tokens || []).forEach((t) => added.set(String(t.content), Number(t.id)));
  const unkId = added.get(model.unk_token || '[UNK]') ?? vocab.get(model.unk_token || '[UNK]') ?? 100;
  const clsId = added.get('[CLS]') ?? vocab.get('[CLS]') ?? 101;
  const sepId = added.get('[SEP]') ?? vocab.get('[SEP]') ?? 102;
  const padId = added.get('[PAD]') ?? vocab.get('[PAD]') ?? 0;

  const norm = raw.normalizer || {};
  const opts = {
    lowercase: !!norm.lowercase,
    stripAccents: norm.strip_accents == null ? !!norm.lowercase : !!norm.strip_accents,
    handleChineseChars: norm.handle_chinese_chars !== false,
    cleanup: norm.clean_text !== false,
  };

  function tokenize(text) {
    const tokens = [];
    for (const word of preTokenize(normalize(text, opts))) {
      const ids = wordPiece(word, vocab, prefix, unkId, maxChars);
      ids.forEach((id) => tokens.push(id));
    }
    return tokens;
  }

  return {
    tokenize,
    encode(text, maxLength = 512) {
      const body = tokenize(text).slice(0, Math.max(1, maxLength - 2));
      return [clsId, ...body, sepId];
    },
    ids: { pad: padId, unk: unkId, cls: clsId, sep: sepId },
    vocabSize: vocab.size,
    config: opts,
  };
}

function resolveModelDir(base) {
  return path.resolve(base || path.join(__dirname, '..', '..', 'models', 'bge-small-zh-v1.5'));
}

module.exports = { createTokenizer, resolveModelDir };
