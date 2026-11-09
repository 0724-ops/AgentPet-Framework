// ============================================================================
//  Step 1 基础设施自测（不碰 Electron UI）
//
//  跑法：
//    node memory/selftest.js
//    node_modules/electron/dist/electron.exe memory/electron-selftest.js
//
//  覆盖：Worker 启动、SQLite 建表/Upsert/FTS、bge-small 加载与推理、
//        向量检索、BM25 检索、清空重置。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('worker_threads');

const MEMORY_DIR = __dirname;
const DEFAULT_MODEL_DIR = path.resolve(MEMORY_DIR, '..', '..', 'models', 'bge-small-zh-v1.5');

class MemoryClient {
  constructor({ modelDir } = {}) {
    this.worker = new Worker(path.join(MEMORY_DIR, 'worker.js'), { workerData: { modelDir } });
    this.seq = 0;
    this.pending = new Map();
    this.worker.on('message', (msg) => {
      const item = this.pending.get(msg.id);
      if (!item) return;
      this.pending.delete(msg.id);
      if (msg.ok) item.resolve(msg.result);
      else {
        const err = new Error(msg.error || 'worker 调用失败');
        err.stack = msg.stack || err.stack;
        item.reject(err);
      }
    });
    this.worker.on('error', (err) => {
      for (const item of this.pending.values()) item.reject(err);
      this.pending.clear();
    });
  }

  call(cmd, args) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args });
    });
  }

  async close() {
    try {
      await this.call('close');
    } catch (_) {
      /* ignore */
    }
    await this.worker.terminate();
  }
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function hashKey(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function formatMs(ms) {
  return `${Math.round(ms * 10) / 10}ms`;
}

async function runSelfTest({ dbPath, modelDir = DEFAULT_MODEL_DIR, log = console.log } = {}) {
  const started = Date.now();
  const dir = dbPath
    ? path.dirname(dbPath)
    : path.join(MEMORY_DIR, '.tmp', 'selftest-' + Date.now());
  if (!dbPath) fs.mkdirSync(dir, { recursive: true });
  const file = dbPath || path.join(dir, 'memory.db');
  const client = new MemoryClient({ modelDir });
  const report = { ok: false, steps: [], timings: {} };

  const step = (name, detail) => {
    report.steps.push({ name, detail });
    log(`✔ ${name}${detail ? `：${detail}` : ''}`);
  };

  try {
    // 1. 初始化 DB
    const init = await client.call('init', { dbPath: file, modelDir });
    step('SQLite 初始化', `${init.dbPath} · schema v${init.schemaVersion} · FTS=${init.ftsTokenizer}`);
    if (init.ftsTokenizer !== 'trigram') {
      throw new Error(`FTS5 分词器是 ${init.ftsTokenizer}，中文召回需要 trigram（检查 SQLite 版本）`);
    }

    // 2. embedding
    const sentences = [
      '我喜欢喝冰美式',
      '我每天早上都要喝一杯咖啡',
      '今天天气不错，适合出门散步',
      '外面在下雨，记得带伞',
      '这个项目的数据库要用 SQLite',
      '向量检索和 BM25 混合召回',
    ];
    const bike = await client.call('embed', { texts: sentences.slice(0, 2) }); // 先加载模型
    report.timings.modelLoadMs = bike.modelLoadMs;
    report.timings.firstBatchMs = bike.ms;
    step('模型加载', `${bike.model} · 维度 ${bike.dim} · 加载 ${formatMs(bike.modelLoadMs)}`);

    const lat = [];
    const vectors = [];
    for (const text of sentences) {
      const one = await client.call('embed', { texts: [text] });
      vectors.push(one.vectors[0]);
      lat.push(one.ms);
    }
    const avg = lat.reduce((a, b) => a + b, 0) / lat.length;
    report.timings.avgEmbedMs = avg;
    report.timings.embedMs = lat;
    step('单句向量化', `平均 ${formatMs(avg)} · 最快 ${formatMs(Math.min(...lat))} · 最慢 ${formatMs(Math.max(...lat))}`);

    const coffee = cosine(vectors[0], vectors[1]);
    const coffeeWeather = cosine(vectors[0], vectors[2]);
    const code = cosine(vectors[4], vectors[5]);
    const codeCoffee = cosine(vectors[4], vectors[0]);
    report.timings.similarities = { coffee, coffeeWeather, code, codeCoffee };
    if (!(coffee > coffeeWeather + 0.08)) {
      throw new Error(`相似度不符合预期：咖啡对 ${coffee.toFixed(3)} 应明显高于咖啡/天气 ${coffeeWeather.toFixed(3)}`);
    }
    if (!(code > codeCoffee + 0.08)) {
      throw new Error(`相似度不符合预期：代码对 ${code.toFixed(3)} 应明显高于代码/咖啡 ${codeCoffee.toFixed(3)}`);
    }
    step('语义相似度', `咖啡对 ${coffee.toFixed(3)} > 咖啡/天气 ${coffeeWeather.toFixed(3)}；代码对 ${code.toFixed(3)} > 代码/咖啡 ${codeCoffee.toFixed(3)}`);

    // 3. 写入 + 向量检索
    const coffeeKey = hashKey('user|preference|咖啡');
    const rainKey = hashKey('user|event|下雨');
    const sqliteKey = hashKey('user|fact|sqlite');
    await client.call('upsert', {
      memory: {
        key: coffeeKey,
        subject: 'user',
        relation: 'preference',
        object_norm: '咖啡',
        fact: '喜欢冰美式',
        polarity: 'positive',
        truth: 1,
        source_text: '我喜欢喝冰美式',
        created_turn: 1,
      },
      vector: vectors[0],
      embedModel: bike.model,
      createdTurn: 1,
    });
    await client.call('upsert', {
      memory: {
        key: rainKey,
        relation: 'event',
        object_norm: '下雨',
        fact: '今天外面在下雨',
        source_text: '外面在下雨，记得带伞',
        truth: 0.7,
        created_turn: 2,
      },
      vector: vectors[3],
      createdTurn: 2,
    });
    await client.call('upsert', {
      memory: {
        key: sqliteKey,
        relation: 'fact',
        object_norm: 'sqlite',
        fact: '项目数据库用 SQLite',
        source_text: '这个项目的数据库要用 SQLite',
        truth: 1,
        created_turn: 3,
      },
      vector: vectors[4],
      createdTurn: 3,
    });
    step('Upsert 记忆', '3 条主键 + 3 条向量');

    const search = await client.call('search', { query: '我想喝一杯冰美式咖啡', limit: 3 });
    const top = search.results[0];
    report.timings.searchEmbedMs = search.embedMs;
    if (!top || top.key !== coffeeKey) {
      throw new Error(`向量检索首选不是咖啡记忆：${JSON.stringify(search.results)}`);
    }
    step('向量检索', `“我想喝一杯冰美式咖啡” → ${top.fact}（${top.score.toFixed(3)}）`);

    // 4. BM25 / FTS
    const ftsHit = await client.call('searchText', { query: '冰美式', limit: 3 });
    if (!ftsHit.results.some((r) => r.key === coffeeKey)) {
      throw new Error('FTS 检索没有命中“冰美式”：' + JSON.stringify(ftsHit.results));
    }
    const likeHit = await client.call('searchText', { query: '冰美', limit: 3 });
    if (!likeHit.results.some((r) => r.key === coffeeKey)) {
      throw new Error('短词 LIKE 检索没有命中“冰美”：' + JSON.stringify(likeHit.results));
    }
    const sqliteHit = await client.call('searchText', { query: 'SQLite', limit: 3 });
    if (!sqliteHit.results.some((r) => r.key === sqliteKey)) {
      throw new Error('FTS 检索没有命中“SQLite”：' + JSON.stringify(sqliteHit.results));
    }
    step('BM25 / FTS', `“冰美式” ${ftsHit.results.length} 条 · “冰美” ${likeHit.results.length} 条 · “SQLite” ${sqliteHit.results.length} 条`);

    // 5. 统计 / 列表 / 重置
    let stats = await client.call('stats');
    if (stats.memories !== 3 || stats.vectors !== 3) {
      throw new Error(`统计不对：memories=${stats.memories} vectors=${stats.vectors}`);
    }
    const list = await client.call('list', { limit: 10 });
    step('统计 / 列表', `${stats.memories} 条记忆 · ${stats.vectors} 条向量 · ${(stats.bytes / 1024 / 1024).toFixed(2)}MB`);
    stats = await client.call('reset');
    if (stats.memories !== 0 || stats.vectors !== 0) {
      throw new Error(`清空失败：memories=${stats.memories} vectors=${stats.vectors}`);
    }
    step('清空重建', 'memories=0 · vectors=0');

    report.ok = true;
    report.timings.totalMs = Date.now() - started;
    log('');
    log(`全部通过 · 总耗时 ${formatMs(report.timings.totalMs)} · 单句平均 ${formatMs(report.timings.avgEmbedMs)}`);
    return report;
  } finally {
    await client.close();
    if (!dbPath) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        /* Windows 上 WAL 文件偶尔晚一点释放，忽略 */
      }
    }
  }
}

module.exports = { runSelfTest, MemoryClient, DEFAULT_MODEL_DIR };

if (require.main === module) {
  runSelfTest()
    .then((r) => process.exit(r.ok ? 0 : 2))
    .catch((err) => {
      console.error('✖ 自测失败：' + (err && err.message ? err.message : err));
      if (err && err.stack) console.error(err.stack);
      process.exit(1);
    });
}
