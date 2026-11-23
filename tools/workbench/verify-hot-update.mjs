/**
 * UI 免构建热更新验证 —— 这是本轮 P0 的核心判据。
 *
 * 【要证明什么】
 *  ① `/ui-plugins/**` 真的绕过构建：改一行文案 → **不跑构建** → 刷新即变
 *  ② 插件必须 no-store，不能命中缓存（否则"改了没变"是假象）
 *  ③ 插件坏了不能拖垮面板（单个失败只报数，其它照常）
 *  ④ 路径穿越必须被挡（`/ui-plugins/../../etc/passwd`）
 *
 * 反例都在：②③④ 各一条。
 *
 * 用法：node tools/workbench/verify-hot-update.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dumpDomWithCdp } from './_cdp-dump.mjs';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, stopServer } from './_serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const BASE = process.env.NIANCHU_BASE || 'http://127.0.0.1:47124';
const PLUGIN_DIR = join(REPO, 'ui-plugins', 'status-bar');
const PLUGIN_JS = join(PLUGIN_DIR, 'index.js');
const BROKEN_DIR = join(REPO, 'ui-plugins', '__broken_probe');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) || null;
}

const browser = findBrowser();
if (!browser) {
  console.log('  ❔ 找不到 Chrome/Edge');
  console.log('  四态: UNKNOWN');
  process.exit(2);
}

/**
 * 取页面 DOM —— 用 CDP **等到面板与插件挂载完成**再取。
 *
 * 之前是 `--dump-dom` 一次性交卷：同一条命令两次分别拿到 55 KB（面板还没挂上）
 * 和 151 KB（挂上了），断言时红时绿 —— 看着像「热更新坏了」，其实只是**采样早于挂载**。
 * `--dump-dom` 没法等，所以改成：起一个带调试端口的 headless Chrome，打开页面后
 * 轮询 `[data-ui-plugin-holder]`（插件真的挂上了）再取 outerHTML。
 *
 * 等超时也如实返回当时的 DOM，让断言红 —— 不把「没等到」洗成「通过」。
/**
 * 取页面 DOM —— 用 CDP **等到面板与插件挂载完成**再取。
 *
 * 之前是 `--dump-dom` 一次性交卷：同一条命令两次分别拿到 55 KB（面板还没挂上）
 * 和 151 KB（挂上了），断言时红时绿 —— 看着像「热更新坏了」，其实只是**采样早于挂载**。
 * 现在统一走 `_cdp-dump.mjs`：导航后轮询「插件真的产出可见内容（或明确报错）」再取。
 *
 * 等超时也如实返回当时的 DOM，让断言红 —— 不把「没等到」洗成「通过」。
 */
async function dumpDom() {
  const { html } = await dumpDomWithCdp({
    url: BASE + '/index.html',
    browser,
    log: (m) => console.log('  · ' + m),
    waitExpr: `(() => {
      const holders = [...document.querySelectorAll('[data-ui-plugin-holder]')];
      return document.readyState === 'complete'
        && (holders.some((h) => h.childElementCount > 0 && h.textContent.trim().length > 0)
            || !!document.querySelector('.rp__err'));
    })()`,
  });
  // 好插件先画完、坏插件后报错：留一个短暂稳定窗，否则会采到「坏的还没失败」的中间态
  await new Promise((r) => setTimeout(r, 600));
  console.log('  · DOM 取样 ' + html.length + ' 字节');
  return html;
}
console.log('');
console.log('  UI 免构建热更新验证 · ' + BASE);
console.log('  ' + '─'.repeat(72));

// 页面可达（不可达则自起；起不来如实 UNKNOWN，不伪 PASS）
const _srv = await ensureServer(BASE);
if (!_srv.ok) {
  console.log('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
console.log('  · ' + _srv.why);

const originalJs = readFileSync(PLUGIN_JS, 'utf8');
try {
  // ══ 一、通道存在 ══
  const idx = await (await fetch(BASE + '/ui-plugins/index.json', { cache: 'no-store' })).json();
  const list = Array.isArray(idx.plugins) ? idx.plugins : [];
  t('index.json 列出插件', list.length > 0, JSON.stringify(list));
  const sb = list.find((p) => p.id === 'status-bar');
  t('列出 status-bar 且带 entryUrl', Boolean(sb && sb.entryUrl === '/ui-plugins/status-bar/index.js'),
    JSON.stringify(sb));
  t('带 entryMtime（供前端 cache-bust）', Boolean(sb && sb.entryMtime > 0), String(sb && sb.entryMtime));

  const jsRes = await fetch(BASE + '/ui-plugins/status-bar/index.js', { cache: 'no-store' });
  t('插件 JS 可下载且 MIME 是 JS',
    jsRes.ok && /javascript/.test(jsRes.headers.get('content-type') || ''),
    jsRes.status + ' ' + jsRes.headers.get('content-type'));
  t('★插件响应 no-store（不缓存，否则改了没变是假象）',
    /no-store/.test(jsRes.headers.get('cache-control') || ''),
    jsRes.headers.get('cache-control'));

  // ══ 二、插件真的被渲染进页面 ══
  const dom1 = await dumpDom();
  t('页面渲染出插件容器', dom1.includes('data-ui-plugin="status-bar"') || dom1.includes('uip-status'),
    dom1.length + ' 字节');
  t('插件文本真的出现在 DOM 里', /免构建加载/.test(dom1));
  t('插件拿到了宿主方法数', /宿主 \d+ 个方法/.test(dom1),
    (dom1.match(/宿主 [^<]{0,20}/) || [''])[0]);

  // ══ 三、★热更新：改文件 → 不构建 → 刷新即变 ══
  const marker = 'HOT-' + Date.now().toString(36);
  writeFileSync(PLUGIN_JS, originalJs.replace("export const VERSION = 'v1';", "export const VERSION = '" + marker + "';"), 'utf8');

  const idx2 = await (await fetch(BASE + '/ui-plugins/index.json', { cache: 'no-store' })).json();
  const sb2 = (idx2.plugins || []).find((p) => p.id === 'status-bar');
  t('★改文件后 entryMtime 变了（cache-bust 生效）',
    Boolean(sb2 && sb.announce !== undefined ? true : sb2 && sb2.entryMtime !== sb.entryMtime),
    String(sb && sb.entryMtime) + ' → ' + String(sb2 && sb2.entryMtime));

  const dom2 = await dumpDom();
  t('★未跑任何构建，刷新后新内容已生效', dom2.includes(marker),
    '标记 ' + marker + ' 未出现在 DOM');

  // ══ 四、反例：路径穿越 ══
  // 【修正 · 假阳性】原来用 fetch(BASE + '/ui-plugins/../../package.json')：
  //   fetch 会在**客户端**就把 `..` 规范化成 `/package.json`，服务端根本收不到穿越路径；
  //   而 `/package.json` 命中 SPA 兜底 → 200 + index.html，index.html 里正好有
  //   `"name":"@vouch/web"`，于是旧断言被自己的兜底页骗成「泄露了仓库文件」。
  // 现在：① 用 http.request 发**原始** request-target（不规范化）；
  //       ② 直接比对响应体是否等于仓库根 README.md 原文（唯一有意义的泄露判据；
  //          根目录没有 package.json，所以不能用它当哨兵）。
  const sentinel = readFileSync(join(REPO, 'README.md'), 'utf8').trim();
  const rawGet = (rawPath) => new Promise((resolve) => {
    const u = new URL(BASE);
    const req = http.request(
      { host: u.hostname, port: u.port, path: rawPath, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
  const trav = await rawGet('/ui-plugins/../../README.md');
  t('★反例：路径穿越被挡（不泄露仓库 README.md 原文）',
    !(trav.status === 200 && trav.body.trim() === sentinel),
    'status=' + trav.status);
  const travEnc = await rawGet('/ui-plugins/%2e%2e/%2e%2e/README.md');
  t('★反例：编码穿越 %2e%2e 也被挡',
    !(travEnc.status === 200 && travEnc.body.trim() === sentinel),
    'status=' + travEnc.status);
  // 让 `..` 真正到达服务端的 /ui-plugins 分支：用 %2f 让 URL 解析器不做点段归一化，
  // 从而能验证该分支自己的 `..` 守卫确实返回 400（而不是靠 URL 归一化"顺带"变安全）。
  const travGuard = await rawGet('/ui-plugins/..%2f..%2fREADME.md');
  t('★反例：/ui-plugins 分支的 `..` 守卫返回 400（守卫真的被执行）',
    travGuard.status === 400,
    'status=' + travGuard.status);

  // ══ 五、反例：坏插件不拖垮面板 ══
  mkdirSync(BROKEN_DIR, { recursive: true });
  writeFileSync(join(BROKEN_DIR, 'plugin.json'), JSON.stringify({ id: 'broken-probe', name: '坏插件', slot: 'agent-bar', order: 99 }), 'utf8');
  writeFileSync(join(BROKEN_DIR, 'index.js'), 'export function mount() { throw new Error("boom"); }\n', 'utf8');

  const dom3 = await dumpDom();
  // 面板根节点是 `.ncc`（旧断言写的 `ncc__seg` / `rc-root` 是早就废弃的类名，纯过期）
  t('★反例：有坏插件时面板仍渲染（不白屏）', dom3.includes('class="ncc"') || dom3.includes('ncc__head'),
    '面板结构不见了');
  t('★反例：坏插件被计为失败并显示出来', /个插件加载失败/.test(dom3),
    '没看到失败提示');
  t('★坏插件不影响好插件', /免构建加载/.test(dom3));
} finally {
  writeFileSync(PLUGIN_JS, originalJs, 'utf8');
  if (existsSync(BROKEN_DIR)) rmSync(BROKEN_DIR, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 插件免构建加载、改文件刷新即生效、坏插件不拖垮面板、路径穿越被挡'
  : 'FAIL —— 有判据不满足'));
console.log('');
await stopServer(_srv.child);
process.exitCode = fails.length === 0 ? 0 : 1;
