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

// ---------------------------------------------------------------- 生物钟

test('生物钟：默认 06:00–22:00 是恒等映射', () => {
  for (let h = 0; h < 24; h += 1) {
    assert.ok(Math.abs(E.rhythmHour(h) - h) < 1e-9, `小时 ${h} 被偏移了`);
  }
  const r = E.normalizeRhythm();
  assert.strictEqual(r.wake, 6);
  assert.strictEqual(r.sleep, 22);
  assert.strictEqual(r.wakeLen, 16);
  assert.strictEqual(r.sleepLen, 8);
});

test('生物钟：默认分段与旧固定表一致', () => {
  const segs = E.rhythmSegments();
  assert.deepStrictEqual(segs.map((s) => s.start), [6, 9, 12, 14, 18, 22]);
  assert.deepStrictEqual(segs.map((s) => s.end), [9, 12, 14, 18, 22, 6]);
  assert.strictEqual(segs[5].sleep, true);
  assert.strictEqual(segs[5].name, '深夜');
});

test('生物钟：晚睡晚起 09:00–01:00，分段与映射一起后移', () => {
  const r = E.normalizeRhythm({ wake: 9, sleep: 1 });
  const segs = E.rhythmSegments(r);
  assert.deepStrictEqual(segs.map((s) => s.name), ['清晨', '上午', '中午', '下午', '晚上', '深夜']);
  assert.deepStrictEqual(segs.map((s) => s.start), [9, 12, 15, 17, 21, 1]);
  assert.deepStrictEqual(segs.map((s) => s.end), [12, 15, 17, 21, 1, 9]);
  assert.ok(Math.abs(E.rhythmHour(9, r) - 6) < 1e-9, '起床对应标准清晨');
  assert.ok(Math.abs(E.rhythmHour(1, r) - 22) < 1e-9, '入睡对应标准入夜');
  assert.ok(Math.abs(E.rhythmHour(17, r) - 14) < 1e-9, '下午中段仍对齐');
});

test('生物钟：清醒时长夹在 8~20 小时', () => {
  const short = E.normalizeRhythm({ wake: 20, sleep: 22 });
  assert.strictEqual(short.wakeLen, 8);
  assert.strictEqual(short.sleep, 4);
  const long = E.normalizeRhythm({ wake: 0, sleep: 23 });
  assert.strictEqual(long.wakeLen, 20);
  assert.strictEqual(long.sleep, 20);
});

test('褪黑素：钟点目标支持小数插值', () => {
  assert.strictEqual(E.melatoninTarget(22), 66);
  assert.ok(Math.abs(E.melatoninTarget(22.5) - 72) < 1e-9, '实际 ' + E.melatoninTarget(22.5));
});

test('生物钟：tick 按映射后的钟点算褪黑素', () => {
  const night = { wake: 9, sleep: 1 };
  const late = fresh();
  late.hormones.melatonin = 12;
  late.updated = at(1, 0).toISOString();
  E.tick(late, at(7, 0), night);

  const normal = fresh();
  normal.hormones.melatonin = 12;
  normal.updated = at(1, 0).toISOString();
  E.tick(normal, at(7, 0));

  assert.ok(late.hormones.melatonin > 60, '9 点起床的人 7 点还在睡：' + late.hormones.melatonin);
  assert.ok(normal.hormones.melatonin < 20, '默认作息 7 点该清醒：' + normal.hormones.melatonin);
});

test('生物钟：改作息后困意与褪黑素按新钟点重新起算', () => {
  const s = fresh();
  s.body.sleepiness = 94;
  s.hormones.melatonin = 80;
  // 18:00 起床 / 14:00 入睡：真实 23:56 落在清醒段，虚拟钟点约 10:45
  E.rebaseRhythm(s, at(23, 56), { wake: 18, sleep: 14 });
  assert.ok(s.body.sleepiness < 40, '应该回到白天水平，实际 ' + s.body.sleepiness);
  assert.ok(s.hormones.melatonin < 20, '褪黑素应该落到低位，实际 ' + s.hormones.melatonin);

  const n = fresh();
  n.body.sleepiness = 10;
  E.rebaseRhythm(n, at(2, 0), { wake: 6, sleep: 22 });
  assert.ok(n.body.sleepiness > 70, '默认作息的凌晨该困，实际 ' + n.body.sleepiness);
});

test('生物钟：状态标签按困意分档（睡眠段不再特殊）', () => {
  const s = fresh();
  // 默认 06:00 起床 / 22:00 入睡
  s.body.sleepiness = 72;
  assert.strictEqual(E.stateTag(s, at(22, 59), undefined), '比较困');
  s.body.sleepiness = 85;
  assert.strictEqual(E.stateTag(s, at(2, 0), undefined), '很困');
  assert.strictEqual(E.stateTag(s, at(6, 20), undefined), '刚睡醒');
  s.body.sleepiness = 30;
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined), '清醒');
  s.body.sleepiness = 55;
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined), '有点困');
  s.body.sleepiness = 70;
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined), '比较困');
  s.body.sleepiness = 85;
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined), '很困');
  // 换作息后只看起床时间：18:00 起床 / 14:00 入睡，真实 14:30 已过起床 40 分钟
  assert.strictEqual(E.stateTag(s, at(14, 30), { wake: 18, sleep: 14 }), '很困');
  assert.strictEqual(E.stateTag(s, at(18, 20), { wake: 18, sleep: 14 }), '刚睡醒');
});

test('生物钟：状态标签映射表可改阈值与文案', () => {
  const s = fresh();
  s.body.sleepiness = 55;
  const tiers = [
    { min: 90, label: '快睡着了' },
    { min: 50, label: '犯困' },
    { min: 0, label: '精神' },
  ];
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined, tiers), '犯困');
  s.body.sleepiness = 95;
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined, tiers), '快睡着了');
  s.body.sleepiness = 20;
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined, tiers), '精神');
  // 低于最低阈值也归到最后一档；空表 / 坏表回落到默认
  s.body.sleepiness = 0;
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined, [{ min: 60, label: '困' }]), '困');
  assert.strictEqual(E.stateTag(s, at(10, 0), undefined, []), '清醒');
  assert.deepStrictEqual(E.normalizeTiers(undefined).map((t) => t.label), ['很困', '比较困', '有点困', '清醒']);
});


test('生物钟：{phase} 仍按真实钟点', () => {
  assert.strictEqual(E.phase(7), '清晨');
  assert.strictEqual(E.phase(23), '半夜');
});

// ---------------------------------------------------------------- 雷达

test('雷达：先验越小，单条回复推动越大', () => {
  const base = E.defaultState(T0).personality;
  const stats = { replies: 1, intimate: 1, cold: 0, questions: 0, tsundere: 0, valenceSum: 60, valenceSqSum: 3600 };
  const loose = E.deriveTraits(stats, base, 1);
  const tight = E.deriveTraits(stats, base, 100);
  assert.ok(loose.warmth > tight.warmth, '先验 1 应比 100 推得多：' + loose.warmth + ' vs ' + tight.warmth);
  // 先验 1、1 条亲密：温暖 = (0.55*1 + 1) / 2
  assert.ok(Math.abs(loose.warmth - 0.775) < 1e-9, '先验 1 的温暖应是 0.775，实际 ' + loose.warmth);
  // 省略 span 时按默认 20 走
  const dft = E.deriveTraits(stats, base);
  assert.ok(Math.abs(dft.warmth - (0.55 * 20 + 1) / 21) < 1e-9, '默认先验 20 的温暖不对：' + dft.warmth);
});

test('雷达：没有统计时就是角色底色', () => {
  const base = E.defaultState(T0).personality;
  const t = E.deriveTraits({ replies: 0 }, base, 20);
  assert.strictEqual(t.warmth, base.warmth);
  assert.strictEqual(t.stubbornness, base.stubbornness);
});

// ---------------------------------------------------------------- 性格自适应

test('性格自适应：rate 为 0 时不动底色', () => {
  const s = E.defaultState(T0);
  const before = { ...s.personality };
  E.adaptPersonality(s, '哼', ['praise'], 80, 0);
  assert.deepStrictEqual(s.personality, before);
});

test('性格自适应：好话让温暖升、敏感降，坏话反过来', () => {
  const warm = E.defaultState(T0);
  E.adaptPersonality(warm, '', ['praise'], 70, 0.02);
  assert.ok(warm.personality.warmth > 0.55, '温暖应上升：' + warm.personality.warmth);
  assert.ok(warm.personality.sensitivity < 0.55, '敏感应下降：' + warm.personality.sensitivity);

  const cold = E.defaultState(T0);
  E.adaptPersonality(cold, '', ['cold'], 30, 0.02);
  assert.ok(cold.personality.sensitivity > 0.55, '敏感应上升：' + cold.personality.sensitivity);
  assert.ok(cold.personality.warmth < 0.55, '温暖应下降：' + cold.personality.warmth);
});

test('性格自适应：傲娇句式推倔强，愉悦度推乐观，开放度不动', () => {
  const s = E.defaultState(T0);
  E.adaptPersonality(s, '哼，才不想理你呢', ['tease'], 60, 0.02);
  assert.ok(s.personality.stubbornness > 0.55, '倔强应上升：' + s.personality.stubbornness);
  assert.ok(s.personality.optimism > 0.55, '乐观应上升：' + s.personality.optimism);
  assert.strictEqual(s.personality.openness, 0.55);
});

test('性格自适应：多次累积后夹在 0.35~0.8', () => {
  const s = E.defaultState(T0);
  for (let i = 0; i < 500; i += 1) E.adaptPersonality(s, '', ['praise'], 95, 0.02);
  assert.strictEqual(s.personality.warmth, 0.8);
  assert.strictEqual(s.personality.optimism, 0.8);
  for (let i = 0; i < 2000; i += 1) E.adaptPersonality(s, '', ['cold'], 5, 0.02);
  assert.ok(Math.abs(s.personality.warmth - 0.45) < 1e-6, '温暖应落到 0.45：' + s.personality.warmth);
  assert.strictEqual(s.personality.sensitivity, 0.8);
  assert.strictEqual(s.personality.optimism, 0.35);
});

// ---------------------------------------------------------------- 汇总

console.log('');
if (failed) {
  console.log(`${passed} 通过，${failed} 失败`);
  process.exit(1);
}
console.log(`${passed} 全部通过`);
