// ============================================================================
//  情感数值引擎（纯函数，无 IO、无依赖）
//
//  分层（从慢到快）：底色 personality → 身体 body → 激素 hormones
//                    → 情绪 feel → 关系 relation → 行为 outbound
//
//  所有函数只接收 state + now，不读盘、不发请求，方便单测。
//  统一约定：
//    - 状态数值全部夹在 0~100，性格维度 0~1
//    - state.updated 是上一次推进的时间点（ISO 字符串）
//    - 时区取本机时间，不写死 +8
//
//  同时兼容两种加载方式：
//    主进程 / 单测：require('./engine')
//    渲染进程：<script src="../emotion/engine.js"> → window.AgentPetEmotionEngine
// ============================================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentPetEmotionEngine = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

// ---------------------------------------------------------------- 常量表

// 身体静息值
const BODY_REST = { stamina: 68, sleepiness: 32, hunger: 25, health: 88 };

// 激素静息值与半衰期（分钟）
const HORMONE_REST = {
  adrenaline: 15, cortisol: 20, dopamine: 45, oxytocin: 50,
  serotonin: 52, endorphin: 40, melatonin: 25,
};
const HALF_LIFE = {
  adrenaline: 8, cortisol: 110, dopamine: 35, oxytocin: 180,
  serotonin: 300, endorphin: 60, melatonin: 240,
};

// 关系静息值（12 天半衰）
const RELATION_REST = { affection: 60, trust: 60, dependence: 50, security: 55, rapport: 50 };

// 技能六维默认值（第一阶段只有数据，没有触发源）
const TALENTS = ['理性', '直觉', '共情', '表达', '动手', '胆量'];
const TALENT_DEFAULT = { 理性: 60, 直觉: 60, 共情: 60, 表达: 60, 动手: 55, 胆量: 50 };

// 性格六维默认值（六边形，无星座加成）
const PERSONALITY_KEYS = ['warmth', 'sensitivity', 'resilience', 'optimism', 'openness', 'stubbornness'];
const PERSONALITY_DEFAULT = {
  warmth: 0.55, sensitivity: 0.55, resilience: 0.55,
  optimism: 0.55, openness: 0.55, stubbornness: 0.55,
};

// 16 类事件对应的激素增减
const EVENTS = {
  praise: { dopamine: 26, oxytocin: 14, cortisol: -6, serotonin: 4 },
  miss: { oxytocin: 22, dopamine: 10 },
  tease: { adrenaline: 18, dopamine: 8, serotonin: 2 },
  ignore: { cortisol: 22, oxytocin: -10, serotonin: -6 },
  cold: { cortisol: 30, oxytocin: -14, adrenaline: 10, serotonin: -8 },
  worry: { cortisol: 20, adrenaline: 12, oxytocin: 6 },
  comfort: { oxytocin: 24, cortisol: -18, adrenaline: -10, endorphin: 10, serotonin: 8 },
  goodnight: { oxytocin: 18, cortisol: -12, adrenaline: -14, melatonin: 16 },
  scare: { adrenaline: 40, cortisol: 16, melatonin: -10 },
  proud: { dopamine: 30, oxytocin: 8, serotonin: 6 },
  hug: { oxytocin: 20, endorphin: 14, cortisol: -12 },
  late_night: { melatonin: 22, cortisol: 10, endorphin: -8 },
  eat: { endorphin: 12, serotonin: 5 },
  rest: { melatonin: 14, cortisol: -14 },
  horror: { adrenaline: 26, cortisol: 12 },
  thunder: { adrenaline: 22, cortisol: 10 },
  night_walk: { adrenaline: 16, cortisol: 9 },
};

// 亲密类事件涨关系，冷淡类掉安全感
const INTIMATE_KINDS = new Set(['praise', 'hug', 'comfort', 'goodnight', 'miss', 'proud']);
const COLD_KINDS = new Set(['cold', 'ignore']);

// 吓人的场景：只在这里发作恐惧值
const FEAR_KINDS = { horror: '看鬼片', thunder: '打雷', night_walk: '一个人走夜路' };
const FEAR_HALF_MIN = 90;   // 恐惧每 90 分钟减半
const FEAR_SHOW = 20;       // 低于此值当作没被吓到

// 褪黑素按钟点走
const MEL_CURVE = {
  0: 88, 1: 92, 2: 94, 3: 90, 4: 80, 5: 58, 6: 28, 7: 12,
  8: 10, 9: 10, 10: 10, 11: 10, 12: 10, 13: 12, 14: 12,
  15: 12, 16: 12, 17: 14, 18: 18, 19: 24, 20: 32, 21: 46,
  22: 66, 23: 78,
};

// 主动消息默认配置（面板可改，见设计 §9.2）
const PROACTIVE_DEFAULTS = {
  checkSeconds: 60,     // 多长时间抽一次签
  weight: 1.0,          // 概率权重
  cooldownMin: 90,      // 主动开口后的冷却
  cap: 'auto',          // auto / 1~20
  nightStart: '23:00',
  nightEnd: '07:00',
  quietMin: 5,          // 距用户最后发言多少分钟内不主动
  floor: true,          // 超时保底
  gapMin: 150,          // 基线期望间隔（分钟）
};

// ---------------------------------------------------------------- 工具

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function round(v, digits) {
  const p = 10 ** (digits || 0);
  return Math.round(Number(v) * p) / p;
}

// 「现在」统一由调用方传入，方便单测；缺省取本机时间
function nowDate(now) {
  return now instanceof Date ? now : new Date(now == null ? Date.now() : now);
}

function hoursOf(now) {
  return nowDate(now).getHours();
}

// 昼夜节律：每个小时的身体偏移
function circadian(hour) {
  if (hour >= 0 && hour < 6) return { stamina: -22, sleepiness: 45, hunger: -5 };
  if (hour < 9) return { stamina: -8, sleepiness: 12, hunger: 8 };
  if (hour < 12) return { stamina: 6, sleepiness: -6, hunger: 4 };
  if (hour < 14) return { stamina: -4, sleepiness: 10, hunger: 22 };
  if (hour < 18) return { stamina: 4, sleepiness: 2, hunger: 0 };
  if (hour < 22) return { stamina: -2, sleepiness: 6, hunger: 14 };
  return { stamina: -12, sleepiness: 22, hunger: -2 };
}

// 褪黑素钟点目标值
function melatoninTarget(hour) {
  return MEL_CURVE[hour % 24] == null ? 12 : MEL_CURVE[hour % 24];
}

// 时段中文
function phase(hour) {
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚上';
  return '半夜';
}

// ---------------------------------------------------------------- 默认状态

function defaultState(now) {
  const d = nowDate(now);
  return {
    version: 1,
    updated: d.toISOString(),
    startedAt: d.toISOString(),
    profile: { name: '', together_since: null },
    personality: { ...PERSONALITY_DEFAULT },
    body: { ...BODY_REST },
    hormones: { ...HORMONE_REST },
    relation: { ...RELATION_REST },
    talents: { ...TALENT_DEFAULT },
    fear: null,
    last_inner: null,
    last_valence: 50,
    last_signed: null,
    today: { date: dateKey(d), sent: 0 },
    lastProactiveAt: null,
    lastCheckAt: null,
    events: [],
  };
}

function dateKey(d) {
  const t = nowDate(d);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------- 衰减

function minutesSince(updatedIso, now) {
  const t = Date.parse(updatedIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowDate(now).getTime() - t) / 60000);
}

function decayBody(s, mins, now) {
  if (mins <= 0) return;
  const circ = circadian(hoursOf(now));
  const k = 0.5 ** (mins / 180);
  for (const key of Object.keys(BODY_REST)) {
    const rest = BODY_REST[key] + (circ[key] || 0);
    const cur = Number(s.body[key]);
    s.body[key] = clamp(rest + (cur - rest) * k, 0, 100);
  }
}

function decayHormones(s, mins, now) {
  if (mins <= 0) return;
  const speed = 0.7 + Number(s.personality.resilience || 0) * 0.6;
  for (const key of Object.keys(HALF_LIFE)) {
    const rest = HORMONE_REST[key];
    const cur = Number(s.hormones[key]);
    s.hormones[key] = clamp(rest + (cur - rest) * (0.5 ** (mins * speed / HALF_LIFE[key])), 0, 100);
  }
  // 日常回归：4 小时被日常磨回一半
  const kHome = 1 - 0.5 ** (mins / 240);
  for (const key of Object.keys(HALF_LIFE)) {
    const rest = HORMONE_REST[key];
    s.hormones[key] += (rest - s.hormones[key]) * kHome;
  }
  // 褪黑素不按半衰期，按钟点靠拢
  const target = melatoninTarget(hoursOf(now));
  const curMel = s.hormones.melatonin;
  s.hormones.melatonin = clamp(target + (curMel - target) * (0.5 ** (mins / 45)), 0, 100);
  // 困倦跟着褪黑素走一点
  if (target > 60) {
    s.body.sleepiness = clamp(s.body.sleepiness + mins * 0.12, 0, 100);
  }
}

function decayRelation(s, mins) {
  if (mins <= 0) return;
  const k = 0.5 ** (mins / (60 * 24 * 12));
  for (const key of Object.keys(RELATION_REST)) {
    const rest = RELATION_REST[key];
    const cur = Number(s.relation[key]);
    s.relation[key] = clamp(rest + (cur - rest) * k, 0, 100);
  }
}

function decayFear(s, mins) {
  if (!s.fear || mins <= 0) return;
  s.fear.v = round(Number(s.fear.v || 0) * (0.5 ** (mins / FEAR_HALF_MIN)), 1);
  if (s.fear.v < FEAR_SHOW) s.fear = null;
}

// 主推进：按经过分钟数依次衰减，最后刷新 updated
function tick(s, now) {
  const t = nowDate(now);
  const mins = minutesSince(s.updated, t);
  decayBody(s, mins, t);
  decayFear(s, mins);
  decayHormones(s, mins, t);
  decayRelation(s, mins);
  s.updated = t.toISOString();
  return s;
}

// ---------------------------------------------------------------- 情绪

// 情绪标签（内心）
function nameOf(v, a, cor, oxy, body) {
  if (body.sleepiness > 80 && v > -20) return '困到走神';
  if (cor > 55 && v < -10) return a < 65 ? '委屈' : '生气';
  if (v < -30) return a < 55 ? '失落' : '难受';
  if (oxy > 70 && v > 25) return '想你';
  if (v > 45 && a > 60) return '开心';
  if (v > 20 && a > 45) return '有点高兴';
  if (a > 70) return '紧张';
  if (a < 35 && v > 0) return '安静';
  return '平常';
}

// 内外分离：嘴硬的人，心里和脸上不是一回事
function mask(inner, v, a, personality, relation) {
  const st = Number(personality.stubbornness || 0);
  if (st < 0.45) return inner;
  // 安全感高时嘴硬会松一点
  const soft = 1 - (Number(relation.security || 0) - 50) / 200;
  if (inner === '委屈' || inner === '失落' || inner === '难受' || inner === '生气') {
    return st * soft > 0.45 ? '别扭' : inner;
  }
  if (inner === '想你' || inner === '开心' || inner === '有点高兴') {
    if (v > 40) return inner;
    return v > 20 ? '嘚瑟' : '平常';
  }
  return inner;
}

// 身体 + 激素 → 情绪三维 → 内心/外显标签
function feel(s) {
  const p = s.personality;
  const h = s.hormones;
  const b = s.body;
  const adr = Number(h.adrenaline), cor = Number(h.cortisol), dop = Number(h.dopamine);
  const oxy = Number(h.oxytocin), ser = Number(h.serotonin), end = Number(h.endorphin);
  const mel = Number(h.melatonin);

  // 以静息值为中性：基线激素 → 0，映射到 50 分
  const raw = (dop - HORMONE_REST.dopamine) * 0.85
    + (oxy - HORMONE_REST.oxytocin) * 0.45
    + (ser - HORMONE_REST.serotonin) * 0.8
    + (end - HORMONE_REST.endorphin) * 0.5
    - (cor - HORMONE_REST.cortisol) * 0.55
    - Math.max(0, b.sleepiness - 55) * 0.25;

  const fear = Number((s.fear || {}).v || 0);
  // signed：以 0 为中性，给标签判断用（参考实现的 v<-30 / v>45 都以 0 为轴）
  const signed = raw * 1.05
    + (Number(p.optimism) - 0.5) * 30
    + (b.health - 88) * 0.2
    - fear * 0.30;
  // 面板/额度用的 0~100 展示值，50 为中性
  const valence = clamp(50 + signed, 0, 100);

  let arousal = adr + (cor - 20) * 0.4 + (mel - 25) * -0.4 + 22 + fear * 0.35;
  arousal = clamp(arousal, 0, 100);

  let control = 42 + (oxy - 50) * 0.45 + (ser - 52) * 0.5 - (cor - 20) * 0.55
    - Math.max(0, adr - 30) * 0.35 - Math.max(0, b.sleepiness - 60) * 0.2;
  control += (Number(p.resilience) - 0.5) * 30;
  control = clamp(control, 0, 100);

  const cand = nameOf(signed, arousal, cor, oxy, b);
  const last = s.last_inner;
  const lastSigned = s.last_signed == null ? signed : Number(s.last_signed);
  // 滞回：除非明显越过上次档位，否则先不换词
  const inner = (last && cand !== last && Math.abs(signed - lastSigned) < 8 && arousal > 18) ? last : cand;
  s.last_inner = inner;
  s.last_valence = valence;
  s.last_signed = signed;
  const outer = mask(inner, signed, arousal, p, s.relation);

  return {
    valence: round(valence, 1),
    arousal: round(arousal, 1),
    control: round(control, 1),
    inner,
    outer,
    label: outer,
    intensity: round(Math.min(1, Math.abs(signed) / 100 * 0.7 + arousal / 100 * 0.3), 2),
  };
}

// ---------------------------------------------------------------- 事件

// 单轮激素总变化夹取（防一句话把状态拉满）
const MAX_HORMONE_DELTA = 30;

function applyEvent(s, kind, intensity, src, now, sim) {
  const table = EVENTS[kind];
  if (!table) return { ok: false, error: 'unknown event: ' + kind };
  const t = nowDate(now);
  const amount = clamp(intensity == null ? 1 : intensity, 0.2, 1.6);
  const p = s.personality;
  const before = { ...s.hormones };

  for (const key of Object.keys(table)) {
    const dv = table[key];
    let gain = 1;
    if (key === 'cortisol' || key === 'adrenaline') {
      gain = 0.6 + Number(p.sensitivity) * 0.9;
    } else if (key === 'oxytocin' || key === 'dopamine' || key === 'serotonin' || key === 'endorphin') {
      gain = 0.7 + Number(p.warmth) * 0.7;
    }
    s.hormones[key] = clamp(Number(s.hormones[key]) + dv * amount * gain, 0, 100);
  }

  // 单轮总变化上限 ±30
  for (const key of Object.keys(before)) {
    const delta = s.hormones[key] - before[key];
    if (Math.abs(delta) > MAX_HORMONE_DELTA) {
      s.hormones[key] = clamp(before[key] + Math.sign(delta) * MAX_HORMONE_DELTA, 0, 100);
    }
  }

  // 亲密事件涨关系
  if (INTIMATE_KINDS.has(kind)) {
    s.relation.affection = clamp(s.relation.affection + 0.6 * amount, 0, 100);
    s.relation.rapport = clamp(s.relation.rapport + 0.4 * amount, 0, 100);
  }
  if (COLD_KINDS.has(kind)) {
    s.relation.security = clamp(s.relation.security - 2.0 * amount, 0, 100);
  }
  if (kind === 'comfort') {
    s.relation.trust = clamp(s.relation.trust + 0.8 * amount, 0, 100);
  }

  // 吓人的事：按 1-胆量 定强度（读角色当前胆量，不用默认值）
  if (FEAR_KINDS[kind]) {
    const brave = clamp(s.talents['胆量'] == null ? TALENT_DEFAULT['胆量'] : s.talents['胆量'], 0, 100);
    const power = (100 - brave) / 100;
    const lvl = (26 + 62 * power) * amount;
    s.fear = { v: round(Math.min(100, lvl), 1), why: FEAR_KINDS[kind], t: t.toISOString() };
  }

  const ev = { t: t.toISOString(), kind, intensity: round(amount, 2), src: src || 'vector' };
  if (sim != null) ev.sim = round(sim, 3);
  s.events.push(ev);
  if (s.events.length > 40) s.events = s.events.slice(-40);
  return { ok: true, event: ev };
}

// ---------------------------------------------------------------- 行为参数

function outbound(s) {
  const f = feel(s);
  const v = f.valence;
  const a = f.arousal;
  const b = s.body;
  const r = s.relation;

  let delay = 1 - (v / 100) * 0.35 + (Math.max(0, -v) / 100) * 0.7
    + Math.max(0, b.sleepiness - 60) / 100 * 0.8;
  delay = clamp(delay, 0.5, 2.6);

  const verbosity = 0.7 + a / 100 * 0.45 + v / 100 * 0.35
    - Math.max(0, b.sleepiness - 60) / 100 * 0.5;

  let urge = 0.45 + Math.abs(v) / 100 * 0.55 + a / 100 * 0.35
    + (r.dependence - 50) / 100 * 0.5;
  let cling = 0.35 + s.hormones.oxytocin / 100 * 0.85 + (r.affection - 50) / 100 * 0.3;

  const fear = Number((s.fear || {}).v || 0);
  if (fear > 0) {
    urge += fear / 100 * 0.30;
    cling += fear / 100 * 0.25;
  }

  return {
    delay: round(delay, 2),
    verbosity: round(Math.max(0.3, verbosity), 2),
    urge: round(Math.min(1.6, urge), 2),
    cling: round(Math.min(1.5, cling), 2),
  };
}

// ---------------------------------------------------------------- 主动消息

function resetDaily(s, now) {
  const key = dateKey(now);
  if (!s.today || s.today.date !== key) s.today = { date: key, sent: 0 };
  return s.today;
}

function parseClock(text, fallbackHour) {
  const m = String(text || '').match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (!m) return fallbackHour * 60;
  return clamp(Number(m[1]), 0, 23) * 60 + clamp(Number(m[2]), 0, 59);
}

function isNight(now, config) {
  const cfg = { ...PROACTIVE_DEFAULTS, ...(config || {}) };
  const t = nowDate(now);
  const mins = t.getHours() * 60 + t.getMinutes();
  const start = parseClock(cfg.nightStart, 23);
  const end = parseClock(cfg.nightEnd, 7);
  if (start === end) return false;
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

// 今日额度：心情好 5 / 平常 3 / 低落 1；困 >70 减 1
function proactiveQuota(s, now, config, emo) {
  const cfg = { ...PROACTIVE_DEFAULTS, ...(config || {}) };
  const f = emo || feel(s);
  const v = f.valence;
  let cap;
  let why;
  if (v >= 65) {
    cap = 5;
    why = '心情好，话就多';
  } else if (v < 35) {
    cap = 1;
    why = '情绪低，只想躲一会儿';
  } else {
    cap = 3;
    why = '平常的一天';
  }
  if (s.body.sleepiness > 70 && cap > 1) {
    cap -= 1;
    why += '，但困了，减一条';
  }
  if (cfg.cap !== 'auto' && cfg.cap != null && cfg.cap !== '') {
    cap = clamp(cfg.cap, 1, 20);
    why = '今日上限已手动设为 ' + cap;
  }
  const today = resetDaily(s, now);
  return { cap, used: today.sent, left: Math.max(0, cap - today.sent), why };
}

// 期望间隔：gap = max(20, 150 / max(0.35, urge*cling))
function baseGapMinutes(s, config, emo) {
  const cfg = { ...PROACTIVE_DEFAULTS, ...(config || {}) };
  const o = outbound(s);
  return Math.max(20, cfg.gapMin / Math.max(0.35, o.urge * o.cling));
}

// 动态概率 + 额度上限（设计 §9.1）
// 返回一次抽签的完整解释，供面板显示「为什么没触发」
function rollProactive(s, now, config, opts) {
  const cfg = { ...PROACTIVE_DEFAULTS, ...(config || {}) };
  const t = nowDate(now);
  const options = opts || {};
  const emo = feel(s);
  const quota = proactiveQuota(s, t, cfg, emo);
  const gap = baseGapMinutes(s, cfg, emo);
  const night = isNight(t, cfg);

  // 实际经过分钟数：用上次抽签时间，避免「调小间隔=变相调高频次」
  const lastCheck = Date.parse(s.lastCheckAt || '');
  const deltaMin = Number.isFinite(lastCheck)
    ? Math.max(0, (t.getTime() - lastCheck) / 60000)
    : clamp(cfg.checkSeconds / 60, 0.1, 10);
  const lambda = 1 / gap;
  const pCheck = 1 - (1 - lambda) ** deltaMin;
  let p = Math.min(1, pCheck * clamp(cfg.weight, 0, 1e6));

  // 各道闸门
  let blocked = '';
  let cooldownLeft = 0;
  let quietLeft = 0;

  if (quota.left <= 0) {
    blocked = 'quota';
  } else if (night) {
    blocked = 'night';
  } else {
    const lastPro = Date.parse(s.lastProactiveAt || '');
    if (cfg.cooldownMin > 0 && Number.isFinite(lastPro)) {
      cooldownLeft = Math.max(0, cfg.cooldownMin - (t.getTime() - lastPro) / 60000);
      if (cooldownLeft > 0) blocked = 'cooldown';
    }
    if (!blocked && cfg.quietMin > 0) {
      const lastUser = Date.parse(options.lastUserAt || '');
      if (Number.isFinite(lastUser)) {
        quietLeft = Math.max(0, cfg.quietMin - (t.getTime() - lastUser) / 60000);
        if (quietLeft > 0) blocked = 'quiet';
      }
    }
  }

  // 保底：额度还有、距上次主动超过 4×gap 却一直抽不中时，兜一把
  let floored = false;
  if (!blocked && cfg.floor) {
    const anchor = Date.parse(s.lastProactiveAt || s.startedAt || s.updated || '');
    if (Number.isFinite(anchor) && (t.getTime() - anchor) / 60000 > 4 * gap) {
      if (p < 0.5) {
        p = 0.5;
        floored = true;
      }
    }
  }
  if (blocked) p = 0;

  const roll = typeof options.random === 'function' ? options.random() : Math.random();
  const fired = !blocked && roll < p;

  s.lastCheckAt = t.toISOString();

  return {
    quota,
    gapMin: round(gap, 1),
    p: round(p, 4),
    roll: round(roll, 4),
    fired,
    blocked,
    night,
    cooldownLeft: Math.round(cooldownLeft),
    quietLeft: Math.round(quietLeft),
    floored,
    weight: cfg.weight,
    checkSeconds: cfg.checkSeconds,
    emotion: emo,
  };
}

// 记录一次主动开口
function markProactive(s, now, src) {
  const t = nowDate(now);
  const today = resetDaily(s, t);
  today.sent += 1;
  s.lastProactiveAt = t.toISOString();
  s.events.push({ t: t.toISOString(), kind: 'proactive', intensity: 1, src: src || 'auto' });
  if (s.events.length > 40) s.events = s.events.slice(-40);
  return today.sent;
}

// ---------------------------------------------------------------- 面板/注入

// 把数字翻成人话：这一刻是谁在推谁
function influences(s) {
  const h = s.hormones;
  const b = s.body;
  const r = s.relation;
  const out = [];
  if (h.adrenaline >= 45) out.push(`肾上腺素 ${Math.round(h.adrenaline)}：心是提着的，说话会冲一点。`);
  if (h.cortisol >= 40) out.push(`皮质醇 ${Math.round(h.cortisol)}：容易往坏处想，别在这时候说重话。`);
  if (h.dopamine >= 60) out.push(`多巴胺 ${Math.round(h.dopamine)}：现在学东西快，也容易被逗笑。`);
  if (h.oxytocin >= 60) out.push(`催产素 ${Math.round(h.oxytocin)}：特别想黏着你，会主动找你。`);
  if (b.sleepiness >= 60) out.push(`困到 ${Math.round(b.sleepiness)}：回话变慢、字变短，不是不高兴。`);
  if (b.hunger >= 60) out.push(`饿到 ${Math.round(b.hunger)}：一点小事就想发脾气。`);
  if (r.trust >= 85) out.push(`信任 ${Math.round(r.trust)}：你说的话我不去猜别的意思。`);
  if (r.security <= 55) out.push(`安全感只有 ${Math.round(r.security)}：会翻旧账，会问你在不在。`);
  const fv = Number((s.fear || {}).v || 0);
  if (fv >= FEAR_SHOW) {
    const why = (s.fear || {}).why || '刚才';
    out.push(`被${why}吓到了（怕劲儿 ${Math.round(fv)}）：心里还发毛，想找你陪一会儿，嘴上还嘴硬。`);
  }
  if (!out.length) out.push('现在各项都在舒服的位置，没什么在推我。');
  return out.slice(0, 4);
}

// 注入用的占位符（模板在 app/preset-emotion.md，由用户维护）
function placeholders(s, now, config, opts) {
  const t = nowDate(now);
  const emo = feel(s);
  const o = outbound(s);
  const quota = proactiveQuota(s, t, config, emo);
  const b = s.body;
  const r = s.relation;
  const options = opts || {};

  const bodyLine = [
    `体力 ${Math.round(b.stamina)}`,
    `困倦 ${Math.round(b.sleepiness)}`,
    `饥饿 ${Math.round(b.hunger)}`,
    `健康 ${Math.round(b.health)}`,
  ].join('，');

  const relationLine = [
    `亲近 ${Math.round(r.affection)}`,
    `信任 ${Math.round(r.trust)}`,
    `依赖 ${Math.round(r.dependence)}`,
    `安心 ${Math.round(r.security)}`,
    `默契 ${Math.round(r.rapport)}`,
  ].join('，');

  const hormoneLine = [
    `肾上腺素 ${Math.round(s.hormones.adrenaline)}`,
    `皮质醇 ${Math.round(s.hormones.cortisol)}`,
    `多巴胺 ${Math.round(s.hormones.dopamine)}`,
    `催产素 ${Math.round(s.hormones.oxytocin)}`,
    `血清素 ${Math.round(s.hormones.serotonin)}`,
    `内啡肽 ${Math.round(s.hormones.endorphin)}`,
    `褪黑素 ${Math.round(s.hormones.melatonin)}`,
  ].join('，');

  const fear = s.fear && s.fear.v >= FEAR_SHOW ? `${s.fear.why}（${Math.round(s.fear.v)}）` : '';

  return {
    inner: emo.inner,
    outer: emo.outer,
    valence: emo.valence,
    arousal: emo.arousal,
    control: emo.control,
    intensity: emo.intensity,
    body_line: bodyLine,
    relation_line: relationLine,
    hormone_line: hormoneLine,
    left: quota.left,
    cap: quota.cap,
    gap_min: Math.round(baseGapMinutes(s, config, emo)),
    fear,
    verbosity: o.verbosity,
    delay: o.delay,
    cling: o.cling,
    urge: o.urge,
    phase: phase(t.getHours()),
    weekday: '周' + '日一二三四五六'[t.getDay()],
    clock: String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'),
    daysTogether: daysTogether(s, t),
    ...(options.extra || {}),
  };
}

// 模板填充：只替换已知占位符，未知的原样留着
function fillTemplate(template, values) {
  return String(template || '').replace(/\{([a-zA-Z_]+)\}/g, (all, key) => {
    if (values[key] == null || values[key] === '') return all;
    return String(values[key]);
  });
}

function daysTogether(s, now) {
  const since = s.profile && s.profile.together_since;
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((nowDate(now).getTime() - t) / 86400000);
  return days >= 0 ? days : null;
}

const API = {
  // 常量
  BODY_REST, HORMONE_REST, HALF_LIFE, RELATION_REST,
  TALENTS, TALENT_DEFAULT, PERSONALITY_KEYS, PERSONALITY_DEFAULT,
  EVENTS, FEAR_KINDS, FEAR_SHOW, PROACTIVE_DEFAULTS,
  // 工具
  clamp, round, phase, circadian, melatoninTarget, dateKey, isNight,
  // 状态
  defaultState, tick, decayBody, decayHormones, decayRelation, decayFear,
  // 情绪
  feel, mask, nameOf, outbound,
  // 事件
  applyEvent,
  // 主动
  proactiveQuota, baseGapMinutes, rollProactive, markProactive,
  // 展示
  influences, placeholders, fillTemplate, daysTogether,
};

return API;
}));
