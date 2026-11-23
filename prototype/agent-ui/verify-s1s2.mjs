#!/usr/bin/env node
/**
 * S1 + S2 验收
 *
 * S1 令牌层：颜色不是"看着行"，是**算出来的**。
 *   · WCAG 对比度实测（明暗两套 × 4 级文字 × 2 个表面）
 *   · 密度只缩放间距，不改字号（可断言）
 *   · 没有悬空 var(--x)
 * S2 外壳：注册表驱动 + 路由不变量 + 真渲染
 *   · 注册表 8 个场景，每个都有视图（一一对应）
 *   · 常驻场景不可关闭；active 必在 open 内；刷新保持
 *   · 真跑一遍：侧栏项数、SceneBar 标签、场景切换
 *
 * 四态：缺产物/缺浏览器 → UNKNOWN(退出 2)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const APP = path.join(REPO, 'apps/agent-ui');
const TOKENS = path.join(APP, 'src/tokens/tokens.css');
const DIST = path.join(APP, 'dist');

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };
const un = (m) => { unknown++; console.log('  ' + I.un + ' ' + m); };

console.log('');
console.log('  S1 + S2 验收 —— 令牌层与外壳');
console.log('  ' + '─'.repeat(76));

if (!fs.existsSync(TOKENS)) { console.log('  ✗ 缺 tokens.css（先 node tools/gen-tokens.mjs）'); process.exit(1); }
const css = fs.readFileSync(TOKENS, 'utf8');

// ══ 1. 令牌提取：把两套主题的变量分别解析出来 ══
// 先把注释整段剥掉再解析块。
// 上一版没剥，`[^{}]{0,220}` 会被前面的注释吃掉导致选择器被截断，
// 于是 ^:root, [data-vouch-root]$ 这种锚点匹配永远失败（实测返回 0 个令牌）。
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

function blockVars(re) {
  const out = new Map();
  const rx = /([^{}]{0,220})\{([^{}]*)\}/g;
  let m;
  while ((m = rx.exec(cssNoComments))) {
    // 选择器前面常带一段注释（/* 亮色语义色 */），必须剥掉再判断，
    // 否则 ^...$ 的锚点匹配永远失败（第一版就栽在这）。
    const sel = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    if (!re.test(sel)) continue;
    for (const d of m[2].matchAll(/(--openbitfun-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
      if (!/var\(--/.test(d[2])) out.set(d[1], d[2].trim());
    }
  }
  return out;
}
const light = blockVars(/data-color-scheme="light"/);
const dark = blockVars(/data-color-scheme="dark"/);
const plain = blockVars(/^:root, \[data-vouch-root\]$/);
const compact = blockVars(/data-density="compact"/);
const cozy = blockVars(/data-density="cozy"/);

ok(light.size > 100 && dark.size > 100, '明暗两套语义色齐备（亮 ' + light.size + ' / 暗 ' + dark.size + '）');
ok(plain.size > 500, '与主题无关令牌 ' + plain.size + ' 个');

// ══ 2. WCAG 对比度实测 ══
function parseColor(v) {
  if (!v) return null;
  const s = v.trim();
  let m;
  if ((m = s.match(/^#([0-9a-f]{6})$/i))) {
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  }
  if ((m = s.match(/^#([0-9a-f]{3})$/i))) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
  }
  if ((m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/i))) {
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  }
  return null; // color-mix 等一律跳过，不猜
}
function over(fg, bg) {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}
function lum(c) {
  const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// 门槛说明：WCAG 2.x 对「禁用控件」的对比度是明确豁免的，
// 所以 content-disabled 不设下限，改为断言它确实比 secondary 更弱（真的被弱化了）。
// 上一版拿 3:1 去卡禁用态，是我的判据错，不是令牌错。
const LEVELS = [
  ['content-primary', 'color-content-primary', 7],
  ['content-secondary', 'color-content-secondary', 4.5],
  ['content-muted', 'color-content-muted', 4.5],
  ['content-disabled', 'color-content-disabled', 0],
];
const SURFACES = ['color-surface-canvas', 'color-surface-chrome', 'color-surface-panel'];

const measured = [];
let contrastFails = 0;
for (const [mode, map] of [['亮', light], ['暗', dark]]) {
  for (const surf of SURFACES) {
    const bg = parseColor(map.get('--openbitfun-' + surf));
    if (!bg) continue;
    for (const [label, key, min] of LEVELS) {
      const fgRaw = parseColor(map.get('--openbitfun-' + key));
      if (!fgRaw) continue;
      const fg = fgRaw[3] < 1 ? over(fgRaw, bg) : fgRaw;
      const r = ratio(fg, bg);
      measured.push([mode, surf.replace('color-surface-', ''), label, r, min]);
      if (r < min) contrastFails++;
    }
  }
}
ok(measured.length >= 16, '对比度实测样本 ' + measured.length + ' 组（明暗 × 3 表面 × 4 级文字）');
ok(contrastFails === 0, '全部达到门槛（' + measured.length + ' 组，禁用态按 WCAG 豁免不设下限）' + (contrastFails ? '  ← ' + contrastFails + ' 组不达标' : ''));

// 禁用态虽豁免，但必须"确实更弱"，否则它就失去了语义
const byKey = (mode, surf, label) => {
  const hit = measured.find((r) => r[0] === mode && r[1] === surf && r[2] === label);
  return hit ? hit[3] : null;
};
let deemphBad = 0;
for (const mode of ['亮', '暗']) {
  for (const surf of ['canvas', 'chrome', 'panel']) {
    const sec = byKey(mode, surf, 'content-secondary');
    const dis = byKey(mode, surf, 'content-disabled');
    if (sec !== null && dis !== null && !(dis < sec)) deemphBad++;
  }
}
ok(deemphBad === 0, '禁用态确实比次要文字更弱（' + (6 - deemphBad) + '/6 组成立）');
console.log('      实测明细（对比度 / 门槛）：');
for (const [mode, surf, label, r, min] of measured) {
  console.log('        ' + mode + ' ' + surf.padEnd(7) + label.padEnd(18) + r.toFixed(2).padStart(6) + '  / ' + min);
}

// ══ 3. 密度只缩放间距，不改字号 ══
// 密度：上游的密度模式只给出一小组令牌（实测 8 个），所以门槛按实际规模定。
// 真正要断言的是两件事：改了间距、没改字号。
if (compact.size || cozy.size) {
  const densityMap = compact.size ? compact : cozy;
  const fontKeys = [...densityMap.keys()].filter((k) => /font-size|fontSize/.test(k));
  ok(fontKeys.length === 0, '密度不改字号' + (fontKeys.length ? '  ← 改了 ' + fontKeys.join(',') : '（' + densityMap.size + ' 个令牌）'));
  const spacingish = [...densityMap.keys()].filter((k) => /space|gap|padding|height|size|block|inline/.test(k));
  ok(spacingish.length >= 5, '密度确实缩放间距（' + spacingish.length + '/' + densityMap.size + ' 个令牌属间距类）');
  // compact 与 cozy 必须真的不同，否则切档没有效果
  const differ = compact.size > 0 && cozy.size > 0 &&
    [...compact.keys()].some((k) => cozy.has(k) && compact.get(k) !== cozy.get(k));
  ok(differ, '紧凑与宽松两档的取值真的不同');
} else {
  fail++; console.log('  ' + I.no + ' 没有生成密度令牌');
}

// ══ 4. 没有悬空 var(--x) ══
if (fs.existsSync(DIST)) {
  const assetsDir = path.join(DIST, 'assets');
  const builtCss = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
  const used = new Set([...builtCss.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const dangling = [...used].filter((v) => !defined.has(v) && !v.startsWith('--vouch'));
  ok(dangling.length === 0, '产物里没有悬空的 var(--x)' + (dangling.length ? '  ← ' + dangling.slice(0, 6).join(', ') : '（用了 ' + used.size + ' 个变量）'));
} else {
  un('没有 dist，悬空变量检查判不了');
}

// ══ 5. S2 注册表与视图一一对应 ══
const regSrc = fs.readFileSync(path.join(APP, 'src/scenes/registry.ts'), 'utf8');
const viewSrc = fs.readFileSync(path.join(APP, 'src/scenes/index.ts'), 'utf8');
const regIds = [...regSrc.matchAll(/\{\s*id:\s*'([a-z]+)'/g)].map((m) => m[1]);
const viewIds = [...viewSrc.matchAll(/^\s{2}([a-z]+):\s/gm)].map((m) => m[1]);
ok(regIds.length === 8, '注册表 8 个场景（' + regIds.join(',') + '）');
const missingView = regIds.filter((id) => !viewIds.includes(id));
ok(missingView.length === 0, '每个场景都有视图实现' + (missingView.length ? '  ← 缺 ' + missingView.join(',') : ''));
ok(/pinned:\s*true/.test(regSrc) && /closable:\s*false/.test(regSrc), '注册表表达了 pinned / closable 语义');

// 路由不变量：读源码断言关键保护
const routeSrc = fs.readFileSync(path.join(APP, 'src/shell/useSceneRoute.ts'), 'utf8');
ok(/DEFAULT_OPEN\.includes\(id\)\)\s*return/.test(routeSrc), '常驻场景不可关闭（有提前 return 保护）');
ok(/localStorage\.setItem\(LS_OPEN/.test(routeSrc) && /localStorage\.setItem\(LS_ACTIVE/.test(routeSrc), 'open 与 active 都持久化');
ok(/hashchange/.test(routeSrc), '监听 hashchange（刷新/后退保持）');
const closeSrc = fs.readFileSync(path.join(APP, 'src/shell/SceneBar.tsx'), 'utf8');
ok(/closable === false \? null/.test(closeSrc), 'SceneBar 对常驻场景不渲染关闭按钮');

// ══ 6. 真渲染 ══
function findBrowser() {
  return ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p)) || null;
}
const browser = findBrowser();
if (!fs.existsSync(DIST)) {
  un('没有 dist，渲染断言判不了');
} else if (!browser) {
  un('没有浏览器，渲染断言判不了');
} else {
  const PORT = 5277;
  const tmp = path.join(os.tmpdir(), 's1s2-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const child = spawn(process.execPath, [path.join(REPO, 'tools/serve-dist.mjs')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  await new Promise((res) => {
    const t = setTimeout(res, 8000);
    child.stdout.on('data', (b) => { if (String(b).includes('READY')) { ready = true; clearTimeout(t); res(); } });
  });
  ok(ready, '静态服务起在 127.0.0.1:' + PORT);

  const dump = (hash, tag) => {
    try {
      return execFileSync(browser, ['--headless', '--disable-gpu', '--no-sandbox',
        '--user-data-dir=' + path.join(tmp, tag), '--virtual-time-budget=6000',
        '--dump-dom', 'http://127.0.0.1:' + PORT + '/#' + hash],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return (e.stdout || '') + ''; }
  };

  const dSession = dump('/session', 'a');
  const navItems = (dSession.match(/class="vp-nav__item"/g) || []).length;
  ok(navItems === 8, '侧栏渲染出 8 个场景项（实测 ' + navItems + '）');
  const tabs = (dSession.match(/class="vp-tab"/g) || []).length;
  ok(tabs >= 3, 'SceneBar 渲染出 ' + tabs + ' 个标签（默认可常驻 3 个）');
  ok(/关闭 总览/.test(dSession) && !/关闭 会话/.test(dSession), '常驻场景没有关闭按钮，普通场景有');
  ok((dSession.match(/class="vp-wctl__btn/g) || []).length === 3, '顶栏有 3 个窗口控件（最小化/最大化/关闭）');
  ok(!/vp-topstrip/.test(dSession) && !/vp-head__title/.test(dSession), '已去掉 OpenBitFun 没有的两样：顶部品牌条与主区大标题行');

  const dVerify = dump('/verify', 'b');
  ok(/验证中心/.test(dVerify), 'hash 直达 /verify 生效（标题切换）');
  const dOverview = dump('/overview', 'c');
  ok(/令牌层/.test(dOverview) && /--openbitfun-\*|openbitfun/.test(dOverview), '总览场景渲染出令牌说明');
  ok((dOverview.match(/_button_[a-z0-9]+_\d+/g) || []).length > 0, '总览里 @openbitfun/ui 按钮真渲染');

  child.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ══ 7. 截图 ══
for (const s of ['我们-S1-令牌.png', '我们-S2-外壳.png']) {
  const p = path.join(REPO, 'research/screenshots', s);
  ok(fs.existsSync(p), '截图证据：' + s + (fs.existsSync(p) ? '  ' + Math.round(fs.statSync(p).size / 1024) + 'KB' : ''));
}

console.log('');
console.log('  ' + '─'.repeat(76));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
