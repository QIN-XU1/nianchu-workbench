/**
 * 文档密度索引的元验证。
 *
 * 造 5 种目录形态，验证判据正确：
 *   1. 密集（35 文档，无索引）→ MUST_INDEX
 *   2. 密集 + 有索引 → HAS_INDEX
 *   3. 中等（18 文档）→ SHOULD_INDEX
 *   4. 稀疏（5 文档）→ SPARSE_OK
 *   5. 豁免目录（备份/35 文档）→ 不出现在扫描结果里
 *   6. 体检 overall ok 只在无 MUST_INDEX 时为 true
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, judge, check, DEFAULTS } from './doc-index-judge.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m' };

const tmp = mkdtempSync(join(tmpdir(), 'docidx-'));
let pass = 0, total = 0;

function mkDocs(dir, n, ext = '.md') {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `d${i}${ext}`), `# doc ${i}\n`, 'utf8');
}

// 1. 密集无索引
mkDocs(join(tmp, 'dense'), 35);
// 2. 密集 + 索引
mkDocs(join(tmp, 'dense-with-index'), 35);
writeFileSync(join(tmp, 'dense-with-index', 'INDEX.md'), '# index\n', 'utf8');
// 3. 中等
mkDocs(join(tmp, 'medium'), 18);
// 4. 稀疏
mkDocs(join(tmp, 'sparse'), 5);
// 5. 备份目录（应豁免）
mkDocs(join(tmp, '备份'), 35);
mkDocs(join(tmp, 'node_modules'), 40);

const profiles = scan(tmp).map(e => judge(e));
const byRel = {};
for (const p of profiles) byRel[p.rel] = p;

function expect(rel, verdict) {
  total++;
  const p = byRel[rel];
  const ok = p && p.verdict === verdict;
  if (ok) pass++;
  const mark = ok ? `${C.green}OK  ` : `${C.red}MISS`;
  console.log(`${mark}${C.reset} ${rel.padEnd(26)} 期望=${verdict.padEnd(13)} 实际=${p ? p.verdict : '(未扫描)'} 文档=${p ? p.docCount : '-'}`);
  if (!ok && p) for (const r of p.reasons) console.log(`${C.dim}      ${r}${C.reset}`);
}

expect('.', 'SPARSE_OK');                      // 根目录本身只有 0 个直接文档
expect('dense', 'MUST_INDEX');
expect('dense-with-index', 'HAS_INDEX');
expect('medium', 'SHOULD_INDEX');
expect('sparse', 'SPARSE_OK');

// 豁免检查
total++;
const exemptOk = !byRel['备份'] && !byRel['node_modules'];
if (exemptOk) pass++;
const mark = exemptOk ? `${C.green}OK  ` : `${C.red}MISS`;
console.log(`${mark}${C.reset} ${'豁免目录不出现在扫描中'.padEnd(26)} 备份=${!!byRel['备份']} node_modules=${!!byRel['node_modules']}`);

// 体检
const r1 = check(tmp);
total++;
const checkOk = r1.ok === false && r1.mustIndex.length === 1 && r1.mustIndex[0].rel === 'dense';
if (checkOk) pass++;
const mark2 = checkOk ? `${C.green}OK  ` : `${C.red}MISS`;
console.log(`${mark2}${C.reset} ${'体检抓到 1 个该建索引的目录'.padEnd(26)} ok=${r1.ok} 违规=${r1.mustIndex.map(m => m.rel).join(',')}`);

// 补索引后应通过
writeFileSync(join(tmp, 'dense', 'INDEX.md'), '# index\n', 'utf8');
const r2 = check(tmp);
total++;
const fixedOk = r2.ok === true;
if (fixedOk) pass++;
const mark3 = fixedOk ? `${C.green}OK  ` : `${C.red}MISS`;
console.log(`${mark3}${C.reset} ${'补索引后体检通过'.padEnd(26)} ok=${r2.ok}`);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n===== 文档索引判据元验证：${pass}/${total} =====`);
const allOk = pass === total;
console.log(allOk
  ? `${C.green}索引判据有效：密集目录必须建索引，稀疏与豁免目录正确跳过${C.reset}`
  : `${C.red}索引判据有缺陷${C.reset}`);
process.exit(allOk ? 0 : 1);
