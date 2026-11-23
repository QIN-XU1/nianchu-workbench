#!/usr/bin/env node
/**
 * 工作台 v1（可拖拽停靠）—— 端到端验收
 *
 * 这一份和 verify-agent-ui.mjs 分工不同：
 *   verify-agent-ui  —— 验设计系统（对比度算数、token 引用），静态分析就够
 *   这一份          —— 验布局运算，必须**真的在浏览器里跑**
 *
 * 为什么必须真跑：拖拽/序列化这类逻辑是运行时行为，静态看源码看不出来。
 * 无头浏览器带 ?selftest=1 打开页面，页面把 15 条断言结果写进 #selftest，
 * 这里 dump DOM 读回来解析。
 *
 * 四态在这份脚本里也用上了：
 *   机器上没有 Edge/Chrome  → UNKNOWN（判不了），退出 2 —— 不许当成"通过"
 *   页面语法错/自检红       → FAIL，退出 1
 *
 * 用法：node verify-workbench.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const PAGE = path.join(REPO, 'prototype/agent-ui/workbench-v2.html');

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (msg) => { unknown++; console.log('  ' + ICON.un + ' ' + msg); };

console.log('');
console.log('  工作台 v1（可拖拽停靠）—— 端到端验收');
console.log('  ' + '─'.repeat(64));

if (!fs.existsSync(PAGE)) { console.log('  ✗ 找不到 ' + PAGE); process.exit(1); }
const html = fs.readFileSync(PAGE, 'utf8');
ok(html.length > 40000, '页面在位（' + Math.round(html.length / 1024) + 'KB 单文件）');

// 静态：三栏停靠 + 面板定义 + 自检入口都在
ok(/data-region="\$\{r\}"|regionHTML/.test(html), '三栏区域由数据模型渲染（不是写死 DOM）');
ok(/function movePanel/.test(html), '有 movePanel 纯函数（先摘后插）');
ok(/function deserialize/.test(html), '有 deserialize（废面板丢弃 + 缺面板补齐）');
ok(/\.splitter/.test(html) && /function onResizeMove/.test(html), '分栏宽度可拖拽');
ok(/localStorage\.setItem\('workbench\.layout'/.test(html), '布局持久化到 localStorage');

// 找浏览器
function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

const browser = findBrowser();
console.log('');
if (!browser) {
  un('机器上没有 Edge/Chrome，布局自检跑不了 —— 这是「判不了」，不是「通过」也不是「失败」');
  console.log('');
  console.log('  ' + '─'.repeat(64));
  console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
  console.log('');
  process.exit(unknown ? 2 : fail ? 1 : 0);
}

console.log('  ' + ICON.ok + ' 找到浏览器: ' + path.basename(browser));
pass++;

// 用无头浏览器跑页面自检
const tmp = path.join(os.tmpdir(), 'wb-verify-' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
const profile = path.join(tmp, 'profile');
const pageUrl = 'file:///' + PAGE.replace(/\\/g, '/') + '?selftest=1';

let dom = '';
let ran = false;
try {
  dom = execFileSync(browser, [
    '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000',
    '--user-data-dir=' + profile,
    '--dump-dom', pageUrl,
  ], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  ran = true;
} catch (e) {
  dom = (e.stdout || '') + '';
}

if (!ran || !dom) {
  un('无头浏览器没有正常返回 —— 判不了，不当成通过');
} else {
  const m = dom.match(/SELFTEST_BEGIN([\s\S]*?)SELFTEST_END/);
  if (!m) {
    fail++;
    console.log('  ' + ICON.no + ' 页面没有输出 SELFTER_BEGIN 块 —— 说明启动期就抛异常了');
  } else {
    const block = m[1];
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const head = lines.find((l) => l.includes('布局自检'));
    const bad = lines.filter((l) => l.startsWith('✗'));
    const good = lines.filter((l) => l.startsWith('✓'));

    ok(good.length >= 29, '布局断言全部成立（' + good.length + ' 条）' + (head ? '  ' + head : ''));
    ok(bad.length === 0, '没有失败的断言' + (bad.length ? '  ← ' + bad.join(' | ') : ''));

    // 逐条列出，证明不是只有个总数
    for (const l of good) console.log('      ' + l);
    for (const l of bad) console.log('      ' + l);

    const result = dom.match(/RESULT (OK|FAIL) (\d+)\/(\d+)/);
    ok(!!result && result[1] === 'OK', '页面自身判定 ' + (result ? result[1] + ' ' + result[2] + '/' + result[3] : '未输出'));

    // 页面里必须真的渲染出三栏，而不是白屏
    ok(/data-region="left"/.test(dom) && /data-region="center"/.test(dom) && /data-region="right"/.test(dom),
      '三栏都真的渲染出来了（left / center / right）');
    // 注意：--dump-dom 把内联 <script> 源码也 dump 出来了，里面有模板串 class="panel"。
    // 直接数会多算 1 个（本轮实测踩到），所以数"真实面板 id"。
    const rendered = new Set([...dom.matchAll(/data-id="(scenes|fleet|chat|inspector|files)"/g)].map((x) => x[1]));
    ok(rendered.size === 3, '渲染出 3 个面板，每栏一个（实际 ' + rendered.size + ' 个: ' + [...rendered].join(',') + '）');
    ok(!rendered.has('files'), 'optional 的 files 面板默认不出现');
    ok(/data-id="chat"/.test(dom), '会话面板在位');
    ok(/class="splitter"/.test(dom), '分隔条在位（可拖拽）');
  }
}

// 截图证据
const shot = path.join(REPO, 'research/screenshots/我们-v2-dark.png');
ok(fs.existsSync(shot), '截图证据：我们-v2-dark.png' + (fs.existsSync(shot) ? '  ' + Math.round(fs.statSync(shot).size / 1024) + 'KB' : ''));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }

console.log('');
console.log('  ' + '─'.repeat(64));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
