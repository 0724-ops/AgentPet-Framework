// ============================================================================
//  Step 3 自测：读取管线（纯函数打分 + Worker 双路召回）
//  跑法：node memory/step3.test.js（在 si/app 下；需要本地 embedding 模型）
// ============================================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryClient, DEFAULT_MODEL_DIR } = require('./selftest');
const {
  DEFAULTS,
  activationFactor,
  keywordTerms,
  scoreMemory,
  selectMemories,
  formatMemoryBlock,
} = require('./retrieve');

function checkRanking() {
  const base = { key: 'a', fact: '喜欢冰美式', relation: 'preference', similarity: 0.6, truth: 1, activation: 1 };
  assert.ok(activationFactor(1) > activationFactor(0.2), '激活度越高权重越大');
  assert.equal(activationFactor(0), DEFAULTS.activationFloor, '激活度 0 用地板值');

  const high = scoreMemory(base);
  const lowTruth = scoreMemory({ ...base, key: 'b', truth: 0.4 });
  const lowAct = scoreMemory({ ...base, key: 'c', activation: 0.1 });
  const constraint = scoreMemory({ ...base, key: 'd', relation: 'constraint' });
  assert.ok(high > lowTruth, 'truth 越高分越高');
  assert.ok(high > lowAct, 'activation 越低分越低');
  assert.ok(constraint > high, 'constraint 权重更高');

  const ranked = selectMemories(
    [
      { ...base, key: 'p1', similarity: 0.5 },
      { ...base, key: 'p2', similarity: 0.8, fact: '喜欢喝拿铁' },
      { ...base, key: 'p3', similarity: 0.4, truth: 0.4, fact: '喜欢喝茶' },
      { ...base, key: 'v1', relation: 'constraint', similarity: 0.46, fact: '不要香菜' },
      { ...base, key: 'v2', relation: 'constraint', similarity: 0.9, fact: '不提那件事' },
    ],
    { thetaSim: 0.45, maxInject: 2 }
  );
  assert.equal(ranked.items.length, 4, '2 条 VIP + 2 条普通（0.4 的低于阈值被丢）');
  assert.equal(ranked.items[0].id, 'M1');
  assert.equal(ranked.items[0].fact, '不提那件事', 'VIP 先按相似度排序');
  assert.ok(ranked.items.slice(0, 2).every((m) => m.vip), 'VIP 全部前置');
  assert.ok(ranked.items.every((m) => m.similarity >= 0.45), '低于 θ_sim 的不注入');
  assert.equal(ranked.dropped.belowTheta, 1);

  // 同一主键多个向量命中 → 只保留相似度最高的
  const deduped = selectMemories(
    [
      { ...base, key: 'same', similarity: 0.5 },
      { ...base, key: 'same', similarity: 0.7 },
    ],
    { thetaSim: 0.45 }
  );
  assert.equal(deduped.items.length, 1);
  assert.equal(deduped.items[0].similarity, 0.7);

  // 主键不同、fact 文本完全一样（旧库同义 object 遗留）→ 只保留一条
  const sameFact = selectMemories(
    [
      { ...base, key: 'd1', similarity: 0.5, activation: 1 },
      { ...base, key: 'd2', similarity: 0.7, activation: 1.6 },
    ],
    { thetaSim: 0.45 }
  );
  assert.equal(sameFact.items.length, 1, '同 fact 文本应合并为一条');
  assert.equal(sameFact.items[0].key, 'd2', '保留激活度更高的一条');
  assert.equal(sameFact.dropped.duplicate, 1, '重复条目应计入 dropped.duplicate');

  // 字数额度：普通记忆装不下就跳过，VIP 不受影响
  const budget = selectMemories(
    [
      { ...base, key: 'v', relation: 'constraint', similarity: 0.6, fact: '不要香菜' },
      { ...base, key: 'n1', similarity: 0.7, fact: '这是一条很长很长的普通记忆内容' },
      { ...base, key: 'n2', similarity: 0.6, fact: '短句' },
    ],
    { thetaSim: 0.45, maxInject: 2, maxChars: 12 }
  );
  assert.deepEqual(
    budget.items.map((m) => m.fact),
    ['不要香菜', '短句'],
    'VIP 保底，普通按字数筛选'
  );

  // 模板由用户维护：没有模板时只输出数据行，有模板时替换 {{MEMORIES}}
  const block = formatMemoryBlock(budget.items, '【长期记忆】\n{{MEMORIES}}\nMEM_MARK');
  assert.ok(block.includes('【长期记忆】'));
  assert.ok(block.includes('[M1] 不要香菜'));
  assert.ok(block.includes('MEM_MARK'));
  assert.ok(!formatMemoryBlock(budget.items).includes('【长期记忆】'), '无模板时不补说明');
  assert.equal(formatMemoryBlock([]), '');

  const terms = keywordTerms('我想喝冰美式，咖啡也行');
  assert.ok(terms.includes('冰美式'), '3 字窗口应包含 冰美式');
  assert.ok(terms.includes('咖啡'), '2 字词应保留给 LIKE');

  // 系统元信息即使已在旧库里也不注入；char / world 的 constraint 不走 VIP
  const meta = selectMemories(
    [
      { ...base, key: 'm1', subject: 'world', relation: 'fact', similarity: 0.9, fact: '系统提示含102条动作库' },
      { ...base, key: 'm2', similarity: 0.6, fact: '喜欢冰美式' },
    ],
    { thetaSim: 0.45 }
  );
  assert.equal(meta.items.length, 1, '元信息事实应被过滤');
  assert.equal(meta.items[0].fact, '喜欢冰美式');
  assert.equal(meta.dropped.meta, 1);

  const subjectVip = selectMemories(
    [
      { ...base, key: 'c1', subject: 'char', relation: 'constraint', similarity: 0.7, fact: '祀不能离开屏幕' },
      { ...base, key: 'c2', subject: 'user', relation: 'constraint', similarity: 0.5, fact: '不要香菜' },
    ],
    { thetaSim: 0.45, maxInject: 0 }
  );
  assert.equal(subjectVip.items.length, 1, '只有用户的 constraint 能占 VIP 名额');
  assert.equal(subjectVip.items[0].fact, '不要香菜');
  assert.ok(subjectVip.items[0].vip);

  console.log('✔ 打分 / VIP / 去重 / 字数截断 / 关键词 / Prompt 拼装 / 元信息过滤');
}

async function checkRetrieve(client) {
  await client.call('reset');
  const up = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: '咖啡', fact: '喜欢冰美式', polarity: 'positive', truth: 1, source: '我喜欢喝冰美式' },
      { subject: 'user', relation: 'constraint', object: '香菜', fact: '不要香菜', polarity: 'negative', truth: 1, source: '我不要香菜' },
      { subject: 'user', relation: 'promise', object: '冰美式', fact: '祀答应端冰美式', polarity: 'positive', truth: 0.7, source: '我这就去给你做' },
      { subject: 'user', relation: 'event', object: '下雨', fact: '昨天下雨了', polarity: 'positive', truth: 0.7, source: '昨天下了很大的雨' },
    ],
    turn: 3,
  });
  assert.equal(up.inserted, 4);

  // 系统元信息在写入侧就该被丢弃，不该进库
  const junk = await client.call('upsertFacts', {
    facts: [
      { subject: 'world', relation: 'fact', object: '动作库', fact: '系统提示含102条动作库', polarity: 'positive', truth: 1, source: '动作库那份' },
    ],
  });
  assert.equal(junk.inserted, 0, '元信息不应入库');
  assert.equal(junk.rejected, 1);

  // 同一句话、不同的 object 归一化 → 写入侧按 fact 文本合并，不再产生第二条
  const dup = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: '煎饼果子', fact: '每天早餐吃煎饼果子', polarity: 'positive', truth: 1 },
      { subject: 'user', relation: 'preference', object: '早餐', fact: '每天早餐吃煎饼果子', polarity: 'positive', truth: 1 },
    ],
    turn: 4,
  });
  assert.equal(dup.inserted, 1, '同 fact 文本只建一条');
  assert.equal(dup.mergedExact, 1, '第二条应走 fact 文本精确合并');
  const dedupe = await client.call('dedupe');
  assert.equal(dedupe.merged, 0, '写入侧已去重，整理命令无需再合并');

  // 语义召回：问喝什么 → 命中偏好
  let r = await client.call('retrieve', { query: '我喜欢喝什么', thetaSim: 0.45 });
  assert.ok(r.items.length >= 1, '应该有召回');
  assert.ok(r.items.some((m) => m.fact === '喜欢冰美式'), '应命中冰美式偏好');
  assert.ok(r.block.includes('[M1]'));

  // 关键词 + VIP：香菜是 constraint，即使 maxInject=1 也强制注入
  r = await client.call('retrieve', { query: '香菜', thetaSim: 0.45, maxInject: 1 });
  const veg = r.items.find((m) => m.fact === '不要香菜');
  assert.ok(veg, '2 字关键词应能召回');
  assert.ok(veg.vip, 'constraint 应走 VIP 通道');
  assert.ok(r.keywordTerms.includes('香菜'));

  // 无关输入：低于阈值，不注入
  r = await client.call('retrieve', { query: '我的显卡是4090', thetaSim: 0.45 });
  assert.equal(r.items.length, 0, '无关输入不应注入');
  assert.ok(r.dropped.belowTheta >= 1);

  // 置顶：把下雨事件 pinned 后，查询它应走 VIP
  const list = await client.call('list', { limit: 10 });
  const rain = list.results.find((m) => m.fact === '昨天下雨了');
  assert.ok(rain);
  await client.call('upsert', { memory: { ...rain, pinned: 1 } });
  r = await client.call('retrieve', { query: '昨天天气怎么样', thetaSim: 0.45, maxInject: 1 });
  const pinned = r.items.find((m) => m.fact === '昨天下雨了');
  assert.ok(pinned, 'pinned 记忆应召回');
  assert.ok(pinned.vip, 'pinned 应走 VIP 通道');

  assert.equal(new Set(r.items.map((m) => m.key)).size, r.items.length, '按主键去重');

  // 模拟旧库遗留：同 fact 文本、不同主键 + 各自向量，整理后只留一条
  const legacy = {
    subject: 'user',
    relation: 'preference',
    fact: '每天早餐吃煎饼果子',
    polarity: 'positive',
    layer: 'hot',
    created_turn: 1,
    last_update_turn: 1,
  };
  await client.call('upsert', {
    memory: { ...legacy, key: 'legacy-a', object_norm: '煎饼果子', truth: 0.8, activation: 1.0, source_text: '甲' },
  });
  await client.call('upsert', {
    memory: { ...legacy, key: 'legacy-b', object_norm: '早餐', truth: 0.9, activation: 0.7, source_text: '乙' },
  });
  const emb = await client.call('embed', { texts: ['每天早餐吃煎饼果子'] });
  await client.call('addVector', { key: 'legacy-b', vector: emb.vectors[0] });
  const mergedLegacy = await client.call('dedupe');
  assert.ok(mergedLegacy.merged >= 1, '旧库重复应被合并');
  const after = await client.call('list', { limit: 50 });
  const crumbs = after.results.filter((m) => m.fact === '每天早餐吃煎饼果子');
  assert.equal(crumbs.length, 1, '同 fact 文本只保留一条');
  assert.ok(Number(crumbs[0].activation) > 1, '激活度按合并累加');
  console.log(
    `✔ 双路召回 / 阈值过滤 / VIP / pinned（召回 ${r.vectorHits} 向量 + ${r.textHits} 关键词，${Math.round(r.embedMs)}ms）`
  );
}

async function main() {
  const dir = path.join(__dirname, '.tmp', 'step3-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const client = new MemoryClient({ modelDir: DEFAULT_MODEL_DIR });
  try {
    checkRanking();
    await client.call('init', { dbPath: path.join(dir, 'memory.db'), modelDir: DEFAULT_MODEL_DIR });
    await checkRetrieve(client);
    console.log('✔ Step 3 全部通过');
  } finally {
    await client.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* Windows WAL 偶尔晚一点释放 */
    }
  }
}

main().catch((err) => {
  console.error('✖ Step 3 自测失败：' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
