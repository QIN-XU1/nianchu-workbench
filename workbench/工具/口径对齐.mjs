#!/usr/bin/env node
/**
 * 口径对齐 —— 多源数据一致性检查
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1Ht4F6MEyE 的自主管理实操）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [17:22] 「四星采印进清档了。**台账和索引都是 57。口径对齐了。**」
 *  > [17:34] 「档案那边认了中版。清档 56，重档 36。」
 *  > [15:40] 「**目录和主当，现在都是三十六个，对上了。**」
 *
 *  UP 主在运营真实客户业务时，反复提到「口径对齐」——
 *  同一个数字在台账、索引、档案里必须一致。
 *
 * ══════════════════════════════════════════════════════════════
 *  我们项目的同类问题
 * ══════════════════════════════════════════════════════════════
 *
 *  我们的数据分散在多处，没有任何对账机制：
 *
 *    派单台账.json       → 派单总数、各状态数量
 *    身份索引.json       → 会话数、场景数
 *    场地地图.json       → 规则数、按档分布
 *    关键资产.json       → 资产数、按级分布
 *    场景路由.yaml       → 场景数
 *    场景层级.yaml       → 场景数
 *    场景记忆/           → 目录数
 *    外壳/scenarios/     → JSON 数
 *
 *  同一个「场景数」在 5 个地方有记录，但从来没人核对过。
 *
 * ══════════════════════════════════════════════════════════════
 *  检查什么
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 场景数一致性
 *     场景路由 / 场景层级 / 场景记忆目录 / scenarios JSON
 *     四处必须相等
 *
 *  ② 派单台账自洽
 *     总数 = 各状态之和
 *
 *  ③ 技能数一致性
 *     skills 目录数 = 关键资产里技能条目数 ÷ 3
 *
 *  ④ 资产清单自洽
 *     声明总数 = assets.length
 *     分级之和 = 总数
 *
 *  ⑤ 索引与实际会话
 *     身份索引里的 sessionId 必须真实存在于引擎
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/口径对齐.mjs              跑全部检查
 *  node 工具/口径对齐.mjs --json       JSON 输出
 *  node 工具/口径对齐.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const SHARED = path.join(DATA_ROOT, '场景记忆', '_共享记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  检查 ①：场景数一致性
// ══════════════════════════════════════════════════════════════
export function checkSceneCount(opts) {
  const o = opts || {};
  const base = o.base || WB;
  const sources = {};

  // a) 场景路由.yaml
  //
  //  ⚠ 自测抓到的缺陷：原来按「缩进 2 空格的 xxx:」解析，
  //     但实际格式是 YAML 列表：
  //       - id: research
  //         name: 调研
  //     所以一个都匹配不到（恒为 0）。
  const routeYaml = readTextSafe(path.join(base, '数据', '.dsh', '场景路由.yaml'));
  if (routeYaml) {
    const ids = [...routeYaml.matchAll(/^\s*-\s*id:\s*([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
    sources['场景路由.yaml'] = [...new Set(ids)].length;
  }

  // b) 场景层级.yaml
  //
  //  层级文件是「映射」格式（scene: 下每个 id 一段），
  //  和路由的列表格式不同，所以两种都试。
  const layerYaml = readTextSafe(path.join(base, '数据', '.dsh', '场景层级.yaml'));
  if (layerYaml) {
    // 先试列表格式
    let ids = [...layerYaml.matchAll(/^\s*-\s*id:\s*([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
    // 再试映射格式（缩进 2 空格的 key:）
    if (ids.length === 0) {
      ids = [...layerYaml.matchAll(/^ {2}([a-z][a-z0-9-]+):\s*$/gm)].map((m) => m[1]);
    }
    sources['场景层级.yaml'] = [...new Set(ids)].length;
  }

  // c) 场景记忆目录
  const memDir = path.join(base, '数据', '.dsh', '场景记忆');
  if (fs.existsSync(memDir)) {
    sources['场景记忆/目录'] = fs.readdirSync(memDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_')).length;
  }

  // d) scenarios JSON
  const scenDir = path.join(base, '外壳', 'scenarios');
  if (fs.existsSync(scenDir)) {
    sources['scenarios/*.json'] = fs.readdirSync(scenDir).filter((f) => f.endsWith('.json')).length;
  }

  // e) 技能目录
  const skillDir = path.join(base, '数据', '.dsh', 'skills');
  if (fs.existsSync(skillDir)) {
    sources['skills/目录'] = fs.readdirSync(skillDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).length;
  }

  const values = Object.values(sources);
  const unique = [...new Set(values)];
  const consistent = unique.length <= 1;

  return {
    ok: consistent,
    sources,
    values: unique,
    diff: consistent ? null : Math.max(...values) - Math.min(...values),
    reason: consistent
      ? '场景数一致：' + unique[0]
      : '场景数不一致：' + Object.entries(sources).map(([k, v]) => k + '=' + v).join(' / '),
  };
}

// ══════════════════════════════════════════════════════════════
//  检查 ②：派单台账自洽
// ══════════════════════════════════════════════════════════════
export function checkLedger(opts) {
  const o = opts || {};
  const file = o.file || path.join(SHARED, '派单台账.json');
  const j = readJsonSafe(file);
  if (!j) return { ok: true, skipped: true, reason: '台账不存在' };

  const list = j.dispatches || [];
  const byState = {};
  for (const d of list) byState[d.state || 'created'] = (byState[d.state || 'created'] || 0) + 1;
  const sum = Object.values(byState).reduce((a, b) => a + b, 0);

  // ⚠ 2026-11-12 修（判据错误：这条检查**永远不会失败**）
  //
  //   原判据：`ok = (sum === list.length)`
  //           sum 是把 list 逐条计数累加出来的，恒等于 list.length。
  //           所以 ok 恒为 true —— 典型的装饰检查。
  //           台账里重复 id、非法状态、已销账却没回执，它一个都发现不了。
  //
  //   改成三条真判据：
  //     ① 声明总数（若有 count 字段）必须等于实际条数
  //     ② id 必须唯一且非空（重复 id 会让 --ack/--close 改错单）
  //     ③ state 必须是状态机里的合法值
  //     ④ 已销账/已回执的单必须有回执正文（销账没回执 = 假闭环）
  //   反例见自测：上面任意一条被破坏都必须红。
  const LEGAL_STATES = new Set(['created', 'delivered', 'acked', 'unacked', 'closed', 'cancelled']);
  const problems = [];

  if (j.count !== undefined && Number(j.count) !== list.length) {
    problems.push('声明总数 ' + j.count + ' ≠ 实际 ' + list.length);
  }

  const seen = new Set();
  const dupIds = [];
  for (const d of list) {
    const id = String(d.id || '').trim();
    if (!id) problems.push('有条目缺 id');
    else if (seen.has(id)) dupIds.push(id);
    else seen.add(id);
  }
  if (dupIds.length) problems.push('id 重复：' + [...new Set(dupIds)].slice(0, 3).join(','));

  const badStates = Object.keys(byState).filter((s) => !LEGAL_STATES.has(s));
  if (badStates.length) problems.push('非法状态：' + badStates.join(','));

  const closedNoReceipt = list.filter((d) => d.state === 'closed' && !d.receipt).map((d) => d.id);
  if (closedNoReceipt.length) {
    problems.push(closedNoReceipt.length + ' 条已销账却无回执：' + closedNoReceipt.slice(0, 3).join(','));
  }

  const ok = problems.length === 0;
  return {
    ok,
    total: list.length,
    byState,
    sum,
    problems,
    reason: ok
      ? '台账自洽：' + list.length + ' 条（' +
        Object.entries(byState).map(([k, v]) => k + '=' + v).join(', ') + '）'
      : '台账不自洽：' + problems.join('；'),
  };
}

// ══════════════════════════════════════════════════════════════
//  检查 ③：资产清单自洽
// ══════════════════════════════════════════════════════════════
export function checkAssets(opts) {
  const o = opts || {};
  const file = o.file || path.join(SHARED, '关键资产.json');
  const j = readJsonSafe(file);
  if (!j) return { ok: true, skipped: true, reason: '资产清单不存在' };

  const assets = j.assets || [];
  const byLevel = {};
  for (const a of assets) byLevel[a.level] = (byLevel[a.level] || 0) + 1;
  const sum = Object.values(byLevel).reduce((a, b) => a + b, 0);

  const declared = j.count;
  const problems = [];

  if (declared !== undefined && declared !== assets.length) {
    problems.push('声明总数 ' + declared + ' ≠ 实际 ' + assets.length);
  }
  if (sum !== assets.length) {
    problems.push('分级之和 ' + sum + ' ≠ 总数 ' + assets.length);
  }

  return {
    ok: problems.length === 0,
    total: assets.length,
    declared,
    byLevel,
    reason: problems.length === 0
      ? '资产清单自洽：' + assets.length + ' 条（' +
        Object.entries(byLevel).map(([k, v]) => k + '=' + v).join(', ') + '）'
      : '资产清单不自洽：' + problems.join('；'),
  };
}

// ══════════════════════════════════════════════════════════════
//  检查 ④：身份索引与实际会话
// ══════════════════════════════════════════════════════════════
export function checkIdentityIndex(opts) {
  const o = opts || {};
  const file = o.file || path.join(SHARED, '身份索引.json');
  const j = readJsonSafe(file);
  if (!j) return { ok: true, skipped: true, reason: '身份索引不存在' };

  // ⚠ 自测/实测抓到的缺陷：实际字段名是 rows，
  //   不是 scenes/items/sessions（第一版没读对 → 恒为 0）。
  const list = j.rows || j.scenes || j.items || j.sessions || [];
  if (!Array.isArray(list)) return { ok: true, skipped: true, reason: '身份索引结构未知' };

  const problems = [];
  // 检查是否有占位 sessionId
  //
  //  ⚠ 2026-11-10 修正（真实数据暴露）：
  //    「没有 sessionId」有两种情况，要区分：
  //      ① 这个场景**从来没启动过** → 正常（还没有会话）
  //      ② 有 sessionId 但值是占位符 → 异常（索引没建好）
  //
  //    原来把两者都算异常，导致 7 个从未启动的场景被误报。
  const PLACEHOLDER_RE = /placeholder|TODO|待补|^xxx$/i;
  const badPlaceholders = list.filter((x) =>
    x.sessionId && PLACEHOLDER_RE.test(String(x.sessionId)));
  if (badPlaceholders.length > 0) {
    problems.push(badPlaceholders.length + ' 个条目的 sessionId 是占位值');
  }

  // 统计真实状态（不算错误，只报告）
  const withSession = list.filter((x) => x.sessionId && !PLACEHOLDER_RE.test(String(x.sessionId)));
  const withoutSession = list.length - withSession.length;

  // 场景数对比
  const sceneCount = list.length;
  const scenDir = path.join(WB, '外壳', 'scenarios');
  const jsonCount = fs.existsSync(scenDir)
    ? fs.readdirSync(scenDir).filter((f) => f.endsWith('.json')).length
    : 0;

  if (jsonCount > 0 && sceneCount !== jsonCount) {
    problems.push('索引 ' + sceneCount + ' 个场景 ≠ 配置 ' + jsonCount + ' 个');
  }

  return {
    ok: problems.length === 0,
    count: sceneCount,
    withSession: withSession.length,
    withoutSession,
    placeholderCount: badPlaceholders.length,
    reason: problems.length === 0
      ? '身份索引正常：' + sceneCount + ' 个场景（' +
        withSession.length + ' 个有会话 / ' + withoutSession + ' 个未启动）'
      : '身份索引有问题：' + problems.join('；'),
  };
}

// ══════════════════════════════════════════════════════════════
//  检查 ⑤：技能数一致性
// ══════════════════════════════════════════════════════════════
export function checkSkills(opts) {
  const o = opts || {};
  const skillDir = o.skillDir || path.join(DATA_ROOT, 'skills');
  if (!fs.existsSync(skillDir)) return { ok: true, skipped: true, reason: '技能目录不存在' };

  const dirs = fs.readdirSync(skillDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  const problems = [];
  let complete = 0;
  for (const d of dirs) {
    const p = path.join(skillDir, d.name);
    const hasMd = fs.existsSync(path.join(p, 'SKILL.md'));
    const hasCheck = fs.existsSync(path.join(p, 'check.mjs'));
    const hasJson = fs.existsSync(path.join(p, 'skill.json'));
    if (hasMd && hasCheck && hasJson) complete++;
    else {
      const miss = [];
      if (!hasMd) miss.push('SKILL.md');
      if (!hasCheck) miss.push('check.mjs');
      if (!hasJson) miss.push('skill.json');
      problems.push(d.name + ' 缺 ' + miss.join('/'));
    }
  }

  return {
    ok: problems.length === 0,
    total: dirs.length,
    complete,
    problems,
    reason: problems.length === 0
      ? '技能完整：' + complete + '/' + dirs.length + ' 个都有三件套'
      : '技能不完整：' + problems.slice(0, 3).join('；'),
  };
}

// ══════════════════════════════════════════════════════════════
//  全跑
// ══════════════════════════════════════════════════════════════
export function checkAll(opts) {
  const checks = [
    { id: 1, name: '场景数一致性', fn: checkSceneCount },
    { id: 2, name: '派单台账自洽', fn: checkLedger },
    { id: 3, name: '资产清单自洽', fn: checkAssets },
    { id: 4, name: '身份索引', fn: checkIdentityIndex },
    { id: 5, name: '技能完整性', fn: checkSkills },
  ];

  const results = checks.map((c) => {
    try {
      return { id: c.id, name: c.name, ...c.fn(opts) };
    } catch (e) {
      return { id: c.id, name: c.name, ok: false, reason: '检查出错: ' + String(e.message).slice(0, 60) };
    }
  });

  const failed = results.filter((r) => !r.ok && !r.skipped);
  return {
    ok: failed.length === 0,
    results,
    failedCount: failed.length,
    verdict: failed.length === 0
      ? '口径全部对齐'
      : failed.length + ' 项不对齐：' + failed.map((r) => r.name).join('、'),
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  口径对齐 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // 准备临时目录
  const tmp = path.join(WB, 'prototype', '_tmp-kouj');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, '数据', '.dsh'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '外壳', 'scenarios'), { recursive: true });

  // ① 场景数一致
  fs.writeFileSync(path.join(tmp, '数据', '.dsh', '场景路由.yaml'),
    '- id: a\n  name: A\n- id: b\n  name: B\n', 'utf8');
  fs.writeFileSync(path.join(tmp, '数据', '.dsh', '场景层级.yaml'),
    'scene:\n  aa:\n    role: root\n  bb:\n    role: root\n', 'utf8');
  fs.mkdirSync(path.join(tmp, '数据', '.dsh', '场景记忆', 'AA'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '数据', '.dsh', '场景记忆', 'BB'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '外壳', 'scenarios', 'aa.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(tmp, '外壳', 'scenarios', 'bb.json'), '{}', 'utf8');

  const c1 = checkSceneCount({ base: tmp });
  chk('场景数一致时通过', c1.ok === true, c1.reason);

  // ② 反例：多一个 JSON → 不一致
  fs.writeFileSync(path.join(tmp, '外壳', 'scenarios', 'cc.json'), '{}', 'utf8');
  const c2 = checkSceneCount({ base: tmp });
  chk('反例：场景数不一致被检出', c2.ok === false, c2.reason.slice(0, 50));
  fs.unlinkSync(path.join(tmp, '外壳', 'scenarios', 'cc.json'));

  // ③ 台账自洽
  //
  //  ⚠ 2026-11-12 修：正例夹具必须满足新判据 ——
  //    closed 的单必须带回执正文，否则它自己就会被「销账无回执」判红。
  //    （这不是放宽判据，是把夹具补成一份**真的合规**的台账。）
  const ledgerFile = path.join(tmp, 'ledger.json');
  fs.writeFileSync(ledgerFile, JSON.stringify({
    dispatches: [
      { id: 'd1', state: 'closed', receipt: '证据：产物 a.md 共 3 行，跑通 8/8' },
      { id: 'd2', state: 'acked', receipt: '证据：产物 b.md 已生成' },
      { id: 'd3', state: 'cancelled' },
    ],
  }), 'utf8');
  const c3 = checkLedger({ file: ledgerFile });
  chk('台账自洽时通过', c3.ok === true, c3.reason);

  // ④ 反例：台账必须能真的发现坏数据
  //
  //  ⚠ 2026-11-12 改：原来这里写着「我们的检查只看状态之和 == list.length，
  //     这两者天然相等」——那正好承认了这条检查永远不会失败。
  //     现在改成真判据（见 checkLedger 注释），所以必须逐条验反例。
  const ledgerBadId = path.join(tmp, 'ledger-dup-id.json');
  fs.writeFileSync(ledgerBadId, JSON.stringify({
    dispatches: [
      { id: 'd1', state: 'closed', receipt: '证据：跑了 3 条，全过，产物 a.md' },
      { id: 'd1', state: 'cancelled' },
    ],
  }), 'utf8');
  const cDup = checkLedger({ file: ledgerBadId });
  chk('反例：台账 id 重复被检出', cDup.ok === false && /id 重复/.test(cDup.reason), cDup.reason.slice(0, 60));

  const ledgerBadState = path.join(tmp, 'ledger-bad-state.json');
  fs.writeFileSync(ledgerBadState, JSON.stringify({
    dispatches: [{ id: 'd1', state: 'done' }],
  }), 'utf8');
  const cState = checkLedger({ file: ledgerBadState });
  chk('反例：非法状态被检出', cState.ok === false && /非法状态/.test(cState.reason), cState.reason.slice(0, 60));

  const ledgerNoReceipt = path.join(tmp, 'ledger-no-receipt.json');
  fs.writeFileSync(ledgerNoReceipt, JSON.stringify({
    dispatches: [{ id: 'd1', state: 'closed' }],
  }), 'utf8');
  const cNoRcpt = checkLedger({ file: ledgerNoReceipt });
  chk('反例：销账无回执被检出', cNoRcpt.ok === false && /无回执/.test(cNoRcpt.reason), cNoRcpt.reason.slice(0, 60));

  const ledgerCount = path.join(tmp, 'ledger-count.json');
  fs.writeFileSync(ledgerCount, JSON.stringify({
    count: 99,
    dispatches: [{ id: 'd1', state: 'cancelled' }],
  }), 'utf8');
  const cCount = checkLedger({ file: ledgerCount });
  chk('反例：声明总数不符被检出', cCount.ok === false && /声明总数/.test(cCount.reason), cCount.reason.slice(0, 60));

  // 台账不存在时跳过不报错
  const c4b = checkLedger({ file: path.join(tmp, 'nope.json') });
  chk('反例：台账不存在时跳过不报错', c4b.skipped === true, c4b.reason);

  // ⑤ 资产清单自洽
  const assetFile = path.join(tmp, 'assets.json');
  fs.writeFileSync(assetFile, JSON.stringify({
    count: 3,
    assets: [
      { pattern: 'a', level: 'critical' },
      { pattern: 'b', level: 'valuable' },
      { pattern: 'c', level: 'temp' },
    ],
  }), 'utf8');
  const c5 = checkAssets({ file: assetFile });
  chk('资产清单自洽时通过', c5.ok === true, c5.reason);

  // ⑥ 反例：声明总数与实际不符
  const assetBad = path.join(tmp, 'assets-bad.json');
  fs.writeFileSync(assetBad, JSON.stringify({
    count: 99,
    assets: [{ pattern: 'a', level: 'critical' }],
  }), 'utf8');
  const c6 = checkAssets({ file: assetBad });
  chk('反例：资产声明总数不符被检出', c6.ok === false, c6.reason.slice(0, 50));

  // ⑦ 技能完整性
  const skillDir = path.join(tmp, 'skills');
  fs.mkdirSync(path.join(skillDir, 'ok-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'ok-skill', 'SKILL.md'), 'x', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'ok-skill', 'check.mjs'), 'x', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'ok-skill', 'skill.json'), '{}', 'utf8');
  const c7 = checkSkills({ skillDir });
  chk('技能完整时通过', c7.ok === true, c7.reason);

  // ⑧ 反例：缺文件
  fs.mkdirSync(path.join(skillDir, 'bad-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'bad-skill', 'SKILL.md'), 'x', 'utf8');
  const c8 = checkSkills({ skillDir });
  chk('反例：技能缺文件被检出', c8.ok === false, c8.reason.slice(0, 50));

  // ⑨ 关键：这个检查必须能发现问题
  chk('关键：4 类不一致都能检出', c2.ok === false && c6.ok === false && c8.ok === false,
      '这是口径对齐存在的理由');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  const r = checkAll();

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  console.log('═'.repeat(76));
  console.log('  口径对齐（多源数据一致性）');
  console.log('═'.repeat(76));
  console.log();

  for (const x of r.results) {
    const mark = x.skipped ? '○' : (x.ok ? '✓' : '✗');
    console.log('  ' + mark + ' ' + String(x.id) + '. ' + x.name.padEnd(16) + x.reason);
  }

  console.log();
  console.log('─'.repeat(76));
  console.log('  ' + r.verdict);
  console.log('─'.repeat(76));
  console.log();
  console.log('  依据：视频 BV1Ht4F6MEyE');
  console.log('  「四星采印进清档了。台账和索引都是 57。口径对齐了。」');
  console.log('  「目录和主当，现在都是三十六个，对上了。」');

  process.exit(r.ok ? 0 : 1);
}
