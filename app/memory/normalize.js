// ============================================================================
//  记忆写入前的归一化（Step 2）
//
//  模型只负责「语义」：subject / relation / object / fact / polarity / truth / source。
//  主键 key 一律由本地计算，防止模型自由生成导致同一事实碎片化：
//      key = sha256(subject + "|" + relation + "|" + normalized_object).slice(0, 16)
//
//  归一化规则（尽量保守，宁可不合并也不误合并）：
//    - NFKC（全角转半角、兼容字符统一）
//    - 英文小写、去掉空白与标点
//    - 同义词表只收录「显然同义」的写法（coffee -> 咖啡 等）
// ============================================================================

const crypto = require('node:crypto');

// subject 枚举：用户 / 角色 / 世界；模型可能返回中文，统一成这三个
const SUBJECT_ALIASES = {
  user: 'user',
  我: 'user',
  用户: 'user',
  博士: 'user',
  主人: 'user',
  对方: 'user',
  玩家: 'user',
  char: 'char',
  角色: 'char',
  她: 'char',
  你: 'char',
  world: 'world',
  世界: 'world',
  环境: 'world',
};

// 当前角色的真实名字由主进程在启动时从角色定义带进来，代码里不写死任何角色名
let CHAR_NAME_ALIASES = new Map();

function registerCharacterName(name) {
  const raw = normalizeText(name);
  if (raw) CHAR_NAME_ALIASES.set(raw, 'char');
}

const RELATION_ALIASES = {
  preference: 'preference',
  偏好: 'preference',
  喜好: 'preference',
  喜欢: 'preference',
  口味: 'preference',
  like: 'preference',
  dislike: 'preference',
  constraint: 'constraint',
  约束: 'constraint',
  禁忌: 'constraint',
  禁止: 'constraint',
  底线: 'constraint',
  规则: 'constraint',
  must: 'constraint',
  avoid: 'constraint',
  event: 'event',
  事件: 'event',
  经历: 'event',
  发生: 'event',
  experience: 'event',
  promise: 'promise',
  约定: 'promise',
  承诺: 'promise',
  计划: 'plan',
  plan: 'plan',
  安排: 'plan',
  emotion: 'emotion',
  情绪: 'emotion',
  心情: 'emotion',
  relation: 'relation',
  关系: 'relation',
  人际: 'relation',
  fact: 'fact',
  事实: 'fact',
  属性: 'fact',
  信息: 'fact',
  画像: 'fact',
  profile: 'fact',
};

const KNOWN_RELATIONS = new Set([
  'preference',
  'constraint',
  'event',
  'promise',
  'plan',
  'emotion',
  'relation',
  'fact',
]);

// 只收录显然同义的写法；拿不准的交给第二层向量兜底
const OBJECT_SYNONYMS = {
  coffee: '咖啡',
  cafe: '咖啡',
  espresso: '浓缩咖啡',
  americano: '美式',
  冰美式咖啡: '冰美式',
  美式咖啡: '美式',
  拿铁咖啡: '拿铁',
  latte: '拿铁',
  mocha: '摩卡',
  cappuccino: '卡布奇诺',
  sqlite3: 'sqlite',
  sqlite数据库: 'sqlite',
  python3: 'python',
  js: 'javascript',
  爪哇: 'java',
  アイスコーヒー: '冰咖啡',
  冰咖啡: '冰美式',
};

const PUNCT_AND_SYMBOL = /[\p{P}\p{S}]+/gu;
const SPACES = /[\s\u3000]+/g;

// NFKC + 小写 + 去空白/标点；中文里的标点同样删掉
function normalizeText(input) {
  return String(input == null ? '' : input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(SPACES, '')
    .replace(PUNCT_AND_SYMBOL, '');
}

function normalizeSubject(input) {
  const raw = normalizeText(input);
  if (!raw) return 'user';
  return CHAR_NAME_ALIASES.get(raw) || SUBJECT_ALIASES[raw] || raw.slice(0, 20);
}

function normalizeRelation(input) {
  const raw = normalizeText(input);
  if (!raw) return 'fact';
  const rel = RELATION_ALIASES[raw] || raw;
  return KNOWN_RELATIONS.has(rel) ? rel : 'fact';
}

function normalizeObject(input) {
  const raw = normalizeText(input);
  if (!raw) return '';
  const standard = OBJECT_SYNONYMS[raw];
  return normalizeText(standard || raw);
}

function normalizePolarity(input) {
  const raw = normalizeText(input);
  if (!raw) return 'positive';
  if (['negative', 'neg', 'false', '0', '否定', '负', '不喜欢', '不'].includes(raw)) return 'negative';
  return 'positive';
}

function normalizeTruth(input) {
  const num = Number(input);
  if (!Number.isFinite(num)) return 0.7;
  return Math.max(0, Math.min(1, num));
}

// fact 是给人看的一句完整陈述：保留原标点，只压空白 / 去掉换行
function cleanFact(input) {
  return String(input == null ? '' : input)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 这些「事实」其实是系统/自己的元信息：提示词、记忆机制、动作库、工具、测试过程……
// 写进库只会自我循环（下一轮检索又把它们注入回提示词），所以在入库前直接丢掉。
const META_FACT_PATTERNS = [
  /系统提示|系统指令|提示词|系统消息|prompt/i,
  /记忆.{0,6}(块|库|机制|注入|系统)|注入.{0,4}记忆|长期记忆/,
  /记忆.{0,8}冲突|冲突.{0,6}记忆|以当前对话为准/,
  /MEM_MARK|编号只给系统/,
  /动作.{0,2}(库|列表)|工具.{0,2}(调用|列表|定义)/,
  /\bapi\b|\btoken\b|\bjson\b|上下文窗口/i,
  // 只拦「在测试记忆机制本身」这类自我指涉；「一起测试了某个功能」属于共同经历，要放行
  /测试.{0,4}(记忆|注入|检索)|记忆.{0,4}测试/,
  /笔记.{0,2}(改为|改成|已改)/,
  /无法(修改|更改).{0,4}(系统|注入)/,
];

function isMetaFact(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  return META_FACT_PATTERNS.some((re) => re.test(s));
}

function factKey(subject, relation, objectNorm) {
  const basis = `${subject}|${relation}|${objectNorm}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

// 把模型返回的一条 fact 变成可入库的记录；缺 fact 或属于系统元信息时视为无效
function normalizeFact(raw = {}, { defaultSource = '' } = {}) {
  const fact = cleanFact(raw.fact || raw.object || raw.content);
  if (!fact || isMetaFact(fact)) return null;
  const subject = normalizeSubject(raw.subject);
  const relation = normalizeRelation(raw.relation || raw.type);
  const objectRaw = raw.object != null && String(raw.object).trim() ? raw.object : fact;
  const object_norm = normalizeObject(objectRaw);
  const object = cleanFact(objectRaw).slice(0, 40);
  const polarity = normalizePolarity(raw.polarity);
  const truth = normalizeTruth(raw.truth);
  const source_text = cleanFact(raw.source || raw.source_text || defaultSource).slice(0, 400);
  return {
    key: factKey(subject, relation, object_norm),
    subject,
    relation,
    object,
    object_norm,
    fact,
    polarity,
    truth,
    source_text,
  };
}

module.exports = {
  normalizeText,
  normalizeSubject,
  normalizeRelation,
  normalizeObject,
  normalizePolarity,
  normalizeTruth,
  cleanFact,
  isMetaFact,
  factKey,
  normalizeFact,
  registerCharacterName,
  KNOWN_RELATIONS,
  SUBJECT_ALIASES,
  RELATION_ALIASES,
  OBJECT_SYNONYMS,
  META_FACT_PATTERNS,
};
