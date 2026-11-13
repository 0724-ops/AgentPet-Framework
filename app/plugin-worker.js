// ============================================================================
//  插件 Worker 入口（Phase 2 / 共享池）
//
//  由主进程用 utilityProcess.fork 拉起。一个进程可以跑一个插件（独立模式），
//  也可以跑多个插件（共享池模式），每个插件是一个「租户」：
//    * 各自独立的 index.js / 配置 / 补丁等待队列
//    * 所有上行消息都带 pluginId，主进程按插件路由
//    * 受限权限的租户各自注册沙箱根目录（见 plugin-sandbox.js）
//
//  config.json 永远由主进程写：插件只能调 ctx.patchConfig()，
//  等主进程回 patch-result 之后本地才更新，避免两边各写一份。
// ============================================================================

const path = require('node:path');
const { installSandbox, uninstallSandbox } = require('./plugin-sandbox.js');

const port = process.parentPort;
const tenants = new Map(); // pluginId -> tenant
let statsTimer = null;

const TOOL_STATUSES = new Set(['success', 'error', 'blocked', 'rate_limited']);

function post(message) {
  try {
    port.postMessage(message);
  } catch (_) {
    /* 主进程已经走了，丢弃即可 */
  }
}

// 进程管理器用：定期把自身的 PID / 内存占用上报给主进程（进程级，不分插件）
function sendStats() {
  const pid = process.pid;
  let rssKb = 0;
  const finish = (value) => {
    post({ type: 'stats', pid, rssKb: Number(value) || 0 });
  };
  try {
    if (typeof process.getProcessMemoryInfo === 'function') {
      Promise.resolve(process.getProcessMemoryInfo())
        .then((info) => {
          rssKb = info && Number(info.private || info.residentSet || 0);
          if (!rssKb) rssKb = Math.round(process.memoryUsage().rss / 1024);
          finish(rssKb);
        })
        .catch(() => {
          try {
            finish(Math.round(process.memoryUsage().rss / 1024));
          } catch (_) {
            finish(0);
          }
        });
      return;
    }
    finish(Math.round(process.memoryUsage().rss / 1024));
  } catch (_) {
    finish(0);
  }
}

function startStats() {
  if (statsTimer) return;
  sendStats();
  statsTimer = setInterval(sendStats, 2000);
  if (statsTimer.unref) statsTimer.unref();
}

function stopStats() {
  if (!statsTimer) return;
  clearInterval(statsTimer);
  statsTimer = null;
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  } catch (_) {
    return null;
  }
}

function tenantOf(id) {
  return tenants.get(String(id || '')) || null;
}

// 插件回调里抛异常不能拖垮整个进程：记一条日志，继续跑
function callShellHandler(tenant, handler, event, data) {
  try {
    handler(event, clone(data));
  } catch (err) {
    post({
      type: 'log',
      pluginId: tenant.pluginId,
      message: `onShellEvent(${event}) 异常：${err && err.message ? err.message : err}`,
    });
  }
}

function makeCtx(tenant) {
  return {
    get pluginId() {
      return tenant.pluginId;
    },
    get permission() {
      return tenant.permission;
    },
    // si 目录绝对路径（壳层资产、旧版运行时目录）
    get siRoot() {
      return tenant.siRoot;
    },
    // 插件自己的目录绝对路径（运行时大件现在放在这里，重导入不会丢）
    get pluginDir() {
      return tenant.pluginDir;
    },
    getConfig() {
      return clone(tenant.config);
    },
    // 插件不能直接写文件：把补丁交给主进程，主进程合并 → 原子写 → rev++ → 回推
    patchConfig(patch) {
      return new Promise((resolve) => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          resolve({ ok: false, error: 'patch 必须是一个对象' });
          return;
        }
        const requestId = `${tenant.pluginId}-patch-${++tenant.patchSeq}`;
        tenant.patchWaiters.set(requestId, resolve);
        post({ type: 'patch', pluginId: tenant.pluginId, requestId, patch });
      });
    },
    // 主动事件（例如定时任务到点）→ 主进程 → 渲染层；data 只给 UI / 壳层，不进模型上下文
    emit(event, data) {
      post({
        type: 'event',
        pluginId: tenant.pluginId,
        event: String(event || ''),
        data: data === undefined ? null : data,
      });
    },
    // 壳层状态回调（plugin.json 的 capabilities 里要声明 "state" 才会收到）：
    //   kernel：{ status: 'ready' | 'stopped', actions?: [动作名] }
    //   state ：{ at: 最后活动时间戳, kind, kernel, busy, current, queueLength }
    //   chat  ：{ role, text, at, seq } 模型回复完成（即时，不补发）
    // 注册时会补发最近一份，所以 init 里注册就不会漏掉启动前的 kernel ready。
    onShellEvent(handler) {
      if (typeof handler !== 'function') return () => {};
      tenant.shellHandlers.add(handler);
      for (const event of ['kernel', 'state']) {
        const data = tenant.lastShell[event];
        if (data) callShellHandler(tenant, handler, event, data);
      }
      return () => tenant.shellHandlers.delete(handler);
    },
    log(message) {
      post({ type: 'log', pluginId: tenant.pluginId, message: String(message == null ? '' : message) });
    },
  };
}

// 插件加载 / init 失败：整个进程退出，由主进程按「整池损坏」处理
function fail(pluginId, message) {
  post({ type: 'fatal', pluginId: String(pluginId || ''), message: String(message || '插件加载失败') });
  process.exit(1);
}

function normalizeResult(raw) {
  if (typeof raw === 'string') return { status: 'success', content: raw };
  if (!raw || typeof raw !== 'object') {
    return { status: 'success', content: String(raw == null ? '' : raw) };
  }
  const status = TOOL_STATUSES.has(raw.status) ? raw.status : 'success';
  const content = raw.content == null ? '' : String(raw.content);
  const extra = raw.extra && typeof raw.extra === 'object' ? raw.extra : undefined;
  return extra ? { status, content, extra } : { status, content };
}

async function loadTenant(tenant) {
  // 受限模式：禁 child_process、fs 限制在这个插件自己的目录内；完全模式不注册
  installSandbox({ pluginId: tenant.pluginId, pluginDir: tenant.pluginDir, permission: tenant.permission });
  const entry = path.join(tenant.pluginDir, 'index.js');
  try {
    tenant.api = require(entry);
  } catch (err) {
    fail(tenant.pluginId, `加载 index.js 失败：${err && err.message ? err.message : err}`);
    return false;
  }
  // 被动型插件（只用 state 通道 / 定时器，不提供工具也不接管语音）也是合法插件：
  // 只要有 init / execute / synthesize 其中一个就够了
  const api = tenant.api;
  const usable =
    api &&
    (typeof api.init === 'function' || typeof api.execute === 'function' || typeof api.synthesize === 'function');
  if (!usable) {
    fail(tenant.pluginId, 'index.js 至少要有 init / execute / synthesize 其中一个导出');
    return false;
  }
  if (typeof tenant.api.init === 'function') {
    try {
      await tenant.api.init(tenant.ctx);
    } catch (err) {
      fail(tenant.pluginId, `init 失败：${err && err.message ? err.message : err}`);
      return false;
    }
  }
  return true;
}

async function handleCall(msg) {
  const callId = String(msg.callId || '');
  const pluginId = String(msg.pluginId || '');
  const tenant = tenantOf(pluginId);
  if (!tenant || !tenant.api || typeof tenant.api.execute !== 'function') {
    post({ type: 'result', pluginId, callId, status: 'error', content: '插件尚未就绪' });
    return;
  }
  try {
    const result = normalizeResult(await tenant.api.execute(String(msg.tool || ''), msg.args || {}));
    post({ type: 'result', pluginId, callId, ...result });
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    post({ type: 'result', pluginId, callId, status: 'error', content: `Error: ${text}` });
  }
}

const MAX_SPEECH_AUDIO_CHARS = 24 * 1024 * 1024;

async function handleSpeech(msg) {
  const requestId = String(msg.requestId || '');
  const pluginId = String(msg.pluginId || '');
  const tenant = tenantOf(pluginId);
  if (!tenant || !tenant.api || typeof tenant.api.synthesize !== 'function') {
    post({ type: 'speech-result', pluginId, requestId, error: '插件没有实现 synthesize(payload)' });
    return;
  }
  try {
    const res = await tenant.api.synthesize(msg.payload || {});
    let audio = '';
    let format = 'wav';
    if (typeof res === 'string') audio = res;
    else if (res && typeof res === 'object') {
      audio = String(res.audio || '');
      format = String(res.format || 'wav');
    }
    if (!audio) {
      post({ type: 'speech-result', pluginId, requestId, error: '插件没有返回音频' });
      return;
    }
    if (audio.length > MAX_SPEECH_AUDIO_CHARS) {
      post({ type: 'speech-result', pluginId, requestId, error: '音频过大' });
      return;
    }
    post({ type: 'speech-result', pluginId, requestId, audio, format });
  } catch (err) {
    post({
      type: 'speech-result',
      pluginId,
      requestId,
      error: err && err.message ? err.message : String(err),
    });
  }
}

async function handleInit(msg) {
  const pluginId = String(msg.pluginId || '');
  if (!pluginId) return;
  const tenant = {
    pluginId,
    pluginDir: String(msg.pluginDir || ''),
    siRoot: String(msg.siRoot || ''),
    permission: msg.permission === 'full' ? 'full' : 'restricted',
    config: clone(msg.config) || {},
    configRev: Number(msg.rev) || 0,
    api: null,
    ctx: null,
    patchSeq: 0,
    patchWaiters: new Map(),
    shellHandlers: new Set(),
    lastShell: { kernel: null, state: null },
  };
  tenant.ctx = makeCtx(tenant);
  tenants.set(pluginId, tenant);
  const ok = await loadTenant(tenant);
  if (ok) post({ type: 'ready', pluginId });
}

async function disposeTenant(tenant) {
  if (tenant.api && typeof tenant.api.dispose === 'function') {
    try {
      await tenant.api.dispose();
    } catch (_) {
      /* 退出前不再上报，避免主进程以为又崩了 */
    }
  }
  for (const waiter of tenant.patchWaiters.values()) {
    waiter({ ok: false, error: '插件进程已退出' });
  }
  tenant.patchWaiters.clear();
  tenants.delete(tenant.pluginId);
  uninstallSandbox(tenant.pluginId);
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    await handleInit(msg);
    return;
  }
  if (msg.type === 'stats-start') {
    startStats();
    return;
  }
  if (msg.type === 'stats-stop') {
    stopStats();
    return;
  }
  if (msg.type === 'call') {
    await handleCall(msg);
    return;
  }
  if (msg.type === 'speech') {
    await handleSpeech(msg);
    return;
  }
  if (msg.type === 'shell-event') {
    const tenant = tenantOf(msg.pluginId);
    if (!tenant) return;
    const event = String(msg.event || '');
    // chat 是即时消息，不缓存、不补发
    if (event === 'chat') {
      const data = clone(msg.data) || {};
      for (const handler of tenant.shellHandlers) callShellHandler(tenant, handler, event, data);
      return;
    }
    if (event !== 'kernel' && event !== 'state') return;
    const data = clone(msg.data) || {};
    tenant.lastShell[event] = data;
    for (const handler of tenant.shellHandlers) callShellHandler(tenant, handler, event, data);
    return;
  }
  if (msg.type === 'config') {
    const tenant = tenantOf(msg.pluginId);
    if (!tenant) return;
    tenant.config = clone(msg.config) || {};
    tenant.configRev = Number(msg.rev) || 0;
    if (tenant.api && typeof tenant.api.onConfig === 'function') {
      try {
        await tenant.api.onConfig(clone(tenant.config), tenant.configRev);
      } catch (err) {
        post({
          type: 'log',
          pluginId: tenant.pluginId,
          message: `onConfig 异常：${err && err.message ? err.message : err}`,
        });
      }
    }
    return;
  }
  if (msg.type === 'patch-result') {
    const tenant = tenantOf(msg.pluginId);
    if (!tenant) return;
    const requestId = String(msg.requestId || '');
    const waiter = tenant.patchWaiters.get(requestId);
    if (!waiter) return;
    tenant.patchWaiters.delete(requestId);
    if (msg.ok) {
      tenant.config = clone(msg.config) || {};
      tenant.configRev = Number(msg.rev) || tenant.configRev;
      waiter({ ok: true, rev: tenant.configRev, config: clone(tenant.config) });
    } else {
      waiter({ ok: false, error: String(msg.error || '写入失败') });
    }
    return;
  }
  if (msg.type === 'shutdown') {
    // 带 pluginId：只退出该租户（共享池里移除单个插件）；不带：整进程退出
    const target = tenantOf(msg.pluginId);
    if (target) {
      await disposeTenant(target);
      if (tenants.size > 0) return;
    } else if (msg.pluginId) {
      return; // 指定租户不存在，忽略
    }
    stopStats();
    for (const tenant of [...tenants.values()]) await disposeTenant(tenant);
    process.exit(0);
  }
}

process.on('uncaughtException', (err) => {
  fail('', `未捕获异常：${err && err.message ? err.message : err}`);
});
process.on('unhandledRejection', (err) => {
  fail('', `未处理的 Promise 拒绝：${err && err.message ? err.message : err}`);
});

if (!port) {
  // 只能作为 utilityProcess 运行；被手动 node 跑起来时直接退出
  process.exit(0);
}

port.on('message', (event) => {
  void handleMessage(event && event.data ? event.data : event);
});
