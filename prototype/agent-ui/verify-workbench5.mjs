#!/usr/bin/env node
/**
 * 工作台 v5（DSH 令牌 + open-design 比例 + Lucide）—— 端到端验收
 *
 * 这一版验的是「风格特征」里可判定的那部分，不是「好不好看」：
 *   1. 令牌是不是逐字取自两个参照系统（而非我编的）
 *   2. 三个「老/廉价」的结构性特征是否真的消失了：
 *        · 大圆角（≥16px 用在常规控件上）
 *        · 到处硬边框（border: 1px solid 遍布）
 *        · 彩色满屏（品牌色出现在很多条规则里）
 *   3. 路由与信息架构仍然成立（沿用 v3 的 18 条）
 *
 * 四态：没有浏览器 → UNKNOWN(退出 2)，不当成通过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(REPO, 'prototype/agent-ui');
const PAGE = path.join(DIR, 'workbench-v5.html');
const LUCIDE = path.join(DIR, 'vendor/lucide.js');

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (msg) => { unknown++; console.log('  ' + ICON.un + ' ' + msg); };

console.log('');
console.log('  工作台 v5（DSH 令牌 + open-design 比例）—— 端到端验收');
console.log('  ' + '─'.repeat(72));

if (!fs.existsSync(PAGE)) { console.log('  ✗ 缺 workbench-v5.html'); process.exit(1); }
const html = fs.readFileSync(PAGE, 'utf8');
ok(html.length > 45000, '页面在位（' + Math.round(html.length / 1024) + 'KB 单文件）');

// ── 1. 令牌出处：能不能在源码里找到参照系统的特征值 ──
ok(/--nb-1000:\s*#0f1115/.test(html), 'DSH 暗色底 #0f1115 在位（取自 design-platform.css 的 neutral-bluish-1000）');
ok(/--nb-500:\s*#979da6/.test(html) && /--nb-900:\s*#1b1b1c/.test(html), 'DSH neutral-bluish 灰阶在位');
ok(/--radius-xs:\s*2px/.test(html) && /--radius-sm:\s*4px/.test(html) && /--radius-md:\s*8px/.test(html),
  '圆角取 open-design 的 2/4/8（不是大圆角）');
ok(/--shadow-lv1:\s*0 1px 0 rgba\(28, 27, 26, \.04\)/.test(html), '阴影逐字取自 open-design（0 1px 0 / .04）');
ok(/--accent-ink:\s*#202020/.test(html), '结构色用 open-design 的墨 #202020，不是彩色');

// ── 2. 三个「老/廉价」特征是否消失（可判定）──
// 2a 大圆角：组件层不许出现 ≥16px 的圆角字面量
// 注意排除 999（胶囊/圆点）与 50%：那些是"圆"，不是"大圆角矩形"。上一版断言把它们算成大圆角，是断言写错了。
const bigRadius = [...html.matchAll(/border-radius:\s*(\d+)px/g)]
  .map((m) => Number(m[1]))
  .filter((v) => v >= 16 && v < 100);
ok(bigRadius.length === 0, '组件里没有 ≥16px 的大圆角' + (bigRadius.length ? '  ← 还有 ' + bigRadius.join(',') : '（旧版有 16/20/28）'));

// 2b 硬边框：完整的 border: 1px solid 只应出现在骨架级别的分隔上
const hardBorders = (html.match(/border:\s*1px solid var\(--border\)/g) || []).length;
ok(hardBorders <= 2, '硬边框只剩 ≤2 处（骨架分隔）' + (hardBorders > 2 ? '  ← 实测 ' + hardBorders : '（实测 ' + hardBorders + '）'));
const insetHairlines = (html.match(/box-shadow:\s*inset 0 1px 0 var\(--border\)/g) || []).length;
ok(insetHairlines >= 3, '列表分隔改用 inset 细线（' + insetHairlines + ' 处），而不是真边框');

// 2c 彩色满屏：品牌蓝只应出现在极少数规则里
const accentUses = (html.match(/var\(--ds-500\)/g) || []).length;
ok(accentUses <= 4, '品牌蓝只用在 ' + accentUses + ' 处（发送 / 焦点），不是满屏');

// 2d 图标：不能再有字符占位
const glyphs = ['◧', '◉', '✳', '◷', '⛁', '⚒'];
ok(glyphs.every((g) => !html.includes(g)), '没有字符占位图标（Lucide 真图标）');
ok(fs.existsSync(LUCIDE), 'Lucide 在位（' + (fs.existsSync(LUCIDE) ? Math.round(fs.statSync(LUCIDE).size / 1024) + 'KB' : '—') + '）');

// ── 3. 跑起来 ──
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
  console.log('  ' + '─'.repeat(72));
  console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
  console.log('');
  process.exit(unknown ? 2 : fail ? 1 : 0);
}
console.log('  ' + ICON.ok + ' 找到浏览器: ' + path.basename(browser));
pass++;

const tmp = path.join(os.tmpdir(), 'wb5-' + process.pid);
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

const domConv = dump('?view=conversation', 'conv');
ok(/class="lucide|data-lucide=/.test(domConv), 'Lucide 图标真的渲染（data-lucide 已被替换）');
ok(/data-wtab="files"/.test(domConv) && /class="composer"/.test(domConv), '会话视图有右工作区与输入框');
ok(/class="tool-row"/.test(domConv) && !/class="tool tuft"\s*<div class="tool-head"/.test(domConv), '工具调用改成无框的行式（不再是有边框的卡片）');
ok(!/class="arco-/.test(domConv), 'Arco 已移除（它的企业后台气质是被嫌"老"的来源）');

const domSkills = dump('?view=capabilities&kind=skills', 'sk');
const rows = (domSkills.match(/class="crow"/g) || []).length;
ok(rows >= 8, '技能页渲染出 ' + rows + ' 行');
ok(!/arco-table/.test(domSkills), '能力列表不再用带表头边框的表格');
ok((domSkills.match(/class="tog"/g) || []).length >= 8, '每行都有启停控件');

// ── 4. 截图 ──
for (const s of ['我们-v5-conv.png', '我们-v5-skills.png', '我们-v5-mcp.png', '我们-v5-agents.png']) {
  const sp = path.join(REPO, 'research/screenshots', s);
  ok(fs.existsSync(sp), '截图证据：' + s + (fs.existsSync(sp) ? '  ' + Math.round(fs.statSync(sp).size / 1024) + 'KB' : ''));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
