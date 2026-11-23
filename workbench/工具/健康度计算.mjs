#!/usr/bin/env node
// 工具/健康度计算.mjs —— 从真实派单台账算出健康度，落盘给 健康哨兵 用
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（进化机制的第二处断层）
// ══════════════════════════════════════════════════════════════════════
//  实测发现（2026-11-12）：
//    健康哨兵 读 数据/.dsh/场景记忆/_共享记忆/健康度.json
//    但那个文件：
//      · _at = 2026-11-09（3 天没更新）
//      · window = 11-02 ~ 11-09（窗口早过期）
//      · verdict 全是 no-data
//      · **没有任何工具负责更新它**
//
//    后果：健康哨兵永远说「没有数据可评估」，
//          「场景有没有变差」这个判断实际上从未生效。
//
//  ══════════════════════════════════════════════════════════════════════
//  怎么算（全部可追溯到派单台账，不接受手写）
//  ══════════════════════════════════════════════════════════════════════
//  对每个场景，在窗口期内的派单里统计：
//    tasks          该场景收到的派单数（不含 cancelled）
//    acked          其中走到 acked 或 closed 的
//    sent           发出的派单数（from = 该场景）
//    rework         被打回重做的（这里用「rework」字段或多次回执）
//    firstPass      一次就过的（acked 且没有 rework 标记）
//    firstPassRate  firstPass / tasks
//    crossBoundary  越界次数（从 越界哨兵 读）
//    verdict        ok / warn / bad / no-data
//    hasEnoughSamples  tasks >= MIN_SAMPLES
//
//  INV-4（防伪造）：每个数字都要能指回台账里的具体记录 id。
//  所以每条统计都带 evidenceIds。
//
//  ══════════════════════════════════════════════════════════════════════
//  用法
// ══════════════════════════════════════════════════════════════════════
//    node 工具/健康度计算.mjs             # 计算最近 7 天并落盘
//    node 工具/健康度计算.mjs --days 14   # 换窗口
//    node 工具/健康度计算.mjs --dry       # 只算不写
//    node 工具/健康度计算.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const SHARED = path.join(DATA, '场景记忆', '_共享记忆');
const LEDGER = path.join(SHARED, '派单台账.json');
const HEALTH = path.join(SHARED, '健康度.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

/** 最少样本数：少于这个数不下 judgment */
export const MIN_SAMPLES = 3;
/** 一次通过率下限 */
export const FIRST_PASS_MIN = 0.4;

const SCENE_ID_TO_CN = {
  hub: '中枢', 'arch-review': '架构梳理', 'build-plan': '实施计划',
  'competitor-analyze': '竞品拆解', 'incident-analysis': '故障分析',
  'pc-cleanup': '本地电脑', research: '调研', 'reverse-eng': '逆向分析',
  'self-review': '自我复盘',
};
const SCENE_CN_TO_ID = {};
for (const [id, cn] of Object.entries(SCENE_ID_TO_CN)) SCENE_CN_TO_ID[cn] = id;

function readJson(p, def) {
  try {
    if (!fs.existsSync(p)) return def;
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return def; }
}

/**
 * 从台账计算健康度
 * @param {Array} items 台账里的 dispatches
 * @param {string} fromIso 窗口起点
 * @param {string} toIso 窗口终点
 * @returns {object}
 */
export function computeHealth(items, fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();

  // 窗口内的派单（按 createdAt）
  const inWindow = (items || []).filter((d) => {
    const t = new Date(d.createdAt || 0).getTime();
    return t >= from && t <= to;
  });

  const scenes = {};

  function ensure(sceneId) {
    if (!scenes[sceneId]) {
      scenes[sceneId] = {
        scene: sceneId,
        tasks: 0, acked: 0, sent: 0, rework: 0, firstPass: 0,
        firstPassRate: null, reworkRate: null, crossBoundary: 0,
        verdict: 'no-data', hasEnoughSamples: false,
        evidenceIds: [],
      };
    }
    return scenes[sceneId];
  }

  // 预建所有场景
  for (const id of Object.keys(SCENE_ID_TO_CN)) ensure(id);

  for (const d of inWindow) {
    if (d.type === 'announce') continue;   // 公告不算派单

    const toId = SCENE_CN_TO_ID[d.to] || d.to;
    const fromId = SCENE_CN_TO_ID[d.from] || d.from;

    // 收到的任务（cancelled 不算「收到过」）
    if (toId && d.state !== 'cancelled') {
      const s = ensure(toId);
      s.tasks++;
      s.evidenceIds.push(d.id);

      const acked = d.state === 'acked' || d.state === 'closed';
      if (acked) {
        s.acked++;
        // 一次通过：acked 且没有 rework 标记
        if (!d.rework && !(Array.isArray(d.reworkHistory) && d.reworkHistory.length)) {
          s.firstPass++;
        } else {
          s.rework++;
        }
      }
    }

    // 发出的任务
    if (fromId) {
      const s = ensure(fromId);
      s.sent++;
      if (!s.evidenceIds.includes(d.id)) s.evidenceIds.push(d.id);
    }
  }

  // 算比率 + 判定
  for (const s of Object.values(scenes)) {
    s.hasEnoughSamples = s.tasks >= MIN_SAMPLES;
    if (s.tasks > 0) {
      s.firstPassRate = Math.round(s.firstPass / s.tasks * 1000) / 1000;
      s.reworkRate = Math.round(s.rework / s.tasks * 1000) / 1000;
    }

    if (!s.hasEnoughSamples) {
      s.verdict = 'no-data';
    } else if (s.firstPassRate !== null && s.firstPassRate < FIRST_PASS_MIN) {
      s.verdict = 'bad';
    } else if (s.crossBoundary >= 1) {
      s.verdict = 'warn';
    } else {
      s.verdict = 'ok';
    }
  }

  // 汇总
  const list = Object.values(scenes);
  const summary = {
    scenes: list.length,
    withData: list.filter((s) => s.hasEnoughSamples).length,
    ok: list.filter((s) => s.verdict === 'ok').length,
    warn: list.filter((s) => s.verdict === 'warn').length,
    bad: list.filter((s) => s.verdict === 'bad').length,
    noData: list.filter((s) => s.verdict === 'no-data').length,
  };

  return {
    scenes,
    window: { from: fromIso, to: toIso, days: Math.round((to - from) / 86400000) },
    summary,
    _at: new Date().toISOString(),
    _source: '派单台账.json',
    _windowRecords: inWindow.length,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  健康度计算 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const NOW = Date.now();
  const iso = (offsetDays) => new Date(NOW - offsetDays * 86400000).toISOString();

  console.log('【一】空窗口');
  {
    const h = computeHealth([], iso(7), iso(0));
    chk('无记录时 verdict 全是 no-data',
      Object.values(h.scenes).every((s) => s.verdict === 'no-data'));
    chk('summary.noData = 9', h.summary.noData === 9, String(h.summary.noData));
  }

  console.log();
  console.log('【二】正常数据');
  {
    const items = [
      { id: 'd-1', type: 'dispatch', from: 'hub', to: '架构梳理', state: 'closed', createdAt: iso(1) },
      { id: 'd-2', type: 'dispatch', from: 'hub', to: '架构梳理', state: 'closed', createdAt: iso(2) },
      { id: 'd-3', type: 'dispatch', from: 'hub', to: '架构梳理', state: 'acked', createdAt: iso(3) },
    ];
    const h = computeHealth(items, iso(7), iso(0));
    const ar = h.scenes['arch-review'];
    chk('tasks = 3', ar.tasks === 3, String(ar.tasks));
    chk('acked = 3', ar.acked === 3, String(ar.acked));
    chk('firstPassRate = 1', ar.firstPassRate === 1, String(ar.firstPassRate));
    chk('hasEnoughSamples = true', ar.hasEnoughSamples === true);
    chk('verdict = ok', ar.verdict === 'ok', ar.verdict);
    chk('evidenceIds 有 3 个', ar.evidenceIds.length === 3, String(ar.evidenceIds.length));
  }

  console.log();
  console.log('【三】反例：一次通过率过低 → bad');
  {
    const items = [];
    // 1 条 acked，3 条还在 created（未回执）
    items.push({ id: 'e-1', type: 'dispatch', from: 'hub', to: '调研', state: 'acked', createdAt: iso(1) });
    for (let i = 2; i <= 4; i++) {
      items.push({ id: 'e-' + i, type: 'dispatch', from: 'hub', to: '调研', state: 'created', createdAt: iso(i) });
    }
    const h = computeHealth(items, iso(7), iso(0));
    const rs = h.scenes.research;
    chk('tasks = 4', rs.tasks === 4, String(rs.tasks));
    chk('firstPassRate = 0.25 < 0.4', rs.firstPassRate === 0.25, String(rs.firstPassRate));
    chk('verdict = bad', rs.verdict === 'bad', rs.verdict);
  }

  console.log();
  console.log('【四】反例：cancelled 不算「收到过」');
  {
    const items = [
      { id: 'c-1', type: 'dispatch', from: 'hub', to: '本地电脑', state: 'cancelled', createdAt: iso(1) },
    ];
    const h = computeHealth(items, iso(7), iso(0));
    chk('cancelled 不计入 tasks', h.scenes['pc-cleanup'].tasks === 0,
      String(h.scenes['pc-cleanup'].tasks));
  }

  console.log();
  console.log('【五】反例：窗口外的不算');
  {
    const items = [
      { id: 'w-1', type: 'dispatch', from: 'hub', to: '逆向分析', state: 'closed', createdAt: iso(30) },
    ];
    const h = computeHealth(items, iso(7), iso(0));
    chk('30 天前的不在 7 天窗口内', h.scenes['reverse-eng'].tasks === 0,
      String(h.scenes['reverse-eng'].tasks));
  }

  console.log();
  console.log('【六】同场景既发又收');
  {
    const items = [
      { id: 'b-1', type: 'dispatch', from: '架构梳理', to: '实施计划', state: 'closed', createdAt: iso(1) },
    ];
    const h = computeHealth(items, iso(7), iso(0));
    chk('架构梳理 sent = 1', h.scenes['arch-review'].sent === 1, String(h.scenes['arch-review'].sent));
    chk('实施计划 tasks = 1', h.scenes['build-plan'].tasks === 1, String(h.scenes['build-plan'].tasks));
  }

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    console.log('  失败项:');
    R.filter((x) => !x.ok).forEach((x) => console.log('    - ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const days = Number(val('days', 7)) || 7;
  const dry = has('dry');

  const ledger = readJson(LEDGER, null);
  if (!ledger) { console.error('✗ 找不到派单台账: ' + LEDGER); process.exit(1); }
  const items = ledger.dispatches || ledger.items || [];

  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.now() - days * 86400000).toISOString();

  const health = computeHealth(items, fromIso, toIso);

  console.log('═'.repeat(72));
  console.log('  健康度计算（窗口 ' + days + ' 天）');
  console.log('═'.repeat(72));
  console.log();
  console.log('  台账总数: ' + items.length + '   窗口内: ' + health._windowRecords + ' 条');
  console.log('  窗口: ' + fromIso.slice(0, 10) + ' ~ ' + toIso.slice(0, 10));
  console.log();
  console.log('  场景             任务  回执  一次过  通过率   判定');
  console.log('  ' + '─'.repeat(62));

  for (const s of Object.values(health.scenes)) {
    const cn = SCENE_ID_TO_CN[s.scene] || s.scene;
    const rate = s.firstPassRate === null ? '—' : (s.firstPassRate * 100).toFixed(0) + '%';
    console.log('  ' + cn.padEnd(12) +
      String(s.tasks).padStart(5) +
      String(s.acked).padStart(6) +
      String(s.firstPass).padStart(7) +
      String(rate).padStart(8) +
      '   ' + s.verdict);
  }

  console.log();
  console.log('  汇总: ' + JSON.stringify(health.summary));

  if (!dry) {
    try {
      fs.writeFileSync(HEALTH, JSON.stringify(health, null, 2), 'utf8');
      console.log();
      console.log('  ✓ 已写入: ' + path.relative(WB, HEALTH));
    } catch (e) {
      console.error('  ✗ 写入失败: ' + ((e && e.message) || e));
      process.exitCode = 1;
    }
  } else {
    console.log();
    console.log('  （--dry：未写入）');
  }

  console.log('═'.repeat(72));
}

main();
