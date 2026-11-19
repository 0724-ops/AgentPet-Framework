// ============================================================================
//  桌面伴侣 —— 应用层（壳）
//  3D 渲染 / 动作执行全部在角色包的内核里（app://si/characters/<id>/...），壳只通过 window.pet 对接。
// ============================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 伪工具标记（<<<SPEAK ...>>> / <<<MEM_MARK ...>>>）的流式剥离器
import { createPseudoToolParser, sanitizePseudoText } from './pseudo-tools.js';
// 压缩模型返回的 JSON（summary + facts）容错解析
import { parseCompressResult } from './compress-result.js';
// 情感：数值引擎（由 index.html 的 classic script 挂到全局）+ 事件识别
import { createEmotionClassifier } from '../emotion/classify.js';
// 情绪化上下文：注入轮数 / 情绪补齐的纯计算（app/emotion/context-window.js）
import { planHistoryWindow, pickTurnsByMood, MIN_CONTEXT_TURNS } from '../emotion/context-window.js';
const E = (typeof window !== 'undefined' && window.AgentPetEmotionEngine)
  || (typeof globalThis !== 'undefined' && globalThis.AgentPetEmotionEngine);

// 设置 / 动作队列是独立窗口，加载的是同一份页面，只是参数不同：
// ?panel=settings|actions。面板窗口不挂 3D 内核，只镜像主窗口的状态。
const BOOT_PARAMS = new URLSearchParams(location.search);
const PANEL_KIND = BOOT_PARAMS.get('panel') || '';
const IS_PANEL = !!PANEL_KIND;
if (IS_PANEL) document.documentElement.dataset.panel = PANEL_KIND;

// ------------------------------------------------------------------ 持久化
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* ignore quota errors */
    }
  },
};

const settings = store.get('agentpet.settings', {
  mouseFollow: true,
  releaseOnLeave: true,
  // 禁用拖动旋转：开启后回到默认朝向，舞台区不再响应左键拖动
  disableRotate: false,
  resolution: '2',
  background: 'dark',
  // 毛玻璃：系统材质（acrylic / mica）与页面暗色浓度，仅毛玻璃模式生效
  glassMaterial: 'acrylic',
  glassOpacity: 0.45,
  modelScale: 1,
  modelRotation: 0,
  scalePivot: 0,
  autoRead: false,
  // 系统语音（Web Speech）默认开启；语音插件可用时自动接管
  ttsWeb: true,
  ttsSpeed: 1,
  bloomOn: true,
  bloomStrength: 0.15,
  bloomThreshold: 0.8,
  historyWindow: 20,
  toolRounds: 8,
  toolRepeatLimit: 3,
  // 上下文自动压缩：发送前未压缩上下文超过 autoCompressAt 就先压缩一次
  autoCompress: true,
  autoCompressAt: 0.75,
  // 请求稳定性：无输出超时 + 失败重试次数
  llmIdleTimeoutOn: true,
  llmIdleTimeoutSec: 60,
  // 压缩生成的摘要较长，单独给一个更宽松的无输出等待时长
  compressIdleTimeoutSec: 180,
  llmRetries: 3,
  // 窗口不在前台时，回复完成就弹系统通知 + 闪任务栏图标
  notifyBackground: true,
  // 图片读取权限：关闭 = 只允许本会话里拖入 / 输入过的图片路径
  imageReadPerm: false,
  // 长期记忆默认关：需要时在设置页手动开启，开启时才按需下载向量模型
  memoryEnabled: false,
  memoryExtractEvery: 3,
  memoryModel: '',
  // 长程记忆读取参数（Step 3）
  longMemoryTheta: 0.45,
  longMemoryMax: 6,
  longMemoryMaxChars: 360,
  // 长程记忆结算参数（Step 5：设置页滑块）
  longMemoryBoost: 0.35,
  longMemoryPenalty: 0.5,
  longMemoryDecay: 1,
  longMemoryWarm: 0.45,
  longMemoryCold: 0.15,
  longMemoryDeleteTurns: 50,
  // 对话里是否显示「思考」折叠行；默认关闭，聊天更沉浸
  chatShowThink: false,
  // 渲染后端与内核性能档：webgl = 默认（稳定），webgpu = 实验性（FSR / 帧生成）
  kernelBackend: 'webgl',
  // 超分辨率（FSR 时间超分）：需客户端重载内核才生效
  fsrOn: false,
  fsrScale: 0.66,
  // 帧生成（RIFE 插帧）：出图降到 frameGenHz，呈现仍跟显示器
  frameGenOn: false,
  frameGenHz: 30,
  // 运行时性能档：0 = 跟随显示器（vsync），自适应画质默认关
  targetFPS: 0,
  adaptiveQuality: false,
  // 画面功能开关（描边 / 水墨特效）与眨眼
  vfxOn: true,
  outlineOn: true,
  blinkOn: true,
  blinkInterval: 3,
  // 关闭画面：不挂 3D 内核，舞台中间只显示「已停止渲染」（默认关）
  visualOff: false,
  // 进后台（最小化 / 收起到托盘）自动关闭画面，回到前台再挂回来（默认关）
  visualOffInBackground: false,
  // 切换角色时是否先把当前会话存入归档（默认关）
  archiveOnSwitch: false,
  // 切换角色后是否按新角色的动作库重建 ACTIONS（默认关）
  rebuildActionsOnSwitch: false,
  // 自动唤醒：默认关；只控制长时间待机时是否主动开口，状态记录与统计始终运行
  emotionEnabled: false,
  // 情绪页默认用简易版：少一些进度条，需要细节时切「全量」
  emotionSimpleView: true,
  // 主动消息：动态概率 + 额度上限（设计 §9.2）
  proactiveCheckSeconds: 60,
  proactiveWeight: 1,
  proactiveCooldownMin: 90,
  proactiveCap: 'auto',
  // 自动上限的倍率：向下取整，例如 3 × 1.4 = 4；手动指定上限时不受它影响
  proactiveCapMultiplier: 1,
  proactiveQuietMin: 5,
  proactiveFloor: true,
  proactiveIgnoreHours: 12,
  // 生物钟：身体与褪黑素按这张表走；主动消息里的 {phase} 仍按真实钟点
  wakeHour: 6,
  sleepHour: 22,
  // 每轮往系统提示里注入一行「当前状态：清醒」，模板来自 preset-emotion.md
  injectEmotionState: true,
  // 状态标签映射表：困意 ≥ min 就用这条文案；用户可在选项页改（默认四档）
  stateTiers: [
    { min: 80, label: '很困' },
    { min: 65, label: '比较困' },
    { min: 50, label: '有点困' },
    { min: 0, label: '清醒' },
  ],
  // 雷达先验强度：越小学单条回复影响越大，默认 20 条
  traitSpan: 20,
  // 性格自适应：每轮语气是否慢慢沉淀进底色（影响情绪与说话方式），默认关
  traitAdapt: false,
  // MOOD 缺失兜底：模型漏写心情标记时，用她这条回复做一次半强度归类，默认开
  moodFallback: true,
  // 情绪化上下文：按当前压力决定注入多少轮（上限仍是 historyWindow），默认关
  emotionContext: false,
  // 情绪一致性：把剩下的 35% 换成「情绪相近、印象更深」的旧对话，默认开
  emotionContextPick: true,
});
// 老版本存下来的设置里没有 scalePivot，补一个默认值（0 = 缩放时脚底不动）
if (typeof settings.scalePivot !== 'number') settings.scalePivot = 0;
// 老版本没有 MOOD 兜底开关：默认打开
if (settings.moodFallback == null) settings.moodFallback = true;
// 老版本没有的新设置项也要补默认值（store.get 不会自动合并新键）
if (settings.ttsWeb == null) settings.ttsWeb = true;
if (settings.bloomOn == null) settings.bloomOn = true;
if (typeof settings.bloomStrength !== 'number') settings.bloomStrength = 0.15;
if (typeof settings.bloomThreshold !== 'number') settings.bloomThreshold = 0.8;
if (!Number.isFinite(settings.historyWindow)) settings.historyWindow = 20;
settings.historyWindow = Math.max(4, Math.min(100, Math.round(settings.historyWindow)));
if (!Number.isFinite(settings.toolRounds)) settings.toolRounds = 8;
settings.toolRounds = Math.max(3, Math.min(20, Math.round(settings.toolRounds)));
if (!Number.isFinite(settings.toolRepeatLimit)) settings.toolRepeatLimit = 3;
settings.toolRepeatLimit = Math.max(2, Math.min(10, Math.round(settings.toolRepeatLimit)));
// 自动压缩：老版本没有这两个键，补默认值
if (settings.autoCompress == null) settings.autoCompress = true;
if (!Number.isFinite(settings.autoCompressAt)) settings.autoCompressAt = 0.75;
settings.autoCompressAt = Math.max(0.3, Math.min(0.95, settings.autoCompressAt));
// 请求稳定性：老版本没有这三个键，补默认值并夹取范围
if (settings.llmIdleTimeoutOn == null) settings.llmIdleTimeoutOn = true;
if (!Number.isFinite(settings.llmIdleTimeoutSec)) settings.llmIdleTimeoutSec = 60;
settings.llmIdleTimeoutSec = Math.max(10, Math.min(300, Math.round(settings.llmIdleTimeoutSec)));
if (!Number.isFinite(settings.compressIdleTimeoutSec)) settings.compressIdleTimeoutSec = 180;
settings.compressIdleTimeoutSec = Math.max(30, Math.min(600, Math.round(settings.compressIdleTimeoutSec)));
if (!Number.isFinite(settings.llmRetries)) settings.llmRetries = 3;
settings.llmRetries = Math.max(0, Math.min(5, Math.round(settings.llmRetries)));
// 自动记忆：老版本没有这几个键，补默认值并夹取范围（默认关）
if (settings.memoryEnabled == null) settings.memoryEnabled = false;
if (!Number.isFinite(settings.memoryExtractEvery)) settings.memoryExtractEvery = 3;
settings.memoryExtractEvery = Math.max(1, Math.min(10, Math.round(settings.memoryExtractEvery)));
if (typeof settings.memoryModel !== 'string') settings.memoryModel = '';
// 长程记忆检索参数
if (!Number.isFinite(settings.longMemoryTheta)) settings.longMemoryTheta = 0.45;
settings.longMemoryTheta = Math.max(0.2, Math.min(0.9, settings.longMemoryTheta));
if (!Number.isFinite(settings.longMemoryMax)) settings.longMemoryMax = 6;
settings.longMemoryMax = Math.max(1, Math.min(12, Math.round(settings.longMemoryMax)));
if (!Number.isFinite(settings.longMemoryMaxChars)) settings.longMemoryMaxChars = 360;
settings.longMemoryMaxChars = Math.max(120, Math.min(800, Math.round(settings.longMemoryMaxChars)));
// 长程记忆结算参数（Step 5）：老版本没有这些键，补默认值并夹取范围
if (!Number.isFinite(settings.longMemoryBoost)) settings.longMemoryBoost = 0.35;
settings.longMemoryBoost = Math.max(0, Math.min(1.5, settings.longMemoryBoost));
if (!Number.isFinite(settings.longMemoryPenalty)) settings.longMemoryPenalty = 0.5;
settings.longMemoryPenalty = Math.max(0, Math.min(2, settings.longMemoryPenalty));
if (!Number.isFinite(settings.longMemoryDecay)) settings.longMemoryDecay = 1;
settings.longMemoryDecay = Math.max(0.2, Math.min(3, settings.longMemoryDecay));
if (!Number.isFinite(settings.longMemoryCold)) settings.longMemoryCold = 0.15;
settings.longMemoryCold = Math.max(0.02, Math.min(0.6, settings.longMemoryCold));
if (!Number.isFinite(settings.longMemoryWarm)) settings.longMemoryWarm = 0.45;
settings.longMemoryWarm = Math.max(settings.longMemoryCold, Math.min(1.2, settings.longMemoryWarm));
if (!Number.isFinite(settings.longMemoryDeleteTurns)) settings.longMemoryDeleteTurns = 50;
settings.longMemoryDeleteTurns = Math.max(5, Math.min(500, Math.round(settings.longMemoryDeleteTurns)));
if (settings.chatShowThink == null) settings.chatShowThink = false;
settings.chatShowThink = !!settings.chatShowThink;
// 图片读取权限默认关闭：只放行本会话里出现过的图片路径
if (settings.imageReadPerm == null) settings.imageReadPerm = false;
settings.imageReadPerm = !!settings.imageReadPerm;
// 切换角色自动归档：默认关闭
if (settings.archiveOnSwitch == null) settings.archiveOnSwitch = false;
settings.archiveOnSwitch = !!settings.archiveOnSwitch;
// 切换角色自动重建动作预设：默认关闭
if (settings.rebuildActionsOnSwitch == null) settings.rebuildActionsOnSwitch = false;
settings.rebuildActionsOnSwitch = !!settings.rebuildActionsOnSwitch;
// 渲染后端 / 超分 / 帧生成 / 性能档（1.3.0 内核新增）：老版本没有这些键，补默认值并夹取
if (settings.kernelBackend !== 'webgpu' && settings.kernelBackend !== 'webgl') settings.kernelBackend = 'webgl';
if (settings.fsrOn == null) settings.fsrOn = false;
settings.fsrOn = !!settings.fsrOn;
if (!Number.isFinite(settings.fsrScale)) settings.fsrScale = 0.66;
settings.fsrScale = Math.max(0.4, Math.min(1, settings.fsrScale));
if (settings.frameGenOn == null) settings.frameGenOn = false;
settings.frameGenOn = !!settings.frameGenOn;
if (!Number.isFinite(settings.frameGenHz)) settings.frameGenHz = 30;
settings.frameGenHz = Math.max(12, Math.min(120, Math.round(settings.frameGenHz)));
if (!Number.isFinite(settings.targetFPS)) settings.targetFPS = 0;
settings.targetFPS = Math.max(0, Math.min(240, Math.round(settings.targetFPS)));
if (settings.adaptiveQuality == null) settings.adaptiveQuality = false;
settings.adaptiveQuality = !!settings.adaptiveQuality;
if (settings.vfxOn == null) settings.vfxOn = true;
if (settings.outlineOn == null) settings.outlineOn = true;
if (settings.blinkOn == null) settings.blinkOn = true;
if (!Number.isFinite(settings.blinkInterval)) settings.blinkInterval = 3;
settings.blinkInterval = Math.max(0.5, Math.min(30, settings.blinkInterval));
if (settings.visualOff == null) settings.visualOff = false;
settings.visualOff = !!settings.visualOff;
if (settings.visualOffInBackground == null) settings.visualOffInBackground = false;
settings.visualOffInBackground = !!settings.visualOffInBackground;
// 情感系统 + 主动消息：老版本没有这些键，补默认值并夹取范围
if (settings.emotionEnabled == null) settings.emotionEnabled = false;
settings.emotionEnabled = !!settings.emotionEnabled;
settings.emotionSimpleView = settings.emotionSimpleView !== false;
if (!Number.isFinite(settings.proactiveCheckSeconds)) settings.proactiveCheckSeconds = 60;
settings.proactiveCheckSeconds = Math.max(15, Math.min(600, Math.round(settings.proactiveCheckSeconds)));
if (!Number.isFinite(settings.proactiveWeight)) settings.proactiveWeight = 1;
settings.proactiveWeight = Math.max(0, Math.min(100, settings.proactiveWeight));
if (!Number.isFinite(settings.proactiveCooldownMin)) settings.proactiveCooldownMin = 90;
settings.proactiveCooldownMin = Math.max(0, Math.min(1440, Math.round(settings.proactiveCooldownMin)));
if (settings.proactiveCap !== 'auto') {
  const cap = Math.round(Number(settings.proactiveCap));
  settings.proactiveCap = Number.isFinite(cap) ? Math.max(1, Math.min(20, cap)) : 'auto';
}
if (!Number.isFinite(settings.proactiveCapMultiplier)) settings.proactiveCapMultiplier = 1;
settings.proactiveCapMultiplier = Math.max(0.1, Math.min(3, settings.proactiveCapMultiplier));
if (!Number.isFinite(settings.proactiveQuietMin)) settings.proactiveQuietMin = 5;
settings.proactiveQuietMin = Math.max(0, Math.min(120, Math.round(settings.proactiveQuietMin)));
if (settings.proactiveFloor == null) settings.proactiveFloor = true;
settings.proactiveFloor = !!settings.proactiveFloor;
if (!Number.isFinite(settings.proactiveIgnoreHours)) settings.proactiveIgnoreHours = 12;
settings.proactiveIgnoreHours = Math.max(1, Math.min(72, Math.round(settings.proactiveIgnoreHours)));
// 雷达先验强度：老版本没有这个键，补默认 20；范围与滑块一致
if (!Number.isFinite(settings.traitSpan)) settings.traitSpan = 20;
settings.traitSpan = Math.max(1, Math.min(100, Math.round(settings.traitSpan)));
if (settings.traitAdapt == null) settings.traitAdapt = false;
settings.traitAdapt = !!settings.traitAdapt;
// 生物钟：清醒 8~20 小时，越界的存值在这里拉回来
if (!Number.isFinite(settings.wakeHour)) settings.wakeHour = 6;
if (!Number.isFinite(settings.sleepHour)) settings.sleepHour = 22;
{
  const rhythm = E && E.normalizeRhythm({ wake: settings.wakeHour, sleep: settings.sleepHour });
  if (rhythm) {
    settings.wakeHour = rhythm.wake;
    settings.sleepHour = rhythm.sleep;
  }
}
// 状态标签映射表：老版本没有这个键就补默认；存坏的表在这里整理回合法形态
settings.stateTiers = E.normalizeTiers(settings.stateTiers);
// 一次性迁移：1.3.0 预览版把 webgpu 当默认值存进过 localStorage，这里统一改回 webgl；
// 用户之后在设置页手动切到 WebGPU（实验性）后不会再被改回来。
if (!store.get('agentpet.backendDefaultV2', false)) {
  settings.kernelBackend = 'webgl';
  store.set('agentpet.backendDefaultV2', true);
  store.set('agentpet.settings', settings);
}
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// 笔记卡片正文硬上限：工具写入超过这个字数直接拒绝，避免模型把整篇文档塞进笔记
const MEMORY_MAX_CHARS = 2000;

// ------------------------------------------------------------------ 自动记忆数据层
// 便签（note）是手动资料；这里是后台静默提取的结构化事实，会自动拼进系统提示。
const MEMORY_TYPES = ['偏好', '事件', '长期事实'];
const MEMORY_HALF_LIFE_DAYS = 7; // 艾宾浩斯半衰期：7 天不看，分数减半
const MEMORY_INJECT_LIMIT = 5; // 普通记忆每次最多注入前 5 条
const MEMORY_MIN_SCORE = 0.2; // 当前分数低于这个值视为淡忘，不再注入
const MEMORY_FACT_MAX_CHARS = 300;
const MEMORY_DEFAULT_CONFIDENCE = 0.8;

// 每条事实：mkey 唯一键 / type 类型 / content 内容 / confidence 置信度 /
// last_accessed_at 召回时间 / is_pinned 置顶 / status active|superseded|archived
function normalizeMemoryFact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mkey = String(raw.mkey || '').trim();
  const content = String(raw.content || '').trim();
  if (!mkey || !content) return null;
  const type = MEMORY_TYPES.includes(raw.type) ? raw.type : '长期事实';
  const conf = Number(raw.confidence);
  const accessed = Number(raw.last_accessed_at);
  const created = Number(raw.created_at);
  const updated = Number(raw.updated_at);
  return {
    id: String(raw.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    mkey,
    type,
    content: content.slice(0, MEMORY_FACT_MAX_CHARS),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : MEMORY_DEFAULT_CONFIDENCE,
    last_accessed_at: Number.isFinite(accessed) && accessed > 0 ? accessed : Date.now(),
    is_pinned: !!raw.is_pinned,
    status: ['active', 'superseded', 'archived'].includes(raw.status) ? raw.status : 'active',
    created_at: Number.isFinite(created) && created > 0 ? created : Date.now(),
    updated_at: Number.isFinite(updated) && updated > 0 ? updated : Date.now(),
  };
}

let memoryFacts = store.get('agentpet.memoryFacts', []);
if (!Array.isArray(memoryFacts)) memoryFacts = [];
memoryFacts = memoryFacts.map(normalizeMemoryFact).filter(Boolean);

let memoryArchive = store.get('agentpet.memoryArchive', []);
if (!Array.isArray(memoryArchive)) memoryArchive = [];
memoryArchive = memoryArchive
  .filter((a) => a && String(a.text || '').trim())
  .map((a) => ({
    id: String(a.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    at: Number(a.at) || Date.now(),
    text: String(a.text).trim(),
  }));

let memoryTurnCounter = Math.max(0, Number(store.get('agentpet.memoryTurnCounter', 0)) || 0);
let memoryExtracting = false;

// 内核入口完全来自当前角色包（characters/<id>/...），程序不再自带内核。
// entry = 原生 WebGPU（poc4，实验性），webglEntry = WebGL（poc，默认）。
const FALLBACK_KERNEL = {
  entry: '',
  webglEntry: '',
  label: '',
};
// 旧版本存过的内核入口（目录结构换过三次），读到时直接回落到配置里的新入口
const LEGACY_KERNEL_ENTRIES = new Set([
  'poc/index.html',
  'kernels/si/0.1.2/index.html',
  'kernels/0.1.2/index.html',
  'kernels/0.1.2/poc/index.html',
]);
let appConfig = null;
let activeCharacter = null;

// 界面上所有会显示名字的地方都走这两个函数：应用名 / 角色名分别来自配置，
// 换角色、换应用名都不用改代码（应用名和角色名是两个概念，不再同名兜底）。
function appNameText() {
  const raw = appConfig || {};
  return raw.appName || raw.name || '';
}

function charNameText() {
  return (activeCharacter && activeCharacter.name) || '';
}

let DEFAULT_KERNEL = { ...FALLBACK_KERNEL };
let kernelConfig = { ...DEFAULT_KERNEL };
// WebGPU 起不来时自动退回 WebGL，只退一次，避免来回重载
let kernelFallbackUsed = false;

// 渲染后端：webgl = poc（默认，稳定），webgpu = poc4（实验性，FSR / 帧生成）
function kernelBackend() {
  return settings.kernelBackend === 'webgl' ? 'webgl' : 'webgpu';
}

function deriveWebglEntry(entry) {
  const s = String(entry || '');
  return s.replace(/\/poc4\//, '/poc/');
}

// 内核有没有两条入口（poc + poc4）。只有同时带两条入口时，
// 「渲染后端」开关才有意义；只带一条入口的内核，后端由这条入口本身决定。
function canSwitchKernelBackend() {
  return !!(kernelConfig && kernelConfig.webglEntry);
}

function entryBackend(entry) {
  // 条目形如 characters/<id>/kernel/poc4/index.html，也可能是旧版的 poc4/index.html
  return /(^|[\\/])poc4[\\/]/i.test(String(entry || '')) ? 'webgpu' : 'webgl';
}

// 实际生效的后端：能切就按用户设置，只有一条入口就按入口自己判断（poc4 → WebGPU，其余 → WebGL）
function renderBackendEffective() {
  return canSwitchKernelBackend() ? kernelBackend() : entryBackend(kernelConfig && kernelConfig.entry);
}

// 内核入口跟着「渲染后端」走：用角色包带回的两条入口
// （只带了一条入口的内核，webglEntry 为空，任何后端都用这一条）
function currentKernelEntry() {
  const backend = renderBackendEffective();
  if (backend === 'webgl' && kernelConfig.webglEntry) return kernelConfig.webglEntry;
  return kernelConfig.entry;
}

// actions.json 读不到时的兜底分组（和旧版选择器一致）
const FALLBACK_GROUPS = [
  { id: 'loop', title: '循环 / 状态', loop: true },
  { id: 'once', title: '一次性动作', loop: false },
];

function configPath(rel, fallback) {
  const raw = String(rel || fallback || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return raw ? `/${raw}` : fallback;
}

// 角色配置里的动作库目录（clip 的 _index.json 所在位置）
function characterClips() {
  return configPath(activeCharacter && activeCharacter.clips, '');
}

async function loadAppConfig() {
  let raw = null;
  try {
    // 配置由主进程装配（components.json + 当前角色），渲染层不再直接读文件
    raw = await window.petApi.appConfig();
  } catch (err) {
    console.warn('[shell] app config unavailable', err);
    return null;
  }
  if (!raw) return null;
  appConfig = raw;
  const chars = Array.isArray(raw.characters) ? raw.characters.filter((c) => c && c.id) : [];
  activeCharacter = chars.find((c) => c.id === raw.defaultCharacter) || chars[0] || null;
  const kernel = (activeCharacter && activeCharacter.kernel) || {};
  DEFAULT_KERNEL = {
    entry: kernel.entry || '',
    webglEntry: kernel.webglEntry || deriveWebglEntry(kernel.entry) || '',
    label: kernel.label || (charNameText() ? `${charNameText()} · 内核` : ''),
  };
  // 旧版本存过 'poc/index.html' / 'kernels/si/0.1.2/index.html'，目录结构已经变了，直接回落到角色配置
  // 内核跟着角色走：entry 相同但角色不同时不能串用
  const stored = store.get('agentpet.kernel', null);
  const storedEntry = stored && stored.entry;
  const sameCharacter =
    !stored || !stored.characterId || stored.characterId === (activeCharacter && activeCharacter.id);
  const usable =
    !!DEFAULT_KERNEL.entry &&
    sameCharacter &&
    storedEntry &&
    !LEGACY_KERNEL_ENTRIES.has(storedEntry) &&
    storedEntry !== DEFAULT_KERNEL.webglEntry;
  kernelConfig = usable ? stored : { ...DEFAULT_KERNEL };
  // 老记录没有 characterId：第一次读到时就归属到当前角色，避免切换后误用
  if (usable && !stored.characterId) {
    stored.characterId = activeCharacter && activeCharacter.id;
    store.set('agentpet.kernel', stored);
  }
  return raw;
}

// 把界面里的静态名字换成配置里的实际名字（标题 / 唤醒提示 / 输入框 / 对话标题等）
function applyUiNames() {
  const app = appNameText();
  const who = charNameText();
  const char = who || '角色';
  document.title = who && app ? `${who} · ${app}` : (app || who);
  const titleNode = $('#chat-title');
  if (titleNode) titleNode.textContent = `与 ${char} 对话`;
  const input = $('#chat-input');
  if (input) input.dataset.placeholder = `给 ${char} 发送消息…（Enter 发送，Shift+Enter 换行）`;
  const frame = $('#pet-frame');
  if (frame) frame.title = char;
  const wake = $('#stage-loading-text');
  if (wake) wake.textContent = `正在唤醒${who}…`;
  const follow = $('#set-mouse-follow-desc');
  if (follow) follow.textContent = `关闭后${char}不再用眼神追随鼠标`;
}

// 动作的中文名 / 分类 / 常用集来自内核目录下的 actions.json（数据文件）
let actionMeta = { names: {}, bases: {}, aliases: [], groups: FALLBACK_GROUPS, common: [] };

async function loadActionMeta(refresh = false) {
  const rel = (activeCharacter && activeCharacter.actions) || '';
  // 先清空：换角色后新清单读不到时不能继续沿用上一个角色的中文名 / 分类
  actionMeta = { names: {}, bases: {}, aliases: [], groups: FALLBACK_GROUPS, common: [] };
  if (!rel) return actionMeta;
  try {
    const res = await fetch(configPath(rel, '') + (refresh ? `?v=${Date.now()}` : ''));
    const raw = await res.json();
    const names = {};
    Object.entries(raw.names || {}).forEach(([key, value]) => {
      names[key] = typeof value === 'string' ? { cn: value } : { ...(value || {}) };
    });
    const aliases = Array.isArray(raw.aliases) ? raw.aliases : [];
    aliases.forEach((a) => {
      if (a && a.name && a.cn) names[a.name] = { ...(names[a.name] || {}), cn: a.cn };
    });
    const groups = Array.isArray(raw.groups) && raw.groups.length ? raw.groups : FALLBACK_GROUPS;
    actionMeta = {
      names,
      bases: raw.bases || {},
      aliases,
      groups,
      common: Array.isArray(raw.common) ? raw.common : [],
      version: raw.version || 1,
    };
  } catch (err) {
    console.warn('[shell] actions.json unavailable', err);
  }
  return actionMeta;
}

// ------------------------------------------------------------------ 元素
const el = {
  app: $('#app'),
  frame: $('#pet-frame'),
  stage: $('#stage'),
  loading: $('#stage-loading'),
  hint: $('#stage-hint'),
  topStatus: $('#top-status'),
  actionPanel: $('#action-panel'),
  actionList: $('#action-list'),
  queueTitle: $('#queue-title'),
  chatPanel: $('#chat-panel'),
  chatHistory: $('#chat-history'),
  chatInput: $('#chat-input'),
  settingsPanel: $('#settings-panel'),
  picker: $('#action-picker'),
  pickerList: $('#picker-list'),
  pickerSearch: $('#picker-search'),
  toasts: $('#toasts'),
  presetPersona: $('#preset-persona'),
  presetSpeak: $('#preset-speak'),
  presetTime: $('#preset-time'),
  presetMemory: $('#preset-memory'),
  presetProactive: $('#preset-proactive'),
  presetEmotion: $('#preset-emotion'),
  presetEmphasize: $('#preset-emphasize'),
  presetSpeakPath: $('#preset-speak-path'),
  presetTools: $('#preset-tools'),
  presetActions: $('#preset-actions'),
  toolManageList: $('#tool-manage-list'),
  toolsConfigPath: $('#tools-config-path'),
  pluginList: $('#plugin-list'),
  pluginRootPath: $('#plugin-root-path'),
  procPanel: $('#proc-panel'),
  procHead: $('#proc-head'),
  procSummary: $('#proc-summary'),
  procBody: $('#proc-body'),
  procList: $('#proc-list'),
  pluginBrowser: $('#plugin-browser'),
  pluginDetail: $('#plugin-detail'),
  pluginBack: $('#btn-plugin-back'),
  pluginDetailBackLabel: $('#plugin-detail-back-label'),
  pluginDetailIcon: $('#plugin-detail-icon'),
  pluginDetailName: $('#plugin-detail-name'),
  pluginDetailId: $('#plugin-detail-id'),
  pluginDetailDesc: $('#plugin-detail-desc'),
  pluginDetailBadges: $('#plugin-detail-badges'),
  pluginDetailStatus: $('#plugin-detail-status'),
  pluginDetailConfig: $('#plugin-detail-config'),
  pluginDetailActions: $('#plugin-detail-actions'),
  permModalMask: $('#perm-modal-mask'),
  permModalTitle: $('#perm-modal-title'),
  permModalText: $('#perm-modal-text'),
  permModalAgree: $('#perm-modal-agree'),
  permModalOk: $('#perm-modal-ok'),
  permModalCancel: $('#perm-modal-cancel'),
  permModalClose: $('#perm-modal-close'),
  charDelMask: $('#char-del-mask'),
  charDelText: $('#char-del-text'),
  charDelCode: $('#char-del-code'),
  charDelOtp: $('#char-del-otp'),
  charDelOk: $('#char-del-ok'),
  charDelCancel: $('#char-del-cancel'),
  charDelClose: $('#char-del-close'),
  consoleLog: $('#console-log'),
  consoleJump: $('#console-jump'),
  consoleInput: $('#console-input'),
  memoryList: $('#memory-list'),
};

// ------------------------------------------------------------------ 小工具
function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, 2200);
}

// 中文名来自 actions.json（names / bases / aliases），这里只做查表与派生
function deriveActionName(name) {
  const m = name.match(/^(?:dialog_state|dialog_virtual_state|interact|battle)_(.+?)_(start|end|loop)$/);
  if (!m) return '';
  const base = actionMeta.bases[m[1]] || m[1];
  if (m[2] === 'start') return `${base}·起`;
  if (m[2] === 'end') return `${base}·止`;
  return base;
}

function actionCn(name) {
  const entry = actionMeta.names[name];
  if (entry && entry.cn) return entry.cn;
  if (entry && typeof entry === 'string') return entry;
  return deriveActionName(name);
}

function displayName(name) {
  const cn = actionCn(name);
  if (!cn) return name;
  return `${cn} (${name})`;
}

function shortName(name) {
  return actionCn(name) || name;
}

// ------------------------------------------------------------------ 动作队列（壳层策略）
class QueueManager {
  constructor(pet, onEvent) {
    this.pet = pet;
    this.queue = [];
    this.onEvent = onEvent || (() => {});
    this._waiting = false;
    this._pumping = false;
    this._pumpTimer = null;
    // 暂停只影响「往内核送新动作」，当前动作继续播
    this.paused = false;
    this._limitTimer = null;

    // 队列推进只依赖内核事件；isBusy() 只用来做启动前的保护检查。
    // 内核在抛 action_finished 前已把 state 置为 idle，但同一帧里还可能继续
    // 做收尾，所以统一延迟到下一个宏任务再泵，避免 play() 撞上残留的 loading 态。
    pet.on('action_finished', () => {
      this._clearLimitTimer();
      this._waiting = false;
      this._schedulePump();
    });
    pet.on('action_failed', (e) => {
      console.warn('[queue] action failed', e.name, e.error);
      this._schedulePump(60);
    });
    pet.on('action_started', () => {
      this._waiting = false;
      this._emit();
    });
    pet.on('state', (e) => {
      this._emit();
      // 兜底：内核已经空闲（含 reset / 自动回待机）但壳里还有没播的动作。
      if (e && e.state === 'idle' && this.queue.length) this._schedulePump(20);
    });
  }

  // busy 的唯一真相源是内核
  get busy() {
    return this.pet.isBusy();
  }

  snapshot() {
    return {
      queue: [...this.queue],
      busy: this.busy,
      waiting: this._waiting,
      paused: this.paused,
      state: this.pet.getState(),
    };
  }

  pause() {
    this.paused = true;
    this._emit();
  }

  resume() {
    this.paused = false;
    this._emit();
    this._schedulePump();
  }

  togglePause() {
    this.paused ? this.resume() : this.pause();
    return this.paused;
  }

  append(name, meta = {}) {
    this.queue.push({ name, ...meta });
    this._emit();
    this._schedulePump();
    return this.queue.length;
  }

  prepend(name, meta = {}) {
    this.queue.unshift({ name, ...meta });
    this._emit();
    this._schedulePump();
    return this.queue.length;
  }

  async interrupt(name, { clearQueue = false } = {}) {
    if (clearQueue) this.queue.length = 0;
    this._clearLimitTimer();
    this._waiting = false;
    this._emit();
    const r = await this.pet.play(name, { interrupt: true });
    this._emit();
    return r;
  }

  remove(index) {
    this.queue.splice(index, 1);
    this._emit();
  }

  clear() {
    this.queue.length = 0;
    this._clearLimitTimer();
    this._emit();
  }

  // 无限动作限时：到点自动回默认待机，不填秒数就不计时
  _armLimit(item, r) {
    this._clearLimitTimer();
    const sec = Number(item && item.seconds);
    if (!r || !r.ok || !r.loop || !Number.isFinite(sec) || sec <= 0) return;
    this._limitTimer = setTimeout(async () => {
      this._limitTimer = null;
      const st = this.pet.getState();
      if (!st || st.current !== item.name) return;
      consoleLog('队列', `「${shortName(item.name)}」到达 ${sec}s 上限，切回默认`);
      await this.pet.reset();
    }, sec * 1000);
  }

  _clearLimitTimer() {
    if (this._limitTimer) {
      clearTimeout(this._limitTimer);
      this._limitTimer = null;
    }
  }

  // 统一在下一个宏任务里泵，给内核留出收尾时间（finished 事件里 state 已置 idle，
  // 但 mixer 可能还在处理同一帧的其它回调）。
  _schedulePump(delay = 0) {
    if (this._pumpTimer) return;
    this._pumpTimer = setTimeout(() => {
      this._pumpTimer = null;
      this._pump();
    }, delay);
  }

  async _pump() {
    if (this._pumping) return;
    if (this.paused) return; // 暂停：不往内核送新动作
    if (this.busy) return; // 内核忙：等 action_finished / state=idle 再推进
    const next = this.queue.shift();
    if (!next) {
      this._emit();
      await this.pet.reset();
      return;
    }
    this._pumping = true;
    this._emit();
    let r;
    try {
      r = await this.pet.play(next.name, { interrupt: false });
    } finally {
      this._pumping = false;
    }
    if (r && r.ok) {
      this._waiting = false;
      this._armLimit(next, r);
    } else if (r && r.reason === 'busy') {
      this.queue.unshift(next);
      this._waiting = true;
    } else if (r && (r.reason === 'superseded' || r.reason === 'already-playing')) {
      /* 被接管 / 已在播：等内核下一次事件 */
    } else {
      // 动作不存在或加载失败：跳过它，继续下一个
      this._schedulePump();
    }
    this._emit();
  }

  _emit() {
    this.onEvent(this.snapshot());
  }
}

// ------------------------------------------------------------------ 内核接入
let pet = null;
let queue = null;
let actions = [];
let kernelReady = false;
let kernelTries = 0;
let kernelMounted = false; // iframe 里是否挂着内核（加载中 / 已就绪都算）
let bgVisualOff = false; // 进后台自动停渲染的临时状态，和手动的 visualOff 分开记

// 现在画面是不是关着的：手动开关，或进后台自动停
function visualOffActive() {
  return settings.visualOff === true || bgVisualOff === true;
}

// ------------------------------------------------------------------ 壳 → 插件状态推送
// 只有 plugin.json 里声明 capabilities:["state"] 的插件才会收（过滤在主进程做）。
//   kernel 内核状态变化：{ status:'ready'|'stopped'|'loading', actions?:[动作名] }
//   state  周期快照：{ at, kind, kernel, busy, current, queueLength, state }
// 插件据此自己做待机判定：at 是最后一次用户操作的时间戳，busy / queueLength 表示内核与队列是否在跑。
const shellPush = {
  lastActivityAt: Date.now(),
  lastKind: 'start',
  lastAt: 0,
  timer: null,
  kernelStatus: 'loading',
  kernelSig: '',
};

const SHELL_PUSH_INTERVAL = 800; // 节流：最快 0.8s 一条，最后一条拖尾补发

function shellKernelStatus() {
  if (!kernelMounted || visualOffActive()) return 'stopped';
  return kernelReady ? 'ready' : 'loading';
}

function sendShellPayload(event, data) {
  if (!window.petApi || !window.petApi.pluginPushState) return;
  try {
    window.petApi.pluginPushState({ event, data });
  } catch (_) {
    /* 主进程正在退出：丢掉这一条即可 */
  }
}

function shellStateSnapshot(kind) {
  const snap = queue ? queue.snapshot() : null;
  const st = (snap && snap.state) || {};
  return {
    at: shellPush.lastActivityAt,
    kind: kind || shellPush.lastKind,
    kernel: shellPush.kernelStatus,
    busy: !!(snap && snap.busy),
    current: st.current || '',
    queueLength: snap ? snap.queue.length : 0,
    state: st.state || 'idle',
  };
}

function flushShellState() {
  if (shellPush.timer) {
    clearTimeout(shellPush.timer);
    shellPush.timer = null;
  }
  shellPush.lastAt = Date.now();
  sendShellPayload('state', shellStateSnapshot());
}

function pushShellState(kind) {
  if (kind) shellPush.lastKind = kind;
  const wait = SHELL_PUSH_INTERVAL - (Date.now() - shellPush.lastAt);
  if (wait <= 0) {
    flushShellState();
    return;
  }
  if (shellPush.timer) return;
  shellPush.timer = setTimeout(flushShellState, wait);
}

// 内核 ready / stopped 这种状态切换要立刻送，不能等节流。
// 动作清单还没到齐时先按 loading 报，避免插件拿到空清单就开始播开机动作；
// 同一份状态 + 同一份清单不重复推送（刷新动作列表不会让插件误以为重启了）。
function pushShellKernel(force = false) {
  const status = shellKernelStatus();
  const names = status === 'ready' ? actions.map((a) => a.name || a.file).filter(Boolean) : [];
  const eff = status === 'ready' && !names.length ? 'loading' : status;
  const sig = `${eff}:${names.join('|')}`;
  if (!force && sig === shellPush.kernelSig) return;
  shellPush.kernelSig = sig;
  shellPush.kernelStatus = eff;
  const data = { status: eff };
  if (eff === 'ready') data.actions = names;
  sendShellPayload('kernel', data);
  pushShellState('kernel');
}

// 把模型最终回复同步给插件（video-call 会把文字推到手机网页）
function pushShellChat(text, seq) {
  const body = String(text || '').trim();
  if (!body) return;
  sendShellPayload('chat', { role: 'assistant', text: body, at: Date.now(), seq: Number(seq) || 0 });
}

function markUserActivity(kind) {
  shellPush.lastActivityAt = Date.now();
  pushShellState(kind);
}

// 用户操作面：鼠标、滚轮、键盘都算「有人在用」，插件据此判断多久没动静
['pointermove', 'pointerdown', 'wheel', 'keydown'].forEach((type) => {
  window.addEventListener(type, () => markUserActivity(type), { passive: true });
});

function setTopStatus(text) {
  // 关闭画面时内核不在，不要显示「待机」这种像是还在跑的文案
  el.topStatus.textContent = visualOffActive() && text === '待机' ? '已停止渲染' : text;
}

// WebGPU 能力探测：poc4 的 RIFE 帧生成要 shader-f16，拿不到就只能禁用这项开关
// （内核侧会自己打日志跳过，但外壳必须让它显式置灰，不然用户以为开了没效果）。
let gpuCaps = { checked: false, gpu: null, f16: null };
async function probeKernelCaps() {
  if (gpuCaps.checked || renderBackendEffective() !== 'webgpu') return gpuCaps;
  const w = el.frame.contentWindow;
  const dbg = w && w.__p4;
  // 内核已经建好 WebGPU device 时直接读它（同步、准确）；requestAdapter 在部分机器上要等很久
  const device = dbg && dbg.renderer && dbg.renderer.backend && dbg.renderer.backend.device;
  if (device && device.features) {
    gpuCaps = { checked: true, gpu: true, f16: device.features.has('shader-f16') };
    return gpuCaps;
  }
  const nav = w && w.navigator;
  if (!nav || !nav.gpu) {
    gpuCaps = { checked: true, gpu: false, f16: false };
    return gpuCaps;
  }
  try {
    const adapter = await nav.gpu.requestAdapter();
    gpuCaps = {
      checked: true,
      gpu: !!adapter,
      f16: !!(adapter && adapter.features && adapter.features.has('shader-f16')),
    };
  } catch (err) {
    console.warn('[shell] WebGPU capability probe failed', err);
    gpuCaps = { checked: true, gpu: false, f16: false };
  }
  return gpuCaps;
}

// 内核启动参数：开关（光晕/描边/水墨/眨眼）与性能档（FSR / 帧生成）都在内核启动时读，
// 改这些项需要重载内核（重新拼 URL）；运行时可调的走 window.pet 接口（分辨率倍率、限帧、眨眼）。
function kernelQuery() {
  const q = new URLSearchParams();
  q.set('ui', '0');
  q.set('npr', 'all');
  if (settings.bloomOn === false) q.set('nobloom', '1');
  if (settings.vfxOn === false) q.set('novfx', '1');
  if (settings.outlineOn === false) q.set('nooutline', '1');
  if (settings.blinkOn === false) q.set('blink', '0');
  if (renderBackendEffective() === 'webgpu') {
    if (settings.fsrOn === true) {
      q.set('fsr', '1');
      q.set('scale', String(clamp(Number(settings.fsrScale) || 0.66, 0.25, 1)));
    }
    if (settings.frameGenOn === true) {
      q.set('fg', '1');
      q.set('hz', String(Math.max(12, Math.min(120, Math.round(Number(settings.frameGenHz) || 30)))));
    }
  }
  return q.toString();
}

function mountKernel(entry, { announce = false } = {}) {
  if (IS_PANEL) return;
  if (visualOffActive()) return; // 关闭画面时不挂内核
  if (!entry) {
    // 纯壳：没有角色包就没有内核可挂，舞台只提示去导入角色
    kernelReady = false;
    pet = null;
    queue = null;
    kernelTries = 0;
    kernelMounted = false;
    gpuCaps = { checked: false, gpu: null, f16: null };
    pushShellKernel();
    try {
      el.frame.src = 'about:blank';
    } catch (_) {
      /* ignore */
    }
    renderQueue(null);
    el.loading.innerHTML = '<span>请先在设置 → 角色导入角色包</span>';
    el.loading.classList.remove('hide');
    setTopStatus('无角色');
    return;
  }
  kernelReady = false;
  pet = null;
  queue = null;
  kernelTries = 0;
  kernelMounted = true;
  gpuCaps = { checked: false, gpu: null, f16: null };
  pushShellKernel(); // loading：插件会知道内核正在启动，先别急着往队列塞动作
  el.loading.classList.remove('hide');
  el.loading.innerHTML = `<span class="spinner"></span><span>正在唤醒${charNameText()}…</span>`;
  el.frame.src = `app://si/${entry}?${kernelQuery()}`;
  if (announce) consoleLog('系统', `已切换内核：${entry}`);
}

// 需要重载内核才能生效的开关（FSR / 帧生成 / 描边 / 水墨 / 后端）
function reloadKernel(reason) {
  mountKernel(currentKernelEntry());
  if (reason) consoleLog('系统', `内核重载：${reason}`);
}

// 卸载内核：iframe 置空、pet / 队列清空，之后不再有任何 3D 渲染（关闭画面 / 恢复画面都走这里）
function releaseKernel() {
  kernelReady = false;
  pet = null;
  queue = null;
  kernelTries = 0;
  kernelMounted = false;
  gpuCaps = { checked: false, gpu: null, f16: null };
  modelSpan = null;
  pushShellKernel(); // stopped：内核已卸载，动作类插件应停手
  try {
    el.frame.src = 'about:blank';
  } catch (_) {
    /* ignore */
  }
  el.loading.classList.add('hide');
  renderQueue(null);
  refreshToolManageIfOpen();
}

// 关闭画面（默认关）：打开后停掉 3D 内核、舞台显示「已停止渲染」，关掉就把内核挂回来。
// 布局保持原样，只靠 html[data-visual-off] 隐藏 iframe（app.css）。
function applyVisualOff() {
  if (IS_PANEL) return;
  const off = settings.visualOff === true;
  const root = document.documentElement;
  const wasOff = root.dataset.visualOff === '1';
  if (off) root.dataset.visualOff = '1';
  else if (!bgVisualOff) delete root.dataset.visualOff;
  const toggle = $('#set-visual-off');
  if (toggle) toggle.checked = off;
  if (off === wasOff) return;
  if (off) {
    releaseKernel();
    // 舞台中间原来的角色换成一行「已停止渲染」（沿用 loading 状态条，避免新增布局）
    el.loading.innerHTML = '<span>已停止渲染</span>';
    el.loading.classList.remove('hide');
    setTopStatus('已停止渲染');
  } else {
    setTopStatus(`正在唤醒${charNameText()}…`);
    mountKernel(currentKernelEntry());
  }
}

// 收起到托盘自动停渲染：只是省资源，不改手动开关，回到前台自动挂回来
// （最小化到任务栏不算，主进程不会发这个通知）
function suspendKernelForBackground() {
  if (IS_PANEL || bgVisualOff) return;
  if (settings.visualOff === true) return; // 已经手动关了，不用再处理
  if (!kernelMounted) return; // 本来就没挂内核
  bgVisualOff = true;
  document.documentElement.dataset.visualOff = '1';
  releaseKernel();
  el.loading.innerHTML = '<span>已停止渲染</span>';
  el.loading.classList.remove('hide');
  setTopStatus('已停止渲染');
  consoleLog('系统', '收起到托盘：已自动停止渲染');
}

function resumeKernelFromBackground() {
  if (IS_PANEL || !bgVisualOff) return;
  bgVisualOff = false;
  if (settings.visualOff === true) return; // 手动关着，保持停止
  delete document.documentElement.dataset.visualOff;
  setTopStatus(`正在唤醒${charNameText()}…`);
  mountKernel(currentKernelEntry());
  consoleLog('系统', '从托盘回来：3D 内核已重新挂载');
}

// 收起到托盘 / 从托盘回来：主进程的 hide·show 会通过 IPC 告诉我们（最小化到任务栏不发，保持渲染）。
// （webPreferences 里 backgroundThrottling:false，页面自己不会变成 hidden，所以不能只靠 visibilitychange）
function handleWindowBackground(hidden) {
  if (IS_PANEL || settings.visualOffInBackground !== true) return;
  if (hidden) suspendKernelForBackground();
  else resumeKernelFromBackground();
}

if (!IS_PANEL && window.petApi && window.petApi.onWindowBackground) {
  window.petApi.onWindowBackground(handleWindowBackground);
}

el.frame.addEventListener('load', () => {
  if (IS_PANEL) return; // 面板窗口不挂内核
  if (visualOffActive()) return; // 关闭画面：iframe 是空页，不探内核
  try {
    const doc = el.frame.contentDocument;
    if (doc) {
      const style = doc.createElement('style');
      style.textContent = '#bg,#hud{display:none!important}html,body{background:transparent!important}';
      doc.head.appendChild(style);
    }
  } catch (err) {
    console.warn('[shell] cannot style kernel iframe', err);
  }
  waitForKernel();
});

function waitForKernel() {
  if (visualOffActive()) return; // 关闭画面：不再探测内核
  const w = el.frame.contentWindow;
  if (w && w.pet) {
    initKernel(w);
    return;
  }
  // WebGPU 内核初始化失败时 window.pet 永远不会出现：别干等 40 秒，立刻退回 WebGL
  if (!kernelFallbackUsed && renderBackendEffective() === 'webgpu') {
    const dbg = w && w.__p4;
    if (dbg && dbg.status === 'error') {
      kernelFallbackUsed = true;
      // 回退入口：用内核自带的 webglEntry；
      // 只有一条 WebGPU 入口的内核没有可退的 WebGL 入口，直接报失败。
      const fallbackEntry = (kernelConfig && kernelConfig.webglEntry) || '';
      if (!fallbackEntry) {
        console.warn('[shell] WebGPU kernel failed without WebGL fallback', dbg.error || '');
        consoleLog('系统', `WebGPU 内核启动失败（该内核没有 WebGL 入口）：${dbg.error || ''}`);
        toast('WebGPU 内核启动失败，这个内核没有 WebGL 入口');
        el.loading.innerHTML = '<span>3D 内核加载失败</span>';
        return;
      }
      // 记住这次回退：否则设置页还显示「WebGPU」、FSR / 帧生成也还亮着，
      // 用户以为在用 WebGPU 但实际跑的是 WebGL。下次启动直接走 WebGL，
      // 想换回来在「渲染后端」里手动切回 WebGPU 即可。
      settings.kernelBackend = 'webgl';
      store.set('agentpet.settings', settings);
      console.warn('[shell] WebGPU kernel failed, falling back to WebGL', dbg.error || '');
      consoleLog('系统', `WebGPU 内核启动失败，已切回 WebGL：${dbg.error || ''}`);
      toast('WebGPU 不可用，已切回 WebGL 内核');
      syncRenderBackendUi();
      mountKernel(fallbackEntry, { announce: true });
      return;
    }
  }
  if (++kernelTries > 160) {
    el.loading.innerHTML = '<span>3D 内核加载失败</span>';
    toast('3D 内核加载失败，请查看控制台日志', '');
    console.error('[shell] kernel timeout');
    return;
  }
  setTimeout(waitForKernel, 250);
}

function initKernel(w) {
  if (kernelReady) return;
  kernelReady = true;
  pet = w.pet;

  // 换了内核（或重载）后要重新量模型：基准高度变了，缩放中心的补偿量也得重算
  modelSpan = null;
  const dbg = w.__p4 || w.__poc;
  const rootNode = dbg && dbg.root;
  modelBaseY = rootNode ? rootNode.position.y : 0;

  // 内核里自带一个 demo 队列，它会在每次动作结束时抢先 reset 回待机；
  // 壳已经有自己的队列，这里把它关掉，避免两个队列互相抢动作。
  try {
    if (w.petQueue) {
      w.petQueue.autoReset = false;
      if (typeof w.petQueue.clear === 'function') w.petQueue.clear();
    }
  } catch (err) {
    console.warn('[shell] cannot disable kernel demo queue', err);
  }

  queue = new QueueManager(pet, renderQueue);
  pushShellKernel(); // 内核就绪（清单还没到时按 loading 报）

  pet.on('action_started', (e) => {
    consoleLog('内核', `▶ ${e.name}  ${Number(e.duration).toFixed(2)}s  loop=${e.loop}`);
    setTopStatus(shortName(e.name));
  });
  pet.on('action_finished', (e) => {
    consoleLog('内核', `■ ${e.name}  reason=${e.reason}  ${Number(e.elapsed).toFixed(2)}s`);
  });
  pet.on('action_failed', (e) => {
    consoleLog('内核', `✗ ${e.name}: ${e.error}`);
    toast(`动作失败：${shortName(e.name)}`);
  });
  pet.on('warn', (e) => consoleLog('内核', `! ${e.message}`));

  fetchActions();
  // 逐项应用外壳侧设置；任何一项抛错都不该把「就绪」卡住（否则遮罩永远不消失）
  const safeApply = (fn, label) => {
    try {
      fn();
    } catch (err) {
      console.warn(`[shell] ${label} failed`, err);
    }
  };
  safeApply(() => applyResolution(settings.resolution), 'applyResolution');
  safeApply(applyModelTransform, 'applyModelTransform');
  safeApply(applyBloom, 'applyBloom');
  safeApply(applyPerformanceRuntime, 'applyPerformanceRuntime');
  safeApply(applyBlink, 'applyBlink');

  el.loading.classList.add('hide');
  setTimeout(() => el.hint.classList.add('hide'), 4500);
  setTopStatus('待机');
  renderQueue(queue.snapshot());
  consoleLog('系统', `内核就绪：${kernelConfig.label || kernelConfig.entry} · window.pet 已连接`);
  refreshToolManageIfOpen();
  // 内核跑起来之后再探能力：帧生成要 shader-f16，FSR 也可能初始化失败，都要让 UI 说清楚
  probeKernelCaps().then(() => {
    syncRenderBackendUi();
    syncKernelRuntimeCaps();
  });
}

async function fetchActions(refresh = false) {
  if (refresh) await loadActionMeta(true);
  // 动作列表由主进程按 clips 文件夹里实际存在的 .glb 重建；IPC 不可用时退回 _index.json
  let data = null;
  try {
    if (window.petApi && window.petApi.actionsIndex) data = await window.petApi.actionsIndex();
  } catch (_) {
    data = null;
  }
  if (!Array.isArray(data)) {
    try {
      const url = `${characterClips()}/_index.json` + (refresh ? `?v=${Date.now()}` : '');
      const res = await fetch(url);
      const raw = await res.json();
      data = Array.isArray(raw) ? raw : raw.actions || Object.values(raw);
    } catch (err) {
      console.warn('[shell] action index failed', err);
      data = [
        { name: 'ui_overview_loop_01', duration: 2.5, loop: true },
        { name: 'dialog_single_wave', duration: 4.17, loop: false },
        { name: 'dialog_virtual_single_idle_nod', duration: 1.33, loop: false },
        { name: 'interact_sit_start', duration: 3.75, loop: false },
        { name: 'interact_sit_loop', duration: 3.83, loop: true },
        { name: 'interact_sit_end', duration: 4, loop: false },
      ];
    }
  }
  actions = data;
  mergeAliasActions();
  renderPicker();
  renderExtensionPage();
  // 动作清单到齐后再报 kernel ready（清单空时壳层按 loading 报，插件不会盘空清单）
  pushShellKernel();
}

// 衍生动作（swing 等）不在 _index.json 里，由 actions.json 的 aliases 补进来
function mergeAliasActions() {
  (actionMeta.aliases || []).forEach((alias) => {
    if (!alias || !alias.name) return;
    if (!actions.some((a) => a.name === alias.name)) actions.push({ ...alias });
  });
  actions.sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ 动作面板
let currentProgressEl = null;

function renderQueue(snap) {
  if (!snap) return;
  pushShellState('queue'); // 队列/内核状态变了，插件侧「是否在跑」跟着更新
  const state = snap.state || {};
  const current = state.current;
  const currentIsIdle = !current || current === 'ui_overview_loop_01' || state.state === 'idle';
  const running = !currentIsIdle && !state.isIdle;

  const base = running
    ? `${1 + snap.queue.length} 个动作队列运行中`
    : snap.queue.length
      ? `${snap.queue.length} 个动作排队中`
      : '队列空闲';
  el.queueTitle.textContent = snap.paused ? `${base}（已暂停）` : base;
  syncPauseButton(snap.paused);
  updateConsoleMeta();

  el.actionList.innerHTML = '';
  currentProgressEl = null;

  if (running) {
    const card = document.createElement('div');
    card.className = 'action-card running';
    card.innerHTML = `
      <div class="action-info">
        <span>${displayName(current)}</span>
        <div class="action-meta">
          <span class="tag accent">进行中</span>
          <span class="tag">${state.loop ? '循环' : '动作'}</span>
          ${state.duration ? `<span class="tag">${Number(state.duration).toFixed(1)}s</span>` : ''}
        </div>
        <div class="progress"><i style="width:${Math.round((state.progress || 0) * 100)}%"></i></div>
      </div>
      <div class="action-controls">
        <button class="btn-icon-sm stop" title="终止并返回待机">
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
      </div>`;
    card.querySelector('.stop').onclick = async () => {
      await pet.reset();
      toast('已返回待机', 'accent');
    };
    el.actionList.appendChild(card);
    currentProgressEl = card.querySelector('.progress > i');
  }

  snap.queue.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'action-card';
    card.innerHTML = `
      <div class="action-info">
        <span>${displayName(item.name)}</span>
        <div class="action-meta">
          <span class="tag">排队 #${i + 1}</span>
          ${i === 0 ? '<span class="tag accent">下一个</span>' : ''}
          ${item.seconds > 0 ? `<span class="tag">限时 ${item.seconds}s</span>` : ''}
        </div>
      </div>
      <div class="action-controls">
        <button class="btn-icon-sm" title="从队列移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>`;
    card.querySelector('button').onclick = () => {
      queue.remove(i);
      renderQueue(queue.snapshot());
    };
    el.actionList.appendChild(card);
  });

  if (!running && !snap.queue.length) {
    const empty = document.createElement('div');
    empty.className = 'action-empty';
    empty.textContent = `队列为空。点下面的「添加动作」或直接和${charNameText() || '角色'}说话。`;
    el.actionList.appendChild(empty);
  }

  updateStatQueue(snap);
}

function tickProgress() {
  if (!currentProgressEl || !pet) return;
  const state = pet.getState();
  currentProgressEl.style.width = `${Math.round((state.progress || 0) * 100)}%`;
}

function syncPauseButton(paused) {
  const btn = $('#btn-pause-queue');
  if (!btn) return;
  btn.textContent = paused ? '继续' : '暂停';
  btn.classList.toggle('active', !!paused);
  btn.title = paused ? '继续向内核送入队列动作' : '暂停后不再向内核送入新动作';
}

$('#btn-pause-queue').onclick = () => {
  if (!queue) return;
  const paused = queue.togglePause();
  renderQueue(queue.snapshot());
  toast(
    paused ? '已暂停：当前动作播完后不再继续' : '已继续：队列恢复推进',
    paused ? '' : 'accent'
  );
};

$('#btn-clear-queue').onclick = () => {
  if (!queue) return;
  queue.clear();
  toast('队列已清空');
};

$('#btn-reset-idle').onclick = async () => {
  if (!pet) return;
  queue.clear();
  await pet.reset();
  toast('已返回待机', 'accent');
};

// ------------------------------------------------------------------ 动作选择器
// 分类规则来自 actions.json 的 groups：按顺序匹配，先命中的分组为准，最后一条当兜底。
// 新增动作只要改 actions.json，选择器自动出现新分组。
function actionGroups() {
  const groups = (actionMeta.groups || []).filter((g) => g && g.title);
  return groups.length ? groups : FALLBACK_GROUPS;
}

function matchesGroup(action, group) {
  const name = action.name || action.file || '';
  if (group.derived && action.derived) return true;
  if (Array.isArray(group.names) && group.names.includes(name)) return true;
  if (group.regex) {
    try {
      if (new RegExp(group.regex).test(name)) return true;
    } catch (_) {
      /* 配置里写错正则就当没写 */
    }
  }
  if (group.loop === true && action.loop) return true;
  if (group.loop === false && !action.loop) return true;
  return false;
}

function actionGroupOf(action) {
  const groups = actionGroups();
  return groups.find((g) => matchesGroup(action, g)) || groups[groups.length - 1];
}

let pickerShowAdvanced = false;

function renderPicker(keyword = '') {
  if (!el.pickerList) return;
  const kw = keyword.trim().toLowerCase();
  const toggle = $('#picker-advanced');
  if (toggle) {
    const advancedCount = actions.filter((a) => !isCommonAction(a.name || a.file)).length;
    toggle.hidden = !commonActions;
    toggle.textContent = pickerShowAdvanced ? '只看常用' : `高阶 · ${advancedCount}`;
    toggle.classList.toggle('active', pickerShowAdvanced);
  }
  el.pickerList.innerHTML = '';
  const list = actions.filter((a) => {
    const name = a.name || a.file || '';
    // 没在搜索、也没展开时，只列常用动作
    if (!kw && !pickerShowAdvanced && !isCommonAction(name)) return false;
    return !kw || name.toLowerCase().includes(kw) || shortName(name).toLowerCase().includes(kw);
  });
  if (!list.length) {
    el.pickerList.innerHTML = '<div class="action-empty">没有匹配的动作</div>';
    return;
  }
  actionGroups().forEach((group) => {
    const items = list.filter((a) => actionGroupOf(a) === group);
    if (!items.length) return;
    const title = document.createElement('div');
    title.className = 'picker-group-title';
    title.textContent = `${group.title} · ${items.length}`;
    el.pickerList.appendChild(title);
    items.forEach((a) => {
      const name = a.name || a.file;
      const btn = document.createElement('button');
      btn.className = 'picker-item';
      const tag = a.missing ? '缺文件' : a.loop ? '循环' : '单次';
      btn.innerHTML = `<span class="name">${shortName(name)}</span>
        <span class="tag">${tag}</span>
        <span class="code">${name}</span>`;
      btn.onclick = () => enqueueAction(name);
      el.pickerList.appendChild(btn);
    });
  });
}

function openPicker() {
  el.picker.classList.add('show');
  renderPicker(el.pickerSearch.value);
  setTimeout(() => el.pickerSearch.focus(), 30);
}

function closePicker() {
  el.picker.classList.remove('show');
}

$('#btn-add-action').onclick = () => {
  // 动作选择器单独开一个小窗口，队列面板留在主窗口内
  if (!IS_PANEL && window.petApi && window.petApi.openPanel) {
    window.petApi.openPanel('actions');
    return;
  }
  openPicker();
};
$('#close-picker').onclick = () => {
  // 动作窗口里只有这个选择器，关掉它等于关掉窗口
  if (IS_PANEL) closePanelWindow();
  else closePicker();
};
el.pickerSearch.oninput = () => renderPicker(el.pickerSearch.value);

const pickerAdvancedBtn = $('#picker-advanced');
if (pickerAdvancedBtn) {
  pickerAdvancedBtn.onclick = () => {
    pickerShowAdvanced = !pickerShowAdvanced;
    renderPicker(el.pickerSearch.value);
  };
}

let pickerMode = 'end';

function enqueueAction(name) {
  if (!queue) return;
  const limitEl = $('#picker-seconds');
  const seconds = limitEl ? Number(limitEl.value) : 0;
  const meta = { source: 'operator' };
  if (Number.isFinite(seconds) && seconds > 0) meta.seconds = seconds;
  if (pickerMode === 'front') queue.prepend(name, meta);
  else queue.append(name, meta);
  const where = pickerMode === 'front' ? '队首' : '队尾';
  const limit = meta.seconds ? ` · 限时 ${meta.seconds}s` : '';
  consoleLog('操作者', `加入${where}：${name}${limit}`);
  toast(`已加入${where}：${shortName(name)}${limit}`, 'accent');
}

$$('.picker-foot .mode-btn').forEach((btn) => {
  btn.onclick = () => {
    pickerMode = btn.dataset.mode;
    $$('.picker-foot .mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
  };
});

// ------------------------------------------------------------------ 对话
// 旧版本里模型把结束标记写成 >>（剥离器当时只认 >>>），历史记录里会残留
// <<<SPEAK ...>>，载入时统一按当前规则洗一遍，避免继续显示 / 朗读标记。
function sanitizeStoredMessages(list) {
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const text = typeof m.text === 'string' ? m.text : '';
    if (!text || text.indexOf('<<<') < 0) return m;
    const parsed = sanitizePseudoText(text);
    if (parsed.text === text && !parsed.marks.length) return m;
    const next = { ...m, text: parsed.text, speakText: parsed.speech || m.speakText };
    if (parsed.marks.length) next.memMarks = parsed.marks;
    return next;
  });
}

const chatState = {
  messages: sanitizeStoredMessages(store.get('agentpet.chat', [])),
  cleared: false,
};

// ---- 会话文件化：每个角色一份 session.json（都在各自角色目录里）
// localStorage 的 agentpet.chat 只在首次启动时迁移一次，之后不再作为存储。
let sessionWriteChain = Promise.resolve();

function saveChatSession() {
  if (IS_PANEL || !window.petApi || typeof petApi.writeChatSession !== 'function') return;
  // 压缩摘要 / 压缩点 / 记忆游标 / 压缩日志都是这一段会话的一部分，跟消息一起落盘
  const payload = {
    messages: chatState.messages,
    compress: {
      summary: store.get('agentpet.compressSummary', '') || '',
      cutoff: Number(store.get('agentpet.compressCutoff', 0)) || 0,
      cutoffSeq: Number(store.get('agentpet.compressCutoffSeq', 0)) || 0,
      memoryExtractSeq: Number(store.get('agentpet.memoryExtractSeq', 0)) || 0,
    },
    compactLog,
  };
  // 串行写入：避免旧快照后到把新内容覆盖
  sessionWriteChain = sessionWriteChain
    .then(() => petApi.writeChatSession(payload))
    .catch((err) => {
      console.warn('[shell] session save failed', err);
    });
}

function flushChatSession() {
  return sessionWriteChain;
}

// 读取当前角色的会话；文件不存在时把 localStorage 里的旧会话迁进来
async function loadChatSession() {
  if (IS_PANEL || !window.petApi || typeof petApi.readChatSession !== 'function') return;
  let res = null;
  try {
    res = await petApi.readChatSession();
  } catch (err) {
    console.warn('[shell] session read failed', err);
    return;
  }
  if (!res || !res.ok) return;
  let messages = Array.isArray(res.messages) ? res.messages : [];
  let migrated = false;
  if (!res.exists) {
    const legacy = store.get('agentpet.chat', []);
    const done = store.get('agentpet.sessionMigratedTo', '');
    if (Array.isArray(legacy) && legacy.length && !done) {
      messages = legacy;
      migrated = true;
    }
  }
  chatState.messages = sanitizeStoredMessages(messages);
  chatState.cleared = false;
  // seq 是跨重启的排序依据：先取历史最大值，再给缺 seq 的老消息补号
  entrySeq = chatState.messages.reduce(
    (max, m) => Math.max(max, m.seq || 0, ...(m.toolCalls || []).map((t) => t.seq || 0)),
    0
  );
  chatState.messages.forEach((m) => {
    if (!Number.isFinite(m.seq) || m.seq <= 0) m.seq = ++entrySeq;
    (m.toolCalls || []).forEach((t) => {
      if (!Number.isFinite(t.seq) || t.seq <= 0) t.seq = ++entrySeq;
    });
  });
  // 压缩摘要 / 压缩点 / 记忆游标 / 压缩日志都属于这段会话，随 session.json 一起恢复
  if (res.exists) {
    const cp = res.compress && typeof res.compress === 'object' ? res.compress : {};
    store.set('agentpet.compressSummary', typeof cp.summary === 'string' ? cp.summary : '');
    store.set('agentpet.compressCutoff', Number(cp.cutoff) || 0);
    store.set('agentpet.compressCutoffSeq', Number(cp.cutoffSeq) || 0);
    store.set('agentpet.memoryExtractSeq', Number(cp.memoryExtractSeq) || 0);
    compactLog = (Array.isArray(res.compactLog) ? res.compactLog : []).filter((c) => c && typeof c === 'object');
    compactLog.forEach((c) => { c.kind = 'compact'; });
    store.set('agentpet.compactLog', compactLog);
  } else if (!migrated) {
    // 新角色的第一段会话：不继承上一个角色留在 localStorage 里的压缩状态
    store.set('agentpet.compressSummary', '');
    store.set('agentpet.compressCutoff', 0);
    store.set('agentpet.compressCutoffSeq', 0);
    store.set('agentpet.memoryExtractSeq', 0);
    compactLog = [];
    store.set('agentpet.compactLog', compactLog);
  }
  // 请求前缀 / 轮次计数 / 记忆注入结果都属于上一段会话，换会话后一律重来
  currentTurnSeq = 0;
  lastRequestMessages = null;
  lastRequestStartSeq = 0;
  longMemoryContext = { block: '', items: [], query: '', at: 0 };
  memoryRead.clear();
  if (migrated) {
    store.set('agentpet.sessionMigratedTo', (activeCharacter && activeCharacter.id) || '');
    saveChatSession();
    consoleLog('系统', `旧会话已迁移到 session.json：${messages.length} 条`);
  }
  renderChat();
  scheduleConsoleRender();
}

// 聊天正文排版：模型常在 <<<SPEAK ...>>> 前后吐一串换行，而 .msg 是 pre-wrap，
// 这些换行会原样变成一整屏空行（「思考」和正文被撑开）。统一裁掉首尾空白、
// 把 3 个以上连续换行收成 1 个空行，行尾空格也去掉。
function tidyChatText(src) {
  return String(src == null ? '' : src)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

// 上一次真正发出去的 messages（只读快照）。压缩时原样回放这份前缀，
// 末尾再追加一条压缩指令 —— 服务端能命中 KV Cache，只付增量 token。
let lastRequestMessages = null;
// 上一次请求最早包含的壳层消息 seq：压缩时判断回放前缀能否覆盖整段待压缩对话
let lastRequestStartSeq = 0;

// 长程记忆读取结果（Step 3）：每轮用户输入前刷新，直接拼进 system prompt
let longMemoryContext = { block: '', items: [], query: '', at: 0 };

// Step 4：轮次结束结算。把 MEM_MARK 的 M 编号映射回主键，交给 Worker 更新激活度 / 分层 / 衰减。
async function settleLongMemory(marks = []) {
  if (!settings.memoryEnabled) return;
  if (!window.petApi || typeof petApi.memoryCall !== 'function') return;
  const items = longMemoryContext.items || [];
  const byId = new Map(items.map((m) => [String(m.id || '').toUpperCase(), m.key]));
  const wrongKeys = [];
  (Array.isArray(marks) ? marks : []).forEach((id) => {
    const key = byId.get(String(id || '').toUpperCase());
    if (key && !wrongKeys.includes(key)) wrongKeys.push(key);
  });
  try {
    const res = await petApi.memoryCall('settle', {
      injectedKeys: items.map((m) => m.key),
      wrongKeys,
      // Step 5：设置页里的结算参数，每轮按当前设置传（改完下一轮就生效）
      boost: settings.longMemoryBoost,
      penalty: settings.longMemoryPenalty,
      thetaWarm: settings.longMemoryWarm,
      thetaCold: settings.longMemoryCold,
      deleteTurns: settings.longMemoryDeleteTurns,
      decayScale: settings.longMemoryDecay,
    });
    if (!res) return;
    const bits = [`第 ${res.turn} 轮结算`];
    if (res.boosted) bits.push(`采纳 ${res.boosted}`);
    if (res.penalized) bits.push(`纠错 ${res.penalized}`);
    if (res.decayed) bits.push(`衰减 ${res.decayed}`);
    if (res.layerChanged) bits.push(`分层变化 ${res.layerChanged}`);
    if (res.deleted) bits.push(`真删 ${res.deleted}`);
    if (res.layerChanged || res.deleted) bits.push(`热 ${res.hot} / 温 ${res.warm} / 冷 ${res.cold}`);
    consoleLog('记忆', bits.join(' · '));
  } catch (err) {
    consoleLog('警告', `记忆结算失败：${err && err.message ? err.message : err}`);
  }
}

// 开启长期记忆时先检查向量模型：没装才开始下载，不用等第一句话
async function ensureMemoryModel() {
  if (!window.petApi || typeof petApi.memoryStatus !== 'function') return;
  try {
    const status = await petApi.memoryStatus();
    if (status && status.modelReady) return;
    toast('正在下载记忆向量模型…');
    const res = await petApi.memoryEnsureModel();
    if (res && res.ok) toast('向量模型已就绪');
    else if (res && res.error) toast(`向量模型下载失败：${res.error}`);
  } catch (err) {
    toast(`向量模型下载失败：${err && err.message ? err.message : err}`);
  }
}

// Step 3：每轮用户输入前检索一次长期记忆。检索失败 / 模型未就绪都不影响正常对话。
async function refreshLongMemory(query) {
  const text = String(query || '').trim();
  longMemoryContext = { block: '', items: [], query: text, at: Date.now(), note: '' };
  if (!text || !settings.memoryEnabled) {
    if (settings.memoryEnabled) return;
    longMemoryContext.note = '长期记忆已关闭，本轮不检索。';
    renderMemInjection();
    return;
  }
  if (!window.petApi || typeof petApi.memoryCall !== 'function') return;
  try {
    const status = await petApi.memoryStatus();
    if (!status || !status.modelReady) {
      // 首次使用：后台下载向量模型，这一轮先不注入；进度在设置页底栏
      longMemoryContext.note = '向量模型未就绪，本轮跳过检索（后台正在下载）。';
      renderMemInjection();
      consoleLog('记忆', '向量模型尚未就绪，本轮跳过检索，后台开始下载…');
      petApi
        .memoryEnsureModel()
        .then((res) => {
          if (res && res.ok) consoleLog('记忆', '向量模型已就绪，下一轮开始注入长期记忆');
          else if (res && res.error) consoleLog('警告', `向量模型下载失败：${res.error}`);
        })
        .catch((err) => consoleLog('警告', `向量模型下载失败：${err && err.message ? err.message : err}`));
      return;
    }
    const res = await petApi.memoryCall('retrieve', {
      query: text,
      thetaSim: settings.longMemoryTheta,
      maxInject: settings.longMemoryMax,
      maxChars: settings.longMemoryMaxChars,
    });
    longMemoryContext = {
      block: String((res && res.block) || ''),
      items: Array.isArray(res && res.items) ? res.items : [],
      query: text,
      at: Date.now(),
      dropped: (res && res.dropped) || {},
      keywordTerms: (res && res.keywordTerms) || [],
      candidateCount: Number(res && res.candidateCount) || 0,
      params: (res && res.params) || {},
      vectorHits: Number(res && res.vectorHits) || 0,
      textHits: Number(res && res.textHits) || 0,
      embedMs: Number(res && res.embedMs) || 0,
    };
    const dropped = longMemoryContext.dropped || {};
    const filterBits = [];
    if (dropped.belowTheta) filterBits.push(`低于阈值 ${dropped.belowTheta}`);
    if (dropped.overLimit) filterBits.push(`超条数/字数 ${dropped.overLimit}`);
    if (dropped.vipOverLimit) filterBits.push(`VIP 超额 ${dropped.vipOverLimit}`);
    if (dropped.meta) filterBits.push(`元信息 ${dropped.meta}`);
    if (dropped.duplicate) filterBits.push(`重复 ${dropped.duplicate}`);
    const filterText = filterBits.length ? `（${filterBits.join(' · ')}）` : '';
    if (longMemoryContext.items.length) {
      const brief = longMemoryContext.items
        .map((m) => `${m.id}(${Number(m.similarity || 0).toFixed(2)}${m.vip ? ',VIP' : ''})`)
        .join(' ');
      consoleLog(
        '记忆',
        `注入 ${longMemoryContext.items.length} 条 · 候选 ${longMemoryContext.candidateCount}${filterText}：${brief}`,
      );
    } else {
      consoleLog('记忆', `本轮没有命中长期记忆 · 候选 ${longMemoryContext.candidateCount}${filterText}`);
    }
    renderMemInjection();
  } catch (err) {
    longMemoryContext.note = `检索失败：${err && err.message ? err.message : err}`;
    renderMemInjection();
    consoleLog('警告', `记忆检索失败：${err && err.message ? err.message : err}`);
  }
}

// ------------------------------------------------------------------ 情感系统
// 设计：情感系统设计.md。默认关闭；关闭时不 tick、不识别、不注入、不写盘。
// 数值全部来自 app/emotion/engine.js（纯函数），识别走 app/emotion/classify.js。
const emotionRuntime = {
  state: null,          // 当前角色的情感状态（内存里的工作副本）
  loadedFor: '',        // 状态属于哪个角色 id
  loading: null,
  proactiveTemplate: '',// preset-proactive.md：主动开口模板
  classifier: null,
  timer: null,
  lastUserAt: 0,        // 用户最后一次发言时间（安静期闸门）
  lastRoll: null,
  lastMood: null,       // 本轮 MOOD 原话与向量归类结果（只展示，不持久化）
  radarCompare: false,  // 雷达「对比上一轮」开关（仅本次运行，不落盘）
  radarPrev: null,      // 上一轮结算前的六维快照，白线来源（仅内存）
  lastError: '',
  repaired: 0,
  note: '',
};

function emotionActive() {
  return !!E;
}

function emotionActiveId() {
  return (activeCharacter && activeCharacter.id) || '';
}

// 生物钟：身体与褪黑素按它换算钟点；{phase} 仍用真实时间
function emotionRhythm() {
  return { wake: settings.wakeHour, sleep: settings.sleepHour };
}

// 性格自适应的每轮步长：跟先验强度联动，1 条最敏感、100 条最稳；夹在 0.2%~2%
function traitAdaptRate() {
  const span = Math.max(1, Math.min(100, Number(settings.traitSpan) || 20));
  return Math.max(0.002, Math.min(0.02, 0.1 / span));
}

function emotionConfig() {
  return {
    checkSeconds: settings.proactiveCheckSeconds,
    weight: settings.proactiveWeight,
    cooldownMin: settings.proactiveCooldownMin,
    cap: settings.proactiveCap,
    capMultiplier: settings.proactiveCapMultiplier,
    nightStart: fmtClock(settings.sleepHour),
    nightEnd: fmtClock(settings.wakeHour),
    quietMin: settings.proactiveQuietMin,
    floor: settings.proactiveFloor,
    gapMin: 150,
    ignoreHours: settings.proactiveIgnoreHours,
  };
}

function emotionClassifier() {
  if (emotionRuntime.classifier || !window.petApi) return emotionRuntime.classifier;
  emotionRuntime.classifier = createEmotionClassifier({
    embed: (texts) => petApi.memoryCall('embed', { texts }),
    readCache: () => petApi.readEmotionVectors({ id: emotionActiveId() }),
    writeCache: (data) => petApi.writeEmotionVectors({ id: emotionActiveId(), data }),
    prototypes: async () => {
      const res = await petApi.readEmotionPrototypes();
      return res && res.ok ? res.data : null;
    },
    getModel: async () => {
      const st = await petApi.memoryStatus();
      return (st && st.embedModel) || '';
    },
    log: (msg) => consoleLog('情感', String(msg)),
  });
  return emotionRuntime.classifier;
}

// 原型向量首建要 1~2 秒：状态读进来后在后台预热，不阻塞第一轮对话
function warmEmotionClassifier() {
  const cls = emotionClassifier();
  if (!cls) return;
  cls
    .ready()
    .then((res) => {
      if (res && res.ok) consoleLog('情感', `心情原型就绪（${res.count} 条${res.cached ? '，缓存命中' : ''}）`);
      else if (res && res.error) consoleLog('警告', `心情原型准备失败：${res.error}`);
    })
    .catch(() => {});
}

async function loadEmotionTemplates() {
  const r = await readPresetText('readPresetProactive');
  emotionRuntime.proactiveTemplate = r.text || '';
  const s = await readPresetText('readPresetEmotion');
  emotionStateTemplateMd = s.text || '';
}

// 读取当前角色的情感档案；force=true 用于切角色 / 手动重载
async function loadEmotionState({ force = false } = {}) {
  if (!emotionActive()) {
    stopEmotionTimer();
    emotionRuntime.state = null;
    emotionRuntime.loadedFor = '';
    emotionRuntime.note = '情感引擎未加载';
    renderEmotionPanel();
    return;
  }
  const id = emotionActiveId();
  if (!id || !window.petApi || !petApi.loadEmotion) {
    emotionRuntime.note = '没有可用角色';
    renderEmotionPanel();
    return;
  }
  if (!force && emotionRuntime.loadedFor === id && emotionRuntime.state) return;
  if (emotionRuntime.loading) return emotionRuntime.loading;
  emotionRuntime.loading = (async () => {
    try {
      const res = await petApi.loadEmotion({ id });
      if (!res || !res.ok) throw new Error((res && res.error) || '读取失败');
      const now = new Date();
      const s = E.tick(res.state, now, emotionRhythm());
      settleIgnoreDue(s, now);
      emotionRuntime.state = s;
      emotionRuntime.loadedFor = id;
      emotionRuntime.radarPrev = null; // 换角色/重载后上一轮的快照不再适用
      emotionRuntime.repaired = Number(res.repaired) || 0;
      emotionRuntime.lastError = '';
      emotionRuntime.note = res.fresh ? '新档案已建立' : '';
      await loadEmotionTemplates();
      // 新建 / 修复过就立刻落盘，别等下一轮对话
      await petApi.saveEmotion({ id, state: s, immediate: true });
      warmEmotionClassifier();
      startEmotionTimer();
      consoleLog('情感', `档案已加载（${id}）${res.fresh ? ' · 新建' : ''}${emotionRuntime.repaired ? ` · 修复 ${emotionRuntime.repaired} 项` : ''}`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      emotionRuntime.lastError = msg;
      consoleLog('警告', `情感档案读取失败：${msg}`);
    } finally {
      emotionRuntime.loading = null;
      renderEmotionPanel();
    }
  })();
  return emotionRuntime.loading;
}

function saveEmotionState(immediate = false) {
  const s = emotionRuntime.state;
  const id = emotionRuntime.loadedFor || emotionActiveId();
  if (!emotionActive() || !s || !id || !window.petApi || !petApi.saveEmotion) return;
  petApi.saveEmotion({ id, state: s, immediate }).catch((err) => {
    consoleLog('警告', `情感状态保存失败：${err && err.message ? err.message : err}`);
  });
}

// 用户说话：只推进衰减、记时间、结算「被忽略」；情绪不读用户的话
async function emotionForTurn(opts) {
  emotionRuntime.lastUserAt = Date.now();
  if (!emotionActive()) return;
  if (!emotionRuntime.state) await loadEmotionState();
  const s = emotionRuntime.state;
  if (!s) return;
  const now = new Date();
  E.tick(s, now, emotionRhythm());
  // [系统信息] 不是用户说的：不刷新 lastUserAt，否则「被忽略」永远判不出来
  if (!(opts && opts.systemEvent)) E.markUserMessage(s, now);
  settleIgnoreDue(s, now);
  saveEmotionState(false);
  renderEmotionPanel();
}

// 她的自述情绪（<<<MOOD:...>>>）：只用来结算状态与统计，用完即丢。
// 没写 MOOD 时：开关打开就对「她这条回复」做一次兜底归类（半强度）；关掉则这一轮不结算。
async function emotionFromMood(mood, visibleText, msg) {
  if (!emotionActive()) return;
  const tag = String(mood || '').trim().slice(0, 60);
  const reply = String(visibleText || '').trim().slice(0, 200);
  if (!emotionRuntime.state) await loadEmotionState();
  const s = emotionRuntime.state;
  if (!s) return;
  const now = new Date();
  E.tick(s, now, emotionRhythm());
  const fallback = !tag;
  if (fallback && (settings.moodFallback === false || !reply)) {
    emotionRuntime.lastMood = { raw: '', hits: [], at: now.toISOString(), missing: true };
    saveEmotionState(false);
    renderEmotionPanel();
    return;
  }
  // 正常 MOOD 按 intensity × 0.5 结算；兜底归类再减半，避免把正文误判当成她自述
  const source = fallback ? reply : tag;
  const strength = fallback ? 0.25 : 0.5;
  let kinds = [];
  let hitsOut = [];
  let modelReady = false;
  try {
    const status = await petApi.memoryStatus();
    modelReady = !!(status && status.modelReady);
    // 关键词直通不依赖向量模型，所以模型没就绪也照样识别常见词
    const cls = emotionClassifier();
    const res = cls ? await cls.classify(source, { noCooldown: true, noVector: !modelReady }) : null;
    const hits = (res && res.hits) || [];
    hitsOut = hits.map((h) => ({ kind: h.kind, sim: h.sim, intensity: h.intensity, text: h.text }));
    if (hits.length) {
      const hit = hits[0];
      E.applyEvent(s, hit.kind, hit.intensity * strength, fallback ? 'mood-fallback' : 'mood', now, hit.sim);
      const kindText = `${hit.kind}${hit.text ? `（命中「${hit.text}」）` : ''}`;
      consoleLog(
        '情感',
        fallback
          ? `她没写 MOOD，按这条回复兜底识别为 ${kindText}（相似度 ${hit.sim}，半强度 ${(hit.intensity * strength).toFixed(2)}）`
          : `她自述的心情像 ${kindText}（相似度 ${hit.sim}，强度 ${(hit.intensity * strength).toFixed(2)}）`
      );
      kinds = hits.map((h) => h.kind);
    }
  } catch (err) {
    consoleLog('警告', `情感识别失败：${err && err.message ? err.message : err}`);
  }
  emotionRuntime.lastMood = { raw: source, hits: hitsOut, at: now.toISOString(), modelReady, fallback };
  // 记下本轮开始前的六维，面板的「对比」白线就用它，直观看出这一轮把她推向了哪边
  emotionRuntime.radarPrev = E.deriveTraits(s.stats, s.personality, settings.traitSpan);
  const valence = E.feel(s).valence;
  E.noteReplyStats(s, reply || source, kinds, valence);
  // 开关打开：这一轮的语气开始沉淀进底色，之后 feel() / 激素增益都会跟着变
  if (settings.traitAdapt) E.adaptPersonality(s, reply || source, kinds, valence, traitAdaptRate());
  // 给这条回复留一份情绪标签，供「情绪化上下文」后续按情绪挑旧对话（不进 API 历史）
  if (msg && typeof msg === 'object') {
    const hit = hitsOut[0] || null;
    msg.mood = {
      kind: hit ? hit.kind : '',
      text: hit ? hit.text || '' : '',
      intensity: hit ? Number((hit.intensity * strength).toFixed(3)) : 0,
      valence: Math.round(valence),
    };
    saveChatSession();
  }
  saveEmotionState(false);
  renderEmotionPanel();
}

// 主动开口后 N 小时没人理：补记一次「被忽略」。
// 判定只看时间戳，软件没开也会在下次启动 tick 到「现在」时补上。
function settleIgnoreDue(s, now) {
  const hit = E.applyIgnoreIfDue(s, now, emotionConfig());
  if (hit) consoleLog('情感', `主动消息 ${hit.hours} 小时没人回，记一次「被忽略」`);
  return !!hit;
}

// 主动消息：到点抽签，抽中且通过全部闸门才开口
function emotionTick() {
  if (!emotionActive() || !emotionRuntime.state) return;
  const now = new Date();
  const s = emotionRuntime.state;
  E.tick(s, now, emotionRhythm());
  const ignored = settleIgnoreDue(s, now);
  // 自动唤醒关掉时只走时间和「被忽略」结算，不抽签、不主动开口
  if (!settings.emotionEnabled) {
    if (ignored) saveEmotionState(false);
    renderEmotionPanel();
    return;
  }
  const res = E.rollProactive(s, now, emotionConfig(), {
    lastUserAt: emotionRuntime.lastUserAt
      ? new Date(emotionRuntime.lastUserAt).toISOString()
      : (s.lastUserAt || ''),
  });
  emotionRuntime.lastRoll = res;
  if (res.fired && !chatBusy && !autoCompressRunning) {
    const tpl = String(emotionRuntime.proactiveTemplate || '').trim();
    if (!tpl) {
      emotionRuntime.note = '主动模板为空（preset-proactive.md），本次不开口';
      consoleLog('情感', emotionRuntime.note);
    } else {
      const values = E.placeholders(s, now, emotionConfig());
      const prompt = E.fillTemplate(tpl, values).trim();
      E.markProactive(s, now);
      consoleLog('情感', `主动开口（p=${res.p}, 今日 ${res.quota.used + 1}/${res.quota.cap}）`);
      // 加 [系统信息] 前缀：聊天里折成一张「系统信息」小卡片，不把提示词当用户发言铺在对话里
      queuePluginChat(`[系统信息] ${prompt}`);
    }
  }
  saveEmotionState(false);
  renderEmotionPanel();
}

function startEmotionTimer() {
  stopEmotionTimer();
  if (!emotionActive()) return;
  const sec = Math.max(15, Math.min(600, Number(settings.proactiveCheckSeconds) || 60));
  emotionRuntime.timer = setInterval(emotionTick, sec * 1000);
}

function stopEmotionTimer() {
  if (emotionRuntime.timer) {
    clearInterval(emotionRuntime.timer);
    emotionRuntime.timer = null;
  }
}

// 设置页改完立即生效：开关只影响自动唤醒，状态与统计始终运行
async function applyEmotionSettings() {
  store.set('agentpet.settings', settings);
  if (settings.emotionEnabled) {
    if (emotionRuntime.note === '自动唤醒已关闭，状态照常记录') emotionRuntime.note = '';
  } else {
    emotionRuntime.note = '自动唤醒已关闭，状态照常记录';
  }
  await loadEmotionState({ force: !emotionRuntime.state });
  startEmotionTimer();
  renderEmotionPanel();
}

async function resetEmotionState() {
  const id = emotionActiveId();
  if (!id || !window.petApi || !petApi.resetEmotion) return;
  const res = await petApi.resetEmotion({ id });
  if (!res || !res.ok) {
    toast((res && res.error) || '重置失败', 'warn');
    return;
  }
  emotionRuntime.state = E.tick(res.state, new Date(), emotionRhythm());
  emotionRuntime.loadedFor = id;
  emotionRuntime.lastRoll = null;
  emotionRuntime.lastMood = null;
  emotionRuntime.note = '已恢复出厂';
  if (emotionRuntime.classifier) emotionRuntime.classifier.resetCooldowns();
  renderEmotionPanel();
  toast('情感状态已重置', 'accent');
}

async function rebuildEmotionVectors() {
  const cls = emotionClassifier();
  if (!cls) return;
  const res = await cls.ready({ force: true });
  if (res && res.ok) {
    toast(`原型向量已重建（${res.count} 条）`, 'accent');
    consoleLog('情感', `原型向量重建完成：${res.count} 条，${res.ms}ms`);
  } else {
    toast(`重建失败：${(res && res.error) || '未知错误'}`, 'warn');
  }
  renderEmotionPanel();
}

// 面板用的只读快照
function emotionSnapshot() {
  const s = emotionRuntime.state;
  if (!emotionActive() || !s) {
    return {
      enabled: emotionActive(),
      note: emotionRuntime.note || (emotionActive() ? '尚未加载' : '情感引擎未加载'),
      error: emotionRuntime.lastError,
      classifier: emotionRuntime.classifier ? emotionRuntime.classifier.stats() : null,
    };
  }
  const now = new Date();
  const cfg = emotionConfig();
  const emo = E.feel(s);
  return {
    enabled: true,
    state: s,
    emotion: emo,
    quota: E.proactiveQuota(s, now, cfg, emo),
    night: E.isNight(now, cfg),
    gapMin: Math.round(E.baseGapMinutes(s, cfg, emo)),
    influences: E.influences(s),
    events: s.events.slice(-8),
    placeholders: E.placeholders(s, now, cfg),
    lastRoll: emotionRuntime.lastRoll,
    repaired: emotionRuntime.repaired,
    classifier: emotionRuntime.classifier ? emotionRuntime.classifier.stats() : null,
    error: emotionRuntime.lastError,
    note: emotionRuntime.note,
    id: emotionRuntime.loadedFor,
  };
}

// ---------------------------------------------------------------- 情感面板
const EMOTION_PERSONALITY_NAMES = {
  warmth: '温暖', sensitivity: '敏感', resilience: '韧性',
  optimism: '乐观', openness: '开放', stubbornness: '倔强',
};
const EMOTION_BODY_NAMES = { sleepiness: '困倦' };
// 面板给用户看的名字：用感受词，不暴露激素术语
const EMOTION_HORMONE_NAMES = {
  adrenaline: '紧张', cortisol: '压力', dopamine: '快乐', oxytocin: '亲密',
  serotonin: '满足', endorphin: '治愈', melatonin: '困意',
};
const EMOTION_RELATION_NAMES = {
  affection: '亲近', trust: '信任', dependence: '依赖', security: '安心', rapport: '默契',
};
// 心情类别给用户看的名字
const EMOTION_KIND_NAMES = {
  praise: '开心', miss: '想念', tease: '傲娇', cold: '低落', worry: '担心',
  comfort: '安心', goodnight: '晚安', proud: '得意', hug: '亲近', scare: '害怕',
  horror: '受惊', thunder: '受惊', night_walk: '不安', late_night: '疲惫',
  eat: '满足', rest: '累了',
};
const EMOTION_BLOCKED_TEXT = {
  quota: '今日额度用完', night: '夜间静默', cooldown: '冷却中', quiet: '刚聊完，不打扰',
};

// 简易 / 全量视图开关先隐藏（代码保留），需要时把这里改成 true 即可恢复
const SHOW_EMOTION_VIEW_TOGGLE = false;

// UI 精简：这些条要么跟别的条一个意思、要么对普通用户太抽象，只隐藏显示，数值照常算。
// 想恢复某一条，从集合里删掉对应 key 即可。
const EMOTION_HIDDEN_METERS = new Set([
  'adrenaline', // 紧张：和「压力」几乎同义
  'serotonin',  // 满足：和「快乐」重合
  'oxytocin',   // 亲密：和「关系 · 亲近」重复
]);

function emotionMeter(label, value, max, display) {
  const pct = Math.max(0, Math.min(100, ((Number(value) || 0) / (max || 100)) * 100));
  const text = display == null ? String(Math.round(Number(value) || 0)) : String(display);
  return (
    `<div class="emotion-meter"><span class="emotion-meter-label">${escapeHtml(label)}</span>` +
    `<span class="emotion-meter-track"><i style="width:${pct.toFixed(1)}%"></i></span>` +
    `<b class="emotion-meter-value">${escapeHtml(text)}</b></div>`
  );
}

// 本轮心情：她自述的原话 → 向量归类成了什么，只展示、不持久化
function emotionMoodTrace() {
  const m = emotionRuntime.lastMood;
  if (!m) return `<div class="emotion-hint">还没有收到她的心情标记</div>`;
  if (m.missing) return `<div class="emotion-hint">这一轮没有 MOOD，情绪未结算</div>`;
  const fallbackNote = m.fallback
    ? '<div class="emotion-hint">这一轮没写 MOOD，已按她的回复兜底归类（半强度）</div>'
    : '';
  const hits = Array.isArray(m.hits) ? m.hits : [];
  if (!hits.length) {
    return (
      fallbackNote +
      `<div class="emotion-mood-raw">${escapeHtml(m.raw)}</div>` +
      `<div class="emotion-hint">${m.modelReady === false ? '记忆模型未就绪，这轮没能归类' : '没有命中任何一类'}</div>`
    );
  }
  const tags = hits
    .map((h) => {
      const kind = EMOTION_KIND_NAMES[h.kind] || h.kind;
      const label = escapeHtml(h.text || kind);
      return `<span class="emotion-tag" title="命中类别：${escapeHtml(kind)}">${label} · ${Number(h.sim || 0).toFixed(2)}</span>`;
    })
    .join('');
  return (
    fallbackNote +
    `<div class="emotion-mood-raw">${escapeHtml(m.raw)}</div>` +
    `<div class="emotion-tags">${tags}</div>`
  );
}

// 六维雷达：纯内联 SVG，无第三方依赖。prev 为可选的对比值（白线，画在数据面之上）
function emotionRadar(items, prev) {
  const cx = 100;
  const cy = 100;
  const R = 62;
  const n = items.length || 1;
  const angleOf = (i) => ((-90 + (360 / n) * i) * Math.PI) / 180;
  const point = (i, v) => {
    const a = angleOf(i);
    return [cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v];
  };
  const ring = (v) => items.map((_, i) => point(i, v).map((x) => x.toFixed(1)).join(',')).join(' ');
  const data = items
    .map((it, i) => point(i, Math.max(0, Math.min(1, Number(it.value) || 0))).map((x) => x.toFixed(1)).join(','))
    .join(' ');
  const prevLine =
    prev && prev.length === items.length
      ? `<polygon points="${prev
          .map((v, i) => point(i, Math.max(0, Math.min(1, Number(v) || 0))).map((x) => x.toFixed(1)).join(','))
          .join(' ')}" class="em-radar-prev" />`
      : '';
  const grid = [0.25, 0.5, 0.75, 1]
    .map((v) => `<polygon points="${ring(v)}" class="em-radar-grid" />`)
    .join('');
  const axes = items
    .map((it, i) => {
      const [x1, y1] = point(i, 1);
      const [tx, ty] = point(i, 1.28);
      // 变化量换到轴名下方一行，不挤占标签本身
      const delta = Number.isFinite(it.delta) && Math.abs(it.delta) >= 0.05
        ? `<tspan x="${tx.toFixed(1)}" dy="9" class="em-ax-delta">${it.delta > 0 ? '+' : ''}${it.delta.toFixed(1)}</tspan>`
        : '';
      return (
        `<line x1="${cx}" y1="${cy}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="em-radar-axis" />` +
        `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" class="em-ax">${escapeHtml(it.name)}${delta}</text>`
      );
    })
    .join('');
  return (
    `<div class="emotion-radar">` +
    `<svg viewBox="0 0 200 200" aria-hidden="true">${grid}${axes}<polygon points="${data}" class="em-radar-data" />${prevLine}</svg>` +
    `</div>`
  );
}

function emotionNumberField(key, label, value, min, max, step, suffix) {
  return (
    `<label class="emotion-field"><span>${escapeHtml(label)}</span>` +
    `<span class="emotion-field-control">` +
    `<input type="number" data-em-setting="${key}" value="${escapeHtml(String(value))}" min="${min}" max="${max}" step="${step}" />` +
    (suffix ? `<em>${escapeHtml(suffix)}</em>` : '') +
    `</span></label>`
  );
}

// 动态注入页：记忆 / 情绪 / 选项 三个顶部页签
const injectState = { tab: 'memory' };

function setInjectTab(tab) {
  injectState.tab = tab === 'emotion' || tab === 'options' ? tab : 'memory';
  $$('.inject-tab').forEach((b) => b.classList.toggle('active', b.dataset.injectTab === injectState.tab));
  $$('.inject-panel').forEach((p) => {
    p.hidden = p.dataset.injectPanel !== injectState.tab;
  });
  if (injectState.tab === 'memory') {
    renderMemoryDb();
  } else if (injectState.tab === 'emotion') {
    if (!emotionRuntime.state && !emotionRuntime.loading) void loadEmotionState({ force: true });
    renderEmotionStatus();
  } else {
    if (!emotionRuntime.state && !emotionRuntime.loading) void loadEmotionState({ force: true });
    renderMemoryParams();
    renderEmotionParams();
  }
  const content = $('.settings-content');
  if (content) content.scrollTop = 0;
}

function initInjectionTabs() {
  // 记忆参数原本在记忆页里，挪到「选项」页（DOM 只此一份，避免滑块重复绑定）
  const memParams = $('#mem-params');
  const memSlot = $('#inject-mem-options');
  if (memParams && memSlot) memSlot.appendChild(memParams);
  $$('.inject-tab').forEach((b) => {
    b.addEventListener('click', () => setInjectTab(b.dataset.injectTab));
  });
}
initInjectionTabs();

function emotionPanelVisible() {
  return !!document.querySelector('.settings-page.active[data-page="injection"]');
}

function emotionFocusBlocked(root) {
  const a = document.activeElement;
  return !!a && root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
}

// 取快照；不可用时把占位提示写进目标容器
function emotionPanelData(target) {
  if (!emotionActive()) {
    const why = '情感引擎未加载：app/emotion/engine.js 没有执行';
    if (target) target.innerHTML = `<div class="emotion-empty">${escapeHtml(emotionRuntime.lastError || why)}</div>`;
    return null;
  }
  const snap = emotionSnapshot();
  if (!snap.state) {
    if (target) target.innerHTML = `<div class="emotion-empty">${escapeHtml(snap.error || snap.note || '情感档案尚未加载')}</div>`;
    return null;
  }
  return snap;
}

function renderEmotionPanel() {
  const toggle = $('#set-emotion-enabled');
  if (toggle) toggle.checked = !!settings.emotionEnabled;
  if (!emotionPanelVisible()) return;
  if (injectState.tab === 'emotion') renderEmotionStatus();
  else if (injectState.tab === 'options') renderEmotionParams();
}

// 情绪页：只读状态，不放参数
function renderEmotionStatus() {
  const root = $('#emotion-root');
  if (!root || emotionFocusBlocked(root)) return;
  const snap = emotionPanelData(root);
  if (!snap) return;

  const emo = snap.emotion;
  const ph = snap.placeholders;
  const days = ph.daysTogether;
  const simple = SHOW_EMOTION_VIEW_TOGGLE ? settings.emotionSimpleView !== false : true;
  // 此刻两条：愉悦 / 唤醒（掌控已随死值一起删掉）
  const moodMeters = [
    ['valence', '愉悦', emo.valence],
    ['arousal', '唤醒', emo.arousal],
  ]
    .filter(([key]) => !EMOTION_HIDDEN_METERS.has(key))
    .map(([, label, value]) => emotionMeter(label, value, 100))
    .join('');

  // 雷达只读：数值由她自己的表达慢慢统计出来，不参与公式，也不能手改
  const traits = E.deriveTraits(snap.state.stats, snap.state.personality, settings.traitSpan);
  // 「对比」：白线与差值都取上一轮结算前的六维，只活在本进程内存里
  const prevTraits = emotionRuntime.radarCompare && emotionRuntime.radarPrev ? emotionRuntime.radarPrev : null;
  const prevValues = prevTraits ? E.PERSONALITY_KEYS.map((key) => Number(prevTraits[key]) || 0) : null;
  const personalityItems = E.PERSONALITY_KEYS.map((key) => {
    const value = Number(traits[key]) || 0;
    const before = prevTraits ? Number(prevTraits[key]) : NaN;
    // 换算成 0~100 的百分点差值：本轮微调常常不到 1 分，所以保留一位小数
    return {
      key,
      name: EMOTION_PERSONALITY_NAMES[key] || key,
      value,
      delta: Number.isFinite(before) ? (value - before) * 100 : null,
    };
  });
  const radarHint = !emotionRuntime.radarCompare
    ? '按她自述的心情慢慢统计，不能手改'
    : (prevValues ? '白线是上一轮结算前的样子，轴名下方是本轮变化' : '聊一轮后，白线会出现在这里');

  root.innerHTML = `
    ${SHOW_EMOTION_VIEW_TOGGLE ? `
    <div class="emotion-view-toggle">
      <button type="button" data-em-view="simple" class="${simple ? 'is-active' : ''}">简易</button>
      <button type="button" data-em-view="full" class="${simple ? '' : 'is-active'}">全量</button>
    </div>` : ''}
    <div class="emotion-grid">
      <div class="emotion-col">
        <section class="emotion-card emotion-card--tight">
          <div class="emotion-card-head"><b>现在</b></div>
          <div class="emotion-clock">${escapeHtml(`${ph.clock} ${ph.weekday} ${ph.phase}`)}</div>
          ${days == null ? '' : `<div class="emotion-sub">在一起 ${days} 天</div>`}
          ${snap.note ? `<div class="emotion-sub">${escapeHtml(snap.note)}</div>` : ''}
          ${snap.repaired ? `<div class="emotion-sub">已用默认值修复 ${snap.repaired} 项</div>` : ''}
          <div class="emotion-divider"></div>
          ${emotionMeter('今日还能主动', snap.quota.left, snap.quota.cap, `${snap.quota.left} / ${snap.quota.cap}`)}
        </section>

        <section class="emotion-card">
          <div class="emotion-card-head"><b>此刻</b></div>
          <div class="emotion-tags">
            <span class="emotion-tag">心里 ${escapeHtml(emo.inner)}</span>
            <span class="emotion-tag">嘴上 ${escapeHtml(emo.outer)}</span>
            <span class="emotion-tag">强度 ${Math.round((Number(emo.intensity) || 0) * 100)}%</span>
          </div>
          ${moodMeters}
        </section>

        <section class="emotion-card">
          <div class="emotion-card-head">
            <b>情绪分析</b>
            <button type="button" class="emotion-pill${emotionRuntime.radarCompare ? ' is-active' : ''}" data-em-action="radar-compare" title="白线画上一轮结算前的雷达">对比</button>
          </div>
          ${emotionRadar(personalityItems, prevValues)}
          <div class="emotion-hint">${radarHint}</div>
        </section>
      </div>

      <div class="emotion-col">
        <section class="emotion-card">
          <div class="emotion-card-head"><b>状态</b></div>
          ${Object.keys(EMOTION_HORMONE_NAMES).filter((key) => !EMOTION_HIDDEN_METERS.has(key)).map((key) => emotionMeter(EMOTION_HORMONE_NAMES[key], snap.state.hormones[key], 100)).join('')}
        </section>

        <section class="emotion-card">
          <div class="emotion-card-head"><b>关系 · 你和我</b></div>
          ${Object.keys(EMOTION_RELATION_NAMES).map((key) => emotionMeter(EMOTION_RELATION_NAMES[key], snap.state.relation[key], 100)).join('')}
        </section>

        <section class="emotion-card emotion-card--tight">
          <div class="emotion-card-head"><b>实时状态</b></div>
          <ul class="emotion-influences">${snap.influences.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
          ${emotionContextLines().map((line) => `<div class="emotion-hint">${escapeHtml(line)}</div>`).join('')}
        </div>
        </section>

        <section class="emotion-card emotion-card--tight">
          <div class="emotion-card-head"><b>本轮心情</b></div>
          ${emotionMoodTrace()}
        </section>
      </div>
    </div>

    <div class="emotion-actions">
      <span class="emotion-hint">${snap.error ? escapeHtml(snap.error) : '主动消息、额度与频率等参数在「选项」页调节'}</span>
    </div>
  `;
}

// ---------------------------------------------------------------- 生物钟卡片

// 0~23.999 的钟点写成 06:00
function fmtClock(hour) {
  const total = ((Math.round(Number(hour) * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// 24 小时条上的夜间高亮：入睡可能晚于起床，会跨午夜
function rhythmTrackBg(r) {
  const a = (r.sleep / 24) * 100;
  const b = (r.wake / 24) * 100;
  const idle = 'rgba(255, 255, 255, 0.07)';
  const deep = 'rgba(108, 192, 166, 0.45)';
  if (a < b) {
    return `linear-gradient(to right, ${idle} 0 ${a}%, ${deep} ${a}% ${b}%, ${idle} ${b}% 100%)`;
  }
  return `linear-gradient(to right, ${deep} 0 ${b}%, ${idle} ${b}% ${a}%, ${deep} ${a}% 100%)`;
}

// 分段条：五个清醒段 + 深夜；深夜跨午夜时拆成两截
function rhythmStripHtml(r) {
  return E.rhythmSegments(r)
    .map((seg) => {
      const cls = 'rhythm-seg' + (seg.sleep ? ' is-night' : '');
      const left = (seg.start / 24) * 100;
      const width = (seg.hours / 24) * 100;
      const tip = ` title="${seg.name} ${fmtClock(seg.start)}–${fmtClock(seg.end)}"`;
      if (seg.start + seg.hours <= 24) {
        return `<span class="${cls}" style="left:${left}%;width:${width}%"${tip}>${seg.name}</span>`;
      }
      const head = ((24 - seg.start) / 24) * 100;
      const tail = ((seg.start + seg.hours - 24) / 24) * 100;
      return `<span class="${cls}" style="left:${left}%;width:${head}%"${tip}>${seg.name}</span>`
        + `<span class="${cls}" style="left:0;width:${tail}%"${tip}>${seg.name}</span>`;
    })
    .join('');
}

// 真实钟点换算成 0~24 的小数，生物钟条上的「现在」指针用它定位
function nowHourOfDay(d = new Date()) {
  return d.getHours() + d.getMinutes() / 60;
}

// 当前困倦值：情感系统没跑时返回 null，只显示时间
function currentSleepiness() {
  const hormones = emotionRuntime.state && emotionRuntime.state.hormones;
  const v = hormones ? Number(hormones.melatonin) : NaN;
  return Number.isFinite(v) ? Math.round(v) : null;
}

function rhythmSummaryHtml(r) {
  const spans = E.rhythmSegments(r)
    .map((seg) => `${seg.name} ${fmtClock(seg.start)}–${fmtClock(seg.end)}`)
    .join(' · ');
  const now = nowHourOfDay();
  const sleepiness = currentSleepiness();
  return `
    <div class="rhythm-readout rhythm-readout--now">现在 ${fmtClock(now)}${sleepiness == null ? '' : ` · 困倦 ${sleepiness}`}</div>
    <div class="rhythm-readout">起床 ${fmtClock(r.wake)} · 入睡 ${fmtClock(r.sleep)} · 清醒 ${r.wakeLen} 小时 / 睡眠 ${r.sleepLen} 小时</div>
    <div class="rhythm-readout rhythm-readout--sub">${spans}</div>
  `;
}

function rhythmCardHtml() {
  const r = E.normalizeRhythm(emotionRhythm());
  const nowHour = nowHourOfDay();
  const thumb = (key, hour, label) =>
    `<div class="rhythm-thumb" data-rhythm-thumb="${key}" role="slider" tabindex="0"`
    + ` aria-label="${label}" aria-valuemin="0" aria-valuemax="23" aria-valuenow="${hour}"`
    + ` style="left:${(hour / 24) * 100}%"></div>`;
  return `
    <section class="emotion-card emotion-rhythm-card">
      <div class="emotion-card-head"><b>生物钟</b></div>
      <div class="rhythm-range" data-rhythm-range>
        <div class="rhythm-track" style="background:${rhythmTrackBg(r)}"></div>
        <span class="rhythm-now" style="left:${(nowHour / 24) * 100}%" title="现在 ${fmtClock(nowHour)}"></span>
        ${thumb('wakeHour', r.wake, '起床时间')}
        ${thumb('sleepHour', r.sleep, '入睡时间')}
      </div>
      <div class="rhythm-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
      <div class="rhythm-strip" data-rhythm-strip>${rhythmStripHtml(r)}</div>
      <div data-rhythm-readout>${rhythmSummaryHtml(r)}</div>
      <label class="emotion-field"><span>对话注入当前状态</span><input type="checkbox" data-em-setting="injectEmotionState"${settings.injectEmotionState !== false ? ' checked' : ''} /></label>
    </section>
  `;
}

// 拖滑块时只刷预览，不重绘整块（否则正在拖的滑块会被换掉）
function updateRhythmPreview(root, key, raw) {
  // 注意：normalizeRhythm 读的是 wake / sleep，不是 wakeHour / sleepHour
  const next = { wake: settings.wakeHour, sleep: settings.sleepHour };
  if (key === 'wakeHour') next.wake = Number(raw);
  else next.sleep = Number(raw);
  const r = E.normalizeRhythm(next);
  settings.wakeHour = r.wake;
  settings.sleepHour = r.sleep;
  // 清醒时长被夹住时会反过来改另一个端点，圆点位置要同步
  root.querySelectorAll('[data-rhythm-thumb]').forEach((el) => {
    const hour = settings[el.dataset.rhythmThumb];
    el.style.left = `${(hour / 24) * 100}%`;
    el.setAttribute('aria-valuenow', String(hour));
  });
  const track = root.querySelector('.rhythm-track');
  if (track) track.style.background = rhythmTrackBg(r);
  const strip = root.querySelector('[data-rhythm-strip]');
  if (strip) strip.innerHTML = rhythmStripHtml(r);
  const readout = root.querySelector('[data-rhythm-readout]');
  if (readout) readout.innerHTML = rhythmSummaryHtml(r);
}

// 圆点是自己画的 div，拖动交给 document：不依赖原生 range，也不怕指针移出卡片
const rhythmDrag = { key: '', root: null, el: null };

function rhythmHourAt(el, clientX) {
  const rect = el.getBoundingClientRect();
  const ratio = rect.width ? (clientX - rect.left) / rect.width : 0;
  return Math.max(0, Math.min(23, Math.round(ratio * 24)));
}

// 点哪儿就拖离得近的那个端点
function rhythmNearestKey(hour) {
  const gap = (a, b) => {
    const d = Math.abs(a - b) % 24;
    return Math.min(d, 24 - d);
  };
  return gap(hour, settings.sleepHour) < gap(hour, settings.wakeHour) ? 'sleepHour' : 'wakeHour';
}

// 作息改完：困意 / 褪黑素立刻按新钟点的应有水平重算，再让设置页重绘
function commitRhythm() {
  if (E && emotionRuntime.state) {
    E.rebaseRhythm(emotionRuntime.state, new Date(), emotionRhythm());
    saveEmotionState(false);
  }
  void applyEmotionSettings();
}

function endRhythmDrag() {
  const el = rhythmDrag.el;
  if (!el) return;
  el.classList.remove('is-dragging');
  rhythmDrag.el = null;
  rhythmDrag.root = null;
  rhythmDrag.key = '';
  commitRhythm();
}

// 拖动全部挂在 document 上：即使面板被重绘过也不会丢监听
document.addEventListener('mousedown', (e) => {
  const range = e.target && e.target.closest ? e.target.closest('[data-rhythm-range]') : null;
  if (!range) return;
  const root = range.closest('.emotion-rhythm-card');
  if (!root) return;
  e.preventDefault();
  const hour = rhythmHourAt(range, e.clientX);
  const thumb = e.target.closest('[data-rhythm-thumb]');
  rhythmDrag.root = root;
  rhythmDrag.el = range;
  rhythmDrag.key = thumb ? thumb.dataset.rhythmThumb : rhythmNearestKey(hour);
  range.classList.add('is-dragging');
  updateRhythmPreview(root, rhythmDrag.key, hour);
});

// 键盘：左右箭头微调选中的圆点
document.addEventListener('keydown', (e) => {
  const thumb = e.target && e.target.closest ? e.target.closest('[data-rhythm-thumb]') : null;
  if (!thumb) return;
  const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (!delta) return;
  const root = thumb.closest('.emotion-rhythm-card');
  if (!root) return;
  e.preventDefault();
  const key = thumb.dataset.rhythmThumb;
  updateRhythmPreview(root, key, settings[key] + delta);
  if (E && emotionRuntime.state) {
    E.rebaseRhythm(emotionRuntime.state, new Date(), emotionRhythm());
    saveEmotionState(false);
  }
  store.set('agentpet.settings', settings);
});

document.addEventListener('mousemove', (e) => {
  if (!rhythmDrag.el) return;
  updateRhythmPreview(rhythmDrag.root, rhythmDrag.key, rhythmHourAt(rhythmDrag.el, e.clientX));
});
document.addEventListener('mouseup', () => {
  if (rhythmDrag.el) endRhythmDrag();
});

// 选项页：主动消息的额度摘要 + 全部参数
// 状态标签映射表默认折叠；展开状态放内存，面板重绘后保持
let emotionTiersOpen = false;

// 映射表卡片：困意 ≥ 阈值就用对应文案，从上到下一档一条
function stateTiersCardHtml() {
  const tiers = Array.isArray(settings.stateTiers) && settings.stateTiers.length
    ? settings.stateTiers
    : E.STATE_TIERS;
  const nowTag = emotionRuntime.state
    ? E.stateTag(emotionRuntime.state, new Date(), emotionRhythm(), tiers)
    : '—';
  const rows = tiers
    .map((t, i) => `
      <div class="emotion-tier-row">
        <input type="number" min="0" max="100" step="1" value="${escapeHtml(String(t.min))}" data-tier-min="${i}" />
        <input type="text" maxlength="8" value="${escapeHtml(t.label)}" data-tier-label="${i}" />
        <button class="btn-ghost-sm" data-em-action="tier-del" data-tier-index="${i}" type="button">删除</button>
      </div>`)
    .join('');
  return `
    <section class="emotion-card emotion-param-card">
      <div class="emotion-card-head"><b>状态标签</b><span class="emotion-hint">当前：<span data-tier-now>${escapeHtml(nowTag)}</span></span></div>
      <details class="emotion-tiers" data-tier-fold${emotionTiersOpen ? ' open' : ''}>
        <summary>按困意分档 · ${tiers.length} 档</summary>
        <div class="emotion-tier-head"><span>困意 ≥</span><span>文案</span><span></span></div>
        ${rows}
        <button class="btn-ghost-sm" data-em-action="tier-add" type="button">添加一档</button>
      </details>
      <div class="emotion-hint">每轮注入的状态词取自这张表：困意达到阈值就用该档文案，低于最低档也归最低档；文案留空或整表为空时用默认四档。起床 40 分钟内固定显示「刚睡醒」。</div>
    </section>
  `;
}

function renderEmotionParams() {
  const root = $('#emotion-params');
  if (!root || rhythmDrag.el || emotionFocusBlocked(root)) return;
  const snap = emotionPanelData(root);
  if (!snap) return;

  const quota = snap.quota;
  const roll = snap.lastRoll;
  let rollText = '等待下一次抽签';
  if (roll) {
    rollText = roll.blocked
      ? `本次未触发：${EMOTION_BLOCKED_TEXT[roll.blocked] || roll.blocked}`
      : `本次 p=${((Number(roll.p) || 0) * 100).toFixed(1)}%，${roll.fired ? '已开口' : '未中'}`;
  }
  const cooldownLeft = roll && roll.cooldownLeft ? Math.ceil(roll.cooldownLeft) : 0;
  const quietLeft = roll && roll.quietLeft ? Math.ceil(roll.quietLeft) : 0;

  // 雷达平滑：先验强度，1 最敏感、100 最稳；每轮最多推动 100/(span+n) 分
  const span = Math.max(1, Math.min(100, Number(settings.traitSpan) || 20));
  const replies = Number(snap.state.stats && snap.state.stats.replies) || 0;
  const perRound = (100 / (span + replies)).toFixed(1);
  const adaptRate = traitAdaptRate();

  // 权重直接乘在每次抽签的概率上，折算成期望间隔 = 基线 / 权重，改了要立刻能看出来
  const weight = Math.max(0, Number(settings.proactiveWeight) || 0);
  const expectText = weight <= 0
    ? '关闭（权重为 0）'
    : `约 ${Math.max(1, Math.round((Number(snap.gapMin) || 0) / weight))} 分钟`;
  const capOptions = ['auto', 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20]
    .map((v) => {
      const sel = String(settings.proactiveCap) === String(v) ? ' selected' : '';
      return `<option value="${v}"${sel}>${v === 'auto' ? '自动（按心情 1/3/5 × 倍率）' : `${v} 条`}</option>`;
    })
    .join('');

  root.innerHTML = `
    <section class="emotion-card emotion-param-card">
      <div class="emotion-card-head"><b>主动找你 · 今日额度</b></div>
      ${settings.emotionEnabled ? '' : '<div class="emotion-sub">自动唤醒已关闭，下面的额度不会触发；状态统计与面板照常。</div>'}
      <div class="emotion-kv"><span>还能发</span><b>${quota.left} / ${quota.cap}</b></div>
      <div class="emotion-sub">${escapeHtml(quota.why || '')}</div>
      <div class="emotion-kv"><span>期望间隔</span><b>${expectText}</b></div>
      <div class="emotion-sub">基线 ${snap.gapMin} 分钟 × 权重 ${weight}（不含冷却与每日上限）</div>
      <div class="emotion-kv"><span>本次抽签</span><b>${escapeHtml(rollText)}</b></div>
      ${cooldownLeft ? `<div class="emotion-kv"><span>冷却剩余</span><b>${cooldownLeft} 分钟</b></div>` : ''}
      ${quietLeft ? `<div class="emotion-kv"><span>安静期剩余</span><b>${quietLeft} 分钟</b></div>` : ''}
      <div class="emotion-kv"><span>夜间静默</span><b>${snap.night ? '是' : '否'}（入睡 ${escapeHtml(fmtClock(settings.sleepHour))} – 起床 ${escapeHtml(fmtClock(settings.wakeHour))}）</b></div>
      <div class="emotion-divider"></div>
      <div class="emotion-form">
        ${emotionNumberField('proactiveCheckSeconds', '抽签间隔', settings.proactiveCheckSeconds, 15, 600, 1, '秒')}
        ${emotionNumberField('proactiveWeight', '概率权重', settings.proactiveWeight, 0, 100, 0.1, '倍')}
        ${emotionNumberField('proactiveCooldownMin', '开口冷却', settings.proactiveCooldownMin, 0, 1440, 1, '分钟')}
        <label class="emotion-field"><span>每日上限</span><select data-em-setting="proactiveCap">${capOptions}</select></label>
        ${emotionNumberField('proactiveCapMultiplier', '上限倍率', settings.proactiveCapMultiplier, 0.1, 3, 0.1, '倍')}
        ${emotionNumberField('proactiveQuietMin', '安静期', settings.proactiveQuietMin, 0, 120, 1, '分钟')}
        ${emotionNumberField('proactiveIgnoreHours', '无视判定', settings.proactiveIgnoreHours, 1, 72, 1, '小时')}
        <label class="emotion-field"><span>超时保底</span><input type="checkbox" data-em-setting="proactiveFloor"${settings.proactiveFloor ? ' checked' : ''} /></label>
      </div>
    </section>

    ${rhythmCardHtml()}

    <section class="emotion-card emotion-param-card">
      <div class="emotion-card-head"><b>MOOD 兜底</b></div>
      <label class="emotion-field emotion-field--row">
        <span>没写 MOOD 时按她的回复归类</span>
        <input type="checkbox" data-em-setting="moodFallback"${settings.moodFallback !== false ? ' checked' : ''} />
      </label>
      <div class="emotion-hint">模型漏写心情标记时，用关键词 + 向量对她这条回复做一次归类，按半强度结算；关掉就完全不结算。</div>
    </section>

    <section class="emotion-card emotion-param-card">
      <div class="emotion-card-head"><b>雷达平滑</b></div>
      <div class="emotion-kv"><span>先验强度</span><b><span data-trait-span-value>${span}</span> 条</b></div>
      <input class="emotion-range" type="range" min="1" max="100" step="1" value="${span}" data-em-setting="traitSpan" />
      <div class="rhythm-axis"><span>1 · 敏感</span><span>50</span><span>100 · 稳定</span></div>
      <div class="emotion-sub" data-trait-span-push>每轮最多推动 ${perRound} 分 · 性格步长 ${(adaptRate * 100).toFixed(2)}%（已累计 ${replies} 条回复）</div>
      <label class="emotion-field emotion-field--row">
        <span>性格自适应</span>
        <input type="checkbox" data-em-setting="traitAdapt"${settings.traitAdapt ? ' checked' : ''} />
      </label>
      <div class="emotion-hint">越靠左，雷达更快跟上、性格改写得也更快；只影响展示与自适应，不参与主动开口判定。</div>
    </section>

    ${stateTiersCardHtml()}

    <div class="emotion-actions">
      <button class="btn-ghost-sm" data-em-action="reset">重置状态</button>
      <button class="btn-ghost-sm" data-em-action="rebuild">重建心情原型向量</button>
      <button class="btn-ghost-sm" data-em-action="rhythm-reset">重置生物钟</button>
      <span class="emotion-hint">${snap.error ? escapeHtml(snap.error) : '状态按角色隔离，改完参数即时生效'}</span>
    </div>
  `;
}

// 面板改参数：先归一化写回 settings，再让定时器按新参数重排
function applyEmotionSettingValue(key, raw) {
  if (key === 'proactiveCap') {
    settings.proactiveCap = raw === 'auto' ? 'auto' : Math.max(1, Math.min(20, Math.round(Number(raw) || 1)));
    return;
  }
  if (key === 'proactiveFloor') {
    settings.proactiveFloor = !!raw;
    return;
  }
  if (key === 'injectEmotionState') {
    settings.injectEmotionState = !!raw;
    return;
  }
  if (key === 'traitAdapt') {
    settings.traitAdapt = !!raw;
    return;
  }
  if (key === 'moodFallback') {
    settings.moodFallback = !!raw;
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  if (key === 'proactiveCheckSeconds') settings[key] = Math.max(15, Math.min(600, Math.round(n)));
  else if (key === 'proactiveWeight') settings[key] = Math.max(0, Math.min(100, n));
  else if (key === 'proactiveCapMultiplier') settings[key] = Math.round(Math.max(0.1, Math.min(3, n)) * 10) / 10;
  else if (key === 'proactiveCooldownMin') settings[key] = Math.max(0, Math.min(1440, Math.round(n)));
  else if (key === 'proactiveQuietMin') settings[key] = Math.max(0, Math.min(120, Math.round(n)));
  else if (key === 'proactiveIgnoreHours') settings[key] = Math.max(1, Math.min(72, Math.round(n)));
  else if (key === 'traitSpan') {
    const span = Math.max(1, Math.min(100, Math.round(n)));
    // 先验强度变了，旧快照是按旧强度算的，直接作废避免出现假的差值
    if (span !== settings.traitSpan) emotionRuntime.radarPrev = null;
    settings.traitSpan = span;
  }
}

function initEmotionPanel() {
  const toggle = $('#set-emotion-enabled');
  if (toggle) {
    toggle.addEventListener('change', () => {
      settings.emotionEnabled = !!toggle.checked;
      void applyEmotionSettings();
    });
  }
  const save = $('#btn-emotion-save');
  if (save) save.addEventListener('click', () => void applyEmotionSettings());

  // 情绪化上下文：总开关 + 情绪一致性；关掉总开关时下面一行置灰
  const ctxToggle = $('#set-emotion-context');
  const ctxPick = $('#set-emotion-context-pick');
  const syncContextUi = () => {
    if (ctxToggle) ctxToggle.checked = settings.emotionContext === true;
    if (ctxPick) {
      ctxPick.checked = settings.emotionContextPick !== false;
      ctxPick.disabled = settings.emotionContext !== true;
      const row = ctxPick.closest ? ctxPick.closest('.setting-row') : null;
      if (row) row.classList.toggle('is-disabled', settings.emotionContext !== true);
    }
  };
  if (ctxToggle) {
    ctxToggle.addEventListener('change', () => {
      settings.emotionContext = !!ctxToggle.checked;
      store.set('agentpet.settings', settings);
      syncContextUi();
    });
  }
  if (ctxPick) {
    ctxPick.addEventListener('change', () => {
      settings.emotionContextPick = !!ctxPick.checked;
      store.set('agentpet.settings', settings);
      syncContextUi();
    });
  }
  syncContextUi();

  // 事件委托：面板每次重绘都会换 DOM，不能逐个绑定
  bindEmotionEvents($('#emotion-root'));
  bindEmotionEvents($('#emotion-params'));
}

// 面板「实时状态」里那几句：当前实际会发多少轮、多少由情绪挑、优先回忆哪些标签
function emotionContextLines() {
  const cap = Number(settings.historyWindow) >= 100 ? 'MAX' : `${settings.historyWindow}`;
  if (settings.emotionContext !== true) {
    return [`当前上下文窗口 ${cap}（情绪化上下文未开启）`];
  }
  const plan = currentEmotionContextPlan();
  const pct = Math.round((plan.weight || 0) * 100);
  if (plan.available < MIN_CONTEXT_TURNS) {
    return [`当前共 ${plan.available} 轮对话（上限 ${cap}，不足 ${MIN_CONTEXT_TURNS} 轮，暂按连续窗口发送）`];
  }
  if (settings.emotionContextPick === false) {
    return [`当前共 ${plan.available} 轮对话（上限 ${cap}），本次注入 ${plan.total} 轮（情绪权重 ${pct}%），全部连续`];
  }
  if (plan.available <= plan.total) {
    return [`当前共 ${plan.available} 轮对话（上限 ${cap}），本次注入 ${plan.total} 轮（情绪权重 ${pct}%），全部为最近连续对话`];
  }
  const lines = [`当前共 ${plan.available} 轮对话（上限 ${cap}），本次注入 ${plan.total} 轮（情绪权重 ${pct}%），其中 ${plan.fill} 轮由情绪决定（候选 ${plan.candidates} 轮）`];
  lines.push(plan.labels.length
    ? `优先回忆：${plan.labels.join(' · ')}`
    : '优先回忆：暂无（旧对话还没有情绪标签）');
  return lines;
}

function bindEmotionEvents(root) {
  if (!root) return;
  // 滑块拖动过程中只更新读数，松手才由 change 落盘
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset || t.dataset.emSetting !== 'traitSpan') return;
    const v = Math.max(1, Math.min(100, Math.round(Number(t.value) || 20)));
    const host = t.closest ? t.closest('.emotion-param-card') : null;
    const out = host ? host.querySelector('[data-trait-span-value]') : null;
    if (out) out.textContent = String(v);
    const push = host ? host.querySelector('[data-trait-span-push]') : null;
    if (push) {
      const n = Number(emotionRuntime.state && emotionRuntime.state.stats ? emotionRuntime.state.stats.replies : 0) || 0;
      const rate = Math.max(0.002, Math.min(0.02, 0.1 / v));
      push.textContent = `每轮最多推动 ${(100 / (v + n)).toFixed(1)} 分 · 性格步长 ${(rate * 100).toFixed(2)}%（已累计 ${n} 条回复）`;
    }
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    // 状态标签映射表：就地改 settings 后直接落盘，不重绘面板（否则输入框会被换掉）
    if (t.dataset.tierMin !== undefined || t.dataset.tierLabel !== undefined) {
      const tiers = Array.isArray(settings.stateTiers) ? settings.stateTiers.slice() : [];
      const isMin = t.dataset.tierMin !== undefined;
      const i = Number(isMin ? t.dataset.tierMin : t.dataset.tierLabel);
      if (!Number.isInteger(i) || !tiers[i]) return;
      if (isMin) {
        const n = Math.max(0, Math.min(100, Math.round(Number(t.value) || 0)));
        tiers[i] = { ...tiers[i], min: n };
        t.value = String(n);
      } else {
        tiers[i] = { ...tiers[i], label: String(t.value).trim().slice(0, 8) };
        t.value = tiers[i].label;
      }
      settings.stateTiers = tiers;
      store.set('agentpet.settings', settings);
      // 标题旁的「当前」跟着变，免得改完文案看不到效果
      const out = root.querySelector('[data-tier-now]');
      if (out) {
        out.textContent = emotionRuntime.state
          ? E.stateTag(emotionRuntime.state, new Date(), emotionRhythm(), tiers)
          : '—';
      }
      return;
    }
    const key = t.dataset.emSetting;
    if (!key) return;
    applyEmotionSettingValue(key, t.type === 'checkbox' ? t.checked : t.value);
    if (t.blur) t.blur();
    void applyEmotionSettings();
  });
  // details 的展开事件不冒泡，用捕获阶段记住状态
  root.addEventListener('toggle', (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.tierFold !== undefined) emotionTiersOpen = !!t.open;
  }, true);
  root.addEventListener('click', (e) => {
    const view = e.target && e.target.closest ? e.target.closest('[data-em-view]') : null;
    if (view) {
      settings.emotionSimpleView = view.dataset.emView !== 'full';
      store.set('agentpet.settings', settings);
      renderEmotionPanel();
      return;
    }
    const t = e.target && e.target.closest ? e.target.closest('[data-em-action]') : null;
    if (!t) return;
    const action = t.dataset.emAction;
    if (action === 'reset') void resetEmotionState();
    else if (action === 'tier-add') {
      const tiers = Array.isArray(settings.stateTiers) ? settings.stateTiers.slice() : [];
      tiers.push({ min: 50, label: '' });
      settings.stateTiers = tiers;
      store.set('agentpet.settings', settings);
      emotionTiersOpen = true;
      renderEmotionPanel();
    }
    else if (action === 'tier-del') {
      const tiers = Array.isArray(settings.stateTiers) ? settings.stateTiers.slice() : [];
      const i = Number(t.dataset.tierIndex);
      // 至少留一档，全删了就没有词可注入
      if (tiers.length > 1 && Number.isInteger(i)) tiers.splice(i, 1);
      settings.stateTiers = tiers;
      store.set('agentpet.settings', settings);
      emotionTiersOpen = true;
      renderEmotionPanel();
    }
    else if (action === 'rhythm-reset') {
      settings.wakeHour = 6;
      settings.sleepHour = 22;
      commitRhythm();
    }
    else if (action === 'rebuild') void rebuildEmotionVectors();
    else if (action === 'radar-compare') {
      // 纯前端开关：白线与差值都只用内存里的上一轮快照，不落盘
      emotionRuntime.radarCompare = !emotionRuntime.radarCompare;
      renderEmotionPanel();
    }
  });
}
initEmotionPanel();

// 自动压缩（在发送新消息之前跑）：未压缩上下文占窗口超过阈值就先压缩一次，
// 这样新消息不会被压进摘要里。手动入口仍在输入框「+ → 压缩上下文」。
let autoCompressRunning = false;
async function maybeAutoCompress() {
  if (!settings.autoCompress || autoCompressRunning || chatBusy) return false;
  const cfg = getApiConfig();
  if (!cfg.key || cfg.builtin || cfg.id === 'mock') return false; // mock 不消耗 token，不必压缩
  const max = Math.max(1000, Number(cfg.contextWindow) || 128000);
  // 两个口径取大：① 本轮实际请求；② 全部未压缩对话（MAX 模式会发的量）。
  // 只看 ① 的话，historyWindow 较小永远压不到；只看 ② 又会在实际请求很小时白花一次调用。
  const msgs = buildChatMessages();
  const systemTokens = estimateTokens(msgs[0] ? msgs[0].content : '');
  const requestTokens = estimateMessagesTokens(msgs);
  const fullTokens = systemTokens + estimateMessagesTokens(buildApiHistory(100));
  const used = Math.max(requestTokens, fullTokens);
  const ratio = used / max;
  if (ratio < settings.autoCompressAt) return false;

  autoCompressRunning = true;
  setTopStatus('自动压缩上下文…');
  setCompressBusy(true); // 压缩期间发送键灰掉不可点，避免两个请求同时跑
  try {
    consoleLog(
      '系统',
      `上下文 ${Math.round(ratio * 100)}% ≥ 触发线 ${Math.round(settings.autoCompressAt * 100)}%，先自动压缩…`
    );
    return await compressContext({ auto: true });
  } catch (err) {
    consoleLog('警告', `自动压缩失败：${err && err.message ? err.message : err}`);
    return false;
  } finally {
    autoCompressRunning = false;
    setTopStatus('待机');
    setCompressBusy(false);
  }
}

// 时间显示判断：只有「请求」（用户气泡）旁边标时间；同一分钟里连发的几条只留一次，
// 免得密集对话里时间一行一行地重复。每次重绘都新建一个闸门，保证历史渲染结果稳定。
function timeGate() {
  let last = '';
  return (entry) => {
    const at = entry && entry.at ? String(entry.at) : '';
    if (!at || at === last) return '';
    last = at;
    return at;
  };
}

// 系统信息（插件注入 / 待机唤醒）：在对话里收成一张折叠小卡片，
// 默认只露标题和时间，点开才看到「这条通知触发了本轮回复」和原文。
const SYS_NOTICE_ICON =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><polyline points="12 7.5 12 12 15 14"/></svg>';

function fmtNoticeTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildSystemNotice(m) {
  const box = document.createElement('div');
  box.className = 'sys-notice' + (m.noticeOpen ? ' open' : '');

  const head = document.createElement('div');
  head.className = 'sys-notice-head';
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  const icon = document.createElement('span');
  icon.className = 'sys-notice-icon';
  icon.innerHTML = SYS_NOTICE_ICON;
  const title = document.createElement('span');
  title.className = 'sys-notice-title';
  title.textContent = '系统信息';
  const time = document.createElement('span');
  time.className = 'sys-notice-time';
  time.textContent = fmtNoticeTime(m.ts);
  const chevron = document.createElement('span');
  chevron.className = 'sys-notice-chevron';
  chevron.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="8 10 12 14 16 10"/></svg>';
  head.append(icon, title, time, chevron);

  const body = document.createElement('div');
  body.className = 'sys-notice-body';
  const lead = document.createElement('div');
  lead.className = 'sys-notice-lead';
  lead.textContent = '这条通知触发了本轮回复。';
  const text = document.createElement('div');
  text.className = 'sys-notice-text';
  text.textContent = shortImagePaths(String(m.text || '').replace(/^\[系统信息\]\s*/, ''));
  body.append(lead, text);

  const toggle = () => {
    m.noticeOpen = !m.noticeOpen;
    box.classList.toggle('open', !!m.noticeOpen);
  };
  head.onclick = toggle;
  head.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  box.append(head, body);
  return box;
}

// 对话气泡里图片只显示文件名：完整路径仍保存在 m.text（发给模型时换成别名），
// 代码块里的路径不动，避免把用户贴的示例代码显示坏了
const CHAT_FENCE_RE = /```[\s\S]*?(?:```|$)/g;
function shortImagePaths(text) {
  const src = String(text || '');
  if (!src || src.indexOf('.') < 0) return src;
  const shorten = (chunk) => chunk.replace(IMAGE_PATH_REGEX, (whole) => baseName(whole));
  let out = '';
  let last = 0;
  for (const hit of src.matchAll(CHAT_FENCE_RE)) {
    if (hit.index > last) out += shorten(src.slice(last, hit.index));
    out += hit[0];
    last = hit.index + hit[0].length;
  }
  if (last < src.length) out += shorten(src.slice(last));
  return out;
}

function renderChat() {
  el.chatHistory.innerHTML = '';
  const gateTime = timeGate();
  if (!chatState.messages.length && !chatState.cleared && !IS_PANEL) {
    chatState.messages.push({
      role: 'ai',
      think: '我已经在这台电脑的屏幕边了。先安静地待机，等对方开口。',
      text: '我在这里。今天想做点什么？',
      at: stamp(),
      ts: Date.now(),
      seq: nextSeq(),
      thinkOpen: false,
    });
  }
  // 聊天时间线 = 会话消息 + 上下文压缩记录，统一按 seq 排序
  // （提示词注入只进控制台：对话窗口只看压缩这一行）
  const items = [];
  chatState.messages.forEach((m, i) => {
    items.push({ kind: 'msg', m, seq: Number.isFinite(m.seq) ? m.seq : i + 0.001, order: i });
  });
  compactLog.forEach((c) => {
    if (c) items.push({ kind: 'compact', c, seq: Number.isFinite(c.seq) ? c.seq : 0, order: 1e6 });
  });
  items.sort((a, b) => a.seq - b.seq || a.order - b.order);

  items.forEach((item) => {
    if (item.kind === 'compact') {
      const node = renderCompactNode(item.c, { showTime: false });
      node.classList.add('chat-fold');
      el.chatHistory.appendChild(node);
      return;
    }
    const m = item.m;
    if (m.toolOnly) return; // 纯工具轮次只进控制台
    // 以 [系统信息] 开头的用户消息（插件注入 / 待机唤醒）在聊天里折成一张小卡片，
    // 不当作自己说的话显示；原文进控制台和模型侧
    if (m.role === 'user' && /^\[系统信息\]/.test(String(m.text || '').trim())) {
      el.chatHistory.appendChild(buildSystemNotice(m));
      return;
    }
    const bodyText = m.role === 'ai' ? tidyChatText(m.text) : String(m.text == null ? '' : m.text);
    // 历史记录里「只有空白正文 + 工具调用」的中间轮次也按纯工具轮次丢掉：
    // 否则聊天里会多出一个只剩朗读按钮的空气泡，还会多带一条「思考」行
    if (m.role === 'ai' && !bodyText && Array.isArray(m.toolCalls) && m.toolCalls.length) return;
    const msg = document.createElement('div');
    msg.className = 'msg ' + (m.role === 'ai' ? 'ai' : m.role === 'sys' ? 'sys' : 'user');
    if (m.role === 'ai') {
      // 思考默认只在控制台展示；设置里打开后，对话也会在正文上方显示可折叠的同一套思考行
      const showThink = !!settings.chatShowThink && !!m.think;
      if (showThink) {
        const thinkNode = buildThinkDetails({
          think: m.think,
          streaming: m.streaming,
          phase: m.phase,
          open: !!m.thinkOpen,
          onToggle: (open) => {
            m.thinkOpen = open;
          },
        });
        thinkNode.classList.add('chat-think');
        msg.appendChild(thinkNode);
      }
      const text = document.createElement('div');
      if (m.streaming && !bodyText && !showThink) {
        // 等首 token 时用扫光占位，比一个「…」更明确
        text.className = 'chat-thinking skeleton-text';
        text.textContent = '正在思考';
      } else {
        text.textContent = bodyText;
      }
      msg.appendChild(text);
      if (m.role === 'ai' && bodyText && !m.streaming && !IS_PANEL) {
        const speakBtn = document.createElement('button');
        speakBtn.className = 'msg-speak';
        speakBtn.dataset.seq = String(m.seq);
        speakBtn.title = '朗读这条回复';
        speakBtn.innerHTML = SPEAK_ICON;
        speakBtn.onclick = (e) => {
          e.stopPropagation();
          toggleSpeak(m);
        };
        text.appendChild(speakBtn);
      }
      if (m.stopped) {
        const hint = document.createElement('div');
        hint.className = 'msg-stopped';
        hint.textContent = '（已停止）';
        msg.appendChild(hint);
      }
    } else if (m.role === 'sys') {
      // 壳层提示（如轮次上限熔断）只展示给用户，不进入模型历史
      msg.textContent = m.text || '';
    } else {
      msg.textContent = shortImagePaths(m.text || '');
    }
    // 时间只挂在用户请求的气泡旁边；回答正文里不再逐段重复时间
    if (m.role === 'user') {
      const at = gateTime(m);
      if (at) {
        const row = document.createElement('div');
        row.className = 'chat-turn';
        const label = document.createElement('span');
        label.className = 'chat-turn-time';
        label.textContent = at;
        row.append(label, msg);
        el.chatHistory.appendChild(row);
        return;
      }
    }
    el.chatHistory.appendChild(msg);
  });
  refreshSpeakButtons();
  el.chatHistory.scrollTop = el.chatHistory.scrollHeight;
}

function pushChat(message) {
  chatState.cleared = false;
  const msg = { at: stamp(), ts: Date.now(), seq: nextSeq(), ...message };
  chatState.messages.push(msg);
  saveChatSession();
  renderChat();
  scheduleConsoleRender();
  return msg;
}

let chatBusy = false;
let chatSession = 0;
let chatCancel = null;
let chatRenderQueued = false;

function scheduleChatRender() {
  if (chatRenderQueued) return;
  chatRenderQueued = true;
  requestAnimationFrame(() => {
    chatRenderQueued = false;
    renderChat();
  });
}

function setChatSending(on) {
  const btn = $('#btn-send');
  if (!btn) return;
  const busy = !!on;
  if (btn.dataset.busy === String(busy)) return;
  btn.dataset.busy = String(busy);
  btn.classList.toggle('busy', busy);
  // 生成中同一颗按钮变成「终止请求」（和其他 AI 工具一致）
  btn.classList.toggle('stop', busy);
  btn.title = busy ? '终止请求' : '发送';
  btn.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.75" y="6.75" width="10.5" height="10.5" rx="2.9"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
}

// 自动压缩期间：发送键灰掉且不可点（不切成「停止」，避免误以为能中断压缩）。
// 聊天和 DSH 控制台两颗按钮都锁，压缩结束再恢复原状态。
function setCompressBusy(on) {
  const chatBtn = $('#btn-send');
  if (chatBtn) {
    chatBtn.disabled = !!on;
    chatBtn.classList.toggle('compress-busy', !!on);
    chatBtn.title = on ? '正在自动压缩上下文…' : chatBusy ? '终止请求' : '发送';
  }
  const conBtn = $('#btn-console-send');
  if (conBtn) {
    conBtn.disabled = !!on;
    conBtn.classList.toggle('compress-busy', !!on);
    conBtn.title = on ? '正在自动压缩上下文…' : consoleState.busy ? '停止生成' : '发送';
  }
}

// 老数据可能没有 seq：读取时补一个，保证按 seq 的压缩点不会误伤新消息
function ensureSeq(m) {
  if (!m) return 0;
  if (!Number.isFinite(m.seq) || m.seq <= 0) m.seq = nextSeq();
  return m.seq;
}

// 压缩点：新键 si.compressCutoffSeq 记录「最后一条被压缩消息的 seq」。
// 旧键 si.compressCutoff 是「第 N 条有正文的消息」，这里迁移一次并清掉旧键。
function chatCutoffSeq() {
  const saved = Number(store.get('agentpet.compressCutoffSeq', 0));
  if (Number.isFinite(saved) && saved > 0) return saved;
  const legacy = Math.max(0, Number(store.get('agentpet.compressCutoff', 0)) || 0);
  if (!legacy) return 0;
  const usable = chatState.messages.filter((m) => m.text && !m.streaming);
  const last = usable[Math.min(legacy, usable.length) - 1];
  const seq = last ? ensureSeq(last) : 0;
  store.set('agentpet.compressCutoffSeq', seq);
  store.set('agentpet.compressCutoff', 0);
  return seq;
}

// 按「对话轮次」从后往前截取：每遇到一条 role:'user' 就是新一轮。
// 选中某一轮后，该轮引发的所有 assistant / tool_calls / tool 结果都会保留。
function selectRecentTurns(messages, turns) {
  const all = messages || [];
  if (!(turns > 0) || turns >= 100) return all.slice(); // 100 = MAX，不截断
  let start = 0;
  let seen = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    start = i;
    if (all[i].role === 'user') {
      seen += 1;
      if (seen >= turns) break;
    }
  }
  return all.slice(start);
}

// ---- 情绪化上下文：按压力决定注入轮数，把一部分换成情绪相近的旧对话 ----
let lastHistoryHadGaps = false;
let lastHistoryGapSeqs = new Set();

// 压力越高，注入越接近上限：平常 0.8，紧张时 1.0（上限仍是 historyWindow）
function emotionContextWeight() {
  if (settings.emotionContext !== true) return 1;
  if (!emotionActive() || !emotionRuntime.state) return 1;
  const h = emotionRuntime.state.hormones || {};
  const stress = Math.min(1, Math.max(0, ((Number(h.cortisol) || 0) + (Number(h.adrenaline) || 0)) / 160));
  // 困意（褪黑素）50 以上开始线性收紧窗口：满值最多打 0.88 折，表现成「有点神志不清」
  const fog = Math.min(1, Math.max(0, ((Number(h.melatonin) || 0) - 50) / 50)) * 0.12;
  return (0.8 + 0.2 * stress) * (1 - fog);
}

// 按「用户消息」切轮：每条 user 开启一轮，后面的 ai 归属该轮
function splitDialogTurns(list) {
  const turns = [];
  let cur = null;
  (list || []).forEach((m) => {
    if (m.role === 'user') {
      cur = { seq: ensureSeq(m), msgs: [m] };
      turns.push(cur);
    } else if (m.role === 'ai' && cur) {
      cur.msgs.push(m);
    }
  });
  return turns;
}

// 补齐段来自更早的对话，加个短时间戳，模型才分得清是三天前还是刚才
function fmtHistoryStamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 选出本次要发的消息：情绪补齐段在前、连续段在后，保持时间顺序
function pickHistoryMessages(list, limitTurns) {
  lastHistoryHadGaps = false;
  lastHistoryGapSeqs = new Set();
  const turns = Number(limitTurns);
  if (!Number.isFinite(turns) || turns <= 0) return [];
  if (settings.emotionContext !== true) return selectRecentTurns(list, turns);

  const all = splitDialogTurns(list);
  // 轮次太少不拆：拆了也只是把有限语境切碎，还会平白多出一堆时间戳
  if (all.length < MIN_CONTEXT_TURNS) return selectRecentTurns(list, turns);

  const plan = planHistoryWindow(turns, emotionContextWeight(), all.length);
  // 关掉情绪一致性，或权重压满、没有真正跳过对话 → 纯连续窗口
  if (!plan.fill || all.length <= plan.total || settings.emotionContextPick === false) {
    return selectRecentTurns(list, plan.total);
  }
  const recent = all.slice(-plan.keep);
  const older = all.slice(0, all.length - plan.keep);
  const picked = pickTurnsByMood(
    older,
    plan.fill,
    emotionRuntime.state ? E.feel(emotionRuntime.state).valence : 50,
    Date.now(),
  );
  if (!picked.length) return selectRecentTurns(list, plan.total);
  lastHistoryHadGaps = true;
  picked.forEach((t) => t.msgs.forEach((m) => lastHistoryGapSeqs.add(ensureSeq(m))));
  return [...picked.flatMap((t) => t.msgs), ...recent.flatMap((t) => t.msgs)];
}

// 面板用：当前窗口规划（含「实际可注入多少轮」与优先回忆的情绪标签）
function currentEmotionContextPlan() {
  const cutoff = chatCutoffSeq();
  const after = chatState.messages.filter((m) => !m.streaming && ensureSeq(m) > cutoff);
  const turns = splitDialogTurns(after);
  const available = turns.length;
  const weight = emotionContextWeight();
  const plan = planHistoryWindow(settings.historyWindow, weight, available);
  const candidates = Math.max(0, available - plan.keep);
  const labels = [];
  if (settings.emotionContextPick !== false && plan.fill && available > plan.total) {
    const older = turns.slice(0, available - plan.keep);
    const picked = pickTurnsByMood(
      older,
      plan.fill,
      emotionRuntime.state ? E.feel(emotionRuntime.state).valence : 50,
      Date.now(),
    );
    picked.forEach((t) => t.msgs.forEach((m) => {
      const text = m && m.mood && m.mood.text;
      if (text) labels.push(String(text));
    }));
  }
  return { ...plan, available, weight, candidates, labels: [...new Set(labels)].slice(0, 4) };
}

// 非连续拼接可能出现两条同角色的普通消息，合并成一条，保证交替
function pushApiHistory(out, item) {
  const last = out[out.length - 1];
  const mergeable = last
    && last.role === item.role
    && !last.tool_calls
    && (item.role === 'user' || item.role === 'assistant')
    && typeof last.content === 'string'
    && typeof item.content === 'string';
  if (mergeable) {
    last.content = `${last.content}\n${item.content}`;
    return;
  }
  out.push(item);
}

// 把壳层消息重建为 OpenAI 历史：assistant 的 tool_calls 和 tool 结果都带上，
// 模型才能在后续请求里看到自己调用过什么工具、拿到了什么结果。
function buildApiHistory(limitTurns) {
  const cutoffSeq = chatCutoffSeq();
  const afterCutoff = chatState.messages.filter((m) => {
    if (m.streaming) return false;
    return ensureSeq(m) > cutoffSeq;
  });
  const picked = pickHistoryMessages(afterCutoff, limitTurns);
  const out = [];
  picked.forEach((m) => {
    if (m.role === 'user') {
      const text = String(m.text || '').trim();
      // 挑出来的旧对话带一个短时间戳，连续段保持原样
      const stamp = lastHistoryGapSeqs.has(ensureSeq(m)) ? `[${fmtHistoryStamp(m.ts)}] ` : '';
      // 引用的会话 / 笔记全文在这里补上，索引仍只存紧凑标记
      if (text) pushApiHistory(out, { role: 'user', content: stamp + text + buildRefBlock(m.refs) });
      return;
    }
    if (m.role !== 'ai') return; // role:'sys' 之类的壳层提示不发给模型
    const calls = (m.toolCalls || []).filter((t) => t && t.name && t.result != null);
    const text = String(m.text || '');
    if (!text.trim() && !calls.length) return;
    if (!calls.length) {
      pushApiHistory(out, { role: 'assistant', content: text });
      return;
    }
    // 历史里的 tool_call_id 现场生成即可：同一条消息内保持唯一
    const ids = calls.map((t, i) => `hist_${ensureSeq(m)}_${i}`);
    out.push({
      role: 'assistant',
      content: text.trim() ? text : null,
      tool_calls: calls.map((t, i) => ({
        id: ids[i],
        type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    });
    calls.forEach((t, i) => {
      out.push({ role: 'tool', tool_call_id: ids[i], content: String(t.result == null ? '' : t.result) });
    });
  });
  // 补齐段若以助手消息开头（比如那条用户消息是空的），整个历史得从用户消息起头
  const firstUser = out.findIndex((x) => x.role === 'user');
  if (firstUser > 0) out.splice(0, firstUser);
  return out;
}

// 上次请求的起点 seq（按当前 historyWindow 重算；请求组装后到调用前状态没变，可直接用）
function requestStartSeq() {
  // 情绪化上下文会跳过中间的对话，前缀回放不再覆盖全部待压缩内容
  if (lastHistoryHadGaps) return 0;
  const cutoff = chatCutoffSeq();
  const after = chatState.messages.filter((m) => !m.streaming && ensureSeq(m) > cutoff);
  const picked = selectRecentTurns(after, settings.historyWindow);
  return picked.length ? ensureSeq(picked[0]) : 0;
}

// ------------------------------------------------------------------ 自动记忆核心逻辑
function persistMemoryFacts() {
  store.set('agentpet.memoryFacts', memoryFacts);
  store.set('agentpet.memoryTurnCounter', memoryTurnCounter);
}

// 艾宾浩斯衰减：当前分数 = confidence * 0.5 ^ (未访问天数 / 半衰期)
function memoryScore(fact, now = Date.now()) {
  const accessed = Number(fact.last_accessed_at) || now;
  const days = Math.max(0, (now - accessed) / 86400000);
  return clamp(Number(fact.confidence) || 0, 0, 1) * Math.pow(0.5, days / MEMORY_HALF_LIFE_DAYS);
}

// 注入筛选：置顶无条件全量；其余按当前分数降序取前 5 条，低于 0.2 不注入
function selectInjectedFacts(now = Date.now()) {
  const active = memoryFacts.filter((f) => f.status === 'active');
  const pinned = active.filter((f) => f.is_pinned);
  const normal = active
    .filter((f) => !f.is_pinned)
    .map((f) => ({ fact: f, score: memoryScore(f, now) }))
    .filter((x) => x.score >= MEMORY_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MEMORY_INJECT_LIMIT)
    .map((x) => x.fact);
  return [...pinned, ...normal];
}

// 返回 { block, facts }：block 拼进 system prompt，facts 是本次真正注入的记忆
function memoryInjection(now = Date.now()) {
  if (!settings.memoryEnabled) return { block: '', facts: [] };
  const facts = selectInjectedFacts(now);
  if (!facts.length) return { block: '', facts: [] };
  const lines = facts.map((f) => `- [${f.type}] ${f.content}`);
  return {
    block: `关于用户的记忆（后台自动提取，可能过时；与对方当前说法冲突时以当前对话为准）：\n${lines.join('\n')}`,
    facts,
  };
}

// 复活机制：本次注入过的记忆立刻刷新访问时间，分数回满
function touchMemoryFacts(facts, now = Date.now()) {
  if (!facts || !facts.length) return;
  facts.forEach((f) => {
    f.last_accessed_at = now;
  });
  store.set('agentpet.memoryFacts', memoryFacts);
}

// 手动改过的记忆按「主人亲口盖章」处理：置信度 1.0 且重置访问时间
function stampMemoryFact(fact, content, now = Date.now()) {
  fact.content = String(content || '').trim().slice(0, MEMORY_FACT_MAX_CHARS);
  fact.confidence = 1;
  fact.last_accessed_at = now;
  fact.updated_at = now;
  fact.status = 'active';
}

// 把模型返回的文本解析成事实列表；无意义返回 SKIP 时得到空数组
function parseMemoryExtraction(raw) {
  let text = String(raw || '').trim();
  if (!text) return [];
  if (/^SKIP\b/i.test(text)) return [];
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let list;
  try {
    list = JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const typeAlias = { preference: '偏好', event: '事件', fact: '长期事实', '偏好': '偏好', '事件': '事件', '长期事实': '长期事实' };
  const out = [];
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const content = String(item.content || '').trim();
    const rawKey = String(item.mkey || '').trim();
    if (!content) return;
    // 没有 mkey 时用内容生成一个，避免写入被整条丢弃
    const mkey = (rawKey || `auto:${content}`).toLowerCase().replace(/\s+/g, '_').slice(0, 80);
    const type = typeAlias[String(item.type || '').trim().toLowerCase()] || typeAlias[String(item.type || '').trim()] || '长期事实';
    out.push({ mkey, type, content: content.slice(0, MEMORY_FACT_MAX_CHARS) });
  });
  return out;
}

// 冲突覆盖：同 mkey 的旧 active 记录标记 superseded（不物理删除），再插入新的 active
function upsertMemoryFacts(items, { confidence = MEMORY_DEFAULT_CONFIDENCE, pinned = false } = {}) {
  const now = Date.now();
  let added = 0;
  let superseded = 0;
  let refreshed = 0;
  items.forEach((item) => {
    const old = memoryFacts.filter((f) => f.mkey === item.mkey && f.status === 'active');
    const same = old[0];
    // 内容完全一样就不用制造版本垃圾，只刷新置信度与访问时间
    if (same && same.content === item.content && same.type === item.type && !pinned) {
      same.confidence = Math.max(same.confidence, confidence);
      same.last_accessed_at = now;
      same.updated_at = now;
      refreshed += 1;
      return;
    }
    const inheritPinned = old.length ? !!old[0].is_pinned : !!pinned;
    old.forEach((f) => {
      f.status = 'superseded';
      f.updated_at = now;
    });
    if (old.length) superseded += 1;
    const fresh = normalizeMemoryFact({
      mkey: item.mkey,
      type: item.type,
      content: item.content,
      confidence,
      last_accessed_at: now,
      is_pinned: inheritPinned,
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    if (fresh) {
      memoryFacts.push(fresh);
      added += 1;
    }
  });
  persistMemoryFacts();
  return { added, superseded, refreshed };
}

// 摘要归档：压缩上下文时把摘要存进「记忆库 → 归档」，SKIP 不存
function addMemoryArchive(summary) {
  const text = String(summary || '').trim();
  if (!text || /^SKIP\b/i.test(text)) return false;
  memoryArchive.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text });
  memoryArchive = memoryArchive.slice(0, 200);
  store.set('agentpet.memoryArchive', memoryArchive);
  return true;
}

function memoryExtractPrompt(dialog) {
  return [
    '你是记忆提取器。阅读下面这段对话，提取关于「用户」的稳定偏好、长期事实或重要事件。',
    '只输出 JSON 数组，不要解释、不要 Markdown 代码块。每个对象包含三个字段：',
    '{"mkey":"preference:drink:coffee","type":"偏好","content":"喜欢冰美式"}',
    'mkey 用英文小写，格式为「类别:主题:细节」；同一件事必须用同一个 mkey，方便覆盖旧记忆。',
    `type 只能是：${MEMORY_TYPES.join(' / ')}。`,
    'content 用一句中文陈述，不超过 60 字，只写用户本人的信息。',
    '如果这段对话全是寒暄、没有值得长期记住的信息，只输出 SKIP。',
    '',
    '对话内容：',
    dialog,
  ].join('\n');
}

// 只取上次提取点之后、有正文的对话，避免重复提取同一段
function memoryDialogSince(cursorSeq) {
  const lines = [];
  chatState.messages.forEach((m) => {
    if (!m || m.streaming) return;
    if (ensureSeq(m) <= cursorSeq) return;
    const text = String(m.text || '').trim();
    if (!text) return;
    if (m.role === 'user') lines.push(`用户：${text}`);
    else if (m.role === 'ai') lines.push(`${charNameText() || '角色'}：${text}`);
  });
  return lines.join('\n');
}

function memoryModelConfig() {
  const models = loadModels();
  const wanted = String(settings.memoryModel || '');
  return (wanted && models.find((m) => m.id === wanted)) || getApiConfig();
}

// 后台静默提取：不占用主对话的 Tool Call；手动按钮也走这里
async function runMemoryExtraction({ manual = false } = {}) {
  if (!settings.memoryEnabled) {
    if (manual) toast('自动记忆已关闭');
    return;
  }
  if (memoryExtracting) {
    if (manual) toast('记忆提取正在进行中');
    return;
  }
  const cursor = Math.max(0, Number(store.get('agentpet.memoryExtractSeq', 0)) || 0);
  const dialog = memoryDialogSince(cursor).slice(-6000);
  if (!dialog.trim()) {
    if (manual) toast('没有新的对话可提取');
    return;
  }
  const cfg = memoryModelConfig();
  if (!cfg || cfg.builtin || cfg.id === 'mock' || !cfg.key) {
    setMemStatus('跳过：提取模型未配置 Key');
    if (manual) toast('当前模型是 Mock 或没有 Key，无法提取记忆');
    return;
  }

  memoryExtracting = true;
  setMemStatus('提取中…');
  try {
    const safeDialog = await aliasizeForModel(dialog, { bare: true, onlyPaths: sessionImagePaths() });
    const acc = await callLLM([{ role: 'system', content: memoryExtractPrompt(safeDialog) }], { modelId: cfg.id });
    const items = parseMemoryExtraction(acc && acc.content);
    const stat = items.length ? upsertMemoryFacts(items) : { added: 0, superseded: 0, refreshed: 0 };
    // 无论 SKIP 还是解析失败，都把游标推到当前最新，避免下一轮反复重试同一段
    const maxSeq = chatState.messages.reduce((max, m) => Math.max(max, m && !m.streaming ? ensureSeq(m) : 0), cursor);
    store.set('agentpet.memoryExtractSeq', maxSeq);
    memoryTurnCounter = 0;
    persistMemoryFacts();
    if (items.length) {
      const parts = [];
      if (stat.added) parts.push(`新增 ${stat.added}`);
      if (stat.superseded) parts.push(`覆盖 ${stat.superseded}`);
      if (stat.refreshed) parts.push(`刷新 ${stat.refreshed}`);
      setMemStatus(`已提取：${parts.join(' · ')}`);
      consoleLog('记忆', `后台提取完成：${parts.join(' · ')}`);
    } else {
      setMemStatus('本轮没有值得记住的内容（SKIP）');
    }
    renderMemoryDb();
  } catch (err) {
    setMemStatus('提取失败：' + (err && err.message ? err.message : err));
    consoleLog('错误', `记忆提取失败：${err && err.message ? err.message : err}`);
    if (manual) toast('记忆提取失败');
  } finally {
    memoryExtracting = false;
  }
}

// 每完成一轮真实对话后调用。
// Step 2 起事实改由「压缩」一次产出，不再每 N 轮单独调 API 提取（省 token）。
// 旧 localStorage 事实的自动提取在这里停用，手动按钮保留到 Step 5 清理。
function noteMemoryTurn() {
  if (!settings.memoryEnabled) return;
  memoryTurnCounter += 1;
  persistMemoryFacts();
}

// 说话格式：内容来自用户维护的 si/app/preset-speak.md（speakFormatMd），程序不内置任何文字。
// 伪工具标记由 pseudo-tools.js 在流式输出里剥离，不会出现在聊天/TTS 里。

// ---- 可插拔工具（真 Tool Call）注册表 ----------------------------------
// 真相源是 si/app/tools.config.json：只注册真正的 Tool Call（play_action、manage_note…）。
// SPEAK / MEM_MARK 属于「底层通讯协议」，解析逻辑始终开启；给模型看的说明走 preset-speak.md，
// 不进这份配置，也不受工具管理开关影响。
let toolsConfig = { version: 1, tools: [] };
let toolsConfigPath = 'si/app/tools.config.json';
let toolsConfigLoaded = false;
let toolsConfigError = '';

// 规范化：缺省字段补全，未知字段原样保留（写回文件时不丢东西）
function normalizeToolsConfig(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(base.tools) ? base.tools : [];
  const tools = [];
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) return;
    item.name = name;
    if (!item.label) item.label = name;
    // icon 只是图标名（generic / search / command / note…），渲染时按表查找；
    // 没写或写了不认识的名字都会回退通用图标，方便插件工具直接复用。
    item.icon = typeof item.icon === 'string' ? item.icon.trim().toLowerCase() : '';
    item.enabled = item.enabled !== false;
    if (typeof item.prompt !== 'string') item.prompt = '';
    if (!item.schema || typeof item.schema !== 'object' || Array.isArray(item.schema)) {
      item.schema = { type: 'object', properties: {} };
    }
    item.aliases = Array.isArray(item.aliases) ? item.aliases.filter((a) => typeof a === 'string' && a.trim()) : [];
    tools.push(item);
  });
  base.version = Number(base.version) || 1;
  base.tools = tools;
  return base;
}

// 按名字或别名找到工具配置（note / memory → manage_note）
function findToolConfig(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return (
    toolsConfig.tools.find(
      (t) => t.name.toLowerCase() === key || t.aliases.some((a) => a.toLowerCase() === key),
    ) || null
  );
}

function activeTools() {
  return toolsConfig.tools.filter((t) => t.enabled !== false);
}

function isToolEnabled(name) {
  const tool = findToolConfig(name);
  return !!tool && tool.enabled !== false;
}

// 内核停转（关闭画面 / 收起到托盘停渲染）时，动作类工具不注入、也不放行
const KERNEL_BOUND_TOOLS = new Set(['play_action', 'list_advanced_actions']);

function kernelRunningNow() {
  return !IS_PANEL && !visualOffActive() && kernelReady;
}

function kernelToolGated(name) {
  // 先按别名解析到规范名，避免模型用别名调用时绕过门禁
  const cfg = findToolConfig(name);
  const key = String(cfg ? cfg.name : name || '').trim().toLowerCase();
  return KERNEL_BOUND_TOOLS.has(key) && !kernelRunningNow();
}

// 发给模型的 tools 参数：只含启用的工具
function activeLLMTools() {
  return activeTools()
    .filter((t) => !kernelToolGated(t.name))
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.prompt || t.label || t.name,
        parameters: t.schema,
      },
    }));
}

// 系统提示里的工具说明：遍历配置，只拼 enabled 的 prompt + schema
function toolsPromptBlock() {
  const tools = activeTools().filter((t) => !kernelToolGated(t.name));
  if (!tools.length) return '';
  const blocks = tools.map((t) => {
    const alias = t.aliases.length ? `（别名：${t.aliases.join(' / ')}，等价于 ${t.name}）` : '';
    const schema = JSON.stringify(t.schema, null, 2);
    return `### ${t.name}${alias}\n${charTemplate(t.prompt) || '（无说明）'}\n参数 schema：\n\`\`\`json\n${schema}\n\`\`\``;
  });
  return `可用工具（Tool Call，按 schema 传参）：\n\n${blocks.join('\n\n')}`;
}

async function loadToolsConfig() {
  let raw = null;
  toolsConfigError = '';
  try {
    if (window.petApi && window.petApi.readToolsConfig) {
      const r = await window.petApi.readToolsConfig();
      if (r && r.path) toolsConfigPath = r.path;
      if (r && r.ok) raw = r.config;
      else if (r && r.error) {
        toolsConfigError = r.error;
        console.warn('[shell] tools.config.json 读取失败', r.error);
      }
    }
  } catch (err) {
    toolsConfigError = String(err && err.message ? err.message : err);
    console.warn('[shell] tools.config.json 读取失败', err);
  }
  toolsConfig = normalizeToolsConfig(raw);
  toolsConfigLoaded = true;
  renderPresetTools();
  renderToolManage();
  return toolsConfig;
}

// 写回整份配置；localStorage 不需要，磁盘文件就是真相源
async function saveToolsConfig() {
  try {
    if (window.petApi && window.petApi.writeToolsConfig) {
      const r = await window.petApi.writeToolsConfig(toolsConfig);
      if (r && r.path) toolsConfigPath = r.path;
      if (r && !r.ok) toast(`写入失败：${r.error || '未知错误'}`);
    }
  } catch (err) {
    toast(`写入失败：${err && err.message ? err.message : err}`);
  }
  renderPresetTools();
  renderToolManage();
}

async function setToolEnabled(name, enabled) {
  const tool = findToolConfig(name);
  if (!tool) return;
  tool.enabled = !!enabled;
  renderPresetTools();
  renderToolManage();
  await saveToolsConfig();
  toast(`${tool.label || tool.name} 已${tool.enabled ? '启用' : '禁用'}`, tool.enabled ? 'accent' : 'warn');
  consoleLog('系统', `可插拔工具 ${tool.name} 已${tool.enabled ? '启用' : '禁用'}`);
}

// 设置页「工具管理」：只列真工具，SPEAK / MEM_MARK 不出现
function renderToolManage() {
  if (!el.toolManageList) return;
  if (el.toolsConfigPath) el.toolsConfigPath.textContent = toolsConfigPath;
  el.toolManageList.innerHTML = '';
  if (toolsConfigError) {
    const err = document.createElement('div');
    err.className = 'tool-manage-error';
    err.textContent = toolsConfigError;
    el.toolManageList.appendChild(err);
  }
  if (!toolsConfigLoaded) {
    const loading = document.createElement('div');
    loading.className = 'action-empty';
    loading.textContent = '正在读取工具配置…';
    el.toolManageList.appendChild(loading);
    return;
  }
  if (!toolsConfig.tools.length) {
    const empty = document.createElement('div');
    empty.className = 'action-empty';
    empty.textContent = toolsConfigError ? '配置读取失败，修好文件后点右上角「重新读取」。' : 'tools.config.json 里还没有注册任何工具。';
    el.toolManageList.appendChild(empty);
    return;
  }
  toolsConfig.tools.forEach((tool) => {
    const row = document.createElement('label');
    row.className = `setting-row tool-manage-item${tool.enabled ? '' : ' is-off'}`;

    const isPlugin = tool.source === 'plugin';
    const info = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = isPlugin
      ? `${tool.pluginName || tool.pluginId} · ${tool.label || tool.name}`
      : `${tool.label || tool.name} · ${tool.name}`;
    if (isPlugin) {
      const tag = document.createElement('i');
      tag.className = 'tool-tag';
      tag.textContent = '插件';
      title.appendChild(tag);
    }
    // 画面关闭（内核停转）时动作类工具会被短路禁用：这里明确告诉用户原因
    if (kernelToolGated(tool.name)) {
      const tag = document.createElement('i');
      tag.className = 'tool-tag is-unavailable';
      tag.textContent = '该工具暂不可用';
      tag.title = '画面已关闭（3D 内核停止渲染），该工具暂不注入提示词，调用也会被拒绝';
      title.appendChild(tag);
    }
    const desc = document.createElement('span');
    desc.textContent = tool.prompt || '（没有写 prompt）';
    info.appendChild(title);
    info.appendChild(desc);

    const plugin = isPlugin ? pluginState.plugins.find((p) => p.id === tool.pluginId) : null;
    const pluginBlocked = isPlugin && (!plugin || plugin.state === 'broken' || !plugin.enabled);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = tool.enabled;
    box.disabled = !!pluginBlocked;
    if (isPlugin && pluginBlocked) {
      row.classList.add('is-off');
      box.title = !plugin ? '插件未安装' : plugin.state === 'broken' ? '插件损坏，修复并重新导入后才能启用' : '插件已禁用';
    }
    box.addEventListener('change', async () => {
      // 插件工具默认关闭；第一次勾选时把权限清单摊开给用户看
      if (isPlugin && box.checked && !pluginPermissionConfirmed.has(tool.name)) {
        const ok = await openPermModal({
          title: '启用插件工具？',
          text: `${pluginPermissionText(plugin)}\n\n确认后模型才能在对话里看到并调用「${
            tool.pluginName || tool.pluginId
          } · ${tool.label || tool.name}」。`,
          confirmText: '启用工具',
        });
        if (!ok) {
          box.checked = false;
          return;
        }
        pluginPermissionConfirmed.add(tool.name);
      }
      await setToolEnabled(tool.name, box.checked);
      // 控制台的「智能搜索」开关和这里是同一个开关，跟着一起变
      syncModeChips(false);
    });

    row.appendChild(info);
    row.appendChild(box);
    el.toolManageList.appendChild(row);
  });
}

// 内核运转/停转会改变动作类工具的门禁状态：工具页开着时就即时刷新标签
function refreshToolManageIfOpen() {
  if (document.querySelector('.settings-page.active[data-page="tools"]')) renderToolManage();
}

// ------------------------------------------------------------------ 插件管理
// registry.json 由主进程维护，渲染层只缓存列表；配置表单按 schema 渲染，保存时整份写回。
let pluginState = { root: '', plugins: [], loaded: false, error: '', detailId: null };

// ---- 插件进程管理器（插件页右上角按钮 + 悬浮卡片）
// 数据源是主进程的 utilityProcess 调度层：状态、PID、RSS、队列、日志都从那里来。
const procState = {
  items: [],
  loaded: false,
  collapsed: true,
  expanded: new Set(),
  logs: new Map(),
  loadedLogs: new Set(),
  refreshTimer: null,
};

const PROC_STATE_LABELS = {
  busy: '执行中',
  ready: '空闲',
  starting: '启动中',
  stopped: '已停止',
  broken: '损坏',
};

function procMemText(rssKb) {
  const kb = Number(rssKb) || 0;
  if (!kb) return '—';
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(kb / 1024))} MB`;
}

function procUptimeText(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function procLogTime(at) {
  const d = new Date(Number(at) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function applyProcCollapse() {
  if (el.procPanel) el.procPanel.classList.toggle('is-collapsed', procState.collapsed);
  if (el.procHead) el.procHead.setAttribute('aria-expanded', procState.collapsed ? 'false' : 'true');
  syncProcWatch();
}

// 内存/PID 轮询只在「插件页 + 面板展开」时开启，收起或切页立即停止
let procWatchOn = false;
function syncProcWatch() {
  const onPage = !!document.querySelector('.settings-page.active[data-page="plugins"]');
  const shouldWatch = onPage && !procState.collapsed;
  if (shouldWatch === procWatchOn) return;
  procWatchOn = shouldWatch;
  try {
    const p = window.petApi && window.petApi.pluginProcWatch;
    if (p) void p(shouldWatch);
  } catch (_) {
    /* 老版本 preload 没有这个接口时忽略 */
  }
}

async function loadProcList() {
  if (!el.procList) return;
  if (!window.petApi || !window.petApi.pluginProcList) {
    procState.items = [];
    procState.loaded = true;
    renderProcPanel();
    return;
  }
  try {
    const r = await window.petApi.pluginProcList();
    procState.items = r && r.ok && Array.isArray(r.processes) ? r.processes : [];
  } catch (_) {
    procState.items = [];
  }
  procState.loaded = true;
  renderProcPanel();
}

function procScheduleRefresh() {
  if (procState.refreshTimer) return;
  procState.refreshTimer = setTimeout(() => {
    procState.refreshTimer = null;
    void loadProcList();
  }, 300);
}

function procRowOf(id) {
  if (!el.procList || !id) return null;
  try {
    return el.procList.querySelector(`[data-proc-id="${CSS.escape(String(id))}"]`);
  } catch (_) {
    return null;
  }
}

function appendProcLogLine(container, entry) {
  if (!container || !entry) return;
  const line = document.createElement('div');
  line.className = `proc-log-line${entry.level === 'error' ? ' is-error' : ''}`;
  const time = document.createElement('span');
  time.className = 'proc-log-time';
  time.textContent = procLogTime(entry.at);
  line.appendChild(time);
  line.appendChild(document.createTextNode(String(entry.line == null ? '' : entry.line)));
  container.appendChild(line);
}

function renderProcLogsInto(container, id) {
  container.innerHTML = '';
  container.classList.add('is-empty');
  const entries = procState.logs.get(id) || [];
  if (!procState.loadedLogs.has(id)) {
    const hint = document.createElement('div');
    hint.className = 'proc-logs-empty';
    hint.textContent = '正在读取日志…';
    container.appendChild(hint);
    return;
  }
  if (!entries.length) {
    const hint = document.createElement('div');
    hint.className = 'proc-logs-empty';
    hint.textContent = '暂无日志';
    container.appendChild(hint);
    return;
  }
  container.classList.remove('is-empty');
  entries.forEach((entry) => appendProcLogLine(container, entry));
  container.scrollTop = container.scrollHeight;
}

async function toggleProcLogs(id) {
  if (procState.expanded.has(id)) {
    procState.expanded.delete(id);
  } else {
    procState.expanded.add(id);
    if (!procState.loadedLogs.has(id)) {
      procState.loadedLogs.add(id);
      procState.logs.set(id, []);
      try {
        const r = await window.petApi.pluginProcLogs(id);
        procState.logs.set(id, r && r.ok && Array.isArray(r.logs) ? r.logs : []);
      } catch (_) {
        /* 读不到日志就显示空列表 */
      }
    }
  }
  renderProcPanel();
}

async function procStopItem(id) {
  try {
    const r = await window.petApi.pluginProcStop(id);
    if (!r || !r.ok) {
      toast((r && r.error) || '停止失败', 'warn');
      return;
    }
    toast('进程已停止', 'accent');
  } catch (err) {
    toast(String(err && err.message ? err.message : err), 'warn');
  }
  await loadProcList();
}

async function procStartItem(id) {
  try {
    const r = await window.petApi.pluginProcStart(id);
    if (!r || !r.ok) {
      toast((r && r.error) || '启动失败', 'warn');
      return;
    }
    toast('进程已启动', 'accent');
  } catch (err) {
    toast(String(err && err.message ? err.message : err), 'warn');
  }
  await loadProcList();
}

function buildProcRow(item) {
  const row = document.createElement('div');
  row.className = 'proc-item';
  row.dataset.procId = item.id;
  if (procState.expanded.has(item.id)) row.classList.add('is-expanded');

  const line = document.createElement('div');
  line.className = 'proc-row';

  const dot = document.createElement('div');
  dot.className = 'proc-spinner';
  if (item.state === 'ready') dot.classList.add('is-dot');
  else if (item.state === 'stopped') dot.classList.add('is-stopped');
  else if (item.state === 'broken') dot.classList.add('is-error');

  const info = document.createElement('div');
  info.className = 'proc-info';

  const name = document.createElement('div');
  name.className = 'proc-name';
  name.textContent = item.name || item.id;
  name.title = `${item.id}${item.version ? ` · v${item.version}` : ''}`;

  const meta = document.createElement('div');
  meta.className = 'proc-meta';

  const poolTag = document.createElement('span');
  poolTag.className = 'proc-tag';
  poolTag.textContent = item.pool === 'shared' ? '共享池' : '独立';
  meta.appendChild(poolTag);

  if (item.permission === 'full') {
    const tag = document.createElement('span');
    tag.className = 'proc-tag is-error';
    tag.textContent = '完全权限';
    meta.appendChild(tag);
  }

  if (item.state === 'broken') {
    const tag = document.createElement('span');
    tag.className = 'proc-tag is-error';
    tag.textContent = PROC_STATE_LABELS.broken;
    tag.title = item.reason || '';
    meta.appendChild(tag);
  } else if (item.queue > 0) {
    const tag = document.createElement('span');
    tag.className = 'proc-tag';
    tag.textContent = `队列 ${item.queue}`;
    meta.appendChild(tag);
  }

  const mem = document.createElement('span');
  mem.className = 'proc-mem';
  mem.textContent = procMemText(item.rssKb);
  mem.title = `PID ${item.pid || '—'} · 运行 ${item.state === 'stopped' || item.state === 'broken' ? '—' : procUptimeText(item.uptimeMs)}`;
  meta.appendChild(mem);

  info.appendChild(name);
  info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'proc-actions';

  const expandBtn = document.createElement('button');
  expandBtn.className = 'proc-btn';
  expandBtn.type = 'button';
  expandBtn.title = '展开日志';
  expandBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  if (procState.expanded.has(item.id)) expandBtn.classList.add('is-expanded');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void toggleProcLogs(item.id);
  });

  const running = item.state === 'busy' || item.state === 'ready' || item.state === 'starting';
  const powerBtn = document.createElement('button');
  powerBtn.className = 'proc-btn';
  powerBtn.type = 'button';
  if (running) {
    powerBtn.title = '停止进程';
    powerBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
    powerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void procStopItem(item.id);
    });
  } else if (item.state === 'stopped') {
    powerBtn.title = '启动进程';
    powerBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="8 5 19 12 8 19 8 5"/></svg>';
    powerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void procStartItem(item.id);
    });
  } else {
    powerBtn.title = item.reason || '插件损坏，需要重新导入';
    powerBtn.disabled = true;
    powerBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
  }

  actions.appendChild(expandBtn);
  actions.appendChild(powerBtn);
  line.appendChild(dot);
  line.appendChild(info);
  line.appendChild(actions);

  const logs = document.createElement('div');
  logs.className = 'proc-logs';
  renderProcLogsInto(logs, item.id);

  row.appendChild(line);
  row.appendChild(logs);
  return row;
}

function renderProcPanel() {
  if (!el.procList) return;
  applyProcCollapse();

  const running = procState.items.filter(
    (p) => p.state === 'busy' || p.state === 'ready' || p.state === 'starting',
  ).length;

  if (el.procSummary) {
    el.procSummary.textContent = procState.loaded
      ? `${running} 个后台进程`
      : '进程状态读取中…';
  }

  el.procList.innerHTML = '';
  if (!procState.loaded) {
    const hint = document.createElement('div');
    hint.className = 'proc-empty';
    hint.textContent = '正在读取进程状态…';
    el.procList.appendChild(hint);
    return;
  }
  if (!procState.items.length) {
    const hint = document.createElement('div');
    hint.className = 'proc-empty';
    hint.textContent = '没有正在运行的插件进程。启用插件后会自动拉起。';
    el.procList.appendChild(hint);
    return;
  }
  procState.items.forEach((item) => el.procList.appendChild(buildProcRow(item)));
}

// stats 每 2 秒来一次：只更新内存和 PID，不整表重绘，避免日志滚动位置丢失
function updateProcStats(payload) {
  const id = payload && payload.pluginId;
  if (!id) return;
  const item = procState.items.find((p) => p.id === id);
  if (!item) return;
  if (payload.pid) item.pid = payload.pid;
  item.rssKb = Number(payload.rssKb) || 0;
  const row = procRowOf(id);
  if (!row) return;
  const mem = row.querySelector('.proc-mem');
  if (!mem) return;
  mem.textContent = procMemText(item.rssKb);
  mem.title = `PID ${item.pid || '—'} · 运行 ${procUptimeText(item.uptimeMs)}`;
}

function appendProcLog(payload) {
  const id = payload && payload.pluginId;
  const entry = payload && payload.entry;
  if (!id || !entry) return;
  let buf = procState.logs.get(id);
  if (!buf) {
    buf = [];
    procState.logs.set(id, buf);
  }
  buf.push(entry);
  if (buf.length > 200) buf.splice(0, buf.length - 200);
  if (!procState.expanded.has(id)) return;
  const row = procRowOf(id);
  if (!row) return;
  const container = row.querySelector('.proc-logs');
  if (!container) return;
  // 只有用户本来就停在底部时才跟随新日志；往上翻看历史时不被拽回去
  const stickBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 24;
  if (!procState.loadedLogs.has(id)) {
    procState.loadedLogs.add(id);
    container.innerHTML = '';
  }
  const empty = container.querySelector('.proc-logs-empty');
  if (empty) empty.remove();
  container.classList.remove('is-empty');
  appendProcLogLine(container, entry);
  if (stickBottom) container.scrollTop = container.scrollHeight;
}

if (el.procHead) {
  el.procHead.addEventListener('click', () => {
    procState.collapsed = !procState.collapsed;
    applyProcCollapse();
  });
}

// 点面板外面或按 Esc 收起悬浮卡片
document.addEventListener('click', (e) => {
  if (procState.collapsed || !el.procPanel) return;
  if (el.procPanel.contains(e.target)) return;
  procState.collapsed = true;
  applyProcCollapse();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || procState.collapsed) return;
  procState.collapsed = true;
  applyProcCollapse();
});

const pluginIcons = new Map();
const pluginDrafts = new Map();
const pluginPermissionConfirmed = new Set();

// 沙箱档位 / 进程形态图标（对齐参考稿）
const PERM_ICON_SHIELD =
  '<svg class="plugin-mode-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 L19 6 V11 C19 16 14.5 20 12 21 C9.5 20 5 16 5 11 V6 Z"/><polyline points="8.5 11.5 11 14 15.5 9.5"/></svg>';
const PERM_ICON_ALERT =
  '<svg class="plugin-mode-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 L19 6 V11 C19 16 14.5 20 12 21 C9.5 20 5 16 5 11 V6 Z"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/></svg>';
const POOL_ICON_SHARED =
  '<svg class="plugin-mode-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15" r="1.5" fill="currentColor" stroke="none"/><polyline points="12 9 12 12 15.5 13.5"/><line x1="12" y1="12" x2="8.5" y2="13.5"/></svg>';
const POOL_ICON_ISOLATED =
  '<svg class="plugin-mode-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><line x1="12" y1="4" x2="12" y2="20"/><circle cx="7.5" cy="12" r="2"/><circle cx="16.5" cy="12" r="2"/></svg>';

const PLUGIN_FALLBACK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3.5a2 2 0 0 1 4 0v1.2h2.3a1.3 1.3 0 0 1 1.3 1.3V9h1.2a2 2 0 0 1 0 4h-1.2v2.9a1.3 1.3 0 0 1-1.3 1.3H14v1.2a2 2 0 0 1-4 0v-1.2H7.7a1.3 1.3 0 0 1-1.3-1.3V13H5.2a2 2 0 0 1 0-4h1.2V6a1.3 1.3 0 0 1 1.3-1.3H10z"/></svg>';

// 下拉菜单里的选中勾（对齐参考稿）
const POOL_CHECK_ICON =
  '<svg class="plugin-pool-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="5 12.5 10 17.5 19 7"/></svg>';

function pluginPermissionText(plugin) {
  if (!plugin) return '权限清单未知';
  const perms = Array.isArray(plugin.permissions) ? plugin.permissions : [];
  const items = ['会联网'];
  if (perms.includes('fs')) items.push('会读写插件目录内的文件');
  if (perms.includes('ext')) items.push('会执行外部程序');
  if (plugin.permission === 'full') {
    return `该插件处于「完全模式」：${items.join('、')}，并且可以访问插件目录外的文件、拉起子进程。`;
  }
  return `该插件处于「受限模式」：${items.join('、')}；禁止子进程，禁止访问插件目录以外的文件。`;
}

// ---- 权限确认弹窗（危险操作必须勾选后才放行）
let permModalResolve = null;

function openPermModal({ title, text, confirmText = '继续' }) {
  return new Promise((resolve) => {
    if (!el.permModalMask) {
      resolve(window.confirm(text));
      return;
    }
    permModalResolve = resolve;
    el.permModalTitle.textContent = title;
    el.permModalText.textContent = text;
    el.permModalOk.textContent = confirmText;
    el.permModalAgree.checked = false;
    el.permModalOk.disabled = true;
    el.permModalMask.hidden = false;
  });
}

function closePermModal(value) {
  if (el.permModalMask) el.permModalMask.hidden = true;
  const fn = permModalResolve;
  permModalResolve = null;
  if (fn) fn(value);
}

if (el.permModalAgree) {
  el.permModalAgree.addEventListener('change', () => {
    el.permModalOk.disabled = !el.permModalAgree.checked;
  });
}
if (el.permModalOk) {
  el.permModalOk.addEventListener('click', () => {
    if (!el.permModalOk.disabled) closePermModal(true);
  });
}
if (el.permModalCancel) el.permModalCancel.addEventListener('click', () => closePermModal(false));
if (el.permModalClose) el.permModalClose.addEventListener('click', () => closePermModal(false));
if (el.permModalMask) {
  el.permModalMask.addEventListener('click', (e) => {
    if (e.target === el.permModalMask) closePermModal(false);
  });
}

// ---- 删除角色：6 位验证码（防误删）。字符集去掉了 0/O/1/l/I 这类容易看混的字符
const DEL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function makeDeleteCode(len = 6) {
  const bytes = new Uint8Array(len);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < len; i += 1) out += DEL_CODE_ALPHABET[bytes[i] % DEL_CODE_ALPHABET.length];
  return out;
}

function openDeleteCharModal(ch) {
  return new Promise((resolve) => {
    const mask = el.charDelMask;
    if (!mask) {
      resolve(false);
      return;
    }
    const code = makeDeleteCode(6);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      mask.hidden = true;
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('paste', onPaste);
      el.charDelOtp.onpaste = null;
      el.charDelOk.onclick = null;
      el.charDelCancel.onclick = null;
      el.charDelClose.onclick = null;
      mask.onclick = null;
      resolve(value);
    };

    el.charDelText.textContent = `即将删除角色「${ch.name || ch.id}」。该角色目录里的内核、动作库、会话记录与全部记忆会被永久删除，无法恢复。请输入下方验证码确认。`;
    el.charDelCode.textContent = code;
    el.charDelOtp.textContent = '';

    const boxes = [];
    const readBox = (node) => node.dataset.value || '';
    const writeBox = (node, value) => {
      const v = value || '';
      node.dataset.value = v;
      node.textContent = v;
    };
    for (let i = 0; i < code.length; i += 1) {
      const box = document.createElement('div');
      box.className = 'char-del-otp-input';
      box.tabIndex = 0;
      box.setAttribute('role', 'textbox');
      box.setAttribute('aria-readonly', 'true');
      box.setAttribute('aria-label', `验证码第 ${i + 1} 位`);
      el.charDelOtp.appendChild(box);
      boxes.push(box);
    }

    const sync = () => {
      boxes.forEach((node) => node.classList.toggle('filled', !!readBox(node)));
      el.charDelOk.disabled = boxes.map(readBox).join('') !== code;
    };

    // 长按产生的系统连键：keyup 之前同一个键只认一次
    let heldKey = '';
    // 极短时间内收到同一个字符（系统/输入法重复派发）也只认一次
    let lastChar = '';
    let lastCharAt = 0;
    const onKeyUp = () => {
      heldKey = '';
    };
    window.addEventListener('keyup', onKeyUp);

    boxes.forEach((box, index) => {
      box.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // 验证码只认英文/数字：输入法组合态直接拦掉，避免一次提交多个字符
        if (e.isComposing) {
          e.preventDefault();
          return;
        }
        // 单字符自己写入：绕开输入法组合态与系统连键，一次按键只填一格
        if (e.key.length === 1) {
          e.preventDefault();
          if (e.key === ' ' || e.repeat || e.key === heldKey) return;
          const now = performance.now();
          if (e.key === lastChar && now - lastCharAt < 50) return;
          heldKey = e.key;
          lastChar = e.key;
          lastCharAt = now;
          writeBox(box, e.key);
          if (index < boxes.length - 1) boxes[index + 1].focus();
          sync();
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (readBox(box)) {
            writeBox(box, '');
            sync();
          } else if (index > 0) {
            writeBox(boxes[index - 1], '');
            boxes[index - 1].focus();
            sync();
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          e.preventDefault();
          boxes[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < boxes.length - 1) {
          e.preventDefault();
          boxes[index + 1].focus();
        } else if (e.key === 'Enter' && !el.charDelOk.disabled) {
          finish(true);
        } else if (e.key === 'Escape') {
          // 别让全局 Esc 顺手把设置面板一起关掉
          e.stopPropagation();
          finish(false);
        }
      });
    });

    el.charDelOtp.onpaste = null;
    const onPaste = (e) => {
      const text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\s+/g, '');
      if (!text) return;
      e.preventDefault();
      const chars = Array.from(text).slice(0, boxes.length);
      boxes.forEach((node, i) => {
        writeBox(node, chars[i] || '');
      });
      (boxes[chars.length] || boxes[boxes.length - 1]).focus();
      sync();
    };
    window.addEventListener('paste', onPaste);

    el.charDelOk.onclick = () => {
      if (!el.charDelOk.disabled) finish(true);
    };
    el.charDelCancel.onclick = () => finish(false);
    el.charDelClose.onclick = () => finish(false);
    mask.onclick = (e) => {
      if (e.target === mask) finish(false);
    };

    el.charDelOk.disabled = true;
    mask.hidden = false;
    requestAnimationFrame(() => boxes[0] && boxes[0].focus());
  });
}

async function loadPlugins() {
  if (!el.pluginList) return pluginState;
  const detailId = pluginState.detailId;
  if (!window.petApi || !window.petApi.pluginList) {
    pluginState = { root: '', plugins: [], loaded: true, error: '当前环境不支持插件接口', detailId: null };
    renderPlugins();
    return pluginState;
  }
  try {
    const r = await window.petApi.pluginList();
    if (!r || !r.ok) {
      pluginState = {
        root: (r && r.root) || '',
        plugins: [],
        loaded: true,
        error: (r && r.error) || '读取插件注册表失败',
        detailId,
      };
    } else {
      pluginState = {
        root: r.root || '',
        plugins: Array.isArray(r.plugins) ? r.plugins : [],
        loaded: true,
        error: '',
        detailId,
      };
    }
  } catch (err) {
    pluginState = { root: '', plugins: [], loaded: true, error: String(err && err.message ? err.message : err), detailId };
  }
  // 详情页对应的插件被卸载了 → 退回列表
  if (pluginState.detailId && !pluginState.plugins.some((p) => p.id === pluginState.detailId)) {
    pluginState.detailId = null;
  }
  renderPlugins();
  return pluginState;
}

function pluginStateBadge(p) {
  const badge = document.createElement('span');
  if (p.state === 'broken') {
    badge.className = 'plugin-badge state-broken';
    badge.textContent = '损坏';
  } else if (!p.enabled) {
    badge.className = 'plugin-badge state-off';
    badge.textContent = '已禁用';
  } else {
    badge.className = 'plugin-badge state-on';
    badge.textContent = '已启用';
  }
  return badge;
}

function loadPluginIcon(id, container) {
  const apply = (dataUrl) => {
    if (!dataUrl) return;
    container.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    container.appendChild(img);
  };
  if (pluginIcons.has(id)) {
    apply(pluginIcons.get(id));
    return;
  }
  try {
    window.petApi.pluginIcon(id).then((r) => {
      const url = r && r.ok && r.dataUrl ? r.dataUrl : '';
      pluginIcons.set(id, url);
      apply(url);
    });
  } catch (_) {
    /* 图标读不出来就用内置图标 */
  }
}

function renderPlugins() {
  if (!el.pluginList) return;
  if (el.pluginRootPath) el.pluginRootPath.textContent = pluginState.root || '读取中…';

  const detail = pluginState.detailId ? pluginState.plugins.find((p) => p.id === pluginState.detailId) : null;
  if (el.pluginBrowser) el.pluginBrowser.hidden = !!detail;
  if (el.pluginDetail) el.pluginDetail.hidden = !detail;
  if (detail) {
    renderPluginDetail(detail);
    return;
  }

  el.pluginList.innerHTML = '';
  if (pluginState.error) {
    const err = document.createElement('div');
    err.className = 'tool-manage-error';
    err.textContent = pluginState.error;
    el.pluginList.appendChild(err);
    return;
  }
  if (!pluginState.loaded) {
    const loading = document.createElement('div');
    loading.className = 'action-empty';
    loading.textContent = '正在读取插件注册表…';
    el.pluginList.appendChild(loading);
    return;
  }
  if (!pluginState.plugins.length) {
    const empty = document.createElement('div');
    empty.className = 'action-empty';
    empty.textContent = '还没有安装插件。点右上角「导入插件」选择一个 zip 包。';
    el.pluginList.appendChild(empty);
    return;
  }
  pluginState.plugins.forEach((p) => el.pluginList.appendChild(buildPluginRow(p)));
}

// 列表只保留一行：图标 + 名称 + 一行描述 + 开关；错误详情放到详情页
function buildPluginRow(p) {
  const row = document.createElement('div');
  row.className = `plugin-row${p.state === 'broken' ? ' is-broken' : ''}`;
  row.dataset.id = p.id;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const icon = document.createElement('div');
  icon.className = 'plugin-icon';
  icon.innerHTML = PLUGIN_FALLBACK_ICON;
  if (p.icon) loadPluginIcon(p.id, icon);

  const info = document.createElement('div');
  info.className = 'plugin-info';

  const name = document.createElement('div');
  name.className = 'plugin-name';
  const nameText = document.createElement('b');
  nameText.textContent = p.name || p.id;
  name.appendChild(nameText);

  const desc = document.createElement('div');
  desc.className = 'plugin-desc';
  desc.textContent = p.description || p.id;

  info.appendChild(name);
  info.appendChild(desc);

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'plugin-switch';
  toggle.checked = !!p.enabled;
  toggle.disabled = p.state === 'broken';
  toggle.title = p.state === 'broken' ? '插件损坏，修复后重新导入才能启用' : p.enabled ? '禁用插件' : '启用插件';
  toggle.addEventListener('click', (e) => e.stopPropagation());
  toggle.addEventListener('change', async () => {
    const r = await window.petApi.pluginSetEnabled(p.id, toggle.checked);
    if (!r || !r.ok) {
      toggle.checked = !toggle.checked;
      toast((r && r.error) || '切换失败', 'warn');
      return;
    }
    toast(`${p.name || p.id} 已${toggle.checked ? '启用' : '禁用'}`, toggle.checked ? 'accent' : 'warn');
    await loadPlugins();
    await loadToolsConfig();
  });

  const open = () => {
    pluginState.detailId = p.id;
    renderPlugins();
    el.pluginDetailConfig.innerHTML = '';
    loadPluginDetailConfig(p);
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  row.appendChild(icon);
  row.appendChild(info);
  row.appendChild(toggle);
  return row;
}

function renderPluginDetail(p) {
  if (el.pluginDetailBackLabel) el.pluginDetailBackLabel.textContent = p.id;
  if (el.pluginDetailIcon) {
    el.pluginDetailIcon.innerHTML = PLUGIN_FALLBACK_ICON;
    if (p.icon) loadPluginIcon(p.id, el.pluginDetailIcon);
  }
  if (el.pluginDetailName) el.pluginDetailName.textContent = p.name || p.id;
  if (el.pluginDetailId) {
    el.pluginDetailId.textContent = `插件 ID：${p.id}${p.version ? ` · v${p.version}` : ''}`;
  }
  if (el.pluginDetailDesc) el.pluginDetailDesc.textContent = p.description || '（插件没有写描述）';

  if (el.pluginDetailBadges) {
    el.pluginDetailBadges.innerHTML = '';
    el.pluginDetailBadges.appendChild(pluginStateBadge(p));
    const permBadge = document.createElement('span');
    permBadge.className = 'plugin-badge perm';
    permBadge.textContent = p.permission === 'full' ? '完全模式' : '受限模式';
    el.pluginDetailBadges.appendChild(permBadge);
  }

  // 错误原因只写在详情页里，列表只看灰不灰
  if (el.pluginDetailStatus) {
    el.pluginDetailStatus.hidden = !p.reason;
    el.pluginDetailStatus.textContent = p.reason || '';
  }

  // 运行时区块：只要插件声明了 runtime 就显示，与是否有配置表单无关
  let runtimeBox = document.getElementById('plugin-detail-runtime');
  if (!runtimeBox) {
    runtimeBox = document.createElement('div');
    runtimeBox.id = 'plugin-detail-runtime';
    if (el.pluginDetailConfig && el.pluginDetailConfig.parentNode) {
      el.pluginDetailConfig.parentNode.insertBefore(runtimeBox, el.pluginDetailConfig);
    }
  }
  renderPluginRuntime(p, runtimeBox);

  if (!el.pluginDetailActions) return;
  el.pluginDetailActions.innerHTML = '';

  // 沙箱模式 / 运行模式：各占一行，左边说明、右边下拉（对齐参考样式）
  const full = p.permission === 'full';
  const pool = p.pool === 'shared' ? 'shared' : 'dedicated';

  const modeRow = (label, desc, current, options, onPick) => {
    const row = document.createElement('div');
    row.className = 'setting-row plugin-mode-row';

    const info = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = label;
    const note = document.createElement('span');
    note.textContent = desc;
    info.appendChild(title);
    info.appendChild(note);
    row.appendChild(info);

    const wrap = document.createElement('div');
    wrap.className = 'plugin-perm-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plugin-mode-btn';
    const currentOpt = options.find((o) => o.value === current);
    btn.innerHTML = `${currentOpt.icon}<span>${currentOpt.label}</span><svg class="plugin-perm-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>`;

    const menu = document.createElement('div');
    menu.className = 'plugin-perm-menu plugin-mode-menu';
    menu.hidden = true;

    for (const opt of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'plugin-perm-item';
      const active = opt.value === current;
      item.innerHTML = `${opt.icon}<span>${opt.label}</span>${active ? POOL_CHECK_ICON : ''}`;
      if (active) item.classList.add('is-active');
      if (opt.disabled) {
        item.classList.add('is-disabled');
        if (opt.title) item.title = opt.title;
      } else {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.hidden = true;
          if (!active) onPick(opt.value);
        });
      }
      menu.appendChild(item);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = menu.hidden;
      menu.hidden = !opening;
      if (!opening) return;
      // 这两行常在页面底部，下方空间不够就向上弹，避免被裁掉
      menu.classList.toggle(
        'is-up',
        window.innerHeight - btn.getBoundingClientRect().bottom < menu.offsetHeight + 12,
      );
      setTimeout(() => document.addEventListener('click', () => (menu.hidden = true), { once: true }), 0);
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    row.appendChild(wrap);
    return row;
  };

  // 两行放在详情页最上面（标题下方），下面才是运行时与配置
  const modesBox = document.createElement('div');
  modesBox.className = 'plugin-mode-box';
  modesBox.appendChild(
    modeRow(
      '沙箱模式',
      full ? '不受沙箱限制，可访问任意文件并启动子进程' : '只能读写插件目录内的文件，禁止启动子进程',
      full ? 'full' : 'restricted',
      [
        { value: 'restricted', label: '受限模式', icon: PERM_ICON_SHIELD },
        { value: 'full', label: '完全权限', icon: PERM_ICON_ALERT },
      ],
      (value) => switchPluginPermission(p, value),
    ),
  );

  modesBox.appendChild(
    modeRow(
      '运行模式',
      full
        ? '完全权限插件只能独立运行'
        : pool === 'shared'
          ? '与其他受限插件共用一个进程，任务串行执行'
          : '独占一个进程，互不影响',
      pool,
      [
        {
          value: 'shared',
          label: '共享模式',
          icon: POOL_ICON_SHARED,
          disabled: full,
          title: '完全权限插件只能独立运行，如需共享池请先切回受限模式',
        },
        { value: 'dedicated', label: '独立模式', icon: POOL_ICON_ISOLATED },
      ],
      (value) => switchPluginPool(p, value),
    ),
  );

  const detailHost = el.pluginDetailStatus && el.pluginDetailStatus.parentNode;
  if (detailHost) {
    detailHost.querySelector('.plugin-mode-box')?.remove();
    detailHost.insertBefore(modesBox, el.pluginDetailStatus);
  }

  const links = document.createElement('div');
  links.className = 'plugin-detail-links';

  const openBtn = document.createElement('button');
  openBtn.className = 'link-btn';
  openBtn.textContent = '打开目录';
  openBtn.addEventListener('click', () => window.petApi.pluginOpenDir(p.id));
  links.appendChild(openBtn);

  const reBtn = document.createElement('button');
  reBtn.className = 'link-btn';
  reBtn.textContent = '重新导入';
  reBtn.addEventListener('click', () => reimportPlugin(p));
  links.appendChild(reBtn);

  const rmBtn = document.createElement('button');
  rmBtn.className = 'link-btn danger';
  rmBtn.textContent = '卸载';
  rmBtn.addEventListener('click', () => uninstallPlugin(p));
  links.appendChild(rmBtn);

  el.pluginDetailActions.appendChild(links);
}

// 插件运行时：状态 + 导入 zip / 下载（大件不随插件包走）
function renderPluginRuntime(p, box) {
  box.innerHTML = '';
  const rt = p.runtime;
  box.hidden = !rt;
  if (!rt) return;

  const title = document.createElement('div');
  title.className = 'plugin-config-title';
  title.textContent = '运行时';
  box.appendChild(title);

  const row = document.createElement('div');
  row.className = 'setting-row';
  const info = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = '状态';
  info.appendChild(b);
  const span = document.createElement('span');
  if (rt.state === 'ready') {
    span.textContent = `已就绪 · ${rt.base}`;
  } else if (rt.state === 'partial') {
    span.textContent = `缺少 ${rt.missing.length} 个文件：${rt.missing.slice(0, 3).join('、')}${
      rt.missing.length > 3 ? '…' : ''
    }`;
  } else {
    const need = rt.required && rt.required.length ? `，需要 ${rt.required.slice(0, 2).join('、')}` : '';
    span.textContent = `未安装 · ${rt.base}${need}`;
  }
  info.appendChild(span);
  row.appendChild(info);
  box.appendChild(row);

  const bar = document.createElement('div');
  bar.className = 'voice-install';

  // 刷新：文件是用户手动放进去的，重新读一次状态即可，不用重开插件详情页
  const refresh = document.createElement('button');
  refresh.className = 'btn-ghost-sm';
  refresh.textContent = '刷新';
  refresh.addEventListener('click', async () => {
    const r = await window.petApi.pluginRuntimeStatus(p.id);
    if (!r || !r.ok) {
      toast((r && r.error) || '读取运行时状态失败');
      return;
    }
    p.runtime = r.runtime;
    renderPluginRuntime(p, box);
    refreshTtsEngineStatus();
  });
  bar.appendChild(refresh);

  const open = document.createElement('button');
  open.className = 'btn-ghost-sm';
  open.textContent = '打开目录';
  open.addEventListener('click', () => {
    void window.petApi.pluginOpenDir(p.id);
  });
  bar.appendChild(open);

  if (rt.state !== 'ready') {
    const imp = document.createElement('button');
    imp.className = 'btn-ghost-sm';
    imp.textContent = '导入 zip';
    imp.addEventListener('click', async () => {
      const r = await window.petApi.pluginRuntimeImport(p.id);
      if (r && r.canceled) return;
      if (r && r.ok) toast(`${p.name || p.id} 运行时已就绪`, 'accent');
      else toast((r && r.error) || '导入后仍缺文件，请检查压缩包内容');
      await loadPlugins();
      refreshTtsEngineStatus();
    });
    bar.appendChild(imp);
    if (rt.download && rt.download.url) {
      const dl = document.createElement('button');
      dl.className = 'btn-ghost-sm';
      dl.textContent = '下载';
      dl.addEventListener('click', async () => {
        const r = await window.petApi.pluginRuntimeDownload(p.id);
        if (r && r.ok) toast(`${p.name || p.id} 运行时已就绪`, 'accent');
        else toast((r && r.error) || '下载失败');
        await loadPlugins();
        refreshTtsEngineStatus();
      });
      bar.appendChild(dl);
    }
  }
  box.appendChild(bar);

  if (rt.state !== 'ready' && (!rt.download || !rt.download.url)) {
    const note = document.createElement('div');
    note.className = 'plugin-note';
    const text = document.createElement('span');
    text.textContent = '可以直接把运行时文件夹放进上面这个目录，然后点「刷新」。';
    note.appendChild(text);
    box.appendChild(note);
  }
}

async function loadPluginDetailConfig(p) {
  const box = el.pluginDetailConfig;
  if (!box) return;
  box.innerHTML = '';
  if (!p.uiDeclared) return;

  const r = await window.petApi.pluginReadConfig(p.id);
  if (pluginState.detailId !== p.id) return;
  if (!r || !r.ok) {
    const note = document.createElement('div');
    note.className = 'plugin-status';
    note.textContent = (r && r.error) || '读取配置失败';
    box.appendChild(note);
    return;
  }
  const draft = r.config && typeof r.config === 'object' ? cloneJson(r.config) : {};
  applySchemaDefaults(p.staticSchema, draft);
  pluginDrafts.set(p.id, draft);
  renderPluginConfigBody(p, draft, box);
}

async function switchPluginPermission(p, target) {
  const next = target || (p.permission === 'full' ? 'restricted' : 'full');
  if (next === 'full') {
    const ok = await openPermModal({
      title: '确认启用完全权限？',
      text: `启用后，「${p.name || p.id}」可以启动外部程序、读写任意路径的文件、访问网络。这些能力不受沙箱限制，只对完全信任的插件开启。`,
      confirmText: '启用完全权限',
    });
    if (!ok) return;
  }
  const r = await window.petApi.pluginSetPermission(p.id, next);
  if (!r || !r.ok) {
    toast((r && r.error) || '切换权限失败', 'warn');
    return;
  }
  toast(`${p.name || p.id} 已切换到${next === 'full' ? '完全模式' : '受限模式'}`, next === 'full' ? 'warn' : 'accent');
  await loadPlugins();
}

async function switchPluginPool(p, target) {
  const next = target === 'shared' ? 'shared' : 'dedicated';
  const r = await window.petApi.pluginSetPool(p.id, next);
  if (!r || !r.ok) {
    toast((r && r.error) || '切换进程模式失败', 'warn');
    return;
  }
  toast(
    `${p.name || p.id} 已切换到${next === 'shared' ? '共享模式' : '独立模式'}`,
    'accent',
  );
  await loadPlugins();
  void loadProcList();
}

async function reimportPlugin(p) {
  const r = await window.petApi.pluginReimport(p.id);
  if (r && r.canceled) return;
  if (!r || !r.ok) {
    toast((r && r.error) || '重新导入失败', 'warn');
    return;
  }
  toast(
    r.state === 'broken' ? `${p.name || p.id} 已覆盖代码，但仍是损坏状态` : `${p.name || p.id} 已更新代码（config.json 已保留）`,
    r.state === 'broken' ? 'warn' : 'accent',
  );
  (r.warnings || []).forEach((w) => consoleLog('警告', w));
  await loadPlugins();
  await loadToolsConfig();
}

async function uninstallPlugin(p) {
  if (!window.confirm(`卸载「${p.name || p.id}」？\n\n插件目录会移到插件目录下的 .trash，不会立即删除。`)) return;
  const r = await window.petApi.pluginUninstall(p.id);
  if (!r || !r.ok) {
    toast((r && r.error) || '卸载失败', 'warn');
    return;
  }
  toast(`${p.name || p.id} 已移入回收目录`, 'accent');
  pluginDrafts.delete(p.id);
  if (pluginState.detailId === p.id) pluginState.detailId = null;
  await loadPlugins();
  await loadToolsConfig();
}

// ---- 配置表单
function cloneJson(obj) {
  try {
    return JSON.parse(JSON.stringify(obj || {}));
  } catch (_) {
    return {};
  }
}

function applySchemaDefaults(schema, draft) {
  if (!schema || !Array.isArray(schema.fields)) return;
  schema.fields.forEach((f) => {
    if (!f || f.type === 'card' || !f.key) return;
    if (Object.prototype.hasOwnProperty.call(f, 'default') && draft[f.key] === undefined) {
      draft[f.key] = f.default;
    }
  });
}

function renderPluginConfigBody(p, draft, box) {
  box.innerHTML = '';

  if (p.staticSchema) {
    const title = document.createElement('div');
    title.className = 'plugin-config-title';
    title.textContent = p.staticSchema.title || '设置';
    box.appendChild(title);
    (p.staticSchema.fields || []).forEach((field) => {
      box.appendChild(pluginFieldNode(field, draft, draft));
    });
  }

  if (p.dynamicSchema) {
    box.appendChild(pluginDynamicSection(p, draft, box));
  }

  const bar = document.createElement('div');
  bar.className = 'plugin-config-bar';
  const save = document.createElement('button');
  save.className = 'btn-save';
  save.textContent = '保存';
  save.addEventListener('click', async () => {
    const r = await window.petApi.pluginWriteConfig(p.id, draft);
    if (!r || !r.ok) {
      toast((r && r.error) || '保存失败', 'warn');
      return;
    }
    toast('配置已保存', 'accent');
    consoleLog('系统', `插件 ${p.id} 的 config.json 已更新（rev ${r.rev}）`);
    await loadPlugins();
    await loadToolsConfig();
  });
  bar.appendChild(save);
  box.appendChild(bar);
}

function pluginFieldNode(field, data, draft) {
  if (field.type === 'card') {
    const note = document.createElement('div');
    note.className = 'plugin-note';
    if (field.label) {
      const b = document.createElement('b');
      b.textContent = field.label;
      note.appendChild(b);
    }
    if (field.text || field.description) {
      const span = document.createElement('span');
      span.textContent = field.text || field.description;
      note.appendChild(span);
    }
    return note;
  }

  const row = document.createElement('label');
  row.className = 'setting-row plugin-field';
  const info = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = field.label || field.key || '';
  info.appendChild(b);
  if (field.description) {
    const span = document.createElement('span');
    span.textContent = field.description;
    info.appendChild(span);
  }
  row.appendChild(info);

  const key = field.key;
  let control = null;
  let controlExtra = null;
  if (field.type === 'toggle') {
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = data[key] === true || (data[key] === undefined && field.default === true);
    control.addEventListener('change', () => {
      draft[key] = control.checked;
    });
  } else if (field.type === 'select') {
    control = document.createElement('select');
    // options 可以是静态数组，也可以从 config 里的某个数组取（例如音色清单）
    const source = Array.isArray(field.optionsFrom) ? null : data[field.optionsFrom];
    const options = Array.isArray(field.options) && field.options.length
      ? field.options
      : Array.isArray(source)
        ? source
        : [];
    options.forEach((opt) => {
      const value =
        typeof opt === 'string'
          ? opt
          : (opt && (opt.value != null ? opt.value : opt.id)) ?? opt;
      const label =
        typeof opt === 'string'
          ? opt
          : (opt && (opt.label || opt.name || opt.desc)) || value;
      const node = document.createElement('option');
      node.value = String(value == null ? '' : value);
      node.textContent = String(label == null ? value : label);
      control.appendChild(node);
    });
    control.value = String(data[key] == null ? field.default ?? '' : data[key]);
    control.addEventListener('change', () => {
      draft[key] = control.value;
    });
  } else if (field.type === 'range') {
    const min = Number.isFinite(Number(field.min)) ? Number(field.min) : 0;
    const max = Number.isFinite(Number(field.max)) ? Number(field.max) : 100;
    const step = Number(field.step) > 0 ? Number(field.step) : 1;
    const raw = data[key];
    const fallback = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : Number(field.default);
    const current = Number.isFinite(fallback) ? fallback : min;
    control = document.createElement('input');
    control.type = 'range';
    control.min = String(min);
    control.max = String(max);
    control.step = String(step);
    control.value = String(Math.min(max, Math.max(min, current)));
    controlExtra = document.createElement('b');
    const showValue = () => {
      const v = Number(control.value);
      controlExtra.textContent = field.unit ? `${v}${field.unit}` : String(v);
    };
    showValue();
    draft[key] = Number(control.value);
    control.addEventListener('input', () => {
      draft[key] = Number(control.value);
      showValue();
    });
  } else if (field.type === 'textarea') {
    control = document.createElement('textarea');
    control.className = 'plugin-textarea';
    control.rows = Number(field.rows) > 0 ? Number(field.rows) : 4;
    control.value = data[key] == null ? '' : String(data[key]);
    if (field.placeholder) control.placeholder = String(field.placeholder);
    control.addEventListener('input', () => {
      draft[key] = control.value;
    });
  } else if (field.type === 'number') {
    control = document.createElement('input');
    control.type = 'number';
    if (field.min != null) control.min = field.min;
    if (field.max != null) control.max = field.max;
    if (field.step != null) control.step = field.step;
    control.value = data[key] == null ? '' : String(data[key]);
    control.addEventListener('input', () => {
      if (control.value === '') draft[key] = null;
      else {
        const n = Number(control.value);
        draft[key] = Number.isFinite(n) ? n : field.default ?? null;
      }
    });
  } else if (field.type === 'secret') {
    control = document.createElement('input');
    control.type = 'password';
    control.autocomplete = 'off';
    control.spellcheck = false;
    control.value = data[key] == null ? '' : String(data[key]);
    if (field.placeholder) control.placeholder = String(field.placeholder);
    control.addEventListener('input', () => {
      draft[key] = control.value;
    });
  } else {
    control = document.createElement('input');
    control.type = 'text';
    control.spellcheck = false;
    control.value = data[key] == null ? '' : String(data[key]);
    if (field.placeholder) control.placeholder = String(field.placeholder);
    if (Number(field.maxLength) > 0) control.maxLength = Number(field.maxLength);
    control.addEventListener('input', () => {
      draft[key] = control.value;
    });
  }
  if (controlExtra) {
    const wrap = document.createElement('div');
    wrap.className = 'slider-wrap';
    wrap.append(control, controlExtra);
    row.appendChild(wrap);
  } else {
    row.appendChild(control);
  }
  return row;
}

function pluginDynamicSection(p, draft, box) {
  const schema = p.dynamicSchema || {};
  const key = typeof schema.key === 'string' && schema.key ? schema.key : 'items';
  if (!Array.isArray(draft[key])) draft[key] = [];
  const wrap = document.createElement('div');
  wrap.className = 'plugin-dynamic';

  const title = document.createElement('div');
  title.className = 'plugin-config-title';
  title.textContent = schema.title || '列表';
  wrap.appendChild(title);

  if (!draft[key].length) {
    const empty = document.createElement('div');
    empty.className = 'plugin-dynamic-empty';
    empty.textContent = '列表还是空的。新增条目由模型调用插件工具完成。';
    wrap.appendChild(empty);
  }

  draft[key].forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const row = document.createElement('div');
    row.className = 'plugin-dynamic-item';

    const head = document.createElement('div');
    head.className = 'plugin-dynamic-head';
    const primary = schema.primaryKey && item[schema.primaryKey] != null ? String(item[schema.primaryKey]) : `#${index + 1}`;
    const name = document.createElement('b');
    name.textContent = primary;
    head.appendChild(name);

    const del = document.createElement('button');
    del.className = 'link-btn danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      const removed = draft[key].splice(index, 1)[0];
      const ok = await persistPluginConfig(p.id, draft);
      if (!ok) {
        draft[key].splice(index, 0, removed);
        return;
      }
      renderPluginConfigBody(p, draft, box);
      undoToast(`已删除 ${primary}`, async () => {
        draft[key].splice(index, 0, removed);
        if (await persistPluginConfig(p.id, draft)) renderPluginConfigBody(p, draft, box);
      });
    });
    head.appendChild(del);
    row.appendChild(head);

    (schema.fields || []).forEach((field) => {
      row.appendChild(pluginFieldNode(field, item, item));
    });
    wrap.appendChild(row);
  });

  return wrap;
}

async function persistPluginConfig(id, draft) {
  const r = await window.petApi.pluginWriteConfig(id, draft);
  if (!r || !r.ok) {
    toast((r && r.error) || '保存失败', 'warn');
    return false;
  }
  return true;
}

function undoToast(message, onUndo) {
  const node = document.createElement('div');
  node.className = 'toast accent toast-with-action';
  const text = document.createElement('span');
  text.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'toast-undo';
  btn.textContent = '撤销';
  btn.addEventListener('click', () => {
    node.remove();
    onUndo();
  });
  node.appendChild(text);
  node.appendChild(btn);
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, 6000);
}

// ---- 插件页顶部按钮
const btnPluginImport = $('#btn-plugin-import');
if (btnPluginImport) {
  btnPluginImport.addEventListener('click', async () => {
    btnPluginImport.disabled = true;
    try {
      const r = await window.petApi.pluginImport();
      if (r && r.canceled) return;
      if (!r || !r.ok) {
        toast((r && r.error) || '导入失败', 'warn');
        consoleLog('警告', `插件导入失败：${(r && r.error) || '未知错误'}`);
        return;
      }
      (r.warnings || []).forEach((w) => consoleLog('警告', w));
      toast(
        r.state === 'broken' ? `插件 ${r.id} 已导入，但处于损坏状态：${r.reason || ''}` : `插件 ${r.id} 已导入`,
        r.state === 'broken' ? 'warn' : 'accent',
      );
      await loadPlugins();
      await loadToolsConfig();
    } finally {
      btnPluginImport.disabled = false;
    }
  });
}

// 右上角：刷新 +「添加插件」，低频操作收进下拉
const btnPluginMore = $('#btn-plugin-more');
const pluginMoreMenu = $('#plugin-more-menu');
if (btnPluginMore && pluginMoreMenu) {
  btnPluginMore.addEventListener('click', (e) => {
    e.stopPropagation();
    pluginMoreMenu.hidden = !pluginMoreMenu.hidden;
    if (!pluginMoreMenu.hidden) {
      setTimeout(() => document.addEventListener('click', () => (pluginMoreMenu.hidden = true), { once: true }), 0);
    }
  });
}

const btnPluginRefresh = $('#btn-plugin-refresh');
if (btnPluginRefresh) {
  btnPluginRefresh.addEventListener('click', async () => {
    btnPluginRefresh.classList.add('is-busy');
    // 刷新 = 给损坏插件一次重来的机会：先清掉损坏标记并置为关闭，再由用户手动打开开关
    let reset = [];
    try {
      const r = window.petApi && window.petApi.pluginResetBroken ? await window.petApi.pluginResetBroken() : null;
      if (r && r.ok && Array.isArray(r.reset)) reset = r.reset;
    } catch (err) {
      console.warn('[shell] reset broken plugins failed', err);
    }
    await loadPlugins();
    await loadToolsConfig();
    if (reset.length) {
      toast(`已清除 ${reset.length} 个插件的损坏标记，开关已关闭，请手动重新打开`, 'warn');
      consoleLog('插件', `刷新后重置：${reset.map((x) => x.id).join('、')}（已置为关闭）`);
    }
    setTimeout(() => btnPluginRefresh.classList.remove('is-busy'), 250);
  });
}

// ------------------------------------------------------------------ 插件主动事件
// 插件跑在独立进程里，只能通过主进程转发事件：
//   task_due      定时任务到点 → 把内容当成一条用户消息送进会话，自动触发模型
//   config-changed 插件自己写了 config（例如模型添加任务）→ 静默刷新界面
//   crashed / timeout 进程异常 → 控制台警告 + 列表灰显
const pluginChatQueue = [];
let pluginChatFlushing = false;

function pluginEventText(payload) {
  const data = payload && payload.data;
  if (!data || typeof data !== 'object') return '';
  const title = String(data.title || '').trim() || '定时任务';
  const content = String(data.content || '').trim();
  return `【定时任务】${title}${content ? `：${content}` : ''}`;
}

function queuePluginChat(text) {
  const t = String(text || '').trim();
  if (!t) return;
  pluginChatQueue.push(t);
  flushPluginChatQueue();
}

// 对话正忙时排队；一轮结束后由 runAgent 的 finally 触发队列
async function flushPluginChatQueue() {
  if (pluginChatFlushing) return;
  if (!pluginChatQueue.length || chatBusy || autoCompressRunning) return;
  pluginChatFlushing = true;
  try {
    while (pluginChatQueue.length && !chatBusy && !autoCompressRunning) {
      const text = pluginChatQueue.shift();
      consoleLog('事件', `插件把消息送进对话：${text}`);
      await sendMessage(text);
    }
  } finally {
    pluginChatFlushing = false;
  }
}

async function refreshPluginViews(pluginId) {
  const detailId = pluginState.detailId;
  await loadPlugins();
  if (detailId && pluginState.detailId === detailId && detailId === pluginId) {
    const p = pluginState.plugins.find((x) => x.id === detailId);
    if (p) await loadPluginDetailConfig(p);
  }
}

// 插件往动作队列加动作（ctx.emit('action', {...})）：
//   { op: 'append' | 'prepend', actions: [{ action, seconds }] }，也接受单个 { action, seconds }
// 队列是壳层的策略，插件只投递意图；画面关闭 / 内核没挂载时直接忽略并提示。
function applyPluginAction(payload) {
  const data = payload && payload.data;
  const who = (payload && payload.pluginName) || (payload && payload.pluginId) || '插件';
  if (!data || typeof data !== 'object') {
    consoleLog('警告', `插件「${who}」的动作事件缺少数据`);
    return;
  }
  if (visualOffActive() || !queue) {
    consoleLog('警告', `插件「${who}」想加动作，但画面已关闭或内核未就绪，已忽略`);
    return;
  }
  const list = Array.isArray(data.actions) ? data.actions : [data];
  const front = data.op === 'prepend' || data.front === true;
  const added = [];
  const skipped = [];
  for (const item of list) {
    const action = typeof item === 'string' ? item : item && (item.action || item.name);
    if (!action) {
      skipped.push('缺少动作名');
      continue;
    }
    // 动作清单来自内核 clips 目录：不存在的名字不往队列里塞，避免泵到一半空转
    if (!actions.some((a) => (a.name || a.file) === action)) {
      skipped.push(action);
      continue;
    }
    const seconds = Number(item && typeof item === 'object' ? item.seconds : undefined);
    const meta = { source: 'plugin', pluginId: payload.pluginId };
    if (Number.isFinite(seconds) && seconds > 0) meta.seconds = seconds;
    if (front) queue.prepend(action, meta);
    else queue.append(action, meta);
    added.push(`${action}${meta.seconds ? `（限时 ${meta.seconds}s）` : ''}`);
  }
  if (added.length) {
    consoleLog('插件', `${who} 已加入${front ? '队首' : '队尾'}：${added.join('、')}`);
  }
  if (skipped.length) {
    consoleLog('警告', `插件「${who}」跳过了无效动作：${skipped.join('、')}`);
  }
}

async function handlePluginEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  const type = String(payload.type || '');
  // 插件启停 / 崩溃 / 运行时变化都可能改变语音接管关系
  void refreshTtsEngineStatus();
  // 进程管理器的实时信号：状态变了整表刷新，内存单点更新，日志只追加
  if (type === 'proc-changed') {
    procScheduleRefresh();
    return;
  }
  if (type === 'proc-stats') {
    updateProcStats(payload);
    return;
  }
  if (type === 'proc-log') {
    appendProcLog(payload);
    return;
  }
  if (type === 'config-changed') {
    await refreshPluginViews(payload.pluginId);
    return;
  }
  if (type === 'crashed') {
    toast(`插件「${payload.pluginId}」进程异常退出，已自动禁用`, 'warn');
    consoleLog('警告', `插件「${payload.pluginId}」已禁用：${payload.reason || '进程异常退出'}`);
    await loadPlugins();
    procScheduleRefresh();
    return;
  }
  if (type === 'timeout') {
    consoleLog('警告', `插件「${payload.pluginId}」工具 ${payload.tool} 响应超时`);
    return;
  }
  if (type === 'plugin-event' && payload.event === 'action') {
    applyPluginAction(payload);
    return;
  }
  if (type === 'plugin-event' && payload.event === 'task_due') {
    queuePluginChat(pluginEventText(payload));
    return;
  }
  // 插件直接投递一段原文进对话（例如待机唤醒）。以 [系统信息] 开头的消息只进控制台，
  // 主界面聊天框不显示用户侧内容，模型的回复照常显示。
  if (type === 'plugin-event' && payload.event === 'system_message') {
    const text = String((payload.data && payload.data.text) || '').trim();
    if (!text) return;
    const who = payload.pluginName || payload.pluginId || '插件';
    consoleLog('事件', `${who} 注入消息：${text.slice(0, 120)}`);
    queuePluginChat(text);
  }
}

if (window.petApi && window.petApi.onPluginEvent) {
  window.petApi.onPluginEvent((payload) => {
    void handlePluginEvent(payload);
  });
}

const btnPluginRoot = $('#btn-plugin-root');
if (btnPluginRoot) {
  btnPluginRoot.addEventListener('click', async () => {
    const r = await window.petApi.pluginChooseRoot();
    if (r && r.canceled) return;
    if (!r || !r.ok) {
      toast((r && r.error) || '切换目录失败', 'warn');
      return;
    }
    toast(`插件目录已切换：${r.root}`, 'accent');
    await loadPlugins();
    await loadToolsConfig();
  });
}

const btnPluginOpenRoot = $('#btn-plugin-open-root');
if (btnPluginOpenRoot) {
  btnPluginOpenRoot.addEventListener('click', () => {
    if (pluginState.root) window.petApi.pluginOpenDir('');
  });
}

if (el.pluginBack) {
  el.pluginBack.addEventListener('click', () => {
    pluginState.detailId = null;
    renderPlugins();
  });
}

const btnPluginClearTrash = $('#btn-plugin-clear-trash');
if (btnPluginClearTrash) {
  btnPluginClearTrash.addEventListener('click', async () => {
    if (!window.confirm('清空回收目录？\n\n卸载的插件会被永久删除，无法恢复。')) return;
    const r = await window.petApi.pluginClearTrash();
    if (!r || !r.ok) {
      toast((r && r.error) || '清空失败', 'warn');
      return;
    }
    toast(`回收目录已清空（${r.removed || 0} 项）`, 'accent');
  });
}

// 当前时间戳：只贴在本轮「最新一条用户消息」前面，写进请求体但不落盘、界面不显示。
// 放 system 里会每轮变化，靠前缀复用（KV Cache）的请求每次都整段失效；
// 用户消息本来就是新内容、不在缓存前缀里，贴在这里最省。
function timeStampForPrompt(d = new Date()) {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${week} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// 「设置 → 预设 → 提示词附带当前时间」：默认开，用户可关；说明文本由 preset-time.md 提供
function promptTimeOn() {
  return store.get('agentpet.promptTime', true) !== false;
}

// 「设置 → 预设 → 发送强调提示词」：默认关，开启后才在当轮用户消息末尾贴 EMPHASIZE
function promptEmphasizeOn() {
  return store.get('agentpet.promptEmphasize', false) === true;
}

// 注入前统一替换 {{char}} 占位符；角色名来自当前角色定义
function charTemplate(text) {
  if (!text) return '';
  const name = (activeCharacter && activeCharacter.name) || '';
  return String(text).replace(/\{\{char\}\}/g, name);
}

// 每轮一行的状态注入：文案在 preset-emotion.md（{state} 由引擎现算），
// 只贴在请求体里最新一条用户消息的时间戳后面，不写进聊天记录，所以永远不会过期。
function emotionStateBlock() {
  if (settings.injectEmotionState === false) return '';
  if (!emotionActive() || !emotionRuntime.state) return '';
  const tpl = String(emotionStateTemplateMd || '').trim();
  if (!tpl) return '';
  const tag = E.stateTag(emotionRuntime.state, new Date(), emotionRhythm(), settings.stateTiers);
  return E.fillTemplate(tpl, { state: tag }).trim();
}

// 对话用的系统提示：人设 + 说话格式（来自 preset-speak.md） + 摘要 + 长程记忆 + 状态 + ACTIONS + 真工具
function buildChatMessages() {
  // play_action 被关掉（或内核停转）时连 ACTIONS 清单也一起收起：
  // 模型没有可用的动作工具，不该再看到一堆动作名。
  const playToolOn = isToolEnabled('play_action') && !kernelToolGated('play_action');
  const actionsBlock = playToolOn
    ? actionsPromptBlock(presetActionsMd || el.presetActions.value || buildActionsMd())
    : '';
  const summary = String(store.get('agentpet.compressSummary', '') || '');
  // 时间开关关掉时，连那句「怎么读时间戳」的说明也一起拿掉，保持提示词干净
  const withTime = promptTimeOn();
  // 状态行不进 system：放进 system 会每轮变化，把靠前缀复用的 KV Cache 整段作废，
  // 改成跟时间戳一起贴在最新一条用户消息前面（见下方），既省缓存也读着自然
  const stateLine = emotionStateBlock();
  const system = [
    charTemplate(getPersonaText()),
    withTime ? charTemplate(timeNoteMd) : '',
    charTemplate(speakFormatMd),
    summary ? `早前对话摘要：\n${summary}` : '',
    longMemoryContext.block,
    charTemplate(actionsBlock),
    toolsPromptBlock(),
  ]
    .filter(Boolean)
    .join('\n\n');
  // historyWindow 的语义是「最近 N 轮对话」；100 = MAX，发送压缩点之后全部
  const history = buildApiHistory(settings.historyWindow);
  // 时钟与状态只贴在最新一条用户消息上（buildApiHistory 返回的是新对象，改不到 si.chat）。
  // 格式：[2026-11-15 周六 14:30] (状态：清醒) 正文
  const head = [withTime ? `[${timeStampForPrompt()}]` : '', stateLine].filter(Boolean).join(' ');
  // 强调提示词（紧箍咒）贴在用户这句话的末尾：开关打开才注入，只进请求体，不落库、不进之后的上下文
  const emphasize = promptEmphasizeOn() ? charTemplate(emphasizeMd).trim() : '';
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user' && typeof history[i].content === 'string') {
      lastUser = i;
      break;
    }
  }
  if (lastUser >= 0) {
    const body = history[lastUser].content;
    history[lastUser].content = [head ? `${head} ${body}` : body, emphasize].filter(Boolean).join('\n\n');
  }
  // 兜底：万一窗口里没有用户消息（不该发生），状态与强调不能被吞掉，退回 system
  if (lastUser < 0 && (head || emphasize)) {
    return [{ role: 'system', content: [system, head, emphasize].filter(Boolean).join('\n\n') }, ...history];
  }
  return [{ role: 'system', content: system }, ...history];
}

// 通知正文：去掉代码块、链接、markdown 符号和伪工具标记，只留纯文本开头
function plainForNotify(text) {
  const raw = String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[#*`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
}

// 一轮回复结束时调用：窗口不在前台时弹系统通知 + 闪任务栏（是否弹由主进程判断）
function notifyReplyDone(since) {
  if (settings.notifyBackground === false) return;
  // 只认本轮新建的 AI 消息，避免本轮没有正文时把上一轮的内容再弹一次
  const last = [...chatState.messages].reverse().find((m) => m.role === 'ai' && m.text && (!since || (m.ts || 0) >= since));
  if (!last) return;
  const body = plainForNotify(last.text);
  if (!body) return;
  try {
    if (window.petApi && window.petApi.notifyReply) {
      void window.petApi.notifyReply({ title: charNameText() || '新消息', body });
    }
  } catch (err) {
    console.warn('[shell] notify reply failed', err);
  }
}

// 统一 agent：聊天和控制台共用同一份历史、同一个流式循环
// 工具轮次上限来自设置，每次组装请求时重新读取（改滑块后下一轮立即生效）
async function runAgent() {
  const session = ++chatSession;
  const turnBeginTs = Date.now();
  // 思考强度按「轮」快照：同一轮的每个工具轮次和重试都发同样的字段，前缀稳定
  const effortBody = thinkRequestBody();
  chatBusy = true;
  consoleState.busy = true;
  consoleState.cancelled = false;
  consoleState.rounds = 0;
  consoleState.phase = 'think';
  consoleState.startedAt = Date.now();
  setChatSending(true);
  syncConsoleSendButton();
  chatCancel = { cancelled: false, abort: null };
  // 真正组装请求：记忆检索已在 sendMessage 里完成（异步，避免阻塞渲染）
  // 发送前统一把图片路径换成别名，模型全程看不到物理路径
  const apiMessages = await aliasizeMessages(buildChatMessages());
  const persist = () => saveChatSession();
  let turnCompleted = false;
  // Step 4：本轮所有工具轮次里出现的 MEM_MARK 编号，轮次结束统一结算
  const turnMarks = [];

  // 新一轮用户输入开始，熔断计数重新累计，避免跨轮误杀
  resetToolCircuit();

  try {
    for (let round = 0; ; round++) {
      if (session !== chatSession || !chatCancel) return;
      const maxRounds = Math.max(3, Math.min(20, Math.round(Number(settings.toolRounds) || 8)));
      if (round >= maxRounds) {
        // 强制中断：工具轮次已经用完，不再向模型发起请求
        const limitText = `已达到单次对话最大工具调用轮次（${maxRounds}），已强制中断。请检查模型是否陷入重复调用，或调高「Agent 运行」里的上限。`;
        chatState.messages.push({
          role: 'sys',
          text: `⚠️ ${limitText}`,
          at: stamp(),
          ts: Date.now(),
          seq: nextSeq(),
        });
        persist();
        renderChat();
        scheduleConsoleRender();
        consoleLog('警告', limitText);
        toast(`已达工具轮次上限 ${maxRounds}，已强制中断`, 'warn');
        break;
      }
      consoleState.rounds += 1;
      const msg = {
        role: 'ai',
        text: '',
        think: '',
        streaming: true,
        phase: 'think',
        at: stamp(),
        ts: Date.now(),
        seq: nextSeq(),
        toolCalls: [],
      };
      chatState.messages.push(msg);
      scheduleConsoleRender();

      // 伪工具统一入口：SPEAK 的台词留下来，MEM_MARK 整段剥掉只留编号
      let fedChars = 0;
      const pseudo = createPseudoToolParser({
        onText: (chunk) => {
          msg.text += chunk;
        },
        onMemMark: (wrong) => {
          if (!wrong.length) return;
          msg.memMarks = [...(msg.memMarks || []), ...wrong];
          for (const id of wrong) {
            if (!turnMarks.includes(id)) turnMarks.push(id);
          }
        },
      });

      let acc;
      const callStarted = Date.now();
      let firstAt = 0;
      // 浅拷贝即可：后续只往 apiMessages push 新对象，不会改动已经发出去的内容
      lastRequestMessages = apiMessages.slice();
      lastRequestStartSeq = requestStartSeq();
      try {
        acc = await callLLM(apiMessages, {
          tools: activeLLMTools(),
          cancel: chatCancel,
          extraBody: effortBody,
          onDelta: (evt) => {
            if (session !== chatSession) return;
            if (!firstAt && (evt.type === 'reasoning' || evt.type === 'content' || evt.type === 'tool_call')) {
              firstAt = Date.now();
            }
            if (evt.type === 'reasoning') {
              msg.think += evt.text;
              msg.phase = 'think';
              consoleState.phase = 'think';
            } else if (evt.type === 'content') {
              fedChars += String(evt.text || '').length;
              pseudo.feed(evt.text);
              msg.phase = 'content';
              consoleState.phase = 'content';
            }
            scheduleChatRender();
            scheduleConsoleRender();
          },
        });
      } catch (err) {
        msg.streaming = false;
        msg.phase = '';
        msg.thinkOpen = false;
        msg.text = msg.text || `（连接失败：${err && err.message ? err.message : err}）`;
        consoleLog('错误', `对话失败：${err && err.message ? err.message : err}`);
        persist();
        renderChat();
        renderConsole();
        return;
      }
      if (session !== chatSession) return; // 已被终止，别再往后写
      turnCompleted = true;
      msg.streaming = false;
      msg.phase = '';
      msg.thinkOpen = false;
      msg.think = acc.reasoning || msg.think;
      // 兜底：有些 mock / 非流式实现只在最终结果里给 content
      if (acc.content && acc.content.length > fedChars) pseudo.feed(acc.content.slice(fedChars));
      const parsed = pseudo.flush();
      // 裁掉标记前后的换行 / 空白：否则 pre-wrap 会把它们渲染成一屏空行
      msg.text = tidyChatText(parsed.text);
      msg.speakText = tidyChatText(parsed.speech);
      if (msg.memMarks && msg.memMarks.length) {
        consoleLog('记忆', `收到 MEM_MARK：wrong=${msg.memMarks.join(',')}（本轮结束时结算）`);
      }
      recordUsage(acc, {
        messages: apiMessages,
        ms: Date.now() - callStarted,
        ttftMs: firstAt ? firstAt - callStarted : 0,
      });
      persist();
      scheduleChatRender();
      scheduleConsoleRender();

      const calls = (acc.toolCalls || [])
        .filter((c) => c && c.name)
        .map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));

      if (!calls.length) {
        if (!msg.text && !msg.think) {
          chatState.messages.pop();
          persist();
          renderChat();
          scheduleConsoleRender();
        } else if (msg.text) {
          pushShellChat(msg.text, msg.seq);
          autoReadReply(speakSourceOf(msg), { raw: msg.text, speak: msg.speakText });
          // 情绪只看她自述的 MOOD，且这条标记不进上下文、用完即丢
          const moods = (parsed && parsed.moods) || [];
          void emotionFromMood(moods.length ? moods[moods.length - 1] : '', msg.text, msg);
        }
        return;
      }

      // 纯工具轮次：聊天只看自然语言，这条（只有思考/工具）只进控制台
      if (!msg.text) msg.toolOnly = true;

      apiMessages.push({
        role: 'assistant',
        content: acc.content || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      });
      for (const call of calls) {
        if (session !== chatSession) return;
        const pending = beginToolRun(msg, call);
        let res = toolResult('Error: 工具执行中断', 'error');
        try {
          res = await dispatchTool(call, msg);
        } catch (err) {
          // 工具异常也要回一条 tool 消息，否则这条 tool_call 在历史里没人应答
          res = toolResult(`Error: ${err && err.message ? err.message : err}`, 'error');
        } finally {
          endToolRun(msg, pending, res);
        }
        // 插件工具可能返回裸路径（如 latest_frame），这里统一换成别名再交给模型
        const toolContent = await aliasizeForModel(res.content, { bare: true });
        apiMessages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
        // read_image 的图片本体：tool 角色只能带纯文本，所以紧跟一条多模态 user 消息。
        // 模型不支持视觉时 callLLM 会在 400/422 上自动剥掉图片重发（见 callLLM）。
        if (res && res.imageDataUrl) {
          const meta = (res.extra && res.extra.image) || {};
          const note = await aliasizeForModel(`[图片] ${meta.name || ''} ${meta.path || ''}`.trim(), {
            bare: true,
            onlyPaths: sessionImagePaths(),
          });
          apiMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: note },
              { type: 'image_url', image_url: { url: res.imageDataUrl } },
            ],
          });
        }
      }
      persist();
      scheduleConsoleRender();
    }
  } finally {
    if (session === chatSession) {
      chatBusy = false;
      chatCancel = null;
      consoleState.busy = false;
      consoleState.phase = '';
      consoleState.cancelled = false;
      setChatSending(false);
      syncConsoleSendButton();
      persist();
      renderChat();
      renderConsole();
      // 这轮真实对话结束：累加记忆提取计数，到阈值就在后台静默提取
      if (turnCompleted) {
        noteMemoryTurn();
        // Step 4：轮次结束钩子（不阻塞 UI）
        void settleLongMemory(turnMarks);
        // 后台回复通知：窗口不在前台时提醒（最小化 / 托盘 / 切到别的程序）
        notifyReplyDone(turnBeginTs);
      }
      // 本轮期间到点的插件事件（定时任务）排队等着，现在继续送进对话
      if (pluginChatQueue.length) setTimeout(() => void flushPluginChatQueue(), 0);
    }
  }
}

// 终止请求：保留已经流出的内容，截断后续 SSE
function cancelChat() {
  if (!chatBusy) return;
  chatSession += 1;
  if (chatCancel) {
    chatCancel.cancelled = true;
    if (chatCancel.abort) chatCancel.abort();
  }
  chatCancel = null;
  chatBusy = false;
  consoleState.busy = false;
  consoleState.phase = '';
  consoleState.cancelled = true;
  syncConsoleSendButton();

  const kept = [];
  chatState.messages.forEach((m) => {
    if (m.role === 'ai' && m.streaming) {
      m.streaming = false;
      m.phase = '';
      m.thinkOpen = false;
      // 没吐出任何内容、也没有工具记录的空气泡直接丢掉
      if (!m.text && !m.think && !(m.toolOnly && m.toolCalls && m.toolCalls.length)) return;
      if (m.text || m.think) m.stopped = true;
      // 停止生成也把已经流出的文字同步给手机端，避免两边内容不一致
      if (m.text) pushShellChat(m.text, m.seq);
    }
    kept.push(m);
  });
  chatState.messages = kept;

  saveChatSession();
  setChatSending(false);
  renderChat();
  renderConsole();
  consoleLog('系统', '已停止生成');
  toast('已停止生成');
}

// 清空上下文：先把当前会话归档，再清空；人设 / 预设 / 笔记都保留
function clearChatContext() {
  const archived = archiveCurrentChat();
  // 中断进行中的回复，避免旧流把内容又写回来
  chatSession += 1;
  if (chatCancel && chatCancel.abort) chatCancel.abort();
  chatCancel = null;
  chatBusy = false;
  consoleState.busy = false;
  consoleState.phase = '';
  consoleState.cancelled = true;
  syncConsoleSendButton();
  setChatSending(false);
  chatState.messages = [];
  chatState.cleared = true;
  clearCompactLog();
  currentTurnSeq = 0;
  store.set('agentpet.compressSummary', '');
  store.set('agentpet.compressCutoff', 0);
  store.set('agentpet.compressCutoffSeq', 0);
  // 会话清空后 seq 会重新从 1 开始，记忆提取游标也一起归零
  store.set('agentpet.memoryExtractSeq', 0);
  // 压缩状态清零之后再落盘，避免把旧的摘要写进空会话
  saveChatSession();
  memoryRead.clear();
  // 旧请求前缀已经没有意义，下一次压缩重新整段请求
  lastRequestMessages = null;
  lastRequestStartSeq = 0;
  // 长期记忆注入结果也跟着清空
  longMemoryContext = { block: '', items: [], query: '', at: 0 };
  resetSessionStats();
  renderChat();
  renderConsole();
  toast(archived ? '上下文已清空，会话已归档' : '上下文已清空', 'accent');
  consoleLog('系统', archived ? '对话上下文已清空，旧会话已存入「设置 → 归档」' : '对话上下文已清空（预设与笔记保留）');
}

function mockIntent(text) {
  if (/坐下|坐一?会儿|休息一下/.test(text)) {
    return {
      think: '用户说要坐下。大姿态必须走 start → loop 三段式，不能直接 play(loop)。',
      text: '好，我坐一会儿。想让我起来就说「起身」。',
      actions: ['interact_sit_start', 'interact_sit_loop'],
    };
  }
  if (/起身|站起|站起来|别坐了/.test(text)) {
    return {
      think: '她在坐着。用 interact_sit_end 强插，播完自动回待机。',
      text: '好，我起来了。',
      interrupt: 'interact_sit_end',
    };
  }
  if (/放松|休息|歇着/.test(text)) {
    return {
      think: '放松是 idle_to_relax → relax_loop 的链式状态。',
      text: '那我就放松一下肩。',
      actions: ['idle_to_relax', 'relax_loop'],
    };
  }
  if (/你好|嗨|早上好|晚上好|再见|拜拜/.test(text)) {
    return {
      think: '打招呼用 dialog_single_wave；它在内核里已被降级成单次，不会卡住队列。',
      text: '你好。今天也请多指教。',
      actions: ['dialog_single_wave'],
    };
  }
  if (/不|没有|不行|拒绝/.test(text)) {
    return { think: '否定用摇头，最轻的反馈。', text: '嗯，我明白。', actions: ['dialog_virtual_single_idle_shake'] };
  }
  return {
    think: '没有明确的动作意图。先用点头回应，保持轻量。',
    text: '收到。',
    actions: ['dialog_virtual_single_idle_nod'],
  };
}

// 统一发送入口：聊天和控制台写入同一份会话
async function sendMessage(text, refs) {
  markUserActivity('chat'); // 发消息也算「用户在操作」，待机判定要重新计时
  // [系统信息] 是插件 / 主动消息写的，不是用户发言：情感那边不能刷新 lastUserAt
  const systemEvent = /^\[系统信息\]/.test(String(text || '').trim());
  // 本会话出现过的图片路径：图片读取权限关闭时，read_image 只放行这些
  for (const hit of String(text || '').matchAll(IMAGE_PATH_REGEX)) addAllowedImagePath(hit[0].trim());
  mentionImagesAt = 0; // 新图片已入会话：让 @ 面板下次重新拉取最近图片
  const cfg = getApiConfig();
  const online = !!cfg.key && !cfg.builtin && cfg.id !== 'mock';

  // 自动压缩必须在新消息入历史之前做：否则本轮输入会被压进摘要、发不出去
  if (online) await maybeAutoCompress();

  // 有引用标签时把它挂在这条用户消息上，请求组装时再展开全文
  const userMsg = pushChat(refs && refs.length ? { role: 'user', text, refs } : { role: 'user', text });
  currentTurnSeq = userMsg.seq;

  if (online) {
    // Step 3：先检索长期记忆（异步），再组装本轮请求
    await refreshLongMemory(text);
    // 情感：推进衰减 + 结算「被忽略」（开关关闭时立即返回）
    await emotionForTurn({ systemEvent });
    await runAgent();
    return;
  }

  // Mock：本地规则解释器（不联网），动作同样以工具记录进入控制台
  setTimeout(() => {
    const reply = mockIntent(text);
    const msg = pushChat({ role: 'ai', think: reply.think, text: reply.text, thinkOpen: false });
    pushShellChat(reply.text, msg.seq);
    const actions = reply.interrupt ? [reply.interrupt] : reply.actions || [];
    if (reply.interrupt) {
      queue.interrupt(reply.interrupt);
      recordTool(msg, {
        name: 'play_action',
        args: JSON.stringify({ action: reply.interrupt, front: true }),
        result: `打断并播放：${reply.interrupt}`,
      });
    } else if (actions.length) {
      actions.forEach((name) => queue.append(name, { source: 'llm' }));
      recordTool(msg, {
        name: 'play_action',
        args: JSON.stringify({ actions: actions.map((name) => ({ action: name })) }),
        result: `已加入动作队列：${actions.join('、')}`,
      });
    }
    if (actions.length) saveChatSession();
  }, 700);
}

// ------------------------------------------------------------------ 输入框图片路径标签
// 拖入 / 粘贴 / 输入图片绝对路径后，输入框里显示成「图标 + 文件名」的行内标签；
// 发送时只序列化成绝对路径文本，图片本身由 read_image 工具按需读取。

const IMAGE_PATH_REGEX =
  /(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/])[^\r\n<>"|?*]*?\.(?:png|jpe?g|webp|gif|bmp)/gi;
const IMAGE_NAME_REGEX = /\.(png|jpe?g|webp|gif|bmp)$/i;

const IMAGE_CHIP_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/>' +
  '<circle cx="5.4" cy="6.4" r="1.1"/>' +
  '<path d="M2.6 11.6l3.1-2.9 2.2 2 2.3-2.2 3.2 3.1"/>' +
  '</svg>';

// 图片允许清单：权限关闭时，只放行本会话里拖入 / 输入过的图片
// key（归一化）→ 原始路径，原始路径还要交给主进程做别名替换
const allowedImagePaths = new Map();
function imagePathKey(p) {
  return String(p || '').replace(/\\/g, '/').trim().toLowerCase();
}
function addAllowedImagePath(p) {
  const key = imagePathKey(p);
  if (key) allowedImagePaths.set(key, String(p).trim());
}
function historyImageKeys() {
  const keys = new Set();
  chatState.messages.forEach((m) => {
    if (!m || m.role !== 'user') return;
    const text = String(m.text || '');
    for (const hit of text.matchAll(IMAGE_PATH_REGEX)) keys.add(imagePathKey(hit[0]));
  });
  return keys;
}

// 图片读取鉴权：权限开启 → 任意存在的图片；关闭 → 只认本会话里出现过的路径
function imagePathAllowed(filePath) {
  if (settings.imageReadPerm === true) return true;
  const key = imagePathKey(filePath);
  if (!key) return false;
  if (allowedImagePaths.has(key)) return true;
  return historyImageKeys().has(key);
}

// 本会话出现过的图片原始路径：只有这些裸路径才允许被换成别名，避免误伤代码里的路径
function sessionImagePaths() {
  const out = new Set(allowedImagePaths.values());
  chatState.messages.forEach((m) => {
    if (!m || m.role !== 'user') return;
    for (const hit of String(m.text || '').matchAll(IMAGE_PATH_REGEX)) out.add(hit[0].trim());
  });
  return [...out];
}

// 模型侧文本别名化：物理路径只留在主进程，模型只看 [image_N]
async function aliasizeForModel(text, options) {
  if (typeof text !== 'string' || !text) return text;
  if (!window.petApi || !window.petApi.imageAliasText) return text;
  try {
    const r = await window.petApi.imageAliasText(text, options);
    return r && r.ok ? r.text : text;
  } catch (_) {
    return text;
  }
}

// 组装好的请求逐条别名化：用户消息只换本会话出现过的图片路径；
// 工具 / 助手历史允许裸路径（插件工具本来就返回裸路径）
async function aliasizeMessages(messages) {
  const onlyPaths = sessionImagePaths();
  for (const m of messages) {
    if (!m || m.role === 'system' || typeof m.content !== 'string' || !m.content) continue;
    // 用户消息只替换本会话出现过的路径，但本条消息自己带进来的图片必须算数：
    // 新贴的图在 chatState 里可能还没落定，漏掉就会把裸路径直接发给模型
    let own = onlyPaths;
    if (m.role === 'user') {
      own = [...onlyPaths];
      for (const hit of m.content.matchAll(IMAGE_PATH_REGEX)) {
        const p = hit[0].trim();
        if (!onlyPaths.includes(p)) own.push(p);
      }
    }
    m.content = await aliasizeForModel(m.content, m.role === 'user' ? { bare: true, onlyPaths: own } : { bare: true });
  }
  return messages;
}

// contenteditable → 纯文本：标签节点输出它保存的绝对路径，<br>/<div> 补换行
function composerText(editor) {
  if (!editor) return '';
  let out = '';
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.nodeValue || '';
        return;
      }
      if (child.nodeType !== 1) return;
      if (child.classList && child.classList.contains('img-path-chip')) {
        out += String(child.dataset.path || child.textContent || '');
        return;
      }
      if (child.classList && child.classList.contains('ref-chip')) {
        // 引用标签序列化成文字标记：不带「@」，否则会把自己再次触发成引用面板
        out += refMark(child.dataset.refKind, refChipName(child));
        return;
      }
      if (child.tagName === 'BR') {
        out += '\n';
        return;
      }
      const block = child.tagName === 'DIV' || child.tagName === 'P';
      if (block && out && !out.endsWith('\n')) out += '\n';
      walk(child);
    });
  };
  walk(editor);
  return out.replace(/\u200b/g, '');
}

function setComposerText(editor, text) {
  if (!editor) return;
  editor.innerHTML = '';
  const lines = String(text == null ? '' : text).split('\n');
  lines.forEach((line, i) => {
    if (i) editor.appendChild(document.createElement('br'));
    if (line) editor.appendChild(document.createTextNode(line));
  });
}

function clearComposer(editor) {
  if (editor) editor.innerHTML = '';
}

function focusComposerEnd(editor) {
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  editor.scrollTop = editor.scrollHeight;
}

function makeImageChip(filePath, name) {
  const chip = document.createElement('span');
  chip.className = 'img-path-chip';
  chip.contentEditable = 'false';
  chip.dataset.path = filePath;
  chip.title = filePath;
  chip.innerHTML = `${IMAGE_CHIP_SVG}<span class="img-path-chip-name"></span>`;
  chip.querySelector('.img-path-chip-name').textContent = name || baseName(filePath);
  return chip;
}

// 入参既支持纯路径字符串，也支持 { path, name }，统一成 { path, name }
function normalizeChipEntries(paths) {
  return (paths || [])
    .map((item) => {
      if (typeof item === 'string') return { path: item, name: '' };
      if (!item || typeof item !== 'object') return null;
      const p = typeof item.path === 'string' ? item.path : '';
      if (!p) return null;
      return { path: p, name: typeof item.name === 'string' ? item.name : '' };
    })
    .filter(Boolean);
}

function insertImageChips(editor, paths) {
  const entries = normalizeChipEntries(paths);
  if (!editor || !entries.length) return;
  const frag = document.createDocumentFragment();
  entries.forEach((entry, i) => {
    if (i) frag.appendChild(document.createTextNode(' '));
    frag.appendChild(makeImageChip(entry.path, entry.name));
  });
  frag.appendChild(document.createTextNode(' '));
  // 有光标就插在光标处，否则追加到末尾
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(frag);
  } else {
    editor.appendChild(frag);
  }
  focusComposerEnd(editor);
  entries.forEach((entry) => addAllowedImagePath(entry.path));
}

// 拖入 / 粘贴的 File → 绝对路径；剪贴板截图没有路径就先落盘
async function resolveImageFile(file) {
  if (!file || !window.petApi) return '';
  let p = '';
  try {
    p = window.petApi.filePath ? window.petApi.filePath(file) : '';
  } catch (_) {
    p = '';
  }
  if (p) return p;
  try {
    const data = await file.arrayBuffer();
    const saved = await window.petApi.imageSaveTemp({ name: file.name || 'pasted.png', data });
    return saved && saved.ok ? saved.path : '';
  } catch (_) {
    return '';
  }
}

async function acceptImageFiles(editor, files) {
  const ready = [];
  for (const file of files) {
    if (!file || !IMAGE_NAME_REGEX.test(file.name || '')) continue;
    const p = await resolveImageFile(file);
    if (!p) continue;
    const probe = await window.petApi.imageProbe(p);
    if (!probe || !probe.ok) {
      toast(`图片不可用：${probe && probe.error ? probe.error : file.name}`, 'warn');
      continue;
    }
    ready.push({ path: probe.path || p, name: probe.name });
  }
  if (!ready.length) return;
  insertImageChips(editor, ready);
}

// 手动输入 / 粘贴路径：延迟检测，只把真实存在的图片换成标签
const composerTimers = new WeakMap();
function scheduleImagePathConvert(editor) {
  if (!editor) return;
  const prev = composerTimers.get(editor);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    composerTimers.delete(editor);
    void convertImagePaths(editor);
  }, 320);
  composerTimers.set(editor, timer);
}

async function convertImagePaths(editor) {
  if (!editor || !window.petApi || !window.petApi.imageProbe) return;
  const text = composerText(editor);
  if (!text) return;
  const existing = new Set(
    Array.from(editor.querySelectorAll('.img-path-chip'), (chip) => String(chip.dataset.path || '')),
  );
  const found = [];
  for (const hit of text.matchAll(IMAGE_PATH_REGEX)) {
    const p = hit[0].trim();
    if (p && !existing.has(p) && !found.includes(p)) found.push(p);
  }
  if (!found.length) return;
  const valid = [];
  for (const p of found) {
    try {
      const probe = await window.petApi.imageProbe(p);
      // 用用户输入的原始路径，保证下面按字符串切分时能精确命中
      if (probe && probe.ok) valid.push(p);
    } catch (_) {
      /* 探测失败就当普通文本 */
    }
  }
  if (!valid.length) return;
  // 异步探测期间用户可能又改了内容：内容变了就放弃这次重建，等下一轮 input
  if (composerText(editor) !== text) return;
  const chipPaths = [...existing].concat(valid.filter((p) => !existing.has(p)));
  const wasFocused = document.activeElement === editor;
  renderComposerParts(editor, splitByImagePaths(text, chipPaths));
  if (wasFocused) focusComposerEnd(editor);
  valid.forEach(addAllowedImagePath);
}

function splitByImagePaths(text, paths) {
  const parts = [];
  let rest = text;
  while (rest) {
    let best = null;
    paths.forEach((p) => {
      const i = rest.indexOf(p);
      if (i >= 0 && (!best || i < best.i)) best = { p, i };
    });
    if (!best) {
      parts.push({ type: 'text', value: rest });
      break;
    }
    if (best.i > 0) parts.push({ type: 'text', value: rest.slice(0, best.i) });
    parts.push({ type: 'chip', path: best.p });
    rest = rest.slice(best.i + best.p.length);
  }
  return parts;
}

function renderComposerParts(editor, parts) {
  editor.innerHTML = '';
  parts.forEach((part) => {
    if (part.type === 'chip') {
      editor.appendChild(makeImageChip(part.path));
      return;
    }
    const value = String(part.value || '');
    value.split('\n').forEach((line, i) => {
      if (i) editor.appendChild(document.createElement('br'));
      appendRefAwareText(editor, line);
    });
  });
}

// 重建输入框时把 〔引用…〕 标记还原成标签，避免图片路径转换把引用弄丢
function appendRefAwareText(editor, line) {
  const text = String(line || '');
  if (!text) return;
  const re = /〔引用(会话|笔记)：([^〕\n]+)〕/g;
  let last = 0;
  let hit = re.exec(text);
  while (hit) {
    if (hit.index > last) editor.appendChild(document.createTextNode(text.slice(last, hit.index)));
    const kind = hit[1] === '会话' ? 'archive' : 'note';
    const target = refTargetByTitle(kind, hit[2]);
    if (target) editor.appendChild(makeRefChip(kind, target.id, target.title));
    else editor.appendChild(document.createTextNode(hit[0]));
    last = hit.index + hit[0].length;
    hit = re.exec(text);
  }
  if (last < text.length) editor.appendChild(document.createTextNode(text.slice(last)));
}

// 输入框统一接线：粘贴 / 拖放图片 → 标签；输入路径 → 延迟转标签
function attachComposer(editor) {
  if (!editor) return;
  // 拖放热区放宽到整个输入容器：拖到工具行 / 内边距上也算落进输入框
  const zone = editor.closest('.chat-input-box, .dsh-input-box, .chat-input-wrap') || editor;
  editor.addEventListener('input', () => {
    syncSlashMenu(editor);
    syncMentionMenu(editor);
    scheduleImagePathConvert(editor);
  });
  editor.addEventListener('keydown', (e) => {
    slashKeydown(editor, e);
  });
  editor.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = Array.from(dt.files || []);
    if (files.length) {
      e.preventDefault();
      void acceptImageFiles(editor, files);
      return;
    }
    const text = dt.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(document.createTextNode(text));
      focusComposerEnd(editor);
    }
    scheduleImagePathConvert(editor);
  });
  zone.addEventListener('dragover', (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    if (Array.from(dt.types || []).includes('Files')) {
      e.preventDefault();
      dt.dropEffect = 'copy';
    }
  });
  zone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files || []);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    focusComposerEnd(editor);
    void acceptImageFiles(editor, files);
  });
  // 失焦时把还没转完的路径补转一次（此时不再抢焦点）
  editor.addEventListener('blur', () => {
    // 点「+」时焦点会离开输入框，这一下交给按钮自己判断开关，别提前关面板
    if (slashState.editor === editor && !plusTogglePending) hideSlashMenu();
    const timer = composerTimers.get(editor);
    if (!timer) return;
    clearTimeout(timer);
    composerTimers.delete(editor);
    void convertImagePaths(editor);
  });
}

/* ---------------------------------------------------------------- 斜杠指令
 * 输入框第一个字符是「/」时，在输入框上方浮出指令面板；其余情况一律不弹。
 * 选中的指令直接复用主界面对话框「+」菜单里的三个动作，模型切换顺带做进同一个面板。
 * ---------------------------------------------------------------------- */
const SLASH_COMMANDS = [
  { id: 'clear', name: '清空上下文', keyword: 'clear', desc: '旧会话存入「设置 → 归档」，保留人设与笔记' },
  { id: 'compress', name: '压缩上下文', keyword: 'compress', desc: '把长对话浓缩成摘要' },
  { id: 'download', name: '下载会话', keyword: 'export', desc: '导出为 JSON 文件' },
  { id: 'model', name: '切换模型', keyword: 'model', desc: '选择本会话使用的模型' },
];

const SLASH_MODEL_ICON =
  '<svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2"/>' +
  '<line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/>' +
  '<line x1="4" y1="17" x2="20" y2="17"/><circle cx="11" cy="17" r="2"/></svg>';
const SLASH_CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg>';

// 三个动作的图标从原「+」菜单搬过来，画法保持一致
const SLASH_ICONS = {
  clear:
    '<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/>' +
    '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' +
    '<path d="M6 6l1.5 13a2.5 2.5 0 0 0 2.5 2.5h4a2.5 2.5 0 0 0 2.5-2.5L18 6"/>' +
    '<line x1="10" y1="10" x2="10" y2="17"/><line x1="14" y1="10" x2="14" y2="17"/></svg>',
  compress:
    '<svg viewBox="0 0 24 24"><circle class="ring-bg" cx="12" cy="12" r="9"/>' +
    '<circle class="ring-arc" cx="12" cy="12" r="9"/></svg>',
  download:
    '<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="15"/>' +
    '<polyline points="7 10 12 15 17 10"/>' +
    '<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
};

// 引用面板的图标：会话沿用「参考/会话图标」里的圆气泡，笔记用文档造型
const REF_ICONS = {
  archive:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M 7 6.5 A 8 8 0 1 1 6 18 Q 4 21 8 19.5"/>' +
    '<line x1="8.5" y1="10.5" x2="15" y2="10.5"/>' +
    '<line x1="8.5" y1="14" x2="13" y2="14"/></svg>',
  note:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3.5h8l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z"/>' +
    '<path d="M14 3.5v5h5"/>' +
    '<line x1="8.5" y1="12.5" x2="15.5" y2="12.5"/>' +
    '<line x1="8.5" y1="16.5" x2="13" y2="16.5"/></svg>',
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<circle cx="8.5" cy="9.5" r="1.4"/>' +
    '<path d="M4.5 17.5l4.5-4 3.2 2.8 3-2.5 4.3 3.7"/></svg>',
};

const slashState = {
  dom: null,
  head: null,
  headTitle: null,
  back: null,
  list: null,
  footHint: null,
  editor: null,
  mode: 'commands',
  // input = 输入框打「/」触发；plus = 点「+」打开。plus 模式不消耗输入框里的正文
  source: 'input',
  clearInput: false,
  items: [],
  index: 0,
};

function slashMenuDom() {
  if (slashState.dom) return slashState.dom;
  const dom = document.createElement('div');
  dom.className = 'slash-menu';
  dom.hidden = true;

  const head = document.createElement('div');
  head.className = 'slash-head';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'slash-back';
  back.title = '返回指令';
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 6 9 12l6 6"/></svg>';
  back.style.display = 'none';
  const headTitle = document.createElement('span');
  headTitle.className = 'slash-title';
  headTitle.textContent = '指令';
  head.append(back, headTitle);

  const list = document.createElement('div');
  list.className = 'slash-list';

  const foot = document.createElement('div');
  foot.className = 'slash-foot';
  const footHint = document.createElement('span');
  footHint.textContent = '↑↓ 选择 · Enter 执行 · Esc 关闭';
  foot.append(footHint);

  dom.append(head, list, foot);
  document.body.appendChild(dom);

  slashState.dom = dom;
  slashState.head = head;
  slashState.headTitle = headTitle;
  slashState.back = back;
  slashState.list = list;
  slashState.footHint = footHint;

  // 点面板时不抢走输入框焦点，避免面板一开就因失焦关掉
  dom.addEventListener('mousedown', (e) => e.preventDefault());
  back.addEventListener('click', () => {
    if (slashState.editor) showSlashCommands(slashState.editor, '', slashState.source);
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.slash-item');
    if (!row) return;
    activateSlashIndex(Number(row.dataset.index));
  });
  return dom;
}

function slashFilterCommands(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return SLASH_COMMANDS.slice();
  return SLASH_COMMANDS.filter((c) => `${c.name} ${c.keyword} ${c.desc}`.toLowerCase().includes(q));
}

function slashIconNode(item) {
  const wrap = document.createElement('span');
  wrap.className = 'plus-item-icon' + (item.id === 'clear' ? ' danger' : '');
  if (slashState.mode === 'mentions') {
    wrap.innerHTML = REF_ICONS[item.kind] || '';
    return wrap;
  }
  if (slashState.mode === 'models') {
    if (item.badge) wrap.innerHTML = SLASH_CHECK_ICON;
    return wrap;
  }
  if (item.id === 'model') {
    wrap.innerHTML = SLASH_MODEL_ICON;
    return wrap;
  }
  if (SLASH_ICONS[item.id]) wrap.innerHTML = SLASH_ICONS[item.id];
  return wrap;
}

function slashRowEl(item, index) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'slash-item' + (index === slashState.index ? ' is-active' : '');
  row.dataset.index = String(index);
  row.dataset.id = String(item.id || '');

  row.appendChild(slashIconNode(item));

  const text = document.createElement('span');
  text.className = 'slash-text';
  const line = document.createElement('span');
  line.className = 'slash-name-line';
  const name = document.createElement('b');
  name.className = 'slash-name';
  name.textContent = item.name || '';
  line.appendChild(name);
  if (item.keyword) {
    const kw = document.createElement('span');
    kw.className = 'slash-kw';
    kw.textContent = item.keyword;
    line.appendChild(kw);
  }
  if (item.badge) {
    const badge = document.createElement('span');
    badge.className = 'slash-badge';
    badge.textContent = item.badge;
    line.appendChild(badge);
  }
  if (item.meta) {
    // 引用面板右侧的「8天 / 123字」：和当前模型徽标同样贴右
    const meta = document.createElement('span');
    meta.className = 'slash-meta';
    meta.textContent = item.meta;
    line.appendChild(meta);
  }
  text.appendChild(line);
  if (item.desc) {
    const desc = document.createElement('span');
    desc.className = 'slash-desc';
    desc.textContent = item.desc;
    text.appendChild(desc);
  }
  row.appendChild(text);
  return row;
}

function renderSlashMenu() {
  const dom = slashMenuDom();
  const isModels = slashState.mode === 'models';
  const isMentions = slashState.mode === 'mentions';
  slashState.back.style.display = isModels ? 'inline-flex' : 'none';
  slashState.headTitle.textContent = isModels ? '切换模型' : isMentions ? '引用' : '指令';
  if (isModels) slashState.footHint.textContent = '↑↓ 选择 · Enter 切换 · Esc 关闭';
  else if (isMentions) slashState.footHint.textContent = '↑↓ 选择 · Enter 插入引用 · Esc 关闭';
  else slashState.footHint.textContent = '↑↓ 选择 · Enter 执行 · Esc 关闭';

  const list = slashState.list;
  list.innerHTML = '';
  if (!slashState.items.length) {
    const empty = document.createElement('div');
    empty.className = 'slash-empty';
    empty.textContent = isMentions ? '没有匹配的图片、会话或笔记' : '没有匹配的指令';
    list.appendChild(empty);
  } else if (isMentions) {
    // 引用面板按来源分组：图片 → 会话 → 笔记，组内保持原有顺序
    let group = '';
    slashState.items.forEach((item, i) => {
      if (item.group && item.group !== group) {
        group = item.group;
        const head = document.createElement('div');
        head.className = 'slash-group';
        head.textContent = group;
        list.appendChild(head);
      }
      list.appendChild(slashRowEl(item, i));
    });
  } else {
    slashState.items.forEach((item, i) => list.appendChild(slashRowEl(item, i)));
  }

  dom.hidden = false;
  positionSlashMenu();
  const active = list.querySelector('.slash-item.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

// 面板贴着输入框上沿生长：底部锚定，窗口变矮时自动缩高度并内部滚动
function positionSlashMenu() {
  const editor = slashState.editor;
  const dom = slashState.dom;
  if (!editor || !dom || dom.hidden) return;
  const anchor = editor.closest('.chat-input-box, .dsh-input-box') || editor;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const width = Math.min(300, window.innerWidth - margin * 2);
  let left = Math.min(rect.left, window.innerWidth - margin - width);
  left = Math.max(margin, left);
  dom.style.width = `${width}px`;
  dom.style.left = `${left}px`;
  dom.style.bottom = `${window.innerHeight - rect.top + gap}px`;
  dom.style.maxHeight = `${Math.max(96, Math.min(360, rect.top - margin - gap))}px`;
}

function showSlashCommands(editor, query, source = 'input') {
  if (!editor) return;
  slashState.editor = editor;
  slashState.mode = 'commands';
  slashState.source = source;
  // 打「/」时那串指令文字本来就该被消耗；点「+」时只有输入框本身是「/」草稿才清
  slashState.clearInput = source === 'input' || composerText(editor).startsWith('/');
  slashState.items = slashFilterCommands(query || '');
  // 打「/」进来默认选中第一项；点「+」进来不预选，避免误按 Enter 直接清空上下文
  slashState.index = source === 'plus' ? -1 : 0;
  renderSlashMenu();
}

function openSlashModels(editor, clearInput) {
  if (!editor) return;
  slashState.editor = editor;
  slashState.mode = 'models';
  slashState.clearInput = clearInput === true;
  const models = loadModels();
  const activeId = currentModelId();
  slashState.items = models.map((m) => ({
    id: m.id,
    name: m.name || m.model || '未命名',
    keyword: m.model || '',
    desc: m.builtin ? '内置模型 · 无需 Key' : `${m.base || '—'} · 上下文 ${fmtNum(m.contextWindow)}`,
    badge: m.id === activeId ? '当前' : '',
  }));
  slashState.index = Math.max(0, models.findIndex((m) => m.id === activeId));
  renderSlashMenu();
}

function hideSlashMenu() {
  if (slashState.dom) slashState.dom.hidden = true;
  slashState.editor = null;
  slashState.mode = 'commands';
  slashState.source = 'input';
  slashState.clearInput = false;
  slashState.items = [];
  slashState.index = 0;
}

function syncSlashMenu(editor) {
  if (!editor) return;
  const text = composerText(editor);
  // 严格按需求：第一个字符是「/」才触发，其他位置出现斜杠一律不弹
  if (!text.startsWith('/')) {
    if (slashState.editor === editor) hideSlashMenu();
    return;
  }
  if (slashState.editor === editor && slashState.mode === 'models') return; // 模型列表不跟随输入过滤
  showSlashCommands(editor, text.slice(1));
}

function runSlashCommand(id, editor, clearInput) {
  if (!editor || !id) return;
  if (id === 'model') {
    // 打「/」时保留输入框里的「/」，等选完模型再一起清掉；点「+」时输入框正文本来就不动
    openSlashModels(editor, clearInput);
    return;
  }
  if (clearInput) clearComposer(editor);
  if (id === 'clear') clearChatContext();
  else if (id === 'compress') compressContext();
  else if (id === 'download') downloadChat();
}

function applySlashModel(id) {
  const models = loadModels();
  const target = models.find((m) => m.id === id);
  if (!target) return;
  store.set('agentpet.currentModel', target.id);
  renderModels();
  updateConsoleMeta();
  syncModeChips(false);
  toast(`已切换到 ${target.name || target.model}`, 'accent');
}

function activateSlashIndex(index) {
  const item = slashState.items[index];
  const editor = slashState.editor;
  if (!item || !editor) return;
  const clearInput = slashState.clearInput;
  if (slashState.mode === 'mentions') {
    hideSlashMenu();
    insertRefChip(editor, item);
    return;
  }
  if (slashState.mode === 'models') {
    applySlashModel(item.id);
    if (clearInput) clearComposer(editor);
    hideSlashMenu();
    return;
  }
  hideSlashMenu();
  runSlashCommand(item.id, editor, clearInput);
}

// 返回 true 表示这次按键已被指令面板吃掉
function slashKeydown(editor, e) {
  if (slashState.editor !== editor || !slashState.dom || slashState.dom.hidden) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!slashState.items.length) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    const down = e.key === 'ArrowDown';
    if (slashState.index < 0) slashState.index = down ? 0 : slashState.items.length - 1;
    else {
      const delta = down ? 1 : -1;
      slashState.index = (slashState.index + delta + slashState.items.length) % slashState.items.length;
    }
    renderSlashMenu();
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    hideSlashMenu();
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    // 没有匹配项或「+」面板还没选中任何项时照常发送，避免卡住正常输入
    if (!slashState.items.length || slashState.index < 0) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    activateSlashIndex(slashState.index);
    return true;
  }
  return false;
}

document.addEventListener(
  'mousedown',
  (e) => {
    if (!slashState.editor || !slashState.dom || slashState.dom.hidden) return;
    if (slashState.dom.contains(e.target) || slashState.editor.contains(e.target)) return;
    // 点「+」时不在这里关，交给它的 click 做开关切换
    if (e.target.closest('#btn-plus')) return;
    hideSlashMenu();
  },
  true,
);

let slashRepositionFrame = 0;
function scheduleSlashReposition() {
  if (!slashState.dom || slashState.dom.hidden) return;
  cancelAnimationFrame(slashRepositionFrame);
  slashRepositionFrame = requestAnimationFrame(positionSlashMenu);
}
window.addEventListener('resize', scheduleSlashReposition);
document.addEventListener('scroll', scheduleSlashReposition, true);

/* ---------------------------------------------------------------- @ 引用面板
 * 输入框里恰好有一个「@」时浮出：列出已归档的会话与笔记，选中后把「@查询词」
 * 换成「图标 + 标题」的引用标签。标签只序列化成标记，全文在组装请求时才拼上。
 * ---------------------------------------------------------------------- */
const REF_BLOCK_MAX_CHARS = 2400; // 单条引用最多带这么多字，避免一轮对话被撑爆

function refMark(kind, title) {
  return `〔引用${kind === 'archive' ? '会话' : '笔记'}：${title}〕`;
}

function refChipName(chip) {
  const name = chip.querySelector('.ref-chip-name');
  return String((name && name.textContent) || '');
}

function refTargetByTitle(kind, title) {
  if (kind === 'note') return memories.find((m) => m.title === title) || null;
  return archives.find((a) => a.title === title) || null;
}

function makeRefChip(kind, id, title) {
  const chip = document.createElement('span');
  chip.className = 'ref-chip';
  chip.contentEditable = 'false';
  chip.dataset.refKind = kind;
  chip.dataset.refId = String(id || '');
  chip.title = refMark(kind, title);
  chip.innerHTML = `${REF_ICONS[kind] || ''}<span class="ref-chip-name"></span>`;
  chip.querySelector('.ref-chip-name').textContent = title;
  return chip;
}

function refDaysAgo(ts) {
  const days = Math.floor(Math.max(0, Date.now() - Number(ts || Date.now())) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days}天`;
}

// 最近用过的图片（@ 面板只列 5 条）：读主进程别名表，带短暂缓存，避免每次键入都走 IPC
const MENTION_IMAGE_LIMIT = 5;
let mentionImages = [];
let mentionImagesAt = 0;
async function refreshMentionImages(maxAgeMs = 1500) {
  if (Date.now() - mentionImagesAt < maxAgeMs) return mentionImages;
  mentionImagesAt = Date.now();
  try {
    const r = window.petApi && window.petApi.imageAliasList ? await window.petApi.imageAliasList(MENTION_IMAGE_LIMIT) : null;
    if (r && r.ok && Array.isArray(r.items)) {
      mentionImages = r.items
        .filter((it) => it && it.alias && it.path)
        .map((it) => ({
          kind: 'image',
          id: it.path,
          name: baseName(it.path),
          alias: it.alias,
          group: '图片',
          meta: `${it.alias} · ${refDaysAgo(it.last_used || it.added_at)}`,
        }));
    }
  } catch (_) {
    /* 别名表读不到时只是不列图片 */
  }
  return mentionImages;
}

function buildMentionItems(query) {
  const q = String(query || '').trim().toLowerCase();
  const hit = (text) => !q || String(text || '').toLowerCase().includes(q);
  const items = [];
  // 图片排在最前：@ 最常见的用途就是把刚看过的图再引用回来
  mentionImages.forEach((it) => {
    if (!hit(it.name) && !hit(it.alias)) return;
    items.push(it);
  });
  archives.forEach((a) => {
    if (!hit(a.title)) return;
    // 归档跨角色可见：显示角色名，避免同名会话分不清
    const meta = [a.characterName, refDaysAgo(a.endedAt)].filter(Boolean).join(' · ');
    items.push({ kind: 'archive', id: a.id, name: a.title, group: '会话', meta });
  });
  memories.forEach((m) => {
    if (!hit(m.title) && !hit(m.body)) return;
    items.push({ kind: 'note', id: m.id, name: m.title, group: '笔记', meta: `${String(m.body || '').length}字` });
  });
  return items;
}

function showSlashMentions(editor, query) {
  if (!editor) return;
  slashState.editor = editor;
  slashState.mode = 'mentions';
  slashState.source = 'input';
  slashState.clearInput = false;
  slashState.items = buildMentionItems(query);
  slashState.index = slashState.items.length ? 0 : -1;
  renderSlashMenu();
}

function syncMentionMenu(editor) {
  if (!editor) return;
  const text = composerText(editor);
  const active = slashState.editor === editor && slashState.mode === 'mentions';
  const close = () => {
    if (active) hideSlashMenu();
  };
  // 严格按需求：有且仅有一个「@」才弹；「/」指令优先，开始写正常句子（出现空格）就收起
  if ((text.match(/@/g) || []).length !== 1 || text.startsWith('/')) {
    close();
    return;
  }
  const at = text.indexOf('@');
  const query = text.slice(at + 1);
  // 邮箱之类「字母后面跟 @」不算引用，避免误弹
  if (/[\s\n]/.test(query) || /[A-Za-z0-9]/.test(text[at - 1] || '')) {
    close();
    return;
  }
  // 先用缓存立刻出面板，再异步补上「最近图片」，查询词没变才重绘
  showSlashMentions(editor, query);
  void refreshMentionImages().then(() => {
    if (slashState.editor !== editor || slashState.mode !== 'mentions') return;
    if (!slashState.dom || slashState.dom.hidden) return;
    const now = composerText(editor);
    if ((now.match(/@/g) || []).length !== 1) return;
    if (now.slice(now.indexOf('@') + 1) !== query) return;
    const keep = slashState.index;
    showSlashMentions(editor, query);
    slashState.index = Math.min(Math.max(0, keep), Math.max(0, slashState.items.length - 1));
    renderSlashMenu();
  });
}

// 从最后一个「@」删到文末（连带用户输入的查询词），再在原位插入引用标签
function lastTextNodeWith(editor, ch) {
  let found = null;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const i = String(node.nodeValue || '').lastIndexOf(ch);
    if (i >= 0) found = { node, index: i };
    node = walker.nextNode();
  }
  return found;
}

function insertRefChip(editor, item) {
  if (!editor || !item) return;
  // 图片沿用输入框里的图片标签：显示文件名，序列化仍是完整路径
  if (item.kind === 'image') addAllowedImagePath(item.id);
  const chip = item.kind === 'image' ? makeImageChip(item.id, item.name) : makeRefChip(item.kind, item.id, item.name);
  const spot = lastTextNodeWith(editor, '@');
  const range = document.createRange();
  if (spot && editor.lastChild) {
    range.setStart(spot.node, spot.index);
    range.setEndAfter(editor.lastChild);
    range.deleteContents();
    range.insertNode(chip);
  } else {
    editor.appendChild(chip);
  }
  const space = document.createTextNode(' ');
  if (chip.parentNode) chip.parentNode.insertBefore(space, chip.nextSibling);
  focusComposerEnd(editor);
}

// 发送前收集引用标签，跟着这条用户消息一起存进会话
function collectComposerRefs(editor) {
  if (!editor) return [];
  return Array.from(editor.querySelectorAll('.ref-chip'))
    .map((chip) => ({
      kind: String(chip.dataset.refKind || ''),
      id: String(chip.dataset.refId || ''),
      title: refChipName(chip),
    }))
    .filter((r) => r.kind && r.id);
}

// 引用全文只在发给模型时拼上：气泡里仍是紧凑标记，不会塞进一大段转录
function buildRefBlock(refs) {
  if (!Array.isArray(refs) || !refs.length) return '';
  const blocks = [];
  refs.forEach((r) => {
    if (!r || !r.kind) return;
    if (r.kind === 'note') {
      const note = memories.find((m) => m.id === r.id) || memories.find((m) => m.title === r.title);
      if (!note) return;
      blocks.push(`【笔记：${note.title}】\n${String(note.body || '').slice(0, REF_BLOCK_MAX_CHARS)}`);
      return;
    }
    const arc = archives.find((a) => a.id === r.id) || archives.find((a) => a.title === r.title);
    if (!arc) return;
    let body = (arc.messages || [])
      .map((m) => {
        const who = m.role === 'user' ? '用户' : charNameText() || '角色';
        const text = String(m.text || '').replace(/\s+/g, ' ').trim();
        return text ? `${who}：${text.slice(0, 300)}` : '';
      })
      .filter(Boolean)
      .join('\n');
    if (body.length > REF_BLOCK_MAX_CHARS) body = `${body.slice(0, REF_BLOCK_MAX_CHARS)}\n……（后略）`;
    blocks.push(`【会话：${arc.title}】\n${body}`);
  });
  if (!blocks.length) return '';
  return `\n\n[用户引用的资料]\n${blocks.join('\n\n')}`;
}

attachComposer(el.chatInput);
attachComposer(el.consoleInput);

async function sendChat() {
  const raw = composerText(el.chatInput);
  const text = raw.trim();
  if (!text) return;
  if (raw.startsWith('/')) {
    // 「/」开头的文本按指令处理，绝不作为普通消息发出去
    const cmd = slashFilterCommands(text.slice(1))[0];
    hideSlashMenu();
    if (cmd) runSlashCommand(cmd.id, el.chatInput, true);
    else toast('没有匹配的指令');
    return;
  }
  if (chatBusy || autoCompressRunning) return; // 生成中 / 自动压缩中，Enter 不再叠发
  if (slashState.editor === el.chatInput) hideSlashMenu();
  const refs = collectComposerRefs(el.chatInput);
  clearComposer(el.chatInput);
  await sendMessage(text, refs);
}

$('#btn-send').onclick = () => (autoCompressRunning ? null : chatBusy ? cancelChat() : sendChat());
el.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// ------------------------------------------------------------------ 语音输入（本地 sherpa-onnx + SenseVoice）
// 点麦克风开始录音，再点一次结束；音频重采样到 16k 单声道 WAV 交给主进程转写。
const voice = {
  ctx: null,
  stream: null,
  processor: null,
  source: null,
  sink: null,
  chunks: [],
  transcribing: false,
  starting: false,
  // 边听边转写 / 静音自动停止
  spoke: false,
  silenceMs: 0,
  autoStopping: false,
  previewBusy: false,
  previewText: '',
  lastPreviewAt: 0,
};

// 用户在语音设置里选的模型文件；空字符串表示用主进程的默认选择
let voiceModelFile = String(store.get('agentpet.voiceModel', '') || '');

const VOICE_SPEECH_RMS = 0.02;
const VOICE_SILENCE_MS = 1600;
const VOICE_PREVIEW_GAP_MS = 2200;
const VOICE_PREVIEW_WINDOW_SEC = 10;

function resampleTo16k(input, inRate) {
  const outRate = 16000;
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function encodeWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function setMicRecording(on) {
  const btn = $('#btn-mic');
  btn.classList.toggle('recording', on);
  btn.classList.toggle('active', on);
  btn.title = on ? '点击结束录音' : '语音输入';
}

function setMicBusy(on) {
  const btn = $('#btn-mic');
  btn.classList.toggle('busy', on);
  btn.disabled = on;
  btn.title = on ? '正在转写…' : '语音输入';
}

function micErrorText(err) {
  const name = err && err.name ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝：Windows 设置 → 隐私 → 麦克风，允许桌面应用访问';
  }
  if (name === 'NotFoundError') {
    return '没有找到麦克风设备：请确认已插好麦克风，并在 Windows 声音设置里启用输入设备';
  }
  if (name === 'NotReadableError') return '麦克风被其他程序占用';
  return (err && err.message) || String(err);
}

// 录音波形 HUD：宽度固定，最新采样从右侧进入，旧的向左滚动
const VOICE_BAR_COUNT = 21;
const voiceLevels = new Array(VOICE_BAR_COUNT).fill(0.06);

function initVoiceBars() {
  const bars = $('#voice-bars');
  if (!bars || bars.childElementCount) return;
  for (let i = 0; i < VOICE_BAR_COUNT; i++) {
    bars.appendChild(document.createElement('i'));
  }
}

function renderVoiceBars() {
  const bars = $('#voice-bars');
  if (!bars) return;
  [...bars.children].forEach((bar, i) => {
    bar.style.height = `${4 + (voiceLevels[i] || 0) * 24}px`;
  });
}

function resetVoiceLevels() {
  voiceLevels.fill(0.06);
  renderVoiceBars();
}

function pushVoiceLevel(level) {
  voiceLevels.push(clamp(level, 0.06, 1));
  voiceLevels.shift();
  renderVoiceBars();
}

function showVoiceHud(on) {
  const hud = $('#voice-hud');
  if (!hud) return;
  hud.hidden = !on;
  if (on) {
    resetVoiceLevels();
    showVoicePartial('');
  }
}

function showVoicePartial(text) {
  const node = $('#voice-partial');
  if (node) node.textContent = text || '';
}

// 取最后 maxSamples 个采样点合并，用于实时预览时限制窗口长度
function mergeVoiceChunks(chunks, maxSamples) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const take = Math.min(total, Number.isFinite(maxSamples) ? maxSamples : total);
  const out = new Float32Array(take);
  let skip = total - take;
  let offset = 0;
  for (const c of chunks) {
    if (offset >= take) break;
    if (skip >= c.length) {
      skip -= c.length;
      continue;
    }
    const start = skip;
    const len = Math.min(c.length - start, take - offset);
    out.set(c.subarray(start, start + len), offset);
    offset += len;
    skip = 0;
  }
  return out;
}

// 录音过程中隔一段时间把最近 10 秒送去转写，结果只做 HUD 预览，不落输入框
async function previewVoiceTranscribe(ctx) {
  if (voice.previewBusy || voice.transcribing || !voice.ctx) return;
  const now = Date.now();
  if (now - voice.lastPreviewAt < VOICE_PREVIEW_GAP_MS) return;
  if (!voice.spoke) return;
  voice.lastPreviewAt = now;
  voice.previewBusy = true;
  const sessionCtx = ctx;
  try {
    const rate = ctx.sampleRate || 48000;
    if (voice.chunks.length < 4) return;
    const merged = mergeVoiceChunks(voice.chunks, rate * VOICE_PREVIEW_WINDOW_SEC);
    if (merged.length < rate * 0.6) return;
    const wav = encodeWav(resampleTo16k(merged, rate), 16000);
    const res = await petApi.voiceTranscribe(wav, voiceModelFile);
    if (voice.ctx !== sessionCtx || voice.transcribing) return;
    if (!res || !res.ok) return;
    const text = String(res.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    voice.previewText = text;
    showVoicePartial(text);
  } catch (_) {
    /* 预览失败不打断录音，最终还会再转写一次 */
  } finally {
    voice.previewBusy = false;
  }
}

initVoiceBars();

async function startVoice() {
  if (voice.transcribing || voice.starting) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('当前环境不支持录音');
    return;
  }
  voice.starting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext();
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor 已废弃但在 Electron 里稳定可用，避免额外的 worklet 文件
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0; // 必须接到 destination 才会持续回调，但不要真的外放
    voice.chunks = [];
    voice.spoke = false;
    voice.silenceMs = 0;
    voice.autoStopping = false;
    voice.previewText = '';
    voice.lastPreviewAt = Date.now();
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      voice.chunks.push(new Float32Array(data));
      // 每帧取一个 RMS 电平驱动波形 HUD
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 8) {
        sum += data[i] * data[i];
        count++;
      }
      const rms = Math.sqrt(sum / Math.max(1, count));
      pushVoiceLevel(rms * 9);

      const frameMs = (data.length / (ctx.sampleRate || 48000)) * 1000;
      if (rms > VOICE_SPEECH_RMS) {
        voice.spoke = true;
        voice.silenceMs = 0;
      } else if (voice.spoke) {
        voice.silenceMs += frameMs;
        // 说过话后长时间静音：自动结束录音，只转写不发送
        if (voice.silenceMs >= VOICE_SILENCE_MS && !voice.autoStopping) {
          voice.autoStopping = true;
          toast('检测到静音，自动停止录音', 'accent');
          stopVoice(true);
          return;
        }
      }
      if (!voice.autoStopping) previewVoiceTranscribe(ctx);
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    Object.assign(voice, { ctx, stream, processor, source, sink });
    setMicRecording(true);
    showVoiceHud(true);
  } catch (err) {
    toast(`无法访问麦克风：${micErrorText(err)}`);
  } finally {
    voice.starting = false;
  }
}

async function stopVoice(auto = false) {
  const { ctx, stream, processor, source, sink, chunks } = voice;
  if (!ctx) return;
  const preview = String(voice.previewText || '').trim();
  setMicRecording(false);
  showVoiceHud(false);
  voice.ctx = voice.stream = voice.processor = voice.source = voice.sink = null;
  voice.chunks = [];
  voice.autoStopping = false;
  voice.spoke = false;
  voice.silenceMs = 0;
  try {
    if (processor) processor.disconnect();
    if (source) source.disconnect();
    if (sink) sink.disconnect();
    if (stream) stream.getTracks().forEach((track) => track.stop());
  } catch (_) {
    /* 断开顺序无关紧要 */
  }
  const rate = ctx.sampleRate || 48000;
  try {
    await ctx.close();
  } catch (_) {
    /* ignore */
  }

  let total = 0;
  chunks.forEach((c) => (total += c.length));
  if (total < rate * 0.3) {
    if (preview) {
      fillChatInput(preview);
      toast('录音较短，已填入实时结果', 'accent');
    } else {
      toast('录音太短，没有内容');
    }
    voice.previewText = '';
    return;
  }
  const merged = mergeVoiceChunks(chunks);

  voice.transcribing = true;
  setMicBusy(true);
  toast('正在转写…');
  try {
    const wav = encodeWav(resampleTo16k(merged, rate), 16000);
    const res = await petApi.voiceTranscribe(wav, voiceModelFile);
    if (!res || !res.ok) {
      if (preview) {
        fillChatInput(preview);
        toast('最终转写失败，已填入实时结果');
      } else {
        toast((res && res.error) || '转写失败');
        openVoiceSettings();
      }
      return;
    }
    const text = String(res.text || '').replace(/\s+/g, ' ').trim() || preview;
    if (!text) {
      toast('没有识别到语音内容');
      return;
    }
    fillChatInput(text);
    toast(auto ? '已自动停止并转写，可编辑后发送' : '已转写，可编辑后发送', 'accent');
  } finally {
    voice.transcribing = false;
    voice.previewText = '';
    setMicBusy(false);
  }
}

function fillChatInput(text) {
  if (!el.chatPanel.classList.contains('show')) {
    closeAllPanels('chat');
    el.chatPanel.classList.add('show');
    $('#btn-chat').classList.add('active');
    renderChat();
  }
  const cur = composerText(el.chatInput).trim();
  setComposerText(el.chatInput, cur ? `${cur} ${text}` : text);
  setTimeout(() => focusComposerEnd(el.chatInput), 60);
}

function openVoiceSettings() {
  openSettingsPage('voice');
  renderVoiceStatus();
  refreshTtsEngineStatus();
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

function fmtVoiceSize(bytes) {
  const v = Number(bytes) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (v >= 1024 * 1024) return `${Math.round(v / (1024 * 1024))}MB`;
  if (v > 0) return `${Math.round(v / 1024)}KB`;
  return '';
}

async function renderVoiceStatus() {
  if (IS_PANEL) return;
  const binEl = $('#voice-bin');
  const modelEl = $('#voice-model');
  const install = $('#voice-install');
  const select = $('#set-voice-model');
  if (!binEl || !modelEl) return;
  binEl.textContent = '检测中…';
  binEl.classList.remove('ok');
  modelEl.textContent = '检测中…';
  modelEl.classList.remove('ok');
  let status = null;
  try {
    status = await petApi.voiceStatus();
  } catch (_) {
    /* 主进程异常时按未就绪处理 */
  }
  if (!status) {
    binEl.textContent = '检测失败';
    modelEl.textContent = '检测失败';
    if (install) install.hidden = false;
    return;
  }
  binEl.textContent = status.bin || '未找到（sherpa-onnx 引擎需放到 si/voice/asr/bin/）';
  binEl.classList.toggle('ok', !!status.bin);

  const models = Array.isArray(status.models) && status.models.length
    ? status.models
    : status.model
      ? [{ name: baseName(status.model), size: 0 }]
      : [];
  if (select) {
    select.innerHTML = '';
    if (!models.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '没有找到模型';
      select.appendChild(opt);
      select.disabled = true;
    } else {
      select.disabled = false;
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.name;
        const size = fmtVoiceSize(m.size);
        opt.textContent = `${m.name}${size ? ` · ${size}` : ''}`;
        select.appendChild(opt);
      });
      if (!models.some((m) => m.name === voiceModelFile)) {
        voiceModelFile = status.model ? baseName(status.model) : models[0].name;
        store.set('agentpet.voiceModel', voiceModelFile);
      }
      select.value = voiceModelFile;
    }
    // 只有一个模型时不显示选择器（大多数人只装一份）
    select.hidden = models.length <= 1;
  }
  const chosen = models.find((m) => m.name === voiceModelFile);
  modelEl.textContent = chosen
    ? `${chosen.name}${fmtVoiceSize(chosen.size) ? ` · ${fmtVoiceSize(chosen.size)}` : ''}`
    : status.model || '未找到（SenseVoice 模型需放到 si/voice/asr/models/）';
  modelEl.classList.toggle('ok', models.length > 0);

  // 装齐后隐藏「下载 / 导入」，只在缺失时露出来
  if (install) install.hidden = !!status.ok;
}

$('#btn-voice-refresh').onclick = () => renderVoiceStatus();
if ($('#set-voice-model')) {
  $('#set-voice-model').onchange = (e) => {
    voiceModelFile = String(e.target.value || '');
    store.set('agentpet.voiceModel', voiceModelFile);
    toast(`已切换到 ${voiceModelFile || '默认模型'}`, 'accent');
  };
}
// 语音识别按需安装：官方源下载，或者导入现成 zip；进度走设置页底部的共用进度条
if ($('#btn-voice-download')) {
  $('#btn-voice-download').onclick = async () => {
    const res = await petApi.voiceDownload();
    if (res && res.ok === false && !res.canceled) toast(res.error || '语音识别下载失败');
    else if (res && res.ok) toast('语音识别已就绪', 'accent');
    renderVoiceStatus();
  };
}
if ($('#btn-voice-import')) {
  $('#btn-voice-import').onclick = async () => {
    const res = await petApi.voiceImportZip();
    if (res && res.canceled) return;
    if (res && res.ok) toast('语音识别已就绪', 'accent');
    else toast((res && res.error) || '导入后仍缺文件，请检查压缩包内容');
    renderVoiceStatus();
  };
}

$('#btn-mic').onclick = () => {
  if (voice.transcribing) return;
  if (voice.ctx) stopVoice();
  else startVoice();
};

// ------------------------------------------------------------------ 语音合成
// 两种引擎：语音插件（插件带 capabilities:["speech"]）+ 系统语音（Web Speech 内置）。
// 插件可用时自动接管；插件不可用就回落内置；两者都关掉就完全不朗读。
const tts = {
  kind: null, // 'plugin' | 'web'
  audio: null,
  url: '',
  utterance: null,
  muted: false,
  msgSeq: null,
  synthesizing: false,
  pluginAvailable: false,
  pluginName: '',
};

const SPEAK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3.5L12 19V5L7.5 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7"/><path d="M18.6 6a8.5 8.5 0 0 1 0 12"/></svg>';
const MUTE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3.5L12 19V5L7.5 9H4z"/><path d="M16 9.5l5 5"/><path d="M21 9.5l-5 5"/></svg>';
// 思考卡片左侧的小图标：原子 / 轨道造型（两条 45° 交叉的椭圆 + 中心圆点）
const THINK_ICON =
  '<svg class="think-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(45 12 12)" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-45 12 12)" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<circle cx="12" cy="12" r="1.8" fill="currentColor"/>' +
  '</svg>';

// 工具卡片左侧的小图标：按 tools.config.json 里的 icon 字段取，没有就通用。
// 新增图标只需在这张表里补一项，配置里写对应的名字即可（插件工具同样适用）。
const TOOL_ICON_SVGS = {
  generic:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M 8.5 6 Q 9 14 17 14.5 Q 9 15 8.5 23 Q 8 15 0 14.5 Q 8 14 8.5 6 Z"/>' +
    '<path d="M 17.5 2.5 Q 18 7 22.5 7.5 Q 18 8 17.5 12.5 Q 17 8 12.5 7.5 Q 17 7 17.5 2.5 Z"/>' +
    '<path d="M 18.5 16.5 Q 18.8 18.5 20.8 18.8 Q 18.8 19.1 18.5 21.1 Q 18.2 19.1 16.2 18.8 Q 18.2 18.5 18.5 16.5 Z"/>' +
    '</svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"/>' +
    '<line x1="3" y1="12" x2="21" y2="12"/>' +
    '<ellipse cx="12" cy="12" rx="4" ry="9"/>' +
    '</svg>',
  command:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="7 8 11 12 7 16"/>' +
    '<line x1="13" y1="16" x2="18" y2="16"/>' +
    '</svg>',
  prompt:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 3v5h5"/>' +
    '<path d="M9 13h6M9 16.5h4"/>' +
    '</svg>',
  note:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4" y="4" width="16" height="16" rx="3"/>' +
    '<line x1="8.5" y1="10" x2="15.5" y2="10"/>' +
    '<line x1="8.5" y1="14" x2="12.5" y2="14"/>' +
    '</svg>',
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/>' +
    '<circle cx="8.5" cy="9.5" r="1.6"/>' +
    '<path d="M4.5 17l4.8-4.6 3.4 3.1 3.5-3.4 4.8 4.9"/>' +
    '</svg>',
};

function toolIconHtml(name) {
  const cfg = findToolConfig(name);
  const key = cfg && typeof cfg.icon === 'string' ? cfg.icon.trim().toLowerCase() : '';
  return TOOL_ICON_SVGS[key] || TOOL_ICON_SVGS.generic;
}

// 思考折叠块：控制台和对话共用同一套样式
// 思考中 → 图标 + 扫光「正在思考」；结束后 → 淡色「思考 · 首行摘要」，展开后只留标题
function buildThinkDetails({ think, streaming = false, phase = '', open = false, onToggle = null }) {
  const details = document.createElement('details');
  details.className = 'dsh-think';
  details.open = !!open;
  const summary = document.createElement('summary');
  const thinkingNow = streaming && phase === 'think';
  const snippet = String(think || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l) || '';
  summary.innerHTML =
    THINK_ICON +
    (thinkingNow
      ? '<span class="skeleton-text">正在思考</span>'
      : '<span class="think-label-done">思考</span>') +
    (!thinkingNow && snippet
      ? `<span class="tool-dot">·</span><span class="think-brief">${escapeHtml(snippet)}</span>`
      : '') +
    `<span class="chev">›</span>`;
  const body = document.createElement('div');
  body.className = 'dsh-think-body';
  body.textContent = String(think || '');
  details.append(summary, body);
  details.addEventListener('toggle', () => {
    if (onToggle) onToggle(details.open);
  });
  return details;
}

function ttsAutoRead() {
  return settings.autoRead === true;
}

function ttsSpeed() {
  return clamp(Number(settings.ttsSpeed) || 1, 0.6, 1.6);
}

// 喇叭按钮：没在播就是「朗读」，正在播就是「静音 / 取消静音」。
function refreshSpeakButtons() {
  document.querySelectorAll('.msg-speak').forEach((btn) => {
    const active = !!(tts.kind && btn.dataset.seq === String(tts.msgSeq));
    const muted = active && !!tts.muted;
    btn.classList.toggle('muted', muted);
    btn.title = muted ? '取消静音' : active ? '静音' : '朗读这条回复';
    btn.innerHTML = muted ? MUTE_ICON : SPEAK_ICON;
  });
}

// 正文转朗读稿：把 Markdown 的语法噪音（代码块、链接、标题号、列表符号、强调符）去掉，
// 只留能念出来的句子。SPEAK 降级为可选之后，这是最常见的朗读来源。
function stripForSpeech(src) {
  let s = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  // 代码块整段删掉：没人想听代码
  s = s.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  // 行内代码只留内容
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 链接只留文字，裸 URL 直接去掉
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/<?https?:\/\/\S+>?/g, '');
  // 表格分隔线、纯符号行
  s = s.replace(/^[ \t]*[|: -]{3,}[ \t]*$/gm, '');
  // 行首的标题 / 引用 / 列表符号（有序列表保留数字后面的内容）
  s = s.replace(/^[ \t]*[#>\-*+•]+[ \t]*/gm, '');
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
  // 行内强调符号
  s = s.replace(/[*_~]{1,3}/g, '');
  // 收尾：行尾空格、连续空行、多余空格
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

// 这条回复该念什么：模型给了 SPEAK 台词就只念台词（可选覆盖），
// 没给就把正文清洗成朗读稿，保证「漏写标记」也能正常朗读。
function speakSourceOf(m) {
  const marked = tidyChatText(m && m.speakText);
  if (marked) return marked;
  return stripForSpeech(m && m.text);
}

// 当前语音引擎：插件接管 > 系统语音（可关）> 关闭
function ttsEngine() {
  if (tts.pluginAvailable) return 'plugin';
  return settings.ttsWeb !== false ? 'web' : 'off';
}

function setTtsMuted(next) {
  tts.muted = !!next;
  if (tts.kind === 'web' && 'speechSynthesis' in window) {
    try {
      if (tts.muted) window.speechSynthesis.pause();
      else window.speechSynthesis.resume();
    } catch (_) {
      /* ignore */
    }
  } else if (tts.kind === 'plugin' && tts.audio) {
    tts.audio.muted = tts.muted;
  }
  refreshSpeakButtons();
}

function toggleSpeak(m) {
  if (tts.kind && tts.msgSeq === m.seq) {
    setTtsMuted(!tts.muted);
    return;
  }
  speakText(speakSourceOf(m), m.seq, { raw: m.text, speak: m.speakText });
}

function stopTtsPlayback() {
  if (tts.kind === 'web' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {
      /* ignore */
    }
  }
  if (tts.audio) {
    try {
      tts.audio.pause();
    } catch (_) {
      /* ignore */
    }
    tts.audio = null;
  }
  if (tts.url) {
    URL.revokeObjectURL(tts.url);
    tts.url = '';
  }
  tts.utterance = null;
  tts.kind = null;
  tts.muted = false;
  tts.msgSeq = null;
  refreshSpeakButtons();
}

// 系统语音（Web Speech API）：零依赖，直接用系统 SAPI / 各平台自带语音
function speakWithWeb(content, msgSeq) {
  if (!('speechSynthesis' in window)) {
    toast('系统不支持语音朗读');
    return;
  }
  const utter = new SpeechSynthesisUtterance(content);
  utter.lang = 'zh-CN';
  utter.rate = ttsSpeed();
  tts.kind = 'web';
  tts.utterance = utter;
  tts.msgSeq = msgSeq;
  tts.muted = false;
  refreshSpeakButtons();
  utter.onend = () => {
    if (tts.utterance === utter) stopTtsPlayback();
  };
  utter.onerror = () => {
    if (tts.utterance === utter) stopTtsPlayback();
  };
  try {
    window.speechSynthesis.speak(utter);
  } catch (_) {
    toast('播放失败');
    stopTtsPlayback();
  }
}

function speakWithPluginAudio(res, msgSeq) {
  const bin = atob(res.audio);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // 插件回来的音频格式：mp3 / ogg / aac / wav，未识别按 wav
  const mime =
    { mp3: 'audio/mpeg', ogg: 'audio/ogg', aac: 'audio/aac', wav: 'audio/wav' }[String(res.format || '').toLowerCase()] ||
    'audio/wav';
  tts.url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  tts.audio = new Audio(tts.url);
  tts.kind = 'plugin';
  tts.msgSeq = msgSeq;
  tts.muted = false;
  refreshSpeakButtons();
  tts.audio.onended = () => stopTtsPlayback();
  tts.audio.onerror = () => {
    toast('播放失败');
    stopTtsPlayback();
  };
  return tts.audio.play().catch(() => toast('播放失败'));
}

async function speakText(text, msgSeq = null, meta = {}) {
  const content = String(text || '').trim();
  if (!content || tts.synthesizing) return;
  const engine = ttsEngine();
  if (engine === 'off') {
    toast('语音已关闭');
    return;
  }
  tts.synthesizing = true;
  stopTtsPlayback();
  try {
    if (engine === 'web') {
      speakWithWeb(content, msgSeq);
      return;
    }
    toast('正在合成语音…');
    const res = await petApi.pluginSpeechSynth({
      text: content,
      raw: String(meta && meta.raw ? meta.raw : ''),
      speak: String(meta && meta.speak ? meta.speak : ''),
      character: {
        id: (activeCharacter && activeCharacter.id) || '',
        name: (activeCharacter && activeCharacter.name) || '',
      },
      speed: ttsSpeed(),
    });
    if (!res || !res.ok) {
      const reason = (res && res.error) || '语音合成失败';
      // 单次合成失败（断网、服务拒绝等）也静默回落到系统语音，不打扰用户
      consoleLog('语音', `插件合成失败，回落到系统语音：${reason}`);
      await refreshTtsEngineStatus();
      if (settings.ttsWeb !== false) speakWithWeb(content, msgSeq);
      else toast(reason);
      return;
    }
    await speakWithPluginAudio(res, msgSeq);
  } finally {
    tts.synthesizing = false;
  }
}

function autoReadReply(text, meta = {}) {
  if (!ttsAutoRead() || !String(text || '').trim()) return;
  speakText(text, null, meta);
}

// 语音页只展示「当前用的是谁」，音色 / 语速交给插件自己的配置页
async function refreshTtsEngineStatus() {
  let res = null;
  try {
    res = await petApi.pluginSpeechStatus();
  } catch (_) {
    /* 主进程异常时按「没有插件」处理 */
  }
  tts.pluginAvailable = !!(res && res.ok && res.available);
  tts.pluginName = res && res.plugin ? res.plugin.name || res.plugin.id : '';
  const stateEl = $('#tts-engine-state');
  const toggle = $('#set-tts-web');
  if (stateEl) {
    if (tts.pluginAvailable) {
      stateEl.textContent = `已由插件「${tts.pluginName}」接管`;
    } else if (settings.ttsWeb !== false) {
      stateEl.textContent = 'speechSynthesis' in window ? '系统语音（内置）' : '系统语音不可用（当前环境不支持）';
    } else {
      stateEl.textContent = '已关闭';
    }
    stateEl.classList.toggle('ok', tts.pluginAvailable || settings.ttsWeb !== false);
  }
  if (toggle) {
    toggle.checked = settings.ttsWeb !== false;
    toggle.disabled = tts.pluginAvailable;
    const row = toggle.closest('.setting-row');
    if (row) row.classList.toggle('is-disabled', tts.pluginAvailable);
  }
}

$('#set-tts-web').checked = settings.ttsWeb !== false;
$('#set-tts-web').onchange = (e) => {
  settings.ttsWeb = e.target.checked;
  store.set('agentpet.settings', settings);
  refreshTtsEngineStatus();
  toast(settings.ttsWeb ? '已开启系统语音' : '已关闭系统语音');
};

$('#set-auto-read').checked = ttsAutoRead();
$('#set-auto-read').onchange = (e) => {
  settings.autoRead = e.target.checked;
  store.set('agentpet.settings', settings);
  syncAutoReadUi();
  toast(settings.autoRead ? '已开启自动朗读' : '已关闭自动朗读');
};
refreshTtsEngineStatus();

// 「+」不再维护第二套菜单：直接复用斜杠指令面板，同一个浮层、同一套图标与交互
let plusTogglePending = false;
$('#btn-plus').addEventListener('mousedown', () => {
  // 按下时先记下这一下是「再点一次就关」，避免输入框失焦先把面板关掉
  plusTogglePending = !!(slashState.dom && !slashState.dom.hidden && slashState.source === 'plus');
});
$('#btn-plus').onclick = () => {
  if (plusTogglePending) {
    plusTogglePending = false;
    hideSlashMenu();
    return;
  }
  showSlashCommands(el.chatInput, '', 'plus');
  focusComposerEnd(el.chatInput);
};

function downloadChat() {
  const payload = {
    exportedAt: new Date().toISOString(),
    messages: chatState.messages,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `si-chat-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  consoleLog('系统', '会话已导出为 JSON');
  toast('会话已下载');
}

// 上下文压缩：提示词从 si/app/preset-compress.md 读，改文件即可改规则
// 摘要 + 事实一次返回；摘要进上下文，事实走记忆写入管线（Step 2）
// options.auto = true 表示由「自动压缩」触发：不弹 toast，只写控制台；返回是否成功
async function compressContext(options = {}) {
  const auto = !!(options && options.auto);
  if (chatBusy) {
    if (!auto) toast('这一轮说完再压缩');
    return false;
  }
  const cutoffSeq = chatCutoffSeq();
  const prevSummary = String(store.get('agentpet.compressSummary', '') || '');
  // 压缩点之后的所有消息（按 seq），正文部分转成可读文本
  const pending = chatState.messages.filter((m) => !m.streaming && ensureSeq(m) > cutoffSeq);
  const dialog = pending.filter(
    (m) => (m.role === 'user' || m.role === 'ai') && m.text && String(m.text).trim()
  );
  const speaker = (activeCharacter && activeCharacter.name) || '角色';
  // 压缩请求也会发给模型：图片路径同样换成别名
  const segment = await aliasizeForModel(
    dialog.map((m) => `${m.role === 'user' ? '用户' : speaker}：${m.text}`).join('\n'),
    { bare: true, onlyPaths: sessionImagePaths() },
  );
  if (!segment) {
    if (!auto) toast('没有可压缩的对话');
    return false;
  }

  // 聊天里先插一行「正在压缩」（骨架扫光），出结果后改写；失败 / 无需压缩则移除
  const compactEntry = beginCompact({
    auto,
    dialogCount: dialog.length,
    tokens: estimateTokens(segment),
  });

  let template = '';
  try {
    const res = await petApi.readPresetCompress();
    template = (res && res.text) || '';
  } catch (_) {
    /* 读不到就当没有模板 */
  }
  template = charTemplate(template);
  if (!template.trim()) {
    // 程序不内置压缩提示词：文件缺失/为空就不压缩，交由用户补全
    dropCompact(compactEntry);
    const msg = '未找到压缩提示词，请编辑 si/app/preset-compress.md';
    consoleLog('警告', msg);
    if (!auto) toast(msg, 'warn');
    return false;
  }

  // 复用 KV Cache：原样回放上一次真正发出去的 messages，末尾只追加一条压缩指令。
  // 没有可回放的前缀（刚启动 / 刚压缩过）才退回「整段对话塞进一个请求」。
  const replay = Array.isArray(lastRequestMessages) && lastRequestMessages.length ? lastRequestMessages.slice() : null;
  const earliestPending = pending.length ? ensureSeq(pending[0]) : 0;
  const lastPending = dialog.length ? dialog[dialog.length - 1] : null;
  // 前缀只覆盖「上次请求起点之后」的对话。待压缩内容更早、或最后一条不是 AI 回复时，
  // 回放会漏内容，直接退回整段请求（宁可丢缓存，也不能把旧对话悄悄扔了）。
  const replayCovers =
    !!(
      replay &&
      lastRequestStartSeq > 0 &&
      earliestPending >= lastRequestStartSeq &&
      lastPending &&
      lastPending.role === 'ai'
    );
  if (replayCovers) {
    // 最后一轮 AI 回复不在 request 里（它没有 tool_calls，不会 push 进 apiMessages），
    // 但它是压缩的重要素材，补成 assistant 消息；前缀本身保持不变，缓存照常命中。
    if (String(lastPending.text || '').trim()) {
      replay.push({ role: 'assistant', content: String(lastPending.text).trim() });
    }
  }
  const instruction = template
    .replace(/\{\{SUMMARY\}\}/g, prevSummary || '（无）')
    .replace(/\{\{CHAT\}\}/g, replayCovers ? '（对话内容见上文，不用重复）' : segment);
  const messages = replayCovers
    ? [...replay, { role: 'user', content: instruction }]
    : [{ role: 'system', content: instruction }];

  consoleLog(
    '系统',
    `正在压缩上下文${replayCovers ? '（回放前缀，复用 KV Cache）' : '（整段请求）'}（提示词：si/app/preset-compress.md）`
  );

  const cfg = getApiConfig();
  // 压缩单独用更宽松的无输出等待时长（默认 180s），避免长摘要被按普通对话的 60s 掐断
  const compressIdleMs = settings.llmIdleTimeoutOn
    ? clamp(Math.round(Number(settings.compressIdleTimeoutSec) || 180) * 1000, 30000, 600000)
    : 0;
  let result;
  try {
    if (cfg.builtin || cfg.id === 'mock' || !cfg.key) {
      // mock / 未配置模型：不编造摘要，直接留最近 12 行原文；也不产生事实
      result = { summary: segment.split('\n').slice(-12).join('\n'), facts: [] };
    } else {
      let acc;
      try {
        acc = await callLLM(messages, {
          tools: activeLLMTools(),
          toolChoice: 'none',
          temperature: 0.2,
          idleMs: compressIdleMs,
        });
      } catch (err) {
        // 个别 OpenAI 兼容服务不支持 tool_choice=none：退回不带工具的请求
        if (/tool_choice|not support/i.test(String(err && err.message ? err.message : err))) {
          consoleLog('警告', '当前模型不支持 tool_choice=none，退回不带工具的压缩请求');
          acc = await callLLM(messages, { temperature: 0.2, idleMs: compressIdleMs });
        } else {
          throw err;
        }
      }
      result = parseCompressResult(acc.content);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    consoleLog('错误', `压缩失败：${msg}`);
    updateCompact(compactEntry, { phase: 'error', error: msg.slice(0, 200) });
    if (!auto) toast('压缩失败');
    return false;
  }
  if (result.skip) {
    if (auto) consoleLog('系统', '自动压缩：这段对话还不需要压缩');
    else toast('这段对话无需压缩');
    dropCompact(compactEntry);
    return false;
  }
  const summary = result.summary;
  if (!summary) {
    if (!auto) toast('压缩没有返回摘要');
    updateCompact(compactEntry, { phase: 'error', error: '压缩没有返回摘要' });
    return false;
  }

  const nextCutoffSeq = pending.reduce((max, m) => Math.max(max, ensureSeq(m)), cutoffSeq);
  store.set('agentpet.compressSummary', summary);
  store.set('agentpet.compressCutoffSeq', nextCutoffSeq);
  // 聊天里的那一行改成结果：已压缩 N 条（约 X tokens），展开能看摘要
  updateCompact(compactEntry, { phase: 'done', summary });
  store.set('agentpet.compressCutoff', 0);
  // 摘要同时进「记忆库 → 归档」（Step 5 会被 SQLite 记忆库替代）
  const archived = addMemoryArchive(summary);
  // 压缩点已经前移，下一次压缩要用新的请求前缀
  lastRequestMessages = null;
  lastRequestStartSeq = 0;
  if (archived) renderMemArchive();
  // 控制台 / 聊天里已经有「压缩上下文」这一行（含摘要），这里不再重复打一条系统日志
  if (auto) consoleLog('系统', '自动压缩完成，下一轮继续');
  else toast('上下文已压缩', 'accent');

  // 写入管线异步执行（不阻塞对话）；首次会按需下载 embedding 模型，进度在设置页底栏
  const facts = (result.facts || []).filter((f) => f && (f.fact || f.object)).slice(0, 50);
  if (!facts.length) return true;
  if (!window.petApi || typeof petApi.memoryCall !== 'function') return true;
  consoleLog('记忆', `正在写入 ${facts.length} 条事实（首次会下载向量模型）…`);
  petApi
    .memoryCall('upsertFacts', {
      facts,
      turn: currentTurnSeq || 0,
      sourceText: segment.slice(0, 400),
    })
    .then((res) => {
      consoleLog(
        '记忆',
        `写入完成：新增 ${res.inserted} · 哈希合并 ${res.mergedHash} · 向量合并 ${res.mergedVector}` +
          (res.rejected ? ` · 丢弃 ${res.rejected}` : '') +
          `（共 ${res.keys.length} 条主键，向量化 ${Math.round(res.embedMs || 0)}ms）`
      );
    })
    .catch((err) => {
      consoleLog('警告', `记忆写入失败：${err && err.message ? err.message : err}`);
      toast('记忆写入失败', 'warn');
    });
  return true;
}


// ------------------------------------------------------------------ 面板开关
function closeAllPanels(except = '') {
  if (except !== 'action') {
    el.actionPanel.classList.remove('show');
    $('#btn-action').classList.remove('active');
  }
  if (except !== 'chat') {
    el.chatPanel.classList.remove('show');
    $('#btn-chat').classList.remove('active');
    if (slashState.editor === el.chatInput) hideSlashMenu();
  }
  if (except !== 'settings') {
    el.settingsPanel.classList.remove('show');
    $('#btn-settings').classList.remove('active');
  }
  if (except !== 'picker') closePicker();
}

// 队列面板留在主窗口里；「添加动作」才用独立窗口
$('#btn-action').onclick = () => {
  const open = el.actionPanel.classList.contains('show');
  closeAllPanels(open ? '' : 'action');
  if (!open) {
    el.actionPanel.classList.add('show');
    $('#btn-action').classList.add('active');
    renderQueue(queue ? queue.snapshot() : null);
  }
};

$('#btn-chat').onclick = () => {
  const open = el.chatPanel.classList.contains('show');
  closeAllPanels(open ? '' : 'chat');
  if (!open) {
    el.chatPanel.classList.add('show');
    $('#btn-chat').classList.add('active');
    renderChat();
    setTimeout(() => el.chatInput.focus(), 200);
  }
};

$('#close-chat').onclick = () => {
  el.chatPanel.classList.remove('show');
  $('#btn-chat').classList.remove('active');
  if (slashState.editor === el.chatInput) hideSlashMenu();
};

$('#btn-settings').onclick = () => {
  const open = el.settingsPanel.classList.contains('show');
  closeAllPanels(open ? '' : 'settings');
  if (!open) {
    // 设置页只按默认尺寸布局，窗口被压窄过就先恢复
    if (!IS_PANEL && window.petApi && window.petApi.resetWindowSize) window.petApi.resetWindowSize();
    el.settingsPanel.classList.add('show');
    $('#btn-settings').classList.add('active');
  }
};

$('#close-settings').onclick = () => {
  el.settingsPanel.classList.remove('show');
  $('#btn-settings').classList.remove('active');
};

// 托盘菜单「设置」：主进程把窗口叫出来之后发这个命令
if (!IS_PANEL && window.petApi && window.petApi.onOpenSettings) {
  window.petApi.onOpenSettings(() => openSettingsPage('performance'));
}

// 缩放中心：Dock 上按一下弹出小浮层，滑动条即时生效（和设置页同一个状态）
const pivotPop = $('#pivot-pop');
const pivotPopBtn = $('#btn-pivot');
const pivotDockInput = $('#set-pivot-dock');

if (pivotPopBtn && pivotPop) {
  pivotPopBtn.onclick = (e) => {
    e.stopPropagation();
    const open = pivotPop.hidden;
    pivotPop.hidden = !open;
    pivotPopBtn.classList.toggle('active', open);
    if (open) {
      // 浮层对准按钮中心，靠近窗口边缘时自动往里收
      const btnBox = pivotPopBtn.getBoundingClientRect();
      const dockBox = pivotPop.parentElement.getBoundingClientRect();
      const half = 110;
      const x = btnBox.left - dockBox.left + btnBox.width / 2;
      pivotPop.style.left = `${Math.round(clamp(x, half + 8, dockBox.width - half - 8))}px`;
      syncModelControls();
    }
  };
  // 点浮层外面就收起
  document.addEventListener('pointerdown', (e) => {
    if (pivotPop.hidden) return;
    if (pivotPop.contains(e.target) || pivotPopBtn.contains(e.target)) return;
    pivotPop.hidden = true;
    pivotPopBtn.classList.remove('active');
  });
}

if (pivotDockInput) {
  pivotDockInput.oninput = (e) => {
    settings.scalePivot = clamp(Number(e.target.value) / 100, 0, 1);
    applyModelTransform();
  };
  pivotDockInput.onchange = () => store.set('agentpet.settings', settings);
}

// 背景切换：Dock 最左边的按钮弹出小浮层，深色 / 半透明面板 / 毛玻璃 / 全透明（只看桌宠）
const bgPop = $('#bg-pop');
const bgPopBtn = $('#btn-bg');
const bgGlassBox = $('#bg-glass-opts');
const bgGlassMat = $('#bg-glass-material');
const bgGlassOpacity = $('#bg-glass-opacity');
const bgGlassOpacityV = $('#bg-glass-v');
const BG_MODES = ['frosted', 'glass', 'clear'];
const BG_TOAST = { dark: '背景：深色', frosted: '背景：半透明面板', glass: '背景：毛玻璃', clear: '背景：全透明（只看桌宠）' };

function currentBgMode() {
  return BG_MODES.includes(settings.background) ? settings.background : 'dark';
}

function glassMaterialValue() {
  return settings.glassMaterial === 'mica' ? 'mica' : 'acrylic';
}

function glassOpacityValue() {
  const n = Number(settings.glassOpacity);
  return Number.isFinite(n) ? Math.min(0.85, Math.max(0.1, n)) : 0.45;
}

// 主进程按这份配置建窗：毛玻璃（不透明 + 系统材质）与全透明桌宠窗口互斥，改动后重启才真正换窗口
function persistAppearance() {
  if (IS_PANEL || !window.petApi || !window.petApi.setAppearance) return;
  window.petApi.setAppearance({
    background: currentBgMode(),
    glassMaterial: glassMaterialValue(),
    glassOpacity: glassOpacityValue(),
  });
}

// 当前窗口是不是毛玻璃材质：启动时由主进程决定
// runtimeMaterial：这台机器是否支持系统材质（Win11 22H2+），不支持的平台退化为半透明模糊
let runtimeGlass = false;
let runtimeMaterial = true;
if (!IS_PANEL && window.petApi && window.petApi.getAppearance) {
  window.petApi
    .getAppearance()
    .then((r) => {
      runtimeGlass = !!(r && r.glass);
      runtimeMaterial = !(r && r.material === false);
      applyBackground();
    })
    .catch(() => {});
}

function applyBackground() {
  const mode = currentBgMode();
  settings.background = mode;
  const glassMode = mode === 'glass';
  el.app.classList.toggle('frosted', mode === 'frosted');
  el.app.classList.toggle('glass', glassMode && runtimeMaterial);
  el.app.classList.toggle('glass-fallback', glassMode && !runtimeMaterial);
  el.app.classList.toggle('bg-clear', mode === 'clear');
  // 毛玻璃浓度：叠在系统材质上的暗色层，保证文字对比
  el.app.style.setProperty('--glass-tint', String(glassOpacityValue()));
  // 换回别的背景时，托盘临时唤出的工具栏一并复位
  if (mode !== 'clear') el.app.classList.remove('toolbar-forced');
  if (bgGlassBox) {
    bgGlassBox.hidden = mode !== 'glass';
    if (mode === 'glass') {
      const pct = Math.round(glassOpacityValue() * 100);
      if (bgGlassMat) bgGlassMat.value = glassMaterialValue();
      if (bgGlassOpacity) bgGlassOpacity.value = String(pct);
      if (bgGlassOpacityV) bgGlassOpacityV.textContent = `${pct}%`;
    }
  }
  if (bgPop) {
    bgPop.querySelectorAll('.dock-pop-opt').forEach((opt) => {
      opt.classList.toggle('active', opt.dataset.bg === mode);
    });
  }
}

if (bgPopBtn && bgPop) {
  bgPopBtn.onclick = (e) => {
    e.stopPropagation();
    const open = bgPop.hidden;
    bgPop.hidden = !open;
    bgPopBtn.classList.toggle('active', open);
    if (open) {
      // 两个浮层互斥，避免叠在一起
      if (pivotPop) {
        pivotPop.hidden = true;
        if (pivotPopBtn) pivotPopBtn.classList.remove('active');
      }
      const btnBox = bgPopBtn.getBoundingClientRect();
      const dockBox = bgPop.parentElement.getBoundingClientRect();
      const half = 116;
      const x = btnBox.left - dockBox.left + btnBox.width / 2;
      bgPop.style.left = `${Math.round(clamp(x, half + 8, dockBox.width - half - 8))}px`;
      applyBackground();
    }
  };
  // 点浮层外面就收起
  document.addEventListener('pointerdown', (e) => {
    if (bgPop.hidden) return;
    if (bgPop.contains(e.target) || bgPopBtn.contains(e.target)) return;
    bgPop.hidden = true;
    bgPopBtn.classList.remove('active');
  });
  bgPop.querySelectorAll('.dock-pop-opt').forEach((opt) => {
    opt.onclick = () => {
      const mode = opt.dataset.bg;
      const wasGlass = runtimeGlass;
      settings.background = mode;
      store.set('agentpet.settings', settings);
      applyBackground();
      persistAppearance();
      bgPop.hidden = true;
      bgPopBtn.classList.remove('active');
      // 透明窗口和系统材质窗口只能二选一，跨过这条线就要提示重启；
      // 没有系统材质的平台（Win10）根本不会换窗口类型，切换即时生效
      if (runtimeMaterial && (mode === 'glass') !== wasGlass) {
        if (!IS_PANEL && window.petApi && window.petApi.promptAppearanceRestart) {
          window.petApi.promptAppearanceRestart();
        } else {
          toast('毛玻璃背景将在下次启动生效');
        }
        return;
      }
      toast(BG_TOAST[mode] || '背景已切换');
    };
  });
}

// 毛玻璃参数：材质在毛玻璃窗口下由主进程即时切换；浓度只改页面叠色，立即生效
if (bgGlassMat) {
  bgGlassMat.onchange = () => {
    settings.glassMaterial = bgGlassMat.value === 'mica' ? 'mica' : 'acrylic';
    store.set('agentpet.settings', settings);
    persistAppearance();
  };
}
if (bgGlassOpacity) {
  bgGlassOpacity.oninput = () => {
    settings.glassOpacity = Math.min(0.85, Math.max(0.1, Number(bgGlassOpacity.value) / 100));
    el.app.style.setProperty('--glass-tint', String(glassOpacityValue()));
    if (bgGlassOpacityV) bgGlassOpacityV.textContent = `${bgGlassOpacity.value}%`;
  };
  bgGlassOpacity.onchange = () => {
    store.set('agentpet.settings', settings);
    persistAppearance();
  };
}

// 托盘菜单「显示 / 隐藏工具栏」：全透明模式下把底栏临时唤回来
if (window.petApi && window.petApi.onToggleToolbar) {
  window.petApi.onToggleToolbar(() => {
    el.app.classList.toggle('toolbar-forced');
  });
}

// 主界面喇叭 = 自动朗读开关（和设置里的「自动朗读」同一份状态）
function syncAutoReadUi() {
  const btn = $('#btn-voice');
  if (!btn) return;
  btn.classList.toggle('active', settings.autoRead === true);
  btn.title = settings.autoRead ? '自动朗读：开（点击关闭）' : '自动朗读：关（点击开启）';
}
$('#btn-voice').onclick = () => {
  settings.autoRead = !settings.autoRead;
  store.set('agentpet.settings', settings);
  $('#set-auto-read').checked = settings.autoRead;
  syncAutoReadUi();
  toast(settings.autoRead ? '已开启自动朗读' : '已关闭自动朗读');
};
syncAutoReadUi();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !IS_PANEL) {
    closeAllPanels();
  }
});

// ------------------------------------------------------------------ 设置页
function openSettingsPage(page) {
  closeAllPanels('settings');
  // 设置页只按默认尺寸布局，窗口被压窄过就先恢复
  if (!IS_PANEL && window.petApi && window.petApi.resetWindowSize) window.petApi.resetWindowSize();
  el.settingsPanel.classList.add('show');
  $('#btn-settings').classList.add('active');
  switchSettingsPage(page);
}

function switchSettingsPage(page) {
  $$('.settings-nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  $$('.settings-page').forEach((p) => p.classList.toggle('active', p.dataset.page === page));
  if (page === 'console') {
    renderConsole();
    // 打开控制台时直接落到最新一条，避免上次的滚动位置停在半空
    requestAnimationFrame(() => {
      if (el.consoleLog) el.consoleLog.scrollTop = el.consoleLog.scrollHeight;
      updateConsoleJump();
    });
  }
  if (page === 'memory') renderMemories();
  if (page === 'injection') setInjectTab(injectState.tab);
  if (page === 'archive') {
    closeArchive();
    renderArchives();
  }
  if (page === 'preset') {
    renderPreset();
  }
  if (page === 'tools') renderToolManage();
  if (page === 'plugins') {
    pluginState.detailId = null;
    loadPlugins();
    loadProcList();
  }
  if (page === 'model') {
    renderModels();
    renderSearchPanel();
  }
  if (page === 'stats') renderStatsPage();
  if (page === 'voice') {
    renderVoiceStatus();
    refreshTtsEngineStatus();
  }
  if (page !== 'plugins') procState.collapsed = true;
  syncProcWatch();
}

$$('.settings-nav-item').forEach((item) => {
  item.onclick = () => switchSettingsPage(item.dataset.page);
});

// ------------------------------------------------------------------ 共用任务条（只在设置页底部）
// 主进程把所有耗时任务（下载 / 解压 / 启动服务 / 合成…）推到 task:update，
// 这里只显示最新在跑的一条：「正在下载 XXX」+ 百分比，结束后停一会儿自动收起。
const taskState = new Map();
let taskBarTimer = null;

function taskBarNodes() {
  return {
    bar: $('#settings-taskbar'),
    version: $('#taskbar-version'),
    title: $('#taskbar-title'),
    detail: $('#taskbar-detail'),
    pct: $('#taskbar-pct'),
    fill: $('#taskbar-fill'),
    cancel: $('#taskbar-cancel'),
  };
}

// 常驻底栏：没有任务时也显示，左边版本号（配置里的 appVersion），中间「空闲」。
function renderTaskBar() {
  const { bar, version, title, detail, pct, fill, cancel } = taskBarNodes();
  if (!bar) return;
  if (version) {
    const v = (appConfig && appConfig.appVersion) || '0.1.0';
    version.textContent = `v${v}`;
  }
  const all = [...taskState.values()];
  const running = all.filter((t) => t.status === 'running');
  const finished = all
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const task = running.length ? running[running.length - 1] : finished[0];
  if (!task) {
    bar.dataset.status = 'idle';
    bar.dataset.taskId = '';
    title.textContent = '空闲';
    detail.textContent = '';
    if (pct) pct.textContent = '';
    fill.classList.remove('indeterminate');
    fill.style.width = '0';
    if (cancel) cancel.hidden = true;
    return;
  }
  bar.dataset.status = task.status;
  bar.dataset.taskId = task.id;
  title.textContent = task.title || '';
  detail.textContent = task.detail || '';
  const known = typeof task.percent === 'number';
  fill.classList.toggle('indeterminate', !known && task.status === 'running');
  fill.style.width = known ? `${task.percent}%` : '38%';
  if (pct) {
    pct.textContent =
      task.status === 'error' ? '失败' : task.status === 'done' ? '完成' : known ? `${task.percent}%` : '';
  }
  if (cancel) cancel.hidden = !(task.status === 'running' && task.cancelable);
}

function applyTaskEvent(payload) {
  if (!payload) return;
  if (payload.kind === 'gone') {
    taskState.delete(payload.id);
  } else if (payload.kind === 'update' && payload.task) {
    const task = payload.task;
    taskState.set(task.id, task);
    if (task.status !== 'running') {
      clearTimeout(taskBarTimer);
      taskBarTimer = setTimeout(() => {
        taskState.delete(task.id);
        renderTaskBar();
      }, 5000);
    }
  }
  renderTaskBar();
}

function subscribeTasks() {
  if (IS_PANEL || !window.petApi) return;
  if (window.petApi.onTaskUpdate) window.petApi.onTaskUpdate(applyTaskEvent);
  if (window.petApi.taskList) {
    window.petApi
      .taskList()
      .then((list) => {
        (list || []).forEach((t) => taskState.set(t.id, t));
        renderTaskBar();
      })
      .catch(() => {
        /* 主进程还没起来时忽略 */
      });
  }
  const cancelBtn = $('#taskbar-cancel');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      const bar = $('#settings-taskbar');
      const id = bar && bar.dataset.taskId;
      if (id && window.petApi.taskCancel) window.petApi.taskCancel(id);
    };
  }
}

// ---- 角色卡片（图标 + 名字，选中描边，末尾固定一张「导入」）
function renderCharacterCards() {
  const row = $('#char-row');
  if (!row) return;
  const list = (appConfig && Array.isArray(appConfig.characters) ? appConfig.characters : []).filter((c) => c && c.id);
  const activeId = (activeCharacter && activeCharacter.id) || (appConfig && appConfig.defaultCharacter) || '';
  row.textContent = '';
  for (const ch of list) {
    const card = document.createElement('div');
    card.className = 'char-card' + (ch.id === activeId ? ' active' : '') + (ch.broken ? ' broken' : '');
    card.dataset.id = ch.id;
    card.title = ch.broken ? `${ch.name || ch.id}（内核入口缺失）` : ch.name || ch.id;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onCharacterCard(ch);
    };

    const box = document.createElement('span');
    box.className = 'char-icon';
    const initial = (ch.name || ch.id).slice(0, 1);
    const iconUrl = ch.icon ? configPath(ch.icon) : '';
    if (iconUrl) {
      const img = document.createElement('img');
      img.alt = ch.name || ch.id;
      img.draggable = false;
      // 图标缺失 / 加载失败时退回首字，别留一个破图
      img.onerror = () => {
        box.classList.add('char-icon-letter');
        box.textContent = initial;
      };
      img.src = iconUrl;
      box.appendChild(img);
    } else {
      box.classList.add('char-icon-letter');
      box.textContent = initial;
    }

    const name = document.createElement('span');
    name.className = 'char-name';
    name.textContent = ch.name || ch.id;
    card.append(box, name);
    card.onclick = () => onCharacterCard(ch);

    // 「⋯」只看详情，不触发切换
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'char-more';
    more.title = '角色详情';
    more.textContent = '⋯';
    more.onclick = (e) => {
      e.stopPropagation();
      toggleCharDetail(ch.id);
    };
    card.appendChild(more);
    if (ch.broken) {
      const badge = document.createElement('span');
      badge.className = 'char-badge-broken';
      badge.textContent = '入口缺失';
      card.appendChild(badge);
    }
    row.appendChild(card);
  }

  const imp = document.createElement('button');
  imp.type = 'button';
  imp.className = 'char-card import';
  imp.id = 'btn-import-character';
  imp.title = '导入角色包';
  imp.innerHTML =
    '<span class="char-icon"><svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg></span>' +
    '<span class="char-name">导入</span>';
  imp.onclick = async () => {
    if (!window.petApi || !window.petApi.importCharacter) {
      toast('当前窗口不支持导入角色');
      return;
    }
    if (imp.disabled) return;
    imp.disabled = true;
    const hadActive = !!activeCharacter;
    try {
      const res = await window.petApi.importCharacter();
      if (!res || res.canceled) return;
      if (!res.ok) {
        toast(res.error || '导入失败');
        return;
      }
      // 重新拉配置：新角色会立即出现在卡片列表里（切换仍是下一阶段）
      await loadAppConfig();
      // 首次导入（此前没有任何角色）：新角色会被自动设为当前角色，直接把内核挂起来
      if (!hadActive && activeCharacter) {
        await loadChatSession();
        await fetchActions(true);
        presetPersonaDirty = false;
        await loadPresetPersona();
        syncRenderBackendUi();
        renderChat();
        if (!IS_PANEL) mountKernel(currentKernelEntry());
      }
      renderExtensionPage();
      toast(`已导入角色：${(res.character && res.character.name) || res.id}`);
    } catch (err) {
      toast(`导入失败：${err && err.message ? err.message : err}`);
    } finally {
      imp.disabled = false;
    }
  };
  row.appendChild(imp);
}

// 切换防抖：切换过程里再点卡片直接忽略
let characterSwitching = false;

async function onCharacterCard(ch) {
  if (!ch || !ch.id) return;
  if (activeCharacter && ch.id === activeCharacter.id) return;
  if (characterSwitching) return;
  if (!window.petApi || !window.petApi.switchCharacter) {
    toast('当前窗口不支持切换角色');
    return;
  }
  // busy 门闩：对话 / 自动压缩 / 控制台生成中不允许换角色
  if (chatBusy || autoCompressRunning || consoleState.busy) {
    toast('对话还在运行，结束后再切换角色');
    return;
  }

  const prevId = (activeCharacter && activeCharacter.id) || '';
  const prevName = charNameText() || '当前角色';
  const toName = ch.name || ch.id;
  let switched = false;
  characterSwitching = true;
  consoleLog('系统', `切换角色：${prevName} → ${toName}`);
  // 开关打开时，先把当前会话存入归档（默认关闭，当前会话本身仍留在原角色）
  if (settings.archiveOnSwitch && archiveCurrentChat()) {
    await saveArchives();
    consoleLog('系统', '当前会话已归档');
  }
  // 先把旧角色的会话落盘：切换后主进程的 activeCharacter 就变了
  await flushChatSession();
  // 再卸内核：队列一并清空，旧角色残留的动作不会再推进
  releaseKernel();
  try {
    const res = await window.petApi.switchCharacter(ch.id);
    if (!res || !res.ok) throw new Error((res && res.error) || '切换失败');
    switched = true;
    // 重新装配：角色名 / 会话 / 动作库 / 内核入口 / 记忆库都按新角色来
    await loadAppConfig();
    applyUiNames();
    // 人设跟着角色走：重新读新角色目录里的 persona.md
    presetPersonaDirty = false;
    await loadPresetPersona();
    await loadChatSession();
    // 情感档案跟着角色目录走：先把旧角色防抖中的状态落盘，再读新角色的 emotion.json
    if (prevId && window.petApi && petApi.flushEmotion) {
      try {
        await petApi.flushEmotion({ id: prevId });
      } catch (_) {
        /* 旧状态落盘失败不影响切换 */
      }
    }
    emotionRuntime.loadedFor = '';
    emotionRuntime.state = null;
    emotionRuntime.lastRoll = null;
    emotionRuntime.lastMood = null;
    if (emotionRuntime.classifier) emotionRuntime.classifier.resetCooldowns();
    await loadEmotionState({ force: true });
    // fetchActions(true) 内部会先刷新 actions.json 的中文名与分类
    await fetchActions(true);
    // 开关打开时，相当于自动按一次「从动作库重建」：用新角色的动作清单覆盖 preset-actions.md
    if (settings.rebuildActionsOnSwitch) {
      await rebuildActionsPreset();
      consoleLog('系统', `已按新角色动作库重建 ACTIONS（${actions.length} 条）`);
    }
    void loadMemoryDb({ silent: true });
    syncRenderBackendUi();
    renderChat();
    renderConsole();
    renderExtensionPage();
    if (!IS_PANEL) mountKernel(currentKernelEntry());
    toast(`已切换到 ${toName}`, 'accent');
    consoleLog('系统', `角色已切换：${toName} · 动作 ${actions.length} 个`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    consoleLog('错误', `切换角色失败：${msg}`);
    toast(`切换失败：${msg}`);
    // 主进程已经切过去的话先切回来，再按原角色重挂内核
    if (switched && prevId) {
      try {
        await window.petApi.switchCharacter(prevId);
      } catch (_) {
        /* 回滚失败也继续恢复渲染，日志里已有记录 */
      }
    }
    await loadAppConfig();
    applyUiNames();
    presetPersonaDirty = false;
    await loadPresetPersona();
    await loadChatSession();
    await fetchActions(true);
    syncRenderBackendUi();
    renderExtensionPage();
    renderChat();
    if (!IS_PANEL) mountKernel(currentKernelEntry());
  } finally {
    characterSwitching = false;
  }
}

// ---- 角色详情：点卡片右上角「⋯」展开，只查看不切换
let charDetailId = '';
let charDetailState = null;

function findCharacter(id) {
  const list = appConfig && Array.isArray(appConfig.characters) ? appConfig.characters : [];
  return list.find((c) => c && c.id === id) || null;
}

function toggleCharDetail(id) {
  charDetailId = charDetailId === id ? '' : id;
  charDetailState = null;
  renderCharDetail();
  if (charDetailId) {
    const content = $('.settings-content');
    if (content) content.scrollTop = 0;
    void loadCharDetail(charDetailId);
  }
}

async function loadCharDetail(id) {
  if (!window.petApi || !window.petApi.validateCharacter) {
    charDetailState = { error: '当前窗口不支持角色校验' };
    renderCharDetail();
    return;
  }
  charDetailState = { loading: true };
  renderCharDetail();
  let info = null;
  try {
    info = await window.petApi.validateCharacter(id);
  } catch (err) {
    info = { ok: false, broken: true, error: String(err && err.message ? err.message : err), issues: [], warnings: [] };
  }
  if (charDetailId !== id) return;
  charDetailState = { info };
  renderCharDetail();
}

async function refreshCharDetail() {
  const id = charDetailId;
  if (!id) return;
  await loadAppConfig();
  renderExtensionPage();
  if (charDetailId === id) await loadCharDetail(id);
}

function renderCharDetail() {
  const browser = $('#char-browser');
  const page = $('#char-detail');
  const box = $('#char-detail-body');
  const actionsCard = $('#char-actions-card');
  if (!page || !box) return;
  const ch = findCharacter(charDetailId);
  if (!charDetailId || !ch) {
    page.hidden = true;
    box.textContent = '';
    if (browser) browser.hidden = false;
    if (actionsCard) actionsCard.hidden = true;
    return;
  }
  if (browser) browser.hidden = true;
  page.hidden = false;
  box.textContent = '';

  const state = charDetailState || {};
  const info = state.info || null;
  const isActive = !!(activeCharacter && activeCharacter.id === ch.id);
  const broken = !!ch.broken || !!(info && info.broken);

  // 头部：左边图标与角色信息，右边操作，窄窗口自动换行
  const head = document.createElement('div');
  head.className = 'plugin-detail-head char-detail-head';

  const icon = document.createElement('div');
  icon.className = 'plugin-detail-icon';
  const initial = (ch.name || ch.id).slice(0, 1);
  const iconUrl = ch.icon ? configPath(ch.icon) : '';
  if (iconUrl) {
    const img = document.createElement('img');
    img.alt = ch.name || ch.id;
    img.draggable = false;
    // 图标缺失 / 加载失败时退回首字
    img.onerror = () => {
      icon.textContent = initial;
      icon.classList.add('char-hero-letter');
    };
    img.src = iconUrl;
    icon.appendChild(img);
  } else {
    icon.textContent = initial;
    icon.classList.add('char-hero-letter');
  }

  const titleWrap = document.createElement('div');
  titleWrap.className = 'char-detail-title';
  const name = document.createElement('h2');
  name.textContent = ch.name || ch.id;
  const badge = document.createElement('span');
  badge.className = 'ext-current' + (broken ? ' danger' : '');
  badge.textContent = broken ? '入口缺失' : isActive ? '当前角色' : '未启用';
  titleWrap.append(name, badge);

  const idLine = document.createElement('div');
  idLine.className = 'plugin-detail-id';
  idLine.textContent = `${ch.id}${ch.version ? ` · v${ch.version}` : ''}`;

  const meta = document.createElement('div');
  meta.className = 'char-detail-meta';
  meta.append(titleWrap, idLine);

  const actions = document.createElement('div');
  actions.className = 'ext-actions';
  const addBtn = (label, cls, onClick, disabled, hint) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.textContent = label;
    btn.disabled = !!disabled;
    if (hint) btn.title = hint;
    btn.onclick = onClick;
    actions.appendChild(btn);
    return btn;
  };

  addBtn('刷新', 'btn-ghost-sm', () => void refreshCharDetail(), !!state.loading, '重新扫描角色列表并校验');
  addBtn('打开目录', 'btn-ghost-sm', async () => {
    const r = await window.petApi.openCharacterDir(ch.id);
    if (r && !r.ok) toast(r.error || '打开目录失败', 'warn');
  });
  addBtn(
    '导出',
    'btn-ghost-sm',
    async () => {
      const r = await window.petApi.exportCharacter(ch.id);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast(r.error || '导出失败', 'warn');
        return;
      }
      toast('角色包已导出', 'accent');
      consoleLog('系统', `已导出角色包：${r.path}`);
    },
  );
  if (!isActive && !broken) {
    addBtn('切换到此角色', 'btn-save', () => void onCharacterCard(ch), characterSwitching);
  }
  addBtn(
    '删除',
    'btn-ghost-sm danger',
    async () => {
      if (!(await openDeleteCharModal(ch))) return;
      const r = await window.petApi.deleteCharacter(ch.id);
      if (!r || !r.ok) {
        toast((r && r.error) || '删除失败', 'warn');
        return;
      }
      charDetailId = '';
      charDetailState = null;
      await loadAppConfig();
      renderExtensionPage();
      toast(`已删除 ${ch.name || ch.id}`, 'accent');
    },
    isActive,
    isActive ? '当前角色不可删除，请先切换到其他角色' : '',
  );

  head.append(icon, meta, actions);
  box.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'char-detail-grid';
  const addRow = (label, value, cls) => {
    const row = document.createElement('div');
    row.className = 'char-detail-row';
    const k = document.createElement('span');
    k.className = 'char-detail-k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'char-detail-v' + (cls ? ` ${cls}` : '');
    v.textContent = value;
    v.title = value;
    row.append(k, v);
    grid.appendChild(row);
  };

  const src = ch.actionsSource || {};
  const manifest = info && info.manifest;
  let manifestText = '—';
  if (state.loading) {
    manifestText = '正在校验…';
  } else if (manifest) {
    const mb = manifest.bytes ? `${(manifest.bytes / 1024 / 1024).toFixed(1)} MB` : '';
    manifestText = [`v${manifest.version || '0.0.0'}`, manifest.sha256 ? `#${String(manifest.sha256).slice(0, 12)}` : '', manifest.files ? `${manifest.files} 文件` : '', mb]
      .filter(Boolean)
      .join(' · ');
    if (!manifest.matches) manifestText += '（与清单不一致）';
  } else if (info && info.ok) {
    manifestText = '未找到清单';
  }

  addRow('角色 ID', ch.id);
  addRow('版本', ch.version || '—');
  addRow('目录', (info && info.dir) || ch.dir || '—');
  addRow('内核入口', (info && info.entry) || (ch.kernel && ch.kernel.entry) || '—');
  addRow(
    '动作来源',
    src.mode === 'index' ? `动作清单 ${src.index || '—'}` : `clips 目录 ${ch.clips || '—'}`,
  );
  addRow('内核清单', manifestText);
  addRow('状态', broken ? '入口缺失，无法切换' : isActive ? '当前使用中' : '可切换', broken ? 'danger' : '');
  box.appendChild(grid);

  if (!isActive && !broken) {
    const tip = document.createElement('p');
    tip.className = 'ext-hint';
    tip.textContent = '下面的动作库为只读统计；导入、刷新与打开目录只作用于当前角色，切换到此角色后可管理。';
    box.appendChild(tip);
  }

  const notes = [];
  if (state.error) notes.push({ text: state.error, kind: 'danger' });
  ((info && info.issues) || []).forEach((text) => notes.push({ text, kind: 'danger' }));
  ((info && info.warnings) || []).forEach((text) => notes.push({ text, kind: 'warn' }));
  if (notes.length) {
    const list = document.createElement('div');
    list.className = 'char-detail-notes';
    notes.forEach((n) => {
      const line = document.createElement('div');
      line.className = `char-detail-note ${n.kind}`;
      line.textContent = n.text;
      list.appendChild(line);
    });
    box.appendChild(list);
  }

  // 动作卡：当前角色可管理；其他角色只读显示动作数量与来源
  if (actionsCard) {
    actionsCard.hidden = false;

    const countEl = $('#ext-actions-current');
    if (countEl) {
      const readOnly = isActive ? null : info && info.actions ? Number(info.actions.count) : null;
      if (isActive) {
        countEl.textContent = `${actions.length} 个动作`;
      } else if (state.loading) {
        countEl.textContent = '统计中…';
      } else if (Number.isFinite(readOnly)) {
        countEl.textContent = `${readOnly} 个动作（只读）`;
      } else {
        countEl.textContent = '— 个动作';
      }
    }

    const hintEl = $('#ext-actions-hint');
    if (hintEl) {
      const src = ch.actionsSource || {};
      if (!isActive) {
        hintEl.textContent = '该角色的动作库只读显示；导入、刷新与打开目录只作用于当前角色，切换到此角色后即可管理。';
      } else if (src.mode === 'index') {
        hintEl.textContent = `来源：动作清单 ${src.index || 'clips/_index.json'}。清单里的名字就是全部可用动作，不再扫描 .glb；时长与循环标记也从清单读取。`;
      } else {
        const missing = actions.filter((a) => a.missing).length;
        hintEl.textContent = `来源：clips 目录里的 .glb${missing ? `（${missing} 条清单记录缺文件，不会出现在模型的动作清单里）` : ''}。也可以直接导入 .json 动作列表。`;
      }
    }

    ['btn-import-actions', 'btn-import-action-list', 'btn-refresh-actions', 'btn-open-clips'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = !isActive;
      btn.title = isActive ? '' : '仅当前角色可管理动作';
    });
  }
}

// ---- 角色页（动作 / 角色卡片）
function renderExtensionPage() {
  renderCharacterCards();
  renderCharDetail();
}


const btnCharBack = $('#btn-char-back');
if (btnCharBack) {
  btnCharBack.onclick = () => {
    charDetailId = '';
    charDetailState = null;
    renderCharDetail();
  };
}

$('#btn-import-actions').onclick = async () => {
  if (!window.petApi || !window.petApi.importActions) return;
  const r = await window.petApi.importActions();
  if (!r || r.canceled) return;
  if (!r.ok) {
    toast(r.error || '导入动作失败');
    return;
  }
  await fetchActions(true);
  renderExtensionPage();
  const failed = r.failed && r.failed.length ? `，${r.failed.length} 个失败` : '';
  toast(`已导入 ${r.imported.length} 个动作${failed}`, r.imported.length ? 'accent' : '');
  if (r.failed && r.failed.length) console.warn('[ext] import failures', r.failed);
};

$('#btn-import-action-list').onclick = async () => {
  if (!window.petApi || !window.petApi.importActionList) return;
  const r = await window.petApi.importActionList();
  if (!r || r.canceled) return;
  if (!r.ok) {
    toast(r.error || '导入动作列表失败');
    return;
  }
  await fetchActions(true);
  renderExtensionPage();
  toast(`已导入 ${r.count} 条动作（共 ${r.total} 条）`, 'accent');
};

$('#btn-refresh-actions').onclick = async () => {
  await fetchActions(true);
  renderExtensionPage();
  toast(`动作列表已刷新：${actions.length} 个`, 'accent');
};

$('#btn-open-clips').onclick = () => {
  if (window.petApi && window.petApi.openClips) window.petApi.openClips();
};

// ---- 性能页
// 渲染分辨率：新内核统一走 pet.setResolutionScale（它在设备像素比之上再乘一层），
// 旧内核没有这个接口，退回直接改 renderer 的 pixelRatio。
const MAX_KERNEL_DPR = 2;
function applyResolution(value) {
  const q = Number(value) || 1;
  const w = el.frame.contentWindow;
  const dpr = Math.min(Number(w && w.devicePixelRatio) || 1, MAX_KERNEL_DPR) || 1;
  if (pet && typeof pet.setResolutionScale === 'function') {
    try {
      pet.setResolutionScale(clamp(q / dpr, 0.5, 2));
      return;
    } catch (err) {
      console.warn('[shell] setResolutionScale failed', err);
    }
  }
  const r = w && w.__poc && w.__poc.renderer;
  if (!r) return;
  r.setPixelRatio(q);
  r.setSize(w.innerWidth, w.innerHeight);
  if (w.__poc.setResolution) w.__poc.setResolution(w.innerWidth * q, w.innerHeight * q);
}

$('#set-resolution').value = settings.resolution;
$('#set-resolution').onchange = (e) => {
  settings.resolution = e.target.value;
  store.set('agentpet.settings', settings);
  applyResolution(e.target.value);
  toast(`渲染分辨率：${e.target.value}×`);
};

// 目标帧率 / 自适应画质（运行时接口，不需要重载内核）
function applyPerformanceRuntime() {
  if (!pet) return;
  try {
    if (typeof pet.setTargetFPS === 'function') {
      // 帧生成模式下内核按「出图帧率」限帧（?hz=N），这里不要把它改回去
      const fps = settings.frameGenOn === true ? Number(settings.frameGenHz) || 30 : Number(settings.targetFPS) || 0;
      pet.setTargetFPS(fps);
    }
    if (typeof pet.setAdaptiveQuality === 'function') {
      pet.setAdaptiveQuality(settings.adaptiveQuality === true);
    }
  } catch (err) {
    console.warn('[shell] apply performance failed', err);
  }
}

// 眨眼（运行时接口；关掉后正在眨的那一次会自然播完）
function applyBlink() {
  if (!pet) return;
  try {
    if (typeof pet.setBlink === 'function') pet.setBlink(settings.blinkOn !== false);
    if (typeof pet.setBlinkParams === 'function') {
      pet.setBlinkParams({ interval: clamp(Number(settings.blinkInterval) || 3, 0.5, 30) });
    }
  } catch (err) {
    console.warn('[shell] apply blink failed', err);
  }
}

// 光晕（WebGL 版在内核里是 UnrealBloom，WebGPU 版是 TSL bloom；参数接口一致）
function applyBloom() {
  if (!pet) return;
  try {
    if (typeof pet.setBloom === 'function') pet.setBloom(settings.bloomOn !== false);
    if (typeof pet.setBloomParams === 'function') {
      pet.setBloomParams({
        strength: clamp(Number(settings.bloomStrength) || 0, 0, 1),
        threshold: clamp(Number(settings.bloomThreshold) || 0, 0, 1),
      });
    }
  } catch (err) {
    console.warn('[shell] apply bloom failed', err);
  }
}

const bloomOn = $('#set-bloom');
const bloomStrength = $('#set-bloom-strength');
const bloomThreshold = $('#set-bloom-threshold');
if (bloomOn) {
  bloomOn.checked = settings.bloomOn !== false;
  bloomOn.onchange = (e) => {
    settings.bloomOn = e.target.checked;
    store.set('agentpet.settings', settings);
    applyBloom();
    toast(settings.bloomOn ? '光晕已开启' : '光晕已关闭');
  };
}
if (bloomStrength) {
  bloomStrength.value = String(settings.bloomStrength);
  $('#set-bloom-strength-v').textContent = Number(settings.bloomStrength).toFixed(2);
  bloomStrength.oninput = (e) => {
    settings.bloomStrength = clamp(Number(e.target.value) || 0, 0, 1);
    $('#set-bloom-strength-v').textContent = settings.bloomStrength.toFixed(2);
    applyBloom();
  };
  bloomStrength.onchange = () => store.set('agentpet.settings', settings);
}
if (bloomThreshold) {
  bloomThreshold.value = String(settings.bloomThreshold);
  $('#set-bloom-threshold-v').textContent = Number(settings.bloomThreshold).toFixed(2);
  bloomThreshold.oninput = (e) => {
    settings.bloomThreshold = clamp(Number(e.target.value) || 0, 0, 1);
    $('#set-bloom-threshold-v').textContent = settings.bloomThreshold.toFixed(2);
    applyBloom();
  };
  bloomThreshold.onchange = () => store.set('agentpet.settings', settings);
}

// ---- 渲染后端 / FSR / 帧生成（启动参数，改了要重载内核）
const backendSelect = $('#set-backend');
const fsrOn = $('#set-fsr');
const fsrScale = $('#set-fsr-scale');
const frameGenOn = $('#set-framegen');
const frameGenHz = $('#set-framegen-hz');
const targetFps = $('#set-target-fps');
const adaptiveQuality = $('#set-adaptive');
const vfxOn = $('#set-vfx');
const outlineOn = $('#set-outline');
const blinkToggle = $('#set-blink');
const blinkInterval = $('#set-blink-interval');

// 只有 WebGPU 内核有 FSR / 帧生成；WebGL 后端直接把这两组行整行隐藏（不是置灰）。
// 帧生成不再按 shader-f16 卡：没有 f16 的机器由内核自己走 f32 慢速路径（实验性，可能崩）。
function syncRenderBackendUi() {
  const backend = renderBackendEffective();
  const gpu = backend === 'webgpu';
  const canSwitch = canSwitchKernelBackend();
  if (backendSelect) backendSelect.value = backend;
  // 自检可能把 fsrOn / frameGenOn 收回去，这里顺手把勾选状态对齐，避免界面和设置不一致
  if (fsrOn) fsrOn.checked = gpu && settings.fsrOn === true;
  if (frameGenOn) frameGenOn.checked = gpu && settings.frameGenOn === true;
  const showRow = (node, on) => {
    const row = node && node.closest('.setting-row');
    if (row) row.style.display = on ? '' : 'none';
  };
  showRow(fsrOn, gpu);
  showRow(fsrScale, gpu && settings.fsrOn === true);
  showRow(frameGenOn, gpu);
  showRow(frameGenHz, gpu && settings.frameGenOn === true);
  [fsrOn, fsrScale, frameGenOn, frameGenHz].forEach((node) => {
    if (node) node.disabled = false;
    const row = node && node.closest('.setting-row');
    if (row) row.classList.remove('is-disabled');
  });
  if (blinkInterval) {
    const row = blinkInterval.closest('.setting-row');
    if (row) row.style.display = settings.blinkOn === false ? 'none' : '';
  }
  // 帧生成开着时出图帧率由「帧生成出图帧率」决定，目标帧率交给它，避免两个旋钮打架
  if (targetFps) {
    const row = targetFps.closest('.setting-row');
    const taken = gpu && settings.frameGenOn === true;
    if (row) row.classList.toggle('is-disabled', taken);
    targetFps.disabled = taken;
  }
  const hint = $('#backend-hint');
  if (backendSelect) {
    // 内核自带两条入口（poc + poc4）才能切后端；只带一条入口时后端由入口决定
    backendSelect.disabled = !canSwitch;
    const row = backendSelect.closest('.setting-row');
    if (row) row.classList.toggle('is-disabled', !canSwitch);
  }
  if (hint) {
    if (!kernelConfig.entry) {
      hint.textContent = '尚未导入角色包';
    } else if (!canSwitch) {
      hint.textContent = `当前内核只带一条入口（${kernelConfig.entry}），渲染后端由它决定：${backend === 'webgpu' ? 'WebGPU（poc4）' : 'WebGL（poc）'}`;
    } else if (backend === 'webgl') {
      hint.textContent = 'WebGL：使用内核自带的 WebGL（poc）入口';
    } else if (gpuCaps.f16 === false) {
      // 硬件支持 f16、但 Chromium 没把它暴露给 WebGPU：
      // 内核会走 f32 慢速路径，能用但更吃显存/更慢，且属于实验性功能
      hint.textContent = 'WebGPU（实验性）：支持 FSR 超分；本机未暴露 shader-f16，帧生成走 f32 慢速路径，可能崩溃';
    } else {
      hint.textContent = 'WebGPU（实验性）：支持 FSR 超分与 RIFE 帧生成，可能出现崩溃或黑屏';
    }
  }
}

// 内核实际能力自检（每挂载一次内核跑一次）：
// FSR / 帧生成初始化失败时，内核只打日志，外壳要把开关收回去。
function syncKernelRuntimeCaps() {
  const dbg = kernelDebug();
  if (!dbg || renderBackendEffective() !== 'webgpu') return;
  let changed = false;
  if (settings.fsrOn === true && dbg.upscaler && dbg.upscaler.ready === false) {
    settings.fsrOn = false;
    changed = true;
    toast(`超分辨率初始化失败（${dbg.upscaler.error || '未知原因'}），已自动关闭`);
  }
  if (settings.frameGenOn === true && dbg.frameGen && dbg.frameGen.error) {
    settings.frameGenOn = false;
    changed = true;
    toast(`帧生成不可用（${dbg.frameGen.error}），已自动关闭`);
  }
  if (changed) {
    store.set('agentpet.settings', settings);
    syncRenderBackendUi();
  }
}

if (backendSelect) {
  backendSelect.value = renderBackendEffective();
  backendSelect.onchange = (e) => {
    settings.kernelBackend = e.target.value === 'webgl' ? 'webgl' : 'webgpu';
    store.set('agentpet.settings', settings);
    kernelFallbackUsed = false;
    syncRenderBackendUi();
    reloadKernel(`渲染后端 ${settings.kernelBackend}`);
    toast(`已切换 ${settings.kernelBackend === 'webgl' ? 'WebGL' : 'WebGPU'} 内核`);
  };
}
if (fsrOn) {
  fsrOn.checked = settings.fsrOn === true;
  fsrOn.onchange = (e) => {
    settings.fsrOn = e.target.checked;
    store.set('agentpet.settings', settings);
    syncRenderBackendUi();
    reloadKernel(`超分辨率 ${settings.fsrOn ? '开' : '关'}`);
    toast(settings.fsrOn ? '超分辨率已开启' : '超分辨率已关闭');
  };
}
if (fsrScale) {
  fsrScale.value = String(settings.fsrScale);
  $('#set-fsr-scale-v').textContent = `${Math.round(Number(settings.fsrScale) * 100)}%`;
  fsrScale.oninput = (e) => {
    settings.fsrScale = clamp(Number(e.target.value) || 0.66, 0.25, 1);
    $('#set-fsr-scale-v').textContent = `${Math.round(settings.fsrScale * 100)}%`;
  };
  fsrScale.onchange = () => {
    store.set('agentpet.settings', settings);
    if (settings.fsrOn === true) reloadKernel(`FSR 倍率 ${Math.round(settings.fsrScale * 100)}%`);
  };
}
if (frameGenOn) {
  frameGenOn.checked = settings.frameGenOn === true;
  frameGenOn.onchange = (e) => {
    settings.frameGenOn = e.target.checked;
    store.set('agentpet.settings', settings);
    syncRenderBackendUi();
    reloadKernel(`帧生成 ${settings.frameGenOn ? '开' : '关'}`);
    toast(settings.frameGenOn ? '帧生成已开启（出图降到设定帧率，中间帧由 RIFE 插值补）' : '帧生成已关闭');
  };
}
if (frameGenHz) {
  frameGenHz.value = String(settings.frameGenHz);
  frameGenHz.onchange = (e) => {
    settings.frameGenHz = Math.max(12, Math.min(120, Math.round(Number(e.target.value) || 30)));
    store.set('agentpet.settings', settings);
    if (settings.frameGenOn === true) reloadKernel(`帧生成出图帧率 ${settings.frameGenHz}Hz`);
  };
}
if (targetFps) {
  targetFps.value = String(settings.targetFPS);
  targetFps.onchange = (e) => {
    settings.targetFPS = Math.max(0, Math.min(240, Math.round(Number(e.target.value) || 0)));
    store.set('agentpet.settings', settings);
    applyPerformanceRuntime();
    toast(settings.targetFPS ? `已限帧 ${settings.targetFPS} FPS` : '帧率跟随显示器');
  };
}
if (adaptiveQuality) {
  adaptiveQuality.checked = settings.adaptiveQuality === true;
  adaptiveQuality.onchange = (e) => {
    settings.adaptiveQuality = e.target.checked;
    store.set('agentpet.settings', settings);
    applyPerformanceRuntime();
    toast(settings.adaptiveQuality ? '自适应画质已开启' : '自适应画质已关闭');
  };
}
if (vfxOn) {
  vfxOn.checked = settings.vfxOn !== false;
  vfxOn.onchange = (e) => {
    settings.vfxOn = e.target.checked;
    store.set('agentpet.settings', settings);
    reloadKernel(`水墨特效 ${settings.vfxOn ? '开' : '关'}`);
  };
}
if (outlineOn) {
  outlineOn.checked = settings.outlineOn !== false;
  outlineOn.onchange = (e) => {
    settings.outlineOn = e.target.checked;
    store.set('agentpet.settings', settings);
    reloadKernel(`描边 ${settings.outlineOn ? '开' : '关'}`);
  };
}
if (blinkToggle) {
  blinkToggle.checked = settings.blinkOn !== false;
  blinkToggle.onchange = (e) => {
    settings.blinkOn = e.target.checked;
    store.set('agentpet.settings', settings);
    syncRenderBackendUi();
    applyBlink();
  };
}
if (blinkInterval) {
  blinkInterval.value = String(settings.blinkInterval);
  $('#set-blink-interval-v').textContent = `${Number(settings.blinkInterval).toFixed(1)}s`;
  blinkInterval.oninput = (e) => {
    settings.blinkInterval = clamp(Number(e.target.value) || 3, 0.5, 30);
    $('#set-blink-interval-v').textContent = `${settings.blinkInterval.toFixed(1)}s`;
    applyBlink();
  };
  blinkInterval.onchange = () => store.set('agentpet.settings', settings);
}
syncRenderBackendUi();

// 关闭画面：默认关；打开后释放内核并显示「已停止渲染」，关掉再把内核挂回来
const visualOffToggle = $('#set-visual-off');
if (visualOffToggle) {
  visualOffToggle.checked = settings.visualOff === true;
  visualOffToggle.onchange = (e) => {
    settings.visualOff = e.target.checked;
    store.set('agentpet.settings', settings);
    applyVisualOff();
    consoleLog('系统', settings.visualOff ? '画面已关闭：3D 内核已释放' : '画面已恢复：重新挂载 3D 内核');
    toast(
      settings.visualOff ? '画面已关闭：已停止渲染' : '画面已恢复：正在重新加载 3D 内核',
      settings.visualOff ? 'accent' : '',
    );
  };
}

// 进后台自动关闭画面：默认关；只影响窗口隐藏/最小化后的渲染，不动上面的手动开关
const visualOffBgToggle = $('#set-visual-off-bg');
if (visualOffBgToggle) {
  visualOffBgToggle.checked = settings.visualOffInBackground === true;
  visualOffBgToggle.onchange = (e) => {
    settings.visualOffInBackground = e.target.checked;
    store.set('agentpet.settings', settings);
    // 关掉这个开关时，如果正处在后台停渲染状态，把内核挂回来
    if (!settings.visualOffInBackground && bgVisualOff) resumeKernelFromBackground();
    toast(
      settings.visualOffInBackground
        ? '已开启：收起到托盘后自动停止渲染'
        : '已关闭：收起到托盘也保持渲染',
    );
  };
}

// 设置 → 预设：提示词是否附带当前时间（默认开，只影响请求体，不动聊天记录）
const promptTimeToggle = $('#set-prompt-time');
if (promptTimeToggle) {
  promptTimeToggle.checked = promptTimeOn();
  promptTimeToggle.onchange = () => {
    store.set('agentpet.promptTime', !!promptTimeToggle.checked);
    toast(
      promptTimeToggle.checked ? '提示词已附带当前时间' : '提示词不再附带时间',
      promptTimeToggle.checked ? 'accent' : '',
    );
  };
}

// 设置 → 预设：是否发送强调提示词（默认关，只影响请求体）
const promptEmphasizeToggle = $('#set-prompt-emphasize');
if (promptEmphasizeToggle) {
  promptEmphasizeToggle.checked = promptEmphasizeOn();
  promptEmphasizeToggle.onchange = () => {
    store.set('agentpet.promptEmphasize', !!promptEmphasizeToggle.checked);
    toast(
      promptEmphasizeToggle.checked ? '已开启强调提示词' : '已关闭强调提示词',
      promptEmphasizeToggle.checked ? 'accent' : '',
    );
  };
}

// 视线跟随：设置页开关与 Dock 浮层开关共用同一份状态
const followSwitch = $('#set-mouse-follow');
const dockFollowSwitch = $('#dock-mouse-follow');

function syncFollowSwitches() {
  const on = settings.mouseFollow !== false;
  if (followSwitch) followSwitch.checked = on;
  if (dockFollowSwitch) dockFollowSwitch.checked = on;
}

function setMouseFollow(on) {
  settings.mouseFollow = on;
  if (!on && pet) {
    if (pet.releaseLookAt) pet.releaseLookAt();
    else if (pet.clearLookAt) pet.clearLookAt();
  }
  syncFollowSwitches();
  store.set('agentpet.settings', settings);
}

syncFollowSwitches();
if (followSwitch) followSwitch.onchange = (e) => setMouseFollow(e.target.checked);
if (dockFollowSwitch) dockFollowSwitch.onchange = (e) => setMouseFollow(e.target.checked);

$('#set-look-release').checked = settings.releaseOnLeave;
$('#set-look-release').onchange = (e) => {
  settings.releaseOnLeave = e.target.checked;
  store.set('agentpet.settings', settings);
};

$('#set-clickthrough').onchange = async (e) => {
  if (window.petApi) await window.petApi.setClickThrough(e.target.checked);
  if (e.target.checked) {
    toast('已开启整窗穿透：按 Ctrl+Shift+P 可恢复');
  }
};

// ---- 模型页（多模型配置）
const MODEL_DEFAULTS = { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
// 内置的本地演示模型：不请求网络，直接用规则解释器
const MOCK_MODEL = { id: 'mock', name: 'Mock 演示（本地）', base: '', key: '', model: 'mock', builtin: true };

// 联网搜索（web_search）配置：和模型配置一样存在本地 store（si.search），不额外建文件
// 想接新供应商：这里加一项（id / label / 默认 endpoint），下拉框会自动出现；
// 已有供应商的请求细节写死在 main.js，自定义供应商则改 si/app/search.providers.json（无需改代码）。
const SEARCH_PROVIDERS = [
  { id: 'anysearch', label: 'AnySearch', endpoint: 'https://api.anysearch.com', isDefault: true },
  { id: 'searxng', label: 'SearXNG', endpoint: 'http://localhost:8888', needsEndpoint: true },
  { id: 'mock', label: 'Mock（离线）', endpoint: '' },
  { id: 'custom', label: '自定义', endpoint: '', isCustom: true },
];

function searchProvider(id) {
  return SEARCH_PROVIDERS.find((p) => p.id === id) || SEARCH_PROVIDERS[0];
}

function loadSearchConfig() {
  const raw = store.get('agentpet.search', null) || {};
  const provider = SEARCH_PROVIDERS.some((p) => p.id === raw.provider) ? raw.provider : 'anysearch';
  const rawEndpoint = String(raw.endpoint || '').trim();
  return {
    provider,
    apiKey: String(raw.apiKey || '').trim(),
    // 只在同一个供应商下沿用保存的地址，避免从 AnySearch 切到 SearXNG 时把旧地址带过来
    endpoint: (raw.provider === provider && rawEndpoint) || searchProvider(provider).endpoint || '',
  };
}

function saveSearchConfig(cfg) {
  store.set('agentpet.search', cfg);
}

// 每次调用都现读配置：设置页改完不用重启，下一次工具调用立刻生效
function searchPayload(query, maxResults) {
  const cfg = loadSearchConfig();
  const payload = {
    query,
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    endpoint: cfg.endpoint,
  };
  if (maxResults) payload.maxResults = maxResults;
  return payload;
}

function loadModels() {
  let models = store.get('agentpet.models', null);
  if (!Array.isArray(models) || !models.length) {
    // 兼容旧版单模型配置 si.api
    const legacy = store.get('agentpet.api', {});
    const seed = {
      id: `m_${Date.now().toString(36)}`,
      name: legacy.model || '默认模型',
      base: legacy.base || MODEL_DEFAULTS.base,
      key: legacy.key || '',
      model: legacy.model || MODEL_DEFAULTS.model,
    };
    models = [seed];
    store.set('agentpet.models', models);
    store.set('agentpet.currentModel', seed.id);
  }
  if (!models.some((m) => m.builtin || m.id === 'mock')) models.push({ ...MOCK_MODEL });
  // 每套模型各自的上下文窗口，统计页用它当分母
  models.forEach((m) => {
    const w = Number(m.contextWindow);
    if (!Number.isFinite(w) || w < 1000) m.contextWindow = 128000;
    m.effort = normalizeEffort(m.effort);
  });
  return models;
}

/* ---------------------------------------------------------------- 思考强度
 * 每套模型带一份 effort 映射：{ off, on }，值是「合并进请求体的 JSON 片段」。
 * 开关只有一个全局布尔 si.thinkOn；off 留空表示关闭时什么都不发。
 * 服务商不支持时（HTTP 400/422）运行期把它记进 effortUnsupported，本轮不再重试。
 * ---------------------------------------------------------------------- */
const effortUnsupported = new Set();

function normalizeEffort(raw) {
  const out = { off: '', on: '' };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of ['off', 'on']) {
    const v = raw[key];
    if (typeof v === 'string') out[key] = v.trim();
    else if (v && typeof v === 'object') out[key] = JSON.stringify(v);
  }
  return out;
}

// 空串 → null（不发）；JSON 解析失败 / 不是对象 → invalid
function parseEffortFragment(text) {
  const src = String(text == null ? '' : text).trim();
  if (!src) return null;
  try {
    const obj = JSON.parse(src);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) { /* 落到 invalid */ }
  return 'invalid';
}

function effortSupported(cfg) {
  if (!cfg || cfg.builtin || effortUnsupported.has(cfg.id)) return false;
  const parsed = parseEffortFragment(normalizeEffort(cfg.effort).on);
  return !!parsed && parsed !== 'invalid';
}

// 本轮请求要额外合并进 body 的字段；一次 runAgent 只快照一次，保证轮内前缀稳定
function thinkRequestBody() {
  const cfg = getApiConfig();
  if (!cfg || cfg.builtin || effortUnsupported.has(cfg.id)) return null;
  const effort = normalizeEffort(cfg.effort);
  if (store.get('agentpet.thinkOn', false)) {
    const on = parseEffortFragment(effort.on);
    return on && on !== 'invalid' ? on : null;
  }
  const off = parseEffortFragment(effort.off);
  return off && off !== 'invalid' ? off : null;
}

function effortLabel() {
  const cfg = getApiConfig();
  const effort = normalizeEffort(cfg && cfg.effort);
  const raw = store.get('agentpet.thinkOn', false) ? effort.on : effort.off;
  return raw ? raw.replace(/\s+/g, ' ').slice(0, 60) : '默认';
}


function currentModelId() {
  const models = loadModels();
  const id = store.get('agentpet.currentModel', '');
  return models.some((m) => m.id === id) ? id : models[0].id;
}

let editingModelId = '';

function modelInputs() {
  return {
    name: $('#model-name'),
    base: $('#model-base'),
    key: $('#model-key'),
    model: $('#model-model'),
    context: $('#model-context'),
    effortOff: $('#model-effort-off'),
    effortOn: $('#model-effort-on'),
  };
}

function setModelEditorOpen(open) {
  const box = $('#model-editor');
  if (!box) return;
  box.hidden = !open;
  if (open) {
    box.classList.remove('show');
    // 重新触发入场动画
    void box.offsetWidth;
    box.classList.add('show');
    requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  } else {
    box.classList.remove('show');
  }
}

function resetModelForm() {
  editingModelId = '';
  const f = modelInputs();
  f.name.value = '';
  f.base.value = MODEL_DEFAULTS.base;
  f.key.value = '';
  f.model.value = MODEL_DEFAULTS.model;
  f.context.value = '128000';
  if (f.effortOff) f.effortOff.value = '';
  if (f.effortOn) f.effortOn.value = '';
  syncEffortHint();
  const title = $('#model-editor-title');
  if (title) title.textContent = '添加模型';
  $('#btn-save-model').textContent = '保存';
  setModelEditorOpen(false);
}

function openModelEditor(target) {
  editingModelId = target ? target.id : '';
  const f = modelInputs();
  f.name.value = target ? target.name || '' : '';
  f.base.value = (target && target.base) || MODEL_DEFAULTS.base;
  f.key.value = (target && target.key) || '';
  f.model.value = (target && target.model) || MODEL_DEFAULTS.model;
  f.context.value = String((target && target.contextWindow) || 128000);
  const effort = normalizeEffort(target && target.effort);
  if (f.effortOff) f.effortOff.value = effort.off;
  if (f.effortOn) f.effortOn.value = effort.on;
  syncEffortHint();
  const title = $('#model-editor-title');
  if (title) title.textContent = target ? '编辑模型' : '添加模型';
  $('#btn-save-model').textContent = '保存';
  setModelEditorOpen(true);
  f.name.focus();
}

// 两行思考参数：实时标红非法的 JSON，合法时显示「生效中」提示
function syncEffortHint() {
  const f = modelInputs();
  const hint = $('#model-effort-hint');
  const rows = [
    { input: f.effortOff, level: 'off' },
    { input: f.effortOn, level: 'on' },
  ];
  let bad = '';
  rows.forEach(({ input, level }) => {
    if (!input) return;
    const parsed = parseEffortFragment(input.value);
    const invalid = parsed === 'invalid';
    input.classList.toggle('invalid', invalid);
    if (invalid) bad = level;
  });
  if (!hint) return;
  if (bad) {
    hint.className = 'effort-hint is-error';
    hint.textContent = `「${bad === 'on' ? '开启' : '关闭'}」这段不是合法的 JSON 对象，保存会被拒绝`;
    return;
  }
  hint.className = 'effort-hint';
  if (!f.effortOn || !f.effortOn.value.trim()) {
    hint.textContent = '开启一栏留空 = 该模型不支持思考强度，控制台的「深度思考」会置灰。';
  } else {
    hint.textContent = `开启时发送：${f.effortOn.value.trim()}（关闭一栏留空表示什么都不发）`;
  }
}

function renderModels() {
  const list = $('#model-list');
  if (!list) return;
  const models = loadModels();
  const activeId = currentModelId();
  list.innerHTML = '';
  models.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'provider-item' + (m.id === activeId ? ' active' : '');
    row.dataset.id = m.id;
    row.dataset.act = 'pick';
    row.title = m.id === activeId ? '当前模型' : '点击切换为当前模型';

    const main = document.createElement('div');
    main.className = 'provider-main';

    const title = document.createElement('div');
    title.className = 'provider-title';
    const name = document.createElement('b');
    name.textContent = m.name || m.model || '未命名';
    title.appendChild(name);
    if (m.id === activeId) {
      const badge = document.createElement('span');
      badge.className = 'provider-badge is-current';
      badge.textContent = '当前';
      title.appendChild(badge);
    }
    const badge = document.createElement('span');
    badge.className = 'provider-badge';
    badge.textContent = m.builtin ? '内置' : '自定义';
    title.appendChild(badge);
    const dot = document.createElement('i');
    dot.className = `provider-dot ${m.key || m.builtin ? 'ok' : 'off'}`;
    dot.title = m.key || m.builtin ? '可用' : '未配置 Key';
    title.appendChild(dot);

    const meta = document.createElement('span');
    meta.className = 'provider-meta';
    meta.textContent = m.builtin
      ? `不请求网络 · 规则解释器 · 上下文 ${fmtNum(m.contextWindow)}`
      : `${m.model || '—'} · ${m.base || '—'} · 上下文 ${fmtNum(m.contextWindow)}`;

    const keyState = document.createElement('span');
    keyState.className = `provider-key ${m.key || m.builtin ? 'ok' : 'off'}`;
    keyState.textContent = m.builtin ? '内置 · 无需 Key' : m.key ? 'Key 已配置' : '未配置 Key · 会退回 Mock';

    main.append(title, meta, keyState);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'provider-actions';
    if (!m.builtin) {
      const edit = document.createElement('button');
      edit.dataset.act = 'edit';
      edit.textContent = '编辑';
      const del = document.createElement('button');
      del.dataset.act = 'del';
      del.className = 'is-danger';
      del.textContent = '删除';
      actions.append(edit, del);
    }
    row.appendChild(actions);
    list.appendChild(row);
  });
}

$('#model-list').addEventListener('click', (e) => {
  const row = e.target.closest('.provider-item');
  if (!row) return;
  const btn = e.target.closest('[data-act]');
  // 整行都能点：不点编辑/删除时，点哪儿都等于切换当前模型
  const act = btn ? btn.dataset.act : 'pick';
  const models = loadModels();
  const target = models.find((m) => m.id === row.dataset.id);
  if (!target) return;

  if (act === 'pick') {
    if (store.get('agentpet.currentModel', '') === target.id) return;
    store.set('agentpet.currentModel', target.id);
  } else if (act === 'edit') {
    openModelEditor(target);
    return;
  } else if (act === 'del') {
    const rest = models.filter((m) => m.id !== target.id);
    if (!rest.length) {
      toast('至少要保留一个模型配置');
      return;
    }
    store.set('agentpet.models', rest);
    if (store.get('agentpet.currentModel', '') === target.id) store.set('agentpet.currentModel', rest[0].id);
    if (editingModelId === target.id) resetModelForm();
  }
  renderModels();
  updateConsoleMeta();
  syncModeChips(false);
  toast(act === 'pick' ? `已切换到 ${target.name || target.model}` : '模型配置已删除', 'accent');
});

$('#btn-save-model').onclick = () => {
  const f = modelInputs();
  const name = f.name.value.trim();
  const base = f.base.value.trim();
  const key = f.key.value.trim();
  const model = f.model.value.trim();
  const contextWindow = Math.max(1000, Math.round(Number(f.context.value) || 128000));
  const effort = {
    off: f.effortOff ? f.effortOff.value.trim() : '',
    on: f.effortOn ? f.effortOn.value.trim() : '',
  };
  const badLevel = ['off', 'on'].find((lv) => parseEffortFragment(effort[lv]) === 'invalid');
  if (badLevel) {
    syncEffortHint();
    toast(`思考参数「${badLevel === 'on' ? '开启' : '关闭'}」不是合法的 JSON 对象，请改一下再保存`, 'warn');
    return;
  }
  if (!name && !model) {
    toast('给这套配置起个名字，或填模型 ID');
    return;
  }
  const models = loadModels();
  if (editingModelId) {
    const target = models.find((m) => m.id === editingModelId);
    if (target) {
      Object.assign(target, {
        name,
        base: base || MODEL_DEFAULTS.base,
        key,
        model: model || MODEL_DEFAULTS.model,
        contextWindow,
        effort,
      });
    }
    store.set('agentpet.models', models);
  } else {
    const item = {
      id: `m_${Date.now().toString(36)}`,
      name: name || model,
      base: base || MODEL_DEFAULTS.base,
      key,
      model: model || MODEL_DEFAULTS.model,
      contextWindow,
      effort,
    };
    models.push(item);
    store.set('agentpet.models', models);
    if (!store.get('agentpet.currentModel', '')) store.set('agentpet.currentModel', item.id);
  }
  resetModelForm();
  renderModels();
  updateConsoleMeta();
  syncModeChips(false);
  toast('模型配置已保存', 'accent');
  consoleLog('系统', `${getApiConfig().name || getApiConfig().model} · ${getApiConfig().key ? '真实请求' : 'Mock 模式'}`);
};

$('#btn-add-model').onclick = () => openModelEditor(null);
$('#btn-cancel-model').onclick = () => resetModelForm();
$('#btn-cancel-model-bottom').onclick = () => resetModelForm();

// 思考参数的预设模板 + 实时校验提示
const EFFORT_PRESETS = {
  openai: '{"reasoning_effort":"medium"}',
  anthropic: '{"thinking":{"type":"enabled","budget_tokens":2048}}',
};
document.querySelectorAll('[data-effort-preset]').forEach((btn) => {
  btn.onclick = () => {
    const f = modelInputs();
    const key = btn.dataset.effortPreset;
    if (key === 'clear') {
      if (f.effortOff) f.effortOff.value = '';
      if (f.effortOn) f.effortOn.value = '';
    } else if (f.effortOn) {
      f.effortOn.value = EFFORT_PRESETS[key] || '';
    }
    syncEffortHint();
  };
});
['#model-effort-off', '#model-effort-on'].forEach((sel) => {
  const input = $(sel);
  if (input) input.addEventListener('input', syncEffortHint);
});

// ---- 联网搜索配置（和模型共用同一份本地存储）
function updateSearchProviderUi(providerId) {
  const provider = searchProvider(providerId);
  const hint = $('#search-custom-hint');
  const keyField = $('#search-key-field');
  const keyInput = $('#search-key');
  const endpointField = $('#search-endpoint-field');
  if (hint) hint.hidden = providerId !== 'custom';
  // SearXNG 不需要 Key，把这一格让给「实例地址」，保持一行三列不乱
  if (keyField) keyField.hidden = !!provider.needsEndpoint;
  if (endpointField) endpointField.hidden = !provider.needsEndpoint;
  if (keyInput) {
    keyInput.placeholder =
      providerId === 'custom' ? '按配置文件规则使用（可留空）' : 'as_sk_…（留空走匿名免费额度）';
  }
}

// 表单里当前的地址：SearXNG 用输入框（留空回落到默认 http://localhost:8888），其它供应商用注册表里的
function searchEndpointValue(providerId) {
  const provider = searchProvider(providerId);
  if (!provider.needsEndpoint) return provider.endpoint;
  const input = $('#search-endpoint');
  const live = input ? input.value.trim() : '';
  return live || provider.endpoint;
}

function paintSearchState(providerId, hasKey) {
  updateSearchProviderUi(providerId);
  const provider = searchProvider(providerId);
  const dot = $('#search-dot');
  const text = $('#search-state-text');
  if (!dot || !text) return;
  dot.className = 'provider-dot';
  if (providerId === 'custom') {
    dot.classList.add('warn');
    text.textContent = '自定义 · 编辑 search.providers.json';
  } else if (providerId === 'searxng') {
    const endpoint = searchEndpointValue(providerId).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    dot.classList.add('ok');
    text.textContent = `SearXNG · ${endpoint}`;
  } else if (providerId === 'mock') {
    dot.classList.add('ok');
    text.textContent = 'Mock · 离线演示';
  } else if (hasKey) {
    dot.classList.add('ok');
    text.textContent = `${provider.label} · Key 已配置`;
  } else {
    dot.classList.add('warn');
    text.textContent = `${provider.label} · 使用匿名免费额度`;
  }
}

function fillSearchProviders() {
  const sel = $('#search-provider');
  if (!sel || sel.dataset.filled === '1') return;
  sel.innerHTML = SEARCH_PROVIDERS.map(
    (p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}${p.isDefault ? '（默认）' : ''}</option>`,
  ).join('');
  sel.dataset.filled = '1';
}

function renderSearchPanel() {
  const sel = $('#search-provider');
  const keyInput = $('#search-key');
  if (!sel || !keyInput) return;
  fillSearchProviders();
  const cfg = loadSearchConfig();
  sel.value = cfg.provider;
  keyInput.value = cfg.apiKey;
  const endpointInput = $('#search-endpoint');
  if (endpointInput) endpointInput.value = cfg.endpoint;
  paintSearchState(cfg.provider, !!cfg.apiKey);
}

$('#search-provider').onchange = () => {
  const providerId = $('#search-provider').value;
  // 切到 SearXNG 时，如果地址还是别的供应商的默认值（或空），换成 SearXNG 的默认地址
  const endpointInput = $('#search-endpoint');
  if (endpointInput) {
    const otherDefaults = SEARCH_PROVIDERS.filter((p) => p.endpoint && p.id !== providerId)
      .map((p) => p.endpoint)
      .concat('');
    if (providerId === 'searxng' && otherDefaults.includes(endpointInput.value.trim())) {
      endpointInput.value = searchProvider('searxng').endpoint;
    }
  }
  paintSearchState(providerId, !!$('#search-key').value.trim());
};

// 边改地址边刷新右上角状态，不用等保存
const searchEndpointInput = $('#search-endpoint');
if (searchEndpointInput) {
  searchEndpointInput.oninput = () =>
    paintSearchState($('#search-provider').value, !!$('#search-key').value.trim());
}

$('#btn-search-save').onclick = () => {
  const provider = $('#search-provider').value;
  const apiKey = $('#search-key').value.trim();
  const endpoint = searchEndpointValue(provider);
  saveSearchConfig({ provider, apiKey, endpoint, updatedAt: Date.now() });
  renderSearchPanel();
  toast('联网搜索配置已保存', 'accent');
  const detail =
    provider === 'mock'
      ? '（离线）'
      : provider === 'searxng'
        ? ` · ${endpoint}`
        : provider === 'custom'
          ? ' · 配置文件里的地址'
          : apiKey
            ? ' · Key 已配置'
            : ' · 匿名额度';
  consoleLog('系统', `联网搜索：${searchProvider(provider).label}${detail}`);
};

$('#btn-search-test').onclick = async () => {
  const btn = $('#btn-search-test');
  const out = $('#search-test-result');
  if (!out) return;
  const provider = $('#search-provider').value;
  const apiKey = $('#search-key').value.trim();
  const payload = {
    query: '近期人工智能新闻',
    provider,
    apiKey,
    endpoint: searchEndpointValue(provider),
    maxResults: 2,
  };
  out.hidden = false;
  out.className = 'search-test-result';
  out.textContent = '正在请求…';
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    if (!window.petApi || !window.petApi.webSearch) throw new Error('搜索桥接不可用');
    const res = await window.petApi.webSearch(payload);
    if (res && res.ok) {
      const meta = res.metadata || {};
      const list = res.results || [];
      const rows = list
        .slice(0, 2)
        .map((r) => `<div class="hit">${escapeHtml(r.title || '（无标题）')}</div>`)
        .join('');
      // 0 条时把原因也显示出来（比如 SearXNG 引擎被验证码/限流挡住）
      const note = !list.length && res.text ? `<div class="note">${escapeHtml(res.text)}</div>` : '';
      out.className = 'search-test-result ok';
      out.innerHTML =
        `<div class="test-head">连接正常 · ${escapeHtml(res.provider || provider)} · ${list.length} 条${
          meta.search_time_ms ? ` · ${meta.search_time_ms}ms` : ''
        }</div>${rows}${note}`;
    } else {
      out.className = 'search-test-result err';
      out.textContent = `连接失败：${(res && res.error) || '未知错误'}`;
    }
  } catch (err) {
    out.className = 'search-test-result err';
    out.textContent = `连接失败：${err && err.message ? err.message : String(err)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
};

resetModelForm();
renderModels();
renderSearchPanel();

// ---- 预设页
// 所有提示词都来自本地 md，程序不内置任何兜底文案；文件为空 → 对应区块不注入。
let presetPersonaPath = 'si/app/preset-persona.md';
let presetSpeakPath = 'si/app/preset-speak.md';
let presetTimePath = 'si/app/preset-time.md';
let presetMemoryPath = 'si/app/preset-memory.md';
let personaMd = '';
let speakFormatMd = '';
let timeNoteMd = '';
let memoryTemplateMd = '';
// 每轮注入的状态行模板（{state} 为占位符），在预设页可编辑；开关在选项·生物钟
let emotionStateTemplateMd = '';
// 强调提示词：只在当轮贴在最后一条用户消息末尾，不落库、不进上下文
let emphasizeMd = '';
let presetPersonaDirty = false;
let presetSpeakDirty = false;
let presetTimeDirty = false;
let presetMemoryDirty = false;
let presetProactiveDirty = false;
let presetEmotionDirty = false;
let presetEmphasizeDirty = false;

// 预设页 TOOLS 区块：只展示 tools.config.json 里启用的真工具（只读，开关在「工具管理」）。
// SPEAK / MEM_MARK 属于底层协议，不在此列。

// ACTIONS 区块：给模型看的动作说明，持久化在 si/app/preset-actions.md。
// 磁盘文件是唯一真相源；localStorage 只做读不到文件时的兜底缓存。
let presetActionsMd = '';
let presetActionsDirty = false;
const PRESET_ACTIONS_STORE = 'agentpet.presetActions';

// ---- 动作分层：常用动作写在 preset-actions.md 顶部的 <!-- si:common ... --> 里
// 系统提示只带常用动作；高阶动作由 list_advanced_actions 按需返回，picker 里也可手动展开。
const COMMON_MARKER_RE = /<!--\s*si:common([\s\S]*?)-->/i;
// 「从动作库重建」时默认算常用的底座，来自 actions.json 的 common
function defaultCommonActions() {
  return Array.isArray(actionMeta.common) ? actionMeta.common : [];
}
let commonActions = null; // Set | null = 未分层（全部算常用）

function parseCommonActions(md) {
  const m = COMMON_MARKER_RE.exec(md || '');
  if (!m) return null;
  const names = m[1]
    .split(/[\s,，、]+/)
    .map((s) => s.replace(/^`|`$/g, '').trim())
    .filter(Boolean);
  return names.length ? new Set(names) : null;
}

function commonMarker(names) {
  return `<!-- si:common\n${names.join('\n')}\n-->`;
}

function isCommonAction(name) {
  return !commonActions || commonActions.has(name);
}

// 动作名都写成 `name`，一行里可能有好几个（状态链那一栏）
const BACKTICK_NAMES_RE = /`([a-z][a-z0-9_]*)`/g;

function rowActionNames(line) {
  return Array.from(line.matchAll(BACKTICK_NAMES_RE), (m) => m[1]);
}

function isAdvancedRow(line) {
  if (!commonActions || !line.startsWith('|')) return false;
  if (/^\|\s*[-: ]+\|/.test(line)) return false; // |---|---| 分隔行
  const names = rowActionNames(line);
  if (!names.length) return false; // 没有动作名的说明行原样保留
  return !names.some((n) => commonActions.has(n));
}

// 系统提示里的 ACTIONS 区块：去掉标记，只留常用动作的行
function actionsPromptBlock(md) {
  if (!commonActions) return md;
  const blocks = md.replace(COMMON_MARKER_RE, '').trim().split(/(?=^## )/m);
  const kept = blocks.map((block) => {
    const lines = block.split('\n');
    let dropped = 0;
    const rows = lines.filter((line) => {
      if (!isAdvancedRow(line)) return true;
      dropped += 1;
      return false;
    });
    // 整节都是高阶动作就整节省略
    if (dropped && !rows.some((l) => /^\|\s*`/.test(l))) return '';
    return rows.join('\n');
  });
  return kept.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n');
}

// 高阶动作（按 md 的表格行返回），供 list_advanced_actions 用
function advancedActionLines(keyword = '') {
  const md = (presetActionsMd || (el.presetActions && el.presetActions.value) || '').replace(COMMON_MARKER_RE, '');
  if (!commonActions) return [];
  const kw = keyword.trim().toLowerCase();
  const out = [];
  let section = '';
  md.split('\n').forEach((line) => {
    if (/^## /.test(line)) {
      section = line.replace(/^##\s*/, '');
      return;
    }
    if (!line.startsWith('|') || !isAdvancedRow(line)) return;
    if (/^\|\s*动作名\s*\|/.test(line)) return; // 表头
    if (kw && !line.toLowerCase().includes(kw)) return;
    out.push({ section, line });
  });
  return out;
}

function syncCommonActions(md) {
  commonActions = parseCommonActions(md);
  if (el.pickerList) renderPicker(el.pickerSearch ? el.pickerSearch.value : '');
}

async function loadPresetActionsMd() {
  let text = '';
  try {
    if (window.petApi && window.petApi.readPresetActions) {
      const r = await window.petApi.readPresetActions();
      if (r && r.ok && r.text) text = r.text;
    }
  } catch (err) {
    console.warn('[shell] read preset actions failed', err);
  }
  if (!text) text = store.get(PRESET_ACTIONS_STORE, '');
  presetActionsMd = text || buildActionsMd();
  syncCommonActions(presetActionsMd);
  renderPresetActions();
}

function renderPresetActions() {
  if (presetActionsDirty) return; // 用户正在改，刷新动作库不要冲掉未保存的编辑
  el.presetActions.value = presetActionsMd;
}

// 从当前动作库生成一份完整清单（导入新动作后点「从动作库重建」用它）
function buildActionsMd() {
  const fmt = (d) => (Number(d) ? `${Number(d).toFixed(2)}s` : '—');
  // 叠加层（actions.json 里归到 additive 组的）不能单独播；缺文件的动作也不进清单
  const list = actions
    .filter((a) => !a.missing && actionGroupOf(a).id !== 'additive')
    .sort((a, b) => a.name.localeCompare(b.name));
  const loops = list.filter((a) => a.loop && !a.derived);
  const derived = list.filter((a) => a.derived);
  const ones = list.filter((a) => !a.loop && !a.derived);
  const transitions = ones.filter((a) => /_(start|end)$/.test(a.name));
  const normalOnes = ones.filter((a) => !/_(start|end)$/.test(a.name));
  const row = (a) => `| \`${a.name}\` | ${shortName(a.name)} | ${fmt(a.duration)} |`;
  const common = defaultCommonActions().filter((name) => list.some((a) => a.name === name));

  return `# ${(activeCharacter && activeCharacter.name) || '角色'} · 可用动作（ACTIONS）

> 由当前动作库生成（${new Date().toISOString().slice(0, 10)}，共 ${list.length} 条）。
> 这份文件就是系统提示里 ACTIONS 区块的原文，可在设置页编辑后保存回 si/app/preset-actions.md。
> 只有下面 si:common 里列出的动作会进系统提示，其余算「高阶动作」，模型用 list_advanced_actions 取。

${commonMarker(common)}

## 一、怎么用动作

1. 一次只给一个动作名，写进 play_action 的 action 参数，队列按顺序播放。
2. 循环动作（loop）会一直保持；后面的动作会排队等它，换姿态要先排它的 _end 或回到待机。
3. 大姿态走三段式：xxx_start → xxx_loop → xxx_end；过渡剪辑不要单独当动作。
4. hair_yaw_m / lookat_body_m 是叠加层，不能播。
5. 拿不准时用最轻的反馈：点头、摇头、挥手。

## 二、循环动作（会一直保持）

| 动作名 | 中文 | 时长 |
|---|---|---|
${loops.map(row).join('\n')}

## 三、一次性动作

| 动作名 | 中文 | 时长 |
|---|---|---|
${normalOnes.map(row).join('\n')}

## 四、过渡剪辑（必须拼在状态前后）

| 动作名 | 中文 | 时长 |
|---|---|---|
${transitions.map(row).join('\n')}

## 五、衍生动作

| 动作名 | 中文 | 说明 |
|---|---|---|
${derived.map((a) => `| \`${a.name}\` | ${shortName(a.name)} | 内核从剪辑截取生成 |`).join('\n')}
`;
}

// 按当前动作库重建 ACTIONS 并写回 preset-actions.md
// 「从动作库重建」按钮和「切换角色时重建动作预设」开关共用这一份逻辑
async function rebuildActionsPreset() {
  presetActionsMd = buildActionsMd();
  presetActionsDirty = false;
  el.presetActions.value = presetActionsMd;
  syncCommonActions(presetActionsMd);
  await savePresetActions();
}

$('#btn-regenerate-actions').onclick = async () => {
  await rebuildActionsPreset();
  toast('已按动作库重建 ACTIONS，并写回 preset-actions.md', 'accent');
  consoleLog('系统', `ACTIONS 已从动作库重建（${actions.length} 条）`);
};

async function savePresetActions() {
  const text = el.presetActions.value;
  presetActionsMd = text;
  presetActionsDirty = false;
  syncCommonActions(text);
  store.set(PRESET_ACTIONS_STORE, text);
  try {
    if (window.petApi && window.petApi.writePresetActions) {
      const r = await window.petApi.writePresetActions(text);
      if (r && !r.ok) toast(`写回失败：${r.error || '未知错误'}`);
    }
  } catch (err) {
    toast(`写回失败：${err && err.message ? err.message : err}`);
  }
}

function renderPresetTools() {
  if (!el.presetTools) return;
  el.presetTools.innerHTML = '';
  if (!toolsConfigLoaded) {
    el.presetTools.textContent = '正在读取 tools.config.json…';
    return;
  }
  if (toolsConfigError) {
    el.presetTools.textContent = `工具配置读取失败：${toolsConfigError}`;
    return;
  }
  const tools = activeTools();
  if (!tools.length) {
    el.presetTools.textContent = '所有可插拔工具都已关闭（设置 → 工具管理）。底层协议（SPEAK / MEM_MARK）仍然开启。';
    return;
  }
  tools.forEach((tool) => {
    const row = document.createElement('div');
    row.className = 'tool-item';

    const code = document.createElement('span');
    code.className = 'tool-code';
    code.textContent = tool.name;

    const info = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = tool.label || tool.name;
    const desc = document.createElement('span');
    desc.className = 'tool-desc';
    desc.textContent = tool.prompt || '';

    info.appendChild(title);
    info.appendChild(document.createElement('br'));
    info.appendChild(desc);

    row.appendChild(code);
    row.appendChild(info);
    el.presetTools.appendChild(row);
  });
}

function lineNumbersFor(textarea) {
  if (!textarea) return;
  const count = Math.max(1, textarea.value.split('\n').length);
  const gutter = $(`.line-numbers[data-for="${textarea.id}"]`);
  if (!gutter) return;
  gutter.innerHTML = Array.from({ length: count }, (_, i) => `<span>${i + 1}</span>`).join('');
  gutter.scrollTop = textarea.scrollTop;
}

// 人设来自当前角色目录的 persona.md（磁盘是唯一真相源，程序不内置默认人设）
function getPersonaText() {
  return personaMd;
}

async function readPresetText(apiName) {
  const out = { text: '', path: '', exists: false, characterScoped: false };
  try {
    const fn = window.petApi && window.petApi[apiName];
    if (!fn) return out;
    const r = await fn();
    if (r && r.path) out.path = r.path;
    if (r && r.ok && r.text) out.text = r.text;
    // 文件存在（哪怕内容是空的）就算存在：空的 md 表示「用户就是要它为空」
    if (r && r.ok && r.exists) out.exists = true;
    // 主进程说了这条内容属于角色目录：缺文件时按「该角色没写人设」处理
    if (r && r.characterScoped) out.characterScoped = true;
  } catch (err) {
    console.warn('[shell] read', apiName, 'failed', err);
  }
  return out;
}

async function loadPresetPersona() {
  const r = await readPresetText('readPresetPersona');
  if (r.path) presetPersonaPath = r.path;
  if (r.exists) {
    // 文件存在就以文件为准（空文件 = 不注入人设，不再回填旧文案）
    personaMd = r.text;
  } else if (!r.characterScoped) {
    // 旧版全局人设存在 localStorage：只有「还没有任何角色」时才迁移到全局 md
    const saved = store.get('agentpet.presets', null);
    const old =
      saved && typeof saved === 'object'
        ? [saved.prompt, saved.persona].filter(Boolean).join('\n\n')
        : '';
    personaMd = old || '';
    if (old && window.petApi && window.petApi.writePresetPersona) {
      try {
        await window.petApi.writePresetPersona(old);
      } catch (err) {
        console.warn('[shell] migrate persona failed', err);
      }
    }
  } else {
    // 该角色目录里还没有 persona.md：保持为空，不继承其他角色的人设
    personaMd = '';
  }
  if (!presetPersonaDirty) {
    el.presetPersona.value = personaMd;
    lineNumbersFor(el.presetPersona);
  }
}

// PROMPT / TIME / MEMORY 同样从本地 md 读，改文件或本页编辑后保存都生效
async function loadPresetSpeak() {
  const r = await readPresetText('readPresetSpeak');
  if (r.path) presetSpeakPath = r.path;
  speakFormatMd = r.text;
  if (!presetSpeakDirty && el.presetSpeak) {
    el.presetSpeak.value = speakFormatMd;
    lineNumbersFor(el.presetSpeak);
  }
  if (el.presetSpeakPath) el.presetSpeakPath.textContent = presetSpeakPath;
}

async function loadPresetTime() {
  const r = await readPresetText('readPresetTime');
  if (r.path) presetTimePath = r.path;
  timeNoteMd = r.text;
  if (!presetTimeDirty && el.presetTime) {
    el.presetTime.value = timeNoteMd;
    lineNumbersFor(el.presetTime);
  }
}

async function loadPresetMemory() {
  const r = await readPresetText('readPresetMemory');
  if (r.path) presetMemoryPath = r.path;
  memoryTemplateMd = r.text;
  if (!presetMemoryDirty && el.presetMemory) {
    el.presetMemory.value = memoryTemplateMd;
    lineNumbersFor(el.presetMemory);
  }
}

// 情感注入模板 / 主动开口模板 / 每轮状态行：同样来自本地 md，改文件或本页编辑后保存都生效
async function loadPresetProactive() {
  const r = await readPresetText('readPresetProactive');
  emotionRuntime.proactiveTemplate = r.text || '';
  if (!presetProactiveDirty && el.presetProactive) {
    el.presetProactive.value = emotionRuntime.proactiveTemplate;
    lineNumbersFor(el.presetProactive);
  }
}

async function loadPresetEmotion() {
  const r = await readPresetText('readPresetEmotion');
  emotionStateTemplateMd = r.text || '';
  if (!presetEmotionDirty && el.presetEmotion) {
    el.presetEmotion.value = emotionStateTemplateMd;
    lineNumbersFor(el.presetEmotion);
  }
}

// 强调提示词：同样来自本地 md，只在 buildChatMessages 里贴到最后一条用户消息末尾
async function loadPresetEmphasize() {
  const r = await readPresetText('readPresetEmphasize');
  emphasizeMd = r.text || '';
  if (!presetEmphasizeDirty && el.presetEmphasize) {
    el.presetEmphasize.value = emphasizeMd;
    lineNumbersFor(el.presetEmphasize);
  }
}

function renderPreset() {
  loadPresetPersona();
  loadPresetSpeak();
  loadPresetTime();
  loadPresetMemory();
  loadPresetProactive();
  loadPresetEmotion();
  loadPresetEmphasize();
  renderPresetActions();
  renderPresetTools();
}

const presetInputs = [
  [el.presetPersona, () => (presetPersonaDirty = true)],
  [el.presetSpeak, () => (presetSpeakDirty = true)],
  [el.presetTime, () => (presetTimeDirty = true)],
  [el.presetMemory, () => (presetMemoryDirty = true)],
  [el.presetProactive, () => (presetProactiveDirty = true)],
  [el.presetEmotion, () => (presetEmotionDirty = true)],
  [el.presetEmphasize, () => (presetEmphasizeDirty = true)],
];
presetInputs.forEach(([node, markDirty]) => {
  if (!node) return;
  node.addEventListener('input', () => {
    markDirty();
    lineNumbersFor(node);
  });
  node.addEventListener('scroll', () => lineNumbersFor(node));
});

el.presetActions.addEventListener('input', () => {
  presetActionsDirty = true;
});

$('#btn-save-all').onclick = async () => {
  personaMd = el.presetPersona.value;
  speakFormatMd = el.presetSpeak.value;
  timeNoteMd = el.presetTime.value;
  memoryTemplateMd = el.presetMemory.value;
  if (el.presetProactive) emotionRuntime.proactiveTemplate = el.presetProactive.value;
  if (el.presetEmotion) emotionStateTemplateMd = el.presetEmotion.value;
  if (el.presetEmphasize) emphasizeMd = el.presetEmphasize.value;
  const jobs = [
    ['writePresetPersona', personaMd],
    ['writePresetSpeak', speakFormatMd],
    ['writePresetTime', timeNoteMd],
    ['writePresetMemory', memoryTemplateMd],
  ];
  if (el.presetProactive) jobs.push(['writePresetProactive', emotionRuntime.proactiveTemplate]);
  if (el.presetEmotion) jobs.push(['writePresetEmotion', emotionStateTemplateMd]);
  if (el.presetEmphasize) jobs.push(['writePresetEmphasize', emphasizeMd]);
  let failed = '';
  for (const [fn, text] of jobs) {
    if (!window.petApi || !window.petApi[fn]) continue;
    try {
      const r = await window.petApi[fn](text);
      if (r && r.ok === false) failed = r.error || fn;
    } catch (err) {
      failed = String(err && err.message ? err.message : err);
    }
  }
  await savePresetActions();
  presetPersonaDirty = false;
  presetSpeakDirty = false;
  presetTimeDirty = false;
  presetMemoryDirty = false;
  presetEmotionDirty = false;
  presetEmphasizeDirty = false;
  if (failed) {
    toast('提示词保存失败，详情见下方提示', 'warn');
    consoleLog('错误', `提示词保存失败：${failed}`);
    return;
  }
  toast('提示词已保存（PROMPT / PERSONA / TIME / MEMORY / PROACTIVE / EMOTION / EMPHASIZE / ACTIONS）', 'accent');
  consoleLog('系统', '提示词已保存到 si/app/preset-*.md');
};

// 启动时先按「未加载」画一版，bootstrap 里会 await 真正读取
renderPresetTools();
loadToolsConfig();
loadPresetSpeak();
loadPresetPersona();
loadPresetTime();
loadPresetMemory();
loadPresetEmotion();
loadPresetEmphasize();
loadPresetActionsMd();

// 工具管理页：重新读取磁盘上的 tools.config.json（手改 prompt / schema 后用它刷新）
const btnToolsReload = $('#btn-tools-reload');
if (btnToolsReload) {
  btnToolsReload.onclick = async () => {
    await loadToolsConfig();
    syncModeChips(false);
    if (toolsConfigError) {
      toast('工具配置读取失败，详情见下方提示', 'warn');
      consoleLog('错误', toolsConfigError);
      return;
    }
    toast(`已重新读取工具配置（${toolsConfig.tools.length} 个）`, 'accent');
    consoleLog('系统', `工具配置已重新读取：${toolsConfig.tools.map((t) => `${t.name}${t.enabled ? '' : '(禁用)'}`).join('、') || '空'}`);
  };
}

// ---- 笔记页
let memories = store.get('agentpet.memories', []);
// 本轮会话里已经 read 过的笔记标题；edit / rm 前必须命中，避免盲改
const memoryRead = new Set();

function renderMemories() {
  el.memoryList.innerHTML = '';
  if (!memories.length) {
    el.memoryList.innerHTML = '<div class="action-empty" style="grid-column:1/-1">还没有笔记。点右上角「+ 新建笔记」。</div>';
  }
  memories.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'memory-card';
    card.title = '点击展开 / 收起全文';
    card.innerHTML = `<div class="memory-card-head"><b>${escapeHtml(m.title)}</b><button title="删除">✕</button></div>
      <p>${escapeHtml(m.body)}</p>`;
    card.querySelector('button').onclick = (ev) => {
      ev.stopPropagation();
      memories = memories.filter((x) => x.id !== m.id);
      memoryRead.delete(m.title);
      store.set('agentpet.memories', memories);
      renderMemories();
      toast('笔记已删除');
    };
    card.onclick = () => card.classList.toggle('expanded');
    el.memoryList.appendChild(card);
  });
}

// 笔记工具统一入口：list / read / write / edit / rm
function runMemoryTool(args) {
  const action = String(args.action || '').toLowerCase();
  const title = String(args.title || '').trim();
  const newTitle = String(args.new_title || '').trim();
  const body = typeof args.body === 'string' ? args.body.trim() : '';

  if (action === 'list') {
    return memories.length
      ? `${memories.length} 条笔记（仅标题）：\n${memories.map((m, i) => `${i + 1}. ${m.title}`).join('\n')}`
      : '（笔记为空）';
  }
  if (!title) return '需要 title 参数（list 之外都要指定笔记标题）';
  const memory = memories.find((m) => m.title === title);

  if (action === 'read') {
    if (!memory) return `未找到笔记「${title}」。先用 action:"list" 看现有标题。`;
    memoryRead.add(title);
    return `「${title}」\n${memory.body}`;
  }
  if (action === 'write') {
    if (!body) return 'write 需要 body 参数';
    if (body.length > MEMORY_MAX_CHARS) {
      return `拒绝写入：正文 ${body.length} 字，超过单条笔记上限 ${MEMORY_MAX_CHARS} 字。请精简后再调用。`;
    }
    if (memory) return `已存在同名笔记「${title}」，请先 read 再用 action:"edit" 修改。`;
    memories.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title, body });
    store.set('agentpet.memories', memories);
    memoryRead.add(title);
    renderMemories();
    return `已写入笔记「${title}」`;
  }
  if (action === 'edit' || action === 'rm') {
    if (!memory) return `未找到笔记「${title}」。先用 action:"list" 看现有标题。`;
    if (!memoryRead.has(title)) {
      return `拒绝执行：${action === 'edit' ? '编辑' : '删除'}前必须先读取。请先调用 note({"action":"read","title":"${title}"})，确认正文后再操作。`;
    }
    if (action === 'rm') {
      memories = memories.filter((m) => m.id !== memory.id);
      memoryRead.delete(title);
      store.set('agentpet.memories', memories);
      renderMemories();
      return `已删除笔记「${title}」`;
    }
    if (!body) return 'edit 需要 body 参数（修改后的完整正文）';
    if (body.length > MEMORY_MAX_CHARS) {
      return `拒绝写入：正文 ${body.length} 字，超过单条笔记上限 ${MEMORY_MAX_CHARS} 字。请精简后再调用。`;
    }
    const finalTitle = newTitle || title;
    if (finalTitle !== title && memories.some((m) => m.title === finalTitle)) {
      return `已有同名笔记「${finalTitle}」，请换一个标题。`;
    }
    memory.title = finalTitle;
    memory.body = body;
    store.set('agentpet.memories', memories);
    memoryRead.delete(title);
    memoryRead.add(finalTitle);
    renderMemories();
    return `已更新笔记「${finalTitle}」`;
  }
  return `未知 action「${action}」，可用：list / read / write / edit / rm`;
}

$('#btn-add-memory').onclick = () => {
  $('#memory-form').hidden = false;
  $('#memory-title').value = '';
  $('#memory-body').value = '';
  $('#memory-title').focus();
};

$('#btn-cancel-memory').onclick = () => {
  $('#memory-form').hidden = true;
};

$('#btn-save-memory').onclick = () => {
  const title = $('#memory-title').value.trim();
  const body = $('#memory-body').value.trim();
  if (!title || !body) {
    toast('标题和正文都不能为空');
    return;
  }
  if (memories.some((m) => m.title === title)) {
    toast('已有同名笔记，请换一个标题');
    return;
  }
  memories.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title, body });
  store.set('agentpet.memories', memories);
  $('#memory-form').hidden = true;
  renderMemories();
  toast('笔记已保存', 'accent');
};

// ---- 记忆库页：结构化事实卡片流 + 摘要归档时间轴
let memTab = 'facts';

function setMemStatus(text) {
  const node = $('#mem-status');
  if (node) node.textContent = text;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function syncMemTabs() {
  $$('.mem-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === memTab));
  $$('.mem-panel').forEach((p) => {
    p.hidden = p.dataset.tab !== memTab;
  });
}

// ------------------------------------------------------------------ SQLite 记忆库
// 页面直接向主进程要 stats + list，卡片只读；置顶 / 删除 / 整理重复走 Worker 命令。
let memDbRows = [];
let memDbStats = null;
let memDbError = '';
let memDbLoading = false;
const memDbExpanded = new Set();

const MEM_LAYER_LABELS = { hot: '热层', warm: '温层', cold: '冷层' };

// Step 5：记忆层级筛选（全部 / 热 / 温 / 冷）
let memLayerFilter = 'all';

function layerKeyOf(row) {
  return row && (row.layer === 'warm' || row.layer === 'cold') ? row.layer : 'hot';
}

const MEM_RELATION_LABELS = {
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  promise: '约定',
  plan: '计划',
  emotion: '情绪',
  relation: '关系',
  fact: '事实',
};

function renderMemoryDb() {
  const enabled = $('#set-memory-enabled');
  if (enabled) enabled.checked = !!settings.memoryEnabled;
  renderMemoryParams();
  renderMemInjection();
  syncMemTabs();
  renderMemArchive();
  void loadMemoryDb();
}

// Step 5：参数滑块。显示值来自 settings，输入即时改内存、松手写 localStorage。
function renderMemoryParams() {
  const setRange = (inputId, valueId, value, label) => {
    const input = $(inputId);
    if (input) input.value = String(value);
    const v = $(valueId);
    if (v) v.textContent = label;
  };
  setRange('#set-mem-theta', '#set-mem-theta-v', settings.longMemoryTheta, settings.longMemoryTheta.toFixed(2));
  setRange('#set-mem-max', '#set-mem-max-v', settings.longMemoryMax, String(settings.longMemoryMax));
  setRange('#set-mem-chars', '#set-mem-chars-v', settings.longMemoryMaxChars, String(settings.longMemoryMaxChars));
  setRange('#set-mem-boost', '#set-mem-boost-v', settings.longMemoryBoost, `+${settings.longMemoryBoost.toFixed(2)}`);
  setRange('#set-mem-penalty', '#set-mem-penalty-v', settings.longMemoryPenalty, `-${settings.longMemoryPenalty.toFixed(2)}`);
  setRange('#set-mem-decay', '#set-mem-decay-v', settings.longMemoryDecay, `×${settings.longMemoryDecay.toFixed(2)}`);
  setRange('#set-mem-warm', '#set-mem-warm-v', settings.longMemoryWarm, settings.longMemoryWarm.toFixed(2));
  setRange('#set-mem-cold', '#set-mem-cold-v', settings.longMemoryCold, settings.longMemoryCold.toFixed(2));
  setRange(
    '#set-mem-delete',
    '#set-mem-delete-v',
    settings.longMemoryDeleteTurns,
    String(settings.longMemoryDeleteTurns)
  );
}

// 每个滑块：输入时夹取范围并即时刷新标签；松手落盘
const MEM_PARAM_SLIDERS = [
  ['#set-mem-theta', 'longMemoryTheta', (v) => clamp(Number(v), 0.2, 0.9)],
  ['#set-mem-max', 'longMemoryMax', (v) => Math.round(clamp(Number(v), 1, 12))],
  ['#set-mem-chars', 'longMemoryMaxChars', (v) => Math.round(clamp(Number(v), 120, 800))],
  ['#set-mem-boost', 'longMemoryBoost', (v) => clamp(Number(v), 0, 1.5)],
  ['#set-mem-penalty', 'longMemoryPenalty', (v) => clamp(Number(v), 0, 2)],
  ['#set-mem-decay', 'longMemoryDecay', (v) => clamp(Number(v), 0.2, 3)],
  [
    '#set-mem-warm',
    'longMemoryWarm',
    (v) => Math.max(settings.longMemoryCold, clamp(Number(v), 0.05, 1.2)),
  ],
  ['#set-mem-cold', 'longMemoryCold', (v) => clamp(Number(v), 0.02, 0.6)],
  ['#set-mem-delete', 'longMemoryDeleteTurns', (v) => Math.round(clamp(Number(v), 5, 200))],
];

MEM_PARAM_SLIDERS.forEach(([inputId, key, parse]) => {
  const input = $(inputId);
  if (!input) return;
  input.oninput = () => {
    const next = parse(input.value);
    if (Number.isFinite(next)) settings[key] = next;
    // 温层阈值必须不小于冷层阈值
    if (key === 'longMemoryCold') {
      settings.longMemoryWarm = Math.max(settings.longMemoryWarm, settings.longMemoryCold);
    }
    renderMemoryParams();
  };
  input.onchange = () => {
    store.set('agentpet.settings', settings);
    renderMemInjection();
  };
});

async function loadMemoryDb({ silent = false } = {}) {
  const box = $('#mem-facts');
  if (!box) return;
  if (!window.petApi || typeof petApi.memoryCall !== 'function') {
    memDbError = '当前环境没有记忆库接口';
    renderMemDbMeta();
    renderMemFacts();
    renderMemInjection();
    return;
  }
  if (memDbLoading) return;
  memDbLoading = true;
  if (!memDbStats && !memDbRows.length) {
    box.innerHTML = '<div class="action-empty">读取记忆库…</div>';
  }
  try {
    const [stats, list] = await Promise.all([
      petApi.memoryCall('stats', {}),
      petApi.memoryCall('list', { limit: 500 }),
    ]);
    memDbStats = stats || null;
    memDbRows = Array.isArray(list && list.results) ? list.results : [];
    memDbError = '';
    if (!silent) consoleLog('记忆', `记忆库已刷新：${memDbRows.length} 条`);
  } catch (err) {
    memDbError = (err && err.message) || String(err);
  } finally {
    memDbLoading = false;
    renderMemDbMeta();
    renderMemFacts();
    renderMemInjection();
  }
}

// Step 5：本轮注入列表。展示 M 编号、相似度、排序分、激活度、分层，以及被滤掉的候选数量。
function layerForInjected(item) {
  const row = memDbRows.find((r) => r.key === item.key);
  if (row) return layerKeyOf(row);
  if (item.pinned || item.relation === 'constraint') return 'hot';
  const act = Number(item.activation) || 0;
  if (act <= settings.longMemoryCold) return 'cold';
  if (act <= settings.longMemoryWarm) return 'warm';
  return 'hot';
}

function renderMemInjection() {
  const list = $('#mem-inject-list');
  const meta = $('#mem-inject-meta');
  if (!list) return;
  const ctx = longMemoryContext || {};
  const items = Array.isArray(ctx.items) ? ctx.items : [];
  const dropped = ctx.dropped || {};
  const candidate = Number(ctx.candidateCount) || 0;
  const query = String(ctx.query || '').trim();

  if (!settings.memoryEnabled) {
    if (meta) {
      meta.textContent = '长期记忆已关闭';
      meta.title = '';
    }
    list.innerHTML = '<div class="mem-inject-empty">开启「启用长期记忆」后，这里会显示每轮注入的记忆。</div>';
    return;
  }

  if (meta) {
    if (!query) {
      meta.textContent = '等待第一次检索…';
      meta.title = '';
    } else {
      const bits = [`候选 ${candidate}`, `注入 ${items.length}`, `θ ${Number(settings.longMemoryTheta).toFixed(2)}`];
      if (dropped.belowTheta) bits.push(`低于阈值 ${dropped.belowTheta}`);
      if (dropped.duplicate) bits.push(`重复 ${dropped.duplicate}`);
      if (dropped.meta) bits.push(`元信息 ${dropped.meta}`);
      const hiddenBits = dropped.overLimit + dropped.vipOverLimit;
      if (hiddenBits) bits.push(`限额截断 ${hiddenBits}`);
      meta.textContent = `「${query.length > 16 ? `${query.slice(0, 16)}…` : query}」 · ${bits.join(' · ')}`;
      meta.title = query;
    }
  }

  list.innerHTML = '';
  if (!query) {
    const empty = document.createElement('div');
    empty.className = 'mem-inject-empty';
    empty.textContent = '还没有检索结果。发一条消息后，这里会列出这一轮注入给模型的记忆。';
    list.appendChild(empty);
    return;
  }
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mem-inject-empty';
    empty.textContent = ctx.note || '本轮没有命中长期记忆（候选 0 条或全部低于阈值）。';
    list.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'mem-inject-item';

    const id = document.createElement('span');
    id.className = 'mem-inject-id';
    id.textContent = String(item.id || 'M?');

    const body = document.createElement('div');
    body.className = 'mem-inject-body';

    const fact = document.createElement('p');
    fact.className = 'mem-inject-fact';
    fact.textContent = String(item.fact || '');
    fact.title = String(item.fact || '');

    const layer = layerForInjected(item);
    const chips = [
      ['相似度', (Number(item.similarity) || 0).toFixed(2), ''],
      ['排序分', (Number(item.score) || 0).toFixed(2), ''],
      ['激活度', (Number(item.activation) || 0).toFixed(2), ''],
      ['分层', MEM_LAYER_LABELS[layer], layer],
      ['类型', MEM_RELATION_LABELS[item.relation] || item.relation || '事实', ''],
    ];
    if (item.vip) chips.push(['通道', 'VIP', 'vip']);
    if (item.pinned) chips.push(['通道', '置顶', 'vip']);

    const tags = document.createElement('div');
    tags.className = 'mem-inject-tags';
    chips.forEach(([label, value, cls]) => {
      const chip = document.createElement('span');
      chip.className = `mem-inject-chip${cls ? ` ${cls}` : ''}`;
      chip.textContent = `${label} ${value}`;
      tags.appendChild(chip);
    });

    body.append(fact, tags);
    row.append(id, body);
    list.appendChild(row);
  });
}

function renderMemDbMeta() {
  const box = $('#mem-db-meta');
  if (!box) return;
  box.innerHTML = '';
  if (memDbError) {
    const err = document.createElement('div');
    err.className = 'mem-db-line danger';
    err.textContent = `记忆库读取失败：${memDbError}`;
    box.appendChild(err);
    return;
  }
  const s = memDbStats;
  if (!s) {
    const loading = document.createElement('div');
    loading.className = 'mem-db-line';
    loading.textContent = '读取中…';
    box.appendChild(loading);
    return;
  }
  const lines = [
    ['数据库文件', s.dbPath || '（尚未初始化）'],
    ['条目', `${Number(s.memories) || 0} 条`],
    ['表述向量', `${Number(s.vectors) || 0} 条`],
    ['体积', formatBytes(s.bytes)],
    ['轮次', String(Number(s.turn) || 0)],
    ['生命周期轮次', String(Number(s.lifeTurn) || 0)],
    ['向量模型', s.embedModel ? `${s.embedModel}${s.embedDim ? ` · ${s.embedDim} 维` : ''}` : '尚未加载'],
    ['FTS 分词器', s.ftsTokenizer || '—'],
  ];
  const layers = { hot: 0, warm: 0, cold: 0 };
  memDbRows.forEach((row) => {
    const key = row.layer === 'cold' || row.layer === 'warm' ? row.layer : 'hot';
    layers[key] += 1;
  });
  lines.push(['分层', `热 ${layers.hot} · 温 ${layers.warm} · 冷 ${layers.cold}`]);
  lines.push(['指示灯', '绿 = 热层 · 黄 = 温层 · 灰 = 冷层（颜色与分层一致）']);
  const bootDeduped = Number(s.bootInfo && s.bootInfo.deduped) || 0;
  if (bootDeduped > 0) lines.push(['启动自动整理', `合并 ${bootDeduped} 条重复`]);
  lines.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'mem-db-line';
    const k = document.createElement('span');
    k.className = 'mem-db-k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'mem-db-v';
    v.textContent = value;
    v.title = value;
    row.append(k, v);
    box.appendChild(row);
  });
}

function renderMemFacts() {
  const box = $('#mem-facts');
  if (!box) return;
  const count = $('#mem-facts-count');
  if (count) count.textContent = String(memDbRows.length);
  // 分层计数 + 筛选按钮状态
  const layers = { all: memDbRows.length, hot: 0, warm: 0, cold: 0 };
  memDbRows.forEach((row) => {
    layers[layerKeyOf(row)] += 1;
  });
  ['all', 'hot', 'warm', 'cold'].forEach((key) => {
    const el = $(`#mem-layer-${key}`);
    if (el) el.textContent = String(layers[key]);
  });
  $$('.mem-layer-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.layer || 'all') === memLayerFilter);
  });
  box.innerHTML = '';
  if (memDbError) {
    box.innerHTML = `<div class="action-empty">记忆库读取失败：${escapeHtml(memDbError)}</div>`;
    return;
  }
  if (!memDbRows.length) {
    box.innerHTML =
      '<div class="action-empty">记忆库里还没有条目。对话中压缩上下文时会写入长期记忆，也可以先聊聊对方的偏好。</div>';
    return;
  }
  const sorted = memDbRows.slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return (Number(b.activation) || 0) - (Number(a.activation) || 0);
  });
  const filtered =
    memLayerFilter === 'all' ? sorted : sorted.filter((row) => layerKeyOf(row) === memLayerFilter);
  if (!filtered.length) {
    box.innerHTML = `<div class="action-empty">${MEM_LAYER_LABELS[memLayerFilter]}还没有记忆。调低冷层阈值或等记忆衰减下来才会进来。</div>`;
    return;
  }
  filtered.forEach((row) => box.appendChild(memFactCard(row)));
}

function memFactCard(row) {
  const card = document.createElement('div');
  card.className = 'mem-card' + (row.pinned ? ' pinned' : '');
  card.dataset.key = String(row.key || '');

  const head = document.createElement('div');
  head.className = 'mem-card-head';

  const tag = document.createElement('span');
  tag.className = 'mem-tag';
  tag.textContent = `#${MEM_RELATION_LABELS[row.relation] || row.relation || '事实'}`;
  if (String(row.polarity || 'positive') === 'negative') tag.textContent += ' · 否定';

  const activation = Number(row.activation) || 0;
  const truth = Number.isFinite(Number(row.truth)) ? Number(row.truth) : 1;
  const layer = row.layer === 'cold' || row.layer === 'warm' ? row.layer : 'hot';
  const dot = document.createElement('span');
  // 指示灯颜色跟「分层」一致：绿=热层 / 黄=温层 / 灰=冷层，
  // 不要再按激活度另外分档，否则同为热层却出现两种颜色。
  dot.className = 'mem-dot ' + (layer === 'cold' ? 'low' : layer === 'warm' ? 'mid' : 'high');
  dot.title = `${MEM_LAYER_LABELS[layer]} · 激活度 ${activation.toFixed(2)} · 置信度 ${truth.toFixed(2)}`;

  const layerTag = document.createElement('span');
  layerTag.className = `mem-layer-tag ${layer}`;
  layerTag.textContent = MEM_LAYER_LABELS[layer];
  layerTag.title = '分层：热层正常检索 / 温层仅作候选 / 冷层归档';

  const spacer = document.createElement('span');
  spacer.className = 'mem-spacer';

  const pin = document.createElement('button');
  pin.className = 'mem-icon-btn mem-pin' + (row.pinned ? ' on' : '');
  pin.textContent = '📌';
  pin.title = row.pinned ? '取消置顶' : '置顶（检索时优先注入）';
  pin.onclick = async (ev) => {
    ev.stopPropagation();
    try {
      await petApi.memoryCall('pin', { key: row.key, pinned: !row.pinned });
      toast(row.pinned ? '已取消置顶' : '已置顶', 'accent');
      await loadMemoryDb({ silent: true });
    } catch (err) {
      toast(`置顶失败：${err && err.message ? err.message : err}`);
    }
  };

  const del = document.createElement('button');
  del.className = 'mem-icon-btn danger';
  del.textContent = '✕';
  del.title = '删除这条记忆（不可恢复）';
  del.onclick = async (ev) => {
    ev.stopPropagation();
    if (!window.confirm(`删除这条记忆？\n\n${String(row.fact || '').slice(0, 80)}`)) return;
    try {
      await petApi.memoryCall('delete', { key: row.key });
      memDbExpanded.delete(row.key);
      toast('记忆已删除');
      await loadMemoryDb({ silent: true });
    } catch (err) {
      toast(`删除失败：${err && err.message ? err.message : err}`);
    }
  };

  head.append(tag, layerTag, spacer, dot, pin, del);

  const body = document.createElement('p');
  body.className = 'mem-body';
  body.textContent = row.fact || '';

  const details = memDetails(row);
  // 展开区里允许选中 / 复制来源原文，点击不要顺手把卡片收起
  details.onclick = (ev) => ev.stopPropagation();

  card.append(head, body, details);
  card.classList.toggle('open', !details.hidden);
  card.onclick = (ev) => {
    if (ev.target.closest && ev.target.closest('button')) return;
    const open = details.hidden;
    details.hidden = !open;
    card.classList.toggle('open', open);
    if (open) memDbExpanded.add(row.key);
    else memDbExpanded.delete(row.key);
  };
  return card;
}

function memDetailRow(label, value) {
  const row = document.createElement('div');
  row.className = 'mem-detail-row';
  const k = document.createElement('span');
  k.className = 'mem-detail-k';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'mem-detail-v';
  v.textContent = String(value == null || value === '' ? '—' : value);
  row.append(k, v);
  return row;
}

function memDetails(row) {
  const box = document.createElement('div');
  box.className = 'mem-details';
  box.hidden = !memDbExpanded.has(row.key);
  const truth = Number.isFinite(Number(row.truth)) ? Number(row.truth) : 1;
  const activation = Number(row.activation) || 0;
  box.append(
    memDetailRow('置信度 truth', truth.toFixed(2)),
    memDetailRow('激活度 activation', activation.toFixed(2)),
    memDetailRow('主体 / 类型', `${row.subject || 'user'} · ${row.relation || 'fact'}`),
    memDetailRow('客体归一化', row.object_norm || ''),
    memDetailRow('分层', `${MEM_LAYER_LABELS[row.layer] || row.layer || '热层'}（${row.layer || 'hot'}）`),
    memDetailRow('命中 / 未命中', `${Number(row.hit_count) || 0} / ${Number(row.miss_count) || 0}`),
    memDetailRow('创建轮次', row.created_turn),
    memDetailRow('最近更新轮次', row.last_update_turn),
    memDetailRow('最近命中轮次', row.last_hit_turn),
    memDetailRow('更新时间', fmtArchiveTime(row.updated_at)),
    memDetailRow('主键', row.key || '')
  );
  if (String(row.source_text || '').trim()) {
    box.appendChild(memDetailRow('来源原文', row.source_text));
  }
  return box;
}

function renderMemArchive() {
  const box = $('#mem-archive');
  if (!box) return;
  const count = $('#mem-archive-count');
  if (count) count.textContent = String(memoryArchive.length);
  box.innerHTML = '';
  if (!memoryArchive.length) {
    box.innerHTML =
      '<div class="action-empty">还没有归档。压缩上下文时生成的摘要会存到这里，模型返回 SKIP 的不存。</div>';
    return;
  }
  memoryArchive.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'mem-tl-item';
    const dot = document.createElement('div');
    dot.className = 'mem-tl-dot';
    const body = document.createElement('div');
    body.className = 'mem-tl-body';
    const head = document.createElement('div');
    head.className = 'mem-tl-head';
    const time = document.createElement('span');
    time.textContent = fmtArchiveTime(item.at);
    const del = document.createElement('button');
    del.className = 'mem-icon-btn danger';
    del.textContent = '✕';
    del.title = '永久删除这条归档';
    del.onclick = () => {
      memoryArchive = memoryArchive.filter((x) => x.id !== item.id);
      store.set('agentpet.memoryArchive', memoryArchive);
      renderMemArchive();
      toast('归档已删除');
    };
    head.append(time, del);
    const text = document.createElement('p');
    text.textContent = item.text;
    body.append(head, text);
    row.append(dot, body);
    box.appendChild(row);
  });
}

$$('.mem-tab').forEach((btn) => {
  btn.onclick = () => {
    memTab = btn.dataset.tab || 'facts';
    syncMemTabs();
  };
});

// Step 5：分层筛选
$$('.mem-layer-btn').forEach((btn) => {
  btn.onclick = () => {
    memLayerFilter = btn.dataset.layer || 'all';
    renderMemFacts();
  };
});

const memEnabledInput = $('#set-memory-enabled');
if (memEnabledInput) {
  memEnabledInput.onchange = () => {
    settings.memoryEnabled = memEnabledInput.checked;
    store.set('agentpet.settings', settings);
    toast(settings.memoryEnabled ? '长期记忆已开启' : '长期记忆已关闭');
    if (settings.memoryEnabled) void ensureMemoryModel();
  };
}

const memRefreshBtn = $('#btn-mem-refresh');
if (memRefreshBtn) {
  memRefreshBtn.onclick = () => {
    memRefreshBtn.disabled = true;
    void loadMemoryDb().finally(() => {
      memRefreshBtn.disabled = false;
    });
  };
}

const memDedupeBtn = $('#btn-mem-dedupe');
if (memDedupeBtn) {
  memDedupeBtn.onclick = async () => {
    if (!window.petApi || typeof petApi.memoryCall !== 'function') return;
    memDedupeBtn.disabled = true;
    try {
      const res = await petApi.memoryCall('dedupe', {});
      const merged = Number(res && res.merged) || 0;
      toast(merged ? `已合并 ${merged} 条重复记忆` : '没有发现重复记忆', merged ? 'accent' : '');
      consoleLog('记忆', merged ? `整理重复：合并 ${merged} 条` : '整理重复：没有发现重复条目');
      await loadMemoryDb({ silent: true });
    } catch (err) {
      toast(`整理失败：${err && err.message ? err.message : err}`);
    } finally {
      memDedupeBtn.disabled = false;
    }
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 归档页：清空对话前先存一份，误删也能翻回来
// 归档已从 localStorage 搬到 userData/data/archives.json：
// localStorage 只有 5MB 级容量，而一条归档就是整段会话，多角色后必然撑爆。
let archives = [];
let currentArchiveId = '';

async function loadArchives() {
  // 新项目从零开始，不做旧版 localStorage 迁移
  try {
    const disk = await petApi.readJsonData('archives');
    archives = Array.isArray(disk) ? disk : [];
  } catch (err) {
    archives = [];
    consoleLog('归档', `读取归档失败：${err && err.message ? err.message : err}`);
  }
}

async function saveArchives() {
  try {
    await petApi.writeJsonData('archives', archives);
    return true;
  } catch (err) {
    consoleLog('归档', `保存归档失败：${err && err.message ? err.message : err}`);
    return false;
  }
}

function fmtArchiveTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 把当前会话存进归档；没有实质内容就不存，避免产生空条目
function archiveCurrentChat() {
  const kept = chatState.messages.filter(
    (m) =>
      (m.role === 'user' && String(m.text || '').trim()) ||
      (m.role === 'ai' && (String(m.text || '').trim() || String(m.think || '').trim())) ||
      (m.toolCalls || []).length
  );
  if (!kept.length) return false;

  const firstUser = kept.find((m) => m.role === 'user' && String(m.text || '').trim());
  const plain = kept.map((m) => ({
    role: m.role,
    text: m.text || '',
    think: m.think || '',
    at: m.at,
    ts: m.ts,
    stopped: !!m.stopped,
    toolCalls: (m.toolCalls || []).map((t) => ({
      name: t.name,
      args: t.args,
      result: t.result,
      at: t.at,
      ts: t.ts,
    })),
  }));
  archives.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    // 归档是全局的：带角色信息，@ 面板与归档页才分得清是谁的会话
    characterId: (activeCharacter && activeCharacter.id) || '',
    characterName: charNameText() || '',
    title: String((firstUser && firstUser.text) || '未命名会话')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 30),
    startedAt: (kept[0] && kept[0].ts) || Date.now(),
    endedAt: Date.now(),
    messages: plain,
  });
  // 搬到文件后不再受 localStorage 容量限制，放宽到 200 条，多角色切换时不至于过早挤掉旧会话
  archives = archives.slice(0, 200);
  saveArchives();
  return true;
}

function archivePreview(a) {
  const last = [...a.messages].reverse().find((m) => String(m.text || '').trim());
  const text = last ? last.text : a.messages.reduce((acc, m) => acc || m.think || '', '');
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function renderArchives() {
  const list = $('#archive-list');
  if (!list) return;
  list.innerHTML = '';
  if (!archives.length) {
    list.innerHTML = '<div class="action-empty" style="grid-column:1/-1">还没有归档。清空对话时会自动存到这里。</div>';
    return;
  }
  archives.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'memory-card archive-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const head = document.createElement('div');
    head.className = 'memory-card-head';
    const title = document.createElement('b');
    title.textContent = a.title;
    const time = document.createElement('span');
    time.className = 'archive-time';
    time.textContent = [a.characterName, fmtArchiveTime(a.endedAt)].filter(Boolean).join(' · ');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'archive-del';
    del.title = '永久删除';
    del.textContent = '✕';
    del.onclick = (e) => {
      e.stopPropagation();
      deleteArchive(a.id);
    };
    head.append(title, time, del);
    const p = document.createElement('p');
    p.textContent = archivePreview(a);
    const count = document.createElement('span');
    count.className = 'archive-count';
    count.textContent = `${a.messages.length} 条消息`;
    card.append(head, p, count);
    card.onclick = () => openArchive(a.id);
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openArchive(a.id);
      }
    };
    list.appendChild(card);
  });
}

// 永久删除：归档只在这里真正消失，平时清空对话只是搬进来
function deleteArchive(id) {
  const a = archives.find((x) => x.id === id);
  if (!a) return;
  if (!window.confirm(`永久删除这条归档？\n「${a.title}」删除后无法恢复。`)) return;
  archives = archives.filter((x) => x.id !== id);
  saveArchives();
  closeArchive();
  renderArchives();
  toast('归档已永久删除', 'accent');
}

function openArchive(id) {
  const a = archives.find((x) => x.id === id);
  if (!a) return;
  currentArchiveId = id;
  $('#archive-list').hidden = true;
  $('#btn-archive-back').hidden = false;
  const viewer = $('#archive-viewer');
  viewer.hidden = false;
  $('#archive-viewer-title').textContent = a.title;
  $('#archive-viewer-meta').textContent = `${fmtArchiveTime(a.startedAt)} → ${fmtArchiveTime(a.endedAt)} · ${a.messages.length} 条消息`;

  const box = $('#archive-transcript');
  box.innerHTML = '';
  a.messages.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'archive-msg';
    const who = document.createElement('div');
    who.className = 'archive-who';
    who.textContent = `${m.at ? m.at + ' · ' : ''}${m.role === 'user' ? '用户' : (charNameText() || '角色')}${m.stopped ? ' · 已停止' : ''}`;
    row.appendChild(who);
    if (m.role === 'user') {
      const body = document.createElement('div');
      body.className = 'archive-body';
      body.textContent = m.text;
      row.appendChild(body);
    } else {
      if (m.think) {
        const think = document.createElement('div');
        think.className = 'archive-think';
        think.textContent = m.think;
        row.appendChild(think);
      }
      if (m.text) {
        const body = document.createElement('div');
        body.className = 'archive-body';
        body.textContent = m.text;
        row.appendChild(body);
      }
    }
    (m.toolCalls || []).forEach((t) => {
      const tool = document.createElement('div');
      tool.className = 'archive-tool';
      tool.textContent = `⚙ ${t.name} ${t.args || '{}'}\n→ ${t.result || ''}`;
      row.appendChild(tool);
    });
    box.appendChild(row);
  });
  viewer.scrollIntoView({ block: 'nearest' });
}

function closeArchive() {
  currentArchiveId = '';
  $('#archive-list').hidden = false;
  $('#btn-archive-back').hidden = true;
  $('#archive-viewer').hidden = true;
}

$('#btn-archive-back').onclick = closeArchive;
$('#btn-archive-close').onclick = closeArchive;
$('#btn-archive-delete').onclick = () => {
  if (currentArchiveId) deleteArchive(currentArchiveId);
};

// ---- 控制台页（DSH 风格）
// 一份会话，两个视图：聊天只看自然语言，控制台看思考 / 工具 / 内核事件
// 序号要在重启后接着历史最大值往下走，否则新消息会排到旧消息前面
let entrySeq = chatState.messages.reduce(
  (max, m) => Math.max(max, m.seq || 0, ...(m.toolCalls || []).map((t) => t.seq || 0)),
  0
);
function nextSeq() {
  return ++entrySeq;
}

// 很早以前的会话可能整段没有 seq：按数组顺序补一遍，保证压缩点（按 seq）与时间顺序一致。
// 重排会让旧的压缩点数值失效，所以只在这种情况下清空 si.compressCutoffSeq。
const needsSeqFix = chatState.messages.some(
  (m) => !Number.isFinite(m.seq) || m.seq <= 0 || (m.toolCalls || []).some((t) => !Number.isFinite(t.seq) || t.seq <= 0)
);
if (needsSeqFix) {
  chatState.messages.forEach((m) => {
    m.seq = nextSeq();
    (m.toolCalls || []).forEach((t) => {
      t.seq = nextSeq();
    });
  });
  if (Number(store.get('agentpet.compressCutoffSeq', 0)) > 0) store.set('agentpet.compressCutoffSeq', 0);
  if (Number(store.get('agentpet.memoryExtractSeq', 0)) > 0) store.set('agentpet.memoryExtractSeq', 0);
}

const consoleState = {
  // 只存「非对话」事件（内核、操作者、系统、错误）；对话内容从 chatState 派生
  logs: [
    {
      kind: 'system',
      tag: '系统',
      text: '控制台已连接。对话与控制台共用同一份记录，这里会显示更完整的过程。',
      at: stamp(),
      ts: Date.now(),
      seq: nextSeq(),
    },
  ],
  rounds: 0,
  busy: false,
  tokens: 0,
  phase: '',
  startedAt: 0,
  cancelled: false,
};

// 控制台里的「提示词注入」：主进程把真正发出去的请求体原样转回来（同一个字符串），
// 这里只放内存，不持久化、不写 localStorage；最多留最近 20 条。
const promptLog = [];
let currentTurnSeq = 0;

// 提示词条目的排序位置：放在当前这轮 assistant 占位消息之前，保证先看到注入、再看到回答
function promptSeq() {
  for (let i = chatState.messages.length - 1; i >= 0; i -= 1) {
    const m = chatState.messages[i];
    if (m.role === 'ai' && m.streaming) return m.seq - 0.5;
  }
  return nextSeq();
}

function recordPrompt(evt) {
  if (!evt || !evt.body) return;
  const entry = {
    kind: 'prompt',
    at: stamp(),
    ts: Date.now(),
    seq: promptSeq(),
    model: evt.model || '',
    count: evt.messages || 0,
    chars: evt.body.length,
    body: evt.body,
    open: false,
    turn: currentTurnSeq,
  };
  // 同一轮里连续发请求（重试 / 工具循环）时，新的注入覆盖上一条，控制台只占一行；
  // 后台任务（记忆提取 / 压缩）不属于任何一轮，不合并
  const prev = promptLog[promptLog.length - 1];
  const replacePrev = prev && prev.kind === 'prompt' && entry.turn > 0 && prev.turn === entry.turn;
  if (replacePrev) {
    promptLog[promptLog.length - 1] = entry;
  } else {
    promptLog.push(entry);
    if (promptLog.length > 20) promptLog.shift();
  }
  scheduleConsoleRender();
}

// ------------------------------------------------------------------ 上下文压缩记录
// 压缩也按「一行折叠」显示：对话窗口里在消息之间，控制台里排在对应位置。
// 只留元信息 + 摘要，跟会话一样放在 localStorage，不新增文件。保留最近 8 条。
const COMPACT_KEEP = 8;
let compactLog = store.get('agentpet.compactLog', []);
if (!Array.isArray(compactLog)) compactLog = [];
// 老数据没有 kind 字段，补上，控制台合并条目时靠它分派渲染
compactLog.forEach((c) => {
  if (c) c.kind = 'compact';
});

function saveCompactLog() {
  compactLog = compactLog.slice(-COMPACT_KEEP);
  store.set('agentpet.compactLog', compactLog);
  // 压缩日志也属于当前会话，跟 session.json 一起落盘
  saveChatSession();
}

// 压缩开始：先插一行「正在压缩」（标题走 skeleton 扫光），结束后再改写
function beginCompact({ auto = false, dialogCount = 0, tokens = 0 } = {}) {
  const entry = {
    kind: 'compact',
    id: `c${Date.now().toString(36)}`,
    seq: nextSeq(),
    at: stamp(),
    ts: Date.now(),
    auto: !!auto,
    phase: 'running',
    dialogCount,
    tokens,
    summary: '',
    open: false,
  };
  compactLog.push(entry);
  saveCompactLog();
  renderChat();
  renderConsole();
  return entry;
}

function updateCompact(entry, patch) {
  if (!entry) return;
  Object.assign(entry, patch || {});
  saveCompactLog();
  renderChat();
  renderConsole();
}

function dropCompact(entry) {
  if (!entry) return;
  compactLog = compactLog.filter((c) => c.id !== entry.id);
  saveCompactLog();
  renderChat();
  renderConsole();
}

function clearCompactLog() {
  if (!compactLog.length) return;
  compactLog = [];
  saveCompactLog();
}

// ------------------------------------------------------------------ 统计
// 当前会话（si.stats）在清空 / 继承时归零；累计（si.statsTotal）一直到手动清零
const DEFAULT_STATS = {
  calls: 0,
  toolCalls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  modelMs: 0,
  toolMs: 0,
  ttftSum: 0,
  ttftCount: 0,
  outMs: 0,
};

function loadStats(key) {
  const saved = store.get(key, null);
  const out = { ...DEFAULT_STATS };
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_STATS)) {
      const v = Number(saved[k]);
      if (Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

let statsSession = loadStats('agentpet.stats');
let statsTotal = loadStats('agentpet.statsTotal');

function saveStats() {
  store.set('agentpet.stats', statsSession);
  store.set('agentpet.statsTotal', statsTotal);
}

function bumpStats(patch) {
  [statsSession, statsTotal].forEach((s) => {
    for (const k of Object.keys(patch)) s[k] += Number(patch[k]) || 0;
  });
  saveStats();
  if (document.querySelector('.settings-page.active[data-page="stats"]')) renderStatsPage();
}

function resetSessionStats() {
  statsSession = { ...DEFAULT_STATS };
  saveStats();
  if (document.querySelector('.settings-page.active[data-page="stats"]')) renderStatsPage();
}

function resetAllStats() {
  statsSession = { ...DEFAULT_STATS };
  statsTotal = { ...DEFAULT_STATS };
  consoleState.tokens = 0;
  saveStats();
  renderStatsPage();
}

function estimateMessagesTokens(messages) {
  return (messages || []).reduce((n, m) => {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const toolPart = m.tool_calls ? JSON.stringify(m.tool_calls) : '';
    return n + 4 + estimateTokens(body) + estimateTokens(toolPart);
  }, 0);
}

// 真实接口返回 usage 时用真实数；mock / 没返回时按字符估算
function recordUsage(acc, { messages = [], ms = 0, ttftMs = 0 } = {}) {
  const usage = (acc && acc.usage) || {};
  const promptRaw = Number(usage.prompt_tokens);
  const prompt = Number.isFinite(promptRaw) ? promptRaw : estimateMessagesTokens(messages);
  const cached = Number(usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0) || 0;
  const completionRaw = Number(usage.completion_tokens);
  const completion = Number.isFinite(completionRaw)
    ? completionRaw
    : estimateTokens(`${(acc && acc.content) || ''}${(acc && acc.reasoning) || ''}`);
  const genMs = Math.max(0, ms - (ttftMs || 0));
  bumpStats({
    calls: 1,
    promptTokens: prompt,
    cachedTokens: Math.min(cached, prompt || cached),
    completionTokens: completion,
    modelMs: ms || 0,
    ttftSum: ttftMs || 0,
    ttftCount: ttftMs > 0 ? 1 : 0,
    outMs: genMs,
  });
  consoleState.tokens += completion;
}

function fmtNum(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function fmtDuration(ms) {
  const total = Number(ms) || 0;
  if (total < 1000) return `${Math.round(total)}ms`;
  const s = total / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function cacheHitRate(s) {
  return s.promptTokens > 0 ? s.cachedTokens / s.promptTokens : NaN;
}

function renderStatsPage() {
  const max = Math.max(1000, Number(getApiConfig().contextWindow) || 128000);
  const messages = buildChatMessages();
  const systemTokens = estimateTokens(messages[0] ? messages[0].content : '');
  const toolTokens = estimateTokens(JSON.stringify(activeLLMTools()));
  const chatTokens = estimateMessagesTokens(messages.slice(1));
  const used = systemTokens + toolTokens + chatTokens;
  const ratio = used / max;

  const setText = (id, text) => {
    const node = $(id);
    if (node) node.textContent = text;
  };
  const setSeg = (id, tokens) => {
    const node = $(id);
    if (node) node.style.width = `${Math.min(100, (tokens / max) * 100)}%`;
  };

  const pctNode = $('#stats-context-pct');
  if (pctNode) {
    pctNode.textContent = ratio >= 0.1 ? `${Math.round(ratio * 100)}%` : `${(ratio * 100).toFixed(1)}%`;
    pctNode.classList.toggle('over', ratio >= 0.8);
  }
  setText('#stats-context-num', fmtNum(used));
  setText('#stats-context-max', `/ ${fmtNum(max)}`);
  setSeg('#stats-seg-system', systemTokens);
  setSeg('#stats-seg-tools', toolTokens);
  setSeg('#stats-seg-chat', chatTokens);
  setText('#stats-tok-system', fmtNum(systemTokens));
  setText('#stats-tok-tools', fmtNum(toolTokens));
  setText('#stats-tok-chat', fmtNum(chatTokens));

  const rate = cacheHitRate(statsSession);
  setText('#stats-cache-rate', Number.isFinite(rate) ? `${(rate * 100).toFixed(2)}%` : '—');
  setText('#stats-tok-in', fmtNum(Math.max(0, statsSession.promptTokens - statsSession.cachedTokens)));
  setText('#stats-tok-in-all', `累计 ${fmtNum(Math.max(0, statsTotal.promptTokens - statsTotal.cachedTokens))}`);
  setText('#stats-tok-cache', fmtNum(statsSession.cachedTokens));
  setText('#stats-tok-cache-all', `累计 ${fmtNum(statsTotal.cachedTokens)}`);
  setText('#stats-tok-out', fmtNum(statsSession.completionTokens));
  setText('#stats-tok-out-all', `累计 ${fmtNum(statsTotal.completionTokens)}`);

  const ttft = statsSession.ttftCount ? statsSession.ttftSum / statsSession.ttftCount : NaN;
  const ttftAll = statsTotal.ttftCount ? statsTotal.ttftSum / statsTotal.ttftCount : NaN;
  const tps = statsSession.outMs > 0 ? statsSession.completionTokens / (statsSession.outMs / 1000) : NaN;
  const tpsAll = statsTotal.outMs > 0 ? statsTotal.completionTokens / (statsTotal.outMs / 1000) : NaN;

  setText('#stats-calls', `${fmtNum(statsSession.calls)} 轮`);
  setText('#stats-model-ms', fmtDuration(statsSession.modelMs));
  setText('#stats-model-ms-all', `累计 ${fmtDuration(statsTotal.modelMs)}`);
  setText('#stats-tool-ms', fmtDuration(statsSession.toolMs));
  setText('#stats-tool-ms-all', `累计 ${fmtDuration(statsTotal.toolMs)}`);
  setText('#stats-ttft', Number.isFinite(ttft) ? `${Math.round(ttft)}ms` : '—');
  setText('#stats-ttft-all', Number.isFinite(ttftAll) ? `累计 ${Math.round(ttftAll)}ms` : '累计 —');
  setText('#stats-tps', Number.isFinite(tps) ? tps.toFixed(1) : '—');
  setText('#stats-tps-all', Number.isFinite(tpsAll) ? `累计 ${tpsAll.toFixed(1)}` : '累计 —');
  renderAutoCompressSettings();
}

// 统计页的自动压缩开关 / 阈值：设置项与自动压缩逻辑共用 settings.autoCompress*
function renderAutoCompressSettings() {
  const toggle = $('#set-auto-compress');
  const range = $('#set-auto-compress-at');
  const label = $('#set-auto-compress-at-v');
  const row = $('#auto-compress-row');
  if (toggle) toggle.checked = !!settings.autoCompress;
  const pct = Math.round(settings.autoCompressAt * 100);
  if (range) range.value = String(pct);
  if (label) label.textContent = `${pct}%`;
  // .setting-row 是 display:flex，hidden 属性会被样式盖掉，所以直接改 display
  if (row) row.style.display = settings.autoCompress ? '' : 'none';
}

const autoCompressToggle = $('#set-auto-compress');
if (autoCompressToggle) {
  autoCompressToggle.onchange = () => {
    settings.autoCompress = autoCompressToggle.checked;
    store.set('agentpet.settings', settings);
    renderAutoCompressSettings();
    toast(settings.autoCompress ? '已开启上下文自动压缩' : '已关闭上下文自动压缩');
  };
}
const autoCompressRange = $('#set-auto-compress-at');
if (autoCompressRange) {
  autoCompressRange.oninput = (e) => {
    settings.autoCompressAt = clamp((Number(e.target.value) || 75) / 100, 0.3, 0.95);
    renderAutoCompressSettings();
  };
  autoCompressRange.onchange = () => store.set('agentpet.settings', settings);
}

const historyInput = $('#set-history');
if (historyInput) {
  const syncHistoryUi = () => {
    const isMax = settings.historyWindow >= 100;
    const label = $('#set-history-v');
    if (label) {
      label.textContent = String(settings.historyWindow);
      label.hidden = isMax;
    }
    const badge = $('#set-history-max');
    if (badge) badge.hidden = !isMax;
    const warn = $('#history-warn');
    if (warn) {
      if (isMax) {
        warn.hidden = false;
        warn.textContent = '⚠️ MAX 模式将全量发送所有未压缩上下文，将消耗更多 Token 并增加延迟。';
      } else if (settings.historyWindow > 40) {
        warn.hidden = false;
        warn.textContent = `⚠️ 每次携带 ${settings.historyWindow} 轮对话（含工具结果），输入 Token 与花费会明显增加。`;
      } else {
        warn.hidden = true;
      }
    }
  };
  historyInput.value = String(settings.historyWindow);
  syncHistoryUi();
  historyInput.oninput = (e) => {
    settings.historyWindow = clamp(Math.round(Number(e.target.value) || 20), 4, 100);
    syncHistoryUi();
    renderStatsPage();
  };
  historyInput.onchange = () => store.set('agentpet.settings', settings);
}

// Agent 运行参数：轮次上限 + 熔断阈值（拖动即时生效，松手写回设置）
const toolRoundsInput = $('#set-tool-rounds');
if (toolRoundsInput) {
  const syncToolRounds = () => {
    const label = $('#set-tool-rounds-v');
    if (label) label.textContent = String(settings.toolRounds);
  };
  toolRoundsInput.value = String(settings.toolRounds);
  syncToolRounds();
  toolRoundsInput.oninput = (e) => {
    settings.toolRounds = clamp(Math.round(Number(e.target.value) || 8), 3, 20);
    syncToolRounds();
  };
  toolRoundsInput.onchange = () => store.set('agentpet.settings', settings);
}

const toolRepeatInput = $('#set-tool-repeat');
if (toolRepeatInput) {
  const syncToolRepeat = () => {
    const label = $('#set-tool-repeat-v');
    if (label) label.textContent = String(settings.toolRepeatLimit);
  };
  toolRepeatInput.value = String(settings.toolRepeatLimit);
  syncToolRepeat();
  toolRepeatInput.oninput = (e) => {
    settings.toolRepeatLimit = clamp(Math.round(Number(e.target.value) || 3), 2, 10);
    syncToolRepeat();
  };
  toolRepeatInput.onchange = () => store.set('agentpet.settings', settings);
}

// 请求稳定性：无输出超时开关 + 等待时长 + 失败重试次数
function renderLlmResilience() {
  const toggle = $('#set-idle-timeout');
  const row = $('#idle-timeout-row');
  const secRange = $('#set-idle-timeout-sec');
  const secLabel = $('#set-idle-timeout-sec-v');
  const compressRow = $('#compress-idle-row');
  const compressRange = $('#set-compress-idle');
  const compressLabel = $('#set-compress-idle-v');
  const retryRange = $('#set-llm-retries');
  const retryLabel = $('#set-llm-retries-v');
  if (toggle) toggle.checked = !!settings.llmIdleTimeoutOn;
  if (secRange) secRange.value = String(settings.llmIdleTimeoutSec);
  if (secLabel) secLabel.textContent = `${settings.llmIdleTimeoutSec}s`;
  if (compressRange) compressRange.value = String(settings.compressIdleTimeoutSec);
  if (compressLabel) compressLabel.textContent = `${settings.compressIdleTimeoutSec}s`;
  if (retryRange) retryRange.value = String(settings.llmRetries);
  if (retryLabel) retryLabel.textContent = String(settings.llmRetries);
  // .setting-row 是 display:flex，hidden 属性会被样式盖掉，所以直接改 display
  if (row) row.style.display = settings.llmIdleTimeoutOn ? '' : 'none';
  if (compressRow) compressRow.style.display = settings.llmIdleTimeoutOn ? '' : 'none';
}

const idleTimeoutToggle = $('#set-idle-timeout');
if (idleTimeoutToggle) {
  idleTimeoutToggle.onchange = () => {
    settings.llmIdleTimeoutOn = idleTimeoutToggle.checked;
    store.set('agentpet.settings', settings);
    renderLlmResilience();
    toast(settings.llmIdleTimeoutOn ? '已开启无输出自动停止' : '已关闭无输出自动停止');
  };
}
const idleTimeoutSecInput = $('#set-idle-timeout-sec');
if (idleTimeoutSecInput) {
  idleTimeoutSecInput.oninput = (e) => {
    settings.llmIdleTimeoutSec = clamp(Math.round(Number(e.target.value) || 60), 10, 300);
    renderLlmResilience();
  };
  idleTimeoutSecInput.onchange = () => store.set('agentpet.settings', settings);
}
const compressIdleInput = $('#set-compress-idle');
if (compressIdleInput) {
  compressIdleInput.oninput = (e) => {
    settings.compressIdleTimeoutSec = clamp(Math.round(Number(e.target.value) || 180), 30, 600);
    renderLlmResilience();
  };
  compressIdleInput.onchange = () => store.set('agentpet.settings', settings);
}
const notifyToggle = $('#set-notify-background');
if (notifyToggle) {
  notifyToggle.checked = settings.notifyBackground !== false;
  notifyToggle.onchange = () => {
    settings.notifyBackground = notifyToggle.checked;
    store.set('agentpet.settings', settings);
    toast(settings.notifyBackground ? '已开启后台回复通知' : '已关闭后台回复通知');
  };
}

const llmRetriesInput = $('#set-llm-retries');
if (llmRetriesInput) {
  llmRetriesInput.oninput = (e) => {
    settings.llmRetries = clamp(Math.round(Number(e.target.value) || 0), 0, 5);
    renderLlmResilience();
  };
  llmRetriesInput.onchange = () => store.set('agentpet.settings', settings);
}
renderLlmResilience();

// 对话里是否显示「思考」折叠行：默认关闭，聊天窗口只留正文更沉浸
const chatThinkInput = $('#set-chat-think');
if (chatThinkInput) {
  chatThinkInput.checked = !!settings.chatShowThink;
  chatThinkInput.onchange = () => {
    settings.chatShowThink = chatThinkInput.checked;
    store.set('agentpet.settings', settings);
    renderChat();
    toast(settings.chatShowThink ? '对话里已显示思考' : '对话里已隐藏思考');
  };
}

// 图片读取权限：关闭时只放行本会话里拖入 / 输入过的图片
const imageReadToggle = $('#set-image-read');
if (imageReadToggle) {
  imageReadToggle.checked = settings.imageReadPerm === true;
  imageReadToggle.onchange = () => {
    settings.imageReadPerm = imageReadToggle.checked;
    store.set('agentpet.settings', settings);
    toast(settings.imageReadPerm ? '已允许读取任意图片路径' : '仅允许读取本会话出现过的图片');
  };
}

// 重置图片别名编号：主进程把表压紧成 1..N，这里同步改写当前会话里的旧引用，
// 否则历史里残留的 [image_61] 会一直失效、模型也会跟着抄旧号
const ALIAS_TOKEN_RE = /\[image_(\d+)\]/gi;
function replaceAliasTokens(text, mapping) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(ALIAS_TOKEN_RE, (whole, n) => mapping[`[image_${n}]`] || whole);
}
function applyImageAliasMapping(mapping) {
  if (!mapping || !Object.keys(mapping).length) return 0;
  let changed = 0;
  for (const m of chatState.messages) {
    const nextText = replaceAliasTokens(m.text, mapping);
    if (nextText !== m.text) { m.text = nextText; changed += 1; }
    for (const t of m.toolCalls || []) {
      if (!t) continue;
      const nextArgs = replaceAliasTokens(t.args, mapping);
      if (nextArgs !== t.args) { t.args = nextArgs; changed += 1; }
      const nextResult = replaceAliasTokens(t.result, mapping);
      if (nextResult !== t.result) { t.result = nextResult; changed += 1; }
    }
  }
  return changed;
}

const resetAliasBtn = $('#btn-reset-image-alias');
if (resetAliasBtn) {
  resetAliasBtn.onclick = async () => {
    const ok = window.confirm('重置后图片编号会压紧成从 1 开始的连续号码，并同步改写当前会话里的引用，确定继续？');
    if (!ok) return;
    const r = window.petApi && window.petApi.imageAliasReset ? await window.petApi.imageAliasReset() : null;
    if (!r || !r.ok) {
      toast(r && r.error ? `重置失败：${r.error}` : '重置失败', 'error');
      return;
    }
    const changed = applyImageAliasMapping(r.mapping || {});
    if (changed) {
      saveChatSession();
      renderChat();
    }
    toast(changed ? `图片别名编号已重置，${changed} 处历史引用已同步` : '图片别名编号已重置');
  };
}

// 切换角色时是否先把当前会话归档（默认关）
const archiveOnSwitchToggle = $('#set-archive-on-switch');
if (archiveOnSwitchToggle) {
  archiveOnSwitchToggle.checked = settings.archiveOnSwitch === true;
  archiveOnSwitchToggle.onchange = () => {
    settings.archiveOnSwitch = archiveOnSwitchToggle.checked;
    store.set('agentpet.settings', settings);
    toast(settings.archiveOnSwitch ? '切换角色时会先归档当前会话' : '切换角色时不再自动归档');
  };
}

// 切换角色时是否按新角色动作库重建 ACTIONS（默认关）
const rebuildActionsOnSwitchToggle = $('#set-rebuild-actions-on-switch');
if (rebuildActionsOnSwitchToggle) {
  rebuildActionsOnSwitchToggle.checked = settings.rebuildActionsOnSwitch === true;
  rebuildActionsOnSwitchToggle.onchange = () => {
    settings.rebuildActionsOnSwitch = rebuildActionsOnSwitchToggle.checked;
    store.set('agentpet.settings', settings);
    toast(settings.rebuildActionsOnSwitch ? '切换角色时会重建动作预设' : '切换角色时不再重建动作预设');
  };
}

const statsResetBtn = $('#btn-stats-reset');
if (statsResetBtn) {
  statsResetBtn.onclick = () => {
    resetAllStats();
    toast('统计已清零（当前会话与累计）', 'accent');
  };
}

// 控制台的日志开关：默认开。关掉只留警告与错误，
// 系统/内核/队列/记忆/搜索这些过程日志整体收起（对话、工具、压缩、提示词注入照常显示）
const CONSOLE_QUIET_TAGS = new Set(['系统', '内核', '队列', '操作者', '记忆', '搜索', '图片']);
const consolePrefs = (() => {
  const raw = store.get('agentpet.console', null) || {};
  // 老版本只存了 showKernel，这里迁移成通用的 showLogs
  const showLogs = typeof raw.showLogs === 'boolean' ? raw.showLogs : raw.showKernel !== false;
  return { showLogs };
})();

let consoleRenderQueued = false;
function scheduleConsoleRender() {
  if (consoleRenderQueued) return;
  consoleRenderQueued = true;
  requestAnimationFrame(() => {
    consoleRenderQueued = false;
    // 面板窗口只有停在「控制台」页时才需要重绘，别让流式 token 拖累其它页
    const page = $('.settings-page.active');
    const visible =
      el.settingsPanel.classList.contains('show') &&
      (!IS_PANEL || (page && page.dataset.page === 'console'));
    if (visible) renderConsole();
  });
}

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function consoleLog(tag, text) {
  consoleState.logs.push({ kind: 'system', tag, text, at: stamp(), ts: Date.now(), seq: nextSeq() });
  if (consoleState.logs.length > 400) consoleState.logs.shift();
  scheduleConsoleRender();
}

function getApiConfig() {
  const models = loadModels();
  return models.find((m) => m.id === currentModelId()) || models[0];
}

function renderMarkdown(text) {
  const blocks = [];
  const src = String(text || '').replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push({ lang: lang || 'text', code });
    return `\u0000${blocks.length - 1}\u0000`;
  });
  let html = escapeHtml(src);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  html = html
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (/^[-*]\s+/.test(t)) return `<div class="dsh-li">• ${t.replace(/^[-*]\s+/, '')}</div>`;
      if (/^\d+[.)]\s+/.test(t)) return `<div class="dsh-li">${t}</div>`;
      if (/^>\s?/.test(t)) return `<div class="dsh-quote">${t.replace(/^>\s?/, '')}</div>`;
      if (/^#{1,4}\s+/.test(t)) return `<div class="dsh-h">${t.replace(/^#{1,4}\s+/, '')}</div>`;
      return line;
    })
    .join('\n')
    .replace(/\n/g, '<br>');
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const block = blocks[Number(i)];
    return `<div class="dsh-code"><span class="lang">${block.lang}</span><code>${escapeHtml(block.code)}</code></div>`;
  });
}

function prettyArgs(raw) {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
  } catch (_) {
    return String(raw || '{}');
  }
}

// 工具返回可能是 JSON，也可能是纯文本；能解析就缩进，不能就原样
function prettyResult(raw) {
  if (raw === undefined || raw === null) return '';
  const text = String(raw);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (_) {
    return text;
  }
}

// ---------------------------------------------------------------- 提示词注入
// 只做归类与排版，不截断、不摘要：参数 / 系统提示词（按标题分段）/ 对话消息 / 工具定义 /
// 原始请求体。最后一段是发送时的原始字符串，方便和「分类视图」逐字核对。
function promptPre(text) {
  const pre = document.createElement('pre');
  pre.className = 'prompt-pre';
  pre.textContent = String(text == null ? '' : text);
  return pre;
}

// 系统提示词按 markdown 标题切段（# 我是谁 / ## 记忆 / ## 可用动作…），正文一行都不删
function promptHeadingSections(text) {
  const src = String(text || '');
  if (!src.trim()) return [{ title: '（空）', text: src }];
  const out = [];
  let cur = { title: '', lines: [] };
  const flush = () => {
    const bodyText = cur.lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (cur.title || bodyText.trim()) out.push({ title: cur.title, text: bodyText });
    cur = { title: '', lines: [] };
  };
  src.split('\n').forEach((line) => {
    const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      cur.title = m[2].replace(/\s+#+$/, '');
    } else {
      cur.lines.push(line);
    }
  });
  flush();
  const kept = out.filter((s) => s.title || s.text.trim());
  return kept.length ? kept : [{ title: '（原文）', text: src }];
}

function promptSection(title, badge, build) {
  const details = document.createElement('details');
  details.className = 'prompt-sec';
  const summary = document.createElement('summary');
  summary.textContent = `${title}${badge ? ` · ${badge}` : ''}`;
  details.append(summary);
  build(details);
  return details;
}

function promptSub(title, badge, build) {
  const details = document.createElement('details');
  details.className = 'prompt-sub';
  const summary = document.createElement('summary');
  summary.textContent = `${title}${badge ? ` · ${badge}` : ''}`;
  details.append(summary);
  build(details);
  return details;
}

function promptMessageBlock(msg) {
  const box = document.createElement('div');
  box.className = 'prompt-msg';
  const role = document.createElement('span');
  const r = String(msg.role || '?');
  role.className = 'prompt-role role-' + r.replace(/[^a-z]/gi, '');
  role.textContent = r + (msg.name ? `(${msg.name})` : '');
  box.appendChild(role);
  if (typeof msg.content === 'string') {
    if (msg.content) box.appendChild(promptPre(msg.content));
  } else if (msg.content != null) {
    box.appendChild(promptPre(JSON.stringify(msg.content, null, 2)));
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const tag = document.createElement('div');
    tag.className = 'prompt-tag';
    tag.textContent = `tool_calls · ${msg.tool_calls.length}`;
    box.appendChild(tag);
    box.appendChild(promptPre(JSON.stringify(msg.tool_calls, null, 2)));
  }
  if (msg.tool_call_id) {
    const tag = document.createElement('div');
    tag.className = 'prompt-tag';
    tag.textContent = `tool_call_id · ${msg.tool_call_id}`;
    box.appendChild(tag);
  }
  return box;
}

// 「一行折叠」的行头：工具行、提示词注入、上下文压缩共用同一套排版
// （图标 + 标题 + 名称 + 摘要 + 右侧 chevron；运行中标题走 skeleton 扫光）
function foldSummaryHtml({ icon = '', title = '', name = '', brief = '', running = false, runningTitle = '', extra = '' }) {
  return (
    `<span class="tool-icon">${icon}</span>` +
    `<span class="tool-title">${
      running ? `<span class="skeleton-text">${escapeHtml(runningTitle || title)}</span>` : escapeHtml(title)
    }</span>` +
    (name ? `<span class="tool-dot">·</span><span class="tool-name">${escapeHtml(name)}</span>` : '') +
    (brief ? `<span class="tool-dot">·</span><span class="tool-brief">${escapeHtml(brief)}</span>` : '') +
    extra +
    `<span class="chev">›</span>`
  );
}

function renderPromptNode(entry, { showTime = false } = {}) {
  const details = document.createElement('details');
  details.className = 'dsh-tool dsh-prompt chat-prompt';
  details.open = !!entry.open;
  const summary = document.createElement('summary');
  summary.innerHTML = foldSummaryHtml({
    icon: TOOL_ICON_SVGS.prompt,
    title: '提示词注入',
    name: entry.model || 'model',
    brief: `${entry.count} 条消息 · ${entry.chars} 字符`,
    extra: showTime && entry.at ? `<span class="dsh-prompt-time">${entry.at}</span>` : '',
  });
  const body = document.createElement('div');
  body.className = 'tool-body prompt-body';

  let data = null;
  try {
    data = JSON.parse(entry.body);
  } catch (_) {
    /* 非 JSON（理论上不会发生）就只显示原文 */
  }

  if (data && typeof data === 'object') {
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const params = { ...data };
    delete params.messages;
    delete params.tools;

    body.appendChild(
      promptSection('请求参数', `${Object.keys(params).length} 项`, (host) => {
        host.appendChild(promptPre(JSON.stringify(params, null, 2)));
      }),
    );

    const system = messages.filter((m) => m && m.role === 'system');
    const others = messages.filter((m) => !m || m.role !== 'system');
    if (system.length) {
      body.appendChild(
        promptSection('系统提示词', `${system.length} 段 · 按标题分类`, (host) => {
          system.forEach((m) => {
            promptHeadingSections(m.content).forEach((sec) => {
              host.appendChild(
                promptSub(sec.title || '系统提示词', `${sec.text.length} 字`, (sub) => {
                  sub.appendChild(promptPre(sec.text));
                }),
              );
            });
          });
        }),
      );
    }
    if (others.length) {
      body.appendChild(
        promptSection('对话消息', `${others.length} 条`, (host) => {
          others.forEach((m) => host.appendChild(promptMessageBlock(m || {})));
        }),
      );
    }
    if (tools.length) {
      body.appendChild(
        promptSection('工具定义', `${tools.length} 个`, (host) => {
          tools.forEach((t) => {
            const fn = (t && t.function) || {};
            host.appendChild(
              promptSub(fn.name || 'tool', '完整 schema', (sub) => {
                sub.appendChild(promptPre(JSON.stringify(t, null, 2)));
              }),
            );
          });
        }),
      );
    }
  }

  body.appendChild(
    promptSection('原始请求体', `${entry.chars} 字符`, (host) => {
      host.appendChild(promptPre(entry.body));
    }),
  );

  // 展开外层时把内层分类也一起展开：要的就是「一眼看到全量注入」
  const openAll = () => {
    if (details.dataset.expanded === '1') return;
    details.dataset.expanded = '1';
    body.querySelectorAll('details').forEach((d) => {
      d.open = true;
    });
  };
  details.addEventListener('toggle', () => {
    entry.open = details.open;
    if (details.open) openAll();
  });
  if (details.open) openAll();

  details.append(summary, body);
  return details;
}

// 上下文压缩行：进行中 → skeleton「正在压缩」；完成 → 「已压缩上下文 · N 条历史记录 · X tokens」
// 展开看到摘要原文；失败 → 一行红字说明原因
function renderCompactNode(entry, { showTime = false } = {}) {
  const running = entry.phase === 'running';
  const failed = entry.phase === 'error';
  const brief = running
    ? `${entry.dialogCount} 条历史记录`
    : failed
      ? String(entry.error || '压缩失败')
      : `${entry.dialogCount} 条历史记录 · ${entry.tokens} tokens`;
  const details = document.createElement('details');
  details.className = `dsh-tool dsh-compact${failed ? ' is-error' : ''} chat-compact`;
  details.open = !!entry.open;
  const summary = document.createElement('summary');
  summary.innerHTML = foldSummaryHtml({
    icon: TOOL_ICON_SVGS.command,
    title: failed ? '压缩失败' : running ? '压缩上下文' : '已压缩上下文',
    name: 'compact',
    brief,
    running,
    runningTitle: '正在压缩',
    extra: showTime && entry.at ? `<span class="dsh-prompt-time">${entry.at}</span>` : '',
  });
  const body = document.createElement('div');
  body.className = 'tool-body compact-body';
  const meta = [entry.auto ? '自动压缩' : '手动压缩'];
  if (entry.at) meta.push(entry.at);
  if (entry.summary) meta.push(`摘要 ${entry.summary.length} 字`);
  body.innerHTML =
    `<div class="compact-meta">${escapeHtml(meta.join(' · '))}</div>` +
    (entry.summary
      ? `<div class="compact-text">${escapeHtml(entry.summary)}</div>`
      : `<div class="compact-text muted">${
          running ? '正在把这段对话折叠成摘要，完成后这里会显示摘要原文。' : escapeHtml(entry.error || '没有摘要')
        }</div>`);
  details.append(summary, body);
  details.addEventListener('toggle', () => {
    entry.open = details.open;
  });
  return details;
}

function renderEntry(entry, { timeLabel = '' } = {}) {
  const node = document.createElement('div');
  if (entry.kind === 'compact') {
    node.className = 'dsh-compact-wrap';
    node.appendChild(renderCompactNode(entry, { showTime: true }));
    return node;
  }
  if (entry.kind === 'prompt') {
    node.className = 'chat-prompt-wrap';
    node.appendChild(renderPromptNode(entry, { showTime: true }));
    return node;
  }
  if (entry.kind === 'user') {
    node.className = 'dsh-user';
    node.textContent = entry.text;
    if (entry.at) node.title = entry.at;
    // 时间挂在请求气泡旁边（同一分钟只留一次），没有时间就按原样单独一行
    if (!timeLabel) return node;
    const row = document.createElement('div');
    row.className = 'dsh-user-row';
    const label = document.createElement('span');
    label.className = 'dsh-user-time';
    label.textContent = timeLabel;
    row.append(label, node);
    return row;
  }
  if (entry.kind === 'assistant') {
    node.className = 'dsh-assistant';
    // 不再单独画「正在思考 / 输出中」的头部：下面那行 skeleton-text 已经说明状态，
    // 两行同样的字反而重复。时间只标在用户请求上，回答不标时间。

    if (entry.think) {
      const details = buildThinkDetails({
        think: entry.think,
        streaming: entry.streaming,
        phase: entry.phase,
        open: entry.thinkOpen,
        onToggle: (open) => {
          entry.thinkOpen = open;
          if (entry._msg) entry._msg.thinkOpen = open;
        },
      });
      node.appendChild(details);
    }
    if (entry.content) {
      const body = document.createElement('div');
      body.innerHTML = renderMarkdown(entry.content);
      node.appendChild(body);
    } else if (entry.streaming && !entry.think) {
      // 没有推理内容的模型：直接显示扫光占位
      const line = document.createElement('div');
      line.className = 'dsh-stream-line';
      line.innerHTML =
        entry.phase === 'content'
          ? `<span class="stream-dot"></span><span>正在回复</span>`
          : `<span class="skeleton-text">正在思考</span>`;
      node.appendChild(line);
    }
    return node;
  }
  if (entry.kind === 'tool') {
    // 折叠：一行摘要；展开：输入 / 输出两个 JSON 块（参考样例）
    // web_search 另外渲染成可读的结果小卡片（只在控制台出现）
    const isSearch = entry.name === 'web_search' && entry.search;
    // 失败的调用只给「工具调用」四个字染红（调试期一眼能扫到），其余照常
    const failed = entry.status === 'error' || entry.status === 'rate_limited';
    const details = document.createElement('details');
    details.className = `dsh-tool${isSearch ? ' is-search' : ''}${failed ? ' is-error' : ''}`;
    details.open = !!entry.open;
    const summary = document.createElement('summary');
    const brief = isSearch
      ? String(entry.search.query || '')
      : String(entry.args || '{}').replace(/\s+/g, ' ').trim();
    // 运行中：标题用扫光文字，和「正在思考」同一套动效
    const titleText = isSearch || entry.name === 'web_search' ? '联网搜索' : '工具调用';
    const titleHtml = entry.running ? `<span class="skeleton-text">${titleText}</span>` : titleText;
    summary.innerHTML =
      `<span class="tool-icon">${toolIconHtml(entry.name)}</span>` +
      `<span class="tool-title">${titleHtml}</span>` +
      `<span class="tool-dot">·</span>` +
      `<span class="tool-name">${escapeHtml(isSearch ? 'web_search' : entry.name || 'tool')}</span>` +
      (entry.blocked ? '<span class="tool-blocked">已熔断</span>' : '') +
      `<span class="tool-dot">·</span>` +
      `<span class="tool-brief">${escapeHtml(brief)}</span>`;
    const body = document.createElement('div');
    body.className = 'tool-body';

    if (isSearch) {
      const card = entry.search;
      const meta = card.metadata || {};
      const metaBits = [];
      if (card.provider) metaBits.push(card.provider);
      if (Array.isArray(card.results)) metaBits.push(`${card.results.length} 条`);
      if (meta.search_time_ms) metaBits.push(`${meta.search_time_ms}ms`);
      const hits = Array.isArray(card.results) ? card.results : [];
      body.innerHTML =
        `<div class="search-head"><span class="search-query">${escapeHtml(card.query || '')}</span>` +
        (metaBits.length ? `<span class="search-meta">${escapeHtml(metaBits.join(' · '))}</span>` : '') +
        '</div>' +
        (card.error ? `<div class="search-error">${escapeHtml(card.error)}</div>` : '') +
        (hits.length
          ? `<div class="search-hits">${hits
              .map(
                (r, i) =>
                  `<div class="search-hit"><div class="search-hit-title"><span class="search-hit-index">${i + 1}</span>${escapeHtml(
                    r.title || '（无标题）',
                  )}</div>` +
                  (r.url ? `<div class="search-hit-url">${escapeHtml(r.url)}</div>` : '') +
                  (r.snippet ? `<div class="search-hit-snippet">${escapeHtml(r.snippet)}</div>` : '') +
                  '</div>',
              )
              .join('')}</div>`
          : '') +
        (entry.result
          ? `<details class="search-raw"><summary>返回给模型的精简文本</summary><pre class="tool-code">${escapeHtml(
              entry.result,
            )}</pre></details>`
          : '');
    } else {
      body.innerHTML =
        `<div class="tool-block"><div class="tool-label">输入</div><pre class="tool-code">${escapeHtml(prettyArgs(entry.args))}</pre></div>` +
        (entry.result !== undefined && entry.result !== null
          ? `<div class="tool-block"><div class="tool-label">输出</div><pre class="tool-code">${escapeHtml(prettyResult(entry.result))}</pre></div>`
          : '');
    }
    details.append(summary, body);
    details.addEventListener('toggle', () => {
      entry.open = details.open;
      if (entry._tool) entry._tool.open = details.open;
    });
    return details;
  }
  if (entry.kind === 'edit') {
    node.className = 'dsh-edit';
    node.innerHTML = `<span class="icon">✎</span><span>${escapeHtml(entry.text)}</span>`;
    return node;
  }
  if (entry.kind === 'error') {
    node.className = 'dsh-error';
    node.textContent = entry.text;
    return node;
  }
  node.className = 'dsh-system';
  node.dataset.tag = entry.tag || '系统';
  node.innerHTML = `<span class="tag">[${escapeHtml(entry.tag || '系统')}]</span><span>${escapeHtml(entry.text)}</span>`;
  return node;
}

// 把共享会话展开成控制台条目（用户 / 助手 / 工具），再和系统日志按 seq 合并
function buildThreadEntries() {
  const out = [];
  chatState.messages.forEach((m) => {
    if (m.role === 'user') {
      out.push({ kind: 'user', text: m.text, at: m.at, ts: m.ts, seq: m.seq });
      return;
    }
    if (m.text || m.think || m.streaming) {
      const entry = {
        kind: 'assistant',
        content: tidyChatText(m.text),
        think: m.think,
        streaming: m.streaming,
        phase: m.phase,
        thinkOpen: m.streaming ? true : !!m.thinkOpen,
        stopped: m.stopped,
        at: m.at,
        ts: m.ts,
        seq: m.seq,
      };
      entry._msg = m; // 折叠状态写回原消息
      out.push(entry);
    }
    (m.toolCalls || []).forEach((t) => {
      // UI 只认记录里的 status：不管结果来自本地 core 工具还是未来的 Worker 插件
      const status = toolStatusOf(t);
      const entry = {
        kind: 'tool',
        id: t.id || '',
        name: t.name,
        args: t.args,
        result: t.result,
        status,
        blocked: status === 'blocked',
        // 只有本轮还在生成时才算「运行中」；历史里残留的 running 标记不会再扫光
        running: (status === 'running' || status === 'pending') && !!m.streaming,
        search: t.search || null,
        open: !!t.open,
        at: t.at,
        ts: t.ts,
        seq: t.seq,
      };
      entry._tool = t;
      out.push(entry);
    });
  });
  return out;
}

function mergedConsoleEntries() {
  const all = buildThreadEntries().concat(consoleState.logs, promptLog, compactLog);
  all.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return all;
}

function renderConsole() {
  const thread = el.consoleLog;
  if (!thread) return;
  const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const entries = mergedConsoleEntries().filter((e) => {
    if (consolePrefs.showLogs) return true;
    // 关掉日志：对话、工具、压缩、提示词注入都不受影响，只收起过程日志，警告/错误始终保留
    if (e.kind !== 'system') return true;
    return !CONSOLE_QUIET_TAGS.has(e.tag);
  });
  thread.innerHTML = '';
  // 时间只标在用户请求上，同一分钟里连发的几条只留一次
  const gateTime = timeGate();
  entries.forEach((entry) => {
    thread.appendChild(renderEntry(entry, { timeLabel: entry.kind === 'user' ? gateTime(entry) : '' }));
  });
  if (stick) thread.scrollTop = thread.scrollHeight;
  updateConsoleJump();
  updateConsoleMeta();
}

// 只有用户往上翻、离开底部一定距离时才显示「回到底部」按钮
function updateConsoleJump() {
  const thread = el.consoleLog;
  const btn = el.consoleJump;
  if (!thread || !btn) return;
  const away = thread.scrollHeight - thread.scrollTop - thread.clientHeight > 120;
  btn.hidden = !away;
}

function syncConsoleSendButton() {
  const btn = $('#btn-console-send');
  if (!btn) return;
  const busy = consoleState.busy;
  if (btn.dataset.busy === String(busy)) return;
  btn.dataset.busy = String(busy);
  btn.classList.toggle('stop', busy);
  btn.title = busy ? '停止生成' : '发送';
  btn.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.75" y="6.75" width="10.5" height="10.5" rx="2.9"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
}

function updateConsoleMeta() {
  const cfg = getApiConfig();
  const online = !!cfg.key && !cfg.builtin;
  const modelLabel = online ? cfg.name || cfg.model || 'deepseek-chat' : 'Mock 演示';
  const badge = $('#console-mode-badge');
  if (badge) {
    badge.textContent = online ? 'LIVE' : 'MOCK';
    badge.classList.toggle('live', online);
  }
  const model = $('#console-model');
  if (model) model.textContent = online ? modelLabel : 'Mock · 本地规则';

  // 对话面板的模型标签同步当前选择
  const chatModel = $('.chat-model');
  if (chatModel) {
    const who = charNameText();
    chatModel.textContent = `${who ? who + ' · ' : ''}${online ? modelLabel : 'mock'}`;
  }
  const chatSub = $('.chat-sub');
  if (chatSub) chatSub.textContent = online ? `${modelLabel} · 流式对话` : 'Mock 演示 · 未接真实模型';

  const state = pet ? pet.getState() : null;
  const current = state && state.current && !state.isIdle ? shortName(state.current) : '待机';
  const actionEl = $('#dsh-action');
  if (actionEl) actionEl.textContent = current;
  const queueEl = $('#dsh-queue');
  if (queueEl) queueEl.textContent = `队列 ${queue ? queue.queue.length : 0}`;
  const roundsEl = $('#dsh-rounds');
  if (roundsEl) roundsEl.textContent = String(consoleState.rounds);
  const tokensEl = $('#dsh-tokens');
  if (tokensEl) tokensEl.textContent = `~${consoleState.tokens} tok`;

  const live = $('#dsh-live');
  if (live) {
    let text = '就绪';
    if (consoleState.busy) {
      const sec = ((Date.now() - consoleState.startedAt) / 1000).toFixed(1);
      text = `${consoleState.phase === 'content' ? '输出中' : '正在思考'} ${sec}s`;
    }
    live.textContent = text;
    live.classList.toggle('busy', consoleState.busy);
  }
  syncConsoleSendButton();
}


const llmHandlers = new Map();
if (window.petApi && window.petApi.onLLMEvent) {
  window.petApi.onLLMEvent((evt) => {
    const handler = llmHandlers.get(evt.id);
    if (handler) handler(evt);
  });
}
let llmSeq = 0;

// 重试只针对「还没收到任何内容」的失败：一旦已有 token 流出，重试会把内容重复写进同一条消息
function isRetryableLlmError(err, state) {
  if (state && state.emitted) return false;
  const msg = String((err && err.message) || err);
  const m = msg.match(/HTTP\s+(\d{3})/);
  if (m) {
    const code = Number(m[1]);
    // 4xx 里只有限流/请求冲突值得再试；401/403/404 这类重试也没用
    return code === 408 || code === 425 || code === 429 || code >= 500;
  }
  return true; // 网络错误、连接被重置、无输出超时
}

// 把多模态 content 数组降级成纯文本：模型不支持视觉（400/422）时用
function messagesHaveImages(messages) {
  return (messages || []).some(
    (m) => m && Array.isArray(m.content) && m.content.some((part) => part && part.type === 'image_url'),
  );
}
function stripMessageImages(messages) {
  (messages || []).forEach((m) => {
    if (!m || !Array.isArray(m.content)) return;
    const text = m.content
      .filter((part) => part && part.type === 'text')
      .map((part) => String(part.text || ''))
      .join('\n')
      .trim();
    m.content = text || '[图片内容已省略]';
  });
}

// modelId 可选：后台记忆提取可以单独指定一个便宜的小模型，留空则用当前模型
// toolChoice 可选：压缩时回放同一份 tools，但传 'none' 禁止真的调用工具
async function callLLM(messages, { tools, onDelta, cancel = null, modelId = '', toolChoice = '', temperature = null, idleMs = null, extraBody = null } = {}) {
  const models = loadModels();
  const cfg = (modelId && models.find((m) => m.id === modelId)) || getApiConfig();
  if (cfg.builtin || cfg.id === 'mock' || !cfg.key) return callMockLLM(messages, { onDelta, cancel });

  // 无输出超时：0 表示不启用；主进程按这个毫秒数计时，超时主动 abort
  // 压缩等慢任务可以传 idleMs 覆盖，走自己的等待时长
  const idleLimit = idleMs != null
    ? clamp(Math.round(Number(idleMs) || 0), 0, 600000)
    : settings.llmIdleTimeoutOn
      ? clamp(Math.round(Number(settings.llmIdleTimeoutSec) || 60) * 1000, 10000, 300000)
      : 0;
  const retries = clamp(Math.round(Number(settings.llmRetries) || 0), 0, 5);
  const state = { emitted: false };
  // 思考参数：服务商不认时会在这里被摘掉，并记住「这套模型别再用」
  let extra = extraBody && typeof extraBody === 'object' ? extraBody : null;
  let extraDropped = false;
  let imagesDropped = false;

  const requestOnce = () => {
    const id = `llm-${Date.now()}-${++llmSeq}`;
    return new Promise((resolve, reject) => {
      const acc = { content: '', reasoning: '', toolCalls: [] };
      const cleanup = () => {
        llmHandlers.delete(id);
        if (cancel) cancel.abort = null;
      };
      if (cancel) cancel.abort = () => window.petApi.llmCancel(id);
      llmHandlers.set(id, (evt) => {
        if (evt.type === 'reasoning') {
          acc.reasoning += evt.text;
          state.emitted = true;
        } else if (evt.type === 'content') {
          acc.content += evt.text;
          state.emitted = true;
        } else if (evt.type === 'tool_call') {
          state.emitted = true;
          const idx = Number.isInteger(evt.index) ? evt.index : 0;
          const slot = acc.toolCalls[idx] || (acc.toolCalls[idx] = { id: '', name: '', arguments: '' });
          if (evt.callId && !slot.id) slot.id = evt.callId;
          if (evt.name) slot.name = evt.name;
          if (evt.args) slot.arguments += evt.args;
        } else if (evt.type === 'usage') {
          // 流式最后一个 chunk 才带 usage（缓存命中数也从这里拿）
          acc.usage = evt.usage;
        } else if (evt.type === 'request') {
          // 主进程回传的「真正发出去的请求体」，控制台展示用
          recordPrompt(evt);
        } else if (evt.type === 'done') {
          cleanup();
          resolve(acc);
          return;
        } else if (evt.type === 'error') {
          cleanup();
          reject(new Error(evt.message || 'LLM 请求失败'));
          return;
        }
        if (onDelta) onDelta(evt, acc);
      });
      window.petApi.llmStart({
        id,
        base: cfg.base,
        key: cfg.key,
        model: cfg.model,
        messages,
        tools,
        toolChoice,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        idleMs: idleLimit,
        extraBody: extra || undefined,
      });
    });
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestOnce();
    } catch (err) {
      lastErr = err;
      const errMsg = err && err.message ? err.message : String(err);
      // 用户主动点停止不算失败，不重试
      if (cancel && cancel.cancelled) throw err;
      // 服务商不认识思考参数（400/422）：摘掉它立刻重发一次，且不占用重试次数
      if (extra && !extraDropped && /HTTP (400|422)/.test(errMsg)) {
        extra = null;
        extraDropped = true;
        effortUnsupported.add(cfg.id);
        const brief = errMsg.replace(/\s+/g, ' ').slice(0, 120);
        toast('该服务商不接受思考参数，本次已自动关闭', 'warn');
        consoleLog('警告', `思考参数被拒绝（${brief}），已摘掉重发；本模型本次运行不再发送`);
        attempt--;
        continue;
      }
      // 模型不支持图片输入（400/422）：剥掉多模态内容改发纯文本，不占用重试次数
      if (!imagesDropped && /HTTP (400|422)/.test(errMsg) && messagesHaveImages(messages)) {
        stripMessageImages(messages);
        imagesDropped = true;
        toast('当前模型不支持图片输入，已改用文字回执', 'warn');
        consoleLog('警告', `图片输入被拒绝（${errMsg.replace(/\s+/g, ' ').slice(0, 120)}），已降级为纯文字重发`);
        attempt--;
        continue;
      }
      if (!isRetryableLlmError(err, state)) throw err;
      if (attempt >= retries) {
        const tried = attempt > 0 ? `（已重试 ${attempt} 次）` : '';
        throw new Error(`${errMsg}${tried}`);
      }
      const waitMs = Math.min(8000, 1000 * 2 ** attempt);
      consoleLog('警告', `请求失败：${errMsg}；${Math.round(waitMs / 1000)} 秒后重试（${attempt + 1}/${retries}）`);
      await sleep(waitMs);
      if (cancel && cancel.cancelled) throw err;
    }
  }
  throw lastErr || new Error('LLM 请求失败');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < String(text).length; i += size) out.push(String(text).slice(i, i + size));
  return out;
}

async function callMockLLM(messages, { onDelta, cancel } = {}) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const intent = mockIntent(lastUser ? lastUser.content : '');
  const alreadyTool = messages.some((m) => m.role === 'tool');
  const acc = { content: '', reasoning: '', toolCalls: [] };
  const stopped = () => cancel && cancel.cancelled;

  const reasoning = intent.think || '先理解对方的意思，再决定要不要调用工具。';
  for (const chunk of chunkText(reasoning, 5)) {
    if (stopped()) return acc;
    await sleep(30);
    acc.reasoning += chunk;
    if (onDelta) onDelta({ type: 'reasoning', text: chunk }, acc);
  }

  const names = intent.interrupt ? [intent.interrupt] : intent.actions || [];
  if (!alreadyTool && names.length) {
    await sleep(120);
    const args = intent.interrupt
      ? JSON.stringify({ actions: [{ action: names[0] }], front: true })
      : JSON.stringify({ actions: names.map((name) => ({ action: name })) });
    const call = { id: `mock-${Date.now()}`, name: 'play_action', arguments: args };
    acc.toolCalls.push(call);
    if (onDelta) onDelta({ type: 'tool_call', index: 0, id: call.id, name: call.name, args: call.arguments }, acc);
    return acc;
  }

  const reply = alreadyTool ? '动作已经排进队列了。' : intent.text || '收到。';
  for (const chunk of chunkText(reply, 4)) {
    if (stopped()) return acc;
    await sleep(30);
    acc.content += chunk;
    if (onDelta) onDelta({ type: 'content', text: chunk }, acc);
  }
  return acc;
}

// 熔断器：同一工具 + 完全相同的参数连续出现 N 次，就拒绝继续执行，防止模型死循环。
// 计数只在连续相同时累加，换个工具或换个参数立刻清零；每轮用户输入开始时也重置。
let toolCallStreak = { key: '', name: '', count: 0 };
function resetToolCircuit() {
  toolCallStreak = { key: '', name: '', count: 0 };
}
// 参数按键名排序后再序列化：只是字段顺序不同不应算作两次不同调用
function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// ---- 工具记录：唯一写入点
// 一条工具调用的完整生命周期都写在 msg.toolCalls 里，UI 只认这里的 status，
// 不关心结果是从渲染层、主进程还是未来 Worker 里的插件跑出来的。
// id 存的是 tool_call_id：跨进程异步回填结果时靠它找回同一条记录。
const TOOL_STATUSES = new Set(['pending', 'running', 'success', 'error', 'blocked', 'rate_limited']);

// 兼容旧记录：重启后从 si.chat 读回来的可能只有 running / blocked / result
function toolStatusOf(tool) {
  const raw = tool && tool.status;
  if (raw && TOOL_STATUSES.has(raw)) return raw;
  if (tool && tool.blocked) return 'blocked';
  if (tool && tool.running) return 'running';
  return tool && tool.result == null ? 'pending' : 'success';
}

// 工具执行结果统一信封：content 回给模型，status 给 UI，extra 只给 UI（不进模型上下文）
function toolResult(content, status = 'success', extra = null) {
  return { content: String(content == null ? '' : content), status, extra };
}

// 工具记录挂到对应的助手消息上：控制台展示，聊天不展示
// extra 用来挂额外展示数据（比如 web_search 的结构化结果卡片），不进入回给模型的文本
function recordTool(msg, record) {
  if (!msg || !record) return null;
  if (!msg.toolCalls) msg.toolCalls = [];
  const id = String(record.id || '');
  const status = TOOL_STATUSES.has(record.status) ? record.status : 'success';
  // 执行中的占位行原地补全：不删不建，seq 与位置都保持稳定
  const pending = id && msg._pendingTools ? msg._pendingTools.get(id) : null;
  if (pending) {
    msg._pendingTools.delete(id);
    // Map 不参与持久化：清空后直接摘掉字段，避免 si.chat 里出现空对象
    if (!msg._pendingTools.size) delete msg._pendingTools;
    pending.name = String(record.name || pending.name || 'tool');
    pending.args = String(record.args || pending.args || '{}');
    pending.result = record.result == null ? '' : String(record.result);
    pending.status = status;
    pending.finishedAt = record.finishedAt || Date.now();
    if (record.extra && typeof record.extra === 'object') Object.assign(pending, record.extra);
    scheduleConsoleRender();
    return pending;
  }
  const item = {
    id,
    name: String(record.name || 'tool'),
    args: String(record.args || '{}'),
    result: record.result == null ? '' : String(record.result),
    status,
    at: stamp(),
    ts: Date.now(),
    finishedAt: record.finishedAt || Date.now(),
    seq: nextSeq(),
  };
  if (record.extra && typeof record.extra === 'object') Object.assign(item, record.extra);
  msg.toolCalls.push(item);
  scheduleConsoleRender();
  return item;
}

// 工具开始执行：先插一条 running 行，控制台立刻显示扫光「工具调用」
// 用 Map 按 tool_call_id 索引：单槽在并行工具调用（一次返回多个 tool_call）时会互相覆盖
function beginToolRun(msg, call) {
  if (!msg) return null;
  if (!msg.toolCalls) msg.toolCalls = [];
  if (!msg._pendingTools) msg._pendingTools = new Map();
  const id = call && call.id ? String(call.id) : `local_${nextSeq()}`;
  const item = {
    id,
    name: String((call && call.name) || 'tool'),
    args: String((call && call.arguments) || '{}'),
    result: null,
    status: 'running',
    at: stamp(),
    ts: Date.now(),
    startedAt: Date.now(),
    seq: nextSeq(),
  };
  msg.toolCalls.push(item);
  msg._pendingTools.set(id, item);
  scheduleConsoleRender();
  return item;
}

// dispatchTool 已经落记录时这里无事可做；异常或没记录的工具由这里补成终态
function endToolRun(msg, pending, res) {
  if (!msg || !pending) return;
  if (msg._pendingTools && pending.id) {
    msg._pendingTools.delete(pending.id);
    if (!msg._pendingTools.size) delete msg._pendingTools;
  }
  const status = toolStatusOf(pending);
  if (status !== 'running' && status !== 'pending') return;
  pending.result = res && res.content != null ? String(res.content) : '';
  pending.status = res && TOOL_STATUSES.has(res.status) ? res.status : pending.result ? 'success' : 'error';
  pending.finishedAt = Date.now();
  scheduleConsoleRender();
}

// 熔断器：同一工具 + 完全相同的参数连续达到阈值就拒绝（返回警告文案，空字符串表示放行）
function toolCircuitWarning(call, args) {
  const repeatLimit = Math.max(2, Math.min(10, Math.round(Number(settings.toolRepeatLimit) || 3)));
  const callKey = `${call.name}::${stableStringify(args)}`;
  if (toolCallStreak.key === callKey) {
    toolCallStreak.count += 1;
  } else {
    toolCallStreak = { key: callKey, name: call.name, count: 1 };
  }
  if (toolCallStreak.count < repeatLimit) return '';
  return `⚠️ 熔断：工具「${call.name}」已连续 ${toolCallStreak.count} 次用完全相同的参数调用，本次拒绝执行。请修改参数，或先直接回复用户。`;
}

// 工具调度（唯一入口）：鉴权 → 熔断 → 路由 → 落记录 → 统计
// 返回统一信封 { content, status, extra }；content 会作为 role:'tool' 的正文回给模型。
async function dispatchTool(call, msg) {
  const toolStarted = Date.now();
  let args = {};
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch (_) {
    args = {};
  }
  let res = null;

  // 可插拔工具鉴权：只查 tools.config.json 的 enabled。
  // 伪工具（SPEAK / MEM_MARK）在流式解析里直接放行，根本走不到这里，也不需要鉴权。
  const toolCfg = findToolConfig(call.name);
  if (toolCfg && toolCfg.enabled === false) {
    res = toolResult('Error: Tool disabled', 'blocked');
    consoleLog('警告', `工具「${toolCfg.name}」已在设置 → 工具管理里关闭，本次调用被拒绝`);
  } else if (kernelToolGated(call.name)) {
    res = toolResult(
      '画面已关闭（3D 内核停止渲染），动作相关工具暂不可用。需要播放动作时，请让用户关闭「设置 → 性能调节 → 关闭画面」，或从托盘恢复窗口。',
      'blocked',
    );
    consoleLog('警告', `内核停转，「${call.name}」本次调用被拒绝`);
  } else {
    const warning = toolCircuitWarning(call, args);
    if (warning) {
      res = toolResult(warning, 'blocked');
      consoleLog('警告', warning);
      toast(`熔断：${call.name} 连续 ${toolCallStreak.count} 次相同调用已拒绝`, 'warn');
    } else {
      // 路由：插件工具走主进程 IPC 总线，原生工具在渲染层直接执行。
      // 两条路径都返回同一形状的信封，下面的落记录 / 统计不需要知道工具在哪跑。
      res = toolCfg && toolCfg.source === 'plugin' ? await runPluginTool(call, args) : await runCoreTool(call, args);
    }
  }

  // 唯一出口：不管工具在渲染层、主进程还是 Worker 里跑，都从这里写进 msg.toolCalls
  recordTool(msg, {
    id: call.id,
    name: call.name,
    args: call.arguments || '{}',
    result: res.content,
    status: res.status,
    extra: res.extra,
  });
  bumpStats({ toolMs: Date.now() - toolStarted, toolCalls: 1 });
  consoleState.tokens += estimateTokens(res.content);
  scheduleConsoleRender();
  return res;
}

// 插件工具：进程隔离 / 超时 / 串行都在主进程里，渲染层只负责发调用、收信封。
async function runPluginTool(call, args) {
  if (!window.petApi || !window.petApi.pluginCallTool) return toolResult('Error: 插件桥接不可用', 'error');
  try {
    const r = await window.petApi.pluginCallTool(call.name, args);
    const status = r && TOOL_STATUSES.has(r.status) ? r.status : 'error';
    const content = r && r.content != null ? String(r.content) : '';
    if (status !== 'success') consoleLog('警告', `插件工具「${call.name}」返回 ${status}：${content}`);
    return toolResult(content, status);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    consoleLog('警告', `插件工具「${call.name}」调用失败：${msg}`);
    return toolResult(`Error: ${msg}`, 'error');
  }
}

// 原生（core）工具实现：直接读写渲染层的本地对象（queue / pet / store / 搜索桥接）。
// 每个分支只返回信封，不自己写记录——写记录由 dispatchTool 统一负责。
async function runCoreTool(call, args) {
  if (call.name === 'play_action') {
    // 关闭画面时内核没挂载、队列也不存在：明确告诉模型，而不是含糊地「队列尚未就绪」
    if (settings.visualOff === true) {
      return toolResult(
        '画面已关闭（3D 内核没有渲染），现在没法播放动作。可以让用户在「设置 → 性能调节」里关掉「关闭画面」再试。',
        'error',
      );
    }
    if (!queue) return toolResult('动作队列尚未就绪', 'error');
    const list =
      Array.isArray(args.actions) && args.actions.length
        ? args.actions
        : [{ action: args.action || args.name, seconds: args.seconds }];
    const front = args.front === true;
    const added = [];
    for (const item of list) {
      const action = typeof item === 'string' ? item : item && (item.action || item.name);
      const seconds = Number(item && typeof item === 'object' ? item.seconds : undefined);
      if (!action) continue;
      const meta = { source: 'llm' };
      if (Number.isFinite(seconds) && seconds > 0) meta.seconds = seconds;
      if (front) queue.prepend(action, meta);
      else queue.append(action, meta);
      added.push(`${action}${meta.seconds ? `（限时 ${meta.seconds}s）` : ''}`);
    }
    if (!added.length) return toolResult('缺少 action 参数', 'error');
    return toolResult(`${front ? '已插入队首' : '已加入动作队列'}：${added.join('、')}`);
  }
  if (call.name === 'get_state') {
    const snap = queue ? queue.snapshot() : null;
    const st = (snap && snap.state) || (pet && pet.getState ? pet.getState() : null) || {};
    const cfg = store.get('agentpet.settings', settings);
    const pct = typeof st.progress === 'number' ? Math.round(st.progress * 100) : 0;
    const payload = {
      kernel: kernelConfig.label || kernelConfig.entry,
      ready: !!pet,
      busy: snap ? snap.busy : !!st.busy,
      state: st.state || 'unknown',
      current: st.current
        ? {
            name: st.current,
            cn: shortName(st.current),
            loop: !!st.loop,
            duration: st.duration ? +Number(st.duration).toFixed(2) : null,
            elapsed: st.time == null ? null : +Number(st.time).toFixed(2),
            progress: pct,
          }
        : null,
      queue: (snap ? snap.queue : []).map((q) => ({ name: q.name, cn: shortName(q.name), source: q.source || 'manual' })),
      model: {
        scale: cfg.modelScale,
        rotation: cfg.modelRotation,
        mouseFollow: !!cfg.mouseFollow,
        resolution: cfg.resolution,
        background: cfg.background,
      },
      time: new Date().toISOString(),
    };
    return toolResult(JSON.stringify(payload));
  }
  if (call.name === 'note' || call.name === 'memory' || call.name === 'manage_note') {
    // note / memory 是旧会话里的历史工具名，manage_note 是配置里的规范名，都进同一个实现
    return toolResult(runMemoryTool(args || {}));
  }
  if (call.name === 'list_advanced_actions') {
    if (!commonActions) {
      return toolResult('没有分层：完整动作清单已经在系统提示的 ACTIONS 里了。');
    }
    const keyword = String(args.keyword || '').trim();
    const rows = advancedActionLines(keyword);
    if (!rows.length) return toolResult(`没有匹配「${keyword}」的高阶动作`);
    const grouped = new Map();
    rows.forEach((r) => {
      if (!grouped.has(r.section)) grouped.set(r.section, []);
      grouped.get(r.section).push(r.line);
    });
    const body = Array.from(grouped, ([title, lines]) => `## ${title}\n${lines.join('\n')}`).join('\n\n');
    return toolResult(`高阶动作 ${rows.length} 条（常用动作已在 ACTIONS 里，不再重复）：\n\n${body}`);
  }
  if (call.name === 'read_image') {
    const filePath = String(args.path || args.file || '').trim();
    if (!filePath) return toolResult('Error: path is required', 'error');
    // 别名由程序分配，天然只指向本会话可见的图片，不再走路径白名单
    const isAlias = /^\[?image_\d+\]?$/i.test(filePath);
    if (!isAlias && !imagePathAllowed(filePath)) {
      return toolResult(
        '该图片不在本会话允许读取的范围内。请让用户在输入框里拖入这张图片（或直接输入它的完整路径），或在「设置 → Agent 运行」打开「图片读取权限」。',
        'error',
      );
    }
    if (!window.petApi || !window.petApi.imageRead) return toolResult('Error: 图片桥接不可用', 'error');
    let r = null;
    try {
      r = await window.petApi.imageRead(filePath);
    } catch (err) {
      r = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (!r || !r.ok) {
      const error = (r && r.error) || '图片读取失败';
      consoleLog('警告', `图片读取失败：${error}`);
      return toolResult(`Error: ${error}`, 'error');
    }
    const dims = r.width && r.height ? `${r.width}×${r.height}` : '未知尺寸';
    const shownPath = isAlias ? filePath : r.path || '';
    consoleLog('图片', `读取 ${r.name}（${dims}，${Math.round((r.bytes || 0) / 1024)}KB）`);
    // 图片本体只放在信封上，不会写进 msg.toolCalls（避免 localStorage 被 base64 撑爆）
    const envelope = toolResult(`已读取图片：${r.name}（${dims}）。画面内容随下一条消息一起发给你。`, 'success', {
      image: { path: shownPath, name: r.name, width: r.width || 0, height: r.height || 0 },
    });
    envelope.imageDataUrl = r.dataUrl;
    return envelope;
  }
  if (call.name === 'web_search') {
    const query = String(args.query || '').trim();
    if (!query) return toolResult('Error: query is required', 'error');
    if (!window.petApi || !window.petApi.webSearch) return toolResult('Error: 搜索桥接不可用', 'error');
    const wanted = Number(args.max_results);
    const payload = searchPayload(
      query,
      Number.isFinite(wanted) && wanted > 0 ? Math.min(5, Math.max(1, Math.round(wanted))) : 0,
    );
    let resp = null;
    try {
      resp = await window.petApi.webSearch(payload);
    } catch (err) {
      resp = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (!resp || !resp.ok) {
      const error = (resp && resp.error) || '搜索失败';
      consoleLog('搜索', `「${query}」失败：${error}`);
      return toolResult(`Error: ${error}`, 'error', { search: { query, error } });
    }
    const searchCard = {
      query: resp.query || query,
      provider: resp.provider || '',
      results: Array.isArray(resp.results) ? resp.results : [],
      metadata: resp.metadata || null,
    };
    const ms = resp.metadata && resp.metadata.search_time_ms ? ` · ${resp.metadata.search_time_ms}ms` : '';
    consoleLog('搜索', `「${query}」${searchCard.results.length} 条${ms}（${searchCard.provider}）`);
    return toolResult(resp.text || '', 'success', { search: searchCard });
  }

  // 未登记的名字：本轮只有 core 工具，插件运行时接入前统一按未知工具回给模型
  return toolResult(`未知工具：${call.name}`, 'error');
}

// 粗估 token：中日韩字符按 1 个，其它字符按 4 个折 1 个
function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) >= 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

// 与聊天共用同一个发送入口：同一份会话，控制台只是更细的视图
async function sendConsole() {
  const raw = composerText(el.consoleInput);
  const text = raw.trim();
  if (!text) return;
  if (raw.startsWith('/')) {
    // 控制台输入框的占位提示就是「/ 调用指令」，这里的斜杠同样只走指令
    const cmd = slashFilterCommands(text.slice(1))[0];
    hideSlashMenu();
    if (cmd) runSlashCommand(cmd.id, el.consoleInput, true);
    else toast('没有匹配的指令');
    return;
  }
  if (slashState.editor === el.consoleInput) hideSlashMenu();
  if (chatBusy || autoCompressRunning) {
    toast('正在生成，点击停止按钮可中断');
    return;
  }
  const refs = collectComposerRefs(el.consoleInput);
  clearComposer(el.consoleInput);
  await sendMessage(text, refs);
}

function cancelConsole() {
  cancelChat();
}

$('#btn-console-send').onclick = () => (consoleState.busy ? cancelConsole() : sendConsole());

if (el.consoleLog) el.consoleLog.addEventListener('scroll', updateConsoleJump, { passive: true });
if (el.consoleJump) {
  el.consoleJump.onclick = () => {
    if (!el.consoleLog) return;
    el.consoleLog.scrollTo({ top: el.consoleLog.scrollHeight, behavior: 'smooth' });
    el.consoleJump.hidden = true;
  };
}

$('#dsh-log-toggle').classList.toggle('active', consolePrefs.showLogs);
$('#dsh-log-toggle').onclick = () => {
  consolePrefs.showLogs = !consolePrefs.showLogs;
  store.set('agentpet.console', consolePrefs);
  $('#dsh-log-toggle').classList.toggle('active', consolePrefs.showLogs);
  renderConsole();
};
el.consoleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendConsole();
  }
});

$('#btn-console-clear').onclick = () => {
  if (chatBusy) cancelChat();
  // 同一份会话：清控制台就是清对话；先归档，误删可在设置里翻回来
  const archived = archiveCurrentChat();
  chatSession += 1;
  if (chatCancel && chatCancel.abort) chatCancel.abort();
  chatCancel = null;
  chatBusy = false;
  consoleState.busy = false;
  consoleState.phase = '';
  consoleState.cancelled = true;
  consoleState.logs = [
    { kind: 'system', tag: '系统', text: '控制台已清空。', at: stamp(), ts: Date.now(), seq: nextSeq() },
  ];
  promptLog.length = 0;
  consoleState.rounds = 0;
  consoleState.tokens = 0;
  chatState.messages = [];
  chatState.cleared = true;
  clearCompactLog();
  currentTurnSeq = 0;
  saveChatSession();
  setChatSending(false);
  syncConsoleSendButton();
  renderChat();
  renderConsole();
  toast(archived ? '控制台与对话已清空，会话已归档' : '控制台与对话已清空');
};

// 导出当前会话：把控制台条目（去掉内部引用）落成 JSON 文件
function exportConsoleSession() {
  const entries = mergedConsoleEntries().map(({ _msg, _tool, ...rest }) => rest);
  const payload = { exportedAt: new Date().toISOString(), entries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `si-console-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('控制台会话已导出');
}

$('#btn-console-export').onclick = exportConsoleSession;

/* -------------------------------------------------------------------------
 * 输入框底部两个开关：深度思考 / 智能搜索
 * 智能搜索与「设置 → 工具管理」里的 web_search 是同一个开关，永远以配置为准；
 * 深度思考要等模型配置了思考参数才能点，目前先做成不可用的外壳。
 * ---------------------------------------------------------------------- */
const chipIconCache = new WeakMap();

function chipIconOf(chip) {
  if (!chip) return null;
  if (chipIconCache.has(chip)) return chipIconCache.get(chip);
  const holder = chip.querySelector('.chip-icon');
  const svg = holder && holder.querySelector('svg');
  const name = holder && holder.dataset.icon;
  const icon = window.SiChipIcons && svg ? window.SiChipIcons.mount(svg, name) : null;
  chipIconCache.set(chip, icon);
  return icon;
}

function setChipState(chip, on, animate) {
  if (!chip) return;
  const next = !!on;
  const was = chip.getAttribute('aria-pressed') === 'true';
  chip.setAttribute('aria-pressed', next ? 'true' : 'false');
  const icon = chipIconOf(chip);
  if (!icon) return;
  if (animate && was !== next) icon.playTo(next ? icon.lastFrame : 0);
  else icon.setFrame(next ? icon.lastFrame : 0);
}

// animate=false 用于首屏/配置变化时直接定格，避免每次渲染都播动画
// 控制台的胶囊和主界面的两个图标按钮都挂 data-mode，状态永远一致
function syncModeChips(animate = false) {
  document.querySelectorAll('[data-mode="search"]').forEach((chip) => {
    const loaded = toolsConfigLoaded;
    const on = loaded && isToolEnabled('web_search');
    chip.disabled = !loaded;
    chip.title = loaded
      ? on
        ? '智能搜索已开启（与「设置 → 工具管理」同一个开关）'
        : '开启联网搜索（与「设置 → 工具管理」同一个开关）'
      : '正在读取工具配置…';
    setChipState(chip, on, animate);
  });

  document.querySelectorAll('[data-mode="think"]').forEach((chip) => {
    const cfg = getApiConfig();
    const supported = effortSupported(cfg);
    const on = supported && !!store.get('agentpet.thinkOn', false);
    chip.disabled = !supported;
    chip.title = supported
      ? on
        ? `思考已开启 · ${effortLabel()}` + '（发送时合并进请求体）'
        : '思考已关闭 · 点击开启（参数在 设置 → 模型 里配置）'
      : effortUnsupported.has(cfg && cfg.id)
        ? '该服务商拒绝了思考参数，本次运行已停用'
        : '当前模型没有配置思考参数：设置 → 模型 → 思考参数';
    setChipState(chip, on, animate);
  });
}

document.querySelectorAll('[data-mode="search"]').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const on = isToolEnabled('web_search');
    await setToolEnabled('web_search', !on);
    syncModeChips(true);
    if (!on) {
      const cfg = loadSearchConfig();
      const needsKey = cfg.provider !== 'mock' && cfg.provider !== 'searxng';
      if (needsKey && !cfg.apiKey) toast('搜索服务还没配 Key：设置 → 联网搜索', 'warn');
    }
  });
});

document.querySelectorAll('[data-mode="think"]').forEach((chip) => {
  chip.addEventListener('click', () => {
    const next = !store.get('agentpet.thinkOn', false);
    store.set('agentpet.thinkOn', next);
    syncModeChips(true);
    const label = effortLabel();
    toast(next ? `思考已开启：${label}` : '思考已关闭', 'accent');
    consoleLog('系统', `思考强度：${next ? '开启' : '关闭'} · ${label}`);
  });
});

document.querySelectorAll('[data-mode]').forEach((chip) => chipIconOf(chip));
syncModeChips(false);

// ------------------------------------------------------------------ 视线跟随
let lastLook = { x: 0, y: 0 };

document.addEventListener('pointermove', (e) => {
  if (!pet) return;
  if (!settings.mouseFollow) return;
  if (e.target && e.target.closest && e.target.closest('.panel, .dock, .top-bar, .toast')) return;
  const rect = el.stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
  lastLook = {
    x: Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1)),
    y: Math.max(-1, Math.min(1, -(((e.clientY - rect.top) / rect.height) * 2 - 1))),
  };
  pet.setLookAt(lastLook.x, lastLook.y);
});

function releaseLook() {
  if (!pet) return;
  if (!settings.releaseOnLeave) return;
  if (pet.releaseLookAt) pet.releaseLookAt();
  else if (pet.clearLookAt) pet.clearLookAt();
}

document.addEventListener('mouseleave', releaseLook);
window.addEventListener('blur', releaseLook);
document.addEventListener('visibilitychange', () => {
  if (!pet) return;
  if (document.hidden) {
    if (pet.releaseLookAt) pet.releaseLookAt({ instant: true });
    else if (pet.clearLookAt) pet.clearLookAt();
  }
});

// ------------------------------------------------------------------ 模型缩放 / 旋转
// 新内核（poc4）只挂 window.__p4，旧内核（poc）挂 window.__poc；两边都暴露 root / THREE
function kernelDebug() {
  const w = el.frame.contentWindow;
  return (w && (w.__p4 || w.__poc)) || null;
}

function kernelRoot() {
  const dbg = kernelDebug();
  return (dbg && dbg.root) || null;
}

// 内核 root 的基准高度与未缩放时的局部包围盒（脚底 / 头顶），缩放中心靠它换算
let modelBaseY = 0;
let modelSpan = null;

function measureModelSpan(root) {
  const poc = kernelDebug();
  if (!poc || !poc.THREE || !poc.THREE.Box3) return null;
  const savedScale = root.scale.x;
  const savedY = root.position.y;
  // 先还原成 scale=1 / 基准位置，量出来的才是模型自身的局部范围
  root.scale.setScalar(1);
  root.position.y = modelBaseY;
  root.updateMatrixWorld(true);
  const box = new poc.THREE.Box3().setFromObject(root);
  root.scale.setScalar(savedScale);
  root.position.y = savedY;
  root.updateMatrixWorld(true);
  if (!Number.isFinite(box.min.y) || !Number.isFinite(box.max.y)) return null;
  return { min: box.min.y - modelBaseY, max: box.max.y - modelBaseY };
}

function applyModelTransform() {
  const root = kernelRoot();
  if (root) {
    root.rotation.y = (settings.modelRotation * Math.PI) / 180;
    const scale = settings.modelScale;
    root.scale.setScalar(scale);
    if (!modelSpan) modelSpan = measureModelSpan(root);
    if (modelSpan) {
      // 缩放中心 0 = 脚底不动，1 = 头顶不动：锚点固定，根部整体平移补偿
      const pivot = clamp(settings.scalePivot, 0, 1);
      const anchor = modelSpan.min + (modelSpan.max - modelSpan.min) * pivot;
      root.position.y = modelBaseY + anchor * (1 - scale);
    }
  }
  syncModelControls();
}

function syncModelControls() {
  const scale = $('#set-scale');
  const rot = $('#set-rotation');
  const pivot = $('#set-pivot');
  const scaleV = $('#set-scale-v');
  const rotV = $('#set-rotation-v');
  const pivotV = $('#set-pivot-v');
  if (scale) scale.value = String(settings.modelScale);
  if (rot) rot.value = String(Math.round(settings.modelRotation));
  if (pivot) pivot.value = String(settings.scalePivot);
  if (scaleV) scaleV.textContent = `${Math.round(settings.modelScale * 100)}%`;
  if (rotV) rotV.textContent = `${Math.round(settings.modelRotation)}°`;
  if (pivotV) pivotV.textContent = `${Math.round(settings.scalePivot * 100)}%`;
  // Dock 浮层里的同一个滑块
  const dockPivot = $('#set-pivot-dock');
  const dockPivotV = $('#pivot-pop-v');
  if (dockPivot) dockPivot.value = String(Math.round(settings.scalePivot * 100));
  if (dockPivotV) dockPivotV.textContent = `${Math.round(settings.scalePivot * 100)}%`;
}

// 滚轮缩放
el.stage.addEventListener(
  'wheel',
  (e) => {
    if (settings.visualOff === true) return; // 关闭画面时没有模型可调
    e.preventDefault();
    settings.modelScale = clamp(settings.modelScale + (e.deltaY < 0 ? 0.05 : -0.05), 0.6, 1.8);
    applyModelTransform();
    store.set('agentpet.settings', settings);
    el.hint.classList.add('hide');
  },
  { passive: false }
);

// 按住左键拖动旋转
let modelDrag = null;
el.stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (settings.visualOff === true) return; // 关闭画面时没有模型可转
  if (settings.disableRotate === true) return; // 用户禁用了拖动旋转
  if (e.target.closest && e.target.closest('.panel, .dock, .top-bar')) return;
  modelDrag = { x: e.clientX };
  el.stage.classList.add('grabbing');
  el.hint.classList.add('hide');
});
window.addEventListener('pointermove', (e) => {
  if (!modelDrag) return;
  const dx = e.clientX - modelDrag.x;
  modelDrag.x = e.clientX;
  settings.modelRotation += dx * 0.6;
  settings.modelRotation = ((((settings.modelRotation + 180) % 360) + 360) % 360) - 180;
  applyModelTransform();
});
window.addEventListener('pointerup', () => {
  if (!modelDrag) return;
  modelDrag = null;
  el.stage.classList.remove('grabbing');
  store.set('agentpet.settings', settings);
});

// 设置页滑块 / 重置
const scaleInput = $('#set-scale');
const rotationInput = $('#set-rotation');
const pivotInput = $('#set-pivot');
if (scaleInput) {
  scaleInput.oninput = (e) => {
    settings.modelScale = Number(e.target.value);
    applyModelTransform();
  };
  scaleInput.onchange = () => store.set('agentpet.settings', settings);
}
if (rotationInput) {
  rotationInput.oninput = (e) => {
    settings.modelRotation = Number(e.target.value);
    applyModelTransform();
  };
  rotationInput.onchange = () => store.set('agentpet.settings', settings);
}
if (pivotInput) {
  pivotInput.oninput = (e) => {
    settings.scalePivot = Number(e.target.value);
    applyModelTransform();
  };
  pivotInput.onchange = () => store.set('agentpet.settings', settings);
}
$('#btn-reset-view').onclick = () => {
  settings.modelScale = 1;
  settings.modelRotation = 0;
  settings.scalePivot = 0;
  applyModelTransform();
  store.set('agentpet.settings', settings);
  toast('视图已复位', 'accent');
};

// Dock 浮层的「禁用旋转」：开启时回到默认朝向，并且舞台区不再响应拖动
const noRotateSwitch = $('#dock-no-rotate');

function syncNoRotateSwitch() {
  const off = settings.disableRotate === true;
  if (noRotateSwitch) noRotateSwitch.checked = off;
  // 舞台提示跟着改，避免还写着「拖动旋转」
  if (el.hint) el.hint.textContent = off ? '滚轮缩放' : '滚轮缩放 · 按住左键拖动旋转';
}

if (noRotateSwitch) {
  noRotateSwitch.onchange = (e) => {
    settings.disableRotate = e.target.checked;
    if (settings.disableRotate) {
      settings.modelRotation = 0; // 恢复默认角度
      applyModelTransform();
    }
    syncNoRotateSwitch();
    store.set('agentpet.settings', settings);
  };
}
syncNoRotateSwitch();

// ------------------------------------------------------------------ 窗口按钮
// 主界面左上角 #btn-pin 和设置底栏最右 #taskbar-pin 是同一个开关，状态互相同步
let windowPinned = false;

function syncPinUi(pinned) {
  const on = !!pinned;
  windowPinned = on;
  const mainBtn = $('#btn-pin');
  if (mainBtn) mainBtn.classList.toggle('active', on);
  const barBtn = $('#taskbar-pin');
  if (barBtn) {
    barBtn.classList.toggle('active', on);
    barBtn.title = on ? '取消窗口置顶' : '窗口置顶（始终显示在最前）';
    barBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

async function toggleWindowPin() {
  if (!window.petApi) return;
  const next = await window.petApi.setPinned(!windowPinned);
  syncPinUi(next);
  toast(next ? '窗口已置顶' : '已取消置顶');
}

if (window.petApi) {
  window.petApi.getPinned().then(syncPinUi);
  // 主进程把真实置顶状态广播回来，避免两个入口各自记一份状态
  if (typeof window.petApi.onPinned === 'function') window.petApi.onPinned(syncPinUi);
  window.petApi.getClickThrough().then((on) => ($('#set-clickthrough').checked = !!on));
}
if ($('#btn-pin')) $('#btn-pin').onclick = toggleWindowPin;
if ($('#taskbar-pin')) $('#taskbar-pin').onclick = toggleWindowPin;
// 底栏右下角贴边按钮：直接切到控制台
if ($('#taskbar-console')) $('#taskbar-console').onclick = () => switchSettingsPage('console');
$('#btn-min').onclick = () => window.petApi && window.petApi.minimize();
$('#btn-close').onclick = () => {
  if (window.petApi && window.petApi.hideWindow) {
    window.petApi.hideWindow();
    toast('已收起到系统托盘，右键托盘图标可退出');
  }
};

// 全透明模式的顶部拖动条：按下抓住窗口，主进程按屏幕坐标跟随鼠标
(() => {
  const hint = $('#drag-hint');
  if (!hint) return;
  let dragging = false;
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    hint.classList.remove('dragging');
    if (window.petApi && window.petApi.stopWindowDrag) window.petApi.stopWindowDrag();
  };
  hint.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !window.petApi || !window.petApi.startWindowDrag) return;
    dragging = true;
    hint.classList.add('dragging');
    try {
      hint.setPointerCapture(e.pointerId);
    } catch (_) {
      /* 捕获失败也不影响移动，只是松手在窗口外可能收不到 pointerup */
    }
    window.petApi.startWindowDrag();
    e.preventDefault();
  });
  hint.addEventListener('pointerup', stop);
  hint.addEventListener('pointercancel', stop);
  hint.addEventListener('lostpointercapture', stop);
})();

// ------------------------------------------------------------------ 状态轮询
let fpsFrames = 0;
let fpsLast = performance.now();
let fps = 0;
let lastStat = 0;

function updateStatQueue(snap) {
  $('#stat-queue').textContent = String(snap.queue.length);
}

function loop(now) {
  fpsFrames++;
  if (now - fpsLast >= 500) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsLast));
    fpsFrames = 0;
    fpsLast = now;

    if (el.settingsPanel.classList.contains('show')) {
      // FPS / 内存是主窗口内核的指标；面板窗口没有内核，不冒充
      if (!IS_PANEL) {
        // 优先用内核自己的报表（帧生成时出图 30Hz，壳的 rAF 仍是 60Hz）
        let shown = String(fps);
        if (pet && typeof pet.getPerformance === 'function') {
          try {
            const p = pet.getPerformance();
            if (p && Number.isFinite(p.fps) && p.fps > 0) shown = String(Math.round(p.fps));
          } catch (_) {
            /* 报表拿不到就用壳的计数 */
          }
        }
        $('#stat-fps').textContent = shown;
      }
      if (pet) {
        const s = pet.getState();
        $('#stat-state').textContent = s.busy ? shortName(s.current || '忙') : '待机';
        $('#stat-queue').textContent = String(queue ? queue.queue.length : 0);
        if (!IS_PANEL && performance.memory) {
          $('#stat-mem').textContent = `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB`;
        }
      }
    }
    if (consoleState.busy) updateConsoleMeta();
  }

  tickProgress();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);

// ------------------------------------------------------------------ 跨窗口
// 只有「添加动作」是独立窗口；它不能直接碰内核，把入队命令回传给主窗口执行。
const syncBus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('agentpet.sync.v1') : null;

function postCmd(cmd) {
  if (syncBus) syncBus.postMessage({ type: 'cmd', cmd });
}

function closePanelWindow() {
  if (window.petApi && window.petApi.closePanel) window.petApi.closePanel();
  else window.close();
}

// 动作窗口里的队列是代理：只负责把命令送出去
if (IS_PANEL) {
  queue = {
    queue: [],
    paused: false,
    snapshot: () => ({ state: {}, queue: [], paused: false, busy: false }),
    togglePause() {
      postCmd({ type: 'queue', op: 'togglePause' });
      return !this.paused;
    },
    append(name, meta = {}) {
      postCmd({ type: 'queue', op: 'append', name, meta });
      return this.queue.length + 1;
    },
    prepend(name, meta = {}) {
      postCmd({ type: 'queue', op: 'prepend', name, meta });
      return this.queue.length + 1;
    },
    remove(index) {
      postCmd({ type: 'queue', op: 'remove', index });
    },
    clear() {
      postCmd({ type: 'queue', op: 'clear' });
    },
    interrupt(name, options = {}) {
      postCmd({ type: 'queue', op: 'interrupt', name, clearQueue: !!options.clearQueue });
    },
  };
}

function handleCmd(cmd) {
  if (cmd.type !== 'queue' || !queue) return;
  if (cmd.op === 'append') queue.append(cmd.name, cmd.meta || {});
  else if (cmd.op === 'prepend') queue.prepend(cmd.name, cmd.meta || {});
  else if (cmd.op === 'remove') queue.remove(Number(cmd.index));
  else if (cmd.op === 'clear') queue.clear();
  else if (cmd.op === 'togglePause') queue.togglePause();
  else if (cmd.op === 'interrupt') queue.interrupt(cmd.name, { clearQueue: !!cmd.clearQueue });
  renderQueue(queue.snapshot());
}

if (syncBus) {
  syncBus.onmessage = (event) => {
    const data = event.data || {};
    if (!IS_PANEL && data.type === 'cmd') handleCmd(data.cmd || {});
  };
}

function initPanelWindow() {
  // 动作窗口只放「添加动作」列表，队列本身不在这里出现
  document.title = '添加动作';
  const bar = $('#panel-bar');
  if (bar) bar.hidden = false;
  const titleEl = $('#panel-bar-title');
  if (titleEl) titleEl.textContent = '添加动作';
  const closeBtn = $('#panel-bar-close');
  if (closeBtn) closeBtn.onclick = () => closePanelWindow();
  const minBtn = $('#panel-bar-min');
  if (minBtn) minBtn.onclick = () => window.petApi && window.petApi.minimizePanel();

  el.actionPanel.classList.remove('show');
  fetchActions().then(() => openPicker());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanelWindow();
  });
}

// ------------------------------------------------------------------ 启动
// 先从主进程取装配好的配置（components.json + 当前角色，含内核入口），
// 再读内核目录的 actions.json（中文名 / 分类）挂内核与动作库——换角色只换配置，代码不用动。
async function bootstrap() {
  await loadAppConfig();
  // 情感档案跟着角色走：开关关闭时内部直接返回，不会产生额外 IO
  void loadEmotionState();
  // 读完配置才知道应用名 / 角色名：静态文案里的名字在这里统一替换
  applyUiNames();
  // 会话已按角色落盘：读当前角色的 session.json（首次会把 localStorage 旧会话迁过来）
  await loadChatSession();
  await loadActionMeta();
  // 插件注册表先读：工具管理里要按插件分组显示，也需要权限清单做二次确认
  await loadPlugins();
  // 预热 @ 面板的「最近图片」，第一次按 @ 不用等 IPC
  void refreshMentionImages(0);
  // 可插拔工具注册表：决定系统提示里拼哪些工具说明、执行时放行哪些 Tool Call
  await loadToolsConfig();
  // 归档改由文件承载，先读盘（首次会把 localStorage 的旧归档迁过来）
  await loadArchives();
  syncModeChips(false);

  syncModelControls();
  renderChat();
  renderMemories();
  renderConsole();
  renderExtensionPage();
  if (!IS_PANEL) {
    subscribeTasks();
    // 底栏常驻：先把「空闲 + 壳版本号」画出来，有任务时再被事件覆盖
    renderTaskBar();
  }

  if (IS_PANEL) {
    initPanelWindow();
    return;
  }

  applyBackground();
  // 把当前外观同步给主进程，保证下次启动用的窗口类型与设置一致
  persistAppearance();
  syncRenderBackendUi(); // 配置读完后才知道当前是内置还是导入内核
  if (settings.visualOff === true) {
    // 关闭画面：不挂内核（布局不变，只在舞台中间显示「已停止渲染」）
    applyVisualOff();
    consoleLog('系统', '画面已关闭：3D 内核未挂载');
  } else {
    consoleLog('系统', '壳已启动，等待 3D 内核…');
    mountKernel(currentKernelEntry());
  }

  // 调试/截图入口：?page=console|preset|actions…
  const bootPage = BOOT_PARAMS.get('page');
  if (bootPage === 'actions') {
    closeAllPanels('action');
    el.actionPanel.classList.add('show');
    $('#btn-action').classList.add('active');
    openPicker();
  } else if (bootPage) {
    openSettingsPage(bootPage);
    // 截图验证入口：?page=injection&tab=emotion|options
    if (bootPage === 'injection' && BOOT_PARAMS.get('tab')) setInjectTab(BOOT_PARAMS.get('tab'));
  }

  if (BOOT_PARAMS.get('demo') === '1' && bootPage === 'console') {
    setTimeout(() => {
      setComposerText(el.consoleInput, '你好，挥个手');
      sendConsole();
    }, 1200);
  }

  // 截图验证用：连续入队三个动作，检查队列是否依次推进。
  if (BOOT_PARAMS.get('demo') === '1' && bootPage === 'actions') {
    const startQueueDemo = () => {
      if (!queue) return setTimeout(startQueueDemo, 300);
      ['dialog_single_wave', 'dialog_virtual_single_idle_nod', 'dialog_single_wave'].forEach((name) =>
        queue.append(name, { source: 'demo' }),
      );
    };
    setTimeout(startQueueDemo, 800);
  }
}

bootstrap();
