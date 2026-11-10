// 极简 zip 工具：只读中央目录做安全校验，解压交给系统 tar / PowerShell。
// 角色包和插件包共用同一套规则，避免 Zip Slip / 压缩炸弹。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;

// 读中央目录：名字、压缩后/解压后大小、外部属性（判符号链接）
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

// 大角色包（完整内核 + assets）可能几百 MB，没必要整个读进内存：
// 只读文件尾部找 EOCD，再按需读中央目录。条目校验逻辑与 validateZipBuffer 共用。
function readZipEntriesFromFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error('暂不支持 zip64 格式，请用普通 zip 重新打包');
    }
    if (cdOffset + cdSize > size) throw new Error('zip 文件已损坏（中央目录越界）');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 文件已损坏（中央目录异常）');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const extAttr = cd.readUInt32LE(p + 38);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      entries.push({ name, flags, method, compSize, uncompSize, extAttr });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function checkZipEntries(entries, limits = null) {
  const maxEntries = (limits && limits.entries) || MAX_ENTRIES;
  const maxUncompressed = (limits && limits.uncompressed) || MAX_UNCOMPRESSED;
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

function validateZipBuffer(buf, limits = null) {
  return checkZipEntries(readZipEntries(buf), limits);
}

// 角色包用这个：只读中央目录，不把几百 MB 的包整个读进内存
function validateZipFile(file, limits = null) {
  return checkZipEntries(readZipEntriesFromFile(file), limits);
}

// 系统自带 tar（bsdtar 支持 zip）；失败时退回 PowerShell。
// options.signal：用户取消时杀掉解压进程，返回 { ok:false, canceled:true }
function extractZipTo(zipFile, destDir, { signal } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(destDir, { recursive: true });
    if (signal && signal.aborted) {
      resolve({ ok: false, canceled: true });
      return;
    }
    let child = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try {
        if (child) child.kill();
      } catch (_) {
        /* 进程可能已经退出 */
      }
      finish({ ok: false, canceled: true });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const run = (cmd, args, onFail) => {
      if (settled) return;
      child = spawn(cmd, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (c) => {
        err += c.toString();
      });
      child.on('error', () => onFail && onFail());
      child.on('close', (code) => {
        if (settled) return;
        if (code === 0) finish({ ok: true });
        else if (onFail) onFail(err);
        else finish({ ok: false, error: `解压失败（${code}）：${err.trim().split(/\r?\n/).slice(-2).join(' ')}` });
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
        (err) => finish({ ok: false, error: `解压失败：${String(err || '').trim() || '系统里没有可用的解压工具'}` }),
      ),
    );
  });
}

// 解压出来的东西常常多包一层文件夹，这里把唯一的一层壳剥掉
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

module.exports = {
  MAX_ENTRIES,
  MAX_UNCOMPRESSED,
  readZipEntries,
  readZipEntriesFromFile,
  safeEntryName,
  validateZipBuffer,
  validateZipFile,
  extractZipTo,
  unwrapSingleRoot,
};
