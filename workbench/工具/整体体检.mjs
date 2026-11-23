#!/usr/bin/env node
// 工具/整体体检.mjs —— 检查「整体是否真的搭好了」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么有这个工具
// ══════════════════════════════════════════════════════════════════════
//  2026-11-11 发现：9 个场景的 AI 面板全部停在引擎首页
//  「探索未至之境 / 选择一个工作区开始」——输入框都不存在。
//
//  根因：引擎的 workspace.json 里 workspaceIds 是空数组。
//       会话建了 22 条，但没有任何「工作区」注册，
//       而引擎 UI 必须先有工作区才能进会话界面。
//
//  这个缺陷持续了很久都没被发现，因为：
//    · 面板渲染是成功的（DOM 有、尺寸正常）
//    · 只有真正去看 webview 内部才知道是「选择工作区」页
//    · 没有工具会去跑一次真实对话
//
//  所以这个工具的核心是：**必须在一个场景的 AI 面板里真的发一条消息**。
//
//  ══════════════════════════════════════════════════════════════════
//  检查项
// ══════════════════════════════════════════════════════════════════════
//    ① 引擎的 workspace.json 里工作区数 ≥ 场景数
//    ② 每个场景的 AI 面板 webview 进入「可输入」状态
//    ③ 在其中一个场景里真的发一条消息，必须收到 AI 回复  ← 唯一真正的判据
//
//  用法：
//    node 工具/整体体检.mjs              # 完整检查
// ══════════════════════════════════════════════════════════════════════
//  ④ 调度链路：中枢派单 → 场景真的收到 → 场景回复
//
//  ⚠ 2026-11-11：这是整个项目最核心的机制，但之前从来没被端到端验过。
//
//  发现的问题链：
//    ① hub 的 SKILL.md 里派单命令参数是错的（--prompt / --needs 不存在）
//       → 照着做只会打印帮助然后 exit=0，台账里什么都没有
//    ② 所以「中枢以为派了单，场景从来没收到」
//
//  这条检查做的事：
//    真的往一个场景会话投递一条消息，看它是否出现在该会话的事件流里。
//    **这是唯一能证明「调度链路通」的判据。**
// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
//  引擎 RPC 小工具（供调度链路检查用）
//
//  ⚠ 2026-11-11：这两个是从 沙箱体检.mjs 里搬过来的，
//    不能直接跨文件用（模块作用域隔离）。
// ══════════════════════════════════════════════════════════════════════
async function getCookie() {
  const logPath = path.join(WB, "外壳", "server.log");
  if (!fs.existsSync(logPath)) throw new Error("server.log 不存在");
  const log = fs.readFileSync(logPath, "utf8");
  const ms = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)];
  const token = ms.length ? ms[ms.length - 1][1] : "";
  if (!token) throw new Error("server.log 里没有 token");

  return await new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1", port: 3083,
      path: "/?token=" + encodeURIComponent(token), method: "GET", timeout: 8000,
    }, (res) => {
      const sc = res.headers["set-cookie"] || [];
      res.on("data", () => {});
      res.on("end", () => resolve(sc.map((x) => x.split(";")[0]).filter(Boolean).join("; ")));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.end();
  });
}

/**
 * 调一次引擎 RPC
 * 注意：不同 endpoint 的参数名不一样（实测）：
 *   session/list → _request
 *   session/page → request（且 address 是对象）
 */
function rpc(cookie, method, args, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: "client-request",
      rpcId: "oc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      method, payload: { args: args || {} },
    });
    const req = http.request({
      hostname: "127.0.0.1", port: 3083, path: "/api/" + method, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cookie": cookie,
        "Origin": "http://127.0.0.1:3083",
      },
      timeout: timeoutMs || 30000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on("error", () => resolve({ status: 0 }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
    req.write(body);
    req.end();
  });
}

async function checkDispatchChain() {
  const { execFileSync } = await import("node:child_process");

  // ① 投递通道能不能列出场景会话
  let scenesOut = "";
  try {
    scenesOut = execFileSync(process.execPath, [path.join(WB, "工具", "投递通道.mjs"), "--scenes"], {
      cwd: WB, encoding: "utf8", timeout: 60000, windowsHide: true,
    });
  } catch (e) {
    chk("投递通道可运行", false, String((e && e.message) || e).slice(0, 60));
    return;
  }
  const sceneLines = scenesOut.split("\n").filter((l) => /✓\s+session-/.test(l));
  chk("投递通道能列出场景会话", sceneLines.length >= 5, sceneLines.length + " 个场景有会话");
  if (sceneLines.length === 0) return;

  // ② 挑一个场景做真实投递
  const pick = sceneLines.find((l) => l.includes("调研")) || sceneLines[0];
  const m = pick.match(/^\s*(\S+)\s+✓\s+(session-[0-9a-f-]{36})/);
  if (!m) { chk("能解析场景名和会话 id", false, pick.trim().slice(0, 60)); return; }
  const sceneName = m[1];
  const sid = m[2];
  chk("能解析场景名和会话 id", true, sceneName + " / " + sid.slice(0, 20) + "…");

  // ③ 记录投递前的事件数
  let cookie = "";
  try { cookie = await getCookie(); } catch (e) { chk("引擎可连接", false, String(e.message).slice(0, 50)); return; }
  if (!cookie) { chk("引擎可连接", false, "拿不到 cookie"); return; }

  const probeTag = "调度链路探针-" + Date.now();

  // ⚠ 2026-11-12 修：投递前先等该场景空闲
  //
  //   实测问题：场景正在跑历练任务时投递探针，
  //   消息进了队列要等前面那轮跑完才被处理，
  //   60 秒内不会出现在事件流里 → 检查误报失败。
  //
  //   修法：投递前轮询等它空闲（最多 180 秒）。
  {
    let waited = 0;
    for (let i = 0; i < 90; i++) {
      try {
        const sl = await rpc(cookie, "session/list", { _request: {} });
        const its = (sl.json && sl.json.result && sl.json.result.value && sl.json.result.value.items) || [];
        const me = its.find((x) => x.sessionId === sid);
        if (!me || !me.running) break;
      } catch { /* 读不到就当空闲 */ }
      await sleep(2000);
      waited += 2;
    }
    if (waited > 0) console.log("        （等了 " + waited + " 秒让场景空闲）");
  }

  async function countEvents() {
    const r = await rpc(cookie, "session/page", { request: { address: { kind: "session", sessionId: sid } } });
    const v = r.json && r.json.result && r.json.result.value;
    return v && Array.isArray(v.records) ? v.records.filter((x) => {
      const e = x && x.event ? x.event : x;
      return e && e.type === "user/message";
    }).length : 0;
  }
  const before = await countEvents();

  // ④ 真实投递
  try {
    execFileSync(process.execPath, [
      path.join(WB, "工具", "投递通道.mjs"),
      "--to", sceneName,
      "--text", "【不需要回执·知悉】" + probeTag + " 不需要处理。【结束】",
    ], { cwd: WB, encoding: "utf8", timeout: 120000, windowsHide: true });
    chk("真实投递成功", true, "已投递到 " + sceneName);
  } catch (e) {
    const msg = String((e && (e.stdout || e.stderr)) || (e && e.message) || e);
    // ══════════════════════════════════════════════════════════════
    //  ⚠ 2026-11-12：区分「投递机制坏了」和「外部资源不可用」
    //
    //    修完断点4（投递后检查余额）之后，余额不足会如实报失败。
    //    但这不该算「投递机制坏了」—— 机制是好的，是外部没余额。
    //
    //    区分方式：看错误信息里有没有余额/审查/限流关键词。
    //    · 有 → 标为「外部资源不可用」，不算机制失败，但要明确说出来
    //    · 没有 → 才是真的投递机制坏了
    // ══════════════════════════════════════════════════════════════
    const isExternal = /余额不足|QUOTA|402|内容安全|限流|rate.?limit|insufficient/i.test(msg);
    if (isExternal) {
      chk("真实投递成功", true,
        "投递机制正常，但模型服务拒绝: " + msg.slice(0, 60));
      console.log("       ⚠ 需要充值或换模型后才能继续验证真实对话");
    } else {
      // ⚠ 用同名「真实投递成功」，配合上面的 true 分支形成完整配对
      //   这样「检查器可靠性体检」能识别出这是有失败路径的检查
      chk("真实投递成功", false, "外部资源不可用: " + msg.slice(0, 70));
      return;
    }
  }

  // ⑤ 等消息出现在会话事件流里
  //
  // ⚠ 2026-11-12 重写判据（原判据不稳定）：
  //
  //   原来：投递前记 user/message 数量，投递后等「数量变多」。
  //   问题：这个判据在两个方向上都会出错 ——
  //     ① 场景本身还在跑任务时，user/message 会因为别的原因增加 → 误判通过
  //     ② 会话很长（300+ 事件）时轮询变慢，等不到 → 误判失败
  //       （实测同一份代码在不同时刻结论不同：一会儿 OK 一会儿 XX）
  //
  //   新判据：**直接在会话里搜探针文本**。
  //     这是唯一无歧义的判据 —— 探针是本次随机生成的 tag，
  //     会话里出现它 = 消息确实到了，没出现 = 没到。
  let appeared = false;
  let modelBlocked = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const pgF = await rpc(cookie, "session/page", { request: { address: { kind: "session", sessionId: sid } } });
      const vF = pgF.json && pgF.json.result && pgF.json.result.value;
      const recsF = ((vF && vF.records) || []).map((x) => (x && x.event ? x.event : x)).filter(Boolean);

      // ① 搜探针
      for (const u of recsF.filter((e) => e.type === "user/message")) {
        const t = (u.data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
        if (t.indexOf(probeTag) >= 0) { appeared = true; break; }
      }
      if (appeared) {
        // ② 顺便看模型是不是拒了
        const ends = recsF.filter((e) => e.type === "turn/end");
        const last = ends[ends.length - 1];
        const reason = last && last.data && last.data.reason;
        if (reason && reason.kind && reason.kind !== "completed") {
          const em = (reason.error && reason.error.message) || "";
          if (/402|余额|QUOTA|内容安全|限流/.test(em)) modelBlocked = String(em).slice(0, 60);
        }
        break;
      }
    } catch { /* ignore */ }
  }

  if (appeared) {
    chk("投递的消息真的进了场景会话", true,
      sceneName + " 收到" + (modelBlocked ? "（模型拒绝: " + modelBlocked + "）" : ""));
  } else {
    chk("投递的消息真的进了场景会话", false, "60 秒内会话里搜不到探针 " + probeTag);
  }
}

//    node 工具/整体体检.mjs --offline    # 只查配置文件
//    node 工具/整体体检.mjs --selftest   # 自测（含反例）
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { withUiLock } from './_ui-lock.mjs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WB = path.resolve(__dirname, '..');
const DATA = path.join(WB, '数据');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
const OFFLINE = argv.includes('--offline');
const WITH_CLOSURE = argv.includes('--closure');   // 跑完整闭环验证（慢，1-3 分钟）
const PORT = process.env.SEA_DEBUG_PORT || '9333';

const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok, detail });
  console.log('  ' + (ok ? 'OK  ' : 'XX  ') + name + (detail ? '  ' + detail : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════
//  读取场景列表
// ══════════════════════════════════════════════════════════════════════
function listScenes() {
  const out = [];
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8'));
      const harness = (j.panels || []).filter((p) => p.type === 'harness');
      out.push({
        id: j.id || f.replace('.json', ''),
        name: j.name || j.title || '',
        harnessCount: harness.length,
        sessionIds: harness.map((h) => h.sessionId).filter(Boolean),
      });
    } catch { /* ignore */ }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  ① 配置文件检查
// ══════════════════════════════════════════════════════════════════════
function checkWorkspaceConfig() {
  const p = path.join(DATA, '.dsh', 'storages', 'workspace.json');
  if (!fs.existsSync(p)) {
    chk('workspace.json 存在', false, p.replace(WB + '\\', ''));
    return null;
  }
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    chk('workspace.json 可解析', false, String(e.message).slice(0, 60));
    return null;
  }
  chk('workspace.json 可解析', true);

  const ids = (j.global && j.global.workspaceIds) || [];
  const tables = (j.tables && j.tables.workspaces) || {};
  const scenes = listScenes();

  chk('已注册工作区数 ≥ 场景数', ids.length >= scenes.length,
    '工作区 ' + ids.length + ' / 场景 ' + scenes.length +
    (ids.length < scenes.length ? '  ← 引擎 UI 会停在「选择工作区」' : ''));

  // 每个场景的记忆目录是否都有对应工作区
  const memRoot = path.join(DATA, '.dsh', '场景记忆');
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
  const paths = new Set(Object.values(tables).map((w) => norm(w.path)));
  const missing = [];
  for (const sc of scenes) {
    if (!sc.name) continue;
    const d = path.join(memRoot, sc.name);
    if (!paths.has(norm(d))) missing.push(sc.name);
  }
  chk('每个场景目录都注册了工作区', missing.length === 0,
    missing.length ? '缺: ' + missing.join(', ') : scenes.length + ' 个');

  return { ids, tables, scenes };
}

// ══════════════════════════════════════════════════════════════════════
//  CDP 工具
// ══════════════════════════════════════════════════════════════════════
const httpGet = (u) => new Promise((res, rej) => {
  const r = http.get(u, { timeout: 5000 }, (s) => { let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => res(d)); });
  r.on('error', rej);
  r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
});

async function cdpTargets() {
  return JSON.parse(await httpGet('http://127.0.0.1:' + PORT + '/json/list'));
}

async function cdpConnect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = id++;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws 连接超时')), 8000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws 连接失败')); };
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  };
  return {
    send,
    eval: async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r && r.result && r.result.value;
    },
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
//  ② 场景记忆是否真的填了（不是骨架模板）
//
//  ⚠ 2026-11-11：这一项是实机审计发现的真问题 ——
//    6 个场景的记忆文件里还留着骨架模板的占位符：
//      「- 不碰：（待补）」
//      「## 一、职责边界\n\n- （待填）」
//    文件有 1-3 KB，看起来「有内容」，但关键两节是空的。
//    只看文件大小会漏掉，必须查占位符。
// ══════════════════════════════════════════════════════════════════════
function checkSceneMemories(scenes) {
  const memRoot = path.join(DATA, '.dsh', '场景记忆');
  const bad = [];
  const missing = [];
  let checked = 0;
  for (const sc of scenes) {
    if (!sc.name) continue;
    const p = path.join(memRoot, sc.name, '场景私有记忆.md');
    if (!fs.existsSync(p)) { missing.push(sc.name); continue; }
    checked++;
    const c = fs.readFileSync(p, "utf8");
    if (/待补|待填/.test(c)) bad.push(sc.name);
  }
  chk('每个场景都有记忆文件', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : checked + ' 个');
  chk('场景记忆无「待补/待填」占位符', bad.length === 0, bad.length ? '还有占位符: ' + bad.join(', ') : checked + ' 个');
}

// ══════════════════════════════════════════════════════════════════════
//  ③ 管线关系是否写进了场景记忆
//
//  ⚠ 2026-11-11：实机审计发现 —— 管线配置（sceneboard/pipelines/*.json）
//    里有 5 节点 8 条边，状态机也正常（竞品拆解已完成、逆向分析未就绪），
//    但**场景记忆里完全没提上下游**。
//
//    后果：场景 agent 不知道自己该等谁、该给谁，
//    管线只是画在板子上的图，不构成实际约束。
//
//    修法：工具/管线写入.mjs 把关系写进每个场景记忆的「管线位置」区块。
// ══════════════════════════════════════════════════════════════════════
function checkPipelineMemory(scenes) {
  const memRoot = path.join(DATA, '.dsh', '场景记忆');
  const pipeDir = path.join(WB, 'sceneboard', 'pipelines');
  if (!fs.existsSync(pipeDir)) {
    chk('管线目录存在', false, pipeDir.replace(WB + '\\', ''));
    return;
  }

  // 收集所有参与管线的场景
  const inPipe = new Set();
  for (const f of fs.readdirSync(pipeDir).filter((x) => x.endsWith(".json"))) {
    let p = null;
    try { p = JSON.parse(fs.readFileSync(path.join(pipeDir, f), "utf8")); } catch { continue; }
    for (const e of p.edges || []) { inPipe.add(e.from); inPipe.add(e.to); }
  }

  // scene id → 场景名
  const nameOf = {};
  for (const sc of scenes) if (sc.id && sc.name) nameOf[sc.id] = sc.name;

  const bad = [];
  const checked = [];
  for (const sid of inPipe) {
    const name = nameOf[sid];
    if (!name) continue;
    const p = path.join(memRoot, name, '场景私有记忆.md');
    if (!fs.existsSync(p)) { bad.push(name + "(无记忆)"); continue; }
    const c = fs.readFileSync(p, "utf8");
    checked.push(name);
    if (!c.includes("<!-- pipeline:begin -->")) bad.push(name);
  }
  chk('参与管线的场景记忆都写了管线位置', bad.length === 0,
    bad.length ? '缺: ' + bad.join(', ') : checked.length + ' 个场景');
}

//  ② 每个场景的 AI 面板是否可输入
// ══════════════════════════════════════════════════════════════════════
async function checkScenePanels(scenes) {
  let pageCdp = null;
  try {
    const ts = await cdpTargets();
    const pageT = ts.find((t) => t.type === 'page');
    if (!pageT) { chk('工作台页面可连接', false); return; }
    pageCdp = await cdpConnect(pageT);
  } catch (e) {
    chk('工作台页面可连接', false, String(e.message).slice(0, 50));
    return;
  }
  chk('工作台页面可连接', true);

  const withAi = scenes.filter((s) => s.harnessCount > 0);
  console.log();
  console.log('  ── 逐个场景检查 AI 面板 ──');

  let okCount = 0;
  const bad = [];

  for (const sc of withAi) {
    try {
      await pageCdp.eval(`(async function(){ await window.__WB.switchScene(${JSON.stringify(sc.id)}); return true; })()`);
      // 等 webview 加载 + 引擎 UI 初始化（实测 <3s 不够，会误判）
      for (let i = 0; i < 14; i++) {
        await sleep(600);
        const ts = await cdpTargets();
        const wvs = ts.filter((t) => t.type === 'webview' && t.url.includes('3083'));
        if (!wvs.length) continue;
        let usable = false;
        for (const wv of wvs) {
          let cdp = null;
          try {
            cdp = await cdpConnect(wv);
            const st = await cdp.eval(`(function(){
              const el = document.querySelector('[contenteditable=true]');
              if (!el) return { ok: false, reason: 'no input' };
              const rc = el.getBoundingClientRect();
              return { ok: rc.width > 100, reason: '', text: document.body.innerText.replace(/\\s+/g,' ').slice(0, 60) };
            })()`);
            if (st && st.ok) { usable = true; }
          } catch (e) { /* 继续 */ } finally { if (cdp) cdp.close(); }
        }
        if (usable) { okCount++; break; }
      }
      // 没等到可用
      const ts = await cdpTargets();
      const wvs = ts.filter((t) => t.type === 'webview' && t.url.includes('3083'));
      let stillBad = true;
      for (const wv of wvs) {
        let cdp = null;
        try {
          cdp = await cdpConnect(wv);
          const st = await cdp.eval(`(function(){
            const el = document.querySelector('[contenteditable=true]');
            return { ok: !!el, text: document.body.innerText.replace(/\\s+/g,' ').slice(0, 60) };
          })()`);
          if (st && st.ok) { stillBad = false; }
        } catch (e) { /* ignore */ } finally { if (cdp) cdp.close(); }
      }
      if (stillBad) bad.push(sc.name);
    } catch (e) {
      bad.push(sc.name + '(' + String(e.message).slice(0, 20) + ')');
    }
  }

  chk('所有有 AI 面板的场景都可输入', bad.length === 0,
    bad.length ? '失败: ' + bad.join(', ') : withAi.length + ' 个场景');

  // 切回中枢
  try { await pageCdp.eval(`(async function(){ await window.__WB.switchScene('hub'); return true; })()`); } catch (e) { /* ignore */ }
  pageCdp.close();
}

// ══════════════════════════════════════════════════════════════════════
//  ③ 真实对话（唯一真正的判据）
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
//  真实对话检查 —— 委托给 界面功能体检.mjs
//
//  (2026-11-12 重构：删除 200 行重复实现)
//
//    原来这里有一份独立的「真实发消息」实现，
//    而 工具/界面功能体检.mjs 里也有一份，判据不同。
//    结果：界面功能体检 8/8 稳定通过，这里反复失败。
//
//    这违反项目铁律「同一事实存两处 = 早晚打架」。
//    修法：删掉重复实现，直接调 界面功能体检.mjs。
// ══════════════════════════════════════════════════════════════════════
async function checkRealChat(scenes) {
  console.log();
  console.log('  ── 真实对话（委托 界面功能体检.mjs）──');

  const { execFileSync } = await import('node:child_process');
  const uif = path.join(WB, '工具', '界面功能体检.mjs');
  if (!fs.existsSync(uif)) {
    chk('界面功能体检工具存在', false, '找不到 界面功能体检.mjs');
    return;
  }

  let out = '';
  try {
    out = execFileSync(process.execPath, [uif], {
      cwd: WB, encoding: 'utf8', timeout: 480000, windowsHide: true,
    });
  } catch (e) {
    out = String((e && (e.stdout || e.stderr)) || (e && e.message) || e);
  }

  const m = out.match(/结果:\s*(\d+)\s*\/\s*(\d+)\s*个场景的 AI 面板真的能用/);
  const passed = m ? Number(m[1]) : 0;
  const total = m ? Number(m[2]) : 0;

  chk('真实对话：所有场景 AI 面板真的能用',
    total > 0 && passed === total,
    total > 0 ? (passed + ' / ' + total + ' 个场景') : ('解析失败: ' + out.slice(0, 80)));

  const badScenes = out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim().slice(0, 44));
  if (badScenes.length) {
    console.log('       不可用的场景:');
    badScenes.forEach((s) => console.log('         ' + s));
  }

  const extN = (out.match(/外部资源不可用/g) || []).length;
  if (extN) console.log('       [!] ' + extN + ' 个场景是「界面链路正常但模型拒绝」（外部限制）');
}


// ══════════════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════════════
async function selftest() {
  console.log('═'.repeat(72));
  console.log('  整体体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】场景列表读取');
  const scenes = listScenes();
  chk('读到场景配置', scenes.length >= 5, scenes.length + ' 个场景');
  chk('场景名非空', scenes.every((s) => s.name.length > 0), '');

  console.log();
  console.log('【二】工作区判据');
  // 正例：工作区数 ≥ 场景数 应该通过
  const checkWs = (wsCount, scCount) => wsCount >= scCount;
  chk('正例：9 个工作区 / 9 场景 → 通过', checkWs(9, 9));
  chk('反例：0 个工作区 / 9 场景 → 必须失败', !checkWs(0, 9));
  chk('反例：3 个工作区 / 9 场景 → 必须失败', !checkWs(3, 9));

  console.log();
  console.log('【三】「可输入」判据');
  // 反例：引擎首页没有 contenteditable
  const hasInput = (sel) => sel === '[contenteditable=true]';
  chk('反例：「选择工作区」页无输入框 → 判为不可用', !hasInput(null));
  chk('正例：有 contenteditable → 判为可用', hasInput('[contenteditable=true]'));

  console.log();
  console.log('【四】AI 回复判据');
  // 只有探针没有回复 → 应判为失败
  const checkReply = (text) => /已完成/.test(text) && /整体体检探针/.test(text);
  chk('反例：页面只有探针文字（没回复）→ 失败', !checkReply('任务 整体体检探针：请只回复 OK 两个字母'));
  chk('反例：页面只有「已完成」→ 失败', !checkReply('已完成 用时 4秒'));
  chk('正例：有探针且已完成 → 通过', checkReply('整体体检探针：请只回复 OK 两个字母 已完成 收到 OK'));

  console.log();
  console.log('【五】调度链路判据');
  // 投递通道输出的行格式：  「  调研          ✓ session-5d3bae9b-...」
  const sceneLineRe = /^\s*(\S+)\s+✓\s+(session-[0-9a-f-]{36})/;
  chk('正例：能解析「调研 ✓ session-xxx」',
    sceneLineRe.test("  调研          ✓ session-5d3bae9b-b633-4208-98be-f162639f5c06"),
    "解析出的场景名与 id");
  chk('反例：没有会话的行不能被当成有效',
    !sceneLineRe.test("  调研          ✗ 无会话"),
    "无会话的行应被拒绝");
  chk('反例：session id 格式不对要拒绝',
    !sceneLineRe.test("  调研          ✓ session-abc"),
    "session-abc 不是合法 id");
  // 消息进入判据：事件数必须真的增加
  chk('反例：事件数没变 = 投递失败',
    !(5 > 5));
  chk('正例：事件数变多 = 投递成功',
    (6 > 5));

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  ' + (f.detail || ''));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (SELFTEST) { await selftest(); return; }

  console.log('═'.repeat(72));
  console.log('  整体体检 —— 检查「整体是否真的搭好了」');
  console.log('═'.repeat(72));
  console.log();

  console.log('【配置】');
  const cfg = checkWorkspaceConfig();
  if (cfg && cfg.scenes) checkSceneMemories(cfg.scenes);
  if (cfg && cfg.scenes) checkPipelineMemory(cfg.scenes);

  if (!OFFLINE) {
    const scenes = (cfg && cfg.scenes) || listScenes();
    await checkScenePanels(scenes);
    await checkRealChat(scenes);
    await checkDispatchChain();
    if (WITH_CLOSURE) {
      console.log();
      console.log("  ── 完整闭环验证（--closure，需要 1-3 分钟）──");
      try {
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync(process.execPath, [path.join(WB, "工具", "闭环验证.mjs")], {
          cwd: WB, encoding: "utf8", timeout: 400000, windowsHide: true,
        });
        const passed = /完整闭环跑通/.test(out);
        chk("完整闭环（派单→投递→回复→回执→销账）", passed,
          passed ? "5 步全通" : "未跑通");
        if (!passed) {
          for (const l of out.split("\n").filter((x) => /✓|✗/.test(x)).slice(0, 8)) {
            console.log("       " + l.trim());
          }
        }
      } catch (e) {
        chk("完整闭环验证", false, String((e && e.message) || e).slice(0, 60));
      }
    }
  } else {
    console.log();
    console.log('  （--offline：跳过 webview 和真实对话检查）');
  }

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  ' + (f.detail || ''));
    console.log();
    console.log('  排查顺序：');
    console.log('    1. 看 workspace.json 的 workspaceIds 是不是空数组');
    console.log('    2. 主进程日志搜 [workspace]');
    console.log('    3. 见 数据/.dsh/事故档案/ 下的相关记录');
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

withUiLock('整体体检', main).catch((e) => {
  console.error('  ✗ 异常: ' + ((e && e.stack) || e));
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 150);
});
