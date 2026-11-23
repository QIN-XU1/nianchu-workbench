#!/usr/bin/env node
/**
 * POST /api/skills —— 技能目录与按需装载（A12 的入口）。
 *
 * 抄自 learn-claude-code s07 的两段式：
 *   action=catalog → 只返回 name+description（对应「目录常驻 prompt」）
 *   action=load    → 返回正文（对应「模型调 load_skill 才读全文」）
 *
 * 为什么必须有这个端点：审计判 A12「部分」的核心是「贡献点是死代码、没有入口」。
 * loader 有 list()/load() 但没人调；这个端点让产品侧真的能拿到目录与正文。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillLoader } from './loader.mjs';
import { catalogText, createLoadSkillTool } from './inject.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/** 技能根目录：本仓自有的（prototype/scenes），不扫 gitignore 的外部资产 */
export const SKILL_ROOTS = [join(REPO, 'prototype/scenes')];

let _loader = null;
function getLoader(deps) {
  if (deps && deps.loader) return deps.loader;
  if (_loader) return _loader;
  _loader = createSkillLoader(SKILL_ROOTS).scanAll();
  return _loader;
}

export function createSkillsHandler(deps = {}) {
  return async function handle(req, res, bodyText) {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    if (req.method !== 'POST') { send(405, { ok: false, error: '只接受 POST' }); return true; }

    let body;
    try { body = JSON.parse(bodyText || '{}'); } catch { send(400, { ok: false, error: '请求体不是合法 JSON' }); return true; }

    const action = body && body.action;
    if (action !== 'catalog' && action !== 'load') {
      send(400, { ok: false, error: 'action 只能是 catalog / load' });
      return true;
    }

    const loader = getLoader(deps);
    const st = loader.stats();

    if (action === 'catalog') {
      const c = catalogText(loader);
      send(200, {
        ok: true,
        action,
        count: c.count,
        catalog: c.text,
        truncated: c.truncated,
        issues: st.issues.map((i) => ({ level: i.level, code: i.code, message: i.message })),
        state: st.issues.some((i) => i.level === 'error') ? 'FAIL' : (c.count > 0 ? 'PASS' : 'UNKNOWN'),
      });
      return true;
    }

    // load
    const tool = createLoadSkillTool(loader);
    const r = tool.run({ name: body.name });
    // 【第 93 轮修】原来无条件 send(200, …)，导致「技能不存在 / 缺 name」这类失败也返回 HTTP 200，
    // 只有 body 里 ok:false —— 只检查状态码的客户端会把它当成成功。改为按错误类型给正确状态码。
    let status = 200;
    if (r.ok !== true) {
      const msg = String(r.error || '');
      status = /需要 name/.test(msg) ? 400 : (/技能不存在/.test(msg) ? 404 : 400);
    }
    send(status, { ok: r.ok === true, action, ...r });
    return true;
  };
}

/** Vite / http 中间件形式（自己读 body） */
export function createSkillsMiddleware(deps) {
  const handle = createSkillsHandler(deps);
  return async function skillsApiMiddleware(req, res, next) {
    const url = String(req.url || '').split('?')[0];
    if (url !== '/api/skills') { next(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); return; } chunks.push(c); });
    req.on('end', async () => { await handle(req, res, Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { try { res.writeHead(400); res.end('{"ok":false}'); } catch { /* ignore */ } });
  };
}
