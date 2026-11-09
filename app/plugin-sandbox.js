// ============================================================================
//  插件沙箱（Phase 3 / 共享池）
//
//  只作用于「受限（restricted）」权限的插件代码：
//    * 禁止加载 child_process（不能拉起外部程序）
//    * fs 读写限制在**该插件自己的目录**内（含 fs.promises、软链接逃逸检查）
//    * 允许联网（net / http / https / ws 等不做限制）
//
//  「完全（full）」权限不注册租户，代码完全按原生行为运行。
//
//  共享池下一个 Worker 里会跑多个插件，因此这里按插件注册「根目录」：
//  Module._load 被覆盖一次，先根据 parent.filename 找出它属于哪个插件，
//  再返回该插件专属的受限 fs 代理 / 做路径校验。插件 A 的代码碰不到
//  B 的目录，Worker 自身与第三方依赖（node_modules）的内部加载不受影响。
//
//  拦截时抛出以「[受限模式]」开头的错误，Worker 会把它作为工具错误返回，
//  用户能在控制台看到可读原因，而不是莫名其妙的 EPERM。
// ============================================================================

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const TAG = '[受限模式]';

// 受限模式禁止的模块（已去掉 node: 前缀）
const BLOCKED_MODULES = new Set(['child_process']);

// 需要做路径检查的 fs 方法：键为去掉 Sync 后缀的方法名，值为路径参数下标
const FS_PATH_ARGS = {
  access: [0],
  appendFile: [0],
  chmod: [0],
  chown: [0],
  copyFile: [0, 1],
  cp: [0, 1],
  createReadStream: [0],
  createWriteStream: [0],
  exists: [0],
  lchmod: [0],
  lchown: [0],
  link: [0, 1],
  lstat: [0],
  lutimes: [0],
  mkdir: [0],
  mkdtemp: [0],
  open: [0],
  opendir: [0],
  readFile: [0],
  readdir: [0],
  readlink: [0],
  realpath: [0],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  stat: [0],
  statfs: [0],
  truncate: [0],
  unlink: [0],
  utimes: [0],
  watch: [0],
  watchFile: [0],
  writeFile: [0],
};

// pluginId -> 插件根目录（受限租户才有记录）
const roots = new Map();
// root -> { fs, promises }：每个插件一份受限 fs 代理，避免跨插件串根
const fsCache = new Map();
let hookInstalled = false;

function baseName(prop) {
  return prop.endsWith('Sync') ? prop.slice(0, -4) : prop;
}

function lower(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInsideRoot(root, absPath) {
  const target = lower(path.normalize(absPath));
  const base = lower(path.normalize(root));
  return target === base || target.startsWith(base + path.sep);
}

function deny(target) {
  throw new Error(`${TAG} 拒绝访问插件目录之外的路径：${target}（如需任意读写请切换为「完全」权限）`);
}

// fs 的路径参数可能是 string / Buffer / URL；数字是 fd，交给原生实现
function normalizePathValue(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof URL) {
    try {
      return fileURLToPath(value);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function realPathOf(absPath) {
  try {
    return fs.realpathSync(absPath);
  } catch (_) {
    return null;
  }
}

// 相对路径按插件目录解析；已存在的路径额外校验真实路径，避免软链接逃逸
function assertInsidePath(root, target) {
  if (target === null || target === undefined || target === '') return;
  const abs = path.resolve(root, target);
  if (!isInsideRoot(root, abs)) deny(target);
  const real = realPathOf(abs);
  if (real) {
    if (!isInsideRoot(root, real)) deny(target);
    return;
  }
  // 目标还不存在（通常是新建文件）：向上找到最近的已存在目录再校验
  let dir = path.dirname(abs);
  while (dir && lower(dir).length >= lower(root).length) {
    const realDir = realPathOf(dir);
    if (realDir) {
      if (!isInsideRoot(root, realDir)) deny(target);
      return;
    }
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

function wrapFs(realFs, promiseApi, root) {
  const cache = new Map();
  let promisesProxy = null;
  return new Proxy(realFs, {
    get(target, prop, receiver) {
      if (prop === 'promises' && !promiseApi) {
        if (!promisesProxy) promisesProxy = wrapFs(target.promises, true, root);
        return promisesProxy;
      }
      const raw = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof raw !== 'function') return raw;
      const positions = FS_PATH_ARGS[baseName(prop)];
      if (!positions) return raw;
      if (cache.has(prop)) return cache.get(prop);
      const wrapper = function (...args) {
        for (const idx of positions) {
          if (idx < args.length) assertInsidePath(root, normalizePathValue(args[idx]));
        }
        // symlink 的目标只在绝对路径时检查（相对目标是相对链接所在目录）
        if (prop === 'symlink' || prop === 'symlinkSync') {
          const linkTarget = normalizePathValue(args[0]);
          if (linkTarget && path.isAbsolute(linkTarget)) assertInsidePath(root, linkTarget);
        }
        return raw.apply(target, args);
      };
      cache.set(prop, wrapper);
      return wrapper;
    },
  });
}

function fsFor(root) {
  let entry = fsCache.get(root);
  if (!entry) {
    entry = { fs: wrapFs(fs, false, root), promises: wrapFs(fs.promises, true, root) };
    fsCache.set(root, entry);
  }
  return entry;
}

// parent.filename 属于哪个插件：多个根时取最长的那个（防止根目录互相包含时误判）
function rootForFile(file) {
  if (!file) return '';
  let best = '';
  const abs = path.resolve(file);
  for (const root of roots.values()) {
    if (isInsideRoot(root, abs) && root.length > best.length) best = root;
  }
  return best;
}

function installHook() {
  if (hookInstalled) return;
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const parentFile = parent && parent.filename;
    const root = rootForFile(parentFile);
    // 不在任何受限插件目录内：Worker 自身 / 第三方依赖 / 完全权限插件，保持原样
    if (!root) return originalLoad.apply(this, arguments);

    const raw = String(request || '');
    const bare = raw.startsWith('node:') ? raw.slice(5) : raw;
    if (BLOCKED_MODULES.has(bare)) {
      throw new Error(`${TAG} 插件不允许加载「${raw}」（启动外部程序），如需该能力请切换为「完全」权限`);
    }
    if (bare === 'fs') return fsFor(root).fs;
    if (bare === 'fs/promises') return fsFor(root).promises;

    // 相对 / 绝对路径的 require 也必须落在该插件目录内
    if (raw.startsWith('.') || path.isAbsolute(raw)) {
      let resolved = '';
      try {
        resolved = Module._resolveFilename(request, parent, isMain);
      } catch (_) {
        resolved = '';
      }
      if (resolved && !isInsideRoot(root, resolved)) {
        throw new Error(`${TAG} 拒绝加载插件目录之外的文件：${raw}`);
      }
    }
    return originalLoad.apply(this, arguments);
  };
  hookInstalled = true;
}

// 注册一个插件租户；完全权限直接不注册（无任何限制）
function installSandbox({ pluginId, pluginDir, permission } = {}) {
  const id = String(pluginId || '');
  if (permission === 'full') {
    roots.delete(id);
    return { restricted: false };
  }
  roots.set(id, path.resolve(String(pluginDir || '')));
  installHook();
  return { restricted: true };
}

// Worker 退出某个租户时摘掉它的根，避免共享池里留下失效路径
function uninstallSandbox(pluginId) {
  roots.delete(String(pluginId || ''));
}

module.exports = { installSandbox, uninstallSandbox, TAG };
