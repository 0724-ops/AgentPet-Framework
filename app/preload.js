// Si desktop companion - preload bridge (contextIsolation on, nodeIntegration off).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('petApi', {
  quit: () => ipcRenderer.invoke('pet:quit'),
  hideWindow: () => ipcRenderer.invoke('pet:hide'),
  minimize: () => ipcRenderer.invoke('pet:minimize'),

  getPinned: () => ipcRenderer.invoke('pet:pin:get'),
  // 后台回复通知：渲染层只在设置开关打开时调用，是否真的弹由主进程按窗口焦点决定
  notifyReply: (payload) => ipcRenderer.invoke('notify:reply', payload),
  setPinned: (enabled) => ipcRenderer.invoke('pet:pin:set', enabled),
  onPinned: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, enabled) => cb(enabled);
    ipcRenderer.on('pet:pinned', listener);
    return () => ipcRenderer.removeListener('pet:pinned', listener);
  },

  getClickThrough: () => ipcRenderer.invoke('pet:clickthrough:get'),
  setClickThrough: (enabled) => ipcRenderer.invoke('pet:clickthrough:set', enabled),
  toggleClickThrough: () => ipcRenderer.invoke('pet:clickthrough:toggle'),
  // 打开设置时恢复默认窗口尺寸
  resetWindowSize: () => ipcRenderer.invoke('pet:window:default-size'),
  // 全透明背景时关掉窗口系统投影
  setWindowShadow: (on) => ipcRenderer.invoke('pet:shadow:set', on),
  // 背景外观（毛玻璃材质 / 浓度）：写入主进程，下次启动按它建窗
  getAppearance: () => ipcRenderer.invoke('pet:appearance:get'),
  setAppearance: (payload) => ipcRenderer.invoke('pet:appearance:set', payload),
  promptAppearanceRestart: () => ipcRenderer.invoke('pet:appearance:restart-prompt'),
  onClickThrough: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, enabled) => cb(enabled);
    ipcRenderer.on('pet:clickthrough', listener);
    return () => ipcRenderer.removeListener('pet:clickthrough', listener);
  },

  capture: (pngPath) => ipcRenderer.invoke('pet:capture', pngPath),

  // 主窗口收起到托盘通知：hidden=true 表示离开前台（最小化到任务栏不发）
  onWindowBackground: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, hidden) => cb(!!hidden);
    ipcRenderer.on('window:background', listener);
    return () => ipcRenderer.removeListener('window:background', listener);
  },

  // 主进程主动要求打开设置页（托盘菜单「设置」）
  onOpenSettings: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = () => cb();
    ipcRenderer.on('ui:open-settings', listener);
    return () => ipcRenderer.removeListener('ui:open-settings', listener);
  },

  // 托盘菜单「显示 / 隐藏工具栏」：全透明背景下临时唤回顶栏和底栏
  onToggleToolbar: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = () => cb();
    ipcRenderer.on('ui:toggle-toolbar', listener);
    return () => ipcRenderer.removeListener('ui:toggle-toolbar', listener);
  },

  // 独立面板窗口（添加动作）
  openPanel: (kind) => ipcRenderer.invoke('panel:open', kind),
  closePanel: () => ipcRenderer.invoke('panel:close'),
  minimizePanel: () => ipcRenderer.invoke('panel:minimize'),

  // 扩展：动作导入（内核跟随角色包，程序不提供内核导入/下载）
  importActions: () => ipcRenderer.invoke('ext:import-actions'),
  // 导入动作清单（.json）：没有 .glb 的内核（2D / Live2D）靠它提供动作名
  importActionList: () => ipcRenderer.invoke('ext:import-action-list'),
  openClips: () => ipcRenderer.invoke('ext:open-clips'),

  // 预设 ACTIONS：给模型看的动作说明，持久化在 si/app/preset-actions.md
  readPresetActions: () => ipcRenderer.invoke('preset:read-actions'),
  writePresetActions: (text) => ipcRenderer.invoke('preset:write-actions', text),
  // 人设 / 说话格式 / 时间说明 / 记忆块模板：全部由本地 md 提供，预设页可直接编辑
  readPresetPersona: () => ipcRenderer.invoke('preset:read-persona'),
  writePresetPersona: (text) => ipcRenderer.invoke('preset:write-persona', text),
  readPresetSpeak: () => ipcRenderer.invoke('preset:read-speak'),
  writePresetSpeak: (text) => ipcRenderer.invoke('preset:write-speak', text),
  readPresetTime: () => ipcRenderer.invoke('preset:read-time'),
  writePresetTime: (text) => ipcRenderer.invoke('preset:write-time', text),
  readPresetMemory: () => ipcRenderer.invoke('preset:read-memory'),
  writePresetMemory: (text) => ipcRenderer.invoke('preset:write-memory', text),
  readPresetCompress: () => ipcRenderer.invoke('preset:read-compress'),
  // 可插拔工具注册表：只含真 Tool Call（SPEAK / MEM_MARK 是底层协议，不在这里）
  readToolsConfig: () => ipcRenderer.invoke('preset:read-tools'),
  writeToolsConfig: (config) => ipcRenderer.invoke('preset:write-tools', config),

  // 语音输入：本地 whisper.cpp（si/voice/asr，缺失时按需下载 / 导入 zip）
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  voiceDownload: () => ipcRenderer.invoke('voice:download'),
  voiceImportZip: () => ipcRenderer.invoke('voice:import-zip'),
  voiceTranscribe: (wav, model) => ipcRenderer.invoke('voice:transcribe', { wav, model }),
  voiceOpenDir: () => ipcRenderer.invoke('voice:open-dir'),

  // 联网搜索（web_search 工具）：主进程请求 AnySearch，已做截断，只回标题/链接/摘要
  webSearch: (payload) => ipcRenderer.invoke('search:web', payload),

  // 图片：拖入时会拿到 File 对象，Electron 36 已移除 File.path，必须走 webUtils
  filePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (_) {
      return '';
    }
  },
  imageProbe: (filePath) => ipcRenderer.invoke('image:probe', filePath),
  imageRead: (filePath) => ipcRenderer.invoke('image:read', filePath),
  imageSaveTemp: (payload) => ipcRenderer.invoke('image:save-temp', payload),

  // 应用配置（应用名 / 版本 / 角色 / 数据根）：主进程装配，渲染层不再直接读配置文件
  appConfig: () => ipcRenderer.invoke('app:config'),
  // 角色：清单 / 导入角色包（zip）；导入后重新 appConfig 刷新卡片
  listCharacters: () => ipcRenderer.invoke('char:list'),
  importCharacter: () => ipcRenderer.invoke('char:import-zip'),
  switchCharacter: (id) => ipcRenderer.invoke('char:switch', id),
  // 角色详情：校验（入口 / 动作 / 内核清单）、打开目录、导出 zip、删除
  validateCharacter: (id) => ipcRenderer.invoke('char:validate', id),
  openCharacterDir: (id) => ipcRenderer.invoke('char:open-dir', id),
  exportCharacter: (id) => ipcRenderer.invoke('char:export', id),
  deleteCharacter: (id) => ipcRenderer.invoke('char:delete', id),
  // 数据根：查看当前目录 / 重新选择（只切指针，选定后主进程自动重启）
  dataRoot: () => ipcRenderer.invoke('app:data-root'),
  chooseDataRoot: () => ipcRenderer.invoke('app:choose-data-root'),

  // 归档等会持续变大的数据：localStorage 容量不够，走 userData/data/<key>.json
  readJsonData: (key) => ipcRenderer.invoke('data:read-json', key),
  writeJsonData: (key, value) => ipcRenderer.invoke('data:write-json', key, value),
  // 当前会话：按角色分文件（characters/<id>/session.json），替代 localStorage
  readChatSession: () => ipcRenderer.invoke('session:read'),
  writeChatSession: (messages) => ipcRenderer.invoke('session:write', messages),

  // 动作列表：主进程按 clips 文件夹里实际存在的 .glb 重建
  actionsIndex: () => ipcRenderer.invoke('actions:index'),

  // 插件系统：注册表、导入校验、配置读写、工具路由（进程隔离在 utilityProcess 里）
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  // 刷新时清掉损坏标记并置为关闭，等用户手动打开开关
  pluginResetBroken: () => ipcRenderer.invoke('plugin:reset-broken'),
  pluginImport: () => ipcRenderer.invoke('plugin:import'),
  pluginReimport: (id) => ipcRenderer.invoke('plugin:reimport', id),
  pluginChooseRoot: () => ipcRenderer.invoke('plugin:choose-root'),
  pluginSetEnabled: (id, enabled) => ipcRenderer.invoke('plugin:set-enabled', id, enabled),
  pluginSetPermission: (id, permission) => ipcRenderer.invoke('plugin:set-permission', id, permission),
  pluginSetPool: (id, pool) => ipcRenderer.invoke('plugin:set-pool', id, pool),
  pluginUninstall: (id) => ipcRenderer.invoke('plugin:uninstall', id),
  pluginClearTrash: () => ipcRenderer.invoke('plugin:clear-trash'),
  pluginOpenDir: (id) => ipcRenderer.invoke('plugin:open-dir', id),
  pluginReadConfig: (id) => ipcRenderer.invoke('plugin:read-config', id),
  pluginWriteConfig: (id, config) => ipcRenderer.invoke('plugin:write-config', id, config),
  pluginIcon: (id) => ipcRenderer.invoke('plugin:icon', id),
  pluginCallTool: (name, args) => ipcRenderer.invoke('plugin:call-tool', name, args),
  pluginSpeechStatus: () => ipcRenderer.invoke('plugin:speech-status'),
  pluginSpeechSynth: (payload) => ipcRenderer.invoke('plugin:speech-synth', payload),
  pluginRuntimeStatus: (id) => ipcRenderer.invoke('plugin:runtime-status', id),
  pluginRuntimeImport: (id) => ipcRenderer.invoke('plugin:runtime-import', id),
  pluginRuntimeDownload: (id) => ipcRenderer.invoke('plugin:runtime-download', id),
  // 进程管理器：列出插件进程、读取日志、手动停止/启动
  pluginProcList: () => ipcRenderer.invoke('plugin:proc-list'),
  pluginProcLogs: (id) => ipcRenderer.invoke('plugin:proc-logs', id),
  pluginProcStop: (id) => ipcRenderer.invoke('plugin:proc-stop', id),
  pluginProcStart: (id) => ipcRenderer.invoke('plugin:proc-start', id),
  // 面板展开时才让 Worker 上报内存，收起/离开页面即停止轮询
  pluginProcWatch: (on) => ipcRenderer.invoke('plugin:proc-watch', on),
  // 壳层 → 插件状态推送（单向高频，用 send 不走 invoke 往返）
  pluginPushState: (payload) => ipcRenderer.send('plugin:push-state', payload),
  // 插件主动推给壳层的事件：任务到点、配置被插件改写、进程崩溃/超时
  onPluginEvent: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('plugin:event', listener);
    return () => ipcRenderer.removeListener('plugin:event', listener);
  },

  // 共用任务中心：设置页底部的进度条订阅这里
  taskList: () => ipcRenderer.invoke('task:list'),
  taskCancel: (id) => ipcRenderer.invoke('task:cancel', id),
  onTaskUpdate: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('task:update', listener);
    return () => ipcRenderer.removeListener('task:update', listener);
  },

  // 长程记忆：SQLite + 本地 embedding（Worker 在主进程里；模型首次使用才下载）
  memoryStatus: () => ipcRenderer.invoke('memory:status'),
  memoryEnsureModel: (opts) => ipcRenderer.invoke('memory:ensure-model', opts),
  memoryCall: (cmd, args) => ipcRenderer.invoke('memory:call', { cmd, args }),

  // 流式 LLM（请求由主进程发出，避免渲染层 CORS 限制）
  llmStart: (payload) => ipcRenderer.send('llm:start', payload),
  llmCancel: (id) => ipcRenderer.send('llm:cancel', id),
  onLLMEvent: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, evt) => cb(evt);
    ipcRenderer.on('llm:event', listener);
    return () => ipcRenderer.removeListener('llm:event', listener);
  },
});
