#!/usr/bin/env node
/**
 * 工作台 v4（复用 Arco + Lucide）—— 端到端验收
 *
 * 这一份验的不是"好不好看"（那不可判定），而是三件可判定的事：
 *   1. 复用资产真的在仓库里、且是真货（不是空文件、不是改名的假货）
 *   2. 页面真的引用了它们、并且组件真的渲染出了 DOM
 *   3. 廉价感的两个可判定来源已消除：字符占位图标、手搓控件
 *
 * 四态：没有浏览器 → UNKNOWN(退出 2)，不当成通过。
 *
 * 用法：node verify-workbench4.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(REPO, 'prototype/agent-ui');
const PAGE = path.join(DIR, 'workbench-v4.html');
const ARCO = path.join(DIR, 'vendor/arco.css');
const LUCIDE = path.join(DIR, 'vendor/lucide.js');

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (msg) => { unknown++; console.log('  ' + ICON.un + ' ' + msg); };

console.log('');
console.log('  工作台 v4（复用 Arco Design + Lucide）—— 端到端验收');
console.log('  ' + '─'.repeat(70));

// ── 1. 复用资产是不是真货 ──
// 只检查"文件存在"是不够的：一个空文件也能通过。必须检查里面有没有该有的东西。
if (!fs.existsSync(ARCO)) { console.log('  ✗ 缺 vendor/arco.css'); process.exit(1); }
const arcoCss = fs.readFileSync(ARCO, 'utf8');
const arcoKB = Math.round(arcoCss.length / 1024);
ok(arcoCss.length > 400000, 'Arco 成品组件 CSS 在位（' + arcoKB + 'KB，不是占位）');
ok(/--primary-6\s*:/.test(arcoCss), 'Arco CSS 含 --primary-6 令牌（说明是真 Arco，不是随便一个 CSS）');
ok(/\.arco-btn-secondary/.test(arcoCss) && /\.arco-btn-primary/.test(arcoCss), 'Arco CSS 含按钮类型类');
ok(/body\[arco-theme='dark'\]/.test(arcoCss), 'Arco CSS 含暗色主题开关（body[arco-theme=dark]）');
ok(/\.arco-table-th/.test(arcoCss) && /\.arco-switch-checked/.test(arcoCss), 'Arco CSS 含表格与开关组件');

if (!fs.existsSync(LUCIDE)) { console.log('  ✗ 缺 vendor/lucide.js'); process.exit(1); }
const lucideJs = fs.readFileSync(LUCIDE, 'utf8');
ok(lucideJs.length > 200000, 'Lucide 图标库在位（' + Math.round(lucideJs.length / 1024) + 'KB）');
ok(/createIcons/.test(lucideJs), 'Lucide 暴露 createIcons（页面靠它把 data-lucide 换成 SVG）');

// ── 2. 页面真的接上了 ──
if (!fs.existsSync(PAGE)) { console.log('  ✗ 缺 workbench-v4.html'); process.exit(1); }
const html = fs.readFileSync(PAGE, 'utf8');
ok(/<link rel="stylesheet" href="vendor\/arco\.css">/.test(html), '页面用 <link> 引用 vendor/arco.css（不是 CDN，离线可开）');
ok(/<script src="vendor\/lucide\.js"><\/script>/.test(html), '页面引用 vendor/lucide.js');
ok(/arco-theme="dark"|arco-theme=.dark./.test(html), '页面开启 Arco 暗色主题');

// 廉价感来源一：字符占位图标。v1–v3 用过 ◧ ◉ ✳ ◷ ⛁ ⚒ ◎，这里断言它们没了。
const glyphs = ['◧', '◉', '✳', '◷', '⛁', '⚒'];
const found = glyphs.filter((g) => html.includes(g));
ok(found.length === 0, '页面里已无字符占位图标' + (found.length ? '  ← 还有 ' + found.join(' ') : '（v1–v3 的 ◧◉✳◷ 全部清掉）'));

// ── 3. 跑起来看真 DOM ──
function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((p) => fs.existsSync(p)) || null;
}
const browser = findBrowser();
console.log('');
if (!browser) {
  un('机器上没有 Edge/Chrome，渲染检查跑不了 —— 这是「判不了」，不是「通过」');
  console.log('');
  console.log('  ' + '─'.repeat(70));
  console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
  console.log('');
  process.exit(unknown ? 2 : fail ? 1 : 0);
}
console.log('  ' + ICON.ok + ' 找到浏览器: ' + path.basename(browser));
pass++;

// 页面通过相对路径引用 vendor/，所以要在页面所在目录起 file:// 并带 profile（避免缓存串）
const tmp = path.join(os.tmpdir(), 'wb4-' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
const baseUrl = 'file:///' + PAGE.replace(/\\/g, '/');
function dump(q, tag) {
  try {
    return execFileSync(browser, [
      '--headless', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
      '--virtual-time-budget=5000', '--user-data-dir=' + path.join(tmp, tag),
      '--dump-dom', baseUrl + q,
    ], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { return (e.stdout || '') + ''; }
}

const domTest = dump('?selftest=1', 'st');
const m = domTest.match(/SELFTEST_BEGIN([\s\S]*?)SELFTEST_END/);
if (!m) {
  fail++;
  console.log('  ' + ICON.no + ' 页面没有输出 SELFTEST_BEGIN —— 启动期抛异常了');
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

// 组件是不是真的渲染成 DOM（不是只有 class 字符串）
const domConv = dump('?view=conversation', 'conv');
ok((domConv.match(/arco-btn/g) || []).length > 0, 'Arco 按钮真的渲染进 DOM');
ok(/class="lucide|class="[^"]*\blucide\b/.test(domConv), 'Lucide 已把 data-lucide 换成真 SVG（不再是空 span）');
ok(/data-wtab="files"/.test(domConv) && /class="composer"/.test(domConv), '会话视图有右工作区与输入框');
ok(/data-nav="capabilities"/.test(domConv), '任何视图下一级导航都在（能力可随时进入）');

const domSkills = dump('?view=capabilities&kind=skills', 'sk');
ok((domSkills.match(/arco-table/g) || []).length > 0, '能力列表用 Arco 表格渲染');
ok((domSkills.match(/arco-switch/g) || []).length >= 8, '每个能力条目都带 Arco 开关');
const skillRows = (domSkills.match(/arco-table-tr/g) || []).length;
ok(skillRows >= 9, '技能页渲染出 9 行（含表头），实测 ' + skillRows);
ok(!/class="cap-nav"/.test(domSkills), '页内重复的「能力分类」纵列已删除（侧栏已列）');

// ── 4. 截图证据 ──
for (const s of ['我们-v4-conv.png', '我们-v4-skills.png', '我们-v4-mcp.png', '我们-v4-agents.png']) {
  const sp = path.join(REPO, 'research/screenshots', s);
  ok(fs.existsSync(sp), '截图证据：' + s + (fs.existsSync(sp) ? '  ' + Math.round(fs.statSync(sp).size / 1024) + 'KB' : ''));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log('');
console.log('  ' + '─'.repeat(70));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
