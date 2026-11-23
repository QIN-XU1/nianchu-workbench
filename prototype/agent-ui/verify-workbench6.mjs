#!/usr/bin/env node
/**
 * 工作台 v6（暗色令牌逐字取 DSH + open-design）—— 端到端验收
 *
 * 这一版验的是「配色为什么不再廉价」里**可判定**的部分。
 * 关键不是颜色长什么样，而是三条结构性事实：
 *
 *   1. 层次步进够大 —— v5 的 bg-base #0f1115 与 bg-1 #151517 只差 6 个单位，
 *      整屏糊成一片，这是"廉价"的物理原因。DSH 的步进是 14 / 9 / 9。
 *   2. 暗色下品牌主色是近白，不是彩色 —— DSH 与 open-design 都是这样，
 *      我在 v5 塞了一个蓝主色，这是第二个物理原因。
 *   3. 状态点不能满屏 —— 每行一个绿点是第三个物理原因。
 *
 * 这三条都能算出来，所以能断言。四态：没有浏览器 → UNKNOWN(退出 2)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(REPO, 'prototype/agent-ui');
const PAGE = path.join(DIR, 'workbench-v6.html');

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (msg) => { unknown++; console.log('  ' + ICON.un + ' ' + msg); };

console.log('');
console.log('  工作台 v6（暗色令牌逐字取 DSH + open-design）—— 端到端验收');
console.log('  ' + '─'.repeat(74));

if (!fs.existsSync(PAGE)) { console.log('  ✗ 缺 workbench-v6.html'); process.exit(1); }
const html = fs.readFileSync(PAGE, 'utf8');
ok(html.length > 45000, '页面在位（' + Math.round(html.length / 1024) + 'KB 单文件）');

const hexOf = (name) => {
  const m = html.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})'));
  return m ? m[1] : null;
};
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ── 1. 暗色令牌是不是 DSH 的值（逐字）──
const base = hexOf('bg-base'), l1 = hexOf('bg-1'), l2 = hexOf('bg-2'), l3 = hexOf('bg-3');
ok(base === '#151517', 'bg-base = DSH neutral-bluish-950 #151517' + (base ? '（实测 ' + base + '）' : ''));
ok(l1 === '#232324' && l2 === '#2c2c2e' && l3 === '#353638', 'bg layer 1/2/3 = DSH 875/850/800（#232324 / #2c2c2e / #353638）');
ok(hexOf('text-1') === '#f9fafb' && hexOf('text-4') === '#81858c', '文字阶梯 = DSH label-primary(50) / caption(600)');
ok(/--border:\s*rgba\(255, 255, 255, \.06\)/.test(html), 'border = DSH border-l1 rgba(255,255,255,.06)');

// ── 2. 层次步进：这条是 v5 "糊" 的根因 ──
if (base && l1 && l2 && l3) {
  const steps = [
    ['base→layer1', rgb(l1), rgb(base)],
    ['layer1→layer2', rgb(l2), rgb(l1)],
    ['layer2→layer3', rgb(l3), rgb(l2)],
  ].map(([name, a, b]) => [name, Math.max(...a.map((v, i) => Math.abs(v - b[i])))]);
  const min = Math.min(...steps.map((s) => s[1]));
  ok(min >= 8, '层次步进每一档都 ≥8 个单位（' + steps.map((s) => s[0] + '=' + s[1]).join('  ') + '）—— v5 只有 6，所以糊');
} else {
  fail++; console.log('  ✗ 取不到 bg 令牌，步进算不出来');
}

// ── 3. 暗色品牌主色必须近白 ──
const ink = hexOf('accent-ink');
if (ink) {
  const [r, g, b] = rgb(ink);
  const minC = Math.min(r, g, b), maxC = Math.max(r, g, b);
  ok(minC >= 230, '暗色主色 accent-ink 是近白 ' + ink + '（RGB 最小值 ' + minC + ' ≥ 230）—— 两个参照系统都如此');
  ok(maxC - minC <= 12, '主色不带明显色相（通道差 ' + (maxC - minC) + ' ≤ 12）—— 不是"塞了个蓝"');
} else { fail++; console.log('  ✗ 缺 --accent-ink'); }

// 主按钮与发送都不该再用品牌蓝
ok(!/\.send\s*\{[^}]*var\(--ds-500\)/.test(html), '发送按钮不再用品牌蓝');
ok(!/\.primary\s*\{[^}]*var\(--ds-500\)/.test(html), '主按钮不再用品牌蓝');
const dsUses = (html.match(/var\(--ds-500\)/g) || []).length;
ok(dsUses === 0, '页面里已完全不引用 --ds-500（实际 ' + dsUses + ' 处）');

// ── 4. 状态色取 open-design 的柔和值（不是交通灯高饱和）──
ok(hexOf('st-pass') === '#3bbf7d', '通过色 = open-design green #3BBF7D');
ok(hexOf('st-warn') === '#ffc740', '待补色 = open-design amber #FFC740');
ok(hexOf('st-fail') === '#ff5e5e', '失败色 = open-design red #FF5E5E');

// ── 5. 圆角与阴影（open-design 比例）──
ok(/--radius-xs:\s*2px/.test(html) && /--radius-sm:\s*4px/.test(html) && /--radius-md:\s*8px/.test(html), '圆角 2/4/8（open-design 比例，非大圆角）');

// ── 6. 噪音：状态点不满屏、已启用不写文字 ──
ok(!/'已启用'/.test(html), '已启用状态不再逐行写「已启用」文字（只标停用）');
ok(/\.tog \{ white-space: nowrap; \}/.test(html), '状态文字禁止换行（实测「已停用」曾被挤成两行）');
const dotSlots = (html.match(/dot-slot/g) || []).length;
ok(dotSlots >= 2, '正常状态用 dot-slot 占位而不是画点（' + dotSlots + ' 处）');

// ── 7. 对齐：顶栏与正文同一条线 ──
ok(/\.main\[data-view="conversation"\] \.topbar \{ padding-right: 300px; \}/.test(html), '会话视图顶栏扣掉右工作区宽度，与正文对齐');
ok(/\.topbar > \.tb-inner \{/.test(html), '顶栏内容用统一容器（不是通栏 padding）');

// ── 8. 跑起来 ──
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
  un('机器上没有 Edge/Chrome，渲染检查跑不了 —— 判不了，不当成通过');
  console.log('');
  console.log('  ' + '─'.repeat(74));
  console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
  console.log('');
  process.exit(unknown ? 2 : fail ? 1 : 0);
}
console.log('  ' + ICON.ok + ' 找到浏览器: ' + path.basename(browser));
pass++;

const tmp = path.join(os.tmpdir(), 'wb6-' + process.pid);
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
  fail++; console.log('  ' + ICON.no + ' 页面没有输出 SELFTEST_BEGIN —— 启动期抛异常了');
} else {
  const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
  const good = lines.filter((l) => l.startsWith('✓'));
  const bad = lines.filter((l) => l.startsWith('✗'));
  ok(good.length >= 18, '路由与信息架构断言全部成立（' + good.length + ' 条）');
  ok(bad.length === 0, '没有失败的断言' + (bad.length ? '  ← ' + bad.join(' | ') : ''));
  for (const l of good) console.log('      ' + l);
  for (const l of bad) console.log('      ' + l);
  const r = domTest.match(/RESULT (OK|FAIL) (\d+)\/(\d+)/);
  ok(!!r && r[1] === 'OK', '页面自身判定 ' + (r ? r[1] + ' ' + r[2] + '/' + r[3] : '未输出'));
}

const domConv = dump('?view=conversation', 'conv');
ok(/data-wtab="files"/.test(domConv) && /class="composer"/.test(domConv), '会话视图有右工作区与输入框');
ok(!/class="arco-/.test(domConv), 'Arco 已移除');

const domSkills = dump('?view=capabilities&kind=skills', 'sk');
const rows = (domSkills.match(/class="crow"/g) || []).length;
ok(rows >= 8, '技能页渲染出 ' + rows + ' 行');
ok(!/已启用<\/button>/.test(domSkills), 'DOM 里确认：已启用的行不再渲染「已启用」文字');

// ── 9. 截图 ──
for (const s of ['我们-v6-conv.png', '我们-v6-skills.png', '我们-v6-mcp.png', '我们-v6-agents.png']) {
  const sp = path.join(REPO, 'research/screenshots', s);
  ok(fs.existsSync(sp), '截图证据：' + s + (fs.existsSync(sp) ? '  ' + Math.round(fs.statSync(sp).size / 1024) + 'KB' : ''));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log('');
console.log('  ' + '─'.repeat(74));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
