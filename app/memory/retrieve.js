// ============================================================================
//  记忆读取管线（Step 3）——纯函数，Worker 和测试共用
//
//  1. 双路召回结果按主键去重（向量 Top-K + 关键词/BM25 Top-K）
//  2. similarity < θ_sim 硬过滤
//  3. VIP 通道：用户的 constraint 或 pinned，过阈值就强制注入，不参与排序竞争
//  4. 普通记忆打分：score = similarity^1.5 × truth × f(log(activation)) × type_weight
//  5. 按 max_k 与总字数截断；编号 M1..Mn 供 Step 4 的 MEM_MARK 结算
// ============================================================================

const { isMetaFact, normalizeText } = require('./normalize');

const DEFAULTS = {
  thetaSim: 0.45,
  maxInject: 6,
  maxChars: 360,
  maxVip: 4,
  maxKeywordTerms: 12,
  activationFloor: 0.2,
  typeWeights: {
    constraint: 1.6,
    preference: 1.15,
    promise: 1.25,
    plan: 1.1,
    relation: 1.0,
    fact: 0.9,
    emotion: 0.9,
    event: 0.8,
  },
};

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function typeWeight(relation, weights = DEFAULTS.typeWeights) {
  return Number(weights[relation]) || DEFAULTS.typeWeights.fact;
}

// f(log(activation))：激活度 1 → 0.693，0.2 → 0.18，再抬到地板值
function activationFactor(activation) {
  return Math.max(DEFAULTS.activationFloor, Math.log1p(Math.max(0, Number(activation) || 0)));
}

function scoreMemory(candidate, { typeWeights } = {}) {
  const similarity = clamp01(candidate.similarity != null ? candidate.similarity : candidate.score);
  const truth = clamp01(candidate.truth == null ? 1 : candidate.truth);
  return (
    Math.pow(similarity, 1.5) *
    truth *
    activationFactor(candidate.activation) *
    typeWeight(candidate.relation, typeWeights)
  );
}

// VIP 通道只认「用户自己的约束」或手动置顶：
// char / world 的 constraint 往往是从系统提示里抄回来的元信息，不能绕过排序强注入
function isVip(candidate) {
  const subject = String(candidate.subject || 'user');
  return !!candidate.pinned || (candidate.relation === 'constraint' && subject === 'user');
}

// 从自然语言里切 3 字窗口（FTS trigram）+ 2 字窗口（LIKE 兜底）
function keywordTerms(text, maxTerms = DEFAULTS.maxKeywordTerms) {
  const runs = String(text || '').match(/[\p{Script=Han}a-zA-Z0-9]+/gu) || [];
  const out = [];
  const seen = new Set();
  const push = (term) => {
    if (!term || seen.has(term)) return false;
    seen.add(term);
    out.push(term);
    return out.length >= maxTerms;
  };

  // 先 3 字窗口（精度高，能走 FTS trigram），再 2 字窗口（LIKE）
  for (const run of runs) {
    const chars = [...run];
    if (chars.length < 2) continue;
    for (let i = 0; i <= chars.length - 3; i += 1) {
      if (push(chars.slice(i, i + 3).join(''))) return out;
    }
  }
  for (const run of runs) {
    const chars = [...run];
    if (chars.length < 2) continue;
    for (let i = 0; i <= chars.length - 2; i += 1) {
      if (push(chars.slice(i, i + 2).join(''))) return out;
    }
  }
  return out;
}

function dedupeByKey(candidates) {
  const map = new Map();
  for (const c of candidates || []) {
    if (!c || !c.key || !String(c.fact || '').trim()) continue;
    const sim = Number(c.similarity != null ? c.similarity : c.score);
    if (!Number.isFinite(sim) || sim < 0) continue;
    const prev = map.get(c.key);
    if (!prev || sim > Number(prev.similarity != null ? prev.similarity : prev.score)) {
      map.set(c.key, {
        ...c,
        similarity: sim,
      });
    }
  }
  return [...map.values()];
}

// 第二层去重：主键不同但 fact 文本完全一样（例如同义表达各自建行），
// 只保留一条，优先 pinned / 激活度高 / 相似度高的那条
function dedupeByFact(candidates) {
  const map = new Map();
  for (const c of candidates || []) {
    const factText = normalizeText(c.fact);
    if (!factText) continue;
    const groupKey = `${factText}|${String(c.polarity || 'positive')}`;
    const prev = map.get(groupKey);
    if (!prev) {
      map.set(groupKey, c);
      continue;
    }
    const better =
      Number(!!c.pinned) - Number(!!prev.pinned) ||
      (Number(c.activation) || 0) - (Number(prev.activation) || 0) ||
      (Number(c.similarity != null ? c.similarity : c.score) || 0) -
        (Number(prev.similarity != null ? prev.similarity : prev.score) || 0);
    if (better > 0) map.set(groupKey, c);
  }
  return [...map.values()];
}

// 选出最终要注入的记忆；items 里的 id 就是 M1 / M2 ...
function selectMemories(candidates, options = {}) {
  const opts = { ...DEFAULTS, ...options, typeWeights: { ...DEFAULTS.typeWeights, ...(options.typeWeights || {}) } };
  const theta = Number(opts.thetaSim);
  // 系统元信息（提示词 / 记忆机制 / 动作库……）即使已在旧库里，也永不注入
  const keyDeduped = dedupeByKey(candidates);
  const deduped = dedupeByFact(keyDeduped);
  const duplicateDropped = keyDeduped.length - deduped.length;
  const all = deduped.filter((c) => !isMetaFact(c.fact));
  const metaDropped = deduped.length - all.length;
  const passed = [];
  let belowTheta = 0;
  for (const c of all) {
    if (c.similarity < theta) {
      belowTheta += 1;
      continue;
    }
    passed.push({ ...c, score: scoreMemory(c, opts), vip: isVip(c) });
  }

  const vip = passed.filter((c) => c.vip).sort((a, b) => b.similarity - a.similarity);
  const normal = passed
    .filter((c) => !c.vip)
    .sort((a, b) => b.score - a.score || b.similarity - a.similarity);

  const pickedVip = vip.slice(0, Math.max(0, opts.maxVip));
  const pickedNormal = [];
  let chars = pickedVip.reduce((sum, c) => sum + String(c.fact).length, 0);
  for (const c of normal) {
    if (pickedNormal.length >= Math.max(0, opts.maxInject)) break;
    const len = String(c.fact).length;
    if (chars + len > opts.maxChars) continue;
    pickedNormal.push(c);
    chars += len;
  }

  const items = [...pickedVip, ...pickedNormal].map((c, i) => ({
    id: `M${i + 1}`,
    key: c.key,
    fact: c.fact,
    relation: c.relation,
    polarity: c.polarity,
    truth: c.truth,
    activation: c.activation,
    pinned: !!c.pinned,
    vip: !!c.vip,
    similarity: c.similarity,
    score: c.score,
  }));

  return {
    items,
    chars,
    // 过了阈值、进入排序的候选（含 VIP 超额 / 字数截断掉的），供 Step 4 区分「检索到但未注入」
    candidateKeys: passed.map((c) => c.key),
    dropped: {
      belowTheta,
      overLimit: normal.length - pickedNormal.length,
      vipOverLimit: vip.length - pickedVip.length,
      meta: metaDropped,
      duplicate: duplicateDropped,
    },
    params: {
      thetaSim: theta,
      maxInject: opts.maxInject,
      maxChars: opts.maxChars,
      maxVip: opts.maxVip,
    },
  };
}

function formatMemoryBlock(items, template) {
  if (!items || !items.length) return '';
  const lines = items.map((m) => `- [${m.id}] ${String(m.fact).trim()}`).join('\n');
  // 模板由用户维护；没有模板就只给数据，不补任何说明文字
  const tpl = typeof template === 'string' ? template : '';
  if (!tpl.trim()) return lines;
  return tpl.replace(/\{\{MEMORIES\}\}/g, lines);
}

module.exports = {
  DEFAULTS,
  clamp01,
  typeWeight,
  activationFactor,
  scoreMemory,
  isVip,
  keywordTerms,
  dedupeByKey,
  dedupeByFact,
  selectMemories,
  formatMemoryBlock,
};
