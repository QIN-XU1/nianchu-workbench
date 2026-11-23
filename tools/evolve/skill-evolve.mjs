#!/usr/bin/env node
/**
 * 技能自进化（按实际使用）—— 2026-11-23
 *
 * 【为什么需要它】技能现在是人写的、写死的。用户要的是「按实际使用自进化」：
 * 用得多的技能该被巩固，老失效的该被重写，从没人用的该退役，反复失败又没技能
 * 覆盖的任务该长出新技能。这些**都能从真实调用记录里算出来**，不需要拍脑袋。
 *
 * 用法：
 *   node tools/evolve/skill-evolve.mjs record --skill <name> --outcome success|fail|correction [--note "..."]
 *   node tools/evolve/skill-evolve.mjs report [--json]
 *
 * 数据：.nianchu/skills/usage.jsonl（追加写，一行一条）
 * 四态：0 = PASS（报告已产出）/ 1 = FAIL / 2 = UNKNOWN
 */
import fs from 'node:fs';
import path from 'node:path';

const USAGE = path.join('.nianchu', 'skills', 'usage.jsonl');

function ensureDir() {
  fs.mkdirSync(path.dirname(USAGE), { recursive: true });
}

function append(rec) {
  ensureDir();
  fs.appendFileSync(USAGE, JSON.stringify(rec) + '\n', 'utf8');
}

function readAll() {
  if (!fs.existsSync(USAGE)) return [];
  return fs
    .readFileSync(USAGE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function report(json) {
  const rows = readAll();
  const bySkill = new Map();
  for (const r of rows) {
    const k = r.skill || '(unknown)';
    if (!bySkill.has(k)) bySkill.set(k, { skill: k, total: 0, success: 0, fail: 0, correction: 0, last: null });
    const s = bySkill.get(k);
    s.total += 1;
    if (r.outcome === 'success') s.success += 1;
    else if (r.outcome === 'fail') s.fail += 1;
    else if (r.outcome === 'correction') s.correction += 1;
    s.last = r.ts || s.last;
  }
  const list = [...bySkill.values()].map((s) => ({
    ...s,
    successRate: s.total ? Number((s.success / s.total).toFixed(3)) : 0,
  }));
  list.sort((a, b) => b.total - a.total);

  // 四个动作（阈值写死，可复算）
  const propose = {
    /** 高频成功：巩固（保留并补样例） */
    consolidate: list.filter((s) => s.total >= 5 && s.successRate >= 0.8),
    /** 高频失败：重写（成功率 < 0.5 且样本 ≥ 3） */
    rewrite: list.filter((s) => s.total >= 3 && s.successRate < 0.5),
    /** 从未使用：淘汰候选（需要外部技能清单才能判「从未」，这里只列历史里有记录的） */
    stale: list.filter((s) => s.total > 0 && (!s.last || Date.now() - Date.parse(s.last) > 30 * 864e5)),
    /** 校正频繁：说明技能在误导，优先改描述/路由 */
    misleading: list.filter((s) => s.correction >= 2),
  };

  if (json) {
    console.log(JSON.stringify({ totalRecords: rows.length, skills: list, propose }, null, 2));
    return 0;
  }

  console.log('技能使用报告（' + rows.length + ' 条记录，' + list.length + ' 个技能）\n');
  if (!list.length) {
    console.log('  （还没有记录。用 record 子命令记一次调用再来看。）');
    return 0;
  }
  for (const s of list) {
    console.log(
      `  ${s.skill.padEnd(32)} 用 ${String(s.total).padStart(3)} 次 · 成 ${(s.successRate * 100).toFixed(0)}% · 校正 ${s.correction}`
    );
  }
  const show = (title, arr, hint) => {
    if (!arr.length) return;
    console.log('\n' + title);
    for (const s of arr) console.log('  · ' + s.skill + '  ' + hint(s));
  };
  show('【巩固】高频成功，值得补样例/固化流程：', propose.consolidate, (s) => `用 ${s.total} 次，成 ${(s.successRate * 100).toFixed(0)}%`);
  show('【重写】高频失败，描述或流程有问题：', propose.rewrite, (s) => `成 ${(s.successRate * 100).toFixed(0)}%`);
  show('【误导】校正 ≥2 次，说明它教错了：', propose.misleading, (s) => `校正 ${s.correction} 次`);
  show('【陈旧】30 天没再用：', propose.stale, (s) => `最后 ${s.last || '未知'}`);
  return 0;
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'record') {
    const get = (k) => {
      const i = argv.indexOf('--' + k);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const skill = get('skill');
    const outcome = get('outcome');
    if (!skill || !outcome) {
      console.error('  ✗ 需要 --skill 和 --outcome');
      return 1;
    }
    append({ skill, outcome, note: get('note') || null, ts: new Date().toISOString() });
    console.log('  ✓ 已记录：' + skill + ' → ' + outcome);
    return 0;
  }
  if (cmd === 'report' || !cmd) {
    return report(argv.includes('--json'));
  }
  console.error('  ✗ 未知子命令：' + cmd);
  return 1;
}

process.exit(main(process.argv.slice(2)));
