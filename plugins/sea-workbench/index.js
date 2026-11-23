/**
 * sea-workbench v3 —— 接入 DSH 原生右栏面板
 *
 * ⚠ 这是对 v1/v2 的**根本性修正**：
 *   之前我把工作台塞进 `conversation.composer.dock`（输入框上方一行），
 *   那根本不是工作台 —— luanyujia 的实用性来自**整块右栏面板**：
 *   文件树在左、预览在右、可停靠可全屏。
 *
 *   DSH 本身就有这套东西（ui-sidebar-right），正确做法是：
 *     ① ctx.sidebarRightTabs.register({ id, kind, title, canOpen? })
 *     ② ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)
 *     ③ ctx.sidebarRight.openTab(kind) 打开
 *
 * 为什么不再塞 conversation.composer.dock：
 *   那里只适合"一条状态"，放不下文件树 + 预览 + 多标签；
 *   而且它挤占输入区，实际把对话框变矮了 —— 这是不实用的根因。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export const name = 'sea-workbench';

/** 依赖：右栏面板系统 + slot 系统 */
// ⚠ 只 inject Host 侧服务。
//   slots / sidebarRightTabs / sidebarRight 是 Client 侧服务，
//   在 Host 里 inject 会永远 pending（实测报错：
//   "pending (waiting for services: slots, sidebarRightTabs, sidebarRight)"）
export const inject = ['webServer'];

function resolveSeaHome(config) {
  if (config?.seaHome) return config.seaHome;
  return join(import.meta.dirname, '..', '..');
}

const CACHE_TTL_MS = 30_000;
const cache = { at: 0, data: null, scenes: null, scenesAt: 0 };

async function runNode(home, script, args, timeoutMs) {
  const p = join(home, 'prototype', script);
  if (!existsSync(p)) throw new Error(`找不到 ${script}`);
  try {
    const { stdout } = await execFileAsync('node', [p, ...args], {
      cwd: home, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env },
    });
    return { exitCode: 0, stdout };
  } catch (e) {
    if (typeof e.code === 'number') return { exitCode: e.code, stdout: e.stdout || '' };
    throw e;
  }
}

function strip(s) { return String(s || '').replace(/\u001b\[[0-9;]*m/g, ''); }

function parseSeaPulse(stdout, exitCode) {
  const clean = strip(stdout);
  const lines = clean.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);

  let kind = 'unknown';
  if (/现在没事要你做/.test(clean)) kind = 'idle';
  else if (/件事需要你/.test(clean)) kind = 'action';
  else if (/我的检查本身不可信/.test(clean)) kind = 'untrusted';
  else if (/个场景配置有误/.test(clean)) kind = 'broken';
  else if (/还没有任何场景/.test(clean)) kind = 'empty';

  const detail = lines[1] || '';
  const g = /门禁\s+(\d+)\/(\d+)/.exec(detail);
  const fl = /下限\s+(\d+)\/(\d+)/.exec(detail);
  const ce = /认证\s+(\d+)\/(\d+)/.exec(detail);
  const as = /资产\s+(\d+)\s+问题/.exec(detail);
  const sc = /(\d+)\s*个场景/.exec(detail);
  const cp = /外挂\s+(\d+)\s*项/.exec(detail);
  const td = /待办\s+(\d+)/.exec(detail);
  const pair = x => ({ passed: Number(x[1]), total: Number(x[2]) });

  return {
    kind, exitCode,
    headline: lines[0] || '',
    detail,
    scenes: sc ? Number(sc[1]) : null,
    gate: g ? pair(g) : null,
    floor: fl ? pair(fl) : null,
    cert: ce ? pair(ce) : null,
    assetProblems: as ? Number(as[1]) : null,
    capabilities: cp ? Number(cp[1]) : null,
    todos: td ? Number(td[1]) : null,
    extra: lines.slice(2, 8),
    at: Date.now(),
  };
}

function readScenes(home, force = false) {
  const now = Date.now();
  if (!force && cache.scenes && now - cache.scenesAt < CACHE_TTL_MS) return cache.scenes;

  const scenesDir = join(home, 'prototype', 'scenes');
  if (!existsSync(scenesDir)) return [];
  const out = [];

  for (const nm of readdirSync(scenesDir)) {
    const dir = join(scenesDir, nm);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const scenePath = join(dir, 'scene.json');
    if (!existsSync(scenePath)) continue;

    let scene = {};
    try { scene = JSON.parse(readFileSync(scenePath, 'utf8')); } catch { continue; }
    let identity = {};
    try { identity = JSON.parse(readFileSync(join(dir, '.identity.json'), 'utf8')); } catch { /* 可选 */ }

    const parts = {
      config: true,
      context: existsSync(join(dir, 'CONTEXT.md')),
      memory: existsSync(join(dir, 'MEMORY.md')),
      skill: existsSync(join(dir, 'SKILL.md')),
      identity: existsSync(join(dir, '.identity.json')),
    };

    out.push({
      id: scene.id || nm,
      name: scene.name || nm,
      desc: scene.desc || '',
      protects: scene.protects || [],
      parts,
      completeness: Object.values(parts).filter(Boolean).length,
      totalParts: 5,
      sessionId: identity.sessionId || null,
      panelId: identity.panelId || null,
      sessionTitle: identity.sessionTitle || null,
    });
  }
  cache.scenes = out.sort((a, b) => a.id.localeCompare(b.id));
  cache.scenesAt = now;
  return cache.scenes;
}

function readSceneDoc(home, sceneId, which) {
  const dir = join(home, 'prototype', 'scenes', sceneId);
  if (!existsSync(dir)) throw new Error('场景不存在：' + sceneId);
  const fileMap = { context: 'CONTEXT.md', memory: 'MEMORY.md', skill: 'SKILL.md', config: 'scene.json', identity: '.identity.json' };
  const fileName = fileMap[which];
  if (!fileName) throw new Error('未知文档类型：' + which);
  const p = join(dir, fileName);
  if (!existsSync(p)) throw new Error(`${sceneId} 没有 ${fileName}`);
  const st = statSync(p);
  if (st.size > 400 * 1024) throw new Error(`文件太大（${Math.round(st.size / 1024)}KB）`);
  return { sceneId, which, file: fileName, content: readFileSync(p, 'utf8'), bytes: st.size, mtime: st.mtimeMs };
}

function readCapabilities(home) {
  const p = join(home, 'prototype', 'capabilities.json');
  if (!existsSync(p)) return { groups: [], active: [] };
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    const active = [], groups = [];
    for (const group of ['bridge', 'mcp', 'plugins']) {
      const g = s[group];
      if (!g) continue;
      const container = group === 'bridge' ? 'sites' : group === 'mcp' ? 'servers' : 'items';
      const items = [];
      if (g[container]) {
        for (const [k, v] of Object.entries(g[container])) {
          items.push({ key: k, label: v.label, on: !!v.on, cost: v.cost || '' });
          if (v.on) active.push({ group, key: k, label: v.label, cost: v.cost || '' });
        }
      }
      groups.push({ group, label: g.label, note: g.note || '', items });
    }
    return { groups, active };
  } catch { return { groups: [], active: [] }; }
}

/**
 * 注册一个可停靠/可全屏的右栏面板类型。
 *
 * 类型 id 用包名（契约文档说这是自然值，且 id 必须全局唯一）。
 */
const TAB_ID = '@local/sea-workbench/workbench';
const TAB_KIND = 'sea-workbench';

export function apply(ctx, config = {}) {
  const home = resolveSeaHome(config);
  const timeoutMs = config.timeoutMs ?? 20_000;

  /** 供面板体读取的数据接口（通过 HTTP 路由，客户端 fetch） */
  async function pulse({ force = false } = {}) {
    const now = Date.now();
    if (!force && cache.data && now - cache.at < CACHE_TTL_MS) return { ...cache.data, cached: true };
    const r = await runNode(home, 'sea.mjs', [], timeoutMs);
    const parsed = parseSeaPulse(r.stdout, r.exitCode);
    cache.at = now; cache.data = parsed;
    return { ...parsed, cached: false };
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // ---------- ① HTTP 数据层（面板体通过它取数据）----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sea-workbench',
    resource: async (request) => {
      const url = new URL(request.url);
      const p = url.pathname;
      const force = url.searchParams.get('force') === '1';

      try {
        if (p === '/sea-workbench/pulse') return json(await pulse({ force }));
        if (p === '/sea-workbench/scenes') return json({ scenes: readScenes(home, force) });
        if (p === '/sea-workbench/scene-doc') {
          const id = url.searchParams.get('id');
          const which = url.searchParams.get('which') || 'context';
          if (!id) return json({ error: '缺少 id 参数' }, 400);
          try { return json(readSceneDoc(home, id, which)); }
          catch (e) { return json({ error: String(e.message || e) }, 400); }
        }
        if (p === '/sea-workbench/caps') return json(readCapabilities(home));
        if (p === '/sea-workbench/roots') {
          const { ALLOWED_ROOTS } = await import('../../prototype/profiles.mjs');
          return json({ roots: ALLOWED_ROOTS.map(r => ({ key: r.key, label: r.label, dir: r.dir })) });
        }
        if (p === '/sea-workbench/files') {
          const root = url.searchParams.get('root') || 'plan';
          const { listProfiles } = await import('../../prototype/profiles.mjs');
          try { return json(listProfiles(home, root)); }
          catch (e) { return json({ error: String(e.message || e), files: [] }, 400); }
        }
        if (p === '/sea-workbench/file') {
          const rel = url.searchParams.get('path');
          if (!rel) return json({ error: '缺少 path 参数' }, 400);
          const { readProfile } = await import('../../prototype/profiles.mjs');
          try { return json(readProfile(home, rel)); }
          catch (e) { return json({ error: String(e.message || e) }, 400); }
        }
        if (p === '/sea-workbench/boards') {
          const r = await runNode(home, 'boards.mjs', ['summary'], timeoutMs);
          const clean = strip(r.stdout);
          const num = re => { const m = re.exec(clean); return m ? Number(m[1]) : 0; };
          return json({
            notices: num(/通知板.*?(\d+)\s*条/),
            todos: num(/待办板.*?(\d+)\s*条/),
            index: num(/总索引.*?(\d+)\s*条/),
          });
        }
        if (p === '/sea-workbench/mcp') {
          const r = await runNode(home, 'mcp.mjs', ['servers'], timeoutMs);
          const clean = strip(r.stdout);
          const nameRe = /^\s{2}(\S+)$/gm;
          const servers = [];
          let m;
          while ((m = nameRe.exec(clean)) !== null) servers.push({ name: m[1] });
          return json({ servers });
        }
        if (p === '/sea-workbench/toggle') {
          const target = url.searchParams.get('target');
          const on = url.searchParams.get('on') === '1';
          if (!target) return json({ error: '缺少 target 参数' }, 400);
          const r = await runNode(home, 'capabilities.mjs', [on ? 'on' : 'off', target], timeoutMs);
          cache.at = 0; cache.scenesAt = 0;
          return json({ ok: r.exitCode === 0, target, on, output: strip(r.stdout).trim() }, r.exitCode === 0 ? 200 : 400);
        }
        return json({ error: '未知路径：' + p }, 404);
      } catch (e) {
        return json({ error: String(e && e.message ? e.message : e), kind: 'error' }, 500);
      }
    },
  }), 'sea-workbench data routes');

  // ---------- ② tab 类型注册在 Client 侧 ----------
  //    Host 不能 inject sidebarRightTabs/sidebarRight（它们是 Client 服务）。
  //    client.js 里通过 ctx.sidebarRightTabs.register + ctx.slots.register 完成。
  //    这里只把 tab 标识导出给外部调用。

  // 也暴露给外部（方便脚本/其他插件调用）
}

export { TAB_ID, TAB_KIND };
