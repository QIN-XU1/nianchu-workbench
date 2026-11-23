#!/usr/bin/env node
// 工具/会话绑定验证.mjs —— 验证「场景 AI 面板绑定到正确会话」是否真的生效
//
// ══════════════════════════════════════════════════════════════════════
//  这个工具验证一个严重缺陷是否已修
// ══════════════════════════════════════════════════════════════════════
//  缺陷（2026-11-12 实测确认）：
//
//    在「调研」场景的 AI 面板里发消息，
//    **消息进了「中枢」的会话**，不是调研的。
//
//    webview 的 localStorage['dsh.sessions.current'] 一直是
//      {"sessionId":"session-dde1feee-..."}  ← 中枢
//    切到任何场景都不变。
//
//  根因（三层）：
//    ① 所有场景的 webview 都用 partition: 'persist:harness'
//       → localStorage 共享 → dsh.sessions.current 串台
//    ② 各场景配置里明明有正确的 sessionId：
//         架构梳理 sessionId="session-223fba45..."
//         调研     sessionId="session-8e710372..."
//       但 harness.js 里 **pinTarget / sessionTitle 各出现 0 次**
//       —— 配置配好了，代码根本不读
//    ③ pinScript(sessionId) 函数写好了（设 localStorage + reload），
//       但 **从未被调用**（grep pinScript 只有定义处）
//
//  突破（2026-11-12 实验）：
//
//    harness.js 的旧注释说「侧栏收起、行不可见，坐标点击很脆弱」——
//    实测确实：sessionRow 的 getBoundingClientRect().left = -140（在可视区外），
//    坐标点击无效。
//
//    但 **DOM 的 el.click() 有效**：
//      点击「逆向分析项目模块实现并沉淀笔记」
//      → current 从 session-dde1feee 变成 session-db87c69e
//      → document.title 也跟着变
//
//    也就是说：不需要坐标，不需要 reload，直接 el.click() 就能切会话。
//
// ══════════════════════════════════════════════════════════════════════
//  这个工具做什么
// ══════════════════════════════════════════════════════════════════════
//  对每个有 AI 面板的场景：
//    ① 切到该场景（主窗口 __WB.switchScene）
//    ② 连到 harness webview
//    ③ 读该场景配置里期望的 sessionId
//    ④ 读 webview 当前的 dsh.sessions.current
//    ⑤ 判断是否一致
//
//  用法：
//    node 工具/会话绑定验证.mjs
//    node 工具/会话绑定验证.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { withUiLock } from './_ui-lock.mjs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const CDP_PORT = 9333;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════
//  CDP（复用 界面功能体检 的实现思路）
// ══════════════════════════════════════════════════════════════════════
function cdpTargets() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json', (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64') },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      let buf = Buffer.alloc(0); let id = 0; const pending = new Map();
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const b1 = buf[1]; let len = b1 & 0x7f; let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
          let t; try { t = JSON.parse(pl.toString('utf8')); } catch { continue; }
          if (t.id && pending.has(t.id)) { pending.get(t.id)(t); pending.delete(t.id); }
        }
      });
      function send(m, p) {
        return new Promise((r) => {
          const myId = ++id; pending.set(myId, r);
          const pl = Buffer.from(JSON.stringify({ id: myId, method: m, params: p || {} }));
          const mask = Buffer.from([1, 2, 3, 4]); const mk = Buffer.alloc(pl.length);
          for (let i = 0; i < pl.length; i++) mk[i] = pl[i] ^ mask[i % 4];
          let h;
          if (pl.length < 126) h = Buffer.from([0x81, 0x80 | pl.length]);
          else if (pl.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(pl.length, 2); }
          else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(pl.length), 2); }
          socket.write(Buffer.concat([h, mask, mk]));
          setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); r({ error: 'timeout' }); } }, 20000);
        });
      }
      resolve({ send, close: () => socket.end() });
    });
    req.on('error', reject);
    req.end();
  });
}

async function evalOn(cdp, expr, awaitPromise) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: awaitPromise !== false, userGesture: true,
  });
  return r.result && r.result.result ? r.result.result.value : undefined;
}

// ══════════════════════════════════════════════════════════════════════
//  读场景配置（含期望的 sessionId）
// ══════════════════════════════════════════════════════════════════════
export function loadSceneBindings() {
  if (!fs.existsSync(SCEN_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SCEN_DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8'));
      const ai = (j.panels || []).filter((p) => p.type === 'harness');
      if (!ai.length) continue;
      const p = ai[0];
      out.push({
        id: j.id || f.replace('.json', ''),
        name: j.name || j.id,
        expectSessionId: p.sessionId ? String(p.sessionId) : null,
        sessionTitle: p.sessionTitle || null,
        pinTarget: p.pinTarget || null,
        panelId: p.id,
      });
    } catch { /* ignore */ }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  会话绑定验证 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】场景配置读取');
  const b = loadSceneBindings();
  chk('能读到有 AI 面板的场景', b.length > 0, b.length + ' 个');
  chk('每个场景都有期望 sessionId', b.every((x) => x.expectSessionId), 
    b.filter((x) => !x.expectSessionId).map((x) => x.name).join(',') || '全有');
  chk('每个场景都有 sessionTitle', b.every((x) => x.sessionTitle),
    b.filter((x) => !x.sessionTitle).map((x) => x.name).join(',') || '全有');
  chk('sessionId 各不相同（没有串台配置）',
    new Set(b.map((x) => x.expectSessionId)).size === b.length,
    b.length + ' 个场景 / ' + new Set(b.map((x) => x.expectSessionId)).size + ' 个不同 id');

  console.log();
  console.log('【二】harness.js 是否真的用了这些配置');
  const hp = path.join(WB, '外壳', 'ui', 'panels', 'harness.js');
  let hs = '';
  try { hs = fs.readFileSync(hp, 'utf8'); } catch { /* ignore */ }
  chk('harness.js 存在', !!hs);
  if (hs) {
    // 这是本工具存在的意义：验证配置有没有被代码读取
    const readsSessionId = /p\.sessionId/.test(hs);
    chk('harness.js 读 p.sessionId', readsSessionId, readsSessionId ? '' : '配置没被读取');
    // pinSessionToScene 是修复后应该出现的函数名
    const hasPin = /pinSessionToScene|sceneSessionPin/.test(hs);
    chk('harness.js 有场景会话绑定逻辑（pinSessionToScene）', hasPin,
      hasPin ? '' : '还没实现');
  }

  console.log();
  console.log('【三】反例验证（判据必须能抓到错）');
  {
    // 反例1：sessionId 不匹配时必须判错
    const fakeMatch = (want, actual) => String(want) === String(actual);
    chk('反例：sessionId 不同必须判不匹配',
        fakeMatch('session-aaa', 'session-bbb') === false, '正确');
    // 反例2：actual 为 null（空会话）时必须判不匹配
    chk('反例：actual=null 必须判不匹配',
        fakeMatch('session-aaa', null) === false, '正确');
    // 正例：相同 sessionId 必须判匹配
    chk('正例：sessionId 相同判匹配',
        fakeMatch('session-aaa', 'session-aaa') === true, '正确');
  }

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { selftest(); return; }

  const bindings = loadSceneBindings();
  console.log('═'.repeat(78));
  console.log('  会话绑定验证 —— 场景 AI 面板绑定的是不是它自己的会话？');
  console.log('═'.repeat(78));
  console.log();
  console.log('  背景：实测发现在「调研」场景发消息，消息进了「中枢」的会话。');
  console.log('        本工具逐场景核对：配置里期望的 sessionId 与实际 current 是否一致。');
  console.log();

  const ts = await cdpTargets();
  const page = ts.find((t) => t.type === 'page' && t.url && t.url.includes('ui/index.html'));
  if (!page) { console.log('  ✗ 找不到主窗口'); process.exit(2); }
  const mainCdp = await cdpConnect(page.webSocketDebuggerUrl);
  await mainCdp.send('Runtime.enable');

  let okN = 0;
  const bad = [];

  for (const b of bindings) {
    // 切到该场景
    await evalOn(mainCdp, `(async function(){
      try { await window.__WB.switchScene(${JSON.stringify(b.id)}); return window.__WB.getCurrentScene(); }
      catch(e) { return 'ERR'; }
    })()`);
    // ⚠ 2026-11-12 修：等 3 秒不够
    //
    //   实测：只等 3 秒时读到的是**上一个场景的残留**，导致 8 个场景全判失败。
    //   绑定逻辑本身需要：
    //     1200ms（dom-ready 延时）+ 最多 3 次 × 800ms 重试 ≈ 3.6 秒
    //   加上 webview 加载时间，至少要 6-8 秒。
    // ⚠ 2026-11-12 修（第二次修，这次是「引擎刚重启」的时序问题）：
    //
    //   第一次修：从 3 秒改成 4 秒 + 轮询，解决「读到上一个场景残留」。
    //   第二次修（本次）：解决「引擎刚重启时全部绑定到同一个会话」。
    //
    //   实测：重新生成 AGENTS.local.md 后重启引擎，立刻跑这个工具，
    //        8 个场景全部报「实际=session-587c9493」（逆向分析的会话）→ 0/8。
    //        再重启一次工作台后，8/8 全对。
    //
    //   原因：引擎刚起来时，所有 webview 都还没完成各自的会话绑定，
    //        localStorage 里是共享 partition 的默认值（最后写入的那个场景）。
    //
    //   修法：检测引擎启动时长 —— 启动不到 3 分钟就多等一会儿。
    //        这不是「放宽判据」，是给真实的重建留出必要时间。
    let engineUpMs = 0;
    try {
      const st = fs.statSync(path.join(WB, '外壳', 'server.log'));
      engineUpMs = Date.now() - st.mtimeMs;
    } catch { /* ignore */ }
    const engineFresh = engineUpMs > 0 && engineUpMs < 180000;
    if (engineFresh) {
      console.log('  （引擎刚启动 ' + Math.round(engineUpMs / 1000) + ' 秒，多等 6 秒让 webview 完成绑定）');
      await sleep(6000);
    }

    await sleep(4000);

    // 再轮询确认 webview 已就绪且 current 有值
    for (let w = 0; w < 10; w++) {
      const tsW = await cdpTargets();
      const wvW = tsW.filter((t) => t.type === 'webview' && t.url && t.url.startsWith('http://127.0.0.1:'));
      if (wvW.length) {
        let tmp = null;
        let hasVal = false;
        try {
          tmp = await cdpConnect(wvW[0].webSocketDebuggerUrl);
          await tmp.send('Runtime.enable');
          const rr = await tmp.send('Runtime.evaluate', {
            expression: 'localStorage.getItem("dsh.sessions.current") || ""',
            returnByValue: true,
          });
          const vv = rr.result && rr.result.result && rr.result.result.value;
          hasVal = !!vv;
        } catch { /* ignore */ }
        try { if (tmp) tmp.close(); } catch { /* ignore */ }
        if (hasVal) break;
      }
      await sleep(1000);
    }

    // 连 webview
    const ts2 = await cdpTargets();
    const wvs = ts2.filter((t) => t.type === 'webview' && t.url && t.url.startsWith('http://127.0.0.1:'));
    if (!wvs.length) { console.log('  ? ' + b.name.padEnd(12) + ' 无 webview'); continue; }

    const wv = await cdpConnect(wvs[0].webSocketDebuggerUrl);
    await wv.send('Runtime.enable');
    const cur = await evalOn(wv, `(function(){
      try { return JSON.parse(localStorage.getItem('dsh.sessions.current')||'null'); } catch(e) { return null; }
    })()`);
    wv.close();

    const actual = cur && cur.sessionId ? String(cur.sessionId) : null;
    const want = b.expectSessionId;
    const match = actual === want;

    if (match) okN++;
    else bad.push({ scene: b.name, want, actual });

    console.log('  ' + (match ? 'OK' : 'XX') + ' ' + b.name.padEnd(12) +
      ' 期望=' + String(want).slice(0, 20) + '  实际=' + String(actual).slice(0, 20));
  }

  mainCdp.close();

  console.log();
  console.log('─'.repeat(78));
  console.log('  结果: ' + okN + ' / ' + bindings.length + ' 个场景绑定了自己的会话');
  if (bad.length) {
    console.log('  绑错的场景: ' + bad.map((x) => x.scene).join(', '));
    console.log();
    console.log('  ⚠ 这意味着：用户在这些场景里跟 AI 说话，实际是在跟别的场景说话。');
    process.exitCode = 1;
  }
  console.log('═'.repeat(78));
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}

withUiLock('会话绑定验证', main).catch((e) => {
  console.error('  ✗ ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
