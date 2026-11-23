// 先加载真实 main.js（它会注册所有 ipcMain.handle）
process.env.ELECTRON_RUN_AS_NODE = '';
require('D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳/main.js');

const { app, ipcMain } = require('electron');
const fs = require('fs');
const OUT = process.env.IPC_TEST_OUT;

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 3000));   // 等 main.js 注册完
  const results = {};
  async function call(channel, ...args) {
    const map = ipcMain._invokeHandlers;
    if (!map || !map.has(channel)) return { ok: false, err: "handler 未注册: " + channel };
    try { return await map.get(channel)({ sender: null }, ...args); }
    catch (e) { return { ok: false, err: String(e && e.message) }; }
  }
  results.drives = await call("pc:drives");
  results.junk = await call("pc:junk");
  results.ledger = await call("pc:ledger");
  results.toplarge = await call("pc:toplarge", { drive: "C", topN: 5, budgetMs: 5000 });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
  app.quit();
});