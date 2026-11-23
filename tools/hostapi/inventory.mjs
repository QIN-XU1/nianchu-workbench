#!/usr/bin/env node
/**
 * 宿主 API 覆盖清点 —— 「自己的一份产品」的真实缺口。
 *
 * 背景：产品在浏览器环境下由 `createTransportAdapter()` 连 WebSocket 宿主
 * （apps/vouch-web/src/web-ui/src/infrastructure/api/adapters/index.ts:30-39，
 *   VITE_WS_URL || ws://localhost:8080/ws）。
 * 我们自己的服务器 tools/workbench/serve.mjs 目前**没有实现 WebSocket 宿主**，
 * 所以首页的用量/智能体/技能/小应用全部显示「无法加载」。
 *
 * 这个脚本不猜、不编：它从源码里把前端真正会 invoke 的方法名抽出来，
 * 再逐条判定我们是否实现，输出可核对的清单。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO, 'apps/vouch-web/src/web-ui/src');
const OUT_DIR = path.join(REPO, 'evidence/host-api');

/** 我们服务器已实现的 HTTP 端点（不是宿主 RPC，是自研子系统） */
const OWN_HTTP = ['/api/plugin-run', '/api/mcp', '/api/scheduler/tick', '/api/skills'];

/** 递归收集 .ts/.tsx */
function walk(dir, acc = []) {
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, acc); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = walk(SRC);
const RE = /\.invoke\(\s*['"]([a-z0-9_]+)['"]/g;

/** method -> Set<file:line> */
const hits = new Map();
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!text.includes('.invoke(')) continue;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(lines[i])) !== null) {
      const name = m[1];
      if (!hits.has(name)) hits.set(name, []);
      hits.get(name).push(path.relative(REPO, f) + ':' + (i + 1));
    }
  }
}

const methods = [...hits.keys()].sort();

/** 我们真正实现的：目前一个宿主 RPC 都没有 */
const implemented = [];

const payload = {
  what: '宿主 API 覆盖清点（前端 invoke 名 × 我们是否实现）',
  at: new Date().toISOString(),
  how: '从 apps/vouch-web/src/web-ui/src 下所有 .ts/.tsx 里抽 .invoke(\'<name>\')，去重后逐条判定',
  transport: {
    note: '浏览器环境走 WebSocket 宿主（adapters/index.ts:30-39），默认 ws://localhost:8080/ws',
    ourServerImplementsWebSocketHost: false,
    ourHttpEndpoints: OWN_HTTP,
  },
  summary: {
    invokeNames: methods.length,
    implemented: implemented.length,
    coverage: methods.length ? +(implemented.length / methods.length).toFixed(4) : 0,
    scannedFiles: files.length,
  },
  /** 按首段前缀分组，便于看「哪一块最缺」 */
  byPrefix: (() => {
    const g = {};
    for (const m of methods) {
      const p = m.split('_')[0] || '(other)';
      g[p] = (g[p] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(g).sort((a, b) => b[1] - a[1]));
  })(),
  methods: methods.map((name) => ({
    name,
    implemented: false,
    // 如实：证据是「前端哪里调它」，不是「我们实现了」
    calledAt: hits.get(name).slice(0, 3),
    calledFrom: hits.get(name).length,
  })),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, 'inventory.json');
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('');
console.log('  宿主 API 覆盖清点');
console.log('    扫描文件        ' + payload.summary.scannedFiles);
console.log('    前端 invoke 名  ' + payload.summary.invokeNames);
console.log('    我们实现        ' + payload.summary.implemented + '  → 覆盖 ' + (payload.summary.coverage * 100).toFixed(1) + '%');
console.log('    产物            ' + path.relative(REPO, out));
console.log('');
console.log('  缺得最多的前缀（Top 8）：');
for (const [p, n] of Object.entries(payload.byPrefix).slice(0, 8)) {
  console.log('    ' + p.padEnd(18) + n);
}
console.log('');
// 四态：一个都没实现 ⇒ FAIL（不是 UNKNOWN：我们确定知道是 0）
const state = payload.summary.implemented === 0 && payload.summary.invokeNames > 0 ? 'FAIL'
  : payload.summary.invokeNames === 0 ? 'UNKNOWN' : 'WARN';
console.log('  四态: ' + state);
process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
