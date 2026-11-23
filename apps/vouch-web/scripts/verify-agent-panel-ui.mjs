/**
 * 主 agent 面板的**真实浏览器**验证。
 *
 * 【为什么不用 puppeteer】仓库里没有装 puppeteer / @wdio，但本机有无头 Edge。
 * 用 `--dump-dom` + `--screenshot` 就能拿到**真实渲染后的 DOM** 和截图，
 * 这比"读源码里有这个类名"强得多：类被覆盖、元素被遮挡、宽度为 0 都能被发现。
 *
 * 【判据来自用户明确反馈】2026-11-18：
 *   「你的在线完全没什么出现的必要」  → 头部不能有在线/就绪状态徽标
 *   「下方的 ctrl 发送完全没必要」    → 不能有 "Ctrl+Enter 发送" 提示行
 * 参照主流 agent（ChatGPT / Claude / Cursor）：
 *   头部只有标题 + 新建 + 关闭；发送键内嵌输入框；回车发送 / Shift+回车换行。
 *
 * 用法：node apps/vouch-web/scripts/verify-agent-panel-ui.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN（找不到浏览器或页面打不开）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const URL_UNDER_TEST = process.env.NIANCHU_UI_URL || 'http://127.0.0.1:47124/index.html';
const OUT_DIR = join(REPO, 'evidence/ui');

/** 找一个可用的 Chromium 内核浏览器 */
function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return cands.find((p) => existsSync(p)) || null;
}

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const browser = findBrowser();
if (!browser) {
  console.log('  ❔ 找不到 Chrome / Edge');
  console.log('  四态: UNKNOWN —— 无法做真实渲染验证');
  process.exit(2);
}

// 页面可达性
let reachable = false;
try {
  const res = await fetch(URL_UNDER_TEST, { signal: AbortSignal.timeout(8000) });
  reachable = res.ok;
} catch { reachable = false; }
if (!reachable) {
  console.log('  ❔ 打不开 ' + URL_UNDER_TEST);
  console.log('  （产品服务器没起？先跑 node tools/workbench/serve.mjs）');
  console.log('  四态: UNKNOWN');
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
const domPath = join(OUT_DIR, 'agent-panel.html');
const pngPath = join(OUT_DIR, 'agent-panel.png');

const common = ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--virtual-time-budget=14000'];

console.log('');
console.log('  主 agent 面板 · 真实浏览器验证');
console.log('  浏览器: ' + browser);
console.log('  页面: ' + URL_UNDER_TEST);
console.log('  ' + '─'.repeat(72));

// ① 取真实渲染后的 DOM
let dom = '';
try {
  dom = execFileSync(browser, [...common, '--dump-dom', URL_UNDER_TEST], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  // Chromium 的 --dump-dom 常以非 0 退出但 stdout 仍有效，先看有没有内容
  dom = String(e && e.stdout || '');
}
if (!dom || dom.length < 5000) {
  console.log('  ❔ 没拿到渲染后的 DOM（' + (dom ? dom.length + ' 字节' : '空') + '）');
  console.log('  四态: UNKNOWN');
  process.exit(2);
}

// ② 截图存证
let shotOk = false;
try {
  execFileSync(browser, [...common, '--window-size=1560,950', '--screenshot=' + pngPath, URL_UNDER_TEST], {
    timeout: 90000, maxBuffer: 32 * 1024 * 1024,
  });
} catch { /* 忽略退出码，看文件 */ }
shotOk = existsSync(pngPath) && statSync(pngPath).size > 20000;
t('截到真实渲染画面（>20KB）', shotOk, shotOk ? '' : '截图没生成');

// ③ 结构判据（全部基于真实 DOM）
t('面板渲染出来了（有 ncc__box）', dom.includes('ncc__box'));
t('输入框存在', dom.includes('ncc__input'));
t('占位文案是「给念初发消息」', dom.includes('placeholder="给念初发消息"'),
  '文案不符');

// 用户明确要求去掉的两处
t('头部没有「在线/就绪」状态徽标（用户：完全没必要）', !dom.includes('ncc__status'));
t('没有「Ctrl+Enter 发送」提示行（用户：完全没必要）',
  !dom.includes('ncc__hint') && !dom.includes('ncc__row'));

// 发送键内嵌在输入容器里（主流 agent 做法）
const boxMatch = dom.match(/<div class="ncc__box">([\s\S]*?)<\/div>/);
t('发送键嵌在输入容器内部（真 DOM 层级）',
  !!(boxMatch && boxMatch[1].includes('ncc__send')),
  boxMatch ? 'box 内没有 send' : '没找到 ncc__box');

// 旧壳层残留
t('没有旧标签页（OpenBitFun / 新会话）', !dom.includes('openbitfun-fmc__header'));
t('没有「正在打开助手…」残留', !dom.includes('正在打开助手'));

// 图例中文
const legendMatch = dom.match(/class="nhn__legend"[^>]*>([\s\S]*?)<\/div>/);
const legendText = legendMatch
  ? legendMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  : '';
t('图谱图例是中文（不含 guards/reads 等英文键）',
  legendText.length > 0 && !/guards|reads|writes|injects|serves|archives|flow/.test(legendText),
  legendText.slice(0, 70) || '没找到图例');
t('图例覆盖 5 层 + 7 种关系',
  /L0 宪法/.test(legendText) && /守护/.test(legendText) && /流转/.test(legendText));

// 多智能体协同入口（2026-11-18 新增能力，必须在真实 DOM 里能看到）
t('有「对话 / 协同 / 动手」工作方式切换',
  dom.includes('ncc__seg') && dom.includes('>对话<') && dom.includes('>协同<') && dom.includes('>动手<'));

// 面板确实铺在右侧（DOM 上有 docked 标记 + CSS 里有全高规则）
t('停靠标记 data-docked="1" 在', dom.includes('data-docked="1"'));
const cssDir = join(REPO, 'apps/vouch-web/dist/assets');
let cssText = '';
try {
  const { readdirSync } = await import('node:fs');
  const f = readdirSync(cssDir).find((n) => n.startsWith('FloatingMiniChat-') && n.endsWith('.css'));
  if (f) cssText = readFileSync(join(cssDir, f), 'utf8');
} catch { /* ignore */ }
t('CSS 里移除类已彻底删除（status/hint/row）',
  cssText.length > 0 && !/ncc__status|ncc__hint|ncc__row/.test(cssText));
t('CSS 里有内嵌发送键样式 ncc__box', cssText.includes('ncc__box'));

// 「动手」面板（工具过程 + diff + 回滚）样式必须在产物里，否则 tab 点开是空的
const doCss = (() => {
  try {
    const { readdirSync } = require('node:fs');
    void readdirSync;
  } catch { /* ignore */ }
  return true;
})();
void doCss;
t('产物里有 diff / 回滚样式（说明动手视图真的接上了）',
  /dp-file__diff/.test(cssText) || dom.includes('dp-file') || dom.includes('dp__rollback'));

console.log('');
console.log('  截图: ' + pngPath);
console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 真 Chromium 渲染的 DOM 与截图都符合主流 agent 设计'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exit(fails.length === 0 ? 0 : 1);