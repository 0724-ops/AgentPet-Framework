// ============================================================================
//  本地 embedding：bge-small-zh-v1.5（int8 ONNX）+ onnxruntime-node
//
//  - CLS pooling + L2 归一化（bge 系列的标准用法）
//  - 批量推理时按当前 batch 的最长句 padding，避免每条都跑一次模型
//  - 全部在 Worker 里跑，不阻塞主进程/UI
// ============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ort = require('onnxruntime-node');
const { createTokenizer, resolveModelDir } = require('./tokenizer');

const MODEL_NAME = 'bge-small-zh-v1.5-int8';
const MAX_LENGTH = 512;

function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  }
  return vec;
}

async function createEmbedder({ modelDir = resolveModelDir(), threads } = {}) {
  const dir = resolveModelDir(modelDir);
  const modelPath = path.join(dir, 'onnx', 'model_quantized.onnx');
  const tokenizerPath = path.join(dir, 'tokenizer.json');
  if (!fs.existsSync(modelPath)) throw new Error(`找不到 embedding 模型：${modelPath}`);
  if (!fs.existsSync(tokenizerPath)) throw new Error(`找不到 tokenizer：${tokenizerPath}`);

  const tokenizer = createTokenizer(tokenizerPath);
  const started = Date.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, Number(threads) || Math.min(8, os.cpus().length || 4)),
    interOpNumThreads: 1,
  });
  const loadMs = Date.now() - started;

  const inputNames = [...session.inputNames];
  const outputNames = [...session.outputNames];
  const wantTokens = inputNames.includes('token_type_ids');
  let dim = 0;

  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
    if (!list.length) return [];
    const encoded = list.map((t) => tokenizer.encode(t, MAX_LENGTH));
    const length = Math.max(...encoded.map((ids) => ids.length));
    const batch = encoded.length;
    const ids = new BigInt64Array(batch * length);
    const mask = new BigInt64Array(batch * length);
    const types = wantTokens ? new BigInt64Array(batch * length) : null;
    encoded.forEach((row, b) => {
      row.forEach((id, i) => {
        ids[b * length + i] = BigInt(id);
        mask[b * length + i] = 1n;
      });
    });

    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [batch, length]),
      attention_mask: new ort.Tensor('int64', mask, [batch, length]),
    };
    if (types) feeds.token_type_ids = new ort.Tensor('int64', types, [batch, length]);

    const t0 = Date.now();
    const results = await session.run(feeds);
    const ms = Date.now() - t0;
    const outName =
      outputNames.find((n) => results[n] && results[n].dims && results[n].dims.length === 3) || outputNames[0];
    const tensor = results[outName];
    if (!tensor || tensor.dims.length !== 3) throw new Error('embedding 输出维度异常：' + JSON.stringify(tensor && tensor.dims));
    const [, seq, hidden] = tensor.dims;
    dim = hidden;
    const data = tensor.data;
    const vectors = [];
    for (let b = 0; b < batch; b += 1) {
      const offset = b * seq * hidden; // CLS 在第 0 个 token
      const vec = new Float32Array(hidden);
      for (let i = 0; i < hidden; i += 1) vec[i] = data[offset + i];
      vectors.push(l2normalize(vec));
    }
    return { vectors, ms, batch, length, dim: hidden };
  }

  return {
    embed,
    model: MODEL_NAME,
    get dim() {
      return dim || 512;
    },
    loadMs,
    modelPath,
    tokenizer,
    inputNames,
    outputNames,
  };
}

module.exports = { createEmbedder, MODEL_NAME, MAX_LENGTH, l2normalize };
