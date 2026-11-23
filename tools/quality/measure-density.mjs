#!/usr/bin/env node
/**
 * D2 信息密度度量（自研）
 *
 * 为什么需要：
 *   矩阵 D2 之前记「部分」，证据只有「20 面板但无密度度量」——
 *   **面板数量不是密度**。密度是「一屏里有多少可用信息、占多少面积」，
 *   这可以量出来，也必须量出来，否则「界面比它密/疏」永远是感觉。
 *
 * 量什么（都是可从 DOM 直接算的）：
 *   1. 视口面积 vs 内容面积         → 填充率（有内容的地方占多少）
 *   2. 一行里承载的信息单元数        → 行密度
 *   3. 可见文本字符总数 / 视口面积   → 字符密度（信息浓度）
 *   4. 交互元素数 / 视口面积         → 可操作密度
 *   5. 留白比例（无文本无控件的块）  → 疏密
 *
 * 输出可复算的 JSON：同一份前端在任何时候跑，数字应当一致（±渲染抖动）。
 *
 * 用法：
 *   node tools/quality/measure-density.mjs --url=<页面URL> [--label=名字]
 *   node tools/quality/measure-density.mjs --url=... --compare=<另一个.json>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(REPO, 'evidence/density.json');

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

const URL_ARG = arg('url');
const LABEL = arg('label', '未命名');
const COMPARE = arg('compare');

if (!URL_ARG && !COMPARE) {
  console.error('用法: node tools/quality/measure-density.mjs --url=<URL> [--label=名字]');
  console.error('  或: node tools/quality/measure-density.mjs --compare=evidence/density.json');
  process.exit(2);
}

// ── --compare：只读已有结果，做对比 ──
if (COMPARE) {
  const cur = JSON.parse(fs.readFileSync(path.join(REPO, COMPARE), 'utf8'));
  console.log('');
  console.log('  信息密度对比');
  console.log('  ' + '─'.repeat(72));
  const rows = Array.isArray(cur.measurements) ? cur.measurements : [cur];
  const keys = ['viewportArea', 'contentArea', 'fillRatio', 'charsPerKpx', 'interactivePerKpx', 'whitespaceRatio', 'rowDensity'];
  console.log('  ' + '指标'.padEnd(20) + rows.map((r) => String(r.label).padEnd(18)).join(''));
  for (const k of keys) {
    console.log('  ' + k.padEnd(20) + rows.map((r) => String(r.metrics?.[k] ?? r[k] ?? '-').padEnd(18)).join(''));
  }
  console.log('');
  process.exit(0);
}

function findBrowser() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((p) => fs.existsSync(p)) || null;
}

const browser = findBrowser();
if (!browser) {
  console.error('  没有浏览器，无法度量（UNKNOWN，不当成通过）');
  process.exit(2);
}

/**
 * 注入到页面里跑的度量脚本。
 * 只用标准 DOM API，不依赖任何框架；返回纯数据。
 */
const PROBE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const viewportArea = vw * vh;

  // 1) 内容面积：所有"有可见内容"的元素的外接面积之和（去重，取最外层可见块）
  const blocks = [...document.querySelectorAll('body *')].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    return true;
  });
  // 内容面积用"叶子可见块"的并集近似：取所有含直接文本节点的块
  const textBlocks = blocks.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0));
  let contentArea = 0;
  for (const el of textBlocks) {
    const r = el.getBoundingClientRect();
    contentArea += r.width * r.height;
  }
  contentArea = Math.min(contentArea, viewportArea); // 重叠不应超过视口

  // 2) 字符密度：可见文本总字符 / 千像素面积
  const visibleText = (() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let s = '';
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent;
      if (!t || !t.trim()) continue;
      const p = n.parentElement;
      if (!p) continue;
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = p.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom < 0 || r.top > vh) continue;   // 只算视口内
      s += t.trim();
    }
    return s;
  })();
  const chars = visibleText.length;

  // 3) 交互密度
  const interactive = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    }).length;

  // 4) 留白比例：视口里既无文本块也无交互元素的区域
  //    近似：1 - (文本块并集面积 + 交互元素面积) / 视口
  const rects = [
    ...textBlocks.map((el) => el.getBoundingClientRect()),
    ...[...document.querySelectorAll('button, a, input')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0),
  ];
  // 用 16x16 网格采样估计被覆盖的比例（够用且快）
  const G = 16;
  let covered = 0, total = 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const x = (gx + 0.5) * vw / G, y = (gy + 0.5) * vh / G;
      total++;
      if (rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) covered++;
    }
  }
  const coverageRatio = covered / total;

  // 5) 行密度：平均每个"行式容器"里有多少子项
  const rowContainers = [...document.querySelectorAll('[class*="row"], [class*="item"], li, tr')]
    .filter((el) => el.getBoundingClientRect().height > 0 && el.children.length > 0);
  const rowDensity = rowContainers.length
    ? Math.round((rowContainers.reduce((a, el) => a + el.children.length, 0) / rowContainers.length) * 100) / 100
    : 0;

  return {
    viewport: { w: vw, h: vh },
    viewportArea,
    contentArea: Math.round(contentArea),
    fillRatio: Math.round((contentArea / viewportArea) * 1000) / 1000,
    chars,
    charsPerKpx: Math.round((chars / (viewportArea / 1000)) * 100) / 100,
    interactive,
    interactivePerKpx: Math.round((interactive / (viewportArea / 1000)) * 100) / 100,
    whitespaceRatio: Math.round((1 - coverageRatio) * 1000) / 1000,
    textBlocks: textBlocks.length,
    rowDensity,
    sample: visibleText.slice(0, 80)
  };
})()`;

const tmp = path.join(os.tmpdir(), 'density-' + process.pid);
fs.mkdirSync(tmp, { recursive: true });

// 用 --dump-dom 拿不到运行时度量，所以改用 CDP 的方式：--headless + --repl 不可用
// 最稳的做法：注入一个把结果写进 DOM 的脚本，再 dump-dom 读回来。
// 但目标页不归我们控制 —— 所以用 Edge 的 --run-all-compositor-stages-before-draw + evaluate 不可行。
// 折中：起一个本地服务做代理注入（我们已有 tools/run-vouch-src.mjs 这样的模式）。
// 这里直接对「我们自己的前端」用代理注入。

const PROXY = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const TARGET = ${JSON.stringify(URL_ARG)};
const PROBE = ${JSON.stringify(PROBE)};
const server = http.createServer(async (req, res) => {
  try {
    const r = await fetch(TARGET.replace(/\\/$/, '') + req.url, { headers: { 'accept': req.headers.accept || '*/*' } });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html')) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': ct }).end(buf);
      return;
    }
    let html = await r.text();
    const inject = '<script>window.addEventListener("load",()=>{setTimeout(()=>{let out;try{out=JSON.stringify(' + PROBE + ');}catch(e){out=JSON.stringify({error:String(e)});}document.title="DENSITY::"+btoa(unescape(encodeURIComponent(out)));},1200);});</script>';
    html = html.replace('</head>', inject + '</head>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  } catch (e) {
    res.writeHead(502).end('proxy error: ' + e.message);
  }
});
server.listen(Number(process.env.PORT || 48031), '127.0.0.1', () => console.log('READY'));
setTimeout(() => process.exit(0), 120000);
`;

fs.writeFileSync(path.join(tmp, 'proxy.mjs'), PROXY, 'utf8');
const child = spawn(process.execPath, [path.join(tmp, 'proxy.mjs')], {
  env: { ...process.env, PORT: '48031' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = false;
await new Promise((res) => {
  const t = setTimeout(res, 8000);
  child.stdout.on('data', (b) => { if (String(b).includes('READY')) { ready = true; clearTimeout(t); res(); } });
});

if (!ready) {
  console.log('  代理没起来，判不了');
  child.kill();
  process.exit(2);
}

let dom = '';
try {
  dom = execFileSync(browser, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1440,900',
    '--user-data-dir=' + path.join(tmp, 'p'),
    '--virtual-time-budget=25000', '--dump-dom',
    'http://127.0.0.1:48031/',
  ], { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) { dom = (e.stdout || '') + ''; }
child.kill();

const titleHit = dom.match(/<title>DENSITY::([A-Za-z0-9+/=]+)<\/title>/);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

if (!titleHit) {
  console.log('');
  console.log('  ✗ 没拿到密度数据（页面没跑完或注入失败）—— 判不了，不当成通过');
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), error: 'no probe result', url: URL_ARG }, null, 2) + '\n', 'utf8');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(2);
}

let metrics;
try { metrics = JSON.parse(Buffer.from(titleHit[1], 'base64').toString('utf8')); }
catch (e) { metrics = { error: 'parse failed: ' + e.message }; }

const record = { label: LABEL, url: URL_ARG, at: new Date().toISOString(), metrics };

// 追加到已有 measurements
let store = { what: '信息密度度量（D2）', rule: '全部从 DOM 直接算，可复算', measurements: [] };
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (Array.isArray(prev.measurements)) store = prev;
  } catch { /* 忽略 */ }
}
store.measurements = store.measurements.filter((x) => x.label !== LABEL).concat(record);
fs.writeFileSync(OUT, JSON.stringify(store, null, 2) + '\n', 'utf8');

console.log('');
console.log('  信息密度度量 —— ' + LABEL);
console.log('  ' + '─'.repeat(64));
if (metrics.error) {
  console.log('  ✗ 度量出错: ' + metrics.error);
} else {
  console.log('  视口            ' + metrics.viewport.w + '×' + metrics.viewport.h + '  (' + metrics.viewportArea + ' px²)');
  console.log('  填充率          ' + (metrics.fillRatio * 100).toFixed(1) + '%');
  console.log('  留白比例        ' + (metrics.whitespaceRatio * 100).toFixed(1) + '%');
  console.log('  字符密度        ' + metrics.charsPerKpx + ' 字符/千像素（共 ' + metrics.chars + ' 字符）');
  console.log('  交互密度        ' + metrics.interactivePerKpx + ' 个/千像素（共 ' + metrics.interactive + ' 个）');
  console.log('  行密度          ' + metrics.rowDensity + ' 子项/行');
  console.log('  文本块          ' + metrics.textBlocks + ' 个');
}
console.log('');
console.log('  → ' + path.relative(REPO, OUT));
console.log('');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(metrics.error ? 1 : 0);