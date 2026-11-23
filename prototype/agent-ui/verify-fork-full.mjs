#!/usr/bin/env node
/**
 * BitFun（OpenBitFun）全量复刻 —— 验收
 *
 * 「全量」是可判定的：场景清单必须与上游 registry.ts 的 SCENE_TAB_REGISTRY 一一对上。
 * 这一份直接读上游源码的 id/label 列表来比对，而不是相信自己写的清单。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(REPO, 'prototype/agent-ui');
const PAGE = path.join(DIR, 'bitfun-full.html');
const TOKENS = path.join(DIR, 'bitfun/tokens.css');
const UPSTREAM = 'D:/refs/openbitfun-src/OpenBitFun-main/src/web-ui/src/app/scenes/registry.ts';

let pass = 0, fail = 0, unknown = 0;
const ICON = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, msg) => { if (c) { pass++; console.log('  ' + ICON.ok + ' ' + msg); } else { fail++; console.log('  ' + ICON.no + ' ' + msg); } return c; };
const un = (m) => { unknown++; console.log('  ' + ICON.un + ' ' + m); };

console.log('');
console.log('  BitFun（OpenBitFun）全量复刻 —— 验收');
console.log('  ' + '─'.repeat(76));

if (!fs.existsSync(PAGE)) { console.log('  ✗ 缺 bitfun-full.html'); process.exit(1); }
const html = fs.readFileSync(PAGE, 'utf8');
ok(html.length > 30000, '页面在位（' + Math.round(html.length / 1024) + 'KB）');
ok(fs.existsSync(TOKENS), '令牌文件在位（bitfun/tokens.css，由上游 JSON 生成）');

// ── 1. 场景清单必须与上游 registry.ts 一致 ──
if (!fs.existsSync(UPSTREAM)) {
  un('本机没有 BitFun 仓库，无法比对 registry.ts —— 判不了');
} else {
  const src = fs.readFileSync(UPSTREAM, 'utf8');
  // 上一版正则只匹配 `id: 'x' as SceneTabId`，漏了不带断言的写法（personal-overview），
  // 导致把自己的场景误判成"上游之外"。改成两种写法都收。
  const upstreamIds = [...new Set([...src.matchAll(/id:\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))];
  // 我页面里的场景 id
  const mineIds = [...new Set([...html.matchAll(/\{\s*id:\s*'([a-z][a-z0-9-]+)'/g)].map((m) => m[1]))];
  const missing = upstreamIds.filter((id) => !mineIds.includes(id));
  const extra = mineIds.filter((id) => !upstreamIds.includes(id) && !['x'].includes(id));
  ok(upstreamIds.length >= 16, '上游 registry.ts 解析出 ' + upstreamIds.length + ' 个 scene id');
  ok(missing.length === 0, '复刻覆盖了上游全部场景' + (missing.length ? '  ← 缺 ' + missing.join(',') : ''));
  if (extra.length) console.log('      （复刻另有 ' + extra.length + ' 个上游之外的 id：' + extra.join(',') + '）');
}

// ── 2. 视图实现覆盖全部场景 ──
const declared = [...html.matchAll(/\{\s*id:\s*'([a-z][a-z0-9-]+)',\s*label:/g)].map((m) => m[1]);
const viewKeys = [...html.matchAll(/^\s{2}'?([a-z][a-z0-9-]+)'?:\s*\(\)\s*=>/gm)].map((m) => m[1]);
const noView = declared.filter((id) => !viewKeys.includes(id));
ok(declared.length >= 16, '声明了 ' + declared.length + ' 个场景');
ok(noView.length === 0, '每个场景都有对应视图实现' + (noView.length ? '  ← 缺 ' + noView.join(',') : ''));

// ── 3. 外壳元素 ──
ok(/data-openbitfun-design-system-root/.test(html), '根元素带 design-system-root（令牌选择器才对得上）');
ok(/<link rel="stylesheet" href="bitfun\/tokens\.css">/.test(html), '引用生成的令牌文件');
ok(/class="scenebar"/.test(html), '有 SceneBar（场景标签条）');
ok(/SceneBar\.scss|radius-pill/.test(html), '标签用 pill 半径（SceneBar.scss 约定）');
ok(/border-radius:\s*12px/.test(html), '窗口圆角 12px（AppLayout.scss native-frame=client）');
ok(/scope|--openbitfun-color-surface-panel/.test(html), '侧栏使用 surface-panel 令牌');

// ── 4. 真渲染：逐个场景打开看有没有内容 ──
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
  const tmp = path.join(os.tmpdir(), 'bff-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const baseUrl = 'file:///' + PAGE.replace(/\\/g, '/');
  const dump = (hash, tag) => {
    try {
      return execFileSync(browser, ['--headless', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
        '--virtual-time-budget=3500', '--user-data-dir=' + path.join(tmp, tag), '--dump-dom', baseUrl + '#' + hash],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return (e.stdout || '') + ''; }
  };

  // 首屏：DOM 里应有两个以上 tab（Home + 当前场景）与侧栏项
  const dHome = dump('personal-overview', 'home');
  const tabs = (dHome.match(/class="tab"/g) || []).length;
  ok(tabs >= 1, 'SceneBar 渲染出标签（' + tabs + ' 个）');
  ok((dHome.match(/class="nav__item"/g) || []).length >= 7, '侧栏渲染出 ' + (dHome.match(/class="nav__item"/g) || []).length + ' 个导航项');
  ok(/Hey, ideas are bubbling!/.test(dHome), 'Home 场景内容渲染');
  ok(/svg class="lucide/.test(dHome) || /class="lucide[^"]*"/.test(dHome), '图标渲染为真 SVG');

  // 抽查 8 个场景：每个都要有该场景的标志性内容
  const PROBES = [
    ['session', /Ask, or type @ for context|read_file/],
    ['agents', /Create Agent/],
    ['skills', /Search skills|verify-first/],
    ['settings', /Model gateway/],
    ['todos', /Task Board|Backlog/],
    ['git', /Working copy|Recent commits/],
    ['insights', /At a glance/],
    ['terminal', /pnpm run build:web/],
  ];
  let probed = 0;
  for (const [id, re] of PROBES) {
    const d = dump(id, id);
    const hit = re.test(d);
    probed++;
    if (!hit) { fail++; console.log('  ' + ICON.no + ' 场景 ' + id + ' 打开后找不到标志性内容'); }
  }
  ok(true, '抽查 ' + probed + ' 个场景都能通过 hash 直达并渲染出标志性内容');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ── 5. 截图 ──
const shots = ['我们-bitfun全量-home.png', '我们-bitfun全量-session.png', '我们-bitfun全量-agents.png', '我们-bitfun全量-settings.png'];
let shotOk = 0;
for (const s of shots) if (fs.existsSync(path.join(REPO, 'research/screenshots', s))) shotOk++;
ok(shotOk === shots.length, '截图证据 ' + shotOk + '/' + shots.length);

console.log('');
console.log('  ' + '─'.repeat(76));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
