// ============================================================================
//  情感引擎单测（固定时钟，纯函数）
//  运行：node app/emotion/engine.test.js
//  不依赖任何第三方库，失败即退出码 1
// ============================================================================

'use strict';

const assert = require('node:assert');
const E = require('./engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message));
  }
}

// 固定时钟：本地时间 2026-11-14 10:00
const T0 = new Date(2026, 10, 14, 10, 0, 0);
function at(hour, minute, dayOffset) {
  return new Date(2026, 10, 14 + (dayOffset || 0), hour, minute || 0, 0);
}
function fresh() {
  return E.defaultState(T0);
}

// ---------------------------------------------------------------- 衰减

test('身体：180 分钟向「静息+昼夜」靠拢一半', () => {
  const s = fresh();
  s.body.stamina = 68;
  // 13:00 的体力昼夜偏移是 -4 → 静息 64
  E.tick(s, at(13, 0));
  const expect = 64 + (68 - 64) * 0.5;
  assert.ok(Math.abs(s.body.stamina - expect) < 1e-6, `实际 ${s.body.stamina}，期望 ${expect}`);
});

test('激素：半衰期按韧性加速，且结果不越界', () => {
  const s = fresh();
  s.hormones.adrenaline = 100;
  const before = s.hormones.adrenaline;
  E.tick(s, at(10, 8)); // 8 分钟 = 一个半衰期
  assert.ok(s.hormones.adrenaline < before, '肾上腺素应下降');
  const rest = E.HORMONE_REST.adrenaline;
  const speed = 0.7 + s.personality.resilience * 0.6;
  const hlDecay = rest + (before - rest) * (0.5 ** (8 * speed / E.HALF_LIFE.adrenaline));
  const home = 1 - 0.5 ** (8 / 240);
  const expect = hlDecay + (rest - hlDecay) * home;
  assert.ok(Math.abs(s.hormones.adrenaline - expect) < 1e-6, `实际 ${s.hormones.adrenaline}，期望 ${expect}`);
  for (const key of Object.keys(E.HORMONE_REST)) {
    assert.ok(s.hormones[key] >= 0 && s.hormones[key] <= 100, key + ' 越界');
  }
});

test('褪黑素按钟点靠拢，深夜困倦上涨', () => {
  const s = fresh();
  s.hormones.melatonin = 10;
  s.body.sleepiness = 30;
  E.tick(s, at(2, 0, 1)); // 次日 02:00，目标 94
  assert.ok(s.hormones.melatonin > 60, '褪黑素应被抬到高位，实际 ' + s.hormones.melatonin);
  assert.ok(s.body.sleepiness > 30, '困倦应上涨');
});

test('关系：12 天半衰，只掉一半距离', () => {
  const s = fresh();
  s.relation.affection = 100;
  const mins = 60 * 24 * 12;
  E.decayRelation(s, mins);
  const expect = E.RELATION_REST.affection + (100 - E.RELATION_REST.affection) * 0.5;
  assert.ok(Math.abs(s.relation.affection - expect) < 1e-6);
});

test('恐惧：90 分钟减半，低于 20 清除', () => {
  const s = fresh();
  s.fear = { v: 80, why: '打雷', t: T0.toISOString() };
  E.tick(s, at(11, 30)); // 90 分钟
  assert.ok(Math.abs(s.fear.v - 40) < 0.2, '实际 ' + s.fear.v);
  E.tick(s, at(15, 30)); // 再 240 分钟 → 远低于 20
  assert.strictEqual(s.fear, null);
});

// ---------------------------------------------------------------- 情绪

test('情绪：开心时 inner=开心，嘴硬的人 outer 会更收敛', () => {
  const s = fresh();
  s.hormones.dopamine = 85;
  s.hormones.oxytocin = 70;
  s.hormones.serotonin = 70;
  s.hormones.adrenaline = 60;
  s.hormones.cortisol = 10;
  s.personality.stubbornness = 0.8;
  const f = E.feel(s);
  assert.strictEqual(f.inner, '开心');
  assert.ok(['开心', '嘚瑟'].includes(f.outer), '实际 outer=' + f.outer);
});

test('情绪：嘴硬的人受委屈时外显为「别扭」', () => {
  const s = fresh();
  s.hormones.cortisol = 70;
  s.hormones.dopamine = 10;
  s.hormones.serotonin = 30;
  s.personality.stubbornness = 0.8;
  const f = E.feel(s);
  assert.strictEqual(f.inner, '委屈');
  assert.strictEqual(f.outer, '别扭');
});

test('情绪：嘴软的人内外一致', () => {
  const s = fresh();
  s.hormones.cortisol = 70;
  s.hormones.dopamine = 10;
  s.hormones.serotonin = 30;
  s.personality.stubbornness = 0.2;
  const f = E.feel(s);
  assert.strictEqual(f.inner, f.outer);
});

test('情绪：三维都在 0~100，强度在 0~1', () => {
  const s = fresh();
  const f = E.feel(s);
  for (const k of ['valence', 'arousal', 'control']) {
    assert.ok(f[k] >= 0 && f[k] <= 100, k + ' 越界：' + f[k]);
  }
  assert.ok(f.intensity >= 0 && f.intensity <= 1);
});

// ---------------------------------------------------------------- 事件

test('事件：夸她 → 多巴胺/催产素上涨', () => {
  const s = fresh();
  const dop = s.hormones.dopamine;
  const oxy = s.hormones.oxytocin;
  const r = E.applyEvent(s, 'praise', 1, 'vector', T0);
  assert.ok(r.ok);
  assert.ok(s.hormones.dopamine > dop);
  assert.ok(s.hormones.oxytocin > oxy);
  assert.strictEqual(s.events.length, 1);
  assert.strictEqual(s.events[0].src, 'vector');
});

test('事件：冷淡 → 皮质醇上涨、安全感下降', () => {
  const s = fresh();
  const cor = s.hormones.cortisol;
  const sec = s.relation.security;
  E.applyEvent(s, 'cold', 1, 'vector', T0);
  assert.ok(s.hormones.cortisol > cor);
  assert.ok(s.relation.security < sec);
});

test('事件：单轮激素总变化不超过 ±30', () => {
  const s = fresh();
  s.personality.sensitivity = 1;
  s.hormones.adrenaline = 10;
  E.applyEvent(s, 'scare', 1.6, 'vector', T0);
  assert.ok(s.hormones.adrenaline - 10 <= 30 + 1e-9, '实际增量 ' + (s.hormones.adrenaline - 10));
});

test('事件：恐惧强度读角色当前胆量（不是默认值）', () => {
  const brave = fresh();
  const timid = fresh();
  timid.talents['胆量'] = 0;
  E.applyEvent(brave, 'thunder', 1, 'vector', T0);
  E.applyEvent(timid, 'thunder', 1, 'vector', T0);
  assert.ok(timid.fear.v > brave.fear.v, '胆量小的人应该更怕');
  assert.strictEqual(timid.fear.why, '打雷');
});

test('事件：未知类型不抛错，返回 ok=false', () => {
  const s = fresh();
  const r = E.applyEvent(s, 'nonsense', 1, 'vector', T0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(s.events.length, 0);
});

test('事件：只保留最近 40 条', () => {
  const s = fresh();
  for (let i = 0; i < 45; i += 1) E.applyEvent(s, 'eat', 1, 'vector', T0);
  assert.strictEqual(s.events.length, 40);
});

// ---------------------------------------------------------------- 主动

test('额度：心情好 5 / 平常 3 / 低落 1，困了减一', () => {
  const happy = fresh();
  happy.hormones.dopamine = 90;
  happy.hormones.oxytocin = 80;
  happy.hormones.serotonin = 80;
  happy.hormones.cortisol = 5;
  const qHappy = E.proactiveQuota(happy, T0, {}, E.feel(happy));
  assert.strictEqual(qHappy.cap, 5);

  const low = fresh();
  low.hormones.cortisol = 90;
  low.hormones.dopamine = 5;
  low.hormones.serotonin = 10;
  const qLow = E.proactiveQuota(low, T0, {}, E.feel(low));
  assert.strictEqual(qLow.cap, 1);

  const normal = fresh();
  normal.body.sleepiness = 90;
  const qNormal = E.proactiveQuota(normal, T0, {}, E.feel(normal));
  assert.strictEqual(qNormal.cap, 2);
});

test('主动：夜间封锁', () => {
  const s = fresh();
  const r = E.rollProactive(s, at(23, 30), {}, { random: () => 0 });
  assert.strictEqual(r.blocked, 'night');
  assert.strictEqual(r.p, 0);
  assert.strictEqual(r.fired, false);
});

test('主动：冷却内不触发', () => {
  const s = fresh();
  s.lastProactiveAt = at(9, 50).toISOString(); // 10 分钟前
  const r = E.rollProactive(s, T0, { cooldownMin: 90 }, { random: () => 0 });
  assert.strictEqual(r.blocked, 'cooldown');
  assert.ok(r.cooldownLeft > 0);
});

test('主动：刚聊完不打扰', () => {
  const s = fresh();
  const r = E.rollProactive(s, T0, { quietMin: 5 }, {
    lastUserAt: at(9, 58).toISOString(),
    random: () => 0,
  });
  assert.strictEqual(r.blocked, 'quiet');
  assert.ok(r.quietLeft > 0);
});

test('主动：额度用完不再触发', () => {
  const s = fresh();
  s.today = { date: E.dateKey(T0), sent: 99 };
  const r = E.rollProactive(s, T0, {}, { random: () => 0 });
  assert.strictEqual(r.blocked, 'quota');
  assert.strictEqual(r.fired, false);
});

test('主动：weight=0 等于关闭', () => {
  const s = fresh();
  const r = E.rollProactive(s, T0, { weight: 0 }, { random: () => 0 });
  assert.strictEqual(r.p, 0);
  assert.strictEqual(r.fired, false);
});

test('主动：概率只跟实际经过时间有关，与抽签间隔无关', () => {
  const a = fresh();
  const b = fresh();
  a.lastCheckAt = at(9, 50).toISOString(); // 10 分钟前
  b.lastCheckAt = at(9, 50).toISOString();
  const ra = E.rollProactive(a, T0, { checkSeconds: 20 }, { random: () => 1 });
  const rb = E.rollProactive(b, T0, { checkSeconds: 600 }, { random: () => 1 });
  assert.strictEqual(ra.p, rb.p, `p 应一致：${ra.p} vs ${rb.p}`);
});

test('主动：小概率也能抽中（random=0）', () => {
  const s = fresh();
  const r = E.rollProactive(s, T0, { weight: 50 }, { random: () => 0 });
  assert.strictEqual(r.fired, true);
  assert.ok(r.p > 0);
});

test('markProactive：当日 sent+1 并记录时间', () => {
  const s = fresh();
  E.markProactive(s, T0);
  assert.strictEqual(s.today.sent, 1);
  assert.strictEqual(s.lastProactiveAt, T0.toISOString());
  assert.strictEqual(s.events[s.events.length - 1].kind, 'proactive');
});

test('markProactive：跨天清零', () => {
  const s = fresh();
  s.today = { date: '2026-11-13', sent: 3 };
  E.markProactive(s, T0);
  assert.strictEqual(s.today.sent, 1);
  assert.strictEqual(s.today.date, E.dateKey(T0));
});

// ---------------------------------------------------------------- 被忽略

test('被忽略：没主动发过就不判定', () => {
  const s = fresh();
  assert.strictEqual(E.applyIgnoreIfDue(s, at(10, 0, 1), {}), null);
  assert.strictEqual(s.events.length, 0);
});

test('被忽略：她开口后用户回过话，不判定', () => {
  const s = fresh();
  s.lastProactiveAt = at(9, 0, 1).toISOString();
  E.markUserMessage(s, at(9, 10, 1));
  assert.strictEqual(s.lastUserAt, at(9, 10, 1).toISOString());
  assert.strictEqual(E.applyIgnoreIfDue(s, at(23, 0, 1), {}), null);
});

test('被忽略：超过 N 小时没人理，补记一次且只记一次', () => {
  const s = fresh();
  s.lastProactiveAt = at(9, 0, 1).toISOString(); // 昨天 09:00 主动开口，之后没人说话
  const first = E.applyIgnoreIfDue(s, at(21, 0, 1), { ignoreHours: 12 });
  assert.ok(first && first.hours === 12);
  const last = s.events[s.events.length - 1];
  assert.strictEqual(last.kind, 'ignore');
  assert.strictEqual(last.src, 'time');
  assert.strictEqual(E.applyIgnoreIfDue(s, at(22, 0, 1), { ignoreHours: 12 }), null, '同一条不该重复记');
  assert.strictEqual(s.events.filter((e) => e.kind === 'ignore').length, 1);
});

test('被忽略：没到 N 小时不判定（软件关着也算，只看时间戳）', () => {
  const s = fresh();
  s.lastProactiveAt = at(9, 0, 1).toISOString();
  assert.strictEqual(E.applyIgnoreIfDue(s, at(18, 0, 1), { ignoreHours: 12 }), null);
  assert.ok(E.applyIgnoreIfDue(s, at(22, 0, 1), { ignoreHours: 12 }));
});

test('被忽略：旧档案没有 lastUserAt 也能结算', () => {
  const s = fresh();
  s.lastProactiveAt = at(9, 0, 1).toISOString();
  s.lastUserAt = null;
  assert.ok(E.applyIgnoreIfDue(s, at(11, 0, 2), { ignoreHours: 12 }));
});

// ---------------------------------------------------------------- 模板/展示

test('模板填充：已知占位符替换，未知原样保留', () => {
  const out = E.fillTemplate('情绪：{inner} / {unknown}', { inner: '开心' });
  assert.strictEqual(out, '情绪：开心 / {unknown}');
});

test('占位符：包含注入模板要用的全部字段', () => {
  const s = fresh();
  s.profile.together_since = '2026-11-01';
  const v = E.placeholders(s, T0, {});
  for (const key of ['inner', 'outer', 'valence', 'arousal', 'control', 'intensity',
    'body_line', 'relation_line', 'hormone_line', 'left', 'gap_min', 'fear']) {
    assert.ok(v[key] !== undefined, '缺字段 ' + key);
  }
  assert.strictEqual(v.daysTogether, 13);
});

test('influences：最多 4 条，永远有话说', () => {
  const s = fresh();
  const list = E.influences(s);
  assert.ok(list.length >= 1 && list.length <= 4);
  s.hormones.adrenaline = 90;
  s.hormones.cortisol = 90;
  s.hormones.dopamine = 90;
  s.hormones.oxytocin = 90;
  const many = E.influences(s);
  assert.ok(many.length <= 4, '实际 ' + many.length);
});

// ---------------------------------------------------------------- 每日上限倍率

test('上限倍率：向下取整，只作用于自动值', () => {
  const s = fresh();
  assert.strictEqual(E.proactiveQuota(s, T0, {}).cap, 3);
  const q = E.proactiveQuota(s, T0, { capMultiplier: 1.4 });
  assert.strictEqual(q.cap, 4);
  assert.ok(q.why.includes('× 1.4'), q.why);
  assert.strictEqual(E.proactiveQuota(s, T0, { capMultiplier: 2 }).cap, 6);
  // 手动上限是绝对值，不再乘倍率
  assert.strictEqual(E.proactiveQuota(s, T0, { cap: 7, capMultiplier: 2 }).cap, 7);
});

// ---------------------------------------------------------------- 汇总

console.log('');
if (failed) {
  console.log(`${passed} 通过，${failed} 失败`);
  process.exit(1);
}
console.log(`${passed} 全部通过`);
