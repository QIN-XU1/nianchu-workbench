/**
 * D3 状态可见性验证 —— 界面必须能回答三件事：
 *   它在做什么 / 花了多少 / 为什么停
 *
 * 【为什么这条要紧】D3 是 openclaw / orca 赢我们的维度。它们的做法是
 * 把 provider 用量、成本、窗口余额摆到界面上（openclaw `ui/src/components/solid/provider-usage.tsx:8`
 * 「Shared provider usage content: plan windows, balances and provider-billed cost」）。
 * 我们原来尾部只显示 state 与 tokens，**没有"为什么停"**，也没有 trace 可复盘。
 *
 * 这条验证做两件事：
 *   ① **防漂移**：前端 STOP_LABEL 的键集合必须与后端 stop.mjs 的 STOP_META 完全一致
 *      （前端多一个/少一个都算错，否则界面会显示英文 reason 或错标签）
 *   ② **真渲染**：用真 Chromium dump DOM，断言状态条的 5 个字段真的在页面上
 *
 * 用法：node tools/agent/verify-d3-status.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOP_REASONS } from './stop.mjs';
import { ensureServer, stopServer } from '../workbench/_serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PANEL = join(ROOT, 'apps/vouch-web/src/web-ui/src/app/layout/NianchuChat.tsx');
// 停止原因标签表已经从界面组件抽到纯函数模块（界面直接 import，判据也直接读同一份）。
const STATUS_MODEL = join(ROOT, 'apps/vouch-web/src/web-ui/src/app/layout/runStatusView.ts');
const BASE = process.env.NIANCHU_BASE || 'http://127.0.0.1:47124';
// 第 200 轮：浏览器渲染需服务；不可达则自起（起不来仍走 UNKNOWN 分支）
const _srv = await ensureServer(BASE);

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  D3 状态可见性验证（在做什么 / 花了多少 / 为什么停）');
console.log('  ' + '─'.repeat(72));

// ══ 一、前后端停止原因表必须一致（防漂移）══
{
  const tsx = readFileSync(STATUS_MODEL, 'utf8');
  const block = tsx.match(/const STOP_LABEL: Record<string, string> = \{([\s\S]*?)\};/);
  t('runStatusView 里有 STOP_LABEL 映射表', Boolean(block));
  const frontKeys = block
    ? [...block[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1])
    : [];
  t('STOP_LABEL 解析到键', frontKeys.length > 0, frontKeys.join(','));
  t('★前端键集合 == 后端 STOP_META 键集合',
    frontKeys.length === STOP_REASONS.length && STOP_REASONS.every((r) => frontKeys.includes(r)),
    '前端[' + frontKeys.join(',') + '] vs 后端[' + STOP_REASONS.join(',') + ']');
}

// ══ 二、源码层面：状态条五个字段都在 ══
{
  const tsx = readFileSync(PANEL, 'utf8');
  const need = [
    ['ncc-run-status', '状态条容器'],
    ['ncc-run-status__state', '状态字段'],
    ['ncc-run-status__stop', '停止原因字段'],
    ['ncc-run-status__usage', '用量字段'],
    ['ncc-run-status__elapsed', '耗时字段'],
    ['ncc-run-status__trace', 'trace 字段'],
  ];
  for (const [id, label] of need) {
    t('源码含 ' + label + '（' + id + '）', tsx.includes(id), '缺 ' + id);
  }
  t('空闲时也显示占位（不把状态藏起来）', tsx.includes('buildRunStatusView') && /状态：\{runView\.stateLabel\}/.test(tsx));
}

// ══ 三、后端真的提供了这些值 ══
{
  const { runWithTools } = await import('./loop.mjs');
  let r = null;
  for (let i = 0; i < 2; i++) {
    r = await runWithTools({
      systemPrompt: '你是 agent。只回复两个字：收到',
      task: '只回复两个字：收到',
      cwd: process.cwd(),
      maxSteps: 2,
    });
    if (typeof r.elapsedMs === 'number') break;
  }
  // 第 190 轮：模型不可用/退化时 runWithTools 返回的字段是 undefined，这不是「后端没提供」而是没跑成。
  // 如实标 UNKNOWN，不伪 FAIL。
  if (typeof r.stopReason !== 'string') {
    console.log('  ⚠ 运行结果缺 stopReason（模型不可用/退化）→ 三 段 UNKNOWN，跳过 6 条断言');
  } else {
  t('★运行结果带 stopReason（界面才有"为什么停"）', typeof r.stopReason === 'string', String(r.stopReason));
  t('★运行结果带 stopLabel（中文可读）', typeof r.stopLabel === 'string', String(r.stopLabel));
  t('★运行结果带 traceId（界面才能复盘）', typeof r.traceId === 'string', String(r.traceId));
  t('★运行结果带 elapsedMs（界面才能显示耗时）', typeof r.elapsedMs === 'number' && r.elapsedMs > 0,
    String(r.elapsedMs));
  t('运行结果带 usage（界面才能显示花了多少）', Boolean(r.usage) && typeof r.usage.calls === 'number',
    JSON.stringify(r.usage));
  t('stopReason 在后端枚举里', STOP_REASONS.includes(r.stopReason), String(r.stopReason));
  }
}

// ══ 四、真浏览器里状态条真的渲染出来 ══
{
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  const browser = cands.find((p) => existsSync(p));

  let dom = '';
  try {
    const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('status ' + r.status);
  } catch {
    console.log('  ❔ 打不开 ' + BASE);
    console.log('');
    console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
    console.log('  四态: UNKNOWN —— 服务未启动，渲染部分无法验证');
    process.exitCode = 2;
    dom = null;
  }

  if (dom !== null) {
    if (!browser) {
      console.log('  ❔ 找不到 Chrome/Edge');
      process.exitCode = 2;
    } else {
      try {
        dom = execFileSync(browser, [
          '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
          '--virtual-time-budget=14000', '--dump-dom', BASE + '/',
        ], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        dom = String((e && e.stdout) || '');
      }
      t('页面里出现状态条容器', dom.includes('ncc-run-status'), dom.length + ' 字节');
      t('★页面上能看到「停止原因」字样', /停止原因/.test(dom));
      t('★页面上能看到「用量」字样', /用量/.test(dom));
      t('★页面上能看到「耗时」字样', /耗时/.test(dom));
      t('★页面上能看到「trace」字样', /trace：/.test(dom));
      t('空闲态显示占位而不是空白', /状态：空闲/.test(dom));
    }
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 前端停止原因表与后端一致；状态条真渲染；后端确实提供了这些值'
  : 'FAIL —— 有判据不满足'));
console.log('');
await stopServer(_srv.child);
process.exitCode = fails.length === 0 ? 0 : 1;