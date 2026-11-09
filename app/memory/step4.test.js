// ============================================================================
//  Step 4 自测：MEM_MARK 解析/清理、激活度结算、幂律衰减、分层与挂起删除
//
//  跑法：npm run memory:selftest:step4
//  纯函数部分不需要向量模型；Worker 集成只测 settle，也不加载模型。
// ============================================================================

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { settleMemory, decayRatio, layerFor } = require('./lifecycle');
const { MemoryClient } = require('./selftest');

const DIR = __dirname;

function baseRow(over = {}) {
  return {
    key: 'k1',
    subject: 'user',
    relation: 'preference',
    truth: 1,
    activation: 1,
    pinned: 0,
    layer: 'hot',
    created_turn: 1,
    last_update_turn: 1,
    last_hit_turn: 0,
    hit_count: 0,
    miss_count: 0,
    delete_streak: 0,
    ...over,
  };
}

function checkLifecycle() {
  const accepted = settleMemory(baseRow(), {
    turn: 1,
    injected: new Set(['k1']),
    wrong: new Set(),
    candidates: new Set(['k1']),
  });
  assert.ok(accepted.activation > 1, '注入且未标记应加激活度');
  assert.equal(accepted.last_hit_turn, 1, '命中轮次应更新');
  assert.equal(accepted.hit_count, 1);
  assert.equal(accepted.layer, 'hot');

  const penalized = settleMemory(baseRow(), {
    turn: 1,
    injected: new Set(['k1']),
    wrong: new Set(['k1']),
  });
  assert.ok(penalized.activation < 1, '被标记 wrong 应扣激活度');
  assert.equal(penalized.miss_count, 1);
  assert.equal(penalized.last_hit_turn, 0, '被标记不当成命中');

  const half = settleMemory(baseRow(), { turn: 1, candidates: new Set(['k1']) });
  const full = settleMemory(baseRow(), { turn: 1, candidates: new Set() });
  assert.ok(half.activation > full.activation, '检索到但未注入应衰减减半');
  assert.ok(full.activation < 1, '未进候选应正常衰减');

  const constraint = settleMemory(baseRow({ relation: 'constraint' }), { turn: 20 });
  assert.equal(constraint.activation, 1, '约束不衰减');
  assert.equal(constraint.layer, 'hot');

  const pinned = settleMemory(baseRow({ pinned: 1 }), { turn: 20 });
  assert.equal(pinned.activation, 1, 'pinned 不衰减');

  const boostedPinned = settleMemory(baseRow({ pinned: 1 }), { turn: 3, injected: new Set(['k1']) });
  assert.ok(boostedPinned.activation > 1, 'pinned 注入仍可累计激活度');

  // 冷层：低置信 + 活跃度低，连续满足 deleteTurns 才真删
  const coldBase = { truth: 0.4, activation: 0.14 };
  const first = settleMemory(baseRow(coldBase), { turn: 1, policy: { deleteTurns: 3 } });
  assert.equal(first.layer, 'cold');
  assert.equal(first.delete_streak, 1);
  const second = settleMemory(baseRow({ ...coldBase, delete_streak: 1 }), {
    turn: 2,
    policy: { deleteTurns: 3 },
  });
  assert.equal(second.delete_streak, 2);
  const third = settleMemory(baseRow({ ...coldBase, delete_streak: 2 }), {
    turn: 3,
    policy: { deleteTurns: 3 },
  });
  assert.equal(third.deleted, true, '连续满足删除条件后应真删');
  const revived = settleMemory(baseRow({ ...coldBase, delete_streak: 5 }), {
    turn: 4,
    injected: new Set(['k1']),
    policy: { deleteTurns: 3 },
  });
  assert.equal(revived.delete_streak, 0, '重新被采纳应清空挂起删除计数');

  // 分层阈值
  assert.equal(layerFor(0.5, { relation: 'fact' }), 'hot');
  assert.equal(layerFor(0.4, { relation: 'fact' }), 'warm');
  assert.equal(layerFor(0.1, { relation: 'fact' }), 'cold');
  assert.equal(layerFor(0.1, { relation: 'constraint' }), 'hot');
  assert.equal(layerFor(0.1, { relation: 'fact', pinned: true }), 'hot');

  // 幂律连乘应等于 (1 + turns)^(-d)
  let product = 1;
  for (let t = 0; t < 5; t += 1) product *= decayRatio('fact', t);
  assert.ok(Math.abs(product - Math.pow(6, -0.5)) < 1e-9, '连乘结果应严格贴合幂律公式');

  // Step 5：衰减强度倍率乘到 d 上；约束仍然不衰减
  const scaled = decayRatio('fact', 0, false, 2);
  assert.ok(Math.abs(scaled - decayRatio('fact', 0) ** 2) < 1e-9, '衰减强度倍率应乘到 d 上');
  assert.equal(decayRatio('constraint', 5, false, 3), 1, '约束即使放大倍率也不衰减');

  // Step 5：结算参数可逐项覆盖（boost / 分层阈值）
  const customBoost = settleMemory(baseRow(), {
    turn: 1,
    injected: new Set(['k1']),
    policy: { boost: 1 },
  });
  assert.equal(customBoost.activation, 2, 'boost 参数应能覆盖默认值');
  const customLayer = settleMemory(baseRow({ activation: 0.5 }), {
    turn: 1,
    policy: { thetaWarm: 0.6, thetaCold: 0.2 },
  });
  assert.equal(customLayer.layer, 'warm', '温层阈值应能覆盖默认值');

  console.log('✔ MEM_MARK 结算规则 / 幂律衰减 / 分层 / 挂起删除');
}

async function checkParser() {
  const mod = await import(pathToFileURL(path.join(DIR, '..', 'renderer', 'pseudo-tools.js')).href);
  assert.deepEqual(mod.parseMemMarks('wrong=M1,M2'), ['M1', 'M2']);
  assert.deepEqual(mod.parseMemMarks('wrong: M1、M2'), ['M1', 'M2']);
  assert.deepEqual(mod.parseMemMarks('wrong = [m1 m2]'), ['M1', 'M2']);
  assert.deepEqual(mod.parseMemMarks('nothing here'), []);

  const parser = mod.createPseudoToolParser({});
  parser.feed('<<<MEM_MARK wrong=M1,M2>>>');
  parser.feed('你好');
  const out = parser.flush();
  assert.equal(out.text, '你好', 'MEM_MARK 标记必须从正文里清理干净');
  assert.deepEqual(out.marks, ['M1', 'M2']);
  console.log('✔ MEM_MARK 宽松解析 / 流式清理');
}

async function checkWorker() {
  const dir = path.join(DIR, '.tmp', 'step4-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const client = new MemoryClient();
  try {
    await client.call('init', { dbPath: path.join(dir, 'memory.db') });

    const seed = async (key, extra = {}) => {
      await client.call('upsert', {
        memory: {
          key,
          subject: 'user',
          relation: 'preference',
          object_norm: key,
          fact: `记忆 ${key}`,
          polarity: 'positive',
          truth: 1,
          activation: 1,
          pinned: 0,
          layer: 'hot',
          created_turn: 1,
          last_update_turn: 1,
          ...extra,
        },
      });
    };
    await seed('hit');
    await seed('skip', { relation: 'fact' });
    await seed('never', { relation: 'event', activation: 1 });
    await seed('wrong');
    await seed('constraint', { relation: 'constraint' });
    await seed('pinned', { pinned: 1 });
    await seed('dim', { relation: 'fact', activation: 0.5 });

    const first = await client.call('settle', {
      injectedKeys: ['hit'],
      wrongKeys: ['wrong'],
      candidateKeys: ['skip'],
    });
    assert.equal(first.turn, 1);
    assert.equal(first.boosted, 1);
    assert.equal(first.penalized, 1);
    assert.ok(first.deleted >= 0);

    let rows = {};
    for (const row of (await client.call('list', { limit: 100 })).results) rows[row.key] = row;
    assert.ok(rows.hit.activation > 1, '注入且未标记应加激活度');
    assert.equal(rows.hit.last_hit_turn, 1);
    assert.equal(rows.hit.hit_count, 1);
    assert.equal(rows.wrong.miss_count, 1);
    assert.ok(rows.wrong.activation < 1, '被标记应扣激活度');
    assert.ok(rows.skip.activation > rows.never.activation, '候选未注入应比未进候选衰减更慢');
    assert.equal(rows.constraint.activation, 1, '约束不衰减');
    assert.equal(rows.pinned.activation, 1, 'pinned 不衰减');
    assert.equal(rows.dim.layer, 'warm', '激活度跌破温层阈值应进温层');

    // 第二轮回放：没有新注入，应有衰减计数
    const second = await client.call('settle', { injectedKeys: [], wrongKeys: [] });
    assert.equal(second.turn, 2);
    assert.equal(second.boosted, 0);
    assert.ok(second.decayed > 0);

    // 低置信冷记忆：连续满足 deleteTurns 后真删
    await seed('junk', { relation: 'fact', truth: 0.4, activation: 0.1 });
    await client.call('settle', { injectedKeys: [], deleteTurns: 3, thetaCold: 0.2 });
    const held = (await client.call('list', { limit: 100 })).results.find((r) => r.key === 'junk');
    assert.ok(held, '第一次满足删除条件只挂起');
    assert.equal(held.delete_streak, 1, '挂起计数应为 1');
    await client.call('settle', { injectedKeys: [], deleteTurns: 3, thetaCold: 0.2 });
    const heldAgain = (await client.call('list', { limit: 100 })).results.find((r) => r.key === 'junk');
    assert.ok(heldAgain && heldAgain.delete_streak === 2, '第二轮仍在挂起');
    const coldRun = await client.call('settle', { injectedKeys: [], deleteTurns: 3, thetaCold: 0.2 });
    assert.ok(coldRun.deleted >= 1, '挂起满 deleteTurns 后应真删');
    const after = (await client.call('list', { limit: 100 })).results.some((r) => r.key === 'junk');
    assert.equal(after, false, '真删后条目不应再存在');

    // 上轮 settle 已清空 lastCandidateKeys，默认按「未进候选」衰减
    const last = await client.call('settle', {});
    assert.equal(last.turn, 6);

    console.log('✔ Worker settle：采纳 / 纠错 / 半衰减 / 分层 / 挂起删除');
  } finally {
    await client.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* Windows 上 WAL 偶尔晚释放，忽略 */
    }
  }
}

(async () => {
  checkLifecycle();
  await checkParser();
  await checkWorker();
  console.log('✔ Step 4 全部通过');
})().catch((err) => {
  console.error('✖ Step 4 自测失败：' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
