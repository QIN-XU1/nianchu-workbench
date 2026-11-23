#!/usr/bin/env node
/**
 * 工作台 v3（路由 + 能力页）—— 端到端验收
 *
 * v2 及以前只有「面板」，没有「页面」，所以技能 / MCP / 模型 / 智能体无处安身。
 * 这一份专门验 v3 的信息架构是否真的成立：
 *   1. 路由模型（makeRoute / parseRoute / routeKey）是纯函数，能在真浏览器里断言
 *   2. 能力页确实有五个分类，且技能与 MCP 在列
 *   3. 深链接 ?view=capabilities&kind=mcp 真的会渲染出 MCP 页（不是只有代码）
 *
 * 四态：没有浏览器 → UNKNOWN(退出 2)，不当成通过。
 *
 * 用法：node verify-workbench3.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const PAGE = path.join(REPO, 'prototype/agent-ui/workbench-v3.html');

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (msg) => { unknown++; console.log('  ' + ICON.un + ' ' + msg); };

console.log('');
console.log('  工作台 v3（路由 + 能力页）—— 端到端验收');
console.log('  ' + '─'.repeat(66));

if (!fs.existsSync(PAGE)) { console.log('  ✗ 找不到 ' + PAGE); process.exit(1); }
const html = fs.readFileSync(PAGE, 'utf8');
ok(html.length > 45000, '页面在位（' + Math.round(html.length / 1024) + 'KB 单文件）');

// ── 静态：信息架构的定义必须存在于源码里 ──
ok(/const SECTIONS = \[/.test(html), '有一级导航定义（SECTIONS）');
ok(/const CAP_KINDS = \[/.test(html), '有能力分类定义（CAP_KINDS）');
ok(/'skills'/.test(html) && /'mcp'/.test(html), '技能与 MCP 都在能力分类里 —— 这就是它们的家');
ok(/function makeRoute/.test(html) && /function parseRoute/.test(html) && /function routeKey/.test(html),
  '路由是纯函数（makeRoute / parseRoute / routeKey）');
ok(/view: 'capabilities'|qView === 'capabilities'/.test(html), '能力页是一条真实路由，不是一个面板');
ok(/switch \(role="switch"|class="switch"/.test(html), '能力条目有启用开关（不只是展示）');
ok(!/data-region="left"/.test(html), 'v3 已不再用 v2 的「面板三栏」模型（避免两套布局模型并存）');

// ── 找浏览器 ──
function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].find((p) => fs.existsSync(p)) || null;
}

const browser = findBrowser();
console.log('');
if (!browser) {
  un('机器上没有 Edge/Chrome，路由自检跑不了 —— 这是「判不了」，不是「通过」');
  console.log('');
  console.log('  ' + '─'.repeat(66));
  console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
  console.log('');
  process.exit(unknown ? 2 : fail ? 1 : 0);
}
console.log('  ' + ICON.ok + ' 找到浏览器: ' + path.basename(browser));
pass++;

const tmp = path.join(os.tmpdir(), 'wb3-verify-' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
const baseUrl = 'file:///' + PAGE.replace(/\\/g, '/');

function dump(query, tag) {
  const profile = path.join(tmp, 'p-' + tag);
  try {
    return execFileSync(browser, [
      '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000',
      '--user-data-dir=' + profile, '--dump-dom', baseUrl + query,
    ], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return (e.stdout || '') + '';
  }
}

// ── 1. 页面自检（路由纯函数在真浏览器里跑）──
const domTest = dump('?selftest=1', 'selftest');
const m = domTest.match(/SELFTEST_BEGIN([\s\S]*?)SELFTEST_END/);
if (!m) {
  fail++;
  console.log('  ' + ICON.no + ' 页面没有输出 SELFTEST_BEGIN 块 —— 启动期就抛异常了');
} else {
  const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
  const good = lines.filter((l) => l.startsWith('✓'));
  const bad = lines.filter((l) => l.startsWith('✗'));
  ok(good.length >= 18, '路由与信息架构断言全部成立（' + good.length + ' 条）');
  ok(bad.length === 0, '没有失败的断言' + (bad.length ? '  ← ' + bad.join(' | ') : ''));
  for (const l of good) console.log('      ' + l);
  for (const l of bad) console.log('      ' + l);
  const result = domTest.match(/RESULT (OK|FAIL) (\d+)\/(\d+)/);
  ok(!!result && result[1] === 'OK', '页面自身判定 ' + (result ? result[1] + ' ' + result[2] + '/' + result[3] : '未输出'));
}

// ── 2. 深链接：能力页真的渲染出来（不是只有代码）──
const domMcp = dump('?view=capabilities&kind=mcp', 'mcp');
ok(/data-cap="mcp"/.test(domMcp), '侧栏渲染出 MCP 分类项');
const mcpRows = [...domMcp.matchAll(/class="trow"/g)].length;
ok(mcpRows >= 5, 'MCP 页渲染出列表（含表头共 ' + mcpRows + ' 行）');
ok(/filesystem/.test(domMcp) && /playwright/.test(domMcp), 'MCP 页渲染出具体的服务器条目（filesystem / playwright）');
ok(/filesystem/.test(domMcp) && /data-toggle="mcp:/.test(domMcp), 'MCP 条目带启用开关（可操作，不是死的）');

const domSkills = dump('?view=capabilities&kind=skills', 'skills');
const skillRows = [...domSkills.matchAll(/class="trow"/g)].length;
ok(skillRows >= 9, '技能页渲染出列表（含表头共 ' + skillRows + ' 行）');

const domConv = dump('?view=conversation', 'conv');
ok(/data-wtab="files"/.test(domConv) && /class="composer"/.test(domConv), '会话视图有右工作区与输入框');
ok(/data-nav="capabilities"/.test(domConv), '主区任何视图下，一级导航都在（能力可随时进入）');

// ── 3. 截图证据 ──
const shots = ['我们-v3-conv.png', '我们-v3-skills.png', '我们-v3-mcp.png'];
for (const s of shots) {
  const sp = path.join(REPO, 'research/screenshots', s);
  ok(fs.existsSync(sp), '截图证据：' + s + (fs.existsSync(sp) ? '  ' + Math.round(fs.statSync(sp).size / 1024) + 'KB' : ''));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log('');
console.log('  ' + '─'.repeat(66));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
