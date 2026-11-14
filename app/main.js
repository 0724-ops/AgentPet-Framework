// AgentPet Framework - Electron main process.
// Frameless transparent host, app://si protocol for the sealed 3D kernel, window IPC.
const { app, BrowserWindow, Menu, Tray, nativeImage, protocol, net, ipcMain, globalShortcut, screen, dialog, shell, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// ------------------------------------------------------------------ 身份 / 数据根
// 这是独立项目：应用名、AppUserModelID、用户数据目录全部与旧版 si-pet 分开。
// 必须在 ready 之前设置，否则 Chromium 的缓存 / 配置已经落到旧目录里。
const APP_NAME = 'AgentPet Framework';
const APP_ID = 'com.agentpet.framework';
const APP_DATA_BASE = app.getPath('appData');
const PROGRAM_ROOT = path.resolve(__dirname, '..');
app.setName(APP_NAME);

const dataRoot = require('./data-root');
// C 盘只留一个指针文件；角色 / 插件 / 记忆 / 会话 / Chromium profile 全在 DataRoot
const ROOT_STATE = dataRoot.resolve(APP_DATA_BASE, APP_NAME);
const DATA_ROOT = ROOT_STATE.root;
// 指针缺失或目录不可达时先用一个极小的引导 profile，选完目录重启到真正的根
const PROFILE_DIR = DATA_ROOT ? path.join(DATA_ROOT, 'profile') : path.join(APP_DATA_BASE, APP_NAME, '.bootstrap');
try {
  // setPath 要求目录已存在，否则直接抛错
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  app.setPath('userData', PROFILE_DIR);
  // sessionData 跟着走，否则缓存 / LocalStorage / IndexedDB 还会落在 userData 默认位置
  app.setPath('sessionData', PROFILE_DIR);
} catch (err) {
  console.error('[app] 用户数据目录切换失败，退回默认目录：', err && err.message);
}
// Windows 通知需要 AppUserModelID，否则便携版/未打包版可能弹不出来或显示成 Electron
app.setAppUserModelId(APP_ID);

const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { createMemoryHost } = require('./memory-host');
const { createPluginHost } = require('./plugin-host');
const { createCharacterHost } = require('./character-host');
const { createImageAlias } = require('./image-alias');

// ------------------------------------------------------------------ WebGPU
// 新内核（poc4）走原生 WebGPU。Chromium 在部分机器上会因 GPU blocklist 直接不给 device，
// 这里显式放开；真的没有硬件 WebGPU 时内核会给出 status=error，壳自动退回 WebGL 后端。
try {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'WebGPU');
} catch (_) {
  /* 命令行开关失败不影响启动 */
}

// ------------------------------------------------------------------ config
const APP_DIR = __dirname; // si/app
const SI_ROOT = path.resolve(APP_DIR, '..'); // 程序根（voice / models 等共享组件在这里；内核在角色目录里）
// 渲染层与 3D 内核都从 app://si 加载，保证同源（可互访 contentWindow / contentDocument）。
const RENDERER_URL = 'app://si/app/renderer/index.html';
const ICON_PATH = path.join(APP_DIR, '图标.png');
// 运行期日志统一收到 si/logs/，不再和壳层源码混在 app/ 里
const LOG_DIR = path.join(SI_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'pet.log');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {
  /* 目录建不出来时 log() 会退化成只写控制台 */
}
// ------------------------------------------------------------------ 应用配置
// 程序只是壳：
//   app/components.json  全局组件（语音 / embedding / 搜索），只读
//   角色定义全部来自 <DataRoot>/characters/<id>/character.json
// 角色相关只从角色定义读，新增角色不用改代码。
const COMPONENTS_FILE = path.join(APP_DIR, 'components.json');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// 角色宿：<DataRoot>/characters/*，返回的路径统一是 app 根相对路径
const characterHost = createCharacterHost({ dataRoot: DATA_ROOT, log });

// 情感状态：每个角色目录一份 emotion.json，读写都在主进程完成
const { createEmotionStore } = require('./emotion/state');
const emotionStore = createEmotionStore({ dataRoot: DATA_ROOT, log });

// app 根相对路径 → 磁盘绝对路径。
//   characters/...  → <DataRoot>/characters/...
//   其余            → 程序根（语音 / 模型等共享组件在这边）
function appPathToFile(rel, fallback) {
  const raw = String(rel || fallback || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return '';
  const isCharacter = raw === 'characters' || raw.startsWith('characters/');
  const base = isCharacter ? path.join(DATA_ROOT || '', 'characters') : SI_ROOT;
  if (!base) return '';
  const sub = raw.startsWith('characters/') ? raw.slice('characters/'.length) : raw;
  const file = path.resolve(base, sub);
  const root = path.resolve(base);
  if (file !== root && !file.startsWith(root + path.sep)) return '';
  return file;
}

function loadAppConfig() {
  const comp = readJsonSafe(COMPONENTS_FILE) || {};
  const state = characterHost.resolve();
  const active = state.active || {};
  const kernel = active.kernel || {};
  const voice = comp.voice || {};
  const asr = voice.asr || {};
  // 动作库完全跟着角色定义走，没有角色就是空
  const clipRel = active.clips || '';
  const actionsRel = active.actions || '';
  const indexRel =
    (active.actionsSource && active.actionsSource.index) || (clipRel ? `${clipRel}/_index.json` : '');
  return {
    raw: comp,
    characters: state.characters,
    active,
    activeId: state.activeId,
    // 应用名与角色名分开：appName 给窗口标题 / 托盘 / 内核名用，角色名只在角色定义里
    appName: comp.appName || APP_NAME,
    appVersion: comp.appVersion || '',
    kernel: {
      id: kernel.id || active.id || '',
      name: kernel.name || active.name || '',
      version: kernel.version || '',
      entry: kernel.entry || '',
      webglEntry: kernel.webglEntry || '',
      label: kernel.label || (active.name ? `${active.name} · 内核` : ''),
    },
    clipDir: appPathToFile(clipRel) || active.dir || '',
    clipPrefix: active.clipPrefix || 'a_actor_',
    actionsFile: appPathToFile(actionsRel),
    // 动作来源：files = 扫 clips 目录里的 .glb（默认）；index = 只认清单文件，
    // 用于没有 .glb 的 2D / Live2D 内核，动作名 + 时长直接写在清单里。
    actionsMode: active.actionsSource && active.actionsSource.mode === 'index' ? 'index' : 'files',
    actionsIndex: appPathToFile(indexRel),
    asr: {
      dir: asr.dir || 'voice/asr',
      modelsDir: asr.modelsDir || 'voice/asr/models',
      engine: asr.engine || {},
      model: asr.model || {},
    },
    memory: {
      dir: (comp.memory && comp.memory.dir) || 'models/bge-small-zh-v1.5',
      dim: Number(comp.memory && comp.memory.dim) || 512,
      sources: (comp.memory && Array.isArray(comp.memory.sources) ? comp.memory.sources : []).filter(Boolean),
      files: (comp.memory && Array.isArray(comp.memory.files) ? comp.memory.files : []).filter((f) => f && f.path),
    },
    search: {
      provider: (comp.search && comp.search.provider) || 'anysearch',
      apiKey: String((comp.search && comp.search.apiKey) || '').trim(),
      endpoint: String((comp.search && comp.search.endpoint) || 'https://api.anysearch.com').replace(/\/+$/, ''),
      zone: (comp.search && comp.search.zone) || 'cn',
      language: (comp.search && comp.search.language) || 'zh-CN',
      maxResults: Number(comp.search && comp.search.maxResults) || 5,
      timeoutMs: Number(comp.search && comp.search.timeoutMs) || 20000,
      maxTotalChars: Number(comp.search && comp.search.maxTotalChars) || 1800,
    },
  };
}

// 切换角色后整份配置会重算，所以这里必须是 let
let APP_CONFIG = loadAppConfig();
// 语音输入：本地 sherpa-onnx（引擎 + SenseVoice 模型都在 si/voice/asr/，缺失时按需下载或导入组件包）
const VOICE_DIR = path.join(SI_ROOT, APP_CONFIG.asr.dir);
const VOICE_MODEL_DIR = path.join(SI_ROOT, APP_CONFIG.asr.modelsDir);
// 长程记忆：embedding 模型按需下载（si/models/bge-small-zh-v1.5/，不进仓库）；库放 userData
const MEMORY_MODEL_DIR = path.join(SI_ROOT, APP_CONFIG.memory.dir);
// 联网搜索（web_search）：provider / apiKey / 端点都从 app/components.json 的 search 段读
const SEARCH_CFG = APP_CONFIG.search;
let CLIP_DIR = APP_CONFIG.clipDir;
let ACTION_INDEX = APP_CONFIG.actionsIndex;
// 预设里给模型看的动作说明，落成磁盘上的 .md，方便手工改 / 版本管理
const PRESET_ACTIONS_FILE = path.join(APP_DIR, 'preset-actions.md');
// 人设：真相源是 .md，预设页可直接编辑并写回
const PRESET_PERSONA_FILE = path.join(APP_DIR, 'preset-persona.md');
// 说话格式：真相源是 .md，预设页可直接编辑并写回
const PRESET_SPEAK_FILE = path.join(APP_DIR, 'preset-speak.md');
// 时间说明：随「提示词附带当前时间」开关注入，预设页可编辑
const PRESET_TIME_FILE = path.join(APP_DIR, 'preset-time.md');
// 长期记忆块的提示词模板（{{MEMORIES}} 为条目占位符），预设页可编辑
const PRESET_MEMORY_FILE = path.join(APP_DIR, 'preset-memory.md');
// 上下文压缩用的提示词，同样落在磁盘上，用户想改直接改文件
const PRESET_COMPRESS_FILE = path.join(APP_DIR, 'preset-compress.md');
// 情感状态摘要的注入模板（贴最新一条用户消息前），预设页可编辑
const PRESET_EMOTION_FILE = path.join(APP_DIR, 'preset-emotion.md');
// 主动开口的指令模板：用户没人说话时按它拼一句，和情感注入模板分开维护
const PRESET_PROACTIVE_FILE = path.join(APP_DIR, 'preset-proactive.md');
// 可插拔工具注册表：只登记真 Tool Call；SPEAK / MEM_MARK 属于底层协议，不走这里
const TOOLS_CONFIG_FILE = path.join(APP_DIR, 'tools.config.json');
// 繁 → 简回落表（OpenCC t2s 单字 + 词组例外），用于兜底修正转写结果
const T2S_FILE = path.join(APP_DIR, 't2s.json');
const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 600;
const CLICK_THROUGH_ACCELERATOR = 'CommandOrControl+Shift+P';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  try {
    console.log(line);
  } catch (_) {
    /* stdout 管道可能已被关闭（EPIPE），不能因为写日志把主进程打崩 */
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {
    /* logging must never crash the app */
  }
}

// 启动方关掉控制台后 stdout 会异步报 EPIPE，吞掉即可
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ------------------------------------------------------------------ 数据根引导
// userData 必须在 ready 之前定下来，所以这里用同步对话框：选完写指针然后重启进程。
// 换目录只切指针、不做迁移（旧目录里的角色 / 记忆原样保留，用户自己处理）。
function promptDataRoot(problem) {
  const suggested = dataRoot.suggestRoot({
    isPackaged: app.isPackaged,
    programRoot: PROGRAM_ROOT,
    execPath: process.execPath,
  });
  for (;;) {
    const changing = problem === 'change';
    const unreachable = problem === 'unreachable';
    const askedAt = Date.now();
    // 注意：showMessageBoxSync 返回的是按钮索引（number），不是 { response } 对象
    const response = dialog.showMessageBoxSync({
      type: unreachable ? 'warning' : 'question',
      title: '选择数据目录',
      message: unreachable ? '数据目录不可用' : changing ? '更换数据目录' : '首次启动：选择数据目录',
      detail: unreachable
        ? `指针指向的目录找不到了：\n${ROOT_STATE.pointerRoot}\n\n角色、插件、记忆都在这个目录里，请重新指定（或把原来的磁盘插回来）。`
        : `角色包、插件、记忆和会话都会存到这个目录，不占 C 盘。${changing ? '\n\n注意：只切换位置，不做迁移。旧目录里的角色和记忆会原样保留，需要你自己复制或删除。' : ''}`,
      buttons: ['选择目录…', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    log(`[data-root] 引导弹窗 response=${response} 等待=${Date.now() - askedAt}ms`);
    if (response !== 0) return false;
    // defaultPath 只作为选择框的初始浏览位置，不再提供「直接使用默认目录」的入口
    const picked = dialog.showOpenDialogSync({
      title: '选择数据目录',
      defaultPath: suggested,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!picked || !picked.length) continue;
    const dir = picked[0];
    log(`[data-root] 选定目录 ${dir}`);
    const check = dataRoot.validate(dir, { appDir: PROGRAM_ROOT, appDataBase: APP_DATA_BASE, appName: APP_NAME });
    if (!check.ok) {
      log(`[data-root] 目录校验失败 ${check.error}`);
      dialog.showErrorBox('目录不可用', check.error);
      continue;
    }
    if (!check.fresh) {
      const sure = dialog.showMessageBoxSync({
        type: 'question',
        title: '确认目录',
        message: '该目录不是空的',
        detail: `目录里已有文件，但没有本程序的数据标记：\n${dir}\n\n继续会在里面创建 characters / plugins 等子目录，确定使用吗？`,
        buttons: ['使用该目录', '重新选择'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (sure !== 0) continue;
    }
    try {
      dataRoot.ensureMarker(dir);
      dataRoot.writePointer(APP_DATA_BASE, APP_NAME, dir);
      log(`[data-root] 已切换到 ${dir}`);
    } catch (err) {
      dialog.showErrorBox('保存失败', `无法写入数据目录：${err && err.message ? err.message : err}`);
      continue;
    }
    return true;
  }
}

// --capture-and-exit <png> [delayMs]  (headless-ish verification hook)
function parseCaptureArgs(argv) {
  const i = argv.indexOf('--capture-and-exit');
  if (i === -1) return null;
  const rawPath = argv[i + 1];
  const rawDelay = parseInt(argv[i + 2], 10);
  return {
    pngPath: rawPath
      ? path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(process.cwd(), rawPath)
      : path.join(APP_DIR, 'verify.png'),
    delayMs: Number.isFinite(rawDelay) ? rawDelay : 6000,
  };
}

const captureArg = parseCaptureArgs(process.argv);
const startPage = (() => {
  const i = process.argv.indexOf('--page');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
})();
// --tab emotion：截图验证时直接落到「动态注入」的指定页签
const startTab = (() => {
  const i = process.argv.indexOf('--tab');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
})();
const demoMode = process.argv.includes('--demo');

let win = null;
let tray = null;
let pluginHost = null;
let quitting = false;
let clickThrough = false;
let pinned = true;
const llmRequests = new Map();

// 「添加动作」是一个独立的小窗口：不盖住主窗口，可以拖到任意位置。
const PANEL_SIZES = {
  actions: { width: 380, height: 540, title: '添加动作' },
};
const panelWindows = new Map();

// ------------------------------------------------------------------ app://
// app://si/<path> 的映射：
//   characters/...  → <DataRoot>/characters/...（外部角色包）
//   其余            → <SI_ROOT>/...
// 这样渲染层和内核都用同一个源，外部角色的相对路径（./vendor、./assets）也能正常加载。
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const isCharacter = rel === 'characters' || rel.startsWith('characters/');
      if (isCharacter && !DATA_ROOT) return new Response('not found', { status: 404 });
      const base = isCharacter ? path.join(DATA_ROOT, 'characters') : SI_ROOT;
      const sub = rel.startsWith('characters/') ? rel.slice('characters/'.length) : rel;
      const root = path.resolve(base);
      const file = path.resolve(root, sub);
      if (file !== root && !file.startsWith(root + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    } catch (err) {
      log('[app://] failed', request.url, err && err.message ? err.message : String(err));
      return new Response('internal error', { status: 500 });
    }
  });
}

// ------------------------------------------------------------------ window
// 背景外观：毛玻璃要用系统窗口材质（acrylic / mica），必须创建成不透明窗口；
// 而全透明桌宠模式又必须是 transparent 窗口。两者互斥，只能启动时定，切换后重启生效。
const APPEARANCE_FILE = path.join(PROFILE_DIR, 'appearance.json');
const BG_MODES = new Set(['dark', 'frosted', 'glass', 'clear']);
const GLASS_MATERIALS = new Set(['acrylic', 'mica']);

// 系统材质（亚克力 / 云母）只有 Windows 11 22H2（build 22621）及以上支持；
// Win10 上 backgroundMaterial 会被忽略，窗口也不能是系统材质窗口，
// 这时退回普通透明窗口，由渲染层画半透明模糊兜底。
const MATERIAL_OK = (() => {
  if (process.platform !== 'win32') return false;
  // os.release() 在 Windows 上形如 10.0.22631，构建号是第三段
  const build = Number(os.release().split('.')[2] || 0);
  return build >= 22621;
})();

function normalizeAppearance(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const background = BG_MODES.has(src.background) ? src.background : 'dark';
  const glassMaterial = GLASS_MATERIALS.has(src.glassMaterial) ? src.glassMaterial : 'acrylic';
  let glassOpacity = Number(src.glassOpacity);
  if (!Number.isFinite(glassOpacity)) glassOpacity = 0.45;
  glassOpacity = Math.min(0.85, Math.max(0.1, glassOpacity));
  return { background, glassMaterial, glassOpacity };
}

function readAppearance() {
  try {
    return normalizeAppearance(JSON.parse(fs.readFileSync(APPEARANCE_FILE, 'utf8')));
  } catch (_) {
    return normalizeAppearance(null);
  }
}

let appearance = readAppearance();
// 当前窗口是不是毛玻璃材质：渲染层据此判断切换背景要不要提示重启
let windowGlass = false;

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const x = Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2);
  const y = Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 2);
  const glass = appearance.background === 'glass' && MATERIAL_OK;
  windowGlass = glass;

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 440,
    minHeight: 520,
    x,
    y,
    frame: false,
    // 毛玻璃必须不透明窗口 + 系统材质；其余模式保持透明，全透明才能镂空
    transparent: !glass,
    backgroundColor: '#00000000',
    ...(glass ? { backgroundMaterial: appearance.glassMaterial } : {}),
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    resizable: true,
    // 透明窗口是方形的，系统投影会沿着方形边界画在窗口内侧，
    // 页面四角是圆角，透出来的方形投影看着就像"没裁掉的直角"，所以透明窗口不要投影。
    // 毛玻璃是不透明窗口，圆角和投影都由系统按真实形状绘制，保留投影。
    hasShadow: glass,
    alwaysOnTop: pinned,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(APP_DIR, 'preload.js'),
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  if (pinned) win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(false);

  const wc = win.webContents;
  wc.on('console-message', (...args) => {
    if (args.length >= 5) {
      const [, level, message, line, sourceId] = args;
      log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    } else if (args[0] && typeof args[0] === 'object') {
      const d = args[0];
      log(`[renderer:${d.level || '?'}] ${d.message || ''} (${d.sourceId || ''}:${d.line || ''})`);
    }
  });
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    log(`[did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  wc.on('render-process-gone', (_e, details) => log(`[render-process-gone] ${JSON.stringify(details)}`));
  wc.on('preload-error', (_e, preloadPath, error) => {
    log(`[preload-error] ${preloadPath} ${error && error.stack ? error.stack : error}`);
  });

  win.on('close', (e) => {
    // 常驻托盘：点标题栏 ✕ 只是收起，真正退出走托盘右键菜单
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
  });

  // 收起到托盘（hide）时通知渲染层停渲染；最小化到任务栏故意不通知（保持渲染）
  // （webPreferences 里 backgroundThrottling:false，页面不会自己变成 hidden，必须由主进程告知）
  const notifyBackground = (hidden) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('window:background', hidden);
  };
  win.on('hide', () => {
    setPanelsVisible(false);
    notifyBackground(true);
  });
  win.on('show', () => {
    setPanelsVisible(true);
    notifyBackground(false);
  });
  // 窗口一旦回到前台，任务栏闪烁立即停止
  win.on('focus', () => {
    if (win && !win.isDestroyed()) win.flashFrame(false);
  });

  win.on('closed', () => {
    for (const controller of llmRequests.values()) controller.abort();
    llmRequests.clear();
    closePanelWindows();
    win = null;
  });

  win.once('ready-to-show', () => win.showInactive());

  const params = new URLSearchParams();
  if (startPage) params.set('page', startPage);
  if (startTab) params.set('tab', startTab);
  if (demoMode) params.set('demo', '1');
  const targetUrl = params.toString() ? `${RENDERER_URL}?${params.toString()}` : RENDERER_URL;
  win
    .loadURL(targetUrl)
    .then(() => log('loaded', targetUrl))
    .catch((err) => log('[loadURL failed]', err && err.stack ? err.stack : String(err)));

  if (captureArg) win.showInactive();
}

// ------------------------------------------------------------------ 托盘
function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// 后台回复通知：只有窗口不在前台时才弹（最小化 / 收进托盘 / 切到别的程序）。
// 同时闪任务栏图标，窗口重新获得焦点时自动停止；点通知直接把窗口调出来。
function notifyReply(payload) {
  if (!win || win.isDestroyed() || win.isFocused()) return false;
  const title = String((payload && payload.title) || '').trim().slice(0, 64) || '新消息';
  const body = String((payload && payload.body) || '').trim().slice(0, 180);
  try {
    const notice = new Notification({ title, body });
    notice.on('click', () => showWindow());
    notice.show();
  } catch (err) {
    log('[notify] failed', err && err.message ? err.message : String(err));
  }
  if (win.isMinimized()) win.flashFrame(true);
  return true;
}

// ------------------------------------------------------------------ 独立面板窗口
function panelUrl(kind) {
  return `${RENDERER_URL}?panel=${encodeURIComponent(kind)}`;
}

// 默认摆到主窗口右侧；右边放不下就换左边，两边都放不下再居中。
function panelPosition(size) {
  const anchor = win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().workArea;
  const area = screen.getDisplayMatching(anchor).workArea;
  let x = anchor.x + anchor.width + 16;
  if (x + size.width > area.x + area.width) x = anchor.x - size.width - 16;
  if (x < area.x) x = area.x + Math.round((area.width - size.width) / 2);
  const y = Math.min(anchor.y + 40, area.y + area.height - size.height);
  return { x: Math.round(x), y: Math.round(y) };
}

function createPanelWindow(kind) {
  const size = PANEL_SIZES[kind];
  if (!size) return null;

  const existing = panelWindows.get(kind);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const pos = panelPosition(size);
  const panel = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    minWidth: Math.min(size.width, 320),
    minHeight: 260,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    resizable: true,
    // 同样是透明窗口，带投影会在四角露出方形边界
    hasShadow: false,
    skipTaskbar: false,
    title: size.title,
    alwaysOnTop: pinned,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(APP_DIR, 'preload.js'),
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  // 主窗口是置顶的，面板要同层才不会一开始就被主窗口盖住
  if (pinned) panel.setAlwaysOnTop(true, 'screen-saver');

  panelWindows.set(kind, panel);
  panel.once('ready-to-show', () => panel.show());
  panel.on('closed', () => {
    if (panelWindows.get(kind) === panel) panelWindows.delete(kind);
  });
  panel.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`[panel:${kind}] did-fail-load ${code} ${desc} ${url}`);
  });
  panel.webContents.on('render-process-gone', (_e, details) =>
    log(`[panel:${kind}] render-process-gone ${JSON.stringify(details)}`)
  );

  panel
    .loadURL(panelUrl(kind))
    .then(() => log(`panel ${kind} loaded`, panelUrl(kind)))
    .catch((err) => log(`[panel:${kind}] loadURL failed`, err && err.message ? err.message : String(err)));
  return panel;
}

function closePanelWindows() {
  for (const panel of panelWindows.values()) {
    if (!panel.isDestroyed()) panel.destroy();
  }
  panelWindows.clear();
}

function setPanelsVisible(visible) {
  for (const panel of panelWindows.values()) {
    if (panel.isDestroyed()) continue;
    if (visible) panel.showInactive();
    else panel.hide();
  }
}

// 主进程主动让渲染层做点事（托盘菜单「设置」、以后其它菜单项也能复用）
function sendUiCommand(channel) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc.isLoading()) {
    wc.send(channel);
    return;
  }
  wc.once('did-finish-load', () => {
    if (win && !win.isDestroyed()) wc.send(channel);
  });
}

function createTray() {
  if (tray || !fs.existsSync(ICON_PATH)) return tray;
  const image = nativeImage.createFromPath(ICON_PATH);
  if (image.isEmpty()) return tray;
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_CONFIG.appName || APP_CONFIG.active.name || '');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => (win && win.isVisible() ? win.hide() : showWindow()) },
      { label: '显示 / 隐藏工具栏', click: () => { showWindow(); sendUiCommand('ui:toggle-toolbar'); } },
      { label: '设置', click: () => { showWindow(); sendUiCommand('ui:open-settings'); } },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on('click', () => (win && win.isVisible() ? win.hide() : showWindow()));
  return tray;
}

function setClickThrough(enabled) {
  clickThrough = !!enabled;
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    win.webContents.send('pet:clickthrough', clickThrough);
  }
  log(`click-through=${clickThrough}`);
  return clickThrough;
}

function setPinned(enabled) {
  pinned = !!enabled;
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(pinned, pinned ? 'screen-saver' : 'normal');
    win.webContents.send('pet:pinned', pinned);
  }
  for (const panel of panelWindows.values()) {
    if (!panel.isDestroyed()) panel.setAlwaysOnTop(pinned, pinned ? 'screen-saver' : 'normal');
  }
  return pinned;
}

async function captureTo(pngPath) {
  if (!win || win.isDestroyed()) throw new Error('no window to capture');
  const dest = path.isAbsolute(pngPath) ? pngPath : path.resolve(process.cwd(), pngPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.writeFileSync(dest, png);
  const size = image.getSize();
  log(`captured ${dest} ${size.width}x${size.height} ${png.length} bytes`);
  return { ok: true, path: dest, bytes: png.length, width: size.width, height: size.height };
}

// ------------------------------------------------------------------ 扩展：内核 / 动作
function safeName(input) {
  return String(input || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 从 GLB 的 JSON chunk 读取动作元数据；和 tools/inject-clip-meta.js 的约定一致。
function readGlbActionMeta(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是合法的 GLB 文件');
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB 缺少 JSON chunk');
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const anim = (json.animations || [])[0];
  if (!anim) throw new Error('GLB 里没有动画');

  const extras = anim.extras || {};
  const base = path.basename(file, path.extname(file));
  const rawName = extras.name || base.replace(/^a_actor_[a-z0-9]+_/i, '');
  const name = safeName(rawName).replace(/\./g, '_');
  if (!name) throw new Error('无法从文件推断动作名');

  let duration = typeof extras.duration === 'number' ? extras.duration : 0;
  if (!duration) {
    for (const sampler of anim.samplers || []) {
      const acc = (json.accessors || [])[sampler.input];
      if (acc && Array.isArray(acc.max) && typeof acc.max[0] === 'number') {
        duration = Math.max(duration, acc.max[0]);
      }
    }
  }
  const loop =
    typeof extras.loop === 'boolean' ? Boolean(extras.loop && !extras.oneshot) : /_loop$/.test(name);

  return { name, duration: +Number(duration || 0).toFixed(4), loop };
}

// ------------------------------------------------------------------ 内核清单
// 每个内核目录带一份 kernel.json：id / entry / version / sha256。
// 目录结构：<角色>/kernel/{poc,assets,vendor,tools}，内核目录就是一个完整内核；
// 同一内核可以并排放多条渲染管线（poc = WebGL，poc2/poc4 = WebGPU 等），共用 assets/vendor。
// 哈希只覆盖内核代码（assets 是几百 MB 的模型资源，不参与哈希，避免每次启动都扫盘）。
const KERNEL_MANIFEST_NAME = 'kernel.json';
let ACTIVE_KERNEL_ENTRY = APP_CONFIG.kernel.entry;
let ACTIVE_KERNEL_VERSION = APP_CONFIG.kernel.version;

// 切换角色：重算所有由角色派生的值（动作目录 / 动作清单 / 内核入口 / 语音与记忆配置）
function applyActiveCharacter() {
  APP_CONFIG = loadAppConfig();
  CLIP_DIR = APP_CONFIG.clipDir;
  ACTION_INDEX = APP_CONFIG.actionsIndex;
  ACTIVE_KERNEL_ENTRY = APP_CONFIG.kernel.entry;
  ACTIVE_KERNEL_VERSION = APP_CONFIG.kernel.version;
}

function listKernelFiles(root) {
  const files = [];
  const skipDirs = new Set(['node_modules', '.git', 'assets']);
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (_) {
        continue;
      }
      if (stat.isSymbolicLink()) continue; // junction/软链（assets）不算内核内容
      if (stat.isDirectory()) {
        if (!skipDirs.has(ent.name)) visit(full);
        continue;
      }
      if (!stat.isFile() || ent.name === KERNEL_MANIFEST_NAME) continue; // 清单不参与哈希，避免自我引用
      files.push({
        rel: path.relative(root, full).split(path.sep).join('/'),
        full,
        size: stat.size,
      });
    }
  };
  visit(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function hashKernelDir(dir) {
  const files = listKernelFiles(dir);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const item of files) {
    bytes += item.size;
    hash.update(`${item.rel}\0`);
    try {
      hash.update(await fileSha256(item.full));
    } catch (_) {
      hash.update('unreadable');
    }
    hash.update('\n');
  }
  return { sha256: hash.digest('hex'), files: files.length, bytes };
}

// entry 形如 'characters/<id>/kernel/poc/index.html'，内核根在角色目录里。
// 内核根 = 从入口文件所在目录逐级向上找到的第一份 kernel.json；
// 新内核还没写过清单时，回落到角色目录本身。
function resolveKernelEntry(entry) {
  const rel = String(entry || ACTIVE_KERNEL_ENTRY).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return { dir: '', fallbackId: '', entry: '' };
  const parts = rel.split('/');
  const walkUp = (startDir, stopDir) => {
    let cur = startDir;
    while (cur.startsWith(stopDir + path.sep)) {
      if (fs.existsSync(path.join(cur, KERNEL_MANIFEST_NAME))) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return '';
  };
  if (parts[0] === 'characters' && parts[1] && DATA_ROOT) {
    const charRoot = path.join(DATA_ROOT, 'characters');
    const entryFile = path.resolve(charRoot, ...parts.slice(1));
    let dir = '';
    if (entryFile.startsWith(charRoot + path.sep)) {
      dir = walkUp(path.dirname(entryFile), charRoot);
      if (!dir) dir = path.join(charRoot, parts[1]);
    }
    return { dir, fallbackId: parts[1], entry: rel };
  }
  // 角色资产只可能落在 characters/ 下；其他路径没有内核可言
  return { dir: '', fallbackId: '', entry: rel };
}

async function writeKernelManifest(entry, { name, version } = {}) {
  const target = resolveKernelEntry(entry);
  if (!fs.existsSync(target.dir)) return null;
  const manifestPath = path.join(target.dir, KERNEL_MANIFEST_NAME);
  const prev = readJsonSafe(manifestPath) || {};
  const digest = await hashKernelDir(target.dir);
  // kernel.json 用「相对内核目录」的入口，角色包整体移动后仍然有效
  const entryAbs = appPathToFile(target.entry);
  const entryOut = entryAbs ? path.relative(target.dir, entryAbs).split(path.sep).join('/') : target.entry;
  const manifest = {
    ...prev,
    id: prev.id || target.fallbackId,
    name: name || prev.name || APP_CONFIG.kernel.name || path.basename(target.dir),
    entry: entryOut,
    version: version || prev.version || '0.0.0',
    sha256: digest.sha256,
    files: digest.files,
    bytes: digest.bytes,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

// 读清单；缺失或文件已被改动（哈希对不上）时重算并回写。
async function kernelManifest(entry, defaults = {}) {
  const target = resolveKernelEntry(entry);
  if (!fs.existsSync(target.dir)) return { ok: false, error: '内核目录不存在' };
  const prev = readJsonSafe(path.join(target.dir, KERNEL_MANIFEST_NAME));
  const fallback = { name: prev && prev.name, version: defaults.version || (prev && prev.version) };
  if (!prev || !prev.sha256) {
    const manifest = await writeKernelManifest(target.entry, fallback);
    return manifest ? { ok: true, ...manifest } : { ok: false, error: '清单写入失败' };
  }
  const digest = await hashKernelDir(target.dir);
  const versionChanged = !!defaults.version && prev.version !== defaults.version;
  if (digest.sha256 !== prev.sha256 || versionChanged) {
    const manifest = await writeKernelManifest(target.entry, fallback);
    return manifest ? { ok: true, ...manifest, changed: true } : { ok: false, error: '清单写入失败' };
  }
  return { ok: true, ...prev };
}

async function ensureActiveKernelManifest() {
  if (!ACTIVE_KERNEL_ENTRY) return;
  try {
    const info = await kernelManifest(ACTIVE_KERNEL_ENTRY, { version: ACTIVE_KERNEL_VERSION });
    if (info && info.ok) {
      log(`[kernel] active v${info.version} sha256=${String(info.sha256).slice(0, 12)}`);
    } else {
      log('[kernel] manifest failed', (info && info.error) || '');
    }
  } catch (err) {
    log('[kernel] manifest failed', err && err.message ? err.message : String(err));
  }
}

// ------------------------------------------------------------------ 任务中心
// 设置页底部那根共用进度条：所有耗时任务（下载 / 解压 / 启动服务 / 合成）都登记到这里，
// 谁在跑就显示谁，结束后自动消失。渲染层只负责画画，不关心任务是什么。
const tasks = new Map();
let taskSeq = 0;

function taskSnapshot(task) {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail || '',
    status: task.status,
    percent: task.percent,
    received: task.received,
    total: task.total,
    cancelable: !!task.cancelable,
    startedAt: task.startedAt,
  };
}

function broadcastTask(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('task:update', payload);
  }
}

function taskStart(title, { detail = '', total = 0, cancelable = false } = {}) {
  const task = {
    id: `t${++taskSeq}`,
    title,
    detail,
    status: 'running',
    percent: null,
    received: 0,
    total,
    cancelable,
    startedAt: Date.now(),
    abort: null,
  };
  tasks.set(task.id, task);
  broadcastTask({ kind: 'update', task: taskSnapshot(task) });
  return task;
}

function taskUpdate(id, patch = {}) {
  const task = tasks.get(id);
  if (!task) return;
  Object.assign(task, patch);
  if (patch.total || patch.received) {
    const total = Number(task.total) || 0;
    const received = Number(task.received) || 0;
    task.percent = total > 0 ? Math.max(0, Math.min(100, Math.round((received / total) * 100))) : null;
  }
  broadcastTask({ kind: 'update', task: taskSnapshot(task) });
}

function taskFinish(id, { ok = true, detail = '' } = {}) {
  const task = tasks.get(id);
  if (!task) return;
  // 取消后底层报错会再次调用 taskFinish，已经结束的任务不再改写，保留「已取消」
  if (task.status !== 'running') return;
  task.status = ok ? 'done' : 'error';
  task.percent = ok ? 100 : task.percent;
  if (detail) task.detail = detail;
  task.cancelable = false;
  task.abort = null;
  broadcastTask({ kind: 'update', task: taskSnapshot(task) });
  // 完成态留一会儿让用户看到结果，再从列表里移除
  setTimeout(() => {
    if (!tasks.has(id)) return;
    tasks.delete(id);
    broadcastTask({ kind: 'gone', id });
  }, 4200);
}

function taskCancel(id) {
  const task = tasks.get(id);
  if (!task || !task.cancelable) return false;
  try {
    if (task.abort) task.abort.abort();
  } catch (_) {
    /* 已经结束 */
  }
  taskFinish(id, { ok: false, detail: '已取消' });
  return true;
}

function taskList() {
  return [...tasks.values()].filter((t) => t.status === 'running').map(taskSnapshot);
}

// ------------------------------------------------------------------ 长程记忆
// Worker 懒启动：第一次真正调用记忆 API 时才建线程；embedding 模型也是这时才按需下载。
let memoryHost = null;

// 记忆分库：每个角色一份 memory.db，放在角色目录里
function memoryDbPath() {
  const active = APP_CONFIG.active;
  if (active && active.dir) {
    try {
      fs.mkdirSync(active.dir, { recursive: true });
    } catch (_) {
      /* 目录建不出来时 createMemoryHost 会报错，不影响其他功能 */
    }
    return path.join(active.dir, 'memory.db');
  }
  return path.join(DATA_ROOT || PROFILE_DIR, 'memory.db');
}

function getMemoryHost() {
  if (!memoryHost) {
    memoryHost = createMemoryHost({
      appDir: APP_DIR,
      dbPath: memoryDbPath(),
      modelDir: MEMORY_MODEL_DIR,
      sources: APP_CONFIG.memory.sources,
      files: APP_CONFIG.memory.files,
      charName: APP_CONFIG.active.name || '',
      fetchToFile,
      taskStart,
      taskUpdate,
      taskFinish,
      log,
    });
  }
  return memoryHost;
}

const MEMORY_COMMANDS = new Set([
  'embed',
  'retrieve',
  'upsertFacts',
  'search',
  'searchVector',
  'searchText',
  'list',
  'stats',
  'reset',
  'upsert',
  'addVector',
  'delete',
  'pin',
  'dedupe',
  'settle',
]);

// ------------------------------------------------------------------ 语音输入（sherpa-onnx）
// 渲染层录 16k 单声道 WAV 传进来，这里落临时文件、spawn sherpa-onnx-vad-with-offline-asr 转写，
// 再把纯文本回传。用 VAD + 非流式模型那一支：长录音会被 Silero VAD 自动切段，不用整段一次喂。
const VOICE_BIN_NAME = 'sherpa-onnx-vad-with-offline-asr.exe';
const VOICE_BIN_CANDIDATES = [VOICE_BIN_NAME, path.join('bin', VOICE_BIN_NAME)];

function firstExistingFile(files) {
  for (const file of files) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch (_) {
      /* 继续找下一个 */
    }
  }
  return '';
}

// 模型清单来自 components.json；切换角色不影响这份配置，但每次现读，方便用户手改后重新检测
function asrModelSpec() {
  const model = APP_CONFIG.asr.model || {};
  return Array.isArray(model.files) ? model.files.filter((f) => f && f.path) : [];
}

function asrModelPath(name) {
  return path.join(VOICE_MODEL_DIR, name);
}

function findVoiceBin() {
  const candidates = VOICE_BIN_CANDIDATES.map((rel) => path.join(VOICE_DIR, rel));
  // 解压后可能带版本号目录（bin/ 在更深一层），兜底按文件名递归找
  candidates.push(...findFilesDeep(VOICE_DIR, /^sherpa-onnx-vad-with-offline-asr\.exe$/i));
  return firstExistingFile(candidates);
}

function findVoiceModel() {
  const main = asrModelSpec().find((f) => /^model(\.int8)?\.onnx$/i.test(f.path));
  if (!main) return '';
  const file = asrModelPath(main.path);
  try {
    return fs.statSync(file).isFile() ? file : '';
  } catch (_) {
    return '';
  }
}

function listVoiceModels() {
  const model = findVoiceModel();
  if (!model) return [];
  let size = 0;
  try {
    size = fs.statSync(model).size;
  } catch (_) {
    /* 拿不到大小就不显示 */
  }
  return [{ name: 'SenseVoiceSmall int8', size, file: path.basename(model) }];
}

function asrMissingFiles() {
  return asrModelSpec().filter((f) => {
    try {
      return !fs.statSync(asrModelPath(f.path)).isFile();
    } catch (_) {
      return true;
    }
  });
}

function voiceStatus() {
  const bin = findVoiceBin();
  const model = findVoiceModel();
  const missing = asrMissingFiles().map((f) => f.path);
  return {
    ok: !!bin && !missing.length,
    bin,
    model,
    models: listVoiceModels(),
    missing,
    dir: VOICE_DIR,
    modelDir: VOICE_MODEL_DIR,
  };
}

// ------------------------------------------------------------------ 下载 / 解压（语音组件按需安装）
function fetchToFile(url, dest, { onProgress, signal } = {}) {
  return new Promise(async (resolve, reject) => {
    let res;
    try {
      res = await net.fetch(url, {
        headers: { 'User-Agent': 'si-desktop' },
        signal,
      });
    } catch (err) {
      reject(err);
      return;
    }
    if (!res.ok) {
      reject(new Error(`下载失败（HTTP ${res.status}）`));
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const total = Number(res.headers.get('content-length') || 0);
    const reader = res.body.getReader();
    const out = fs.createWriteStream(dest);
    let received = 0;
    const finished = new Promise((ok, fail) => {
      out.on('finish', ok);
      out.on('error', fail);
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!out.write(Buffer.from(value))) {
          await new Promise((r) => out.once('drain', r));
        }
        if (onProgress) onProgress(received, total);
      }
      out.end();
      await finished;
      resolve({ bytes: received, total });
    } catch (err) {
      out.destroy();
      reject(err);
    }
  });
}

// 用系统自带的 tar（bsdtar 支持 zip）解压；没有 tar 时退回 PowerShell 的 Expand-Archive
function extractZip(zipFile, destDir) {
  return new Promise((resolve) => {
    fs.mkdirSync(destDir, { recursive: true });
    const run = (cmd, args, onFail) => {
      const child = spawn(cmd, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (c) => {
        err += c.toString();
      });
      child.on('error', () => onFail && onFail());
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else if (onFail) onFail(err);
        else resolve({ ok: false, error: `解压失败（${code}）：${err.trim().split(/\r?\n/).slice(-2).join(' ')}` });
      });
    };
    run('tar', ['-xf', zipFile, '-C', destDir], () =>
      run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        (err) => resolve({ ok: false, error: `解压失败：${String(err || '').trim() || '系统里没有可用的解压工具'}` }),
      ),
    );
  });
}

function copyDirMerge(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirMerge(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

// 解压出来的东西常常多包一层文件夹（sherpa-onnx-vX-win-x64/、si_tts/…），这里把唯一的一层壳剥掉
function unwrapSingleRoot(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return dir;
  }
  const real = entries.filter((e) => !e.name.startsWith('.'));
  if (real.length === 1 && real[0].isDirectory()) return unwrapSingleRoot(path.join(dir, real[0].name));
  return dir;
}

function findFilesDeep(dir, re, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) findFilesDeep(full, re, out);
    else if (ent.isFile() && re.test(ent.name)) out.push(full);
  }
  return out;
}

// 下载源按顺序尝试：先直连，再走镜像前缀（gh-proxy 这类）
function expandSources(sources, url, proxies) {
  const list = (Array.isArray(sources) ? sources : []).filter(Boolean).map(String);
  if (url) list.push(String(url));
  for (const raw of Array.isArray(proxies) ? proxies : []) {
    const prefix = String(raw || '').trim();
    if (!prefix || !url) continue;
    list.push(`${prefix.replace(/\/+$/, '')}/${url}`);
  }
  return list;
}

async function downloadFirstOk(sources, dest, { signal, onProgress } = {}) {
  let lastErr = null;
  for (const url of sources) {
    if (signal && signal.aborted) throw new Error('已取消');
    try {
      return await fetchToFile(url, dest, { signal, onProgress });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      lastErr = err;
      try {
        fs.unlinkSync(dest);
      } catch (_) {
        /* 半截文件可能没创建 */
      }
    }
  }
  throw lastErr || new Error('没有可用的下载源');
}

// 语音识别：引擎（sherpa-onnx 官方 release）和模型（SenseVoice int8 + Silero VAD）都走下载，
// 也可以直接导入组件包；两者都缺时按顺序补齐，已有的跳过。
async function installAsr({ force = false } = {}) {
  const engine = APP_CONFIG.asr.engine || {};
  const status0 = voiceStatus();
  const needBin = force || !status0.bin;
  const missing = force ? asrModelSpec() : asrMissingFiles();
  if (!needBin && !missing.length) return { ok: true, status: status0 };

  // 引擎
  if (needBin) {
    const engineName = engine.file || path.basename(String(engine.url || '')) || 'sherpa-onnx';
    const task = taskStart('正在下载 语音识别引擎', { detail: engineName, cancelable: true });
    const controller = new AbortController();
    task.abort = controller;
    const tmpFile = path.join(os.tmpdir(), `si-asr-engine-${Date.now()}-${engineName}`);
    const tmpDir = path.join(os.tmpdir(), `si-asr-engine-dir-${Date.now()}`);
    try {
      const sources = expandSources([], engine.url, engine.proxies);
      if (!sources.length) throw new Error('components.json 里没有配置语音识别引擎的下载源');
      taskUpdate(task.id, { total: Number(engine.bytes) || 0 });
      await downloadFirstOk(sources, tmpFile, {
        signal: controller.signal,
        onProgress: (received, total) =>
          taskUpdate(task.id, { received, total: total || Number(engine.bytes) || 0 }),
      });
      taskUpdate(task.id, { detail: '正在解压引擎', percent: null });
      // 系统 tar（bsdtar）既能解 .zip 也能解 .tar.bz2
      const un = await extractZip(tmpFile, tmpDir);
      if (!un.ok) throw new Error(un.error || '解压引擎失败');
      // 发行包通常多包一层同名目录，剥掉后合并进 si/voice/asr（bin/ 和 lib/ 一起带过来）
      copyDirMerge(unwrapSingleRoot(tmpDir), VOICE_DIR);
      if (!findVoiceBin()) throw new Error('引擎包里没找到 sherpa-onnx-vad-with-offline-asr.exe');
      taskFinish(task.id, { ok: true, detail: '引擎已就绪' });
    } catch (err) {
      taskFinish(task.id, { ok: false, detail: String(err && err.message ? err.message : err) });
      return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
      for (const target of [tmpFile, tmpDir]) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch (_) {
          /* 临时文件可能没写出来 */
        }
      }
    }
  }

  // 模型：逐个文件下载，进度按总字节累加
  if (missing.length) {
    const total = missing.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0);
    const task = taskStart('正在下载 语音识别模型', { detail: 'SenseVoiceSmall int8', cancelable: true });
    const controller = new AbortController();
    task.abort = controller;
    try {
      taskUpdate(task.id, { total });
      let done = 0;
      for (const file of missing) {
        const sources = expandSources(file.sources, file.url, file.proxies);
        if (!sources.length) throw new Error(`components.json 里没有配置 ${file.path} 的下载源`);
        taskUpdate(task.id, { detail: file.path });
        fs.mkdirSync(VOICE_MODEL_DIR, { recursive: true });
        const dest = asrModelPath(file.path);
        const part = `${dest}.part`;
        const res = await downloadFirstOk(sources, part, {
          signal: controller.signal,
          onProgress: (received) => taskUpdate(task.id, { received: done + received, total }),
        });
        fs.renameSync(part, dest);
        done += Number(file.bytes) || (res && res.bytes) || 0;
        taskUpdate(task.id, { received: done, total });
      }
      taskFinish(task.id, { ok: true, detail: '模型已就绪' });
    } catch (err) {
      taskFinish(task.id, { ok: false, detail: String(err && err.message ? err.message : err) });
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  const status = voiceStatus();
  return { ok: status.ok, status };
}

// 导入组件包：引擎包（sherpa-onnx 发行包）或模型包（model.int8.onnx / tokens.txt / silero_vad.onnx）
async function importVoiceZip() {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口尚未就绪' };
  const picked = await dialog.showOpenDialog(win, {
    title: '选择 sherpa-onnx 引擎包或 SenseVoice 模型包',
    properties: ['openFile'],
    filters: [{ name: '组件包', extensions: ['zip', 'tar', 'bz2', 'tgz', 'gz'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

  const zipFile = picked.filePaths[0];
  const task = taskStart(`正在解压 ${path.basename(zipFile)}`);
  const tmp = path.join(os.tmpdir(), `si-unzip-${Date.now()}`);
  try {
    const un = await extractZip(zipFile, tmp);
    if (!un.ok) throw new Error(un.error || '解压失败');

    // 带 SenseVoice 模型文件的包进 models/；没有模型文件就按引擎包平铺到 si/voice/asr
    const modelHits = findFilesDeep(tmp, /^(model(\.int8)?\.onnx|tokens\.txt|silero_vad\.onnx)$/i);
    if (modelHits.length) {
      fs.mkdirSync(VOICE_MODEL_DIR, { recursive: true });
      for (const file of modelHits) fs.copyFileSync(file, path.join(VOICE_MODEL_DIR, path.basename(file)));
    } else {
      copyDirMerge(unwrapSingleRoot(tmp), VOICE_DIR);
    }

    const files = voiceStatus();
    const detail = files.ok ? '已就绪' : files.missing.length ? `还缺：${files.missing.join(' / ')}` : '还缺引擎或模型';
    taskFinish(task.id, { ok: files.ok, detail });
    return { ok: files.ok, missing: files.missing, status: files };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    taskFinish(task.id, { ok: false, detail: message });
    return { ok: false, error: message };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* 临时目录清不掉不影响结果 */
    }
  }
}

// 转写结果理论上已是简体，这里仍用离线字表兜底：词组优先（乾隆 / 乾坤这类简繁同形的词不能被单字表改坏）。
let t2sTable = null;
function loadT2sTable() {
  if (t2sTable) return t2sTable;
  try {
    const raw = JSON.parse(fs.readFileSync(T2S_FILE, 'utf8'));
    const phrases = Array.isArray(raw.phrases)
      ? raw.phrases.filter((p) => Array.isArray(p) && p.length === 2 && p[0] && p[1])
      : [];
    t2sTable = {
      phrases: phrases.slice().sort((a, b) => b[0].length - a[0].length),
      chars: raw.chars && typeof raw.chars === 'object' ? raw.chars : {},
    };
  } catch (err) {
    log('[voice] t2s 表读取失败，跳过繁转简', err && err.message ? err.message : String(err));
    t2sTable = { phrases: [], chars: {} };
  }
  return t2sTable;
}

function toSimplified(text) {
  const src = String(text || '');
  if (!src) return src;
  const table = loadT2sTable();
  let out = '';
  for (let i = 0; i < src.length; ) {
    let hit = null;
    for (const pair of table.phrases) {
      if (src.startsWith(pair[0], i)) {
        hit = pair;
        break;
      }
    }
    if (hit) {
      out += hit[1];
      i += hit[0].length;
      continue;
    }
    const ch = src[i];
    out += table.chars[ch] || ch;
    i += 1;
  }
  return out;
}

// sherpa-onnx 每段结果打成「start -- end: 文本」一行，其他都是加载日志，只挑这种行
const ASR_LINE_RE = /^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?):\s*(.+?)\s*$/;

function collectAsrText(output) {
  const segments = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = line.match(ASR_LINE_RE);
    if (!m) continue;
    const text = m[3].trim();
    if (text) segments.push(text);
  }
  if (!segments.length) return '';
  // 中日韩句子不需要空格拼接，英文/数字之间要留空格
  const cjk = segments.some((s) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(s));
  return segments.join(cjk ? '' : ' ');
}

function transcribeWav(bytes, _modelFile) {
  return new Promise((resolve) => {
    const status = voiceStatus();
    if (!status.bin) {
      resolve({
        ok: false,
        error: `未找到 sherpa-onnx 引擎（${VOICE_BIN_NAME}），请在设置 → 语音里下载，或把引擎包导入 si/voice/asr/`,
      });
      return;
    }
    const missing = asrMissingFiles().map((f) => f.path);
    const tokens = asrModelPath('tokens.txt');
    const vad = asrModelPath('silero_vad.onnx');
    if (!status.model || missing.length) {
      resolve({
        ok: false,
        error: `未找到 SenseVoice 模型${missing.length ? `（缺 ${missing.join(' / ')}）` : ''}，请在设置 → 语音里下载，或把模型文件放进 si/voice/asr/models/`,
      });
      return;
    }

    const stamp = `si-voice-${Date.now()}-${process.pid}`;
    const wavPath = path.join(os.tmpdir(), `${stamp}.wav`);
    try {
      fs.writeFileSync(wavPath, Buffer.from(bytes));
    } catch (err) {
      resolve({ ok: false, error: `写入临时音频失败：${err && err.message ? err.message : err}` });
      return;
    }

    const threads = String(Math.max(2, Math.min(8, (os.cpus() || []).length || 4)));
    const args = [
      `--tokens=${tokens}`,
      `--sense-voice-model=${status.model}`,
      '--sense-voice-language=auto',
      '--sense-voice-use-itn=true',
      `--silero-vad-model=${vad}`,
      `--num-threads=${threads}`,
      wavPath,
    ];
    const child = spawn(status.bin, args, { cwd: path.dirname(status.bin), windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const cleanup = () => {
      try {
        fs.unlinkSync(wavPath);
      } catch (_) {
        /* 临时文件可能已被清掉 */
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* 进程可能已退出 */
      }
      finish({ ok: false, error: '转写超时（120 秒），可以缩短录音后重试' });
    }, 120000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });
    child.on('error', (err) => {
      finish({ ok: false, error: `无法启动 sherpa-onnx：${err && err.message ? err.message : err}` });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
        finish({ ok: false, error: `sherpa-onnx 异常退出（${code}）${tail ? '：' + tail : ''}` });
        return;
      }
      // 结果可能走 stdout，也可能混在 stderr 的日志里，两处都收一遍
      const text = collectAsrText(stdout) || collectAsrText(stderr);
      if (!text) {
        finish({ ok: true, text: '' });
        return;
      }
      finish({ ok: true, text: toSimplified(text) });
    });
  });
}

// ------------------------------------------------------------------ 联网搜索（web_search）
// 统一入口：provider 从 components.json 的 search 段读，现阶段支持 anysearch / mock。
// 回给模型前一定做精简：最多 N 条、每条只保留标题 / 链接 / 截断摘要，避免整页正文塞爆上下文。
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function oneLine(text, limit) {
  const s = String(text || '').replace(/[\s\u00a0]+/g, ' ').trim();
  if (!s) return '';
  return s.length > limit ? `${s.slice(0, Math.max(0, limit - 1))}…` : s;
}

// 自定义搜索供应商：用户自己改 si/app/search.providers.json 里的请求地址 / 请求头 / 请求体 / 返回字段
// 只读取 providers[0]，模板变量支持 {{query}} {{maxResults}} {{apiKey}} {{zone}} {{language}}
const CUSTOM_SEARCH_FILE = path.join(APP_DIR, 'search.providers.json');

function readJsonPath(root, pathText) {
  if (!pathText) return root;
  return String(pathText)
    .split('.')
    .filter(Boolean)
    .reduce((cur, key) => (cur == null ? cur : cur[key]), root);
}

const TEMPLATE_EXACT = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;

function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    const exact = value.match(TEMPLATE_EXACT);
    if (exact && Object.prototype.hasOwnProperty.call(vars, exact[1])) return vars[exact[1]];
    return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : match,
    );
  }
  if (Array.isArray(value)) return value.map((item) => fillTemplate(item, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = fillTemplate(item, vars);
    return out;
  }
  return value;
}

function joinSearchUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(suffix || '');
  if (!b) return s;
  if (!s) return b;
  if (/^https?:\/\//i.test(s)) return s;
  return `${b}/${s.replace(/^\/+/, '')}`;
}

function loadCustomSearchDef() {
  const raw = fs.readFileSync(CUSTOM_SEARCH_FILE, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed && parsed.providers) ? parsed.providers : [];
  const def = list[0];
  if (!def || typeof def !== 'object') throw new Error('providers[0] 不存在');
  return def;
}

// 所有供应商共用：只保留标题 / 链接 / 截断摘要，并按总字数预算裁剪
function compactResults(rawList, maxResults, maxTotalChars, fieldMap = {}) {
  const results = [];
  let budget = maxTotalChars;
  for (const item of rawList) {
    if (!item || results.length >= maxResults) break;
    const title = oneLine(readJsonPath(item, fieldMap.title || 'title'), 120) || '（无标题）';
    const url = String(readJsonPath(item, fieldMap.url || 'url') || '').trim().slice(0, 300);
    const snippetText =
      readJsonPath(item, fieldMap.snippet || 'snippet') ||
      (fieldMap.snippetFallback ? readJsonPath(item, fieldMap.snippetFallback) : '');
    const snippet = oneLine(snippetText, 260);
    const cost = title.length + url.length + snippet.length + 10;
    // 总预算用完后不再追加，宁可少一条也不把长文塞给模型
    if (results.length && budget - cost < 100) break;
    budget -= cost;
    results.push({ title, url, snippet });
  }
  return results;
}

function mockSearchResults(query, count) {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => ({
    title: `【Mock】${query} · 模拟资讯 ${i + 1}`,
    url: `https://example.com/mock-search?q=${encodeURIComponent(query)}&n=${i + 1}`,
    snippet: `这是未接入真实搜索服务时返回的假摘要，仅用于联调。关键词「${query}」，示例时间 ${now.toLocaleString('zh-CN')}。`,
  }));
}

function searchText(query, provider, items, meta = {}) {
  const head = `搜索「${query}」${items.length} 条结果（${provider}${meta.search_time_ms ? ` · ${meta.search_time_ms}ms` : ''}）：`;
  const rows = items.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  return `${head}\n\n${rows}`;
}

async function webSearch(payload) {
  const p = payload || {};
  const query = String(p.query || '').trim();
  if (!query) return { ok: false, error: 'query 不能为空' };

  const provider = String(p.provider || SEARCH_CFG.provider || 'anysearch').toLowerCase();
  const maxResults = clampInt(
    p.maxResults,
    1,
    5,
    clampInt(SEARCH_CFG.maxResults, 1, 5, 3),
  );
  const maxTotalChars = clampInt(p.maxTotalChars, 400, 4000, clampInt(SEARCH_CFG.maxTotalChars, 400, 4000, 1800));

  if (provider === 'mock') {
    const results = mockSearchResults(query, maxResults);
    const metadata = { total_results: results.length, search_time_ms: 0 };
    return { ok: true, provider, query, results, metadata, text: searchText(query, provider, results, metadata) };
  }
  if (provider === 'custom') return await customWebSearch(query, p, maxResults, maxTotalChars);
  if (provider === 'searxng') return await searxngWebSearch(query, p, maxResults, maxTotalChars);
  if (provider !== 'anysearch') {
    return { ok: false, error: `不支持的搜索服务：${provider}（可选 anysearch / searxng / mock / custom）` };
  }

  // 设置页填的供应商 / Key 优先；显式传空字符串表示「不用 Key」，走匿名免费额度
  const apiKey = String(
    p.apiKey !== undefined ? p.apiKey : SEARCH_CFG.apiKey || process.env.ANYSEARCH_API_KEY || '',
  ).trim();
  const endpoint = String(p.endpoint || SEARCH_CFG.endpoint || 'https://api.anysearch.com').replace(/\/+$/, '');
  const zone = p.zone || SEARCH_CFG.zone;
  const language = p.language || SEARCH_CFG.language;
  const timeoutMs = clampInt(p.timeoutMs, 3000, 60000, clampInt(SEARCH_CFG.timeoutMs, 3000, 60000, 20000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await net.fetch(`${endpoint}/v1/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        zone: zone || undefined,
        language: language || undefined,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = oneLine(await res.text().catch(() => ''), 200);
      const hints = {
        401: 'API Key 无效',
        402: '额度用尽',
        403: 'Key 已过期或账号被禁用',
        415: '请求头缺少 Content-Type',
        429: '请求过于频繁，请稍后再试',
      };
      const hint = hints[res.status] || '';
      return {
        ok: false,
        error: `搜索失败（HTTP ${res.status}${hint ? `，${hint}` : ''}）${detail ? `：${detail}` : ''}`,
      };
    }

    const json = await res.json();
    if (!json || json.code !== 0) {
      return { ok: false, error: `搜索失败：${(json && json.message) || '返回格式异常'}` };
    }

    const rawList = json.data && Array.isArray(json.data.results) ? json.data.results : [];
    const results = compactResults(rawList, maxResults, maxTotalChars, { snippetFallback: 'content' });

    const metadata = {
      total_results: Number(json.data && json.data.metadata && json.data.metadata.total_results) || results.length,
      search_time_ms: Number(json.data && json.data.metadata && json.data.metadata.search_time_ms) || 0,
    };
    if (!results.length) {
      return { ok: true, provider, query, results: [], metadata, text: `搜索「${query}」没有找到结果，可以换个关键词再试。` };
    }
    return { ok: true, provider, query, results, metadata, text: searchText(query, provider, results, metadata) };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    return {
      ok: false,
      error: aborted
        ? `搜索超时（${Math.round(timeoutMs / 1000)} 秒）`
        : `搜索请求失败：${err && err.message ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 图片读取（read_image 工具）
// 渲染层只把图片绝对路径交给模型；真正需要「看」时由模型调用 read_image，
// 主进程读文件、缩到最长边 ≤1568px、转 JPEG 后以 data URL 回给渲染层。
// 缓存放 userData 下（不进仓库、不进 localStorage），同一路径 + 同一 mtime 只处理一次。
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_EDGE = 1568;
const IMAGE_CACHE_DIR = path.join(app.getPath('userData'), 'image-cache');
const IMAGE_SAVE_DIR = path.join(IMAGE_CACHE_DIR, 'pasted');
// 图片虚拟别名：模型只看 [image_N]，物理路径一直留在主进程
const imageAlias = createImageAlias({ dir: path.join(DATA_ROOT || PROFILE_DIR, 'image-map'), log });
const IMAGE_EXPIRED = '图片不存在或已过期，请让用户重新上传。';

// 归档这类会持续变大的数据不再放 localStorage（只有 5MB 级容量），
// 统一落到 userData/data/<key>.json，白名单之外一律拒绝，避免渲染层乱写文件
const DATA_JSON_KEYS = new Set(['archives']);
const DATA_JSON_DIR = path.join(DATA_ROOT || PROFILE_DIR, 'data');

function dataJsonPath(key) {
  const name = String(key || '');
  if (!DATA_JSON_KEYS.has(name)) return '';
  return path.join(DATA_JSON_DIR, `${name}.json`);
}

// 路径合法性：必须是绝对路径、扩展名在白名单里、文件存在且大小可控
function inspectImagePath(raw) {
  const input = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
  if (!input) return { ok: false, error: '路径为空' };
  const file = path.resolve(input);
  if (!path.isAbsolute(input)) return { ok: false, error: '需要绝对路径' };
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return { ok: false, error: `不支持的图片格式：${ext || '(无扩展名)'}（支持 png / jpg / webp / gif / bmp）` };
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return { ok: false, error: '图片不存在或无法访问' };
  }
  if (!stat.isFile()) return { ok: false, error: '路径不是文件' };
  if (stat.size <= 0) return { ok: false, error: '图片是空文件' };
  if (stat.size > IMAGE_MAX_BYTES) {
    return { ok: false, error: `图片超过 ${Math.round(IMAGE_MAX_BYTES / (1024 * 1024))}MB 上限` };
  }
  return { ok: true, path: file, size: stat.size, mtimeMs: stat.mtimeMs };
}

function imageCacheFile(file, mtimeMs, size) {
  const hash = crypto.createHash('sha1');
  hash.update(`${file}|${mtimeMs}|${size}`);
  return path.join(IMAGE_CACHE_DIR, `${hash.digest('hex')}.jpg`);
}

function readImageDataUrl(raw) {
  const checked = inspectImagePath(raw);
  if (!checked.ok) return checked;
  const name = path.basename(checked.path);
  let cacheFile = '';
  try {
    cacheFile = imageCacheFile(checked.path, checked.mtimeMs, checked.size);
  } catch (_) {
    cacheFile = '';
  }
  // 命中缓存：直接回读，省掉解码 / 缩放
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = fs.readFileSync(cacheFile);
      return { ok: true, path: checked.path, name, bytes: cached.length, dataUrl: `data:image/jpeg;base64,${cached.toString('base64')}` };
    } catch (_) {
      /* 缓存读不出来就重新解码 */
    }
  }
  const image = nativeImage.createFromPath(checked.path);
  // nativeImage 解不了的格式（如部分 webp / bmp）：原样回传，交给模型侧解码
  if (image.isEmpty()) {
    if (checked.size > IMAGE_MAX_BYTES) return { ok: false, error: '图片过大，无法直接读取' };
    try {
      const raw = fs.readFileSync(checked.path);
      const mime = IMAGE_MIME[path.extname(checked.path).toLowerCase()] || 'image/png';
      return { ok: true, path: checked.path, name, bytes: raw.length, dataUrl: `data:${mime};base64,${raw.toString('base64')}` };
    } catch (_) {
      return { ok: false, error: '图片无法解析（文件可能已损坏）' };
    }
  }
  let { width, height } = image.getSize();
  let out = image;
  if (Math.max(width, height) > IMAGE_MAX_EDGE) {
    const scale = IMAGE_MAX_EDGE / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    out = image.resize({ width, height, quality: 'best' });
  }
  const jpeg = out.toJPEG(82);
  if (!jpeg || !jpeg.length) return { ok: false, error: '图片转码失败' };
  if (cacheFile) {
    try {
      fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, jpeg);
    } catch (_) {
      /* 缓存写失败不影响本次读取 */
    }
  }
  return {
    ok: true,
    path: checked.path,
    name,
    width,
    height,
    bytes: jpeg.length,
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
  };
}

// 剪贴板截图没有真实文件路径：落一份到 userData 缓存目录，再按普通图片处理
function saveClipboardImage(payload) {
  const p = payload || {};
  const buf = p.data ? Buffer.from(p.data) : null;
  if (!buf || !buf.length) return { ok: false, error: '剪贴板图片为空' };
  if (buf.length > IMAGE_MAX_BYTES) return { ok: false, error: '图片超过大小上限' };
  let ext = path.extname(String(p.name || '')).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) ext = '.png';
  try {
    fs.mkdirSync(IMAGE_SAVE_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const file = path.join(IMAGE_SAVE_DIR, `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  fs.writeFileSync(file, buf);
  const checked = inspectImagePath(file);
  if (!checked.ok) return checked;
  return { ok: true, path: checked.path, name: path.basename(checked.path), size: checked.size };
}

// 自定义供应商：完全按 search.providers.json 的模板发请求，再把返回映射成统一结果
async function customWebSearch(query, p, maxResults, maxTotalChars) {
  let def;
  try {
    def = loadCustomSearchDef();
  } catch (err) {
    return {
      ok: false,
      error: `读取 search.providers.json 失败：${err && err.message ? err.message : String(err)}`,
    };
  }

  const apiKey = String(p.apiKey !== undefined ? p.apiKey : '').trim();
  const label = String(def.label || '自定义');
  const method = String(def.method || 'POST').toUpperCase();
  const requestUrl = joinSearchUrl(p.endpoint || def.endpoint || '', def.path || '');
  if (!requestUrl) {
    return { ok: false, error: 'search.providers.json 里缺少 endpoint / path' };
  }

  const timeoutMs = clampInt(def.timeoutMs || p.timeoutMs, 3000, 60000, 20000);
  const vars = {
    query,
    maxResults,
    apiKey,
    zone: p.zone || SEARCH_CFG.zone || '',
    language: p.language || SEARCH_CFG.language || '',
  };

  const headers = {};
  const headerTpl =
    def.headers && typeof def.headers === 'object' ? def.headers : { 'Content-Type': 'application/json' };
  for (const [key, value] of Object.entries(headerTpl)) {
    const text = String(value == null ? '' : value);
    // 没填 Key 时，把带 {{apiKey}} 的整条请求头去掉（避免发出 "Bearer " 这种空鉴权）
    if (!apiKey && /\{\{\s*apiKey\s*\}\}/.test(text)) continue;
    headers[key] = String(fillTemplate(text, vars));
  }
  if (method !== 'GET' && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const bodyTpl =
    def.body && typeof def.body === 'object' ? def.body : { query: '{{query}}', max_results: '{{maxResults}}' };
  const body = fillTemplate(bodyTpl, vars);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    let finalUrl = requestUrl;
    const options = { method, headers, signal: controller.signal };
    if (method === 'GET') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body || {})) {
        if (value == null || typeof value === 'object') continue;
        params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) finalUrl += (finalUrl.includes('?') ? '&' : '?') + qs;
    } else if (body !== undefined) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await net.fetch(finalUrl, options);
    if (!res.ok) {
      const detail = oneLine(await res.text().catch(() => ''), 200);
      return {
        ok: false,
        error: `搜索失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}（检查 search.providers.json）`,
      };
    }

    const json = await res.json();
    const response = def.response && typeof def.response === 'object' ? def.response : {};
    const rawList = response.resultsPath ? readJsonPath(json, response.resultsPath) : json;
    if (!Array.isArray(rawList)) {
      return {
        ok: false,
        error: `响应里找不到结果数组（检查 response.resultsPath：${response.resultsPath || '（空）'}）`,
      };
    }

    const results = compactResults(rawList, maxResults, maxTotalChars, {
      title: response.title || 'title',
      url: response.url || 'url',
      snippet: response.snippet || 'snippet',
      snippetFallback: response.snippetFallback || '',
    });
    const elapsed = Date.now() - started;
    const metadata = {
      total_results: Number(readJsonPath(json, response.totalPath)) || results.length,
      search_time_ms: Number(readJsonPath(json, response.timePath)) || elapsed,
    };
    if (!results.length) {
      return {
        ok: true,
        provider: 'custom',
        providerLabel: label,
        query,
        results: [],
        metadata,
        text: `搜索「${query}」没有找到结果，可以换个关键词再试。`,
      };
    }
    return {
      ok: true,
      provider: 'custom',
      providerLabel: label,
      query,
      results,
      metadata,
      text: searchText(query, label, results, metadata),
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    return {
      ok: false,
      error: aborted
        ? `自定义搜索超时（${Math.round(timeoutMs / 1000)} 秒）`
        : `自定义搜索请求失败：${err && err.message ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// SearXNG：走自带的 JSON 接口 GET /search?q=…&format=json（不需要 Key）
// 实例必须开启 JSON 输出：settings.yml 里 search.formats 要有 json，否则会 403 / 返回 HTML
async function searxngWebSearch(query, p, maxResults, maxTotalChars) {
  const endpoint = String(p.endpoint || SEARCH_CFG.endpoint || 'http://localhost:8888')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(endpoint)) {
    return { ok: false, error: `SearXNG 地址无效：${endpoint || '（空）'}（示例 http://localhost:8888）` };
  }

  let requestUrl;
  try {
    const url = new URL(`${endpoint}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general');
    url.searchParams.set('language', p.language || SEARCH_CFG.language || 'zh-CN');
    url.searchParams.set('safesearch', '0');
    url.searchParams.set('pageno', '1');
    requestUrl = url.toString();
  } catch (err) {
    return { ok: false, error: `SearXNG 地址无效：${endpoint}` };
  }

  const timeoutMs = clampInt(p.timeoutMs, 3000, 60000, clampInt(SEARCH_CFG.timeoutMs, 3000, 60000, 8000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await net.fetch(requestUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      const hints = {
        403: '实例没开 JSON 输出（settings.yml 的 search.formats 里加上 json）',
        429: '请求过于频繁，稍后再试',
        503: '实例暂时不可用（搜索引擎可能被限流）',
      };
      const hint = hints[res.status] || '';
      return {
        ok: false,
        error: `SearXNG 返回 HTTP ${res.status}${hint ? `，${hint}` : ''}（地址 ${endpoint}）`,
      };
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      // 没开 JSON 的实例会回一坨 HTML，这里给个明确提示
      return {
        ok: false,
        error: `SearXNG 返回的不是 JSON：确认实例已开启 JSON 输出（format=json），当前地址 ${endpoint}`,
      };
    }

    const rawList = json && Array.isArray(json.results) ? json.results : [];
    const results = compactResults(rawList, maxResults, maxTotalChars, { snippet: 'content' });
    // 引擎被限流 / 触发验证码时结果会是空的，把原因带回去，免得看起来像搜到了但没内容
    const unresponsive = Array.isArray(json && json.unresponsive_engines)
      ? json.unresponsive_engines
          .map((row) => (Array.isArray(row) ? row.filter(Boolean).join(': ') : String(row || '')))
          .filter(Boolean)
      : [];
    const metadata = {
      total_results: Number(json && json.number_of_results) || results.length,
      search_time_ms: Date.now() - started,
      unresponsive_engines: unresponsive,
    };
    if (!results.length) {
      const why = unresponsive.length ? `（引擎异常：${oneLine(unresponsive.join('、'), 160)}）` : '';
      return {
        ok: true,
        provider: 'searxng',
        query,
        results: [],
        metadata,
        text: `搜索「${query}」没有找到结果${why}，可以换个关键词或稍后再试。`,
      };
    }
    return { ok: true, provider: 'searxng', query, results, metadata, text: searchText(query, 'SearXNG', results, metadata) };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    return {
      ok: false,
      error: aborted
        ? `SearXNG 超时（${Math.round(timeoutMs / 1000)} 秒）：${endpoint}`
        : `连接 SearXNG 失败：${err && err.message ? err.message : String(err)}（确认实例在 ${endpoint} 上运行）`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function importActionFiles() {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口尚未就绪' };
  const picked = await dialog.showOpenDialog(win, {
    title: '选择动作文件（.glb，可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'GLB 动作', extensions: ['glb'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

  fs.mkdirSync(CLIP_DIR, { recursive: true });
  let index = [];
  try {
    const raw = JSON.parse(fs.readFileSync(ACTION_INDEX, 'utf8'));
    index = Array.isArray(raw) ? raw : raw.actions || [];
  } catch (_) {
    index = [];
  }

  const imported = [];
  const failed = [];
  for (const file of picked.filePaths) {
    try {
      const meta = readGlbActionMeta(file);
      // 内核按 <prefix><name>.glb 直接找文件，导入时统一改名为内核可识别的格式。
      const destFile = `${APP_CONFIG.clipPrefix}${meta.name}.glb`;
      const destPath = path.join(CLIP_DIR, destFile);
      if (path.resolve(file) !== path.resolve(destPath)) fs.copyFileSync(file, destPath);
      const next = { name: meta.name, file: destFile, duration: meta.duration, loop: meta.loop };
      const hit = index.findIndex((a) => (a.name || a.file) === meta.name);
      if (hit === -1) index.push(next);
      else index[hit] = { ...index[hit], ...next };
      imported.push(next);
    } catch (err) {
      failed.push(`${path.basename(file)}: ${err && err.message ? err.message : err}`);
    }
  }

  if (imported.length) fs.writeFileSync(ACTION_INDEX, JSON.stringify(index, null, 2), 'utf8');
  log(`[ext] actions imported=${imported.length} failed=${failed.length}`);
  return { ok: true, imported, failed, total: index.length };
}

// 导入动作清单（.json）：给没有 .glb 的 2D / Live2D 内核用。
// 清单模式直接替换（清单就是事实来源）；文件模式按名字合并进 _index.json，不丢已有条目。
async function importActionIndex() {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口尚未就绪' };
  const picked = await dialog.showOpenDialog(win, {
    title: '选择动作清单（.json）',
    properties: ['openFile'],
    filters: [{ name: '动作清单', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(picked.filePaths[0], 'utf8'));
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err && err.message ? err.message : err}` };
  }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.actions) ? raw.actions : null;
  if (!list) return { ok: false, error: '格式应为动作数组，或 { "actions": [ ... ] }' };

  const prefix = APP_CONFIG.clipPrefix;
  const incoming = [];
  for (const entry of list) {
    if (!entry) continue;
    const fallback = String(entry.file || '').replace(/\.glb$/i, '');
    const name = String(entry.name || (fallback.startsWith(prefix) ? fallback.slice(prefix.length) : fallback)).trim();
    if (!name) continue;
    const item = { name };
    if (entry.file) item.file = String(entry.file);
    const dur = Number(entry.duration);
    if (Number.isFinite(dur)) item.duration = dur;
    if (entry.loop) item.loop = true;
    if (entry.oneshot) item.oneshot = true;
    if (entry.kind) item.kind = String(entry.kind);
    incoming.push(item);
  }
  if (!incoming.length) return { ok: false, error: '清单里没有有效的动作名' };

  let out = incoming;
  if (APP_CONFIG.actionsMode !== 'index') {
    let existing = [];
    try {
      const old = JSON.parse(fs.readFileSync(ACTION_INDEX, 'utf8'));
      existing = Array.isArray(old) ? old : (old && old.actions) || [];
    } catch (_) {
      existing = [];
    }
    const map = new Map();
    for (const entry of existing) {
      const name = String((entry && entry.name) || '').trim();
      if (name) map.set(name, entry);
    }
    for (const item of incoming) map.set(item.name, { ...(map.get(item.name) || {}), ...item });
    out = [...map.values()];
  }

  fs.mkdirSync(path.dirname(ACTION_INDEX), { recursive: true });
  fs.writeFileSync(ACTION_INDEX, JSON.stringify(out, null, 2), 'utf8');
  log(`[ext] action list imported=${incoming.length} mode=${APP_CONFIG.actionsMode}`);
  return { ok: true, count: incoming.length, total: out.length, mode: APP_CONFIG.actionsMode, path: ACTION_INDEX };
}

// 动作库以 clips 文件夹里实际存在的 .glb 为准：_index.json 只补时长 / loop 这类元数据。
// 所以往文件夹里拖一个新 glb（哪怕还没登记）动作列表也会重建出来；索引里有、文件没了的标 missing。
function scanActions() {
  let index = [];
  try {
    const raw = JSON.parse(fs.readFileSync(ACTION_INDEX, 'utf8'));
    index = Array.isArray(raw) ? raw : raw.actions || [];
  } catch (_) {
    index = [];
  }
  const prefix = APP_CONFIG.clipPrefix;
  const byName = new Map();

  // 清单模式（2D / Live2D 内核）：没有 .glb 可扫，清单就是全部事实来源。
  // 这里不标 missing，否则这些动作会被 ACTIONS 提示词过滤器剔除，模型就看不到它们了。
  if (APP_CONFIG.actionsMode === 'index') {
    const out = [];
    for (const entry of index) {
      if (!entry) continue;
      const fallback = String(entry.file || '').replace(/\.glb$/i, '');
      const name = String(entry.name || (fallback.startsWith(prefix) ? fallback.slice(prefix.length) : fallback)).trim();
      if (!name || out.some((a) => a.name === name)) continue;
      out.push({
        name,
        file: String(entry.file || ''),
        duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
        loop: !!entry.loop,
        oneshot: !!entry.oneshot,
        kind: entry.kind || undefined,
        missing: false,
      });
    }
    return out;
  }

  index.forEach((entry) => {
    if (!entry) return;
    const fallback = String(entry.file || '').replace(/\.glb$/i, '');
    const name = entry.name || (fallback.startsWith(prefix) ? fallback.slice(prefix.length) : fallback);
    if (name) byName.set(name, { ...entry, name });
  });

  let files = [];
  try {
    files = fs.readdirSync(CLIP_DIR).filter((f) => f.toLowerCase().endsWith('.glb'));
  } catch (_) {
    files = [];
  }

  const list = [];
  const seen = new Set();
  for (const file of files) {
    const base = file.replace(/\.glb$/i, '');
    const name = base.startsWith(prefix) ? base.slice(prefix.length) : base;
    if (seen.has(name)) continue;
    seen.add(name);
    const meta = byName.get(name) || {};
    list.push({
      name,
      file,
      duration: Number.isFinite(Number(meta.duration)) ? Number(meta.duration) : null,
      loop: !!meta.loop,
      oneshot: !!meta.oneshot,
      kind: meta.kind || undefined,
    });
  }
  for (const [name, meta] of byName) {
    if (seen.has(name)) continue;
    list.push({
      name,
      file: meta.file || `${prefix}${name}.glb`,
      duration: Number.isFinite(Number(meta.duration)) ? Number(meta.duration) : null,
      loop: !!meta.loop,
      oneshot: !!meta.oneshot,
      kind: meta.kind || undefined,
      missing: true,
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// 请求体里这几个字段由程序控制，模型配置的额外参数（extraBody）不允许覆盖它们
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream', 'tools', 'tool_choice', 'stream_options']);

async function streamChatCompletion(event, payload) {
  const { id, base, key, model, messages, tools, temperature, toolChoice, idleMs, extraBody } = payload || {};
  if (!id) return;
  const send = (evt) => {
    if (!event.sender.isDestroyed()) event.sender.send('llm:event', { id, ...evt });
  };
  const controller = new AbortController();
  llmRequests.set(id, controller);

  // 「无输出超时」：等待响应头、以及流式过程中长时间没收到任何数据都会计时；
  // 每次读到新数据就重置。超时主动 abort，但和用户手动取消要区分开。
  const idleLimit = Number(idleMs) > 0 ? Number(idleMs) : 0;
  let idleTimer = null;
  let idleFired = false;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    if (!idleLimit) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      idleFired = true;
      log(`[llm] idle timeout ${id} ${idleLimit}ms`);
      controller.abort();
    }, idleLimit);
  };

  try {
    const apiBase = String(base || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(apiBase) ? apiBase : `${apiBase}/chat/completions`;
    const body = {
      model: model || 'deepseek-chat',
      messages,
      stream: true,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
    };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      // 压缩时回放同一份 tools（保住 KV Cache 前缀），同时明确不允许调用
      if (['none', 'auto', 'required'].includes(toolChoice)) body.tool_choice = toolChoice;
    }
    // 流式响应默认不带 usage；显式要求后服务端会在最后一个 chunk 里补上
    body.stream_options = { include_usage: true };
    // 每套模型在设置里配的「思考参数」：只做浅合并，协议关键字段一律不许被覆盖
    if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
      for (const [k, v] of Object.entries(extraBody)) {
        if (PROTECTED_BODY_KEYS.has(k)) continue;
        body[k] = v;
      }
    }

    // 控制台「完整提示词」：这一份和真正发出去的请求体是同一个字符串，一字不差。
    // 只在内存里转给渲染层展示，不落盘、不持久化。
    const bodyText = JSON.stringify(body);
    // 唯一的例外：图片 base64 太长，控制台展开会把整段 DOM 撑爆，只把图片内容折成占位说明
    const bodyForDisplay = bodyText.replace(
      /("image_url"\s*:\s*\{\s*"url"\s*:\s*"data:image\/[^;]+;base64,)([^"]+)"/g,
      (_m, head, payload) => `${head}<已省略 ${payload.length} 字符的 base64>"`,
    );
    send({
      type: 'request',
      url,
      model: body.model,
      messages: Array.isArray(messages) ? messages.length : 0,
      body: bodyForDisplay,
    });

    log(`[llm] start ${id} ${url} model=${body.model} messages=${messages.length}`);
    armIdle();
    const res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key || ''}`,
      },
      body: bodyText,
      signal: controller.signal,
    });
    armIdle();
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 400)}`);
    }

    send({ type: 'start' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle(); // 收到新数据，重新开始计「无输出」时间
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件按空行分隔；有的服务端只用 \n，这里按 data: 行解析即可。
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch (_) {
          continue;
        }
        // usage 只出现在末尾的独立 chunk 里（此时 choices 为空），要放在 delta 判断之前
        if (json.usage) send({ type: 'usage', usage: json.usage });
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        if (delta.reasoning_content) send({ type: 'reasoning', text: delta.reasoning_content });
        if (delta.content) send({ type: 'content', text: delta.content });
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            send({
              type: 'tool_call',
              index: tc.index ?? 0,
              // 注意：不能叫 id，事件外层用 id 做请求路由，会被工具自己的 id 覆盖
              callId: tc.id,
              name: tc.function && tc.function.name,
              args: tc.function && tc.function.arguments,
            });
          }
        }
      }
    }
    // 极少数情况下 abort 会让 read() 以 done 结束，这里再确认一次，避免把超时当成功
    if (idleFired) throw new Error('idle timeout');
    clearIdle();
    send({ type: 'done' });
    log(`[llm] done ${id}`);
  } catch (err) {
    if (idleFired) {
      // 超时是我们自己 abort 的，要作为「错误」回传，渲染层才会按失败处理（可重试）
      const sec = Math.max(1, Math.round(idleLimit / 1000));
      const message = `等待 ${sec} 秒没有收到输出，已自动停止`;
      send({ type: 'error', message });
      log(`[llm] idle-timeout ${id} ${message}`);
    } else if (controller.signal.aborted) {
      send({ type: 'done', aborted: true });
      log(`[llm] aborted ${id}`);
    } else {
      const message = String(err && err.message ? err.message : err);
      send({ type: 'error', message });
      log(`[llm] error ${id} ${message}`);
    }
  } finally {
    clearIdle();
    llmRequests.delete(id);
  }
}

// ------------------------------------------------------------------ 角色包
// 目录 → zip：系统 tar（bsdtar 支持 -a 自动识别扩展名），失败退回 PowerShell。
// zip 里保留角色目录这一层，导入时会自动剥掉唯一外壳。
function createZipFromDir(dir, zipFile) {
  return new Promise((resolve) => {
    const parent = path.dirname(dir);
    const name = path.basename(dir);
    const run = (cmd, args, onFail) => {
      const child = spawn(cmd, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (c) => {
        err += c.toString();
      });
      child.on('error', () => onFail && onFail());
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else if (onFail) onFail(err);
        else resolve({ ok: false, error: `打包失败（${code}）：${err.trim().split(/\r?\n/).slice(-2).join(' ')}` });
      });
    };
    run('tar', ['-a', '-c', '-f', zipFile, '-C', parent, name], () =>
      run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Compress-Archive -LiteralPath '${dir.replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`,
        ],
        (err) => resolve({ ok: false, error: `打包失败：${String(err || '').trim() || '系统里没有可用的压缩工具'}` }),
      ),
    );
  });
}

// 角色体检：入口 / 动作来源 / 内核清单（版本 + 目录哈希）。
// broken 只由「入口缺失」决定，动作清单或哈希不一致算警告，不阻止聊天。
async function validateCharacter(id) {
  const char = characterHost.getById(String(id || ''));
  if (!char) return { ok: false, error: '角色不存在' };
  const issues = [];
  const warnings = [];
  const entryRel = (char.kernel && char.kernel.entry) || '';
  const entryAbs = entryRel ? appPathToFile(entryRel) : '';
  const entryExists = !!entryAbs && fs.existsSync(entryAbs);
  if (!entryRel) issues.push('未配置内核入口');
  else if (!entryExists) issues.push(`内核入口缺失：${entryRel}`);
  if (!char.dir || !fs.existsSync(char.dir)) issues.push('角色目录不存在');

  const src = char.actionsSource || {};
  if (src.mode === 'index') {
    const idxAbs = src.index ? appPathToFile(src.index) : '';
    if (!idxAbs || !fs.existsSync(idxAbs)) warnings.push(`动作清单缺失：${src.index || '(未配置)'}`);
  } else {
    const clipAbs = char.clips ? appPathToFile(char.clips) : '';
    if (!clipAbs || !fs.existsSync(clipAbs)) warnings.push('动作目录为空，角色仍可聊天');
  }

  let manifest = null;
  if (entryExists) {
    const target = resolveKernelEntry(entryRel);
    const file = path.join(target.dir, KERNEL_MANIFEST_NAME);
    const raw = readJsonSafe(file);
    if (!raw) {
      warnings.push('缺少内核清单 kernel.json（首次使用时会自动生成）');
    } else if (!raw.sha256) {
      warnings.push('内核清单缺少 sha256');
    } else {
      try {
        const digest = await hashKernelDir(target.dir);
        manifest = {
          version: raw.version || '',
          sha256: raw.sha256,
          files: digest.files,
          bytes: digest.bytes,
          matches: digest.sha256 === raw.sha256,
        };
        if (!manifest.matches) warnings.push('内核文件与清单不一致（目录被修改过）');
      } catch (err) {
        warnings.push(`内核哈希计算失败：${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    broken: issues.length > 0,
    issues,
    warnings,
    dir: char.dir || '',
    entry: entryRel,
    manifest,
  };
}

function registerIpc() {
  // 插件宿主：registry / 导入校验 / config 写入 / utilityProcess 工具路由
  pluginHost = createPluginHost({
    userDataDir: app.getPath('userData'),
    // 插件默认放数据根下，和角色同级；指针文件仍留在 userData 里
    dataRoot: DATA_ROOT,
    toolsConfigFile: TOOLS_CONFIG_FILE,
    appDir: APP_DIR,
    siRoot: path.dirname(APP_DIR),
    fetchToFile,
    taskStart,
    taskUpdate,
    taskFinish,
    log,
    notify: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  pluginHost.registerIpc(ipcMain, () => win);
  // 拉起所有已启用的插件进程（定时任务这类常驻逻辑要靠它跑在后台）
  setTimeout(() => {
    if (pluginHost) void pluginHost.startAll();
  }, 1000);

  ipcMain.on('llm:start', (event, payload) => {
    streamChatCompletion(event, payload);
  });
  ipcMain.on('llm:cancel', (_event, id) => {
    const controller = llmRequests.get(id);
    if (controller) controller.abort();
  });

  ipcMain.handle('pet:quit', () => {
    quitting = true;
    app.quit();
    return true;
  });
  ipcMain.handle('pet:hide', () => {
    // 没有托盘图标时不藏窗口，否则用户找不回来
    if (!tray) {
      quitting = true;
      app.quit();
      return true;
    }
    if (win && !win.isDestroyed()) win.hide();
    return true;
  });
  // 顶部拖动条：原生 -webkit-app-region: drag 会吞掉鼠标事件，做不了 hover 提示，
  // 所以全透明模式的拖动条改由渲染层按下、主进程按屏幕坐标跟随鼠标移动窗口。
  let windowDragTimer = null;
  const stopWindowDrag = () => {
    if (windowDragTimer) {
      clearInterval(windowDragTimer);
      windowDragTimer = null;
    }
  };
  ipcMain.on('pet:window:drag-start', () => {
    if (!win || win.isDestroyed() || windowDragTimer) return;
    const from = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const startedAt = Date.now();
    windowDragTimer = setInterval(() => {
      // 兜底：窗口没了 / 松手事件丢失时最多跟 60 秒
      if (!win || win.isDestroyed() || Date.now() - startedAt > 60000) {
        stopWindowDrag();
        return;
      }
      const now = screen.getCursorScreenPoint();
      win.setPosition(wx + (now.x - from.x), wy + (now.y - from.y));
    }, 16);
  });
  ipcMain.on('pet:window:drag-stop', stopWindowDrag);
  ipcMain.handle('pet:minimize', () => {
    if (win && !win.isDestroyed()) win.minimize();
    return true;
  });
  ipcMain.handle('pet:pin:get', () => pinned);
  // 后台回复通知：渲染层只在「设置开关打开」时调用，是否真的弹由主进程按窗口焦点判断
  ipcMain.handle('notify:reply', (_e, payload) => ({ ok: notifyReply(payload) }));
  ipcMain.handle('pet:pin:set', (_e, enabled) => setPinned(enabled));
  ipcMain.handle('pet:clickthrough:get', () => clickThrough);
  ipcMain.handle('pet:clickthrough:set', (_e, enabled) => setClickThrough(enabled));
  ipcMain.handle('pet:clickthrough:toggle', () => setClickThrough(!clickThrough));
  // 打开设置时把窗口恢复成默认尺寸，设置页只按 900×600 布局，不再适配窄窗口
  ipcMain.handle('pet:window:default-size', () => {
    if (!win || win.isDestroyed()) return false;
    const b = win.getBounds();
    if (b.width >= WINDOW_WIDTH && b.height >= WINDOW_HEIGHT) return false;
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(WINDOW_WIDTH, area.width);
    const height = Math.min(WINDOW_HEIGHT, area.height);
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
    win.setBounds({ x, y, width, height });
    return true;
  });
  // 背景外观：渲染层把「背景模式 / 毛玻璃材质 / 浓度」同步过来，下次启动按它建窗
  ipcMain.handle('pet:appearance:get', () => ({ glass: windowGlass, material: MATERIAL_OK }));
  ipcMain.handle('pet:appearance:set', (_e, payload) => {
    appearance = normalizeAppearance(payload);
    try {
      fs.writeFileSync(APPEARANCE_FILE, JSON.stringify(appearance, null, 2));
    } catch (err) {
      log(`[appearance] 写入失败：${err && err.message}`);
    }
    // 已经是毛玻璃窗口时，材质可以即时切换，不用重启
    if (windowGlass && win && !win.isDestroyed()) {
      try {
        win.setBackgroundMaterial(appearance.glassMaterial);
      } catch (err) {
        log(`[appearance] 切换材质失败：${err && err.message}`);
      }
    }
    return appearance;
  });
  // 透明窗口与系统材质窗口互斥，切换后只能靠重启生效
  ipcMain.handle('pet:appearance:restart-prompt', async () => {
    if (!win || win.isDestroyed()) return false;
    const r = await dialog.showMessageBox(win, {
      type: 'info',
      title: '背景切换',
      message: '背景切换需要重建窗口',
      detail: '毛玻璃使用的是系统窗口材质，与全透明桌宠窗口互斥，将在下次启动时生效。',
      buttons: ['稍后', '立即重启'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (r && r.response === 1) {
      quitting = true;
      app.relaunch();
      app.exit(0);
    }
    return true;
  });
  ipcMain.handle('pet:capture', async (_e, pngPath) => {
    try {
      return await captureTo(pngPath);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('panel:open', (_e, kind) => {
    const panel = createPanelWindow(String(kind || ''));
    return !!panel;
  });
  ipcMain.handle('panel:close', (event) => {
    const caller = BrowserWindow.fromWebContents(event.sender);
    if (caller && caller !== win && !caller.isDestroyed()) caller.close();
    return true;
  });
  ipcMain.handle('panel:minimize', (event) => {
    const caller = BrowserWindow.fromWebContents(event.sender);
    if (caller && !caller.isDestroyed()) caller.minimize();
    return true;
  });

  ipcMain.handle('ext:import-actions', async () => {
    try {
      return await importActionFiles();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('ext:import-action-list', async () => {
    try {
      return await importActionIndex();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('ext:open-clips', async () => {
    try {
      fs.mkdirSync(CLIP_DIR, { recursive: true });
      return { ok: true, path: CLIP_DIR, error: await shell.openPath(CLIP_DIR) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 角色：清单 / 导入 zip（导入只负责放进 characters，切换属于下一阶段）
  ipcMain.handle('char:list', () => characterHost.list());
  ipcMain.handle('char:import-zip', async () => {
    const picked = dialog.showOpenDialogSync({
      title: '导入角色包',
      filters: [{ name: '角色包', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (!picked || !picked.length) return { ok: false, canceled: true };
    // 大包解压可能几十秒：走共用任务中心，可看进度、可取消
    const task = taskStart('正在导入角色包', { detail: path.basename(picked[0]), cancelable: true });
    const controller = new AbortController();
    task.abort = controller;
    let result;
    try {
      result = await characterHost.importZip(picked[0], {
        signal: controller.signal,
        onProgress: (p) => {
          if (!p) return;
          const patch = {};
          if (p.detail) patch.detail = p.detail;
          if (p.total) {
            patch.total = p.total;
            patch.received = p.received || 0;
          }
          taskUpdate(task.id, patch);
        },
      });
    } catch (err) {
      result = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (result && result.canceled) {
      taskFinish(task.id, { ok: false, detail: '已取消' });
      return { ok: false, canceled: true };
    }
    if (!result || !result.ok) {
      taskFinish(task.id, { ok: false, detail: (result && result.error) || '导入失败' });
      return result || { ok: false, error: '导入失败' };
    }
    taskFinish(task.id, { ok: true, detail: `已导入 ${(result.character && result.character.name) || result.id}` });
    // 角色包通常不带图标：导入后请用户补一张（可取消，取消就显示首字）
    if (!result.icon) {
      const icon = dialog.showOpenDialogSync({
        title: '选择角色图标（可取消）',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        properties: ['openFile'],
      });
      if (icon && icon.length) {
        const applied = characterHost.setIcon(result.id, icon[0]);
        if (applied.ok) {
          result.character = applied.character;
          result.icon = true;
        }
      }
    }
    // 让后续 app:config 立即看到新角色
    APP_CONFIG.characters = characterHost.list();
    return result;
  });

  // 切换角色：写注册表 → 记忆库按新角色重开 → 重算派生配置
  ipcMain.handle('char:switch', (_e, id) => {
    const state = characterHost.resolve();
    const target = state.characters.find((c) => c.id === String(id || ''));
    if (!target) return { ok: false, error: '角色不存在' };
    if (state.activeId === target.id) {
      return { ok: true, id: target.id, unchanged: true };
    }
    const entry = target.kernel && target.kernel.entry;
    if (!entry || !fs.existsSync(appPathToFile(entry))) {
      return { ok: false, error: `角色内核入口缺失：${entry || '(未配置)'}` };
    }
    const applied = characterHost.setActive(target.id);
    if (!applied.ok) return applied;
    // 每个角色一个 memory.db：先关旧 Worker，下次调用时按新角色目录重建
    if (memoryHost) {
      try {
        memoryHost.close();
      } catch (err) {
        log('[memory] 关闭旧记忆库失败', err && err.message ? err.message : String(err));
      }
      memoryHost = null;
    }
    applyActiveCharacter();
    log(`[character] 已切换：${(state.active && state.active.name) || state.activeId || ''} → ${target.name || target.id}`);
    return { ok: true, id: target.id, character: applied.character };
  });

  // 角色详情里的四个操作：校验 / 打开目录 / 导出 / 删除
  ipcMain.handle('char:validate', async (_e, id) => {
    try {
      return await validateCharacter(id);
    } catch (err) {
      return { ok: false, broken: true, error: String(err && err.message ? err.message : err), issues: [], warnings: [] };
    }
  });

  ipcMain.handle('char:open-dir', async (_e, id) => {
    const char = characterHost.getById(String(id || ''));
    if (!char || !char.dir) return { ok: false, error: '角色目录不存在' };
    try {
      fs.mkdirSync(char.dir, { recursive: true });
      const err = await shell.openPath(char.dir);
      return { ok: !err, path: char.dir, error: err };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('char:export', async (_e, id) => {
    const char = characterHost.getById(String(id || ''));
    if (!char) return { ok: false, error: '角色不存在' };
    const options = {
      title: '导出角色包',
      defaultPath: path.join(app.getPath('downloads'), `${char.id}-${char.version || 'character'}.zip`),
      filters: [{ name: '角色包', extensions: ['zip'] }],
    };
    const picked = win && !win.isDestroyed() ? dialog.showSaveDialogSync(win, options) : dialog.showSaveDialogSync(options);
    if (!picked) return { ok: false, canceled: true };
    const target = /\.zip$/i.test(picked) ? picked : `${picked}.zip`;
    try {
      fs.rmSync(target, { force: true });
    } catch (_) {
      /* 覆盖失败时让打包工具自己报错 */
    }
    const packed = await createZipFromDir(char.dir, target);
    if (!packed.ok) return packed;
    let bytes = 0;
    try {
      bytes = fs.statSync(target).size;
    } catch (_) {
      /* 大小拿不到不影响导出结果 */
    }
    log(`[character] 已导出角色 ${char.id} → ${target}`);
    return { ok: true, path: target, bytes };
  });

  ipcMain.handle('char:delete', (_e, id) => {
    try {
      return characterHost.remove(String(id || ''));
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 动作列表按 clips 文件夹里实际的文件重建
  ipcMain.handle('actions:index', () => {
    try {
      return scanActions();
    } catch (err) {
      log('[actions] scan failed', err && err.message ? err.message : String(err));
      return [];
    }
  });

  // 预设文本文件统一读写：读不到就当空文件（程序不再内置任何提示词兜底）
  function presetTextIO(file) {
    return {
      read() {
        try {
          return { ok: true, text: fs.readFileSync(file, 'utf8'), path: file, exists: true };
        } catch (err) {
          if (err && err.code === 'ENOENT') return { ok: true, text: '', path: file, exists: false };
          return { ok: false, error: String(err && err.message ? err.message : err) };
        }
      },
      write(text) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, String(text ?? ''), 'utf8');
          return { ok: true, path: file };
        } catch (err) {
          return { ok: false, error: String(err && err.message ? err.message : err) };
        }
      },
    };
  }

  ipcMain.handle('preset:read-actions', async () => {
    try {
      return { ok: true, text: fs.readFileSync(PRESET_ACTIONS_FILE, 'utf8'), path: PRESET_ACTIONS_FILE };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, text: '', path: PRESET_ACTIONS_FILE };
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('preset:write-actions', async (_e, text) => {
    try {
      fs.mkdirSync(path.dirname(PRESET_ACTIONS_FILE), { recursive: true });
      fs.writeFileSync(PRESET_ACTIONS_FILE, String(text ?? ''), 'utf8');
      return { ok: true, path: PRESET_ACTIONS_FILE };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 人设按角色走：<角色目录>/persona.md；没有角色时才回退到程序内的旧文件
  function activePersonaFile() {
    const active = APP_CONFIG.active;
    if (active && active.dir) return path.join(active.dir, 'persona.md');
    return PRESET_PERSONA_FILE;
  }
  const personaIO = {
    read() {
      const file = activePersonaFile();
      // characterScoped：人设来自角色目录，缺失就代表「这个角色没写人设」，不允许用旧全局人设回填
      const characterScoped = !!(APP_CONFIG.active && APP_CONFIG.active.dir);
      try {
        return { ok: true, text: fs.readFileSync(file, 'utf8'), path: file, exists: true, characterScoped };
      } catch (err) {
        if (err && err.code === 'ENOENT') return { ok: true, text: '', path: file, exists: false, characterScoped };
        return { ok: false, error: String(err && err.message ? err.message : err), path: file, characterScoped };
      }
    },
    write(text) {
      const file = activePersonaFile();
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(text ?? ''), 'utf8');
        return { ok: true, path: file };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err), path: file };
      }
    },
  };
  const speakIO = presetTextIO(PRESET_SPEAK_FILE);
  const timeIO = presetTextIO(PRESET_TIME_FILE);
  const memoryIO = presetTextIO(PRESET_MEMORY_FILE);
  ipcMain.handle('preset:read-persona', () => personaIO.read());
  ipcMain.handle('preset:write-persona', (_e, text) => personaIO.write(text));
  ipcMain.handle('preset:read-speak', () => speakIO.read());
  ipcMain.handle('preset:write-speak', (_e, text) => speakIO.write(text));
  ipcMain.handle('preset:read-time', () => timeIO.read());
  ipcMain.handle('preset:write-time', (_e, text) => timeIO.write(text));
  ipcMain.handle('preset:read-memory', () => memoryIO.read());
  ipcMain.handle('preset:write-memory', (_e, text) => memoryIO.write(text));
  const emotionPresetIO = presetTextIO(PRESET_EMOTION_FILE);
  ipcMain.handle('preset:read-emotion', () => emotionPresetIO.read());
  ipcMain.handle('preset:write-emotion', (_e, text) => emotionPresetIO.write(text));
  const proactivePresetIO = presetTextIO(PRESET_PROACTIVE_FILE);
  ipcMain.handle('preset:read-proactive', () => proactivePresetIO.read());
  ipcMain.handle('preset:write-proactive', (_e, text) => proactivePresetIO.write(text));

  // 情感状态：按角色目录隔离，读写走主进程；前端只拿 state 对象
  function activeEmotionTarget(id) {
    const wanted = String(id || '');
    const character = wanted ? characterHost.getById(wanted) : (APP_CONFIG.active || null);
    return {
      id: (character && character.id) || wanted || ((APP_CONFIG.active && APP_CONFIG.active.id) || ''),
      character,
    };
  }
  ipcMain.handle('emotion:load', (_e, payload) => {
    const target = activeEmotionTarget(payload && payload.id);
    if (!target.id) return { ok: false, error: '没有可用角色' };
    return { ...emotionStore.load(target.id, target.character), id: target.id };
  });
  ipcMain.handle('emotion:save', (_e, payload) => {
    const p = payload || {};
    const target = activeEmotionTarget(p.id);
    if (!target.id) return { ok: false, error: '没有可用角色' };
    return emotionStore.save(target.id, p.state, { immediate: !!p.immediate });
  });
  ipcMain.handle('emotion:flush', (_e, payload) => {
    const target = activeEmotionTarget(payload && payload.id);
    if (!target.id) return { ok: false, error: '没有可用角色' };
    return emotionStore.flush(target.id);
  });
  ipcMain.handle('emotion:reset', (_e, payload) => {
    const target = activeEmotionTarget(payload && payload.id);
    if (!target.id) return { ok: false, error: '没有可用角色' };
    return { ...emotionStore.reset(target.id, target.character), id: target.id };
  });
  ipcMain.handle('emotion:vectors-read', (_e, payload) => {
    const target = activeEmotionTarget(payload && payload.id);
    if (!target.id) return null;
    return emotionStore.readVectors(target.id, target.character);
  });
  ipcMain.handle('emotion:vectors-write', (_e, payload) => {
    const p = payload || {};
    const target = activeEmotionTarget(p.id);
    if (!target.id) return { ok: false, error: '没有可用角色' };
    return { ...emotionStore.writeVectors(target.id, target.character, p.data), id: target.id };
  });
  // 原型句由主进程读盘：渲染进程是 file:// 页面，fetch 本地 json 会被拦
  ipcMain.handle('emotion:prototypes', async () => {
    try {
      const text = await fs.promises.readFile(path.join(APP_DIR, 'emotion', 'prototypes.json'), 'utf8');
      return { ok: true, data: JSON.parse(text) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('preset:read-compress', async () => {
    try {
      return { ok: true, text: fs.readFileSync(PRESET_COMPRESS_FILE, 'utf8'), path: PRESET_COMPRESS_FILE };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, text: '', path: PRESET_COMPRESS_FILE };
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('preset:read-tools', async () => {
    try {
      const text = fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8');
      let config = null;
      try {
        config = JSON.parse(text);
      } catch (err) {
        return {
          ok: false,
          error: `tools.config.json 解析失败：${String(err && err.message ? err.message : err)}`,
          text,
          path: TOOLS_CONFIG_FILE,
        };
      }
      // 插件工具跟原生工具一起交给「工具管理」：默认关闭，带 source:plugin 标记
      const pluginTools = pluginHost ? pluginHost.toolDefinitions() : [];
      const merged = { ...config, tools: [...(Array.isArray(config.tools) ? config.tools : []), ...pluginTools] };
      return { ok: true, config: merged, text, path: TOOLS_CONFIG_FILE };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          ok: true,
          config: { version: 1, tools: pluginHost ? pluginHost.toolDefinitions() : [] },
          text: '',
          path: TOOLS_CONFIG_FILE,
        };
      }
      return { ok: false, error: String(err && err.message ? err.message : err), path: TOOLS_CONFIG_FILE };
    }
  });

  ipcMain.handle('preset:write-tools', async (_e, config) => {
    try {
      // 插件工具的启停状态写 registry；tools.config.json 只留原生工具
      const incoming = config && Array.isArray(config.tools) ? config.tools : [];
      const nativeTools = incoming.filter((t) => t && t.source !== 'plugin');
      const pluginTools = incoming.filter((t) => t && t.source === 'plugin');
      if (pluginHost) {
        for (const t of pluginTools) pluginHost.setToolEnabled(t.name, t.enabled !== false);
      }
      const target = { ...(config && typeof config === 'object' ? config : {}), version: Number(config && config.version) || 1, tools: nativeTools };
      const text = JSON.stringify(target, null, 2);
      fs.mkdirSync(path.dirname(TOOLS_CONFIG_FILE), { recursive: true });
      fs.writeFileSync(TOOLS_CONFIG_FILE, text + '\n', 'utf8');
      return { ok: true, path: TOOLS_CONFIG_FILE };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('voice:status', () => voiceStatus());
  ipcMain.handle('voice:download', async () => {
    try {
      return await installAsr();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('voice:import-zip', async () => {
    try {
      return await importVoiceZip();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('voice:transcribe', async (_e, payload) => {
    try {
      const raw = payload && payload.wav ? payload.wav : payload;
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
      return await transcribeWav(bytes, payload && payload.model);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('voice:open-dir', async () => {
    try {
      fs.mkdirSync(VOICE_DIR, { recursive: true });
      return { ok: true, path: VOICE_DIR, error: await shell.openPath(VOICE_DIR) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 联网搜索（web_search 工具）：请求在主进程发出，避免渲染层 CORS；返回前已精简
  ipcMain.handle('search:web', async (_e, payload) => {
    try {
      return await webSearch(payload || {});
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 图片读取（read_image 工具）：渲染层拖入图片时先 probe 校验，模型真要“看”时再 read
  ipcMain.handle('image:probe', (_e, filePath) => {
    const checked = inspectImagePath(filePath);
    if (!checked.ok) return checked;
    return { ok: true, path: checked.path, name: path.basename(checked.path), size: checked.size };
  });
  ipcMain.handle('image:read', (_e, filePath) => {
    const requested = String(filePath || '').trim();
    // 模型传的是别名：查表还原；表里没有或文件已失效都只回一句「已过期」
    if (/^\[?image_\d+\]?$/i.test(requested)) {
      try {
        const real = imageAlias.resolveAlias(requested);
        if (!real) return { ok: false, error: IMAGE_EXPIRED };
        const r = readImageDataUrl(real);
        if (!r || !r.ok) {
          imageAlias.remove(requested);
          return { ok: false, error: IMAGE_EXPIRED };
        }
        return { ...r, alias: requested };
      } catch (_) {
        return { ok: false, error: IMAGE_EXPIRED };
      }
    }
    try {
      return readImageDataUrl(requested);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  // 发送给模型前把文本里的图片路径换成别名（代码块里的不动）
  ipcMain.handle('image:alias-text', (_e, text, options) => {
    const src = String(text == null ? '' : text);
    try {
      return { ok: true, text: imageAlias.aliasizeText(src, options || {}) };
    } catch (err) {
      return { ok: false, text: src, error: String(err && err.message ? err.message : err) };
    }
  });
  // @ 引用面板：最近用过的图片（按 last_used 倒序）
  ipcMain.handle('image:alias-list', (_e, limit) => {
    try {
      const n = Math.max(1, Math.min(20, Math.round(Number(limit) || 5)));
      return { ok: true, items: imageAlias.list(n) };
    } catch (err) {
      return { ok: false, items: [], error: String(err && err.message ? err.message : err) };
    }
  });
  // 剪贴板截图没有磁盘路径：先落盘，后续流程与拖入文件一致
  ipcMain.handle('image:save-temp', (_e, payload) => {
    try {
      return saveClipboardImage(payload);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 渲染层不再直接 fetch 配置文件：主进程装配后统一供给。
  // 角色清单每次现取，导入后不用重启就能看到新卡片。
  ipcMain.handle('app:config', () => {
    const state = characterHost.resolve();
    APP_CONFIG.characters = state.characters;
    return {
      appName: APP_CONFIG.appName,
      appVersion: APP_CONFIG.appVersion,
      characters: state.characters,
      defaultCharacter: state.activeId || APP_CONFIG.activeId,
      dataRoot: DATA_ROOT,
    };
  });

  // 数据根：读取当前路径 / 重新选择（只切指针不迁移，选定后重启进程）
  ipcMain.handle('app:data-root', () => ({
    root: DATA_ROOT,
    pointer: dataRoot.pointerFile(APP_DATA_BASE, APP_NAME),
  }));
  ipcMain.handle('app:choose-data-root', async () => {
    const picked = promptDataRoot('change');
    if (!picked) return { ok: false };
    const root = dataRoot.readPointer(APP_DATA_BASE, APP_NAME);
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 300);
    return { ok: true, root };
  });

  // 归档读写：先写临时文件再 rename，避免中途断电留下半截 JSON
  ipcMain.handle('data:read-json', (_e, key) => {
    const file = dataJsonPath(key);
    if (!file || !fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      log(`读取 ${key}.json 失败：${err && err.message ? err.message : err}`);
      return null;
    }
  });
  ipcMain.handle('data:write-json', (_e, key, value) => {
    const file = dataJsonPath(key);
    if (!file) throw new Error(`不允许写入的数据文件：${key}`);
    fs.mkdirSync(DATA_JSON_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value === undefined ? null : value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  });

  // 当前会话：每个角色一份 session.json，放在角色目录里
  function sessionFile() {
    const active = characterHost.resolve().active;
    if (!active || !active.dir) return '';
    return path.join(active.dir, 'session.json');
  }
  ipcMain.handle('session:read', () => {
    const file = sessionFile();
    if (!file) return { ok: false, exists: false, messages: [] };
    if (!fs.existsSync(file)) return { ok: true, exists: false, messages: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const messages = Array.isArray(raw) ? raw : Array.isArray(raw && raw.messages) ? raw.messages : [];
      const compress = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.compress || null : null;
      const compactLog = raw && Array.isArray(raw.compactLog) ? raw.compactLog : [];
      return { ok: true, exists: true, messages, compress, compactLog, path: file };
    } catch (err) {
      log(`读取 session.json 失败：${err && err.message ? err.message : err}`);
      return { ok: false, exists: true, messages: [], error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('session:write', (_e, body) => {
    const file = sessionFile();
    if (!file) return { ok: false, error: '没有当前角色' };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const isArray = Array.isArray(body);
      const payload = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        messages: isArray ? body : Array.isArray(body && body.messages) ? body.messages : [],
        // 压缩摘要 / 压缩点 / 记忆游标 / 压缩日志都属于这一段会话，跟消息一起走
        compress: !isArray && body && typeof body.compress === 'object' ? body.compress : null,
        compactLog: !isArray && body && Array.isArray(body.compactLog) ? body.compactLog : [],
      };
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 共用任务中心：设置页底部进度条订阅这些
  ipcMain.handle('task:list', () => taskList());
  ipcMain.handle('task:cancel', (_e, id) => taskCancel(String(id || '')));

  // 长程记忆：状态 / 按需下载模型 / 通用命令（命令白名单在 MEMORY_COMMANDS）
  ipcMain.handle('memory:status', () => getMemoryHost().status());
  ipcMain.handle('memory:ensure-model', (_e, opts) => getMemoryHost().ensureModel(opts || {}));
  ipcMain.handle('memory:call', async (_e, payload) => {
    const cmd = String((payload && payload.cmd) || '');
    if (!MEMORY_COMMANDS.has(cmd)) throw new Error(`不允许的记忆命令：${cmd}`);
    return getMemoryHost().call(cmd, (payload && payload.args) || {});
  });
}

function registerShortcuts() {
  const ok = globalShortcut.register(CLICK_THROUGH_ACCELERATOR, () => setClickThrough(!clickThrough));
  log(`global shortcut ${CLICK_THROUGH_ACCELERATOR} registered=${ok}`);
}

app.on('before-quit', () => {
  quitting = true;
  // 先让插件进程有序退出，否则会被当成「异常退出」记成 broken
  if (pluginHost) pluginHost.stopAll();
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
app.on('will-quit', () => {
  // 第二个实例没拿到单实例锁、在 ready 之前就退出了，此时还没注册过快捷键，
  // 直接调用 unregisterAll 会抛 "globalShortcut cannot be used before the app is ready"
  if (app.isReady()) globalShortcut.unregisterAll();
  try {
    emotionStore.flushAll();
  } catch (err) {
    log('[emotion] 退出前落盘失败', String((err && err.message) || err));
  }
  if (memoryHost) memoryHost.close();
  if (pluginHost) pluginHost.stopAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// 单实例：已经开了一个实例时，第二次启动不再建窗口，只把已有窗口叫出来
const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  log('second instance detected, quitting');
  // 明确告诉用户是「已经在运行」而不是让他看到一个看不懂的 JS 异常栈
  dialog.showErrorBox('提示', '程序已运行');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app
  .whenReady()
  .then(() => {
    if (!hasSingleInstance) return;
    // 还没定数据根（首启 / 目录丢失）：先引导选目录，选定后重启进程让 userData 生效
    if (!DATA_ROOT) {
      const picked = promptDataRoot(ROOT_STATE.problem);
      if (picked) app.relaunch();
      app.exit(0);
      return;
    }
    // 引导 profile 只在选目录那次用过，正常启动后清掉，别在 C 盘留残余
    try {
      fs.rmSync(path.join(APP_DATA_BASE, APP_NAME, '.bootstrap'), { recursive: true, force: true });
    } catch (_) {
      /* 删不掉就算了，不影响运行 */
    }
    // 标记文件被用户删掉时自动补回，避免下次被当成陌生目录
    try {
      dataRoot.ensureMarker(DATA_ROOT);
    } catch (err) {
      log('[data-root] 标记文件写入失败', err && err.message ? err.message : String(err));
    }
    Menu.setApplicationMenu(null);
    // 录音需要 Chromium 的 media 权限；默认可能被拒，这里显式放行音频采集
    const defaultSession = session.defaultSession;
    const isMediaPermission = (permission) =>
      permission === 'media' || permission === 'microphone' || permission === 'audioCapture';
    defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(isMediaPermission(permission));
    });
    defaultSession.setPermissionCheckHandler((_wc, permission) => isMediaPermission(permission));
    registerAppProtocol();
    registerIpc();
    createWindow();
    createTray();
    registerShortcuts();
    log('app ready', JSON.stringify(captureArg || {}));
    // 启动时确保当前角色的内核有清单（缺失或内核文件被改过就重算哈希）
    ensureActiveKernelManifest();

    if (captureArg) {
      setTimeout(async () => {
        try {
          const result = await captureTo(captureArg.pngPath);
          log('CAPTURE_OK', JSON.stringify(result));
          // app.exit 不会触发 will-quit：先手动停掉插件进程，避免被误标 broken
          if (pluginHost) pluginHost.stopAll();
          app.exit(0);
        } catch (err) {
          log('CAPTURE_FAIL', err && err.stack ? err.stack : String(err));
          if (pluginHost) pluginHost.stopAll();
          app.exit(1);
        }
      }, captureArg.delayMs);
    }
  })
  .catch((err) => {
    log('[whenReady failed]', err && err.stack ? err.stack : String(err));
    app.exit(1);
  });
