// ============================================================================
//  Step 2 自测：归一化 + 写入管线（三层合并）
//
//  跑法：node memory/step2.test.js（在 si/app 下）
//  依赖本地已存在 models/bge-small-zh-v1.5（首次按需下载后即可跑）
// ============================================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryClient, DEFAULT_MODEL_DIR } = require('./selftest');
const {
  normalizeText,
  normalizeObject,
  normalizeRelation,
  normalizeSubject,
  normalizePolarity,
  normalizeTruth,
  factKey,
  normalizeFact,
  isMetaFact,
  registerCharacterName,
} = require('./normalize');

const MEMORY_DIR = __dirname;

function checkNormalize() {
  // 角色名不再写死在代码里：测试里模拟主进程注册当前角色名
  registerCharacterName('祀');
  const tests = [
    ['NFKC + 小写 + 去空白标点', normalizeText('ＡＢＣ　１２３。'), 'abc123'],
    ['英文同义词归一到中文', normalizeObject('COFFEE'), '咖啡'],
    ['同义词 + 标点', normalizeObject(' 咖啡。'), '咖啡'],
    ['复合写法归一', normalizeObject('冰美式咖啡'), '冰美式'],
    ['relation 中文别名', normalizeRelation('偏好'), 'preference'],
    ['relation 未知值回落 fact', normalizeRelation('不知道'), 'fact'],
    ['subject 角色别名', normalizeSubject('祀'), 'char'],
    ['polarity 布尔 false', normalizePolarity(false), 'negative'],
    ['truth 字符串数字', normalizeTruth('0.9'), 0.9],
    ['truth 非法值回落 0.7', normalizeTruth('abc'), 0.7],
  ];
  for (const [name, got, want] of tests) {
    assert.equal(got, want, `${name}：${got} != ${want}`);
  }

  const a = factKey('user', 'preference', normalizeObject('coffee'));
  const b = factKey('user', 'preference', normalizeObject('咖啡'));
  assert.equal(a, b, '同义词应生成同一个主键');
  assert.equal(a.length, 16, '主键应为 16 位哈希');

  assert.equal(
    normalizeFact({ subject: '我', relation: '喜欢', object: 'coffee', fact: '喜欢冰美式', polarity: 'positive', truth: 1, source: '我喜欢喝冰美式' })
      .key,
    a,
    'normalizeFact 的主键应与 factKey 一致',
  );
  assert.equal(normalizeFact({ fact: '' }), null, '空事实应被丢弃');

  // 系统元信息不能入库：否则下一轮检索又把它们注入回提示词，形成自我循环
  assert.equal(isMetaFact('系统提示含102条动作库'), true);
  assert.equal(isMetaFact('正在测试记忆功能'), true);
  assert.equal(isMetaFact('记忆与当前说法冲突时以当前对话为准'), true);
  assert.equal(isMetaFact('无法修改系统注入的记忆块'), true);
  assert.equal(isMetaFact('把早餐笔记改为煎饼果子加待定饮品'), true);
  assert.equal(isMetaFact('喜欢冰美式'), false, '正常偏好不能被误杀');
  assert.equal(isMetaFact('每天早餐吃煎饼果子'), false);
  assert.equal(normalizeFact({ subject: 'world', relation: 'fact', fact: '系统提示含102条动作库' }), null, '元信息事实应被丢弃');
  console.log('✔ 归一化：10 条规则 + 主键一致性 + 元信息拦截');
}

async function factsCount(client) {
  return client.call('stats');
}

async function checkPipeline(client) {
  // ------------------------------------------------ 场景 A：哈希合并 / 极性覆盖
  await client.call('reset');
  let r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: '咖啡', fact: '喜欢冰美式', polarity: 'positive', truth: 1, source: '我喜欢喝冰美式' },
    ],
    turn: 1,
  });
  assert.equal(r.inserted, 1, '第一条应新建');
  assert.equal((await factsCount(client)).memories, 1);

  // 同一三元组换个写法（coffee -> 咖啡）→ 哈希命中
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: 'coffee', fact: '喜欢喝咖啡', polarity: 'positive', truth: 1, source: '我每天早上都要喝咖啡' },
    ],
    turn: 2,
  });
  assert.equal(r.mergedHash, 1, '同义词应走哈希合并');
  assert.equal((await factsCount(client)).memories, 1, '哈希合并不应新增主键');

  // 同键反向表述 → 极性覆盖
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: '咖啡', fact: '不喜欢冰美式了', polarity: 'negative', truth: 1, source: '我以后不喝冰美式了' },
    ],
    turn: 3,
  });
  assert.equal(r.items[0].polarity, 'negative', '极性冲突时新表述应覆盖旧表述');
  assert.equal(r.items[0].fact, '不喜欢冰美式了', '新表述更完整时应替换事实');
  assert.ok(r.items[0].activation > 1, '合并应提升激活度');

  // 完全重复 → 只合并、不重复加向量
  const before = (await factsCount(client)).vectors;
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: '咖啡', fact: '不喜欢冰美式了', polarity: 'negative', truth: 1, source: '我以后不喝冰美式了' },
    ],
    turn: 4,
  });
  assert.equal(r.mergedHash, 1, '重复事实应哈希合并');
  const after = (await factsCount(client)).vectors;
  assert.ok(after <= 5, '同一主键向量上限应为 5');
  console.log(`✔ 哈希合并 / 极性覆盖（向量 ${before} → ${after}）`);

  // ------------------------------------------------ 场景 B：向量兜底合并
  await client.call('reset');
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: '咖啡', fact: '喜欢喝冰美式咖啡', polarity: 'positive', truth: 1, source: '我喜欢喝冰美式咖啡' },
    ],
    turn: 5,
  });
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'preference', object: '美式', fact: '喜欢喝冰美式', polarity: 'positive', truth: 1, source: '我喜欢喝冰美式' },
    ],
    turn: 6,
  });
  assert.equal(r.mergedVector, 1, '哈希不同但向量足够相似时应触发跨主键合并');
  assert.equal((await factsCount(client)).memories, 1, '向量合并后仍应只有一条主键');

  // ------------------------------------------------ 场景 C：数值冲突不合并
  await client.call('reset');
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'fact', object: '3杯咖啡', fact: '每天喝3杯咖啡', polarity: 'positive', truth: 1, source: '我每天喝3杯咖啡' },
    ],
    turn: 7,
  });
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'fact', object: '5杯咖啡', fact: '每天喝5杯咖啡', polarity: 'positive', truth: 1, source: '我每天喝5杯咖啡' },
    ],
    turn: 8,
  });
  assert.equal(r.inserted, 1, '数值冲突（3 杯 vs 5 杯）应新建主键');
  assert.equal((await factsCount(client)).memories, 2);

  // ------------------------------------------------ 场景 D：同批重复 / 非法事实
  await client.call('reset');
  r = await client.call('upsertFacts', {
    facts: [
      { subject: 'user', relation: 'event', object: '下雨', fact: '今天下雨了', polarity: 'positive', truth: 0.7, source: '外面在下雨' },
      { subject: 'user', relation: 'event', object: '下雨', fact: '今天下雨了', polarity: 'positive', truth: 0.7, source: '外面在下雨' },
      { subject: 'user', relation: 'event', object: '', fact: '' },
      { subject: 'world', relation: 'fact', object: '动作库', fact: '系统提示含102条动作库', polarity: 'positive', truth: 1, source: '动作库那份' },
    ],
    turn: 9,
  });
  assert.equal(r.inserted, 1, '同批重复事实只新建一次');
  assert.equal(r.mergedHash, 1, '同批重复事实第二次应合并');
  assert.equal(r.rejected, 2, '空事实 + 系统元信息应被丢弃并计入 rejected');
  assert.equal((await factsCount(client)).memories, 1);

  const list = await client.call('list', { limit: 10 });
  assert.equal(list.results[0].source_text, '外面在下雨', 'source_text 应落库');
  assert.equal(list.results[0].created_turn, 9, 'created_turn 应记录写入轮次');
  console.log('✔ 向量兜底 / 数值冲突 / 同批重复 / source_text');
}

async function main() {
  const dir = path.join(MEMORY_DIR, '.tmp', 'step2-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'memory.db');
  const client = new MemoryClient({ modelDir: DEFAULT_MODEL_DIR });
  try {
    checkNormalize();
    const init = await client.call('init', { dbPath, modelDir: DEFAULT_MODEL_DIR });
    console.log(`✔ SQLite 初始化：${init.dbPath} · schema v${init.schemaVersion}`);
    await checkPipeline(client);
    const stats = await client.call('stats');
    console.log(`✔ 全部通过 · memories=${stats.memories} vectors=${stats.vectors}`);
  } finally {
    await client.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* Windows 上 WAL 文件偶尔晚一点释放 */
    }
  }
}

main().catch((err) => {
  console.error('✖ Step 2 自测失败：' + (err && err.message ? err.message : err));
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
