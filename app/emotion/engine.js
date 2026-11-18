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

// 技能只剩「胆量」：其余五维从未被读取，已删
const TALENTS = ['胆量'];
const TALENT_DEFAULT = { 胆量: 50 };

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

// 生物钟：用户可调的「起床 / 入睡」，默认 06:00–22:00（等价于旧的固定表）
const RHYTHM_DEFAULTS = { wake: 6, sleep: 22, minWake: 8, maxWake: 20 };
// 清醒段按 3:3:2:4:4 切成五段，睡眠段整段算深夜
const RHYTHM_SPLIT = [
  { key: 'dawn', name: '清晨', ratio: 3 },
  { key: 'morning', name: '上午', ratio: 3 },
  { key: 'noon', name: '中午', ratio: 2 },
  { key: 'afternoon', name: '下午', ratio: 4 },
  { key: 'evening', name: '晚上', ratio: 4 },
];
const RHYTHM_SPLIT_SUM = 16;

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
  capMultiplier: 1.0,   // 每日上限倍率（向下取整），只作用于自动上限
  ignoreHours: 12,      // 主动开口后多久没人理，补记一次「被忽略」
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

// 带小数的钟点：生物钟分段落在半点时也能对齐
function clockHoursOf(now) {
  const d = nowDate(now);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

// 昼夜节律：返回虚拟钟点对应的小时数（供褪黑素曲线使用）

// 褪黑素钟点目标值：虚拟钟点可能是小数，按相邻整点线性插值
function melatoninTarget(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const lo = Math.floor(h);
  const hi = (lo + 1) % 24;
  const a = MEL_CURVE[lo] == null ? 12 : MEL_CURVE[lo];
  const c = MEL_CURVE[hi] == null ? 12 : MEL_CURVE[hi];
  return a + (c - a) * (h - lo);
}

// 时段中文（永远按真实钟点，避免用户调了作息后文案说错）
function phase(hour) {
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚上';
  return '半夜';
}

// 入睡 / 起床归一化：清醒时长夹在 8~20 小时，越界就挪入睡时间
function normalizeRhythm(rhythm) {
  const src = rhythm || {};
  const pick = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const wake = ((Math.round(pick(src.wake, RHYTHM_DEFAULTS.wake)) % 24) + 24) % 24;
  let sleep = ((Math.round(pick(src.sleep, RHYTHM_DEFAULTS.sleep)) % 24) + 24) % 24;
  let wakeLen = (sleep - wake + 24) % 24;
  if (wakeLen < RHYTHM_DEFAULTS.minWake) wakeLen = RHYTHM_DEFAULTS.minWake;
  if (wakeLen > RHYTHM_DEFAULTS.maxWake) wakeLen = RHYTHM_DEFAULTS.maxWake;
  sleep = (wake + wakeLen) % 24;
  return { wake, sleep, wakeLen, sleepLen: 24 - wakeLen };
}

// 真实钟点 → 标准钟点：清醒段拉成 06~22，睡眠段拉成 22~06。
// 默认 06/22 时是恒等映射，行为和旧的固定表一致。
function rhythmHour(hour, rhythm) {
  const r = normalizeRhythm(rhythm);
  const h = ((Number(hour) % 24) + 24) % 24;
  const d = (h - r.wake + 24) % 24;
  if (d < r.wakeLen) return 6 + (d / r.wakeLen) * 16;
  // 睡眠段映射到 22~06，会越过 24 点，绕回来
  return (22 + ((d - r.wakeLen) / r.sleepLen) * 8) % 24;
}

// 真实钟点下的分段：五个清醒段 + 一个整段深夜（跨午夜时 end < start）
function rhythmSegments(rhythm) {
  const r = normalizeRhythm(rhythm);
  const out = [];
  let cursor = r.wake;
  for (const seg of RHYTHM_SPLIT) {
    const len = (r.wakeLen * seg.ratio) / RHYTHM_SPLIT_SUM;
    const start = cursor;
    cursor = (cursor + len) % 24;
    out.push({
      key: seg.key,
      name: seg.name,
      start: round(start, 3),
      end: round(cursor, 3),
      hours: round(len, 3),
      sleep: false,
    });
  }
  out.push({
    key: 'night',
    name: '深夜',
    start: round(r.sleep, 3),
    end: round(r.wake, 3),
    hours: round(r.sleepLen, 3),
    sleep: true,
  });
  return out;
}

// 改了作息后，把钟点直接驱动的褪黑素按此刻虚拟钟点应有的水平重新起算，
// 否则旧作息攒下的困意要几小时才化开，看起来像设置没生效。
function rebaseRhythm(s, now, rhythm) {
  if (!s || !s.hormones) return s;
  const virtual = rhythmHour(clockHoursOf(now), rhythm);
  s.hormones.melatonin = clamp(melatoninTarget(virtual), 0, 100);
  return s;
}

// 困意分档表：用户可在选项页改阈值与文案，这里只是默认值（从高到低）
const STATE_TIERS = [
  { min: 80, label: '很困' },
  { min: 65, label: '比较困' },
  { min: 50, label: '有点困' },
  { min: 0, label: '清醒' },
];

// 用户改过的表可能缺项 / 顺序乱 / 文案为空，这里统一整理：按阈值从高到低，至少保留一条
function normalizeTiers(tiers) {
  const src = Array.isArray(tiers) ? tiers : [];
  const out = [];
  for (const t of src) {
    if (!t || typeof t !== 'object') continue;
    const min = Number(t.min);
    const label = typeof t.label === 'string' ? t.label.trim() : '';
    if (!Number.isFinite(min) || !label) continue;
    out.push({ min: clamp(Math.round(min), 0, 100), label: label.slice(0, 8) });
  }
  if (!out.length) return STATE_TIERS.map((t) => ({ ...t }));
  out.sort((a, b) => b.min - a.min);
  return out;
}

// 每轮注入的一行状态：只给词，不给数值，也不带行为建议。
// 起床 40 分钟内 → 刚睡醒；其余一律按困意查映射表（睡眠段不再特殊，
// 半夜聊天本来就该显示多困，而不是永远「刚被叫醒」）。
function stateTag(s, now, rhythm, tiers) {
  const r = normalizeRhythm(rhythm);
  const d = (clockHoursOf(now) - r.wake + 24) % 24;
  if (d < 2 / 3) return '刚睡醒';
  const list = normalizeTiers(tiers);
  const sleepy = Number(s && s.hormones ? s.hormones.melatonin : NaN);
  if (!Number.isFinite(sleepy)) return list[list.length - 1].label;
  for (const t of list) {
    if (sleepy >= t.min) return t.label;
  }
  // 低于最低一档也归到最低那档，保证总有词可用
  return list[list.length - 1].label;
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
    hormones: { ...HORMONE_REST },
    relation: { ...RELATION_REST },
    talents: { ...TALENT_DEFAULT },
    fear: null,
    last_inner: null,
    last_signed: null,
    today: { date: dateKey(d), sent: 0 },
    lastProactiveAt: null,
    lastCheckAt: null,
    lastUserAt: null,
    lastIgnoredProactiveAt: null,
    stats: blankReplyStats(),
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

function decayHormones(s, mins, now, rhythm) {
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
  // 褪黑素不按半衰期，按钟点靠拢（钟点走生物钟映射）
  const target = melatoninTarget(rhythmHour(clockHoursOf(now), rhythm));
  const curMel = s.hormones.melatonin;
  s.hormones.melatonin = clamp(target + (curMel - target) * (0.5 ** (mins / 45)), 0, 100);
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

// 主推进：按经过分钟数依次衰减，最后刷新 updated。
// rhythm = { wake, sleep }（真实钟点），缺省 06/22 时与旧行为一致。
function tick(s, now, rhythm) {
  const t = nowDate(now);
  const mins = minutesSince(s.updated, t);
  decayFear(s, mins);
  decayHormones(s, mins, t, rhythm);
  decayRelation(s, mins);
  // 心情反过来影响困意（幅度很小）：愉悦低于 50 更容易困，高于 50 更清醒，满幅只拉 ±6。
  // 先按钟点算目标，再叠加心情偏置，用 45 分钟时间常数靠拢，tick 间隔不同也不会跳。
  if (mins > 0) {
    const mood = feel(s);
    const target = melatoninTarget(rhythmHour(clockHoursOf(t), rhythm)) + (50 - mood.valence) * 0.12;
    s.hormones.melatonin = clamp(target + (Number(s.hormones.melatonin) - target) * (0.5 ** (mins / 45)), 0, 100);
  }
  s.updated = t.toISOString();
  return s;
}

// ---------------------------------------------------------------- 情绪

// 情绪标签（内心）
function nameOf(v, a, cor, oxy, mel) {
  if (mel > 80 && v > -20) return '困到走神';
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

// 激素 → 情绪三维 → 内心/外显标签
function feel(s) {
  const p = s.personality;
  const h = s.hormones;
  const adr = Number(h.adrenaline), cor = Number(h.cortisol), dop = Number(h.dopamine);
  const oxy = Number(h.oxytocin), ser = Number(h.serotonin), end = Number(h.endorphin);
  const mel = Number(h.melatonin);

  // 以静息值为中性：基线激素 → 0，映射到 50 分
  const raw = (dop - HORMONE_REST.dopamine) * 0.85
    + (oxy - HORMONE_REST.oxytocin) * 0.45
    + (ser - HORMONE_REST.serotonin) * 0.8
    + (end - HORMONE_REST.endorphin) * 0.5
    - (cor - HORMONE_REST.cortisol) * 0.55
    - Math.max(0, mel - 55) * 0.25;

  const fear = Number((s.fear || {}).v || 0);
  // signed：以 0 为中性，给标签判断用（参考实现的 v<-30 / v>45 都以 0 为轴）
  const signed = raw * 1.05
    + (Number(p.optimism) - 0.5) * 30
    - fear * 0.30;
  // 面板/额度用的 0~100 展示值，50 为中性
  const valence = clamp(50 + signed, 0, 100);

  let arousal = adr + (cor - 20) * 0.4 + (mel - 25) * -0.4 + 22 + fear * 0.35;
  arousal = clamp(arousal, 0, 100);

  const cand = nameOf(signed, arousal, cor, oxy, mel);
  const last = s.last_inner;
  const lastSigned = s.last_signed == null ? signed : Number(s.last_signed);
  // 滞回：除非明显越过上次档位，否则先不换词
  const inner = (last && cand !== last && Math.abs(signed - lastSigned) < 8 && arousal > 18) ? last : cand;
  s.last_inner = inner;
  s.last_signed = signed;
  const outer = mask(inner, signed, arousal, p, s.relation);

  return {
    valence: round(valence, 1),
    arousal: round(arousal, 1),
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

// 只有 urge / cling 真正影响行为（主动间隔），话多 / 回速已删
function outbound(s) {
  const f = feel(s);
  const v = f.valence;
  const a = f.arousal;
  const r = s.relation;

  let urge = 0.45 + Math.abs(v) / 100 * 0.55 + a / 100 * 0.35
    + (r.dependence - 50) / 100 * 0.5;
  let cling = 0.35 + s.hormones.oxytocin / 100 * 0.85 + (r.affection - 50) / 100 * 0.3;

  const fear = Number((s.fear || {}).v || 0);
  if (fear > 0) {
    urge += fear / 100 * 0.30;
    cling += fear / 100 * 0.25;
  }

  return {
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
  if (Number(s.hormones.melatonin) > 70 && cap > 1) {
    cap -= 1;
    why += '，但困了，减一条';
  }
  const mult = clamp(cfg.capMultiplier, 0.1, 3);
  if (mult !== 1) {
    const base = cap;
    cap = clamp(Math.floor(base * mult), 1, 20);
    why += `（${base} × ${round(mult, 2)} 向下取整 = ${cap} 条）`;
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

// 记录用户真的说了话（[系统信息] 那种不算）；ignore 判定要用它
function markUserMessage(s, now) {
  s.lastUserAt = nowDate(now).toISOString();
}

// 她主动开口后 N 小时没人理 → 补记一次 ignore。
// 纯时间对比，软件关着也不影响：下次启动 tick 到「现在」时照样能结算。
function applyIgnoreIfDue(s, now, config) {
  const cfg = { ...PROACTIVE_DEFAULTS, ...(config || {}) };
  const t = nowDate(now);
  const pro = Date.parse(s.lastProactiveAt || '');
  if (!Number.isFinite(pro)) return null;
  const ignored = Date.parse(s.lastIgnoredProactiveAt || '');
  if (Number.isFinite(ignored) && ignored >= pro) return null;
  const said = Date.parse(s.lastUserAt || '');
  if (Number.isFinite(said) && said > pro) return null;
  const hours = clamp(Number(cfg.ignoreHours), 1, 72);
  if (t.getTime() - pro < hours * 3600000) return null;
  s.lastIgnoredProactiveAt = new Date(pro).toISOString();
  applyEvent(s, 'ignore', 1, 'time', t);
  return { hours, at: s.lastIgnoredProactiveAt };
}

// ---------------------------------------------------------------- 回复统计（只用来画雷达）

// 平滑窗口：相当于 20 条回复的先验，越大越不容易被几句话带偏
const TRAIT_SPAN = 20;

// 傲娇句式：统计和性格自适应用同一条规则
const TSUNDERE_RE = /(哼|才不|才没|别管|不要你|谁要|讨厌)/;

function blankReplyStats() {
  return {
    replies: 0,
    intimate: 0,
    cold: 0,
    questions: 0,
    tsundere: 0,
    valenceSum: 0,
    valenceSqSum: 0,
  };
}

// 她的这条回复：命中什么、有多问、有多嘴硬、当时心情如何，累计下来
function noteReplyStats(s, reply, kinds, valence) {
  const st = s.stats || (s.stats = blankReplyStats());
  const text = String(reply || '');
  st.replies = (Number(st.replies) || 0) + 1;
  const v = clamp(valence, 0, 100);
  st.valenceSum = (Number(st.valenceSum) || 0) + v;
  st.valenceSqSum = (Number(st.valenceSqSum) || 0) + v * v;
  const list = Array.isArray(kinds) ? kinds : [];
  if (list.some((k) => INTIMATE_KINDS.has(k))) st.intimate += 1;
  if (list.some((k) => COLD_KINDS.has(k) || k === 'scare')) st.cold += 1;
  if (/[?？]/.test(text)) st.questions += 1;
  if (TSUNDERE_RE.test(text)) st.tsundere += 1;
  return st;
}

// 性格自适应（选项页开关，默认关）：把这一轮的即时语气慢慢沉淀进底色 personality，
// 从而真正影响 feel()、激素增益与说话方式。rate 是每轮向目标靠拢的比例。
// 只动 4 维：温暖 / 敏感 / 倔强 / 乐观；开放度仍只做展示，韧性交给长期统计。
function adaptPersonality(s, reply, kinds, valence, rate) {
  if (!s || !s.personality) return null;
  const r = clamp(Number(rate) || 0, 0, 0.05);
  if (r <= 0) return s.personality;
  const p = s.personality;
  const list = Array.isArray(kinds) ? kinds : [];
  const intimate = list.some((k) => INTIMATE_KINDS.has(k));
  const cold = list.some((k) => COLD_KINDS.has(k) || k === 'scare');
  const move = (key, target) => {
    const cur = Number(p[key]) || 0.55;
    // 底色留在 0.35~0.8：太低会变成另一个人，太高会把性格锁死
    p[key] = clamp(cur + (clamp(target, 0, 1) - cur) * r, 0.35, 0.8);
  };
  // 好事让她更暖、更不敏感；坏事反过来；两个方向互相牵制，不会只涨不跌
  if (intimate) { move('warmth', 0.9); move('sensitivity', 0.45); }
  if (cold) { move('sensitivity', 0.9); move('warmth', 0.45); }
  if (TSUNDERE_RE.test(String(reply || ''))) move('stubbornness', 0.9);
  const v = Number(valence);
  if (Number.isFinite(v)) move('optimism', v / 100);
  return p;
}

// 雷达六维：以角色当前底色为先验，被她的表达慢慢拉动；只用于展示，不回灌公式
// span 是先验强度（等价「多少条统计才能和底色五五开」），由用户设置页调节，默认 TRAIT_SPAN
function deriveTraits(stats, personality, span) {
  const st = stats || blankReplyStats();
  const p = personality || PERSONALITY_DEFAULT;
  const n = Number(st.replies) || 0;
  const prior = Math.max(1, Math.min(200, Number(span) || TRAIT_SPAN));
  const blend = (count, base) => clamp((Number(base) * prior + (Number(count) || 0)) / (prior + n), 0, 1);
  const mean = n ? Number(st.valenceSum) / n : 50;
  const sq = n ? Number(st.valenceSqSum) / n : 2500;
  const sd = Math.sqrt(Math.max(0, sq - mean * mean));
  const stable = 1 - clamp(sd / 45, 0, 1);
  return {
    warmth: blend(st.intimate, p.warmth),
    sensitivity: blend(st.cold, p.sensitivity),
    resilience: clamp((Number(p.resilience) * prior + stable * n) / (prior + n), 0, 1),
    optimism: clamp((Number(p.optimism) * prior + (Number(st.valenceSum) || 0) / 100) / (prior + n), 0, 1),
    openness: blend(st.questions, p.openness),
    stubbornness: blend(st.tsundere, p.stubbornness),
  };
}

// ---------------------------------------------------------------- 面板/注入

// 把数字翻成人话：这一刻是谁在推谁
function influences(s) {
  const h = s.hormones;
  const r = s.relation;
  const out = [];
  if (h.adrenaline >= 45) out.push(`紧张 ${Math.round(h.adrenaline)}：主动开口时会说得急一点。`);
  if (h.cortisol >= 40) out.push(`压力 ${Math.round(h.cortisol)}：主动找你时容易往坏处想。`);
  if (h.dopamine >= 60) out.push(`快乐 ${Math.round(h.dopamine)}：主动说话会更轻快。`);
  if (h.oxytocin >= 60) out.push(`亲密 ${Math.round(h.oxytocin)}：特别想黏着你，主动找你更频繁。`);
  if (h.melatonin >= 60) out.push(`困到 ${Math.round(h.melatonin)}：不太想主动开口，找你的次数会变少。`);
  if (r.trust >= 85) out.push(`信任 ${Math.round(r.trust)}：主动开口时更愿意说心里话。`);
  if (r.security <= 55) out.push(`安全感只有 ${Math.round(r.security)}：主动找你时更想确认你在不在。`);
  const fv = Number((s.fear || {}).v || 0);
  if (fv >= FEAR_SHOW) {
    const why = (s.fear || {}).why || '刚才';
    out.push(`被${why}吓到了（怕劲儿 ${Math.round(fv)}）：主动开口时还带着点没缓过来。`);
  }
  if (!out.length) out.push('现在各项都在舒服的位置，没什么在推我。');
  return out.slice(0, 4);
}

// 注入模板不出现裸数字：数值按区间换成程度词
const LEVEL_BANDS = [80, 60, 40, 20];
function levelWord(value, words, bands) {
  const cuts = bands || LEVEL_BANDS;
  const n = Number(value);
  const v = Number.isFinite(n) ? n : 0;
  const idx = cuts.findIndex((cut) => v >= cut);
  return words[idx === -1 ? words.length - 1 : idx];
}

const TIRED_WORDS = ['困得厉害', '挺困', '有点困', '不太困', '很清醒'];

const RELATION_WORDS = {
  affection: ['很亲近', '挺亲近', '关系一般', '有点疏远', '很生疏'],
  trust: ['完全信任', '挺信任', '还在观察', '有点防备', '很难信任'],
  dependence: ['很依赖你', '有点依赖你', '不太依赖你', '挺独立的', '完全靠自己'],
  security: ['很安心', '挺安心', '还算安稳', '有点忐忑', '很不安'],
  rapport: ['很有默契', '挺有默契', '还在磨合', '经常对不上', '总是错开'],
};

const HORMONE_WORDS = {
  adrenaline: ['紧绷', '很高', '偏高', '略高', '平稳'],
  cortisol: ['压得慌', '很高', '偏高', '略高', '平稳'],
  dopamine: ['很兴奋', '很高', '偏高', '一般', '偏低'],
  oxytocin: ['很想黏人', '很高', '偏高', '一般', '偏低'],
  serotonin: ['很满足', '很高', '偏高', '一般', '偏低'],
  endorphin: ['很放松', '很高', '偏高', '一般', '偏低'],
  melatonin: ['困意很重', '很高', '偏高', '一般', '偏低'],
};

const INTENSITY_BANDS = [1.2, 0.75, 0.35, 0.05];
const INTENSITY_WORDS = ['很强烈', '挺明显', '不太明显', '淡淡的', '几乎察觉不到'];

// 主动开口模板的占位符（模板在 app/preset-proactive.md，由用户维护）
function placeholders(s, now, config, opts) {
  const t = nowDate(now);
  const emo = feel(s);
  const o = outbound(s);
  const quota = proactiveQuota(s, t, config, emo);
  const r = s.relation;
  const options = opts || {};

  const bodyLine = levelWord(s.hormones.melatonin, TIRED_WORDS);

  const relationLine = [
    levelWord(r.affection, RELATION_WORDS.affection),
    levelWord(r.trust, RELATION_WORDS.trust),
    levelWord(r.dependence, RELATION_WORDS.dependence),
    levelWord(r.security, RELATION_WORDS.security),
    levelWord(r.rapport, RELATION_WORDS.rapport),
  ].join('，');

  const hormoneLine = [
    `紧张 ${levelWord(s.hormones.adrenaline, HORMONE_WORDS.adrenaline)}`,
    `压力 ${levelWord(s.hormones.cortisol, HORMONE_WORDS.cortisol)}`,
    `快乐 ${levelWord(s.hormones.dopamine, HORMONE_WORDS.dopamine)}`,
    `亲密 ${levelWord(s.hormones.oxytocin, HORMONE_WORDS.oxytocin)}`,
    `满足 ${levelWord(s.hormones.serotonin, HORMONE_WORDS.serotonin)}`,
    `治愈 ${levelWord(s.hormones.endorphin, HORMONE_WORDS.endorphin)}`,
    `困意 ${levelWord(s.hormones.melatonin, HORMONE_WORDS.melatonin)}`,
  ].join('，');

  const fear =
    s.fear && s.fear.v >= FEAR_SHOW
      ? `${s.fear.why}（${levelWord(s.fear.v, ['吓坏了', '很怕', '挺怕', '有点怕', '还发毛'])}）`
      : '';

  return {
    inner: emo.inner,
    outer: emo.outer,
    valence: emo.valence,
    arousal: emo.arousal,
    // 模板里只给程度词，不给 0.19 这种裸数字
    intensity: levelWord(emo.intensity, INTENSITY_WORDS, INTENSITY_BANDS),
    body_line: bodyLine,
    relation_line: relationLine,
    hormone_line: hormoneLine,
    left: quota.left,
    cap: quota.cap,
    gap_min: Math.round(baseGapMinutes(s, config, emo)),
    fear,
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
  HORMONE_REST, HALF_LIFE, RELATION_REST,
  TALENTS, TALENT_DEFAULT, PERSONALITY_KEYS, PERSONALITY_DEFAULT,
  EVENTS, FEAR_KINDS, FEAR_SHOW, PROACTIVE_DEFAULTS, RHYTHM_DEFAULTS,
  // 工具
  clamp, round, phase, melatoninTarget, dateKey, isNight,
  // 生物钟
  normalizeRhythm, rhythmHour, rhythmSegments, rebaseRhythm,
  stateTag, STATE_TIERS, normalizeTiers,
  // 状态
  defaultState, tick, decayHormones, decayRelation, decayFear,
  // 情绪
  feel, mask, nameOf, outbound,
  // 事件
  applyEvent,
  // 主动
  proactiveQuota, baseGapMinutes, rollProactive, markProactive,
  markUserMessage, applyIgnoreIfDue,
  // 雷达
  noteReplyStats, deriveTraits, adaptPersonality, TRAIT_SPAN,
  // 展示
  influences, placeholders, fillTemplate, daysTogether,
};

return API;
}));
