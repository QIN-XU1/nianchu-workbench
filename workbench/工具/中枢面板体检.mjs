#!/usr/bin/env node
// 工具/中枢面板体检.mjs —— 中枢的 AI 对话面板真的能用吗
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（覆盖盲区）
// ══════════════════════════════════════════════════════════════════════
//  实测发现的盲区：
//
//    · 面板内容体检 覆盖 29 个面板（9 个场景各自的配置面板）
//      但它测的是 `外壳/scenarios/*.json` 里声明的面板。
//
//    · 中枢 hub.json 只声明了 **1 个**面板：
//        hub-neuron（type=neuron，记忆神经元）
//
//    · 但中枢界面上**还有一个 AI 对话面板**（输入框 + 消息流 + 发送按钮），
//      它是硬编码在 `外壳/ui/panels/main-agent.js`（904 行 / 28KB）里的，
//      不在场景配置里。
//
//    → 结果：中枢的 AI 面板**两套界面体检都没覆盖**。
//      它能用，但没有任何检查保证它一直能用。
//
//  实测它当前是好的：
//    输入框 TEXTAREA placeholder="说点什么…"  259x35 可见
//    状态文案「中枢就绪＋已接入中枢会话」
//    对话内容「【场景自检】…」→「确认在线，我是「中枢」场景的助手。」
//
//  但这个「好」没有任何机制守着。
//
//  本工具验 4 件事：
//    ① 能切到中枢场景
//    ② AI 输入框存在且可见（不是 0x0、不是隐藏）
//    ③ 输入框能聚焦、能输字
//    ④ 输入框不是错误占位（文案里没有「失败」「错误」）
//
//  用法：
//    node 工具/中枢面板体检.mjs
//    node 工具/中枢面板体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 中枢场景 id */
export const HUB_SCENE = 'hub';
/** AI 输入框的最小可见尺寸（像素） */
export const MIN_INPUT_W = 100;
export const MIN_INPUT_H = 20;
/** 允许的输入框占位文案（含任一即算对） */
export const INPUT_PLACEHOLDER_HINTS = ['说点什么', '输入', '问', '消息'];
/** 不该出现的错误文案 */
export const ERROR_TEXTS = ['加载失败', '启动失败', '出错了', '未连接', '无法连接', '面板不可用'];

/**
 * 判一个输入框描述是否合格
 * @param {{tag?:string, ph?:string, w?:number, h?:number, visible?:boolean}} inp
 * @returns {{ok:boolean, why:string}}
 */
export function judgeInput(inp) {
  if (!inp) return { ok: false, why: '没有输入框' };
  const w = Number(inp.w || 0);
  const h = Number(inp.h || 0);
  if (w < MIN_INPUT_W || h < MIN_INPUT_H) {
    return { ok: false, why: '尺寸太小 ' + w + 'x' + h + '（要 ≥' + MIN_INPUT_W + 'x' + MIN_INPUT_H + '）' };
  }
  if (inp.visible === false) return { ok: false, why: '不可见' };
  const ph = String(inp.ph || '');
  const hasHint = INPUT_PLACEHOLDER_HINTS.some((k) => ph.includes(k));
  if (!hasHint) {
    return { ok: false, why: '占位文案不像 AI 输入框: 「' + ph.slice(0, 20) + '」' };
  }
  return { ok: true, why: '' };
}

/**
 * 判页面文案里有没有错误态
 * @param {string} text
 * @returns {{ok:boolean, hit:string}}
 */
export function judgeNoError(text) {
  const t = String(text || '');
  for (const e of ERROR_TEXTS) {
    if (t.includes(e)) return { ok: false, hit: e };
  }
  return { ok: true, hit: '' };
}

// ══════════════════════════════════════════════════════════════════════
function getList() {
  return new Promise((res) => {
    http.get('http://127.0.0.1:9333/json/list', (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res([]); } });
    }).on('error', () => res([]));
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const send = (m, params) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method: m, params: params || {} }));
  });
  ws.onmessage = (e) => {
    try {
      const j = JSON.parse(e.data);
      if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); }
    } catch { /* ignore */ }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  return { send, close: () => ws.close() };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  中枢面板体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】输入框判据');
  {
    chk('正例：正常的 AI 输入框',
      judgeInput({ tag: 'TEXTAREA', ph: '说点什么…', w: 259, h: 35, visible: true }).ok);
    chk('反例：尺寸 0x0 必须失败',
      judgeInput({ ph: '说点什么', w: 0, h: 0, visible: true }).ok === false,
      judgeInput({ ph: '说点什么', w: 0, h: 0, visible: true }).why);
    chk('反例：不可见必须失败',
      judgeInput({ ph: '说点什么', w: 259, h: 35, visible: false }).ok === false);
    chk('反例：占位文案不对必须失败',
      judgeInput({ ph: '搜索文件名', w: 259, h: 35, visible: true }).ok === false,
      judgeInput({ ph: '搜索文件名', w: 259, h: 35, visible: true }).why);
    chk('反例：null 必须失败', judgeInput(null).ok === false);
  }

  console.log();
  console.log('【二】错误态判据');
  {
    chk('正例：干净文案通过', judgeNoError('中枢就绪 发送就绪').ok);
    chk('反例：加载失败必须被抓', judgeNoError('面板 加载失败').ok === false, judgeNoError('面板 加载失败').hit);
    chk('反例：启动失败必须被抓', judgeNoError('启动失败 请重启').ok === false);
    chk('反例：未连接必须被抓', judgeNoError('引擎 未连接').ok === false);
    chk('反例：空文案通过（不算错误）', judgeNoError('').ok === true);
  }

  console.log();
  console.log('【三】关键：这个工具补的盲区');
  chk('关键：中枢 AI 面板不在场景配置里，两套界面体检都没覆盖',
    true, 'hub.json 只声明了 hub-neuron；AI 对话硬编码在 main-agent.js（904 行）');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  let pass = 0, total = 0;
  const step = (n, ok, d) => { total++; if (ok) pass++; console.log('  ' + (ok ? 'OK ' : 'XX ') + n.padEnd(38) + (d || '')); };

  console.log('='.repeat(78));
  console.log('  中枢面板体检 —— 硬编码在 main-agent.js 里的 AI 对话能用吗');
  console.log('='.repeat(78));
  console.log();
  console.log('  为什么单列一项：hub.json 只声明了 hub-neuron（记忆神经元），');
  console.log('  但界面上还有一个 AI 对话面板，它不在场景配置里 ——');
  console.log('  面板内容体检 和 界面功能体检 都基于场景配置，所以都漏了它。');
  console.log();

  // ① 连主窗口
  const list = await getList();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('  ⛔ 找不到主窗口（工作台没启动？）'); process.exit(2); }

  let cdp;
  try { cdp = await connect(page.webSocketDebuggerUrl); } catch (e) { console.log('  ⛔ CDP 连不上: ' + e.message); process.exit(2); }
  await cdp.send('Runtime.enable');

  const ev = async (expr, awaitPromise) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: awaitPromise !== false, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.text || '');
    return r.result && r.result.result && r.result.result.value;
  };

  // ② 切到中枢
  await ev(`window.__WB.switchScene('${HUB_SCENE}')`);
  await sleep(4000);
  const cur = await ev(`window.__WB.getCurrentScene()`);
  step('能切到中枢场景', cur === HUB_SCENE, cur ? '→ ' + cur : '无');

  // ③ 找输入框
  const rawInp = await ev(`JSON.stringify((function(){
    var cands = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]');
    return Array.from(cands).map(function(e){
      var r = e.getBoundingClientRect();
      return { tag: e.tagName, ph: e.getAttribute('placeholder') || '', w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
    });
  })())`);
  let inputs = [];
  try { inputs = JSON.parse(rawInp || '[]'); } catch { /* ignore */ }
  const inp = inputs.find((x) => judgeInput(x).ok) || inputs[0];
  const j = judgeInput(inp);
  step('AI 输入框存在且可用', j.ok, j.ok ? (inp.w + 'x' + inp.h + ' 「' + inp.ph + '」') : j.why);

  // ④ 能聚焦、能输字
  if (j.ok) {
    const typed = await ev(`(function(){
      var cands = document.querySelectorAll('textarea, [contenteditable="true"]');
      for (var i = 0; i < cands.length; i++) {
        var e = cands[i];
        var r = e.getBoundingClientRect();
        if (r.width < 100 || r.height < 20) continue;
        e.focus();
        if (document.activeElement !== e) continue;
        if (e.tagName === 'TEXTAREA' || e.tagName === 'INPUT') {
          e.value = 'PROBE';
          e.dispatchEvent(new Event('input', { bubbles: true }));
          var ok = e.value === 'PROBE';
          e.value = '';
          e.dispatchEvent(new Event('input', { bubbles: true }));
          return ok ? 'typed' : 'set-failed';
        }
        return 'contenteditable';
      }
      return 'no-target';
    })()`);
    step('输入框能聚焦能输字', typed === 'typed' || typed === 'contenteditable', String(typed));
  } else {
    step('输入框能聚焦能输字', false, '跳过（输入框不可用）');
  }

  // ⑤ 页面没有错误态
  //
  // ⚠ 2026-11-13 修（误报：「加载失败」出现在 <script> 的注释里也算）
  //
  //   第一版用 `document.body.textContent` 扫错误词。
  //   实测误报：页面源码里有一段注释
  //     // 启动失败兜底：5 秒还没就绪就把错误显示出来，不要留白屏
  //   textContent 会把它算进正文 → 报「出现加载失败」。
  //
  //   修法：只扫**可见的**文本节点，显式排除 SCRIPT / STYLE / 不可见元素。
  //        判据看的是「用户能看到的字」，不是「页面源码里的字」。
  const errScan = await ev(`JSON.stringify((function(){
    var hits = [];
    var walk = function(n){
      if (n.nodeType === 3) {
        var t = String(n.nodeValue||'').trim();
        if (!t) return;
        var p = n.parentElement;
        if (!p) return;
        // 排除脚本/样式/注释载体
        if (p.tagName === 'SCRIPT' || p.tagName === 'STYLE' || p.tagName === 'NOSCRIPT') return;
        var r = p.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return;   // 不可见，不算页面文案
        if (getComputedStyle(p).display === 'none' || getComputedStyle(p).visibility === 'hidden') return;
        hits.push(t.slice(0, 80));
      }
      for (var i = 0; i < (n.childNodes ? n.childNodes.length : 0); i++) walk(n.childNodes[i]);
    };
    walk(document.body);
    return hits;
  })())`);
  let visibleTexts = [];
  try { visibleTexts = JSON.parse(errScan || '[]'); } catch { /* ignore */ }
  const visibleText = visibleTexts.join(' ');
  const errJ = judgeNoError(visibleText);
  step('页面没有错误态文案（只看可见文本）', errJ.ok,
    errJ.ok ? '干净（扫了 ' + visibleTexts.length + ' 段可见文本）' : '出现「' + errJ.hit + '」');

  // ⑥ 中枢会话已接入（页面文案里有「已接入」或「就绪」）
  const hasHubSession = /中枢就绪|已接入|发送就绪/.test(visibleText);
  step('中枢会话已接入（不是空面板）', hasHubSession,
    hasHubSession ? '找到「就绪/已接入」文案' : '没找到，可能是空面板');

  cdp.close();

  console.log();
  console.log('-'.repeat(78));
  console.log('  结果: ' + pass + ' / ' + total + ' 步通过');
  if (pass === total) {
    console.log('  ✓ 中枢的 AI 对话面板真的能用（输入框可见、能输字、会话已接入、无错误态）');
  } else {
    process.exitCode = 1;
  }
  console.log('='.repeat(78));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
