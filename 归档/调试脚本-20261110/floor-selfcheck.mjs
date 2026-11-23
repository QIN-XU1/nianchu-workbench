/**
 * 不变量下限的元验证：证明"声明过弱"会被拒。
 *
 * 造 3 个弱声明场景（一个比一个更弱），每一个都必须被 floor 检查拦下。
 * 同时造 1 个合规场景，必须通过。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFloor } from './invariant-floor.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m' };

const CASES = [
  {
    name: 'compliant',
    expect: true,          // 达到下限
    protects: ['completeness', 'uniqueness', 'required-field', 'referential-integrity'],
    data: {
      'items.json': [{ id: 'A', name: '甲', owner: 'alice' }],
      'roster.json': ['alice'],
    },
  },
  {
    name: 'too-weak-no-completeness',
    expect: false,
    protects: ['uniqueness'],                    // 两个集合却只声明唯一性
    data: {
      'items.json': [{ id: 'A', name: '甲' }],
      'expected.json': [{ id: 'A', name: '甲' }],
    },
  },
  {
    name: 'too-weak-no-uniqueness',
    expect: false,
    protects: ['completeness'],                  // 有 id 却不声明唯一性
    data: {
      'items.json': [{ id: 'A', name: '甲' }],
      'expected.json': [{ id: 'A', name: '甲' }],
    },
  },
  {
    name: 'too-weak-empty',
    expect: false,
    protects: [],                                // 什么都不声明
    data: {
      'items.json': [{ id: 'A', name: '甲', owner: 'alice' }],
      'roster.json': ['alice'],
    },
  },
];

let pass = 0;
for (const c of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  for (const [f, v] of Object.entries(c.data)) {
    writeFileSync(join(data, f), JSON.stringify(v, null, 2));
  }
  const scene = { id: c.name, dataDir: data, protects: c.protects };
  const r = checkFloor(scene);

  const ok = r.ok === c.expect;
  if (ok) pass++;
  const mark = ok ? `${C.green}OK  ` : `${C.red}MISS`;
  console.log(`${mark}${C.reset} ${c.name.padEnd(28)} 期望=${c.expect ? '达下限' : '拦下'} 实际=${r.ok ? '达下限' : '拦下'}`);
  if (!r.ok) {
    for (const m of r.missing) console.log(`${C.dim}      缺 ${m.invariant}: ${m.reason}${C.reset}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n===== 不变量下限元验证：${pass}/${CASES.length} =====`);
const allOk = pass === CASES.length;
console.log(allOk
  ? `${C.green}下限有效：过弱声明会被拦下${C.reset}`
  : `${C.red}下限无效：过弱声明被放过${C.reset}`);
process.exit(allOk ? 0 : 1);
