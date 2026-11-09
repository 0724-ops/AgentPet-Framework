// ============================================================================
//  主进程侧的记忆宿主：负责
//    1. embedding 模型的「首次按需下载」（复用任务中心 + fetchToFile 进度）
//    2. 记忆 Worker 的生命周期（懒启动、崩溃后自动重建、退出时关闭）
//    3. IPC 调用的序列化 / 错误回传
//
//  模型和其它组件一样不随仓库走：第一次真正需要向量化时才下载。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('worker_threads');

// 需要 embedding 模型才能执行的命令
const NEED_MODEL = new Set(['embed', 'search', 'retrieve', 'upsertFacts']);

// components.json 里 memory.files / memory.sources 缺失时的兜底（与 models/README.md 一致）
const DEFAULT_FILES = [
  { path: 'config.json', bytes: 716 },
  { path: 'tokenizer.json', bytes: 439125 },
  { path: 'onnx/model_quantized.onnx', bytes: 24010842 },
];
const DEFAULT_SOURCES = [
  'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main',
  'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main',
];

function createMemoryHost({
  appDir,
  dbPath,
  modelDir,
  sources,
  files,
  charName = '',
  fetchToFile,
  taskStart,
  taskUpdate,
  taskFinish,
  log = () => {},
}) {
  const workerPath = path.join(appDir, 'memory', 'worker.js');
  const sourceList = (Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES)
    .map((s) => String(s || '').replace(/\/+$/, ''))
    .filter(Boolean);
  const fileList = Array.isArray(files) && files.length ? files : DEFAULT_FILES;

  let worker = null;
  let seq = 0;
  const pending = new Map();
  let downloading = null;

  function fileReady(file) {
    try {
      return fs.statSync(path.join(modelDir, file.path)).size > 0;
    } catch (_) {
      return false;
    }
  }

  function modelReady() {
    return fileList.every(fileReady);
  }

  function status() {
    return {
      dbPath,
      modelDir,
      modelReady: modelReady(),
      files: fileList.map((f) => ({
        path: f.path,
        bytes: Number(f.bytes) || 0,
        ready: fileReady(f),
      })),
      worker: !!worker,
    };
  }

  function taskDetail(file, host) {
    return host ? `${file.path} · ${host}` : file.path;
  }

  async function downloadWithFallback(file, dest, signal, onProgress) {
    let lastError = null;
    for (const base of sourceList) {
      const url = `${base}/${file.path}`;
      const host = (() => {
        try {
          return new URL(url).host;
        } catch (_) {
          return '';
        }
      })();
      try {
        await fetchToFile(url, dest, { onProgress, signal });
        return { url, host };
      } catch (err) {
        if (signal.aborted) throw err;
        lastError = err;
        log(`[memory] 下载失败 ${url}：${err && err.message ? err.message : err}`);
        try {
          fs.unlinkSync(dest);
        } catch (_) {
          /* 可能还没落盘 */
        }
      }
    }
    throw lastError || new Error('components.json 里没有可用的记忆模型下载源');
  }

  // 首次使用才下载；并发调用共用同一个 Promise
  async function ensureModel({ force = false } = {}) {
    if (!force && modelReady()) return { ok: true, ...status() };
    if (downloading) return downloading;

    downloading = (async () => {
      const missing = fileList.filter((f) => force || !fileReady(f));
      if (!missing.length) return { ok: true, ...status() };

      const totalBytes = missing.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
      const task = taskStart('正在下载 记忆模型', {
        detail: `首次使用需要下载 bge-small 中文向量模型（约 ${Math.max(1, Math.round(totalBytes / 1024 / 1024))}MB）`,
        total: totalBytes,
        cancelable: true,
      });
      const controller = new AbortController();
      task.abort = controller;
      let doneBytes = 0;

      try {
        for (const file of missing) {
          const dest = path.join(modelDir, file.path);
          const part = `${dest}.part`;
          const detail = taskDetail(file, '');
          taskUpdate(task.id, { detail });
          await downloadWithFallback(file, part, controller.signal, (received, total) => {
            taskUpdate(task.id, {
              received: doneBytes + received,
              total: totalBytes || total,
              detail,
            });
          });
          fs.renameSync(part, dest);
          let size = Number(file.bytes) || 0;
          try {
            size = fs.statSync(dest).size;
          } catch (_) {
            /* 用配置里的体积兜底 */
          }
          doneBytes += size;
          taskUpdate(task.id, { received: doneBytes, total: totalBytes || doneBytes });
        }
        taskFinish(task.id, { ok: true, detail: '记忆模型已就绪' });
        return { ok: true, ...status() };
      } catch (err) {
        for (const file of missing) {
          try {
            fs.unlinkSync(path.join(modelDir, file.path) + '.part');
          } catch (_) {
            /* 忽略没写出来的临时文件 */
          }
        }
        const message = String(err && err.message ? err.message : err);
        taskFinish(task.id, { ok: false, detail: controller.signal.aborted ? '已取消' : message });
        return { ok: false, error: message, ...status() };
      }
    })();

    try {
      return await downloading;
    } finally {
      downloading = null;
    }
  }

  function spawnWorker() {
    // 记忆块的提示词模板由用户维护，Worker 每次检索时按路径现读
    const w = new Worker(workerPath, {
      workerData: {
        dbPath,
        modelDir,
        promptFile: path.join(__dirname, 'preset-memory.md'),
        // 角色名用于记忆主语的归一化（换角色不用改 normalize.js）
        charName,
      },
    });
    w.on('message', (msg) => {
      const item = pending.get(msg && msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.ok) item.resolve(msg.result);
      else {
        const err = new Error(msg.error || '记忆 Worker 调用失败');
        if (msg.stack) err.stack = msg.stack;
        item.reject(err);
      }
    });
    const fail = (err) => {
      for (const [, item] of pending) item.reject(err);
      pending.clear();
      if (worker === w) worker = null;
    };
    w.on('error', (err) => {
      log(`[memory] worker 出错：${err && err.message ? err.message : err}`);
      fail(err);
    });
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      if (pending.size) fail(new Error(`记忆 Worker 已退出（code ${code}）`));
    });
    return w;
  }

  async function call(cmd, args = {}) {
    if (NEED_MODEL.has(cmd)) {
      const ready = await ensureModel();
      if (!ready.ok) throw new Error(ready.error || '记忆模型未就绪');
    }
    if (!worker) worker = spawnWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, args });
    });
  }

  function close() {
    const w = worker;
    worker = null;
    if (!w) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        w.terminate().catch(() => {}).finally(resolve);
      }, 800);
      w.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      for (const [, item] of pending) item.reject(new Error('记忆 Worker 已关闭'));
      pending.clear();
      try {
        w.postMessage({ id: ++seq, cmd: 'close', args: {} });
      } catch (_) {
        clearTimeout(timer);
        w.terminate().catch(() => {}).finally(resolve);
      }
    });
  }

  return { status, ensureModel, call, close };
}

module.exports = { createMemoryHost, NEED_MODEL, DEFAULT_FILES, DEFAULT_SOURCES };
