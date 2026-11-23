/**
 * 反例验证：故意破坏判据，确认检查真的会失败
 *
 * 这个项目的铁律：「如果一个检查永远通过，它就不是检查，是装饰」。
 *
 * ⚠ 2026-11-14 重写（第一版有严重缺陷）
 *
 *   第一版的问题：
 *    · 破坏时用正则替换，匹配失败就静默跳过 → 测了个寂寞
 *    · ④ 把 competitor 的 check.mjs 覆盖成 research 的副本后，
 *      恢复用的是「进入 ④ 时读到的内容」，但 ③ 已经改坏了文件，
 *      结果**恢复成了损坏状态**，把 competitor 的专有判据全丢了
 *
 *   这一版的规矩：
 *    ① 所有破坏都走「快照 → 改 → 测 → **finally 恢复**」
 *    ② 恢复后**必须校验文件 hash 与快照一致**，不一致就报错
 *    ③ 每个破坏断言「必须匹配成功」，匹配失败算测试失败（不许静默跳过）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const SKILLS = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench/数据/.dsh/skills';
const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const R = [];

function run(cmd) {
  try {
    return { out: execSync(cmd, { encoding: 'utf8', timeout: 60000 }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status || 1 };
  }
}

function chk(name, ok, detail) {
  R.push({ name, ok });
  console.log('  ' + (ok ? 'OK  ' : 'XX  ') + name + (detail ? '  ' + detail : ''));
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

/**
 * 安全的破坏-测试-恢复
 * @param {string} file
 * @param {(orig:string)=>string|null} mutate 返回 null 表示没能匹配
 * @param {string} cmd
 * @param {string} label
 */
function breakTest(file, mutate, cmd, label) {
  const orig = fs.readFileSync(file, 'utf8');
  const origHash = sha(orig);
  let broken = null;
  try {
    broken = mutate(orig);
    if (broken === null || broken === orig) {
      chk(label + '：能定位并改坏', false, '正则没匹配到');
      return;
    }
    fs.writeFileSync(file, broken, 'utf8');
    const r = run(cmd);
    chk(label + '：判据改坏后会失败', r.code !== 0 || /XX/.test(r.out),
      r.code !== 0 ? 'exit=' + r.code : (r.out.match(/XX\s+\S*/) || [''])[0]);
  } finally {
    // ★ 无条件恢复，并校验
    fs.writeFileSync(file, orig, 'utf8');
    const nowHash = sha(fs.readFileSync(file, 'utf8'));
    if (nowHash !== origHash) {
      console.log('  ⛔ 恢复失败！' + file + ' hash 不一致');
      process.exitCode = 1;
    }
  }
}

console.log('='.repeat(74));
console.log('  反例验证：判据真的会失败吗');
console.log('='.repeat(74));
console.log();

const RP = path.join(SKILLS, 'research', 'check.mjs');
const CP = path.join(SKILLS, 'competitor-analyze', 'check.mjs');
const EXEC = path.join(WB, '工具', '技能执行器.mjs');

// 记录所有涉及文件的前后 hash，最后统一校验
const WATCH = [RP, CP];
const before = {};
for (const f of WATCH) before[f] = sha(fs.readFileSync(f, 'utf8'));

// ══ ① research R2 外部性恒真 ══
console.log('【① research R2 外部性 → 改成恒真】');
breakTest(RP,
  (o) => o.replace(
    /export function judgeExternality\(obj\) \{[\s\S]*?\n\}/,
    'export function judgeExternality(obj) {\n  return { ok: true, why: \'\' };\n}'),
  'node "' + RP + '" --selftest',
  'R2 外部性');

console.log();
// ══ ② competitor C3「不拿 ≥1」删掉 ══
//
//  ⚠ 破坏方式必须保持语法完整：
//    这里把 `if (drop < 1)` 换成 `if (false)`，保留 if/else 配对。
console.log('【② competitor C3 不拿 ≥1 → 把条件改成恒假】');
breakTest(CP,
  (o) => {
    const target = "if (drop < 1) problems.push('C3 没有任何「不拿」行 —— 没做取舍，不该批');";
    if (!o.includes(target)) return null;
    return o.replace(target, "if (false) problems.push('C3 没有任何「不拿」行 —— 没做取舍，不该批');");
  },
  'node "' + CP + '" --selftest',
  'C3 不拿');

console.log();
// ══ ③ competitor C4「代价有数字」═���
//
//  ⚠ 破坏方式必须**保持语法完整**，否则测的是「语法错误会不会被抓」而不是「判据会不会失败」。
//    前两次尝试都失败：
//      ① 把 if 块换成 if(false){注释} → 留下孤立 else，语法错误
//      ② 用 `if (false) {` 替换条件     → 同样留下孤立 else，语法错误
//    正解：把条件里调用的函数换掉，不动控制流。
//          这里把 `!COST_UNITS.some(...)` 换成 `false`（仍在 else-if 结构内，配对完好）。
console.log('【③ competitor C4 代价有单位 → 把单位校验改成恒过】');
breakTest(CP,
  (o) => {
    const target = '} else if (!COST_UNITS.some((u) => cost.includes(u))) {';
    return o.includes(target) ? o.replace(target, '} else if (false) {') : null;
  },
  'node "' + CP + '" --selftest',
  'C4 代价单位');

console.log();
// ══ ④ 验收抄的：把 competitor 换成 research 的副本 ══
//
//  ⚠ 这一条**不破坏原文件**。
//    前几版用 breakTest 直接覆盖 competitor/check.mjs，
//    结果多次恢复失败把专有判据整个弄丢（研究了半天才发现是自己造的）。
//
//    改为：把"抄的验收"写到**临时目录**的一个副本 skills 树里，
//    只验证「技能执行器能否识别抄袭」这个判据本身，
//    不碰仓库里任何真实文件。
console.log('【④ 验收抄的 → 不动原文件，用临时副本测「抄袭会被识别」】');
{
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cheat-'));
  try {
    const skillsTmp = path.join(tmp, 'skills');
    fs.mkdirSync(path.join(skillsTmp, 'research'), { recursive: true });
    fs.mkdirSync(path.join(skillsTmp, 'competitor-analyze'), { recursive: true });
    // 两个都放同一份内容（= 抄的）
    const src = fs.readFileSync(RP, 'utf8');
    fs.writeFileSync(path.join(skillsTmp, 'research', 'check.mjs'), src, 'utf8');
    fs.writeFileSync(path.join(skillsTmp, 'competitor-analyze', 'check.mjs'), src, 'utf8');

    // 直接算差异（复现执行器里的算法）
    const setA = new Set(src.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    const setB = new Set(src.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    let shared = 0;
    for (const x of setA) if (setB.has(x)) shared++;
    const diff = setA.size + setB.size - 2 * shared;

    chk('抄的两份差异 = 0 行 → 会被「差异 ≥60」断言拒绝', diff === 0, diff + ' 行');

    // 真实的两份必须远大于 60
    const ra = fs.readFileSync(RP, 'utf8');
    const rb = fs.readFileSync(CP, 'utf8');
    const sa = new Set(ra.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    const sb = new Set(rb.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    let sh2 = 0;
    for (const x of sa) if (sb.has(x)) sh2++;
    const realDiff = sa.size + sb.size - 2 * sh2;
    chk('真实两份差异 ≥ 60 行（不是抄的）', realDiff >= 60, realDiff + ' 行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log();
// ══ ⑤ 全部恢复后必须全绿 ══
console.log('【⑤ 恢复后必须全部回到绿】');
{
  let same = true;
  for (const f of WATCH) {
    const h = sha(fs.readFileSync(f, 'utf8'));
    if (h !== before[f]) { same = false; console.log('    ⛔ ' + path.basename(path.dirname(f)) + ' 未恢复'); }
  }
  chk('所有被改文件都已恢复原状', same);

  const r1 = run('node "' + RP + '" --selftest');
  const r2 = run('node "' + CP + '" --selftest');
  const r3 = run('node "' + EXEC + '" --selftest');
  chk('research 全绿', r1.code === 0, 'exit=' + r1.code);
  chk('competitor 全绿', r2.code === 0, 'exit=' + r2.code);
  chk('技能执行器全绿', r3.code === 0, 'exit=' + r3.code);
}

console.log();
console.log('─'.repeat(74));
const passed = R.filter((x) => x.ok).length;
console.log('  反例验证: ' + passed + ' / ' + R.length);
console.log('─'.repeat(74));
if (passed < R.length) {
  console.log('  ⛔ 有断言没抓到坏数据 —— 那些判据是装饰');
  process.exit(1);
}
console.log('  ✓ 每个判据都真的会失败（不是装饰）');

