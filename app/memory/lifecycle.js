// ============================================================================
//  记忆生命周期（Step 4）—— 纯函数，Worker 与自测共用
//
//  每轮对话结束结算一次（settle）：
//    - 注入且未被 MEM_MARK 标记：activation += boost（默认采纳）
//    - 被 MEM_MARK 标记 wrong：activation -= penalty
//    - 检索到但没注入：衰减减半
//    - 没进候选：正常衰减
//
//  衰减按幂律：activation = base * (1 + turns_since_hit)^(-d)
//  逐轮实现为连乘 ratio(t) = ((1+t)/(2+t))^(d)，从 t=0 连乘到 t=k 正好等于
//  (1+k+1)^(-d)，不额外存 base。
//
//  分档 d：约束 0 / 偏好 0.3 / 事实 0.5 / 事件 0.8（其余按相近档位取值）。
//  分层：hot 正常检索；warm 仅作候选；cold 移出主索引（检索时 excludeCold）。
//  物理删除：cold + 低 truth + 低激活 + 非 pinned + 非约束，连续满足 deleteTurns 轮才真删。
// ============================================================================

const DECAY_D = {
  constraint: 0,
  preference: 0.3,
  promise: 0.3,
  plan: 0.4,
  relation: 0.4,
  fact: 0.5,
  emotion: 0.6,
  event: 0.8,
};

const DEFAULTS = {
  boost: 0.35,
  penalty: 0.5,
  thetaWarm: 0.45,
  thetaCold: 0.15,
  deleteTurns: 50,
  lowTruth: 0.4,
  minActivation: 0,
  maxActivation: 3,
  // Step 5：设置页的「衰减强度」滑块，乘到分档 d 上（约束 d=0 不受影响）
  decayScale: 1,
};

// scale 是用户可调的倍率；约束的 d 恒为 0，乘任何倍率都不衰减
function decayD(relation, scale = 1) {
  const base = DECAY_D[String(relation || 'fact')];
  const d = Number.isFinite(base) ? base : DECAY_D.fact;
  if (d <= 0) return 0;
  const s = Number(scale);
  return d * (Number.isFinite(s) && s > 0 ? s : 1);
}

// 逐轮衰减倍率；half=true 时指数减半（检索到但未注入）
function decayRatio(relation, turnsSinceHit, half = false, scale = 1) {
  const d = decayD(relation, scale);
  if (d <= 0) return 1;
  const t = Math.max(0, Number(turnsSinceHit) || 0);
  const ratio = (1 + t) / (2 + t);
  return Math.pow(ratio, half ? d * 0.5 : d);
}

function clampActivation(value, min = DEFAULTS.minActivation, max = DEFAULTS.maxActivation) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function layerFor(activation, { relation, pinned, thetaWarm, thetaCold } = {}) {
  if (pinned || relation === 'constraint') return 'hot';
  const act = Number(activation) || 0;
  const warm = Number.isFinite(Number(thetaWarm)) ? Number(thetaWarm) : DEFAULTS.thetaWarm;
  const cold = Number.isFinite(Number(thetaCold)) ? Number(thetaCold) : DEFAULTS.thetaCold;
  if (act <= cold) return 'cold';
  if (act <= warm) return 'warm';
  return 'hot';
}

// row 是 SQLite 里的一条 memories 记录；ctx 见 DEFAULTS + turn/sets
function settleMemory(row, ctx = {}) {
  const policy = { ...DEFAULTS, ...(ctx.policy || {}) };
  const turn = Number(ctx.turn) || 0;
  const injected = ctx.injected || new Set();
  const wrong = ctx.wrong || new Set();
  const candidates = ctx.candidates || new Set();
  const pinned = !!row.pinned;
  const relation = String(row.relation || 'fact');
  const isInjected = injected.has(row.key);
  const isWrong = wrong.has(row.key);

  let activation = Number(row.activation) || 0;
  let hitCount = Number(row.hit_count) || 0;
  let missCount = Number(row.miss_count) || 0;
  let lastHitTurn = Number(row.last_hit_turn) || 0;
  let deleteStreak = Number(row.delete_streak) || 0;

  if (isWrong) {
    activation -= policy.penalty;
    missCount += 1;
  } else if (isInjected) {
    activation += policy.boost;
    hitCount += 1;
    lastHitTurn = turn;
  } else if (!pinned) {
    const half = candidates.has(row.key);
    activation *= decayRatio(relation, turn - lastHitTurn, half, policy.decayScale);
  }

  activation = clampActivation(
    Math.round(activation * 10000) / 10000,
    policy.minActivation,
    policy.maxActivation
  );

  const layer = layerFor(activation, {
    relation,
    pinned,
    thetaWarm: policy.thetaWarm,
    thetaCold: policy.thetaCold,
  });

  const lowTruth = (Number(row.truth) || 0) <= policy.lowTruth;
  const qualifies =
    !pinned && relation !== 'constraint' && layer === 'cold' && lowTruth && activation <= policy.thetaCold;
  deleteStreak = qualifies ? deleteStreak + 1 : 0;
  const deleted = qualifies && deleteStreak >= policy.deleteTurns;

  return {
    activation,
    layer,
    last_hit_turn: lastHitTurn,
    hit_count: hitCount,
    miss_count: missCount,
    delete_streak: deleteStreak,
    deleted,
  };
}

module.exports = {
  DECAY_D,
  DEFAULTS,
  decayD,
  decayRatio,
  clampActivation,
  layerFor,
  settleMemory,
};
