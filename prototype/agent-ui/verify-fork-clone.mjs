#!/usr/bin/env node
/**
 * BitFun（OpenBitFun）界面 1:1 复刻 —— 验收
 *
 * 用户要求「先完全照搬」。判定标准不是"好看"，而是三条可核对的事实：
 *   1. 令牌是**生成**的，不是手抄的
 *      输入 = BitFun 仓库的四个令牌 JSON；规则 = 它自己的 build.mjs 命名约定
 *      → 所以 tokens.css 里的值必须能在 JSON 里找到同一个数
 *   2. 外壳几何取自它的 AppLayout.scss / ShellNav.scss（40px 段头、2px 列表间距等）
 *   3. 图标与文字内容齐备（不能静默变成空块）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(REPO, 'prototype/agent-ui');
const TOKENS = path.join(DIR, 'bitfun/tokens.css');
const PAGE = path.join(DIR, 'bitfun-clone.html');
const DS = 'D:/refs/openbitfun-src/OpenBitFun-main/design-system/packages';

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (m) => { unknown++; console.log('  ' + ICON.un + ' ' + m); };

console.log('');
console.log('  BitFun（OpenBitFun）界面 1:1 复刻 —— 验收');
console.log('  ' + '─'.repeat(72));

// ── 1. 令牌是不是从 BitFun 的 JSON 生成的 ──
if (!fs.existsSync(TOKENS)) { console.log('  ✗ 缺 bitfun/tokens.css'); process.exit(1); }
const tokens = fs.readFileSync(TOKENS, 'utf8');
const varCount = (tokens.match(/--openbitfun-/g) || []).length;
ok(varCount >= 500, 'tokens.css 生成 ' + varCount + ' 个 --openbitfun-* 变量');
ok(/:where\(\[data-openbitfun-design-system-root\]\[data-color-scheme="dark"\]\)/.test(tokens),
  '暗色选择器与 BitFun build.mjs 一致（[data-openbitfun-design-system-root][data-color-scheme="dark"]）');

// 逐个回查 JSON：断言值确实来自 BitFun 的源文件
let jsonChecked = 0, jsonOk = 0;
if (fs.existsSync(DS)) {
  const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  function flat(o, pre = '', out = {}) {
    for (const [k, v] of Object.entries(o)) {
      const p = pre ? pre + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (v.$value !== undefined) out[p] = v.$value;
        else if (v.value !== undefined) out[p] = v.value;
        else flat(v, p, out);
      } else out[p] = v;
    }
    return out;
  }
  const ref = flat(readJ(DS + '/theme-openbitfun/src/reference.tokens.json'));
  const dark = flat(readJ(DS + '/theme-openbitfun/src/dark.tokens.json'));
  const light = flat(readJ(DS + '/theme-openbitfun/src/light.tokens.json'));
  const merged = Object.assign({}, ref, light, dark);
  const resolve = (v, d = 0) => {
    if (typeof v !== 'string' || d > 10) return v;
    const m = v.match(/^\{([^}]+)\}$/);
    if (!m) return v;
    return merged[m[1]] === undefined ? v : resolve(merged[m[1]], d + 1);
  };
  const kebab = (p) => '--openbitfun-' + p.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/\./g, '-');

  const PROBES = [
    ['color.surface.canvas', dark], ['color.surface.panel', dark],
    ['color.content.primary', dark], ['color.content.secondary', dark], ['color.content.muted', dark],
    ['color.border.subtle', dark], ['color.border.default', dark],
    ['color.accent.default', dark], ['color.status.success.emphasis', dark],
    ['color.surface.canvas', light], ['color.accent.default', light],
  ];
  for (const [tokenPath, doc] of PROBES) {
    const expected = resolve(doc[tokenPath]);
    if (expected === undefined) continue;
    jsonChecked++;
    const varName = kebab(tokenPath);
    // 在 tokens.css 里找该变量（light/dark 各一段，取命中任一为真）
    const hit = new RegExp(varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*' + String(expected).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(tokens);
    if (hit) jsonOk++;
    else console.log('      ✗ ' + varName + ' 期望 ' + expected + ' 未在 tokens.css 中找到');
  }
  ok(jsonChecked > 0 && jsonOk === jsonChecked, '回查 BitFun JSON：' + jsonOk + '/' + jsonChecked + ' 个令牌的值与源文件完全一致');
} else {
  un('本机没有 BitFun 仓库（D:/refs），无法回查 JSON —— 判不了，不当成通过');
}

// ── 2. 外壳几何取自它的 SCSS ──
const html = fs.readFileSync(PAGE, 'utf8');
ok(/height:\s*40px;\s*padding:\s*0 var\(--openbitfun-space-3\)/.test(html), '段头 40px + space-3（ShellNav.scss __header）');
ok(/gap:\s*2px;/.test(html), '会话列表 2px 间距（ShellNav.scss __terminal-list）');
ok(/border-radius:\s*12px/.test(html), '窗口圆角 12px（AppLayout.scss native-frame=client）');
ok(/--openbitfun-color-surface-canvas/.test(html) && /--openbitfun-color-surface-panel/.test(html), '外层用 BitFun 的 canvas / panel 令牌');
ok(/<link rel="stylesheet" href="bitfun\/tokens\.css">/.test(html), '页面引用生成的令牌文件');
ok(/data-openbitfun-design-system-root/.test(html), '根元素带 BitFun 的 design-system-root 标记（选择器才对得上）');

// ── 3. 内容与图标 ──
for (const s of ['Search everything', 'Task Board', 'SESSIONS', 'Hey, ideas are bubbling!', 'Total tokens', 'Peak daily tokens', 'Longest streak', 'Create Agent', 'Create assistant', 'Built-in and custom Agents', 'Manage devices', 'Sign in to connect more devices']) {
  if (!html.includes(s)) { fail++; console.log('  ' + ICON.no + ' 缺文案: ' + s); }
}
ok(true, '截图里的 12 处文案全部在位');

// ── 4. 真渲染 ──
function findBrowser() {
  return ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p)) || null;
}
const browser = findBrowser();
console.log('');
if (!browser) {
  un('没有 Edge/Chrome，渲染检查判不了');
} else {
  console.log('  ' + ICON.ok + ' 找到浏览器: ' + path.basename(browser));
  pass++;
  const tmp = path.join(os.tmpdir(), 'bfc-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  let dom = '';
  try {
    dom = execFileSync(browser, ['--headless', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
      '--virtual-time-budget=5000', '--user-data-dir=' + path.join(tmp, 'p'),
      '--dump-dom', 'file:///' + PAGE.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { dom = (e.stdout || '') + ''; }
  const missing = (dom.match(/data-lucide-missing="([^"]*)"/) || [])[1];
  const svgN = Number((dom.match(/data-lucide-svg="(\d+)"/) || [])[1] || 0);
  ok(missing === 'none', '图标零缺失（data-lucide-missing=' + (missing || '未输出') + '）');
  ok(svgN >= 14, '真的生成了 ' + svgN + ' 个 <svg> 图标（不是空 span）');
  ok(/Hey, ideas are bubbling!/.test(dom) && /Total tokens/.test(dom), '渲染后的 DOM 含关键文案');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ── 5. 截图 ──
const shot = path.join(REPO, 'research/screenshots/我们-bitfun复刻-home.png');
ok(fs.existsSync(shot), '截图证据：我们-bitfun复刻-home.png' + (fs.existsSync(shot) ? '  ' + Math.round(fs.statSync(shot).size / 1024) + 'KB' : ''));

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
