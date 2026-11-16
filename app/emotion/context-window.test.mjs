// 情绪化上下文（窗口规划 + 情绪挑选）单测：node --test app/emotion/context-window.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./context-window.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { planContextWindow, planHistoryWindow, pickTurnsByMood, MIN_CONTEXT_TURNS } = mod;

test('窗口规划：100 轮、满权重 → 100 / 连续 65 / 补齐 35', () => {
  assert.deepEqual(planContextWindow(100, 1), { total: 100, keep: 65, fill: 35 });
});

test('窗口规划：100 轮、平常压力 → 80 / 连续 52 / 补齐 28', () => {
  assert.deepEqual(planContextWindow(100, 0.8), { total: 80, keep: 52, fill: 28 });
});

test('窗口规划：98 轮、敏感 0.98 → 96 / 连续 63 / 补齐 33', () => {
  assert.deepEqual(planContextWindow(98, 0.98), { total: 96, keep: 63, fill: 33 });
});

test('窗口规划：权重再高也不超过用户设定', () => {
  assert.equal(planContextWindow(60, 1.5).total, 60);
  assert.equal(planContextWindow(60, 999).total, 60);
});

test('窗口规划：小窗口至少保留 1 轮连续段', () => {
  assert.deepEqual(planContextWindow(1, 0.8), { total: 1, keep: 1, fill: 0 });
  assert.deepEqual(planContextWindow(2, 0.8), { total: 2, keep: 2, fill: 0 });
  assert.deepEqual(planContextWindow(0, 1), { total: 0, keep: 0, fill: 0 });
});

test('窗口规划：可用轮次不足上限时按实际轮次实时计算', () => {
  assert.deepEqual(planContextWindow(100, 0.8, 0.35, 60), { total: 60, keep: 39, fill: 21 });
  assert.deepEqual(planContextWindow(100, 0.8, 0.35, 10), { total: 10, keep: 7, fill: 3 });
});

test('窗口规划：可用 0 轮时返回空，不硬凑 1 轮', () => {
  assert.deepEqual(planContextWindow(100, 0.8, 0.35, 0), { total: 0, keep: 0, fill: 0 });
});

test('少于 25 轮不启用拆分', () => {
  assert.equal(MIN_CONTEXT_TURNS, 25);
});

test('真实轮次：上限 60、只有 30 轮 → 按 30 × 0.84 算', () => {
  // base=30 → total=25, fill=8, keep=17
  assert.deepEqual(planHistoryWindow(60, 0.84, 30), { total: 25, keep: 17, fill: 8 });
});

test('真实轮次：MAX（100）不设上限，200 轮 × 0.84 → 168', () => {
  assert.deepEqual(planHistoryWindow(100, 0.84, 200), { total: 168, keep: 110, fill: 58 });
});

test('真实轮次：非 MAX 先按上限截断，再乘权重', () => {
  assert.deepEqual(planHistoryWindow(60, 0.84, 200), { total: 50, keep: 33, fill: 17 });
});

test('真实轮次：权重压满时等于全量，不产生补齐', () => {
  assert.deepEqual(planHistoryWindow(100, 1, 200), { total: 200, keep: 130, fill: 70 });
  assert.deepEqual(planHistoryWindow(60, 1, 60), { total: 60, keep: 39, fill: 21 });
});

test('真实轮次：没有对话时返回空', () => {
  assert.deepEqual(planHistoryWindow(60, 0.84, 0), { total: 0, keep: 0, fill: 0 });
  assert.deepEqual(planHistoryWindow(0, 0.84, 30), { total: 0, keep: 0, fill: 0 });
});

function turn(seq, hoursAgo, valence, intensity = 0.5) {
  const ts = Date.now() - hoursAgo * 3600 * 1000;
  return {
    seq,
    msgs: [
      { role: 'user', text: `u${seq}`, ts },
      { role: 'ai', text: `a${seq}`, ts, mood: { kind: 'praise', text: '', intensity, valence } },
    ],
  };
}

test('情绪挑选：优先挑和当前情绪接近的旧对话', () => {
  const turns = [turn(1, 2, 90), turn(2, 2, 10), turn(3, 2, 88)];
  const picked = pickTurnsByMood(turns, 2, 85, Date.now());
  assert.deepEqual(picked.map((t) => t.seq), [1, 3]);
});

test('情绪挑选：结果按时间升序返回', () => {
  const turns = [turn(1, 6, 10), turn(2, 5, 90), turn(3, 4, 80)];
  const picked = pickTurnsByMood(turns, 3, 85, Date.now());
  assert.deepEqual(picked.map((t) => t.seq), [1, 2, 3]);
});

test('情绪挑选：同样情绪时，越近的越优先', () => {
  const turns = [turn(1, 240, 80), turn(2, 1, 80)];
  const picked = pickTurnsByMood(turns, 1, 80, Date.now());
  assert.deepEqual(picked.map((t) => t.seq), [2]);
});

test('情绪挑选：老消息没有情绪标签也能被挑中', () => {
  const turns = [
    { seq: 1, msgs: [{ role: 'user', text: 'u1', ts: Date.now() - 86400000 }] },
    { seq: 2, msgs: [{ role: 'user', text: 'u2', ts: Date.now() - 86400000 }] },
  ];
  assert.equal(pickTurnsByMood(turns, 1, 50, Date.now()).length, 1);
});

test('情绪挑选：count 为 0 或输入为空时返回空', () => {
  assert.deepEqual(pickTurnsByMood([turn(1, 1, 50)], 0, 50, Date.now()), []);
  assert.deepEqual(pickTurnsByMood([], 3, 50, Date.now()), []);
  assert.deepEqual(pickTurnsByMood(null, 3, 50, Date.now()), []);
});
