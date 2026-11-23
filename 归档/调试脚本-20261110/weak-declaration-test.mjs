/**
 * 验证：声明过弱的场景，门禁会不会拒？
 * 造一个"有两个集合但只声明 uniqueness"的场景，check 也写得对，
 * 门禁必须因 G0.5 失败而 REJECT。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from './gate.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m' };

const dir = mkdtempSync(join(tmpdir(), 'weak-'));
const data = join(dir, 'data');
mkdirSync(data, { recursive: true });

writeFileSync(join(data, 'a.json'), JSON.stringify([{ id: 'x', name: '甲' }], null, 2));
writeFileSync(join(data, 'b.json'), JSON.stringify([{ id: 'x', name: '甲' }], null, 2));

// 一个完全正确的 check（比较两个集合）
writeFileSync(join(dir, 'check.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const DATA = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data');",
  "const a = JSON.parse(readFileSync(join(DATA,'a.json'),'utf8'));",
  "const b = JSON.parse(readFileSync(join(DATA,'b.json'),'utf8'));",
  "const problems=[];",
  "const ai=a.map(x=>x.id), bi=b.map(x=>x.id);",
  "const miss=ai.filter(x=>!bi.includes(x)); const extra=bi.filter(x=>!ai.includes(x));",
  "if(miss.length) problems.push(`缺失 ${miss.length}(${miss.join(', ')})`);",
  "if(extra.length) problems.push(`多出 ${extra.length}(${extra.join(', ')})`);",
  "if(problems.length===0){console.log('PASS weak: 差异集合 = 0');process.exit(0);}",
  "console.log(`FAIL weak: 差异集合 = ${problems.length} 项`);",
  "for(const p of problems) console.log('  - '+p);",
  "process.exit(1);",
].join('\n'));

const scene = {
  id: 'weak-declaration',
  name: '弱声明场景',
  desc: '有两个集合却只声明 uniqueness',
  check: join(dir, 'check.mjs'),
  dataDir: data,
  protects: ['uniqueness'],          // ← 故意过弱：没有 completeness
};

const r = validate(scene.check, scene);
const rejected = r.verdict === 'REJECT';
const dueToFloor = r.gates.G0_5_meets_floor === false;

console.log(`${rejected && dueToFloor ? C.green + 'OK  ' : C.red + 'MISS'}${C.reset} 弱声明场景`);
console.log(`  verdict=${r.verdict}`);
console.log(`  G0_declares=${r.gates.G0_declares_invariants}`);
console.log(`  G0_5_floor=${r.gates.G0_5_meets_floor}`);
console.log(`  G2=${r.gates.G2_all_mutations_caught}`);
for (const why of r.reasons) console.log(`  ${C.red}· ${why}${C.reset}`);

rmSync(dir, { recursive: true, force: true });

const ok = rejected && dueToFloor;
console.log(`\n===== 弱声明拦下测试：${ok ? '1/1' : '0/1'} =====`);
console.log(ok
  ? `${C.green}门禁会因"声明过弱"而拒绝${C.reset}`
  : `${C.red}门禁放过了过弱声明 —— 下限未生效${C.reset}`);
process.exit(ok ? 0 : 1);
