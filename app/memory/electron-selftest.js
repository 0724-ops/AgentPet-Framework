// Electron 环境自测：验证 better-sqlite3 / onnxruntime-node 在 Electron 36 的
// 原生模块 ABI 下能正常加载和推理。
// 跑法：node_modules/electron/dist/electron.exe memory/electron-selftest.js

const path = require('node:path');
const { app } = require('electron');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(__dirname, '.tmp', 'electron-userdata'));

app.whenReady().then(async () => {
  try {
    console.log(`Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}`);
    const { runSelfTest } = require('./selftest');
    const report = await runSelfTest();
    app.exit(report.ok ? 0 : 2);
  } catch (err) {
    console.error('✖ Electron 自测失败：' + (err && err.message ? err.message : err));
    if (err && err.stack) console.error(err.stack);
    app.exit(1);
  }
});
