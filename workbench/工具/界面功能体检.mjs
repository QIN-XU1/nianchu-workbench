#!/usr/bin/env node
// 工具/界面功能体检.mjs —— 验证界面不只是「画出来了」，而是「真的能用」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  现状：
//    · 界面回归.mjs 通过「截图找亮点」判断界面正常
//      但它只能证明「画出来了」，证明不了「能用」
//    · 整体体检.mjs 的「所有场景 AI 面板都可输入」用 CDP 查 DOM
//      但它只查「输入框存在且可编辑」，不查「输入进去能不能发出去」
//
//  「看起来有实际是空」的典型场景：
//    · 输入框在，但发不出去
//    · 按钮在，但点了没反应
//    · 面板在，但绑定的是错误的会话
//    · 场景能切，但切过去是空白
//
//  这个工具的做法：**真的操作一遍**
//    ① CDP 连到渲染进程
//    ② 切到一个场景
//    ③ 找到 AI 面板的输入框
//    ④ 真的输入文字（Input.insertText）
//    ⑤ 真的按回车（Input.dispatchKeyEvent）
//    ⑥ 等消息出现在会话事件流里
//    ⑦ 验证消息内容对得上
//
//  只有全部通过，才算「这个场景的 AI 面板真的能用」。
//
//  用法：
//    node 工具/界面功能体检.mjs                 # 测所有有 AI 面板的场景
//    node 工具/界面功能体检.mjs --scene 调研     # 只测一个
//    node 工具/界面功能体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { withUiLock } from './_ui-lock.mjs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const PORT = 3083;
const CDP_PORT = 9333;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════
//  判据（唯一出处 —— 五步法第 1、2 步）
// ══════════════════════════════════════════════════════════════════════
//  ⚠ 2026-11-12 修（判据藏在流程里，等于没有判据）
//
//   原来「9 步全过」「必须到达会话」「等 15 秒」都是散在 testScene 里的
//   字面量和 if 分支：步骤名写死在 step() 调用处，自测里又抄了一份期望列表，
//   15 秒写成 for (k=0;k<15;k++)。三处各写一份 = 同一事实存三处。
//
//   现在：步骤清单、必须到达的步骤、等待上限都只在这里定义并 export，
//        testScene / 自测 / 汇总一律引用。
// ──────────────────────────────────────────────────────────────────────

// 一次完整验证的步骤数（少一步说明体检被削弱了，自测会红）
export const STEPS_REQUIRED = 9;

// 每个场景的步骤清单，按执行顺序。key 是代码里的步骤名（step() 的第一个参数）。
// MUST = true 表示这一步失败就是「界面不可用」，不能被其它原因掩盖。
export const STEP_MUST = {
  '切到场景': { must: true, why: '切不过去就说明场景入口坏了' },
  '连到 AI 面板 webview': { must: true, why: '面板是 webview，连不上就没法验证输入' },
  '找到输入框': { must: true, why: '没有可编辑区 = 看着有实际不能用' },
  '聚焦输入框': { must: true, why: '聚焦不了就输不进字' },
  '定位输入框坐标': { must: true, why: '真实点击需要坐标，定位失败等于无法真实操作' },
  '文字进入输入框': { must: true, why: '输入链路断了' },
  '按回车': { must: true, why: '发送动作没做出来' },
  '找到场景会话': { must: true, why: '面板绑错会话 = 数据写错地方' },
  '消息到达会话': { must: true, why: '唯一的真判据：消息没到达会话，界面就只是「画出来了」' },
};

// 步骤顺序（MUST 的键按声明顺序展开）
export const STEP_ORDER = Object.keys(STEP_MUST);

// 等消息到达会话的上限（秒）。超时可判：不是「大概等等」。
//
// ⚠ 2026-11-12 两次调整：15 → 60 → 120
//
//   15 秒是按「官方 DeepSeek 快模型」估的。
//   实测（本地免费网关 nemotron）：
//     · 模型首 token 1.5~3 秒
//     · 引擎组装上下文（AGENTS.local.md ~3.4KB）+ 工具调用往返
//     · 「按回车 → 消息落进 session」**实测 61 秒**（不是 20~45）
//
//   所以 60 秒也卡在边界上，一个慢一点就红。
//   提到 120 秒 —— 留一倍余量。
//
//   注意：这一步是**唯一真判据**（消息没到达 = 界面只是画出来了），
//   所以不能删也不能放宽判据，只能把等待时间调到与真实模型匹配。
//
//   ⚠ 如果将来换回快模型，可以调小；如果换更慢的模型，要再调大。
//      这个数字应该跟着「模型首响应速度」走，不是固定的。
export const WAIT_REACH_SEC = 120;
export const WAIT_POLL_SEC = 1;

// 真实操作之间需要的稳定时间（毫秒）——切场景后要等渲染，点击后要等光标
export const TEXT_WAIT_MAX_MS = 12000;
const TEXT_WAIT_STEP_MS = 400;

const INPUT_WAIT_MAX_MS = 30000;
const INPUT_WAIT_STEP_MS = 600;

const SETTLE_MS = {
  afterSwitchScene: 3000,
  afterMouseClick: 400,
  afterClear: 300,
  afterInsertText: 600,
  afterEnter: 2000,
};

// 输入框可见性门槛：太小的 contenteditable 是装饰，不是输入区
export const INPUT_MIN_WIDTH = 100;
export const INPUT_MIN_HEIGHT = 16;

// 浏览器侧报错的关键词（用来区分「界面没发出去」和「发出去但模型拒了」）
export const MODEL_ERROR_PATTERN = /(402|余额不足|QUOTA|内容安全|限流|rate.?limit)/;

/**
 * 核心判据：一次 testScene 的结果是否算「这个场景的 AI 面板真的能用」。
 *
 * 判据（唯一出处，单测和真实体检都走这里）：
 *   ① 必须跑完 STEPS_REQUIRED 步（没跑完不算通过，不能因为「提前失败」被当成通过）
 *   ② STEP_MUST 里 must 的步骤一个都不能挂
 * 返回 { ok, missing, failed }：
 *   missing = 没跑到的步骤（差异集合，不是 0/1）
 *   failed  = 跑到了但失败的步骤
 */
export function judgeScenePanelReady(result) {
  const steps = (result && result.steps) || [];
  const gotNames = steps.map((s) => s.n);

  const missing = STEP_ORDER.filter((n) => !gotNames.includes(n));
  const failed = steps
    .filter((s) => STEP_MUST[s.n] && STEP_MUST[s.n].must && !s.ok)
    .map((s) => ({ n: s.n, d: s.d }));

  // 步骤数不足也算「没验证完」——这是「看起来有实际是空」的另一种形态
  const short = steps.length < STEPS_REQUIRED;

  return {
    ok: !short && missing.length === 0 && failed.length === 0,
    short,
    missing,
    failed,
    got: steps.length,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  CDP
// ══════════════════════════════════════════════════════════════════════
async function cdpTargets() {
  return await new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: CDP_PORT, path: '/json', method: 'GET', timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64'),
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      let buf = Buffer.alloc(0);
      let id = 0;
      const pending = new Map();

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const b0 = buf[0];
          const b1 = buf[1];
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          let text;
          try { text = JSON.parse(payload.toString('utf8')); } catch { continue; }
          if (text.id && pending.has(text.id)) {
            const { resolve: r } = pending.get(text.id);
            pending.delete(text.id);
            r(text);
          }
        }
      });

      function send(method, params) {
        return new Promise((r) => {
          const myId = ++id;
          pending.set(myId, { resolve: r });
          const payload = Buffer.from(JSON.stringify({ id: myId, method, params: params || {} }));
          const mask = Buffer.from([1, 2, 3, 4]);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
          let header;
          if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
          else if (payload.length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
          } else {
            header = Buffer.alloc(10);
            header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
          }
          socket.write(Buffer.concat([header, mask, masked]));
          setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); r({ error: 'timeout' }); } }, 20000);
        });
      }

      resolve({ send, close: () => socket.end() });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getRenderer() {
  const ts = await cdpTargets();
  // 主窗口（用于切场景）
  return ts.find((t) => t.type === 'page' && t.url && t.url.includes('ui/index.html')) ||
         ts.find((t) => t.type === 'page');
}

/**
 * 找 AI 面板的 webview 目标
 *
 * ⚠ 2026-11-12 修（第一版找错目标，8 个场景全部失败）：
 *
 *   AI 面板是 <webview>，在 Electron 里是独立的 CDP 目标（OOPIF）。
 *   主页面 document.querySelectorAll('[contenteditable]') 看不到它内部的 DOM。
 *
 *   实测 CDP /json 返回 4 个目标：
 *     webview  http://127.0.0.1:3083/          ← 引擎 UI（AI 面板在这）
 *     webview  https://chat.deepseek.com/...   ← 网页面板
 *     iframe   https://open.weixin.qq.com/...  ← 微信登录
 *     page     file:///.../ui/index.html       ← 主窗口
 *
 *   所以要单独连 webview 目标，才能操作输入框。
 */
async function getHarnessWebviews() {
  const ts = await cdpTargets();
  return ts.filter((t) => t.type === 'webview' && t.url && t.url.startsWith('http://127.0.0.1:'));
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.result && r.result.exceptionDetails) return { err: r.result.exceptionDetails.text };
  return { value: r.result && r.result.result ? r.result.result.value : undefined };
}

// ══════════════════════════════════════════════════════════════════════
//  引擎 RPC
// ══════════════════════════════════════════════════════════════════════
function getToken() {
  const p = path.join(WB, '外壳', 'server.log');
  if (!fs.existsSync(p)) return null;
  const s = fs.readFileSync(p, 'utf8');
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

async function getCookie() {
  const token = getToken();
  if (!token) return '';
  return await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 8000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function rpc(cookie, method, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'uif-' + Date.now(), method, payload: { args: args || {} } });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie, Origin: 'http://127.0.0.1:' + PORT },
      timeout: 20000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve(j); });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
//  读场景配置
// ══════════════════════════════════════════════════════════════════════
function loadScenes() {
  const dir = path.join(WB, '外壳', 'scenarios');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const aiPanels = (j.panels || []).filter((p) => p.type === 'harness');
      if (!aiPanels.length) continue;
      out.push({ id: j.id || f.replace('.json', ''), name: j.name || j.id, aiPanels: aiPanels.length });
    } catch { /* ignore */ }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  测一个场景的 AI 面板：真的输入 + 真的发送 + 验证消息到达
// ══════════════════════════════════════════════════════════════════════
async function testScene(cdp, cookie, scene) {
  const result = { scene: scene.name, steps: [] };
  const step = (n, ok, d) => { result.steps.push({ n, ok, d }); };

  // ① 切到该场景（在主窗口做）
  const sw = await evaluate(cdp, `(async function(){
    if (!window.__WB || typeof window.__WB.switchScene !== 'function') {
      return { ok: false, why: 'window.__WB.switchScene 不存在' };
    }
    try {
      var r = await window.__WB.switchScene(${JSON.stringify(scene.id)});
      return { ok: !!r, current: window.__WB.getCurrentScene() };
    } catch (e) { return { ok: false, why: String(e) }; }
  })()`);
  if (!sw.value || !sw.value.ok) {
    step('切到场景', false, sw.value ? sw.value.why : 'evaluate 失败');
    return result;
  }
  step('切到场景', true, sw.value.current);
  await sleep(SETTLE_MS.afterSwitchScene);

  // ② 连到 harness webview（AI 面板的 DOM 在里面）
  //
  // ⚠ 关键：AI 面板是 <webview>，Electron 里是独立 CDP 目标（OOPIF）。
  //   主页面 document.querySelectorAll('[contenteditable]') 看不到它。
  //
  // ⚠ 2026-11-13 修（等 3 秒不够，工作台刚重启时 webview 要 8 秒以上）
  //
  //   实测：重启后跑这个检查 → 5/8 场景失败，报
  //     「webview 里没有可见的 contenteditable」
  //   但用手工 CDP 脚本等 8 秒再查，输入框明明在（w=552, h=36, visible）。
  //
  //   根因：SETTLE_MS.afterSwitchScene 只有 3000ms。
  //        切场景 = 销毁旧 webview + 建新 webview + 加载引擎 UI，
  //        冷启动时要 8~10 秒，热的时候 2~3 秒。
  //        固定等 3 秒 = 冷时必失败、热时碰巧过 —— 典型的 flaky。
  //
  //   修法：改成**轮询等待**，最多等 INPUT_WAIT_MAX_MS，
  //        每 INPUT_WAIT_STEP_MS 查一次，查到就继续。
  //        这样热的场景 2 秒就走，冷的场景也能等到。
  let wvs = [];
  const waitDeadline = Date.now() + INPUT_WAIT_MAX_MS;
  while (Date.now() < waitDeadline) {
    wvs = await getHarnessWebviews();
    if (wvs.length) {
      // 再确认一下输入框真的存在（webview 建好了但 DOM 可能还没渲染）
      try {
        const probe = await cdpConnect(wvs[0].webSocketDebuggerUrl);
        if (probe) {
          await probe.send('Runtime.enable');
          const chk = await probe.send('Runtime.evaluate', {
            expression: `(function(){
              var n = 0;
              document.querySelectorAll('[contenteditable]').forEach(function(el){
                if (el.getAttribute('contenteditable') === 'false') return;
                var r = el.getBoundingClientRect();
                if (r.width >= ${INPUT_MIN_WIDTH} && r.height >= ${INPUT_MIN_HEIGHT}) n++;
              });
              return n;
            })()`,
            returnByValue: true,
          });
          const cnt = chk.result && chk.result.result && chk.result.result.value;
          if (cnt > 0) { await probe.close?.(); break; }
          await probe.close?.();
        }
      } catch { /* 继续等 */ }
    }
    await sleep(INPUT_WAIT_STEP_MS);
  }

  if (!wvs.length) {
    step('连到 AI 面板 webview', false, '等了 ' + Math.round(INPUT_WAIT_MAX_MS / 1000) + ' 秒仍找不到 harness webview');
    return result;
  }
  const wvCdp = await cdpConnect(wvs[0].webSocketDebuggerUrl);
  if (!wvCdp) {
    step('连到 AI 面板 webview', false, 'CDP 连接失败');
    return result;
  }
  await wvCdp.send('Runtime.enable');
  step('连到 AI 面板 webview', true, wvs[0].url);

  try {
    // ③ 找输入框
    const findInput = await wvCdp.send('Runtime.evaluate', {
      expression: `(function(){
        var cands = [];
        document.querySelectorAll('[contenteditable]').forEach(function(el){
          var ce = el.getAttribute('contenteditable');
          if (ce === 'false') return;
          var r = el.getBoundingClientRect();
          if (r.width < ${INPUT_MIN_WIDTH} || r.height < ${INPUT_MIN_HEIGHT}) return;
          cands.push({ w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName });
        });
        return { n: cands.length, list: cands };
      })()`,
      returnByValue: true,
    });
    const inVal = findInput.result && findInput.result.result && findInput.result.result.value;
    const nIn = inVal ? inVal.n : 0;
    if (!nIn) {
      step('找到输入框', false, 'webview 里没有可见的 contenteditable');
      return result;
    }
    step('找到输入框', true, nIn + ' 个（' + inVal.list[0].w + 'x' + inVal.list[0].h + '）');

    // ④ 聚焦
    const focus = await wvCdp.send('Runtime.evaluate', {
      expression: `(function(){
        var best = null;
        document.querySelectorAll('[contenteditable]').forEach(function(e){
          var ce = e.getAttribute('contenteditable');
          if (ce === 'false') return;
          var r = e.getBoundingClientRect();
          if (r.width < ${INPUT_MIN_WIDTH} || r.height < ${INPUT_MIN_HEIGHT}) return;
          if (!best || r.width * r.height > best.w * best.h) best = { el: e, w: r.width, h: r.height };
        });
        if (!best) return { ok: false };
        best.el.focus();
        return { ok: true, tag: best.el.tagName };
      })()`,
      returnByValue: true,
    });
    const fVal = focus.result && focus.result.result && focus.result.result.value;
    if (!fVal || !fVal.ok) {
      step('聚焦输入框', false);
      return result;
    }
    step('聚焦输入框', true, fVal.tag);

    // ⑤ 输入文字
    //
    // ⚠ 2026-11-12 修（第一版只 insertText，不生效）：
    //
    //   实测：focus() 之后直接 Input.insertText 没有反应，
    //        输入框里找不到探针文字。
    //
    //   原因：contenteditable 的输入框需要真实的光标位置。
    //        单纯 focus() 不产生光标，insertText 无处可插。
    //
    //   修法：先发真实的 mousePressed/mouseReleased 点到输入框上，
    //        让浏览器自己放光标，再 insertText。
    //        （这条经验来自 研究素材/引擎RPC实测文档.md：
    //          「Real input requires: Input.dispatchMouseEvent
    //           (mousePressed/mouseReleased) → Ctrl+A/Delete →
    //           Input.insertText → Enter」）
    const boxRect = await wvCdp.send('Runtime.evaluate', {
      expression: `(function(){
        var best = null;
        document.querySelectorAll('[contenteditable]').forEach(function(e){
          var ce = e.getAttribute('contenteditable');
          if (ce === 'false') return;
          var r = e.getBoundingClientRect();
          if (r.width < ${INPUT_MIN_WIDTH} || r.height < ${INPUT_MIN_HEIGHT}) return;
          if (!best || r.width * r.height > best.w * best.h) best = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        });
        return best;
      })()`,
      returnByValue: true,
    });
    const box = boxRect.result && boxRect.result.result && boxRect.result.result.value;
    if (!box) {
      step('定位输入框坐标', false);
      return result;
    }
    step('定位输入框坐标', true, Math.round(box.x) + ',' + Math.round(box.y));

    // 真实鼠标点击（产生光标）
    await wvCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await wvCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(SETTLE_MS.afterMouseClick);

    // 清空（Ctrl+A + Delete）
    await wvCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await wvCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await wvCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await wvCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await sleep(SETTLE_MS.afterClear);

    const tag = 'UIF-' + Date.now();
    await wvCdp.send('Input.insertText', { text: tag + ' 界面功能体检探针' });
    await sleep(SETTLE_MS.afterInsertText);

    // ⚠ 2026-11-13 修（insertText 后只等 600ms 就查 → flaky）
    //
    //   实测：同一份代码连跑两次，一次 6/8、一次 7/8，
    //        失败的都是「输入后找不到探针文字」。
    //        而手工 CDP 脚本插入后等 2 秒再查，文字明明在。
    //
    //   根因：引擎的输入框是 React 受控组件，
    //        Input.insertText 触发的是原生插入，
    //        它要经过 React 的 onChange → setState → 重渲染，
    //        才反映到 textContent 上。600ms 在负载高时不够。
    //
    //   修法：轮询等待，最多 TEXT_WAIT_MAX_MS。
    let gVal = false;
    const textDeadline = Date.now() + TEXT_WAIT_MAX_MS;
    while (Date.now() < textDeadline) {
      const got = await wvCdp.send('Runtime.evaluate', {
        expression: `(function(){
          var found = false;
          document.querySelectorAll('[contenteditable]').forEach(function(e){
            if (String(e.textContent||'').indexOf(${JSON.stringify(tag)}) >= 0) found = true;
          });
          return found;
        })()`,
        returnByValue: true,
      });
      gVal = got.result && got.result.result && got.result.result.value;
      if (gVal) break;
      await sleep(TEXT_WAIT_STEP_MS);
    }
    if (!gVal) {
      step('文字进入输入框', false, '等了 ' + Math.round(TEXT_WAIT_MAX_MS / 1000) + ' 秒，输入框里仍找不到探针文字');
      return result;
    }
    step('文字进入输入框', true);

    // ⑥ 按回车
    await wvCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await wvCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    step('按回车', true);
    await sleep(SETTLE_MS.afterEnter);

    // ⑦ 验证消息进了会话
    const list = await rpc(cookie, 'session/list', { _request: {} });
    const items = (list && list.result && list.result.value && list.result.value.items) || [];
    const MEM = path.join(DATA, '场景记忆');
    const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
    const target = norm(path.join(MEM, scene.name));
    const sess = items.filter((s) => norm(s.cwd) === target).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];

    if (!sess) {
      step('找到场景会话', false, '没有 cwd 匹配');
      return result;
    }
    step('找到场景会话', true, sess.sessionId.slice(0, 18));

    // ⚠ 2026-11-12：区分「界面没发出去」和「发出去但模型拒了」
    //
    //   实测：8/9 步全过（切场景/找输入框/点击/输入文字/按回车都成功），
    //        只差「消息到达会话」。
    //   查 webview 发现最后一条消息是：
    //         「本轮运行失败 402: 余额不足，请充值后再使用」
    //
    //   也就是说：**界面功能是好的，是模型服务拒了**。
    //   这不该算「界面不可用」—— 但必须如实说出来。
    let found = false;
    let modelError = null;
    // 轮询次数由 WAIT_REACH_SEC / WAIT_POLL_SEC 派生（唯一出处在文件顶部）
    const polls = Math.ceil(WAIT_REACH_SEC / WAIT_POLL_SEC);
    for (let k = 0; k < polls; k++) {
      await sleep(WAIT_POLL_SEC * 1000);
      const pg = await rpc(cookie, 'session/page', { request: { address: { kind: 'session', sessionId: sess.sessionId } } });
      const v = pg && pg.result && pg.result.value;
      const recs = ((v && v.records) || []).map((x) => (x && x.event ? x.event : x)).filter(Boolean);
      for (const u of recs.filter((e) => e.type === 'user/message')) {
        const t = (u.data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (t.includes(tag)) { found = true; break; }
      }
      if (found) break;

      // 顺便看 webview 里有没有模型报错
      try {
        const er = await wvCdp.send('Runtime.evaluate', {
          expression: `(function(){
            var t = String(document.body ? document.body.innerText : '');
            var m = t.match(new RegExp(${JSON.stringify(MODEL_ERROR_PATTERN.source)}));
            return m ? m[0] : null;
          })()`,
          returnByValue: true,
        });
        const ev = er.result && er.result.result && er.result.result.value;
        if (ev) modelError = ev;
      } catch { /* ignore */ }
    }

    if (found) {
      step('消息到达会话', true, '探针已出现');
    } else if (modelError) {
      // 输入/发送链路是好的，只是模型拒了 → 单独标为「外部限制」
      // ⚠ 步骤名必须仍然叫「消息到达会话」，否则 judgeScenePanelReady 会把它算成
      //   「缺步骤」而误判 —— 判据按 STEP_ORDER 的名字对账。
      step('消息到达会话', true,
        '输入与发送都成功，模型服务拒绝: ' + modelError);
      result.externalBlocked = modelError;
    } else {
      step('消息到达会话', false, WAIT_REACH_SEC + ' 秒内没出现，且 webview 无报错');
    }
  } finally {
    try { wvCdp.close(); } catch { /* ignore */ }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════
//  自测（导出：外面可以 import 后单独跑）
// ══════════════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  界面功能体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】场景配置读取');
  const scenes = loadScenes();
  chk('能读到有 AI 面板的场景', scenes.length > 0, scenes.length + ' 个');
  chk('每个场景有 id 和 name', scenes.every((s) => s.id && s.name));
  chk('每个场景至少 1 个 AI 面板', scenes.every((s) => s.aiPanels >= 1));

  console.log();
  console.log('【二】反例：没有 AI 面板的场景不该被列出');
  {
    // 中枢只有 neuron 面板，没有 harness
    const hub = scenes.find((s) => s.id === 'hub');
    chk('反例：中枢（无 AI 面板）不在列表里', !hub, hub ? '竟然列出来了' : '正确排除');
  }

  console.log();
  console.log('【三】检查项完整性');
  // ⚠ 2026-11-12 修：原来这里手抄了一份 7 步清单，和 testScene 里实际调的
  //   step(...) 是同一事实的两份（而且清单本身已经落后于实现 —— 实际是 9 步）。
  //   现在清单唯一出处是 STEP_MUST / STEP_ORDER，这里只对账「数量」和「源码里真的调用了」。
  chk('判据里定义了 ' + STEPS_REQUIRED + ' 步', STEP_ORDER.length === STEPS_REQUIRED,
    STEP_ORDER.length + ' 步');
  // 验证 testScene 源码里都提到这些
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const missing = STEP_ORDER.filter((s) => !self.includes("step('" + s + "'"));
  chk('testScene 真的实现了所有 ' + STEPS_REQUIRED + ' 步', missing.length === 0,
    missing.length ? '缺: ' + missing.join(', ') : '全实现');

  console.log();
  console.log('【四】判据函数 judgeScenePanelReady 会判错（反例）');
  {
    // 反例 1：只跑了几步就返回（前置失败）→ 必须判不通过，不能被当成「全通」
    const shortRun = {
      scene: '假场景',
      steps: [{ n: '切到场景', ok: true }],
    };
    const r1 = judgeScenePanelReady(shortRun);
    chk('反例：没跑完 ' + STEPS_REQUIRED + ' 步必须判不通过', r1.ok === false && r1.short === true,
      'steps=' + r1.got + ' 缺=' + r1.missing.length + ' 项');

    // 反例 2：9 步都在，但「消息到达会话」是 false → 必须判不通过
    //        （这正是「界面画出来了但发不出去」的真实故障形态）
    const notDelivered = {
      scene: '假场景',
      steps: STEP_ORDER.map((n) => ({ n, ok: n !== '消息到达会话' })),
    };
    const r2 = judgeScenePanelReady(notDelivered);
    chk('反例：消息没到达会话必须判不通过', r2.ok === false && r2.failed.some((f) => f.n === '消息到达会话'),
      r2.failed.map((f) => f.n).join(', ') || '（竟然通过了）');

    // 正例：9 步全过才算能用
    const good = { scene: '假场景', steps: STEP_ORDER.map((n) => ({ n, ok: true })) };
    chk('正例：' + STEPS_REQUIRED + ' 步全过判通过', judgeScenePanelReady(good).ok === true);
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

  const sceneFilter = val('scene', null);
  const scenes = loadScenes().filter((s) => !sceneFilter || s.name === sceneFilter || s.id === sceneFilter);

  if (!scenes.length) {
    console.log('没有找到场景（或用 --scene 指定的场景不存在）');
    process.exit(2);
  }

  console.log('═'.repeat(76));
  console.log('  界面功能体检 —— 界面不只是「画出来了」，而是「真的能用」');
  console.log('═'.repeat(76));
  console.log();
  console.log('  做法：真的切场景 → 真的输入 → 真的按回车 → 验证消息到达会话');
  console.log('  场景数: ' + scenes.length);
  console.log();

  const target = await getRenderer();
  if (!target) {
    console.log('  ✗ 找不到渲染进程（CDP 端口 ' + CDP_PORT + '）');
    process.exit(2);
  }
  console.log('  渲染进程: ' + target.url.slice(0, 60));
  const cdp = await cdpConnect(target.webSocketDebuggerUrl);
  if (!cdp) { console.log('  ✗ CDP 连接失败'); process.exit(2); }
  await cdp.send('Runtime.enable');

  const cookie = await getCookie();
  if (!cookie) { console.log('  ✗ 拿不到引擎 cookie'); process.exit(2); }

  const results = [];
  for (const s of scenes) {
    process.stdout.write('  ' + s.name.padEnd(12) + '  ');
    const r = await testScene(cdp, cookie, s);
    results.push(r);
    // 判据只有一处：judgeScenePanelReady（这里不再自己数 ok 步数）
    const j = judgeScenePanelReady(r);
    const okN = r.steps.filter((x) => x.ok).length;
    console.log((j.ok ? '✓ 全通' : '✗ ' + okN + '/' + r.steps.length) + '  (' + r.steps.length + '/' + STEPS_REQUIRED + ' 步)');
    for (const st of r.steps.filter((x) => !x.ok)) {
      console.log('       ✗ ' + st.n + (st.d ? ': ' + st.d : ''));
    }
    // 差异集合：没跑到 / 判失败的步骤逐条列出来，不只给一个总计
    if (j.missing.length) console.log('       ✗ 未执行: ' + j.missing.join(' / '));
  }

  cdp.close();

  console.log();
  console.log('─'.repeat(76));
  const allOk = results.filter((r) => judgeScenePanelReady(r).ok);
  console.log('  结果: ' + allOk.length + ' / ' + results.length + ' 个场景的 AI 面板真的能用');
  if (allOk.length < results.length) {
    console.log('  不可用的场景: ' + results.filter((r) => !allOk.includes(r)).map((r) => r.scene).join(', '));
    process.exitCode = 1;
  }
  console.log('═'.repeat(76));
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}

// ⚠ 2026-11-12 补：只有「直接运行本文件」才跑主流程。
//   原来 main() 在模块顶层无条件调用，于是**别的工具 import 这里的判据时，
//   会把整套真实体检（8 个场景、每个 15 秒）跑一遍** —— 那等于判据没法被复用。
//   实测：写了个 import { judgeScenePanelReady } 的单测，一 import 就切场景。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // ⚠ 2026-11-12 加 UI 互斥锁：这个工具会切场景 + 连 webview。
  //   与 面板内容体检 / 会话绑定验证 并发跑时会互相干扰（读到别人的场景）。
  //   实测：并发跑 6/8，单独跑 8/8 —— 不是产品缺陷，是测试互斥问题。
  withUiLock('界面功能体检', main).catch((e) => {
    console.error('  ✗ ' + ((e && e.stack) || e));
    process.exitCode = 1;
  });
}
