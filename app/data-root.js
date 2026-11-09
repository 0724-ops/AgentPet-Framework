// 数据根（DataRoot）
// 角色包、插件、记忆库、会话归档都放在这个目录里，避免把大文件塞进 C 盘。
//   <appData>/<appName>/data-root.json   ← 指针文件（不到 1KB，固定留在这）
//   <DataRoot>/.agentpet-root.json       ← 标记文件（认目录用，防止误选桌面之类的目录）
// 目录由用户自选，所以每一步都要校验：绝对路径、非系统目录、非程序目录、非网络/同步盘、可写。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POINTER_FILE = 'data-root.json';
const MARKER_FILE = '.agentpet-root.json';
const SCHEMA_VERSION = 1;

// 常见同步盘 / 网盘的目录名特征：SQLite(WAL) 在这些位置会锁冲突甚至损坏库
const SYNC_HINTS =
  /(^|[\\/])(onedrive|dropbox|google drive|google 云端硬盘|icloud drive|icloud|nutstore|坚果云|baidunetdisk|百度网盘|weiyun|微云|aliyunpan|阿里云盘)([\\/]|$)/i;

function pointerFile(appDataBase, appName) {
  return path.join(appDataBase, appName, POINTER_FILE);
}

function readPointer(appDataBase, appName) {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerFile(appDataBase, appName), 'utf8'));
    return typeof raw.root === 'string' ? raw.root : '';
  } catch (_) {
    return '';
  }
}

function writePointer(appDataBase, appName, root) {
  const file = pointerFile(appDataBase, appName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, root }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function markerFile(root) {
  return path.join(root, MARKER_FILE);
}

function readMarker(root) {
  try {
    return JSON.parse(fs.readFileSync(markerFile(root), 'utf8'));
  } catch (_) {
    return null;
  }
}

// 标记文件是「这个目录归本程序管理」的凭证；没有它就当陌生目录，先问用户
function ensureMarker(root) {
  const existing = readMarker(root);
  if (existing && existing.schemaVersion) return existing;
  const marker = { schemaVersion: SCHEMA_VERSION, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  fs.writeFileSync(markerFile(root), JSON.stringify(marker, null, 2) + '\n', 'utf8');
  return marker;
}

function isInside(child, parent) {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// 网络盘 / 同步盘检测：命中就拒绝，记忆库放上去等于给自己埋雷
function networkReason(dir) {
  if (/^\\\\/.test(dir)) return '该目录是网络路径（UNC），不能放记忆库';
  let type = 0;
  try {
    // libuv 在 Windows 上用 GetDriveType 填这个字段：4 = 网络驱动器
    type = fs.statfsSync(dir).type;
  } catch (_) {
    type = 0;
  }
  if (type === 4) return '该目录在网络驱动器上，不能放记忆库';
  const syncs = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer].filter(Boolean);
  for (const s of syncs) {
    if (isInside(dir, s)) return '该目录在 OneDrive 同步范围内，不能放记忆库';
  }
  if (SYNC_HINTS.test(dir)) return '该目录看起来是同步盘 / 网盘目录，不能放记忆库';
  return '';
}

function forbiddenRoots() {
  return [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter(
    Boolean
  );
}

// 校验一个目录能不能当数据根。
// 返回 { ok, error, fresh }：fresh=false 表示目录里已有内容但没有标记文件，需要用户确认。
function validate(root, { appDir = '', appDataBase = '', appName = '' } = {}) {
  const dir = String(root || '').trim();
  if (!dir) return { ok: false, error: '路径为空' };
  if (!path.isAbsolute(dir)) return { ok: false, error: '必须是绝对路径' };
  if (path.parse(dir).root === dir) return { ok: false, error: '不能直接选盘符根目录' };
  for (const f of forbiddenRoots()) {
    if (isInside(dir, f)) return { ok: false, error: '不能使用系统目录' };
  }
  if (appDir && isInside(dir, appDir)) {
    return { ok: false, error: '不能放在程序目录里，程序升级时会被覆盖' };
  }
  if (appDataBase && appName && isInside(dir, path.join(appDataBase, appName))) {
    return { ok: false, error: '不能放在程序的配置目录里' };
  }

  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch (_) {
    // 不存在就试着建出来（选的通常是新目录）
    try {
      fs.mkdirSync(dir, { recursive: true });
      stat = fs.statSync(dir);
    } catch (err) {
      return { ok: false, error: `目录不存在且无法创建：${err && err.message ? err.message : err}` };
    }
  }
  if (!stat.isDirectory()) return { ok: false, error: '选中的不是目录' };

  const net = networkReason(dir);
  if (net) return { ok: false, error: net };

  // 真的写一次才算「可写」，只读盘 / 受保护目录会在这里暴露
  const probe = path.join(dir, `.agentpet-write-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (err) {
    return { ok: false, error: `目录不可写：${err && err.message ? err.message : err}` };
  }

  let fresh = true;
  try {
    const marker = readMarker(dir);
    const entries = fs.readdirSync(dir).filter((name) => name !== MARKER_FILE);
    fresh = !!marker || entries.length === 0;
  } catch (_) {
    fresh = true;
  }
  return { ok: true, error: '', fresh };
}

// 启动时解析指针：拿到一个「指针存在且目录可达」的根，其余情况交给首启引导处理
function resolve(appDataBase, appName) {
  const root = readPointer(appDataBase, appName);
  if (!root) return { root: '', problem: 'missing', pointerRoot: '' };
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { root: '', problem: 'unreachable', pointerRoot: root };
  return { root, problem: '', pointerRoot: root };
}

// 首启建议位置：打包版放 exe 同级，开发期放程序根同级（避免建议到 node_modules 里）
function suggestRoot({ isPackaged, programRoot, execPath }) {
  if (isPackaged) return path.join(path.dirname(execPath), 'AgentPet DataRoot');
  return path.join(path.dirname(programRoot), 'AgentPet DataRoot');
}

module.exports = {
  POINTER_FILE,
  MARKER_FILE,
  SCHEMA_VERSION,
  pointerFile,
  readPointer,
  writePointer,
  markerFile,
  readMarker,
  ensureMarker,
  networkReason,
  validate,
  resolve,
  suggestRoot,
};
