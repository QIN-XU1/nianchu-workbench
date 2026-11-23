#!/usr/bin/env node
/**
 * 工作台 v7（照搬 BitFun / OpenBitFun 设计系统）—— 端到端验收
 *
 * 用户要求：「直接照搬这份项目的设计」。
 * 所以这份验收只验一件事：页面里的令牌是不是 BitFun 那两个 JSON 里的原值。
 *
 * 每个断言都写着出处文件与令牌路径，可以逐条对照：
 *   design-system/packages/theme-openbitfun/src/dark.tokens.json
 *   design-system/packages/design-tokens/src/system.tokens.json
 *
 * 四态：没有浏览器 → UNKNOWN(退出 2)，不当成通过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const PAGE = path.join(REPO, 'prototype/agent-ui/workbench-v7.html');

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (msg) => { unknown++; console.log('  ' + ICON.un + ' ' + msg); };

console.log('');
console.log('  工作台 v7（照搬 BitFun 设计系统）—— 端到端验收');
console.log('  ' + '─'.repeat(74));

if (!fs.existsSync(PAGE)) { console.log('  ✗ 缺 workbench-v7.html'); process.exit(1); }
const html = fs.readFileSync(PAGE, 'utf8');
ok(html.length > 50000, '页面在位（' + Math.round(html.length / 1024) + 'KB）');
ok(/theme-openbitfun\/src\/dark\.tokens\.json/.test(html), '文件头标注了令牌出处（dark.tokens.json）');

// ── 暗色语义（BitFun dark.tokens.json 解引用值）──
const has = (re) => re.test(html);
ok(has(/--bg-base:\s*#0e0e10/), 'surface.canvas = #0e0e10（= ref.color.neutral.950）');
ok(has(/--bg-1:\s*#1c1c1f/), 'surface.panel = #1c1c1f（= ref.color.neutral.900）');
ok(has(/--text-1:\s*#e8e8e8/), 'content.primary = #e8e8e8（= neutral.200）');
ok(has(/--text-2:\s*#b0b0b0/), 'content.secondary = #b0b0b0（= neutral.350）');
ok(has(/--text-3:\s*#858585/), 'content.muted = #858585（= neutral.550）');
ok(has(/--text-4:\s*#555555/), 'content.disabled = #555555（= neutral.750）');
ok(has(/--border:\s*rgba\(255, 255, 255, \.12\)/), 'border.subtle = rgba(255,255,255,.12)');
ok(has(/--border-strong:\s*rgba\(255, 255, 255, \.18\)/), 'border.default = rgba(255,255,255,.18)');
ok(has(/--border-l3:\s*rgba\(255, 255, 255, \.30\)/), 'border.strong = rgba(255,255,255,.30)');
ok(has(/--accent:\s*#60a5fa/), 'accent.default = #60a5fa（= ref.color.blue.400）');
ok(has(/--accent-hover:\s*#3b82f6/), 'accent.hover = #3b82f6（= ref.color.blue.500）');
ok(has(/--st-pass:\s*#1aa73e/), 'status.success = #1aa73e（= green.550 / codeChange.added）');
ok(has(/--st-warn:\s*#ff8c00/), 'status.warning = #ff8c00（= amber.550）');
ok(has(/--st-fail:\s*#ec221f/), 'status.danger = #ec221f（= red.650 / codeChange.removed）');
ok(has(/--overlay-scrim:\s*rgba\(0, 0, 0, \.56\)/), 'overlay.scrim = rgba(0,0,0,.56)');
ok(has(/--scroll-thumb:\s*rgba\(255, 255, 255, \.20\)/), 'scrollbar.thumb = rgba(255,255,255,.20)');

// ── 亮色（BitFun light.tokens.json）──
ok(has(/--bg-base:\s*#fdfdfd/), '亮色 surface.canvas = #fdfdfd（= neutral.50）');
ok(has(/--accent:\s*#059cb0/), '亮色 accent = #059cb0（= cyan.500）');

// ── 几何 / 动效 / 层级（system.tokens.json）──
ok(has(/--radius-xs:\s*4px/) && has(/--radius-sm:\s*6px/) && has(/--radius-md:\s*8px/) && has(/--radius-lg:\s*12px/) && has(/--radius-xl:\s*16px/), 'radius xs4 / sm6 / base8 / lg12 / xl16');
ok(has(/--radius-pill:\s*9999px/), 'radius.pill = 9999px');
ok(has(/--sp-1:\s*4px/) && has(/--sp-2:\s*8px/) && has(/--sp-3:\s*12px/) && has(/--sp-4:\s*16px/), 'space 4/8/12/16（4px 栅格）');
ok(has(/--dur-instant:\s*80ms/) && has(/--dur-fast:\s*140ms/) && has(/--dur-normal:\s*220ms/) && has(/--dur-slow:\s*320ms/), 'motion 80/140/220/320');
ok(has(/cubic-bezier\(0\.23, 1, 0\.32, 1\)/), 'easing.standard = cubic-bezier(0.23, 1, 0.32, 1)');
ok(has(/--z-modal:\s*200/) && has(/--z-toast:\s*400/) && has(/--z-menu:\s*500/), 'layer modal200 / toast400 / contextMenu500');

// ── 照搬的行为 ──
ok(has(/\.composer:focus-within \{ border-color: var\(--border-strong\); box-shadow: none; \}/), 'composer 聚焦只改 border-color，无焦点环无阴影（BitFun .surface:focus-within）');
ok(has(/border-radius: var\(--radius-pill, 9999px\)/), '小图标按钮 pill 半径（BitFun .actionButton[icon-button]）');
ok(has(/box-shadow: inset 0 0 0 1px var\(--st-pass-line\)/), '状态 chip 用 10% 底 + 30% 边派生（BitFun color.status.*.surface/.border）');

// ── 跑起来 ──
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
  un('机器上没有 Edge/Chrome —— 判不了，不当成通过');
  console.log('');
  console.log('  ' + '─'.repeat(74));
  console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
  console.log('');
  process.exit(unknown ? 2 : fail ? 1 : 0);
}
console.log('  ' + ICON.ok + ' 找到浏览器: ' + path.basename(browser));
pass++;

const tmp = path.join(os.tmpdir(), 'wb7-' + process.pid);
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
if (!m) { fail++; console.log('  ' + ICON.no + ' 页面没有输出 SELFTEST_BEGIN'); }
else {
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
ok(/class="lucide|data-lucide=/.test(domConv), 'Lucide 图标渲染');

const domSkills = dump('?view=capabilities&kind=skills', 'sk');
ok((domSkills.match(/class="crow"/g) || []).length >= 8, '技能页渲染出 8 行以上');

for (const s of ['我们-v7-conv.png', '我们-v7-skills.png', '我们-v7-mcp.png', '我们-v7-agents.png']) {
  const sp = path.join(REPO, 'research/screenshots', s);
  ok(fs.existsSync(sp), '截图证据：' + s + (fs.existsSync(sp) ? '  ' + Math.round(fs.statSync(sp).size / 1024) + 'KB' : ''));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('');
console.log('  ' + '─'.repeat(74));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
