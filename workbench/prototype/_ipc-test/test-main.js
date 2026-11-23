const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = process.env.IPC_TEST_OUT;

app.whenReady().then(async () => {
  const { ipcMain } = require("electron");
  const results = {};

  // 直接调用已注册的 handler
  async function call(channel, ...args) {
    const handlers = [];
    // Electron 内部不暴露 handle 列表，改用 executeCommand 不行
    // 退路：用 ipcMain._invokeHandlers（内部 API）
    const map = ipcMain._invokeHandlers;
    if (!map || !map.has(channel)) return { ok: false, err: "handler 未注册: " + channel };
    try {
      return await map.get(channel)({ sender: null }, ...args);
    } catch (e) {
      return { ok: false, err: String(e && e.message) };
    }
  }

  results.drives = await call("pc:drives");
  results.junk = await call("pc:junk");
  results.ledger = await call("pc:ledger");
  results.toplarge = await call("pc:toplarge", { drive: "C", topN: 5, budgetMs: 5000 });

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
  app.quit();
});