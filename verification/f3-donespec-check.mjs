/**
 * F-3：DoneSpec 三形态的可行性验证（纯本地，不需要模型）
 *
 * 目标：证明"非编码场景也能写出会失败的 check"，或证明写不出来。
 * 三个非编码场景各写一条 check，每条必须：
 *   1) 输出**差异集合**（不是 0/1）
 *   2) 在正常输入下 exit 0
 *   3) 在**注入一个真实错误**时 exit 非 0，并说出差在哪
 *
 * 使用：node f3-donespec-check.mjs <scenario>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = import.meta.dirname;
// 数据目录可由环境变量覆盖（反例测试用 f3-work，正向用 f3-data）
const dataDir = process.env.F3_DATA_DIR
  ? join(here, process.env.F3_DATA_DIR)
  : join(here, 'f3-data');

function ensureData() {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });

    // 场景 1：客服工单分派 —— 校验：每张工单都恰好有一个负责人，且负责人在值班表里
    writeFileSync(join(dataDir, 'tickets.json'), JSON.stringify([
      { id: 'T-1', topic: '退款', assignee: 'alice' },
      { id: 'T-2', topic: '发票', assignee: 'bob' },
      { id: 'T-3', topic: '物流', assignee: 'carol' },
    ], null, 2));
    writeFileSync(join(dataDir, 'roster.json'), JSON.stringify(['alice', 'bob', 'carol', 'dave'], null, 2));

    // 场景 2：文档一致性 —— 校验：术语表里的每个术语在正文里都出现，且正文没有未登记术语
    writeFileSync(join(dataDir, 'glossary.json'), JSON.stringify(['SLA', 'TAT', 'RCA'], null, 2));
    writeFileSync(join(dataDir, 'doc.txt'),
      '服务等级协议（SLA）承诺 99.9%。响应时限（TAT）为 4 小时。RCA 需在 48 小时内提交。\n');

    // 场景 3：数据核对 —— 校验：两份数据的记录集合完全一致（按 key）
    writeFileSync(join(dataDir, 'sourceA.json'), JSON.stringify([
      { id: 'A-1', amount: 100 }, { id: 'A-2', amount: 200 }, { id: 'A-3', amount: 300 },
    ], null, 2));
    writeFileSync(join(dataDir, 'sourceB.json'), JSON.stringify([
      { id: 'A-1', amount: 100 }, { id: 'A-2', amount: 200 }, { id: 'A-3', amount: 300 },
    ], null, 2));
  }
}

function diffSet(expected, actual, label) {
  const missing = expected.filter(x => !actual.includes(x));
  const extra = actual.filter(x => !expected.includes(x));
  const parts = [];
  if (missing.length) parts.push(`${label} 缺失 ${missing.length}(${missing.join(', ')})`);
  if (extra.length) parts.push(`${label} 多出 ${extra.length}(${extra.join(', ')})`);
  return parts;
}

const scenarios = {
  // ---- 场景 1：客服工单分派 ----
  'support-assign': () => {
    const tickets = JSON.parse(readFileSync(join(dataDir, 'tickets.json'), 'utf8'));
    const roster = JSON.parse(readFileSync(join(dataDir, 'roster.json'), 'utf8'));
    const problems = [];

    const unassigned = tickets.filter(t => !t.assignee).map(t => t.id);
    if (unassigned.length) problems.push(`未分派 ${unassigned.length}(${unassigned.join(', ')})`);

    const notInRoster = tickets.filter(t => t.assignee && !roster.includes(t.assignee))
      .map(t => `${t.id}->${t.assignee}`);
    if (notInRoster.length) problems.push(`负责人不在值班表 ${notInRoster.length}(${notInRoster.join(', ')})`);

    // 一单一 owner：同一 id 出现多次
    const ids = tickets.map(t => t.id);
    const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dups.length) problems.push(`工单重复 ${dups.length}(${[...new Set(dups)].join(', ')})`);

    return { problems };
  },

  // ---- 场景 2：文档一致性 ----
  'doc-consistency': () => {
    const glossary = JSON.parse(readFileSync(join(dataDir, 'glossary.json'), 'utf8'));
    const doc = readFileSync(join(dataDir, 'doc.txt'), 'utf8');
    const problems = [];

    const missing = glossary.filter(term => !doc.includes(term));
    if (missing.length) problems.push(`术语未在正文出现 ${missing.length}(${missing.join(', ')})`);

    // 正文里出现了类似缩写的全大写词，但不在术语表
    const caps = new Set((doc.match(/\b[A-Z]{2,5}\b/g) || []));
    const unregistered = [...caps].filter(w => !glossary.includes(w));
    if (unregistered.length) problems.push(`未登记缩写 ${unregistered.length}(${unregistered.join(', ')})`);

    return { problems };
  },

  // ---- 场景 3：数据核对 ----
  'data-reconcile': () => {
    const a = JSON.parse(readFileSync(join(dataDir, 'sourceA.json'), 'utf8'));
    const b = JSON.parse(readFileSync(join(dataDir, 'sourceB.json'), 'utf8'));
    const problems = [];

    const aIds = a.map(r => r.id);
    const bIds = b.map(r => r.id);
    problems.push(...diffSet(aIds, bIds, '记录 id'));

    // 同 id 金额不一致
    const byId = new Map(b.map(r => [r.id, r]));
    const amountDiffs = a.filter(r => byId.has(r.id) && byId.get(r.id).amount !== r.amount)
      .map(r => `${r.id}:${r.amount}≠${byId.get(r.id).amount}`);
    if (amountDiffs.length) problems.push(`金额不一致 ${amountDiffs.length}(${amountDiffs.join(', ')})`);

    return { problems };
  },
};

ensureData();

const name = process.argv[2];
const fn = scenarios[name];
if (!fn) {
  console.error(`usage: node f3-donespec-check.mjs <${Object.keys(scenarios).join('|')}>`);
  process.exit(2);
}

const { problems } = fn();
if (problems.length === 0) {
  console.log(`PASS ${name}: 差异集合 = 0`);
  process.exit(0);
}
console.log(`FAIL ${name}: 差异集合 = ${problems.length} 项`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
