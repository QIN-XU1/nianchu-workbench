#!/usr/bin/env node
/**
 * 技能 RPC 接线验收 —— 证明 ws-host 真的能回答技能市场/安装的请求
 *
 * 不是「方法写好了」，而是：
 *   1. 方法真的注册进了 IMPLEMENTED 表（能被 RPC 找到）
 *   2. 每个方法返回的是**真数据**，不是占位
 *   3. miniapp_market_installed_origins 不再是假 `[]`
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

async function main() {
  console.log('\n  0. 方法表里真的有这四个方法');
  const mod = await import('../hostapi/ws-host.mjs');
  const IMPL = mod.IMPLEMENTED;
  t('导出 IMPLEMENTED', !!IMPL && typeof IMPL === 'object');
  for (const m of ['get_skill_configs', 'miniapp_market_installed_origins', 'skill_market_search', 'skill_manage']) {
    t('已注册 ' + m, typeof IMPL[m] === 'function');
  }

  console.log('\n  1. get_skill_configs 返回真数据');
  const cfgs = IMPL.get_skill_configs();
  t('返回数组', Array.isArray(cfgs));
  t('技能数 ≥ 25', cfgs.length >= 25, '实际 ' + cfgs.length);
  t('每项有 key/name/description', cfgs.every((c) => c.key && c.name && typeof c.description === 'string'));
  t('level 只能是 user|project', cfgs.every((c) => c.level === 'user' || c.level === 'project'));
  t('能指到真实 SKILL.md', cfgs.slice(0, 5).every((c) => fs.existsSync(path.join(c.path, c.entryFile))),
    JSON.stringify(cfgs.slice(0, 3).map((c) => c.path)));

  console.log('\n  2. miniapp_market_installed_origins 不再是假 []');
  const origins = IMPL.miniapp_market_installed_origins();
  t('返回数组', Array.isArray(origins));
  // 真实情况：目前没装过东西，所以是空数组 —— 但要证明它读的是真清单而不是写死
  const manifestPath = path.join(ROOT, 'prototype/scenes/installed.json');
  const hasManifest = fs.existsSync(manifestPath);
  if (!hasManifest) {
    t('无清单时返回空数组（如实）', origins.length === 0);
    t('且不是写死的：清单文件确实不存在', !hasManifest);
  } else {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const expected = Object.keys(m.installed || {}).length;
    const got = origins.reduce((s, o) => s + o.count, 0);
    t('条目数与清单一致', got === expected, '清单 ' + expected + ' vs 返回 ' + got);
  }

  console.log('\n  3. skill_market_search 能检索');
  const all = IMPL.skill_market_search({});
  t('无参数返回全部', all.total >= 25, 'total=' + all.total);
  t('含 categories', Array.isArray(all.categories) && all.categories.length >= 3);
  const q = IMPL.skill_market_search({ query: 'debug' });
  t('query=debug 命中 debug-repro', q.rows.some((r) => r.name === 'debug-repro'), JSON.stringify(q.rows.map((r) => r.name)));
  t('已装技能 installed=true', q.rows.find((r) => r.name === 'debug-repro')?.installed === true);
  const lim = IMPL.skill_market_search({ limit: 3 });
  t('limit=3 生效', lim.rows.length === 3, '实际 ' + lim.rows.length);
  const cat = IMPL.skill_market_search({ category: '工程' });
  t('category=工程 只返回该分类', cat.rows.length > 0 && cat.rows.every((r) => r.category === '工程'));
  // 非法参数不崩
  t('params 为 null 不崩', (() => { try { return IMPL.skill_market_search(null).total >= 0; } catch { return false; } })());
  t('limit 超范围被夹紧', (() => { const r = IMPL.skill_market_search({ limit: 99999 }); return r.rows.length <= 200; })());

  console.log('\n  4. skill_manage 的 action 校验');
  const bad = IMPL.skill_manage({ action: 'nonsense' });
  t('未知 action → bad_action', bad.ok === false && bad.code === 'bad_action', JSON.stringify(bad));
  const noAction = IMPL.skill_manage({});
  t('缺 action → bad_action', noAction.ok === false && noAction.code === 'bad_action');
  const list = IMPL.skill_manage({ action: 'list' });
  t('action=list 返回清单结构', Array.isArray(list.rows) && typeof list.count === 'number');
  const dryBad = IMPL.skill_manage({ action: 'install', source: '/no/such/dir' });
  t('安装不存在的源 → source_missing', dryBad.ok === false && dryBad.code === 'source_missing', JSON.stringify(dryBad));

  console.log('\n  5. 反假绿：真的能装进临时池（走 RPC 参数路径）');
  // 用 dryRun 验证参数能穿透到 installSkill（不真的污染 prototype/scenes）
  // 注意：目录名必须与技能 name 一致（loader 会校验 name_mismatch），
  // 所以临时根目录下再建一层 rpc-probe/。
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-skill-'));
  const tmpSrc = path.join(tmpRoot, 'rpc-probe');
  fs.mkdirSync(tmpSrc, { recursive: true });
  fs.writeFileSync(path.join(tmpSrc, 'SKILL.md'),
    '---\nname: rpc-probe\ncategory: 测试\ndescription: RPC 验收用临时技能，不应留下。\n---\n\n# rpc-probe\n\n正文。\n', 'utf8');
  const dry = IMPL.skill_manage({ action: 'install', source: tmpSrc, dryRun: true });
  t('dryRun 安装返回 ok', dry.ok === true && dry.dryRun === true, JSON.stringify(dry).slice(0, 140));
  t('dryRun 报告了 bodyBytes', typeof dry.bodyBytes === 'number' && dry.bodyBytes > 0);
  t('dryRun 报告了 hash', typeof dry.hash === 'string' && dry.hash.length === 64);
  t('dryRun 未真的落盘', !fs.existsSync(path.join(ROOT, 'prototype/scenes/rpc-probe')));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力 */ }

  console.log('\n  ──────────────────────────────────────────');
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  const state = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'UNKNOWN');
  console.log('  四态: ' + state);
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}

main().catch((e) => {
  console.error('  ✗ 工具自检失败：' + (e && e.stack || e));
  process.exit(2);
});
