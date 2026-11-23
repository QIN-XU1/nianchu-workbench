#!/usr/bin/env node
/**
 * 界面层验证（替代旧的「连 hermes 桌面端 CDP 9333」）
 *
 * 为什么换掉旧做法：
 *   旧 R8 靠 CDP 9333 连 hermes 桌面端来验界面。但我们现在的主线前端是
 *   apps/vouch-web（fork 的 OpenBitFun 源码，MIT），跟那个桌面端无关。
 *   继续用旧判据等于「拿一个不存在的环境判一个不存在的界面」——
 *   那会永远 UNKNOWN，或者更糟：逼着人把它当成失败/假装通过。
 *
 * 现在验的是**真的东西**，四层：
 *   1. 产物：apps/vouch-web/dist 存在且有 index.html + 主包
 *   2. 启动：静态服务能起来，HTTP 200
 *   3. 渲染：无头浏览器打开后，DOM 里出现它自己的界面结构（侧栏项/场景栏/窗口控件）
 *   4. 品牌：页面标题与欢迎语是我们自己的（念初 / Nianchu），没有旧名残留
 *
 * 四态：dist 不存在 / 没浏览器 → UNKNOWN(退出 2)，不当成通过。
 *
 * 用法：node verify-ui-layer.mjs
 *       node verify-ui-layer.mjs --selftest
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const DIST = path.join(REPO, 'apps/vouch-web/dist');
const SERVER = path.join(REPO, 'tools/run-vouch-src.mjs');
const PORT = 48021;

// 阈值：集中成常量，自检与正式判定共用同一套，避免两处漂移
const MIN_DOM = 50000;   // DOM 至少这么大才算真渲染出内容（空白页远小于它）
const MIN_JS = 50;       // 真实多 chunk 构建产物
const MIN_CSS = 5;

/** 它自己的界面结构（这些类名只有真实前端才有） */
export const STRUCT = [
  ['openbitfun-workspace-body', '外壳容器'],
  ['openbitfun-nav-panel', '侧栏面板'],
  ['openbitfun-nav-bar', '导航条'],
  ['openbitfun-scene-top-bar', '场景顶栏'],
  ['window-controls__btn', '窗口控件'],
];

// ════════════════════════════════════════════════════════════════════
//  四项核心判定（全部纯函数，自检可注入假产物/假 DOM）
// ════════════════════════════════════════════════════════════════════

/** 1. 产物判定 —— 只看 dist 里到底有什么 */
export function judgeArtifact(a = {}, opt = {}) {
  const jsMin = opt.jsMin ?? MIN_JS;
  const cssMin = opt.cssMin ?? MIN_CSS;
  const files = Array.isArray(a.files) ? a.files : [];
  return [
    { ok: files.includes('index.html'), msg: 'dist/index.html 在位' },
    { ok: Number(a.jsCount) > jsMin, msg: 'assets 有 ' + a.jsCount + ' 个 js（真实多 chunk 构建）' },
    { ok: Number(a.cssCount) > cssMin, msg: 'assets 有 ' + a.cssCount + ' 个 css' },
    { ok: !!a.brandMark, msg: '品牌标记资产在位' },
  ];
}

/** 2. 启动判定 */
export function judgeServe(ready, port = PORT) {
  return [{ ok: !!ready, msg: '静态服务就绪 127.0.0.1:' + port }];
}

/**
 * 3. 渲染判定 —— DOM 内容 + 界面结构
 *
 * 【为什么不能只看产物】「dist 有 index.html、有 2000 个 js」只能证明**构建过了**，
 * 证明不了页面真渲染出来。构建产物齐全但一打开是空白（JS 报错、路由 404、
 * 后端未注入 boot 等），DOM 就是空的 —— 这正是「产物存在 ≠ 渲染成功」。
 * 所以渲染必须单独判：DOM 体积要够，且必须出现只有真实前端才有的结构类名。
 */
export function judgeRender(dom, struct = STRUCT, opt = {}) {
  const s = typeof dom === 'string' ? dom : '';
  const minLen = opt.minDomLen ?? MIN_DOM;
  const out = [{ ok: s.length > minLen, msg: 'DOM 渲染出 ' + Math.round(s.length / 1024) + 'KB 内容' }];
  for (const [cls, label] of struct) out.push({ ok: s.includes(cls), msg: '渲染出' + label + '（.' + cls + '）' });
  return out;
}

/** 4. 品牌判定 —— 渲染成功还不够，得是我们自己的界面 */
export function judgeBrand(dom) {
  const s = typeof dom === 'string' ? dom : '';
  const title = (s.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  return [
    { ok: /念初|Nianchu/.test(title), msg: '页面标题是我们的：' + (title || '(空)') },
    { ok: /念初/.test(s), msg: '页面出现「念初」' },
    { ok: !/四鉴|四鑒/.test(s), msg: '没有旧名残留（四鉴/四鑒）' },
    { ok: !/authored inner and outer contours/.test(s), msg: '品牌标记契约校验通过（没有崩）' },
  ];
}

/**
 * 四项总判定：产物 → 启动 → 渲染 → 品牌
 *
 * 输入是「已经采到的观测」，不是现场动作 —— 这样才能在自检里喂「产物齐全但 DOM 空」
 * 这种真实环境很难复现的假绿。
 */
export function judgeUiLayer(input = {}, opt = {}) {
  const unknown = [];
  const verdicts = [];
  if (!input.distExists) {
    unknown.push('没有 apps/vouch-web/dist —— 先构建（pnpm --dir apps/vouch-web/src/web-ui exec vite build）');
    return { verdicts, unknown, pass: 0, fail: 0 };
  }
  verdicts.push(...judgeArtifact(input.artifact || {}, opt));
  if (!input.browserFound) {
    unknown.push('没有 Edge/Chrome，渲染层判不了');
  } else {
    verdicts.push(...judgeServe(input.serverReady, input.port ?? PORT));
    verdicts.push(...judgeRender(input.dom, opt.struct || STRUCT, opt));
    verdicts.push(...judgeBrand(input.dom));
  }
  const pass = verdicts.filter((v) => v.ok).length;
  return { verdicts, unknown, pass, fail: verdicts.length - pass };
}

/**
 * 自检 —— 反例全打「产物存在 ≠ 渲染成功」「大 ≠ 对」「UNKNOWN 不当通过」
 *
 * 【为什么必须有】这个验收器最容易被「构建成功」骗：只要 dist 在、服务能起，
 * 人工看一眼觉得「有页面」就签收了。可空白页也能构建成功、服务也能起。
 * 下面的反例把「产物全绿但页面空」构造出来，断言整体必须红。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const goodArtifact = { files: ['index.html'], jsCount: 2413, cssCount: 109, brandMark: true };
  const structMarkup = STRUCT.map(([c]) => '<div class="' + c + '"></div>').join('');
  const goodDom = '<html><head><title>念初 Nianchu — agent 工作台</title></head><body>'
    + structMarkup + '念初' + 'x'.repeat(60000) + '</body></html>';

  // ── 反例 1（核心）：产物四项全绿，但页面渲染成空白 → 整体不许通过 ──
  //   产物存在 ≠ 渲染成功：这正是「构建过了」冒充「界面能用」的假绿。
  const r1 = judgeUiLayer({ distExists: true, artifact: goodArtifact, browserFound: true, serverReady: true, dom: '' });
  // verdicts 顺序：0-3 产物 / 4 启动 / 5-10 渲染 / 11-14 品牌
  T('反例 · 产物齐全但渲染空白（DOM 空）→ 整体不通过（产物存在 ≠ 渲染成功）',
    r1.verdicts.slice(0, 4).every((v) => v.ok) && r1.verdicts.slice(5, 11).every((v) => !v.ok) && r1.fail > 0,
    'pass=' + r1.pass + ' fail=' + r1.fail);

  // ── 反例 2：DOM 体积很大但没有界面结构类 → 只看大小会误判 ──
  //   把任意 60KB 的错误页/白屏都当成「渲染成功」，是对「渲染」最粗的误读。
  const fatNoStruct = '<html><head><title>x</title></head><body>' + 'y'.repeat(60000) + '</body></html>';
  const r2 = judgeRender(fatNoStruct);
  T('反例 · DOM 够大但没有界面结构类 → 结构判定必须红（大 ≠ 渲染出了界面）',
    r2[0].ok === true && r2.slice(1).every((v) => !v.ok), JSON.stringify(r2.map((v) => v.ok)));

  // ── 反例 3：结构都在、体积够，但标题是旧名「四鉴」→ 品牌不通过 ──
  //   渲染成功还不够：得确认渲染的是**我们自己的**界面，不是旧名残留的壳。
  const oldDom = '<html><head><title>四鉴 工作台</title></head><body>'
    + structMarkup + 'x'.repeat(60000) + '</body></html>';
  const r3 = judgeBrand(oldDom);
  T('反例 · 标题是旧名「四鉴」→ 品牌判定红（渲染成功也要验品牌是我们自己的）',
    r3[0].ok === false && r3[2].ok === false, JSON.stringify(r3.map((v) => v.ok)));

  // ── 反例 4：阈值边界 —— css 恰好 5 / js 恰好 50（判据是「大于」）→ 必须红 ──
  const r4a = judgeArtifact({ files: ['index.html'], jsCount: 51, cssCount: 5, brandMark: true });
  const r4b = judgeArtifact({ files: ['index.html'], jsCount: 50, cssCount: 6, brandMark: true });
  T('反例 · css=5 / js=50 恰好不超阈值 → 判红（边界是「大于」不是「等于」）',
    r4a[2].ok === false && r4b[1].ok === false, JSON.stringify({ a: r4a.map((v) => v.ok), b: r4b.map((v) => v.ok) }));

  // ── 反例 5：dist 里没有 index.html → 产物红 ──
  const r5 = judgeArtifact({ files: [], jsCount: 2413, cssCount: 109, brandMark: true });
  T('反例 · dist 里没有 index.html → 产物红', r5[0]?.ok === false, JSON.stringify(r5.map((v) => v.ok)));

  // ── 反例 6：没有浏览器 → 渲染层无法判断，必须记 unknown，绝不当成通过 ──
  const r6 = judgeUiLayer({ distExists: true, artifact: goodArtifact, browserFound: false });
  T('反例 · 没浏览器 → 渲染层记 unknown（不许当通过）',
    r6.unknown.length === 1 && r6.pass === 4 && r6.fail === 0,
    JSON.stringify({ pass: r6.pass, fail: r6.fail, unknown: r6.unknown }));

  // ── 反例 7：dist 不存在 → 整体 unknown、零断言（不是通过也不是失败）──
  const r7 = judgeUiLayer({ distExists: false });
  T('反例 · dist 不存在 → 记 unknown，不是通过也不是失败',
    r7.unknown.length === 1 && r7.pass === 0 && r7.fail === 0, JSON.stringify(r7));

  // ── 正例：完整好页面 → 15 项全绿（与真实基线 15/0 对齐，证明判据不是「永远红」）──
  const r8 = judgeUiLayer({ distExists: true, artifact: goodArtifact, browserFound: true, serverReady: true, dom: goodDom });
  T('正例 · 产物 + 启动 + 渲染 + 品牌四项齐全 → 15 项全绿',
    r8.pass === 15 && r8.fail === 0 && r8.unknown.length === 0,
    JSON.stringify({ pass: r8.pass, fail: r8.fail }));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  界面层验证 · 自检（1 正例 + 7 反例，反例全打「产物存在 ≠ 渲染成功」）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// ════════════════════════════════════════════════════════════════════
//  正式验证（只在直接运行时执行）
// ════════════════════════════════════════════════════════════════════

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };
const un = (m) => { unknown++; console.log('  ' + I.un + ' ' + m); };

function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((p) => fs.existsSync(p)) || null;
}

console.log('');
console.log('  界面层验证 —— 我们自己的前端（apps/vouch-web）');
console.log('  ' + '─'.repeat(72));

// 采集观测（产物 / 启动 / 渲染），判定交给纯函数
const input = { distExists: fs.existsSync(DIST), browserFound: false, serverReady: false, dom: '', port: PORT };

if (input.distExists) {
  const files = fs.readdirSync(DIST);
  const assetsDir = path.join(DIST, 'assets');
  const jsFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : [];
  const cssFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css')) : [];
  input.artifact = {
    files,
    jsCount: jsFiles.length,
    cssCount: cssFiles.length,
    brandMark: fs.existsSync(path.join(DIST, 'brand/openbitfun-mark.svg')),
  };

  const browser = findBrowser();
  input.browserFound = !!browser;
  if (browser) {
    const tmp = path.join(os.tmpdir(), 'ui-verify-' + process.pid);
    fs.mkdirSync(tmp, { recursive: true });
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ROOT: DIST, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    await new Promise((res) => {
      const t = setTimeout(res, 10000);
      child.stdout.on('data', (b) => { if (String(b).includes('READY')) { ready = true; clearTimeout(t); res(); } });
    });
    input.serverReady = ready;

    let dom = '';
    try {
      dom = execFileSync(browser, [
        '--headless', '--disable-gpu', '--no-sandbox',
        '--user-data-dir=' + path.join(tmp, 'p'),
        '--virtual-time-budget=25000', '--dump-dom',
        'http://127.0.0.1:' + PORT + '/',
      ], { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { dom = (e.stdout || '') + ''; }
    child.kill();
    input.dom = dom;

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

const r = judgeUiLayer(input);

// dist 不存在：UNKNOWN 早退（保持原行为，不打印分隔线）
if (!input.distExists) {
  for (const m of r.unknown) un(m);
  console.log('\n  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown + '\n');
  process.exit(2);
}

for (const v of r.verdicts) ok(v.ok, v.msg);
for (const m of r.unknown) un(m);

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
