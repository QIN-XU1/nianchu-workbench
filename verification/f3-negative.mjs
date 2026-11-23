// F-3 反例测试：注入真实错误，验证三个 check 都会"红"且说出差异集合
import { readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = import.meta.dirname;
const base = join(here, 'f3-data');
const work = join(here, 'f3-work');

function reset() {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  cpSync(base, work, { recursive: true });
}

function runCheck(scene) {
  try {
    const out = execFileSync('node', [join(here, 'f3-donespec-check.mjs'), scene], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, F3_DATA_DIR: 'f3-work' },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const cases = [
  {
    scene: 'support-assign',
    name: '注入一个未分派工单',
    mutate() {
      const p = join(work, 'tickets.json');
      const t = JSON.parse(readFileSync(p, 'utf8'));
      t[1].assignee = null;
      writeFileSync(p, JSON.stringify(t, null, 2));
    },
    expect: '未分派',
  },
  {
    scene: 'support-assign',
    name: '注入一个负责人不在值班表',
    mutate() {
      const p = join(work, 'tickets.json');
      const t = JSON.parse(readFileSync(p, 'utf8'));
      t[2].assignee = 'zombie';
      writeFileSync(p, JSON.stringify(t, null, 2));
    },
    expect: '负责人不在值班表',
  },
  {
    scene: 'doc-consistency',
    name: '删掉正文里的 SLA',
    mutate() {
      const p = join(work, 'doc.txt');
      const d = readFileSync(p, 'utf8').replace(/SLA/g, '服务承诺');
      writeFileSync(p, d);
    },
    expect: '术语未在正文出现',
  },
  {
    scene: 'doc-consistency',
    name: '正文引入未登记缩写 XYZ',
    mutate() {
      const p = join(work, 'doc.txt');
      writeFileSync(p, readFileSync(p, 'utf8') + '\nXYZ 也要遵守。\n');
    },
    expect: '未登记缩写',
  },
  {
    scene: 'data-reconcile',
    name: 'B 源少一条记录',
    mutate() {
      const p = join(work, 'sourceB.json');
      const b = JSON.parse(readFileSync(p, 'utf8'));
      b.pop();
      writeFileSync(p, JSON.stringify(b, null, 2));
    },
    expect: '缺失',
  },
  {
    scene: 'data-reconcile',
    name: 'A/B 金额不一致',
    mutate() {
      const p = join(work, 'sourceB.json');
      const b = JSON.parse(readFileSync(p, 'utf8'));
      b[0].amount = 999;
      writeFileSync(p, JSON.stringify(b, null, 2));
    },
    expect: '金额不一致',
  },
];

let passed = 0;
for (const c of cases) {
  reset();
  c.mutate();
  const r = runCheck(c.scene);
  const redOk = r.code !== 0;
  const saysWhy = r.out.includes(c.expect);
  const hasDiffSet = /\d+(\([^)]*\))|\d+ 项/.test(r.out);
  const ok = redOk && saysWhy && hasDiffSet;
  if (ok) passed++;
  console.log(`${ok ? 'OK  ' : 'MISS'} [${c.scene}] ${c.name}`);
  console.log(`       exit=${r.code} 红=${redOk} 说出原因=${saysWhy} 有差异集合=${hasDiffSet}`);
  console.log(`       输出: ${r.out.trim().split('\n').slice(0, 3).join(' | ')}`);
}
reset();
console.log(`\n反例通过 ${passed}/${cases.length}`);
process.exit(passed === cases.length ? 0 : 1);
