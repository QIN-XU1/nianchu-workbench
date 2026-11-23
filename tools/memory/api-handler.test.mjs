#!/usr/bin/env node
/**
 * /api/memory 反例测试 —— 每条都要能红。
 * 注意：会真实读写记忆存储，所以测试前后各清一次，避免污染。
 * 用法：node tools/memory/api-handler.test.mjs
 */
import { Readable } from 'node:stream';
import { createMemoryHandler } from './api-handler.mjs';
import { load as loadDb, save as saveDb } from './store.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

function call(body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.url = '/api/memory';
  req.method = 'POST';
  let code = null;
  let payload = null;
  const res = {
    writeHead(c) { code = c; },
    end(b) { try { payload = JSON.parse(b); } catch { payload = b; } },
    on() {},
  };
  return new Promise((resolve) => {
    createMemoryHandler()(req, res, () => resolve({ code, payload }));
    setTimeout(() => resolve({ code, payload }), 300);
  });
}

// 记下原库，测完还原（不污染真实记忆）
const backup = JSON.stringify(loadDb());

// ── 正例 ──
{
  const r = await call({ action: 'ping' });
  t('正例：ping 报出治理三件', r.code === 200 && Array.isArray(r.payload.governance) && r.payload.governance.length === 3, JSON.stringify(r.payload));
}
{
  const k = 'test__api__' + Date.now();
  const w = await call({ action: 'put', key: k, value: 'v1', source: 'api-test' });
  t('正例：带 source 能写入', w.code === 200 && w.payload.ok === true, JSON.stringify(w.payload));
  const g = await call({ action: 'get', key: k });
  t('正例：写入后能读回', g.code === 200 && JSON.stringify(g.payload.result).includes('v1'), JSON.stringify(g.payload).slice(0, 120));
}
{
  const r = await call({ action: 'audit' });
  t('正例：audit 返回治理统计', r.code === 200 && r.payload.result != null, JSON.stringify(r.payload).slice(0, 120));
}

// ── 反例（每条都必须红）──
{
  const r = await call({ action: 'nope' });
  t('★反例：未知 action ⇒ 400', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'put', key: 'k_no_source', value: 'v' });
  t('★反例：没有 source 的写入被拒绝（治理第一条：凭印象不许进存储）', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'put', value: 'v', source: 'x' });
  t('★反例：缺 key ⇒ 400', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'get', key: '不存在的键__' + Date.now() });
  t('★反例：读不存在的键不能假装有值', r.code === 200 && r.payload.result && r.payload.result.live === null, JSON.stringify(r.payload).slice(0, 100));
}
{
  // 冲突：同 key 不同值 ⇒ 旧值必须仍可查（superseded 不是删除）
  const k = 'test__conflict__' + Date.now();
  await call({ action: 'put', key: k, value: 'old', source: 's1' });
  await call({ action: 'put', key: k, value: 'new', source: 's2' });
  const g = await call({ action: 'get', key: k, includeHistory: true });
  const s = JSON.stringify(g.payload.result);
  t('★反例：同 key 改值后旧值仍可查（不许静默覆盖）', s.includes('old') && s.includes('new'), s.slice(0, 160));
}
{
  // TTL：立即过期的条目不应出现在有效结果里，但历史里还在
  const k = 'test__ttl__' + Date.now();
  await call({ action: 'put', key: k, value: 'short', source: 's', ttlSec: -1 });
  const g = await call({ action: 'get', key: k });
  const s = JSON.stringify(g.payload.result);
  // 【2026-11-18 修·独立审计 R12】原断言是 `!s.includes('short') || s.includes('expired')` ——
  // 第二项**恒真**（泄漏的条目自己就带 effective:"expired" 字样）⇒
  // 把 store.get 的 live 过滤器整个删掉，过期条目真的泄漏进 live，这条断言仍然绿。
  // 现在改成直接判 live 字段：过期条目出现即失败。
  const live = g.payload?.result?.live ?? null;
  t('★反例：已过期的条目不能出现在有效查询里（直接判 live，不用字符串包含）',
    live === null, 'live=' + JSON.stringify(live) + ' raw=' + s.slice(0, 120));
  const h = await call({ action: 'get', key: k, includeHistory: true });
  t('★反例：过期条目的历史仍要保留（不许物理删除）', JSON.stringify(h.payload.result).includes('short'), JSON.stringify(h.payload.result).slice(0, 160));
}

// 还原
saveDb(JSON.parse(backup));

console.log('\n  /api/memory 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
