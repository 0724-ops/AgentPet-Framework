// 角色宿：扫描 / 归一化 / 导入角色包。
//
// 约定：
//   * 程序只是壳，没有内置角色：所有角色都在 <DataRoot>/characters/<id>/ 下。
//   * 角色的 character.json 里所有路径都相对角色目录自身，整包可移动。
//   * 交给渲染层时统一成「app 根相对路径」：统一加 characters/<id>/ 前缀，
//     这样 app://si/characters/... 走同一个协议。
//   * characters/registry.json 只记录当前角色 id；角色清单以磁盘目录为真相源。
const fs = require('fs');
const path = require('path');
const { validateZipFile, extractZipTo, unwrapSingleRoot } = require('./zip');

const REGISTRY_FILE = 'registry.json';
const SCHEMA_VERSION = 1;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHAR_DIR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ICON_NAMES = ['icon.png', 'icon.jpg', 'icon.jpeg', 'icon.webp', 'icon.gif'];
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 4 * 1024 * 1024 * 1024;

function readJson(file) {
  try {
    // 有些打包工具会写 UTF-8 BOM，JSON.parse 会因此失败
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
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

function isDir(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch (_) {
    return false;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    /* 删不掉时留给用户手动处理 */
  }
}

// 解压进度：tar 不报进度，按目标目录里已有的字节数轮询估算
function dirBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const ent of entries) {
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirBytes(file);
    else if (ent.isFile()) {
      try {
        total += fs.statSync(file).size;
      } catch (_) {
        /* 文件可能刚创建还没落盘 */
      }
    }
  }
  return total;
}

// 只接受相对路径，挡住绝对路径与 .. 穿越
function cleanRel(raw) {
  let rel = String(raw || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || /^[A-Za-z]:/.test(rel)) return '';
  if (rel.split('/').some((s) => s === '..')) return '';
  return rel;
}

function joinRel(a, b) {
  return [cleanRel(a), cleanRel(b)].filter(Boolean).join('/');
}

// 平铺包：内核文件散在角色根目录时，整体收进一个子目录，避免和角色自己的文件混在一起。
// 包里的相对引用（./kernel/main.js、./assets/...）跟着一起搬，路径保持不变。
const KEEP_AT_ROOT = new Set([
  'character.json',
  'persona.md',
  'session.json',
  'icon.png',
  'icon.jpg',
  'icon.jpeg',
  'icon.webp',
  'icon.gif',
]);

function wrapFlatRoot(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return '';
  }
  const movable = entries.filter((e) => !e.name.startsWith('.') && !KEEP_AT_ROOT.has(e.name.toLowerCase()));
  if (!movable.length) return '';
  // 优先 kernel/；包内已经有 kernel/（内核自己的 JS 模块目录）时退到 kernel-app/
  const wrap =
    ['kernel', 'kernel-app', 'kernel-app-2', 'kernel-app-3'].find((n) => !exists(path.join(root, n))) ||
    `kernel-${Date.now()}`;
  const dest = path.join(root, wrap);
  fs.mkdirSync(dest, { recursive: true });
  for (const e of movable) {
    fs.renameSync(path.join(root, e.name), path.join(dest, e.name));
  }
  return wrap;
}

// 搬完之后，character.json 里相对角色根目录的路径要跟着加上前缀
function prefixKernelPaths(char, wrap) {
  if (!char || !wrap) return char;
  const fix = (rel) => {
    const clean = cleanRel(rel);
    return clean ? `${wrap}/${clean}` : rel;
  };
  const kernel = char.kernel || {};
  if (kernel.entry) kernel.entry = fix(kernel.entry);
  if (kernel.webglEntry) kernel.webglEntry = fix(kernel.webglEntry);
  if (char.actions) char.actions = fix(char.actions);
  if (char.clips) char.clips = fix(char.clips);
  if (char.actionsSource && char.actionsSource.index) char.actionsSource.index = fix(char.actionsSource.index);
  char.kernel = kernel;
  return char;
}

// 角色目录里的图标：优先 character.json 指定的，其次常见文件名
function pickIcon(dir, preferred) {
  const want = cleanRel(preferred);
  if (want && exists(path.join(dir, want))) return want;
  for (const name of ICON_NAMES) {
    if (exists(path.join(dir, name))) return name;
  }
  return '';
}

// kernel.json 可能直接躺在角色根，也可能在 kernel/ 子目录里
function findKernelJson(dir) {
  const direct = path.join(dir, 'kernel.json');
  if (exists(direct)) return { file: direct, root: dir };
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const file = path.join(dir, ent.name, 'kernel.json');
    if (exists(file)) return { file, root: path.join(dir, ent.name) };
  }
  return null;
}

// 内核名常见写成「安洁莉娜 · Spine 2D 内核」，角色名取分隔符前一段
function displayNameFrom(kernelName, fallback) {
  const first = String(kernelName || '').split(/\s*[·|]\s*/)[0].trim();
  return first || fallback;
}

// 没有 character.json 的角色包：从 kernel.json 合成一份（路径相对角色目录）
function synthFromKernel(dir, info, folder) {
  const kernel = readJson(info.file) || {};
  const kernelRel = path.relative(dir, info.root).split(path.sep).join('/');
  const entry = joinRel(kernelRel, kernel.entry || 'index.html');
  const actionsIndex = joinRel(kernelRel, kernel.actions || 'assets/actions/_index.json');
  // actions.json 可能跟着内核一起被收进子目录，两个位置都认
  const actionsJson = exists(path.join(dir, 'actions.json'))
    ? 'actions.json'
    : exists(path.join(info.root, 'actions.json'))
      ? joinRel(kernelRel, 'actions.json')
      : '';
  const name = displayNameFrom(kernel.name, folder);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: folder,
    name,
    version: kernel.version || '',
    kernel: {
      id: kernel.id || folder,
      name: kernel.name || name,
      version: kernel.version || '',
      entry,
      webglEntry: kernel.webglEntry ? joinRel(kernelRel, kernel.webglEntry) : entry,
      label: kernel.name || name,
      backend: kernel.backend || '',
      source: {},
    },
    clips: '',
    clipPrefix: '',
    // 2D / Live2D 内核没有 .glb，动作直接读清单
    actions: actionsJson,
    actionsSource: { mode: 'index', index: actionsIndex },
    memory: { mode: 'own' },
    icon: '',
  };
}

function createCharacterHost({ dataRoot, log = () => {} }) {
  const charactersDir = dataRoot ? path.join(dataRoot, 'characters') : '';
  const registryFile = charactersDir ? path.join(charactersDir, REGISTRY_FILE) : '';

  function ensureDirs() {
    if (!charactersDir) return;
    try {
      fs.mkdirSync(charactersDir, { recursive: true });
    } catch (err) {
      log('[character] 角色目录创建失败', err && err.message ? err.message : String(err));
    }
  }

  function readRegistry() {
    if (!registryFile) return {};
    const raw = readJson(registryFile);
    if (raw && typeof raw === 'object') return raw;
    // 注册表损坏：备份原文件，随后按磁盘重建；角色本身不受影响
    if (exists(registryFile)) {
      try {
        fs.renameSync(registryFile, `${registryFile}.bak`);
        log('[character] registry.json 损坏，已备份为 .bak');
      } catch (_) {
        /* 备份失败也不阻塞 */
      }
    }
    return {};
  }

  function writeRegistry(active) {
    if (!registryFile) return;
    ensureDirs();
    writeJsonAtomic(registryFile, { schemaVersion: SCHEMA_VERSION, activeCharacter: active || '' });
  }

  // 角色：磁盘路径 → app 根相对路径
  function toAppRel(folder, raw) {
    const rel = cleanRel(raw);
    if (!rel) return '';
    if (rel === 'characters' || rel.startsWith('characters/')) return rel;
    return `characters/${folder}/${rel}`;
  }

  function normalizeExternal(folder) {
    const dir = path.join(charactersDir, folder);
    if (!isDir(dir)) return null;
    const raw = readJson(path.join(dir, 'character.json'));
    const kernelInfo = findKernelJson(dir);
    const synth = kernelInfo ? synthFromKernel(dir, kernelInfo, folder) : null;
    if (!raw && !synth) return null;

    const base = synth || { id: folder, name: folder, kernel: {}, actionsSource: { mode: 'files', index: '' } };
    const rawKernel = (raw && raw.kernel) || {};
    const kernel = { ...(base.kernel || {}), ...rawKernel };
    const id = raw && raw.id && ID_RE.test(raw.id) ? raw.id : folder;
    const name = (raw && raw.name) || base.name || folder;
    const version = (raw && raw.version) || kernel.version || base.version || '';
    const icon = pickIcon(dir, raw && raw.icon);

    // 动作来源：index = 只认清单（2D / Live2D）；files = 扫 clips 目录
    const rawSource = { ...((base && base.actionsSource) || {}), ...((raw && raw.actionsSource) || {}) };
    const clips = (raw && raw.clips) || base.clips || '';
    const sourceMode = rawSource.mode === 'index' ? 'index' : 'files';
    const sourceIndex = rawSource.index || (clips ? `${clips}/_index.json` : '');
    const entryRel = cleanRel(kernel.entry || 'index.html');

    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      name,
      version,
      icon: toAppRel(folder, icon),
      kernel: {
        id: kernel.id || id,
        name: kernel.name || name,
        version: kernel.version || version,
        entry: toAppRel(folder, entryRel),
        webglEntry: kernel.webglEntry ? toAppRel(folder, kernel.webglEntry) : '',
        label: kernel.label || kernel.name || name,
        backend: kernel.backend || '',
        source: kernel.source || {},
      },
      clips: toAppRel(folder, clips),
      clipPrefix: (raw && raw.clipPrefix) || base.clipPrefix || '',
      actions: toAppRel(folder, (raw && raw.actions) || base.actions || ''),
      actionsSource: {
        mode: sourceMode,
        index: toAppRel(folder, sourceIndex),
      },
      memory: (raw && raw.memory) || base.memory || { mode: 'own' },
      dir,
      relDir: `characters/${folder}`,
      folder,
      broken: !exists(path.join(dir, entryRel)),
    };
  }

  function list() {
    const out = [];
    if (!charactersDir) return out;
    ensureDirs();
    let entries = [];
    try {
      entries = fs.readdirSync(charactersDir, { withFileTypes: true });
    } catch (_) {
      return out;
    }
    const seen = new Set();
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && CHAR_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort();
    for (const folder of folders) {
      const char = normalizeExternal(folder);
      if (!char) continue;
      if (seen.has(char.id)) {
        log('[character] 角色 id 重复，已跳过', folder, char.id);
        continue;
      }
      seen.add(char.id);
      out.push(char);
    }
    return out;
  }

  function resolve() {
    const characters = list();
    const wanted = readRegistry().activeCharacter || '';
    const activeId = characters.some((c) => c.id === wanted) ? wanted : characters[0] ? characters[0].id : '';
    return { characters, activeId, active: characters.find((c) => c.id === activeId) || null };
  }

  function getById(id) {
    return list().find((c) => c.id === id) || null;
  }

  // 角色目录名：优先用 zip 文件名第一段（anjielina-2d-kernel-0.1.0 → anjielina）
  function suggestId(zipFile) {
    const base = path.basename(zipFile).replace(/\.zip$/i, '');
    const first = String(base).split(/[-_]/)[0].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    return ID_RE.test(first) ? first : `char-${Date.now()}`;
  }

  async function importZip(zipFile, { iconFile, signal, onProgress } = {}) {
    const report = (patch) => {
      try {
        if (onProgress) onProgress(patch);
      } catch (_) {
        /* 进度回调不能影响导入本身 */
      }
    };
    if (signal && signal.aborted) return { ok: false, canceled: true };
    if (!charactersDir) return { ok: false, error: '数据目录不可用，无法导入角色' };
    let stat = null;
    try {
      stat = fs.statSync(zipFile);
    } catch (_) {
      return { ok: false, error: '角色包不存在' };
    }
    if (!stat.isFile()) return { ok: false, error: '请选择一个 zip 文件' };
    if (stat.size > MAX_ZIP_BYTES) {
      return { ok: false, error: `角色包过大（${(stat.size / 1024 / 1024).toFixed(0)}MB > ${MAX_ZIP_BYTES / 1024 / 1024 / 1024}GB）` };
    }

    const id = suggestId(zipFile);
    const target = path.join(charactersDir, id);
    if (exists(target)) return { ok: false, error: `角色已存在：characters/${id}，请先删除旧目录再导入` };

    ensureDirs();
    const tmp = path.join(charactersDir, `.import-${process.pid}-${Date.now()}`);
    let progressTimer = null;
    try {
      // 先过安全校验（路径穿越 / 符号链接 / 压缩炸弹），再交给系统解压
      const checked = validateZipFile(zipFile, { entries: MAX_ENTRIES, uncompressed: MAX_UNCOMPRESSED });
      const totalBytes = checked.total || 0;
      report({ detail: '正在解压角色包', received: 0, total: totalBytes });
      if (totalBytes) {
        // tar / Expand-Archive 都不给进度：按目标目录已解出的字节数估算
        progressTimer = setInterval(() => {
          report({ received: Math.min(dirBytes(tmp), totalBytes), total: totalBytes });
        }, 400);
        if (progressTimer.unref) progressTimer.unref();
      }
      const un = await extractZipTo(zipFile, tmp, { signal });
      clearInterval(progressTimer);
      progressTimer = null;
      if (signal && signal.aborted) {
        removeTree(tmp);
        return { ok: false, canceled: true };
      }
      if (!un.ok) throw new Error(un.error || '解压失败');
      report({ detail: '正在安装角色', received: totalBytes, total: totalBytes });

      // 常见包会多包一层目录
      const root = unwrapSingleRoot(tmp);
      let kernelInfo = findKernelJson(root);
      let rawChar = readJson(path.join(root, 'character.json'));
      if (!kernelInfo && !rawChar) throw new Error('不是有效的角色包：缺少 kernel.json 或 character.json');

      // 内核平铺在根目录（entry 只有一层）时，整体收进一个子目录：
      // 换内核时整目录替换，也不会和 character.json / 记忆库 / 会话混在一起。
      const declaredEntry = cleanRel(
        (rawChar && rawChar.kernel && rawChar.kernel.entry) ||
          (kernelInfo && (readJson(kernelInfo.file) || {}).entry) ||
          'index.html'
      );
      const kernelAtRoot = !kernelInfo || kernelInfo.root === root;
      if (kernelAtRoot && !declaredEntry.includes('/')) {
        const wrap = wrapFlatRoot(root);
        if (wrap) {
          prefixKernelPaths(rawChar, wrap);
          if (rawChar) writeJsonAtomic(path.join(root, 'character.json'), rawChar);
          // 搬完重新定位内核清单（kernel.json 也跟着进了子目录）
          kernelInfo = findKernelJson(root);
          rawChar = readJson(path.join(root, 'character.json'));
        }
      }

      // 校验入口文件真的存在
      const entry = cleanRel(
        (rawChar && rawChar.kernel && rawChar.kernel.entry) ||
          (kernelInfo && joinRel(path.relative(root, kernelInfo.root), (readJson(kernelInfo.file) || {}).entry || 'index.html'))
      );
      if (!entry || !exists(path.join(root, entry))) throw new Error(`角色包缺少内核入口文件：${entry || 'index.html'}`);

      const icon = pickIcon(root, rawChar && rawChar.icon) || (iconFile ? copyIcon(root, iconFile) : '');
      if (!rawChar) {
        // 只有 kernel.json 的包：补一份 character.json，后续路径都相对角色目录
        writeJsonAtomic(path.join(root, 'character.json'), { ...synthFromKernel(root, kernelInfo, id), icon });
      } else if (!rawChar.id || !ID_RE.test(rawChar.id) || !rawChar.icon) {
        if (!rawChar.id || !ID_RE.test(rawChar.id)) rawChar.id = id;
        if (!rawChar.icon && icon) rawChar.icon = icon;
        writeJsonAtomic(path.join(root, 'character.json'), rawChar);
      }

      // 解压目录 → 正式目录（同一分区，rename 是原子的）
      fs.renameSync(root, target);
      if (root !== tmp) removeTree(tmp);

      const character = normalizeExternal(id);
      if (!character) throw new Error('导入后角色校验失败');

      // 不改当前角色：切换属于下一阶段，导入只负责把角色放进来
      const reg = readRegistry();
      writeRegistry(reg.activeCharacter || resolve().activeId || id);
      report({ detail: '导入完成', received: totalBytes, total: totalBytes });
      log(`[character] 已导入角色 ${id}`);
      return { ok: true, id, character, icon: !!character.icon };
    } catch (err) {
      if (progressTimer) clearInterval(progressTimer);
      removeTree(tmp);
      if (signal && signal.aborted) return { ok: false, canceled: true };
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  function copyIcon(dir, iconFile) {
    try {
      const ext = path.extname(iconFile).toLowerCase();
      const name = `.png .jpg .jpeg .webp .gif`.split(' ').includes(ext) ? `icon${ext === '.jpeg' ? '.jpg' : ext}` : '';
      if (!name) return '';
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(iconFile, path.join(dir, name));
      return name;
    } catch (err) {
      log('[character] 图标复制失败', err && err.message ? err.message : String(err));
      return '';
    }
  }

  // 给角色补一张图标（导入后选择 / 后续手动更换都走这里）
  function setIcon(id, iconFile) {
    const char = list().find((c) => c.id === id);
    if (!char) return { ok: false, error: '角色不存在' };
    const name = copyIcon(char.dir, iconFile);
    if (!name) return { ok: false, error: '只能使用 png / jpg / webp / gif 图片' };
    const raw = readJson(path.join(char.dir, 'character.json')) || {};
    raw.icon = name;
    writeJsonAtomic(path.join(char.dir, 'character.json'), raw);
    const character = normalizeExternal(char.folder);
    return { ok: true, character };
  }

  // 切换角色：只改注册表里的 activeCharacter，磁盘目录不动
  function setActive(id) {
    const target = list().find((c) => c.id === id);
    if (!target) return { ok: false, error: '角色不存在' };
    writeRegistry(target.id);
    log(`[character] 切换角色 → ${target.id}`);
    return { ok: true, character: target };
  }

  // 删除角色目录：当前角色不允许删，避免程序变成无角色可用
  function remove(id) {
    const char = list().find((c) => c.id === id);
    if (!char) return { ok: false, error: '角色不存在' };
    if (!char.folder || !charactersDir) return { ok: false, error: '角色目录不可用' };
    if (resolve().activeId === char.id) return { ok: false, error: '当前角色不可删除，请先切换到其他角色' };
    const dir = path.join(charactersDir, char.folder);
    const root = path.resolve(charactersDir);
    if (!path.resolve(dir).startsWith(root + path.sep)) return { ok: false, error: '角色目录越界' };
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
    log(`[character] 已删除角色 ${char.id}`);
    return { ok: true, id: char.id };
  }

  // 启动时保证注册表存在，指向一个真实存在的角色
  function init() {
    if (!charactersDir) return;
    ensureDirs();
    const reg = readRegistry();
    const current = resolve();
    const active = reg.activeCharacter && current.characters.some((c) => c.id === reg.activeCharacter)
      ? reg.activeCharacter
      : current.activeId;
    if (reg.activeCharacter !== active || !exists(registryFile)) writeRegistry(active);
  }

  init();

  return { charactersDir, registryFile, list, resolve, getById, importZip, setIcon, setActive, remove };
}

module.exports = { createCharacterHost, ID_RE };
