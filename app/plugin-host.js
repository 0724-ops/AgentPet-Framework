// ============================================================================
//  主进程侧插件宿主（Phase 2：注册表 + 导入校验 + 配置读写 + utilityProcess 调度）
//
//  设计约定（见 插件计划书.md）：
//    * registry.json 是唯一真相源，放在插件目录内；插件目录本身可换。
//    * config.json 只由主进程写，原子写（先 tmp 再 rename）。
//    * 有 UI 声明但缺 config.json → broken，绝不自动生成。
//    * 一个插件一个 utilityProcess：同一插件串行（队列上限 3）、全局并行 4、
//      默认 20s 超时（不杀进程）、迟到结果按 call_id 丢弃、崩溃 → broken + 禁用。
//    * 插件只能发 config_patch，由主进程合并写盘后回推，避免两边各写一份。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { dialog, shell, utilityProcess } = require('electron');

const SCHEMA_VERSION = 1;
const MAX_QUEUE_PER_PLUGIN = 3;
const MAX_PARALLEL = 4;
const WORKER_READY_MS = 8000;
const MAX_TIMEOUT_STREAK = 3;
const TOOL_STATUSES = new Set(['success', 'error', 'blocked', 'rate_limited']);
const POINTER_FILE = 'plugin-root.json';
const REGISTRY_FILE = 'registry.json';
const TRASH_DIR = '.trash';
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;
// 运行时（模型 / Python 等）体积远大于插件包，单独放宽；仍然走同一套安全校验
const MAX_RUNTIME_ZIP_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_RUNTIME_ENTRIES = 20000;
const MAX_RUNTIME_UNCOMPRESSED = 16 * 1024 * 1024 * 1024;
const SPEECH_TIMEOUT_MS = 120000;
const MAX_SPEECH_CHARS = 5000;
const CAPABILITIES = new Set(['speech', 'state']);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 256 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- zip 解析
// 只读中央目录：拿到每个条目的名字、压缩后/解压后大小、外部属性（判符号链接）。
// 解压仍交给系统 tar，但所有路径与大小在这里先过一遍，避免 Zip Slip / zip bomb。
function readZipEntries(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('暂不支持 zip64 格式，请用普通 zip 重新打包');
  if (cdOffset >= buf.length) throw new Error('zip 文件已损坏（中央目录越界）');
  let p = cdOffset;
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 文件已损坏（中央目录异常）');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, flags, method, compSize, uncompSize, extAttr });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function safeEntryName(raw) {
  const name = String(raw || '').replace(/\\/g, '/');
  if (!name || name.endsWith('/')) return { ok: true, dir: true };
  if (name.startsWith('/')) return { ok: false, reason: '包含绝对路径' };
  if (/^[A-Za-z]:/.test(name)) return { ok: false, reason: '包含盘符路径' };
  const parts = name.split('/');
  if (parts.some((s) => s === '..')) return { ok: false, reason: '包含 .. 路径' };
  return { ok: true };
}

function validateZipBuffer(buf, limits = null) {
  const maxEntries = (limits && limits.entries) || MAX_ENTRIES;
  const maxUncompressed = (limits && limits.uncompressed) || MAX_UNCOMPRESSED;
  const entries = readZipEntries(buf);
  if (entries.length > maxEntries) throw new Error(`压缩包条目过多（${entries.length} > ${maxEntries}）`);
  let total = 0;
  for (const e of entries) {
    const safe = safeEntryName(e.name);
    if (!safe.ok) throw new Error(`压缩包内含不安全路径（${e.name}）：${safe.reason}`);
    if ((e.flags & 0x1) !== 0) throw new Error('暂不支持加密 zip');
    if (e.uncompSize === 0xffffffff || e.compSize === 0xffffffff) throw new Error('暂不支持 zip64 格式');
    const unixMode = (e.extAttr >>> 16) & 0xf000;
    if (unixMode === 0xa000) throw new Error(`压缩包内不允许符号链接（${e.name}）`);
    total += e.uncompSize;
    if (total > maxUncompressed) {
      throw new Error(`解压后总大小超过 ${Math.round(maxUncompressed / 1024 / 1024)}MB，疑似压缩炸弹`);
    }
  }
  return { entries, total };
}

// 系统自带 tar（bsdtar 支持 zip）；失败时退回 PowerShell
function extractZipTo(zipFile, destDir) {
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

function findPluginJson(dir) {
  if (exists(path.join(dir, 'plugin.json'))) return path.join(dir, 'plugin.json');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const nested = path.join(dir, ent.name, 'plugin.json');
      if (exists(nested)) return nested;
    }
  }
  return null;
}

// 递归复制（覆盖式），skipTop 里的顶层文件名不复制（用于保留 config.json）
function copyTree(src, dest, skipTop = new Set()) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.gitkeep') continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(from, to);
    else if (ent.isFile()) {
      if (skipTop.has(ent.name)) continue;
      fs.copyFileSync(from, to);
    }
  }
}

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    /* 删不掉时留给用户手动处理 */
  }
}

// ---------------------------------------------------------------- plugin.json
function validateToolDef(tool, pluginId) {
  if (!tool || typeof tool !== 'object') return null;
  const name = typeof tool.name === 'string' ? tool.name.trim() : '';
  if (!TOOL_RE.test(name)) return null;
  const def = {
    name,
    label: typeof tool.label === 'string' && tool.label.trim() ? tool.label.trim() : name,
    icon: typeof tool.icon === 'string' ? tool.icon.trim().toLowerCase() : '',
    prompt: typeof tool.prompt === 'string' ? tool.prompt : '',
    schema:
      tool.schema && typeof tool.schema === 'object' && !Array.isArray(tool.schema)
        ? tool.schema
        : { type: 'object', properties: {} },
    aliases: Array.isArray(tool.aliases)
      ? tool.aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim())
      : [],
    pluginId,
  };
  return def;
}

// 运行时声明：插件需要的本地大件（模型 / 可执行程序），由详情页统一安装到插件目录下
function validateRuntime(raw) {
  if (raw == null) return { ok: true, runtime: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'plugin.json 的 runtime 必须是一个对象' };
  const dir = typeof raw.dir === 'string' ? raw.dir.trim().replace(/\\/g, '/') : '';
  if (!dir) return { ok: false, error: 'runtime.dir 不能为空' };
  if (dir.startsWith('/') || /^[A-Za-z]:/.test(dir) || dir.split('/').includes('..')) {
    return { ok: false, error: 'runtime.dir 必须是插件目录下的相对路径（不能是绝对路径或包含 ..）' };
  }
  const required = [];
  if (Array.isArray(raw.required)) {
    for (const item of raw.required) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const rel = item.trim().replace(/\\/g, '/');
      if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
        return { ok: false, error: `runtime.required 里有非法路径：${rel}` };
      }
      required.push(rel);
    }
  }
  let download = null;
  if (raw.download && typeof raw.download === 'object') {
    const url = typeof raw.download.url === 'string' ? raw.download.url.trim() : '';
    if (url) {
      download = {
        url,
        sha256: typeof raw.download.sha256 === 'string' ? raw.download.sha256.trim().toLowerCase() : '',
      };
    }
  }
  return { ok: true, runtime: { dir, required, download } };
}

function readPluginManifest(dir) {
  const file = findPluginJson(dir);
  if (!file) return { ok: false, error: '插件包里没有 plugin.json' };
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'plugin.json 解析失败' };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_RE.test(id)) return { ok: false, error: 'plugin.json 的 id 非法（只允许字母、数字、_、-，长度 1-64）' };
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const tools = [];
  if (Array.isArray(raw.tools)) {
    for (const t of raw.tools) {
      const def = validateToolDef(t, id);
      if (!def) return { ok: false, error: `plugin.json 里有非法工具定义（name 需为字母/数字/_/-，长度 1-64）` };
      tools.push(def);
    }
  }
  const capabilities = Array.isArray(raw.capabilities)
    ? [...new Set(raw.capabilities.filter((x) => typeof x === 'string' && CAPABILITIES.has(x.trim().toLowerCase())).map((x) => x.trim().toLowerCase()))]
    : [];
  const rt = validateRuntime(raw.runtime);
  if (!rt.ok) return { ok: false, error: rt.error };
  return {
    ok: true,
    root: path.dirname(file),
    manifest: {
      id,
      name,
      version: typeof raw.version === 'string' ? raw.version.trim() : '',
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      icon: typeof raw.icon === 'string' ? raw.icon.trim() : '',
      // 进程形态：shared 进共享池，dedicated 独立进程（默认）
      pool: raw.pool === 'shared' ? 'shared' : 'dedicated',
      permissions: Array.isArray(raw.permissions) ? raw.permissions.filter((x) => typeof x === 'string') : [],
      // 非工具能力（目前只有 speech）：语音合成插件走独立通道，不进工具列表
      capabilities,
      runtime: rt.runtime,
      timeoutMs: Number(raw.timeoutMs) > 0 ? Math.min(300000, Math.round(Number(raw.timeoutMs))) : 20000,
      tools,
    },
  };
}

// 收集 schema 里的字段 key（用来在重新导入时提示「新增字段」）
function collectFieldKeys(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.sections)) {
    return schema.sections.flatMap((s) => collectFieldKeys(s));
  }
  if (Array.isArray(schema.fields)) {
    return schema.fields
      .filter((f) => f && typeof f === 'object' && f.type !== 'card' && f.key)
      .map((f) => String(f.key));
  }
  return [];
}

// ---------------------------------------------------------------- 插件宿主工厂
function createPluginHost({
  userDataDir,
  dataRoot = '',
  toolsConfigFile,
  appDir,
  siRoot = path.dirname(appDir),
  log = () => {},
  notify = () => {},
  fetchToFile = null,
  taskStart = null,
  taskUpdate = null,
  taskFinish = null,
}) {
  const pointerFile = path.join(userDataDir, POINTER_FILE);
  // 默认放在数据根下（用户可再自定义）；没有数据根时才退回 userData
  const defaultRoot = dataRoot ? path.join(dataRoot, 'plugins') : path.join(userDataDir, 'plugins');

  let registry = null;
  let registryRoot = '';

  // ---- 目录指针：registry 在插件目录内，这里只记「当前用哪个目录」
  function currentRoot() {
    const ptr = readJson(pointerFile);
    const dir = ptr && typeof ptr.pluginsRoot === 'string' ? ptr.pluginsRoot : '';
    return dir && exists(dir) ? dir : defaultRoot;
  }

  function setRoot(dir) {
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(pointerFile, JSON.stringify({ pluginsRoot: dir, updatedAt: Date.now() }, null, 2));
    registry = null;
    registryRoot = '';
    loadRegistry();
  }

  function registryPath() {
    return path.join(registryRoot, REGISTRY_FILE);
  }

  function trashPath() {
    return path.join(registryRoot, TRASH_DIR);
  }

  function blankRegistry(root) {
    return { schemaVersion: SCHEMA_VERSION, pluginsRoot: root, plugins: [] };
  }

  function normalizeRegistry(raw, root) {
    const base = raw && typeof raw === 'object' ? raw : {};
    const list = Array.isArray(base.plugins) ? base.plugins : [];
    const plugins = [];
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      plugins.push({
        id,
        enabled: item.enabled === true,
        permission: item.permission === 'full' ? 'full' : 'restricted',
        pool: item.pool === 'shared' ? 'shared' : 'dedicated',
        grantedAt: Number(item.grantedAt) || null,
        installedAt: Number(item.installedAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Date.now(),
        configRev: Number(item.configRev) || 0,
        // 进程崩溃 / 连续超时后写入，inspect 时优先判 broken；重新启用即清除
        crashReason: typeof item.crashReason === 'string' ? item.crashReason : '',
        tools: Array.isArray(item.tools)
          ? item.tools.filter((t) => t && typeof t.name === 'string').map((t) => ({ name: t.name, enabled: t.enabled === true }))
          : [],
      });
    }
    return { schemaVersion: SCHEMA_VERSION, pluginsRoot: root, plugins };
  }

  function loadRegistry() {
    const root = currentRoot();
    registryRoot = root;
    fs.mkdirSync(root, { recursive: true });
    const file = registryPath();
    if (exists(file)) {
      const raw = readJson(file);
      if (raw) {
        registry = normalizeRegistry(raw, root);
      } else {
        // 坏 registry：备份后重建（只丢启停状态，插件目录还在，可重新导入）
        try {
          fs.renameSync(file, `${file}.bak-${Date.now()}`);
        } catch (_) {
          /* ignore */
        }
        registry = blankRegistry(root);
      }
    } else {
      registry = blankRegistry(root);
    }
    saveRegistry();
    return registry;
  }

  function saveRegistry() {
    if (!registry) return;
    registry.pluginsRoot = registryRoot;
    atomicWrite(registryPath(), JSON.stringify(registry, null, 2) + '\n');
  }

  function ensure() {
    if (!registry) loadRegistry();
    return registry;
  }

  function pluginDir(id) {
    return path.join(registryRoot, id);
  }

  function entryOf(id) {
    return ensure().plugins.find((p) => p.id === id) || null;
  }

  // 实际运行的进程形态：完全权限一律独立，其余按用户选择（默认独立）
  function effectivePool(entry) {
    if (!entry) return 'dedicated';
    if (entry.permission === 'full') return 'dedicated';
    return entry.pool === 'shared' ? 'shared' : 'dedicated';
  }

  function nativeToolNames() {
    const raw = readJson(toolsConfigFile);
    const set = new Set();
    const tools = raw && Array.isArray(raw.tools) ? raw.tools : [];
    for (const t of tools) {
      if (!t || typeof t !== 'object') continue;
      if (typeof t.name === 'string' && t.name) set.add(t.name.toLowerCase());
      if (Array.isArray(t.aliases)) {
        for (const a of t.aliases) if (typeof a === 'string' && a) set.add(a.toLowerCase());
      }
    }
    return set;
  }

  // 读取插件包内的 schema 文件（可选）
  function readSchemaFile(dir, name) {
    const file = path.join(dir, name);
    if (!exists(file)) return null;
    const raw = readJson(file);
    return raw && typeof raw === 'object' ? raw : { __invalid: true };
  }

  // 运行时状态：插件声明了 runtime 才有；缺文件时详情页负责引导安装
  // 运行时放在插件自己的目录里（pluginDir/<runtime.dir>），插件包重导入时会被保留
  function runtimeInfo(manifest, dir) {
    const rt = manifest && manifest.runtime;
    if (!rt) return null;
    const base = path.join(dir || pluginDir(manifest.id), rt.dir);
    const missing = rt.required.filter((rel) => !exists(path.join(base, rel)));
    const state = !rt.required.length || !missing.length ? 'ready' : missing.length === rt.required.length ? 'absent' : 'partial';
    return { dir: rt.dir, base, required: rt.required.slice(), missing, state, download: rt.download || null };
  }

  // 语音能力：启用 + 未损坏 + 声明 speech + 运行时齐全
  function speechPlugin() {
    ensure();
    for (const entry of registry.plugins) {
      if (!entry.enabled) continue;
      const info = inspect(entry.id);
      if (info.state !== 'ok' || !info.manifest) continue;
      if (!(info.manifest.capabilities || []).includes('speech')) continue;
      const rt = runtimeInfo(info.manifest);
      if (rt && rt.state !== 'ready') continue;
      return { entry, info, runtime: rt };
    }
    return null;
  }

  // 检查插件目录：返回 { state, reason, manifest, uiDeclared, configOk }
  function inspect(id, { repair = false } = {}) {
    const dir = pluginDir(id);
    const entry = entryOf(id);
    if (!exists(dir)) return { state: 'broken', reason: '插件目录不存在' };
    if (entry && entry.crashReason) return { state: 'broken', reason: entry.crashReason };
    const man = readPluginManifest(dir);
    if (!man.ok) return { state: 'broken', reason: man.error };
    if (man.manifest.id !== id) return { state: 'broken', reason: `plugin.json 的 id（${man.manifest.id}）与目录名不一致` };
    const staticSchema = readSchemaFile(dir, 'static_schema.json');
    const dynamicSchema = readSchemaFile(dir, 'dynamic_schema.json');
    const uiDeclared = !!staticSchema || !!dynamicSchema;
    if (staticSchema && staticSchema.__invalid) return { state: 'broken', reason: 'static_schema.json 解析失败' };
    if (dynamicSchema && dynamicSchema.__invalid) return { state: 'broken', reason: 'dynamic_schema.json 解析失败' };

    const configFile = path.join(dir, 'config.json');
    let configExisted = exists(configFile);
    if (uiDeclared && !configExisted) {
      return {
        state: 'broken',
        reason: '插件包缺少配置文件（config.json）',
        manifest: man.manifest,
        uiDeclared,
        staticSchema,
        dynamicSchema,
      };
    }
    if (configExisted && !readJson(configFile)) {
      if (repair) {
        try {
          fs.renameSync(configFile, `${configFile}.bak-${Date.now()}`);
        } catch (_) {
          /* ignore */
        }
      }
      return {
        state: 'broken',
        reason: '配置文件损坏（已备份为 config.json.bak）',
        manifest: man.manifest,
        uiDeclared,
        staticSchema,
        dynamicSchema,
      };
    }
    return {
      state: 'ok',
      reason: '',
      manifest: man.manifest,
      uiDeclared,
      staticSchema,
      dynamicSchema,
    };
  }

  // 全量列表；顺便把目录状态同步回 registry
  function list() {
    ensure();
    const plugins = registry.plugins.map((entry) => {
      const info = inspect(entry.id);
      const manifest = info.manifest || { id: entry.id, name: entry.id, version: '', description: '', icon: '', tools: [] };
      const tools = (manifest.tools || []).map((t) => {
        const known = entry.tools.find((x) => x.name === t.name);
        return {
          name: t.name,
          label: t.label,
          icon: t.icon,
          prompt: t.prompt,
          schema: t.schema,
          aliases: t.aliases,
          enabled: !!(known && known.enabled),
        };
      });
      return {
        id: entry.id,
        name: manifest.name || entry.id,
        version: manifest.version || '',
        description: manifest.description || '',
        icon: manifest.icon || '',
        capabilities: manifest.capabilities || [],
        runtime: runtimeInfo(manifest),
        enabled: entry.enabled,
        permission: entry.permission,
        // pool 是实际生效的形态；declaredPool 是注册表里的选择，供 UI 展示开关
        pool: effectivePool(entry),
        declaredPool: entry.pool,
        grantedAt: entry.grantedAt,
        state: info.state,
        reason: info.reason || '',
        uiDeclared: !!info.uiDeclared,
        permissions: manifest.permissions || [],
        timeoutMs: manifest.timeoutMs || 20000,
        staticSchema: info.staticSchema || null,
        dynamicSchema: info.dynamicSchema || null,
        tools,
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt,
      };
    });
    return { root: registryRoot, plugins };
  }

  // 给 tools.config.json 合并用：所有插件的工具（带来源标记）
  function toolDefinitions() {
    ensure();
    const out = [];
    for (const entry of registry.plugins) {
      const info = inspect(entry.id);
      if (!info.manifest) continue;
      const broken = info.state === 'broken';
      for (const t of info.manifest.tools) {
        const known = entry.tools.find((x) => x.name === t.name);
        out.push({
          name: t.name,
          label: t.label,
          icon: t.icon,
          enabled: !!(known && known.enabled) && !broken && entry.enabled,
          prompt: t.prompt,
          schema: t.schema,
          aliases: t.aliases,
          source: 'plugin',
          pluginId: entry.id,
          pluginName: info.manifest.name || entry.id,
        });
      }
    }
    return out;
  }

  function setToolEnabled(name, enabled) {
    ensure();
    for (const entry of registry.plugins) {
      const known = entry.tools.find((x) => x.name === name);
      if (known) {
        known.enabled = !!enabled;
        saveRegistry();
        return true;
      }
    }
    return false;
  }

  // ---- 导入
  async function pickZip(getWindow) {
    const picked = await dialog.showOpenDialog(getWindow ? getWindow() : null, {
      title: '导入插件',
      properties: ['openFile'],
      filters: [{ name: '插件包', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return picked.filePaths[0];
  }

  function checkToolConflicts(manifest, selfId) {
    const names = nativeToolNames();
    const conflicts = [];
    for (const other of registry.plugins) {
      if (other.id === selfId) continue;
      const info = inspect(other.id);
      if (!info.manifest) continue;
      for (const t of info.manifest.tools) {
        names.add(t.name.toLowerCase());
        for (const a of t.aliases) names.add(a.toLowerCase());
      }
    }
    for (const t of manifest.tools) {
      const key = t.name.toLowerCase();
      if (names.has(key)) conflicts.push(t.name);
      names.add(key);
      for (const a of t.aliases) {
        if (names.has(a.toLowerCase())) conflicts.push(a);
        names.add(a.toLowerCase());
      }
    }
    return conflicts;
  }

  async function importPlugin({ getWindow, reimportId = null } = {}) {
    ensure();
    const zip = await pickZip(getWindow);
    if (!zip) return { ok: false, canceled: true };
    let stat = null;
    try {
      stat = fs.statSync(zip);
    } catch (err) {
      return { ok: false, error: `读取压缩包失败：${err.message}` };
    }
    if (stat.size > MAX_ZIP_BYTES) return { ok: false, error: `压缩包过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > 20MB）` };
    let buf = null;
    try {
      buf = fs.readFileSync(zip);
      validateZipBuffer(buf);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }

    const tmp = path.join(os.tmpdir(), `si-plugin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const un = await extractZipTo(zip, tmp);
      if (!un.ok) return { ok: false, error: un.error };
      const root = unwrapSingleRoot(tmp);
      const man = readPluginManifest(root);
      if (!man.ok) return { ok: false, error: man.error };
      const manifest = man.manifest;
      const id = manifest.id;
      if (reimportId && id !== reimportId) {
        return { ok: false, error: `压缩包里的插件 ID 是 ${id}，与要重新导入的 ${reimportId} 不一致` };
      }
      if (!reimportId && entryOf(id)) {
        return { ok: false, error: `插件 ${id} 已安装；如需更新代码请用「重新导入」（会保留 config.json）` };
      }

      const conflicts = checkToolConflicts(manifest, reimportId || id);
      if (conflicts.length) {
        return { ok: false, error: `工具名与已有工具冲突：${conflicts.join('、')}（插件工具名必须全局唯一）` };
      }

      const targetDir = pluginDir(id);
      const targetHadConfig = exists(path.join(targetDir, 'config.json'));
      const pkgHasConfig = exists(path.join(root, 'config.json'));
      const pkgHasUi =
        exists(path.join(root, 'static_schema.json')) || exists(path.join(root, 'dynamic_schema.json'));
      if (pkgHasUi && !pkgHasConfig && !targetHadConfig) {
        // 仍然安装，但会落成 broken —— 计划书要求「绝不替插件生成配置」
        log(`[plugin] ${id} 缺少 config.json，将以 broken 状态安装`);
      }

      // 重新导入：先记录旧 schema 字段，用于提示新增字段（不补默认值）
      const warnings = [];
      if (targetHadConfig) {
        const oldStatic = readSchemaFile(targetDir, 'static_schema.json');
        const oldDynamic = readSchemaFile(targetDir, 'dynamic_schema.json');
        const newStatic = readSchemaFile(root, 'static_schema.json');
        const newDynamic = readSchemaFile(root, 'dynamic_schema.json');
        const oldKeys = new Set([...collectFieldKeys(oldStatic), ...collectFieldKeys(oldDynamic)]);
        const config = readJson(path.join(targetDir, 'config.json')) || {};
        const newKeys = [...collectFieldKeys(newStatic), ...collectFieldKeys(newDynamic)].filter(
          (k) => !oldKeys.has(k) && !(k in config),
        );
        if (newKeys.length) warnings.push(`schema 新增字段：${newKeys.join('、')}（需插件自身兼容，不会自动补默认值）`);
      }

      // 覆盖代码；目标已有 config.json 时跳过包里的 config.json
      const skip = targetHadConfig ? new Set(['config.json']) : new Set();
      copyTree(root, targetDir, skip);

      // 合并 registry 记录：保留启停 / 权限 / 已启用的工具
      const old = entryOf(id);
      const tools = manifest.tools.map((t) => {
        const prev = old ? old.tools.find((x) => x.name === t.name) : null;
        return { name: t.name, enabled: !!(prev && prev.enabled) };
      });
      const record = {
        id,
        enabled: old ? old.enabled : false,
        permission: old ? old.permission : 'restricted',
        // 重新导入保留用户已选的进程形态；首次导入读 plugin.json 声明
        pool: old ? old.pool : man.manifest.pool === 'shared' ? 'shared' : 'dedicated',
        grantedAt: old ? old.grantedAt : null,
        installedAt: old ? old.installedAt : Date.now(),
        updatedAt: Date.now(),
        configRev: old ? old.configRev : 0,
        tools,
      };
      if (old) {
        const idx = registry.plugins.indexOf(old);
        registry.plugins[idx] = record;
      } else {
        registry.plugins.push(record);
      }
      saveRegistry();

      const info = inspect(id, { repair: true });
      // 代码被覆盖了：老进程里跑的还是旧代码，必须重启
      stopWorker(id, { quiet: true });
      if (record.enabled && info.state === 'ok') void ensureWorker(id);
      log(`[plugin] 导入 ${id} → ${targetDir}（${info.state}）`);
      return { ok: true, id, state: info.state, reason: info.reason || '', warnings };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
      removeTree(tmp);
    }
  }

  // ---- 管理
  async function setEnabled(id, enabled) {
    const entry = entryOf(id);
    if (!entry) return { ok: false, error: '插件不存在' };
    if (enabled) {
      // 用户手动重新启用 = 认可修复，先清掉上一轮崩溃标记再判状态
      entry.crashReason = '';
      const info = inspect(id);
      if (info.state === 'broken') return { ok: false, error: `插件损坏，无法启用：${info.reason}` };
    }
    entry.enabled = !!enabled;
    entry.updatedAt = Date.now();
    saveRegistry();
    if (enabled) {
      await ensureWorker(id);
      if (!entry.enabled) return { ok: false, error: entry.crashReason || '插件进程启动失败' };
    } else {
      stopWorker(id);
    }
    return { ok: true };
  }

  // 刷新插件列表：清掉上一轮崩溃 / 超时留下的损坏标记，让插件重新被检查一次。
  // 清掉标记的一律改成「关闭」状态，由用户手动打开开关再启动，不在后台偷偷拉起。
  async function resetBroken() {
    const reset = [];
    for (const entry of registry.plugins) {
      const info = inspect(entry.id);
      if (!entry.crashReason && info.state !== 'broken') continue;
      entry.crashReason = '';
      entry.enabled = false;
      entry.updatedAt = Date.now();
      reset.push({ id: entry.id, reason: info.reason || '' });
      stopWorker(entry.id);
    }
    if (reset.length) saveRegistry();
    return { ok: true, reset };
  }

  function setPermission(id, permission) {
    const entry = entryOf(id);
    if (!entry) return { ok: false, error: '插件不存在' };
    const next = permission === 'full' ? 'full' : 'restricted';
    const changed = entry.permission !== next;
    const beforePool = effectivePool(entry);
    entry.permission = next;
    entry.grantedAt = next === 'full' ? Date.now() : null;
    entry.updatedAt = Date.now();
    saveRegistry();
    // 权限与进程形态都是拉起进程时注入的，变化后必须重启才能生效
    if (entry.enabled && (changed || beforePool !== effectivePool(entry))) {
      stopWorker(id, { quiet: true });
      void ensureWorker(id);
    }
    return { ok: true, permission: next, pool: effectivePool(entry) };
  }

  // 手动切换进程形态（plugin.json 只决定首次导入的默认值）
  function setPool(id, pool) {
    const entry = entryOf(id);
    if (!entry) return { ok: false, error: '插件不存在' };
    const next = pool === 'shared' ? 'shared' : 'dedicated';
    if (next === 'shared' && entry.permission === 'full') {
      return { ok: false, error: '完全权限插件只能独立运行，如需共享池请先切回受限权限' };
    }
    const before = effectivePool(entry);
    entry.pool = next;
    entry.updatedAt = Date.now();
    saveRegistry();
    const after = effectivePool(entry);
    if (entry.enabled && before !== after) {
      stopWorker(id, { quiet: true });
      void ensureWorker(id);
    }
    return { ok: true, pool: after, declaredPool: entry.pool };
  }

  function uninstall(id) {
    const entry = entryOf(id);
    if (!entry) return { ok: false, error: '插件不存在' };
    // 先从注册表摘掉，共享池重启时就不会再拉起它
    const idx = registry.plugins.indexOf(entry);
    registry.plugins.splice(idx, 1);
    stopWorker(id, { quiet: true });
    const dir = pluginDir(id);
    if (exists(dir)) {
      fs.mkdirSync(trashPath(), { recursive: true });
      const target = path.join(trashPath(), `${id}-${Date.now()}`);
      try {
        fs.renameSync(dir, target);
      } catch (err) {
        registry.plugins.splice(idx, 0, entry);
        saveRegistry();
        return { ok: false, error: `移入回收目录失败：${err.message}` };
      }
    }
    saveRegistry();
    return { ok: true };
  }

  function clearTrash() {
    const trashed = trashPath();
    if (!exists(trashed)) return { ok: true, removed: 0 };
    let removed = 0;
    for (const ent of fs.readdirSync(trashed, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        removeTree(path.join(trashed, ent.name));
        removed += 1;
      }
    }
    return { ok: true, removed };
  }

  function openDir(id) {
    const target = id ? pluginDir(id) : registryRoot;
    fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
    return { ok: true, path: target };
  }

  async function chooseRoot(getWindow) {
    const picked = await dialog.showOpenDialog(getWindow ? getWindow() : null, {
      title: '选择插件目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const dir = picked.filePaths[0];
    // 换库 = 换一整套插件：先把旧目录的进程全停掉
    stopAll();
    setRoot(dir);
    void startAll();
    return { ok: true, root: dir, plugins: list().plugins };
  }

  // ---- 配置
  function readConfig(id) {
    const entry = entryOf(id);
    if (!entry) return { ok: false, error: '插件不存在' };
    const file = path.join(pluginDir(id), 'config.json');
    if (!exists(file)) return { ok: true, config: {}, rev: entry.configRev };
    const raw = readJson(file);
    if (!raw) return { ok: false, error: 'config.json 解析失败' };
    const size = fs.statSync(file).size;
    if (size > MAX_CONFIG_BYTES) return { ok: false, error: 'config.json 过大（超过 1MB）' };
    return { ok: true, config: raw, rev: entry.configRev };
  }

  function writeConfig(id, config, { fromWorker = false } = {}) {
    const entry = entryOf(id);
    if (!entry) return { ok: false, error: '插件不存在' };
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, error: '配置必须是一个对象' };
    let text = '';
    try {
      text = JSON.stringify(config, null, 2) + '\n';
    } catch (err) {
      return { ok: false, error: `配置无法序列化：${err.message}` };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) return { ok: false, error: '配置超过 1MB，拒绝写入' };
    const file = path.join(pluginDir(id), 'config.json');
    try {
      atomicWrite(file, text);
    } catch (err) {
      return { ok: false, error: `写入失败：${err.message}` };
    }
    entry.configRev += 1;
    entry.updatedAt = Date.now();
    // 有配置后 broken 状态重新判定：缺配置导致的损坏在此解除
    saveRegistry();
    if (fromWorker) {
      // 插件自己改的配置：告诉渲染层静默刷新，避免界面和磁盘不同步
      notify('plugin:event', { type: 'config-changed', pluginId: id, rev: entry.configRev });
    } else {
      // 用户在 UI 里保存的配置：推给运行中的 Worker，让定时器等逻辑立即重新调度
      syncConfigToWorker(id, config, entry.configRev);
    }
    return { ok: true, rev: entry.configRev };
  }

  // 图标：读成 dataURL（插件目录不在 app:// 作用域内）
  function readIcon(id) {
    const entry = entryOf(id);
    if (!entry) return { ok: false, error: '插件不存在' };
    const info = inspect(id);
    const rel = info.manifest && info.manifest.icon;
    if (!rel) return { ok: true, dataUrl: '' };
    const safe = safeEntryName(rel);
    if (!safe.ok) return { ok: true, dataUrl: '' };
    const file = path.join(pluginDir(id), rel);
    if (!exists(file)) return { ok: true, dataUrl: '' };
    try {
      if (fs.statSync(file).size > MAX_ICON_BYTES) return { ok: true, dataUrl: '' };
      const ext = path.extname(file).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.svg' ? 'image/svg+xml' : ext === '.webp' ? 'image/webp' : '';
      if (!mime) return { ok: true, dataUrl: '' };
      const b64 = fs.readFileSync(file).toString('base64');
      return { ok: true, dataUrl: `data:${mime};base64,${b64}` };
    } catch (_) {
      return { ok: true, dataUrl: '' };
    }
  }

  // ---------------------------------------------------------------- Worker 进程
  // 两种形态：独立（一插件一进程）与共享池（多个受限插件共用一个进程）。
  // procs 按进程存调度状态；workers 是「插件租户」视图（队列 / 就绪态）。
  const procs = new Map(); // key: 'shared' | `plugin:<id>` -> procRec
  const workers = new Map(); // pluginId -> tenant
  const procLogs = new Map(); // pluginId -> 环形日志（最多 200 行，供进程管理器展开）
  let globalRunning = 0;
  let shuttingDown = false;
  // 进程管理器面板展开时才会让 Worker 轮询 PID / 内存，收起或离开插件页就停掉
  let statsWatching = false;

  function pushProcLog(id, level, line) {
    if (!id) return;
    const entry = { at: Date.now(), level, line: String(line == null ? '' : line) };
    let buf = procLogs.get(id);
    if (!buf) {
      buf = [];
      procLogs.set(id, buf);
    }
    buf.push(entry);
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    notify('plugin:event', { type: 'proc-log', pluginId: id, entry });
  }

  function notifyProcChanged(id) {
    notify('plugin:event', { type: 'proc-changed', pluginId: id });
  }

  function setStatsWatching(on) {
    const next = !!on;
    if (next === statsWatching) return;
    statsWatching = next;
    for (const p of procs.values()) postToProc(p, { type: next ? 'stats-start' : 'stats-stop' });
  }

  function mergeConfig(base, patch, depth = 0) {
    const out = { ...(base && typeof base === 'object' ? base : {}) };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || depth > 4) return out;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) {
        delete out[key];
        continue;
      }
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        out[key] &&
        typeof out[key] === 'object' &&
        !Array.isArray(out[key])
      ) {
        out[key] = mergeConfig(out[key], value, depth + 1);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  function postToProc(p, message) {
    if (!p || !p.proc) return false;
    try {
      p.proc.postMessage(message);
      return true;
    } catch (_) {
      return false;
    }
  }

  // 壳层 → 插件：只有声明 capabilities:["state"] 的插件才收（渲染层节流后推过来）。
  //   kernel  内核状态变化（ready / stopped），ready 时附带动作名清单
  //   state   周期快照（最后活动时间、队列与内核是否空闲）
  // 新就绪的插件会补发最近一份快照，避免插件比壳晚启动就收不到「内核已就绪」
  const lastShell = { kernel: null, state: null };

  function sendShell(tenant, event, data) {
    if (!tenant || !tenant.ready || data == null) return;
    if (!(tenant.capabilities || []).includes('state')) return;
    postToProc(tenant.procRec, { type: 'shell-event', pluginId: tenant.id, event, data });
  }

  function pushShellEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const event = String(payload.event || '');
    if (event !== 'kernel' && event !== 'state') return;
    lastShell[event] = payload.data === undefined ? null : payload.data;
    for (const tenant of workers.values()) sendShell(tenant, event, lastShell[event]);
  }

  function syncConfigToWorker(id, config, rev) {
    const tenant = workers.get(id);
    if (!tenant || !tenant.ready) return;
    postToProc(tenant.procRec, { type: 'config', pluginId: id, config, rev });
  }

  // 结束该插件正在跑 / 排队中的调用，必要时归还进程级计数
  function settleTenant(tenant, status, content) {
    if (!tenant) return;
    const p = tenant.procRec;
    if (p && p.current && p.current.tenantId === tenant.id) {
      clearTimeout(p.current.job.timer);
      p.current.job.resolve({ status, content });
      p.current = null;
      globalRunning = Math.max(0, globalRunning - 1);
    }
    for (const job of tenant.queue.splice(0)) {
      job.resolve({ status, content });
    }
  }

  function markCrash(id, reason) {
    const entry = entryOf(id);
    if (!entry) return;
    entry.enabled = false;
    entry.crashReason = String(reason || '插件进程异常退出');
    entry.updatedAt = Date.now();
    saveRegistry();
    notify('plugin:event', { type: 'crashed', pluginId: id, reason: entry.crashReason });
    pushProcLog(id, 'error', `已标记损坏：${entry.crashReason}`);
    log(`[plugin] ${id} 已标记损坏：${entry.crashReason}`);
  }

  // 停止一整个进程：共享池会连同全部租户一起停掉
  function stopProc(p, { quiet = false } = {}) {
    if (!p) return;
    const wasShared = p.shared;
    p.stopping = true;
    procs.delete(p.key);
    const list = [...p.tenants.values()];
    p.tenants.clear();
    for (const tenant of list) {
      settleTenant(tenant, 'error', '插件进程已停止');
      if (tenant.readyResolve) {
        tenant.readyResolve(null);
        tenant.readyResolve = null;
      }
      clearTimeout(tenant.readyTimer);
      workers.delete(tenant.id);
      pushProcLog(tenant.id, 'info', '进程已停止');
      notifyProcChanged(tenant.id);
    }
    postToProc(p, { type: 'shutdown' });
    const proc = p.proc;
    p.proc = null;
    if (proc) {
      // 给 Worker 一点时间处理 shutdown（dispose 清理定时器），随后强制结束
      setTimeout(() => {
        try {
          proc.kill();
        } catch (_) {
          /* ignore */
        }
      }, 400);
    }
    if (!quiet) log(`[plugin] 已停止进程 ${p.key}${wasShared ? '（共享池）' : ''}`);
  }

  // 从插件维度停进程：独立模式停自己的进程；共享模式停整池并拉起其余租户
  function stopWorker(id, { quiet = false, restart = true } = {}) {
    const tenant = workers.get(id);
    const p = tenant ? tenant.procRec : procs.get(`plugin:${id}`);
    if (!p) {
      workers.delete(id);
      return;
    }
    const wasShared = p.shared;
    stopProc(p, { quiet });
    if (wasShared && restart && !shuttingDown) void startSharedPool();
    if (!quiet) log(`[plugin] 已停止 ${id}`);
  }

  function handleWorkerExit(key, code) {
    const p = procs.get(key);
    if (!p) return; // 主动停止时已经摘表
    procs.delete(key);
    p.proc = null;
    const list = [...p.tenants.values()];
    p.tenants.clear();
    const stopping = p.stopping || shuttingDown;
    for (const tenant of list) {
      settleTenant(tenant, 'error', '插件进程已退出');
      if (tenant.readyResolve) {
        tenant.readyResolve(null);
        tenant.readyResolve = null;
      }
      clearTimeout(tenant.readyTimer);
      workers.delete(tenant.id);
      pushProcLog(tenant.id, stopping ? 'info' : 'error', `插件进程已退出（code ${code}）`);
      notifyProcChanged(tenant.id);
      if (!stopping) {
        markCrash(tenant.id, p.crashReason || (code === 0 ? '插件进程意外退出' : `插件进程异常退出（code ${code}）`));
      }
    }
  }

  // 共享池里任一租户出问题，按「整池损坏」处理
  function crashPool(p, reason) {
    if (!p) return;
    const list = [...p.tenants.values()];
    stopProc(p, { quiet: true });
    if (shuttingDown) return;
    for (const tenant of list) markCrash(tenant.id, reason);
  }

  function pluginNameOf(id) {
    const rec = workers.get(id);
    if (rec && rec.name) return rec.name;
    const info = inspect(id);
    return (info.manifest && info.manifest.name) || id;
  }

  function handleWorkerMessage(key, msg) {
    const p = procs.get(key);
    if (!p || !msg || typeof msg !== 'object') return;
    const pluginId = String(msg.pluginId || '');
    if (msg.type === 'ready') {
      const tenant = workers.get(pluginId);
      if (!tenant || tenant.procRec !== p) return;
      tenant.ready = true;
      clearTimeout(tenant.readyTimer);
      tenant.readyTimer = null;
      if (tenant.readyResolve) {
        tenant.readyResolve(tenant);
        tenant.readyResolve = null;
      }
      pushProcLog(tenant.id, 'info', '进程就绪');
      notifyProcChanged(tenant.id);
      log(`[plugin] ${tenant.id} 进程就绪${p.shared ? '（共享池）' : ''}`);
      // 补发最近一份壳层快照（插件启动晚于内核就绪时也能立刻拿到 ready）
      sendShell(tenant, 'kernel', lastShell.kernel);
      sendShell(tenant, 'state', lastShell.state);
      pumpAll();
      return;
    }
    if (msg.type === 'stats') {
      p.pid = Number(msg.pid) || p.pid;
      p.rssKb = Number(msg.rssKb) || 0;
      for (const tenant of p.tenants.values()) {
        notify('plugin:event', { type: 'proc-stats', pluginId: tenant.id, pid: p.pid, rssKb: p.rssKb });
      }
      return;
    }
    if (msg.type === 'speech-result') {
      const tenant = workers.get(pluginId);
      const requestId = String(msg.requestId || '');
      if (!tenant || !p.current || p.current.callId !== requestId || p.current.kind !== 'speech') {
        log(`[plugin] ${pluginId} 丢弃迟到语音结果 ${requestId}`);
        return;
      }
      const job = p.current.job;
      p.current = null;
      clearTimeout(job.timer);
      globalRunning = Math.max(0, globalRunning - 1);
      if (msg.error || !msg.audio) {
        job.resolve({ ok: false, error: String(msg.error || '插件没有返回音频') });
      } else {
        job.resolve({ ok: true, audio: String(msg.audio), format: String(msg.format || 'wav') });
      }
      pumpAll();
      return;
    }
    if (msg.type === 'result') {
      const tenant = workers.get(pluginId);
      const callId = String(msg.callId || '');
      if (!tenant || !p.current || p.current.callId !== callId) {
        // 已经超时返回过：迟到的结果按 call_id 丢弃，避免串到下一轮
        log(`[plugin] ${pluginId} 丢弃迟到结果 ${callId}`);
        return;
      }
      const job = p.current.job;
      p.current = null;
      clearTimeout(job.timer);
      globalRunning = Math.max(0, globalRunning - 1);
      tenant.timeoutStreak = 0;
      job.resolve({
        status: TOOL_STATUSES.has(msg.status) ? msg.status : 'success',
        content: msg.content == null ? '' : String(msg.content),
        extra: msg.extra && typeof msg.extra === 'object' ? msg.extra : undefined,
      });
      notifyProcChanged(tenant.id);
      pumpAll();
      return;
    }
    if (msg.type === 'patch') {
      void handlePatch(p, pluginId, msg);
      return;
    }
    if (msg.type === 'event') {
      const event = String(msg.event || '');
      if (!event || !pluginId) return;
      notify('plugin:event', {
        type: 'plugin-event',
        pluginId,
        pluginName: pluginNameOf(pluginId),
        event,
        data: msg.data === undefined ? null : msg.data,
      });
      return;
    }
    if (msg.type === 'log') {
      const text = msg.message == null ? '' : String(msg.message);
      pushProcLog(pluginId, 'info', text);
      log(`[plugin:${pluginId}] ${text}`);
      return;
    }
    if (msg.type === 'fatal') {
      // 进程随后就会非 0 退出，崩溃处理在 exit 里统一做；共享池据此整池判损坏
      const text = msg.message == null ? '' : String(msg.message);
      p.crashReason = text;
      pushProcLog(pluginId, 'error', `致命错误：${text}`);
      log(`[plugin:${pluginId}] 致命错误：${text}`);
    }
  }

  async function handlePatch(p, pluginId, msg) {
    const requestId = String(msg.requestId || '');
    const reject = (error) => postToProc(p, { type: 'patch-result', pluginId, requestId, ok: false, error });
    if (!msg.patch || typeof msg.patch !== 'object' || Array.isArray(msg.patch)) {
      reject('patch 必须是一个对象');
      return;
    }
    const current = readConfig(pluginId);
    if (!current.ok) {
      reject(current.error || '读取配置失败');
      return;
    }
    const merged = mergeConfig(current.config, msg.patch);
    const written = writeConfig(pluginId, merged, { fromWorker: true });
    if (!written.ok) {
      reject(written.error || '写入失败');
      return;
    }
    postToProc(p, { type: 'patch-result', pluginId, requestId, ok: true, rev: written.rev, config: merged });
  }

  // 确保进程存在；shared === true 时整池共用一个进程
  function ensureProc(key, shared) {
    const existing = procs.get(key);
    if (existing) return existing;
    if (!utilityProcess) return null;
    const workerPath = path.join(appDir, 'plugin-worker.js');
    let proc = null;
    try {
      proc = utilityProcess.fork(workerPath, [], {
        serviceName: shared ? 'si-plugin-shared' : `si-plugin-${key.slice('plugin:'.length)}`,
        stdio: 'pipe',
      });
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      log(`[plugin] 启动进程失败（${key}）：${text}`);
      return null;
    }
    const rec = {
      key,
      shared,
      proc,
      tenants: new Map(),
      current: null,
      pid: 0,
      rssKb: 0,
      startedAt: Date.now(),
      stopping: false,
      crashReason: '',
    };
    procs.set(key, rec);
    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => log(`[plugin:${key}] ${String(chunk).trimEnd()}`));
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trimEnd();
        for (const tenant of rec.tenants.values()) pushProcLog(tenant.id, 'error', text);
        log(`[plugin:${key}:err] ${text}`);
      });
    }
    proc.on('message', (raw) => {
      // utilityProcess 的 message 事件按版本可能是 MessageEvent 或裸对象，两种都兼容
      const payload = raw && typeof raw === 'object' && raw.type === undefined && raw.data !== undefined ? raw.data : raw;
      try {
        handleWorkerMessage(key, payload);
      } catch (err) {
        // 插件消息不可信：解析出错只记日志，绝不让主进程跟着崩
        log(`[plugin] ${key} 消息处理失败：${err && err.message ? err.message : String(err)}`);
      }
    });
    proc.on('exit', (code) => handleWorkerExit(key, code));
    if (statsWatching) postToProc(rec, { type: 'stats-start' });
    log(`[plugin] 进程启动 ${key}（pid=${proc.pid}）`);
    return rec;
  }

  // 加入一个插件租户；同一插件已有租户则复用
  function ensureWorker(id) {
    if (shuttingDown) return Promise.resolve(null);
    const existing = workers.get(id);
    if (existing) return existing.ready ? Promise.resolve(existing) : existing.readyPromise;
    const entry = entryOf(id);
    if (!entry) return Promise.resolve(null);
    const info = inspect(id);
    if (!info.manifest || info.state !== 'ok') return Promise.resolve(null);
    const shared = effectivePool(entry) === 'shared';
    const p = ensureProc(shared ? 'shared' : `plugin:${id}`, shared);
    if (!p) {
      markCrash(id, '启动进程失败');
      return Promise.resolve(null);
    }
    const cfg = readConfig(id);
    const tenant = {
      id,
      procRec: p,
      ready: false,
      readyPromise: null,
      readyResolve: null,
      readyTimer: null,
      queue: [],
      seq: 0,
      timeoutStreak: 0,
      name: info.manifest.name || id,
      capabilities: info.manifest.capabilities || [],
      timeoutMs: info.manifest.timeoutMs || 20000,
    };
    tenant.readyPromise = new Promise((resolve) => {
      tenant.readyResolve = resolve;
    });
    workers.set(id, tenant);
    p.tenants.set(id, tenant);

    tenant.readyTimer = setTimeout(() => {
      if (tenant.ready || !workers.has(id)) return;
      log(`[plugin] ${id} 启动超时（${WORKER_READY_MS}ms）`);
      pushProcLog(id, 'error', `启动超时（${WORKER_READY_MS}ms）`);
      if (p.shared) {
        crashPool(p, '插件启动超时');
      } else {
        stopWorker(id, { quiet: true, restart: false });
        markCrash(id, '插件启动超时');
      }
    }, WORKER_READY_MS);

    postToProc(p, {
      type: 'init',
      pluginId: id,
      pluginDir: pluginDir(id),
      permission: entry.permission,
      siRoot,
      config: cfg.ok ? cfg.config : {},
      rev: entry.configRev,
    });
    pushProcLog(id, 'info', '进程启动中');
    notifyProcChanged(id);
    return tenant.readyPromise;
  }

  // 共享池重建：把仍然启用、未损坏的共享插件重新拉起来
  async function startSharedPool() {
    if (shuttingDown) return;
    const list = registry.plugins.filter(
      (entry) => entry.enabled && effectivePool(entry) === 'shared' && inspect(entry.id).state === 'ok',
    );
    if (!list.length) return;
    await Promise.all(list.map((entry) => ensureWorker(entry.id)));
  }

  // 进程内的调用是串行的（共享池一个进程同时只跑一个工具，避免插件之间抢占）
  function pump(tenant) {
    const p = tenant ? tenant.procRec : null;
    if (!p || !p.proc || !tenant.ready || !tenant.queue.length) return;
    if (p.current || globalRunning >= MAX_PARALLEL) return;
    const job = tenant.queue.shift();
    const callId = `${tenant.id}-${++tenant.seq}`;
    const speech = job.kind === 'speech';
    p.current = { tenantId: tenant.id, callId, job, kind: job.kind || 'tool' };
    globalRunning += 1;
    notifyProcChanged(tenant.id);
    const timer = setTimeout(() => {
      if (!p.current || p.current.callId !== callId) return;
      p.current = null;
      globalRunning = Math.max(0, globalRunning - 1);
      if (speech) {
        // 语音合成等待时间更长，且不计入「连续超时」熔断
        log(`[plugin] ${tenant.id} 语音合成超时（${Math.round(job.timeoutMs / 1000)}s）`);
        pushProcLog(tenant.id, 'error', `语音合成超时（${Math.round(job.timeoutMs / 1000)}s）`);
        job.resolve({ ok: false, error: `语音合成超时（${Math.round(job.timeoutMs / 1000)}s）` });
        notifyProcChanged(tenant.id);
        pumpAll();
        return;
      }
      tenant.timeoutStreak += 1;
      log(`[plugin] ${tenant.id} 工具 ${job.tool} 超时（${job.timeoutMs}ms）`);
      pushProcLog(tenant.id, 'error', `工具 ${job.tool} 超时（${Math.round(job.timeoutMs / 1000)}s）`);
      job.resolve({ status: 'error', content: `插件响应超时（${Math.round(job.timeoutMs / 1000)}s）` });
      notify('plugin:event', { type: 'timeout', pluginId: tenant.id, tool: job.tool, timeoutMs: job.timeoutMs });
      notifyProcChanged(tenant.id);
      if (tenant.timeoutStreak >= MAX_TIMEOUT_STREAK) {
        // 共享池按「整池损坏」处理，独立进程只影响自己
        crashPool(p, `连续 ${tenant.timeoutStreak} 次超时`);
      } else {
        pumpAll();
      }
    }, job.timeoutMs);
    job.timer = timer;
    const msg = speech
      ? { type: 'speech', pluginId: tenant.id, requestId: callId, payload: job.payload }
      : { type: 'call', pluginId: tenant.id, callId, tool: job.tool, args: job.args };
    if (!postToProc(p, msg)) {
      clearTimeout(timer);
      p.current = null;
      globalRunning = Math.max(0, globalRunning - 1);
      job.resolve(speech ? { ok: false, error: '插件进程已不可用' } : { status: 'error', content: '插件进程已不可用' });
      pumpAll();
    }
  }

  function pumpAll() {
    for (const tenant of workers.values()) pump(tenant);
  }

  // 启动所有已启用且未损坏的插件进程（app ready 之后调用）
  function startAll() {
    ensure();
    const tasks = registry.plugins
      .filter((entry) => entry.enabled)
      .map((entry) => ensureWorker(entry.id));
    return Promise.all(tasks);
  }

  // 直接按进程停，避免共享池里逐插件 stopWorker 反复触发整池重建
  // 只会在退出/停机时调用，因此 shuttingDown 保持为 true，防止退出途中再被拉起进程
  function stopAll() {
    shuttingDown = true;
    for (const p of [...procs.values()]) stopProc(p, { quiet: true });
  }

  // ---- 进程管理器（插件管理页内嵌）
  // 只列已启用或异常的插件；禁用的插件不占进程，没必要显示。
  function procList() {
    ensure();
    const items = [];
    for (const entry of registry.plugins) {
      const tenant = workers.get(entry.id);
      if (!tenant && !entry.enabled) continue;
      const info = inspect(entry.id);
      const broken = !!entry.crashReason || !info.manifest || info.state === 'broken';
      const p = tenant ? tenant.procRec : procs.get(`plugin:${entry.id}`);
      let state = 'stopped';
      if (tenant && p && p.current && p.current.tenantId === entry.id) state = 'busy';
      else if (tenant) state = tenant.ready ? 'ready' : 'starting';
      else if (broken) state = 'broken';
      items.push({
        id: entry.id,
        name: (info.manifest && info.manifest.name) || entry.id,
        version: (info.manifest && info.manifest.version) || '',
        state,
        permission: entry.permission === 'full' ? 'full' : 'restricted',
        pool: effectivePool(entry),
        processKey: p ? p.key : '',
        pid: p ? p.pid : 0,
        rssKb: p ? p.rssKb : 0,
        uptimeMs: p ? Date.now() - p.startedAt : 0,
        queue: tenant ? tenant.queue.length : 0,
        pending: tenant && p && p.current && p.current.tenantId === entry.id ? 1 : 0,
        timeoutStreak: tenant ? tenant.timeoutStreak : 0,
        reason: broken ? entry.crashReason || info.reason || '插件损坏' : '',
      });
    }
    return items;
  }

  function readProcLogs(id) {
    return (procLogs.get(String(id || '')) || []).slice(-200);
  }

  // 手动停止：共享池停整池（其他租户也会停，之后可由用户重新启动）
  function procStop(id) {
    const key = String(id || '');
    if (!entryOf(key)) return { ok: false, error: '插件不存在' };
    const tenant = workers.get(key);
    const p = tenant ? tenant.procRec : procs.get(`plugin:${key}`);
    if (!p) return { ok: true, state: 'stopped' };
    stopProc(p);
    return { ok: true, state: 'stopped', pool: p.shared ? 'shared' : 'dedicated' };
  }

  async function procStart(id) {
    const key = String(id || '');
    const entry = entryOf(key);
    if (!entry) return { ok: false, error: '插件不存在' };
    if (!entry.enabled) return { ok: false, error: '插件已禁用，请先在列表中启用' };
    const info = inspect(key);
    if (info.state === 'broken') return { ok: false, error: `插件损坏：${info.reason || entry.crashReason}` };
    if (effectivePool(entry) === 'shared') {
      // 共享池被手动停掉后，按注册表把仍然启用的共享插件一起拉起来
      await startSharedPool();
    }
    const tenant = workers.get(key) || (await ensureWorker(key));
    if (!tenant) return { ok: false, error: '启动失败，请查看进程日志' };
    return { ok: true, state: tenant.ready ? 'ready' : 'starting', pid: tenant.procRec ? tenant.procRec.pid : 0 };
  }

  // ---- 工具执行：找到插件后交给 Worker，进程隔离 / 串行 / 超时都在主进程侧
  function findPluginTool(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    for (const entry of ensure().plugins) {
      const info = inspect(entry.id);
      if (!info.manifest) continue;
      for (const t of info.manifest.tools) {
        if (t.name.toLowerCase() === key || t.aliases.some((a) => a.toLowerCase() === key)) {
          const known = entry.tools.find((x) => x.name === t.name);
          return {
            entry,
            info,
            tool: t,
            enabled: !!(known && known.enabled),
          };
        }
      }
    }
    return null;
  }

  async function callTool(name, args) {
    const found = findPluginTool(name);
    if (!found) return { status: 'error', content: `未知工具：${name}` };
    const { entry, info, tool } = found;
    if (info.state === 'broken') return { status: 'blocked', content: `插件已损坏，无法执行：${info.reason}` };
    if (!entry.enabled) return { status: 'blocked', content: `插件「${info.manifest.name || entry.id}」已禁用` };
    if (!found.enabled) return { status: 'blocked', content: 'Error: Tool disabled' };
    const rec = await ensureWorker(entry.id);
    if (!rec) return { status: 'error', content: '插件进程未能启动，请到插件管理页查看错误原因' };
    if (rec.queue.length >= MAX_QUEUE_PER_PLUGIN) return { status: 'rate_limited', content: '插件忙，稍后再试' };
    return new Promise((resolve) => {
      rec.queue.push({ tool: tool.name, args: args || {}, timeoutMs: rec.timeoutMs, resolve });
      pump(rec);
    });
  }

  // ---- 语音合成：壳层把已清理的文本交给插件，插件只回音频，不接触会话
  function speechStatus() {
    const found = speechPlugin();
    return {
      ok: true,
      available: !!found,
      plugin: found ? { id: found.entry.id, name: found.info.manifest.name || found.entry.id } : null,
    };
  }

  async function speechSynth(payload) {
    const text = String((payload && payload.text) || '').trim();
    if (!text) return { ok: false, error: '没有可朗读的文本' };
    if (text.length > MAX_SPEECH_CHARS) {
      return { ok: false, error: `朗读文本过长（${text.length} 字 > ${MAX_SPEECH_CHARS}）` };
    }
    const found = speechPlugin();
    if (!found) return { ok: false, error: '没有可用的语音插件' };
    const rec = await ensureWorker(found.entry.id);
    if (!rec) return { ok: false, error: '语音插件进程未能启动' };
    if (rec.queue.length >= MAX_QUEUE_PER_PLUGIN) return { ok: false, error: '语音插件忙，请稍后再试' };
    return new Promise((resolve) => {
      // 语音合成比普通工具慢得多：至少 120s，插件可以在清单里把 timeoutMs 调更大
      const declared = Number(found.info.manifest.timeoutMs) || 0;
      const timeoutMs = Math.min(300000, Math.max(SPEECH_TIMEOUT_MS, declared));
      rec.queue.push({
        kind: 'speech',
        payload: {
          text,
          raw: String((payload && payload.raw) || ''),
          speak: String((payload && payload.speak) || ''),
          character:
            payload && payload.character && typeof payload.character === 'object'
              ? { id: String(payload.character.id || ''), name: String(payload.character.name || '') }
              : { id: '', name: '' },
          speed: Number(payload && payload.speed) || 1,
        },
        timeoutMs,
        resolve,
      });
      pump(rec);
    });
  }

  // ---- 插件运行时（模型 / 可执行程序）：状态、导入 zip、下载
  function runtimeTarget(id) {
    const info = inspect(id);
    if (!info.manifest) return { ok: false, error: '插件清单读取失败' };
    const rt = info.manifest.runtime;
    if (!rt) return { ok: false, error: '插件没有声明 runtime' };
    return {
      ok: true,
      id,
      name: info.manifest.name || id,
      base: path.join(pluginDir(id), rt.dir),
      runtime: rt,
    };
  }

  function runtimeStatus(id) {
    const info = inspect(String(id || ''));
    if (!info.manifest) return { ok: true, runtime: null };
    return { ok: true, runtime: runtimeInfo(info.manifest) };
  }

  async function installRuntimeZip(target, zipFile) {
    const tmp = path.join(os.tmpdir(), `si-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const un = await extractZipTo(zipFile, tmp);
      if (!un.ok) return { ok: false, error: un.error };
      const src = unwrapSingleRoot(tmp);
      copyTree(src, target.base);
      const info = inspect(target.id);
      const status = runtimeInfo(info.manifest);
      log(`[plugin] 运行时已安装到 ${target.base}（${status ? status.state : 'unknown'}）`);
      return {
        ok: true,
        state: status ? status.state : '',
        missing: status ? status.missing : [],
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
      removeTree(tmp);
    }
  }

  async function importRuntime(id, getWindow = null) {
    const target = runtimeTarget(id);
    if (!target.ok) return target;
    const picked = await dialog.showOpenDialog(getWindow ? getWindow() : null, {
      title: `导入「${target.name}」运行时`,
      properties: ['openFile'],
      filters: [{ name: '压缩包', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const zip = picked.filePaths[0];
    let stat = null;
    try {
      stat = fs.statSync(zip);
    } catch (err) {
      return { ok: false, error: `读取压缩包失败：${err.message}` };
    }
    if (stat.size > MAX_RUNTIME_ZIP_BYTES) {
      return { ok: false, error: `压缩包过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_RUNTIME_ZIP_BYTES / 1024 / 1024 / 1024}GB）` };
    }
    try {
      validateZipBuffer(fs.readFileSync(zip), {
        entries: MAX_RUNTIME_ENTRIES,
        uncompressed: MAX_RUNTIME_UNCOMPRESSED,
      });
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
    const task = taskStart ? taskStart('正在导入插件运行时', { detail: target.name }) : null;
    try {
      if (task && taskUpdate) taskUpdate(task.id, { detail: '正在解压运行时', percent: null });
      const done = await installRuntimeZip(target, zip);
      if (task && taskFinish) taskFinish(task.id, { ok: done.ok, detail: done.ok ? '运行时已就绪' : done.error });
      return done;
    } catch (err) {
      if (task && taskFinish) taskFinish(task.id, { ok: false, detail: '导入失败' });
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  async function downloadRuntime(id) {
    const target = runtimeTarget(id);
    if (!target.ok) return target;
    const dl = target.runtime.download;
    if (!dl || !dl.url) return { ok: false, error: '该插件没有提供下载地址，请手动导入 zip' };
    if (!fetchToFile) return { ok: false, error: '当前环境不支持下载' };
    const task = taskStart ? taskStart('正在下载插件运行时', { detail: `${target.name} · ${dl.url.split('/').pop()}` }) : null;
    const zip = path.join(os.tmpdir(), `si-runtime-dl-${Date.now()}.zip`);
    try {
      await fetchToFile(dl.url, zip, {
        onProgress: (received, total) => {
          if (task && taskUpdate) taskUpdate(task.id, { received, total: Number(total) || 0 });
        },
      });
      if (dl.sha256) {
        if (task && taskUpdate) taskUpdate(task.id, { detail: '正在校验 sha256', percent: null });
        const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
        if (hash !== dl.sha256) throw new Error('sha256 校验失败，文件可能已损坏');
      }
      validateZipBuffer(fs.readFileSync(zip), {
        entries: MAX_RUNTIME_ENTRIES,
        uncompressed: MAX_RUNTIME_UNCOMPRESSED,
      });
      if (task && taskUpdate) taskUpdate(task.id, { detail: '正在解压运行时', percent: null });
      const done = await installRuntimeZip(target, zip);
      if (task && taskFinish) taskFinish(task.id, { ok: done.ok, detail: done.ok ? '运行时已就绪' : done.error });
      return done;
    } catch (err) {
      if (task && taskFinish) taskFinish(task.id, { ok: false, detail: '下载失败' });
      return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally {
      try {
        fs.rmSync(zip, { force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  // ---- IPC
  function registerIpc(ipcMain, getWindow) {
    const wrap = (fn) => async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        log('[plugin] ipc error', err && err.stack ? err.stack : String(err));
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    };

    ipcMain.handle('plugin:list', wrap(() => ({ ok: true, ...list() })));
    // 刷新列表时给损坏插件一次重来的机会：清标记 + 置为关闭，等用户手动打开
    ipcMain.handle('plugin:reset-broken', wrap(() => resetBroken()));
    ipcMain.handle('plugin:import', wrap(() => importPlugin({ getWindow })));
    ipcMain.handle('plugin:reimport', wrap((id) => importPlugin({ getWindow, reimportId: String(id || '') })));
    ipcMain.handle('plugin:choose-root', wrap(() => chooseRoot(getWindow)));
    ipcMain.handle('plugin:set-enabled', wrap((id, enabled) => setEnabled(String(id || ''), !!enabled)));
    ipcMain.handle('plugin:set-permission', wrap((id, permission) => setPermission(String(id || ''), permission)));
    ipcMain.handle('plugin:set-pool', wrap((id, pool) => setPool(String(id || ''), pool)));
    ipcMain.handle('plugin:uninstall', wrap((id) => uninstall(String(id || ''))));
    ipcMain.handle('plugin:clear-trash', wrap(() => clearTrash()));
    ipcMain.handle('plugin:open-dir', wrap((id) => openDir(id ? String(id) : '')));
    ipcMain.handle('plugin:read-config', wrap((id) => readConfig(String(id || ''))));
    ipcMain.handle('plugin:write-config', wrap((id, config) => writeConfig(String(id || ''), config)));
    ipcMain.handle('plugin:icon', wrap((id) => readIcon(String(id || ''))));
    ipcMain.handle('plugin:call-tool', wrap((name, args) => callTool(String(name || ''), args || {})));
    ipcMain.handle('plugin:proc-list', wrap(() => ({ ok: true, processes: procList() })));
    ipcMain.handle('plugin:proc-logs', wrap((id) => ({ ok: true, logs: readProcLogs(id) })));
    ipcMain.handle('plugin:proc-stop', wrap((id) => procStop(id)));
    ipcMain.handle('plugin:proc-start', wrap((id) => procStart(id)));
    ipcMain.handle('plugin:proc-watch', wrap((on) => {
      setStatsWatching(!!on);
      return { ok: true, watching: statsWatching };
    }));
    ipcMain.handle('plugin:speech-status', wrap(() => speechStatus()));
    ipcMain.handle('plugin:speech-synth', wrap((payload) => speechSynth(payload || {})));
    ipcMain.handle('plugin:runtime-status', wrap((id) => runtimeStatus(String(id || ''))));
    ipcMain.handle('plugin:runtime-import', wrap((id) => importRuntime(String(id || ''), getWindow)));
    ipcMain.handle('plugin:runtime-download', wrap((id) => downloadRuntime(String(id || ''))));
    // 高频单向推送用 send，不占 invoke 的往返开销
    ipcMain.on('plugin:push-state', (_event, payload) => {
      try {
        pushShellEvent(payload);
      } catch (err) {
        log(`[plugin] 推送壳层状态失败：${err && err.message ? err.message : err}`);
      }
    });
  }

  return {
    registerIpc,
    pushShellEvent,
    resetBroken,
    list,
    toolDefinitions,
    setToolEnabled,
    setPool,
    inspect,
    callTool,
    speechStatus,
    speechSynth,
    runtimeStatus,
    importRuntime,
    downloadRuntime,
    startAll,
    stopAll,
    procList,
    procStop,
    procStart,
    readProcLogs,
    registryRoot: () => (ensure(), registryRoot),
  };
}

module.exports = { createPluginHost, ID_RE, TOOL_RE };
