import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import * as undoStore from './undo.mjs';
import { discover, healthy } from './scene-loader.mjs';

const HERE = import.meta.dirname;
const SEA = join(HERE, 'sea.mjs');
const GATE = join(HERE, 'gate-cli.mjs');
const SCENES_ROOT = join(HERE, 'scenes');
const SNAPS = join(HERE, '.snapshots');

function run(args = [], opts = {}) {
  const t0 = performance.now();
  let code = 0, out = '';
  try {
    out = execFileSync('node', [SEA, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout || '') + (e.stderr || '');
  }
  return { code, clean: out.replace(/\x1b\[[0-9;]*m/g, ''), ms: performance.now() - t0 };
}

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id} ${name}`);
  console.log(`      ${detail}`);
}

// ---------- 备份 / 恢复所有场景数据 ----------
const BACKUP = join(HERE, '.baseline-backup');
function snapshotBaseline() {
  if (existsSync(BACKUP)) rmSync(BACKUP, { recursive: true, force: true });
  cpSync(SCENES_ROOT, BACKUP, { recursive: true });
}
function restoreBaseline() {
  if (!existsSync(BACKUP)) return;
  rmSync(SCENES_ROOT, { recursive: true, force: true });
  cpSync(BACKUP, SCENES_ROOT, { recursive: true });
}
snapshotBaseline();

const scenes = healthy(SCENES_ROOT);

// ---------- U1 首值 ----------
{
  const r = run([]);
  record('U1', '首值时间',
    r.ms < 30000 && /个场景.*门禁|件事需要你|个场景配置有误/.test(r.clean),
    `${r.ms.toFixed(0)}ms，${scenes.length} 个场景`);
}

// ---------- U2 零配置 ----------
{
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !/^(DEEPSEEK|TRAE|MOCK|BEICHEN|PURSUERAY|DSH_|SEA_)/i.test(k)));
  let ok = true;
  try { execFileSync('node', [SEA], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }); }
  catch { ok = false; }
  record('U2', '零配置', ok, ok ? '剥离全部环境变量后仍运行' : '失败');
}

// ---------- U3 不撒谎（注入真实错误）----------
{
  const before = run([]);
  const saysPass = /个场景.*门禁/.test(before.clean) && before.code === 0;

  // 注入：从 support-assign 的 roster 删掉一个正在值班的人
  const rosterPath = join(SCENES_ROOT, 'support-assign', 'data', 'roster.json');
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  const removed = roster.shift();
  writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

  const after = run([]);
  const admits = /件事需要你/.test(after.clean) && !/个场景.*门禁/.test(after.clean);
  const exitChanged = before.code === 0 && after.code === 1;

  // 恢复
  restoreBaseline();
  record('U3', '不撒谎', saysPass && admits && exitChanged,
    `全绿说通过=${saysPass} 注入(移除${removed})后改口=${admits} 退出码变化=${exitChanged}`);
}

// ---------- U4 安静 ----------
{
  restoreBaseline();
  const r = run([]);
  const lines = r.clean.split('\n').filter(l => l.trim()).length;
  record('U4', '安静', lines <= 2, `健康时 ${lines} 行（目标 ≤2）`);
}

// ---------- U5 可撤回 ----------
{
  resetSnaps();
  undoStore.snapshot('before-break');
  const rosterPath = join(SCENES_ROOT, 'support-assign', 'data', 'roster.json');
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  // 删掉一个「正在被工单引用」的人 —— 这才违反 referential-integrity
  const idx = roster.indexOf('alice');
  if (idx >= 0) roster.splice(idx, 1);
  writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

  const broken = run([]);
  const sawProblem = /件事需要你/.test(broken.clean);
  const showedUndo = /撤销点：1 个/.test(broken.clean);

  const t0 = performance.now();
  const u = run(['undo']);
  const undoMs = performance.now() - t0;

  const recovered = run([]);
  const backGreen = /个场景.*门禁/.test(recovered.clean);
  restoreBaseline();

  record('U5', '可撤回', sawProblem && showedUndo && backGreen && undoMs < 5000,
    `发现问题=${sawProblem} 显示撤销点=${showedUndo} 恢复=${backGreen} ${undoMs.toFixed(0)}ms`);
}

function resetSnaps() {
  if (existsSync(SNAPS)) rmSync(SNAPS, { recursive: true, force: true });
}

// ---------- U6 人话失败 ----------
{
  const b = run(['foo']);
  record('U6', '人话失败',
    /不认识的命令/.test(b.clean) && /可用：/.test(b.clean) && !/node:internal/.test(b.clean),
    '给可选命令、无堆栈');
}

// ---------- U7 渐进披露 ----------
{
  restoreBaseline();
  const rosterPath = join(SCENES_ROOT, 'support-assign', 'data', 'roster.json');
  const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  const idx = roster.indexOf('alice');
  if (idx >= 0) roster.splice(idx, 1);
  writeFileSync(rosterPath, JSON.stringify(roster, null, 2));

  const s = run([]), l = run(['--more']);
  const sc = s.clean.split('\n').filter(x => x.trim()).length;
  const lc = l.clean.split('\n').filter(x => x.trim()).length;
  restoreBaseline();
  record('U7', '渐进披露', lc > sc, `默认 ${sc} 行 → --more ${lc} 行`);
}

// ---------- U8 门禁可信 ----------
{
  restoreBaseline();
  let r;
  try {
    r = execFileSync('node', [GATE, 'selfcheck'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    r = (e.stdout || '') + (e.stderr || '');
  }
  const clean = r.replace(/\x1b\[[0-9;]*m/g, '');
  const m = clean.match(/元验证：\s*(\d+)\/(\d+)/);
  const allOk = m && Number(m[1]) === Number(m[2]);
  record('U8', '门禁可信', allOk,
    m ? `元验证 ${m[1]}/${m[2]}（真 check 通过 / 说谎·说不清·静默全被拒）` : '无法解析');
}

// ---------- U10 不变量下限可信 ----------
{
  restoreBaseline();
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [join(HERE, 'floor-selfcheck.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
  const m = clean.match(/元验证：(\d+)\/(\d+)/);
  const allOk = code === 0 && m && Number(m[1]) === Number(m[2]);
  record('U10', '不变量下限可信', allOk,
    m ? `元验证 ${m[1]}/${m[2]}（合规通过 / 三种过弱声明被拦）` : '无法解析');
}

// ---------- U11 弱声明被门禁拦下 ----------
{
  restoreBaseline();
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [join(HERE, 'weak-declaration-test.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
  const ok = code === 0 && /会因"声明过弱"而拒绝/.test(clean);
  record('U11', '弱声明被拦下', ok,
    ok ? '声明过弱的场景被门禁 REJECT（G0.5）' : '过弱声明被放过');
}

// ---------- U12 check 被改坏时必须说"不可信" ----------
{
  restoreBaseline();
  const target = join(SCENES_ROOT, 'docs-index', 'check.mjs');
  const original = readFileSync(target, 'utf8');

  // 注入故障：让 check 少查一项（会漏报）
  const broken = original.replace(
    'const ghost = indexed.filter(i => !docs.includes(i));',
    'const ghost = [];  // 故障注入'
  );
  writeFileSync(target, broken, 'utf8');

  // 清缓存，强制重算
  rmSync(join(HERE, '.cache'), { recursive: true, force: true });

  const r = run([]);
  const saysUntrusted = /我的检查本身不可信/.test(r.clean);
  const namesBad = /docs-index/.test(r.clean);
  const exitIs2 = r.code === 2;

  // 恢复
  writeFileSync(target, original, 'utf8');
  rmSync(join(HERE, '.cache'), { recursive: true, force: true });

  record('U12', 'check 改坏必须说不可信', saysUntrusted && namesBad && exitIs2,
    `报不可信=${saysUntrusted} 点名=docs-index:${namesBad} exit=2:${exitIs2}`);
}

// ---------- U13 热启动必须快（<1s）----------
{
  restoreBaseline();
  // 先热一次
  run([]);
  const t0 = performance.now();
  run([]);
  const ms = performance.now() - t0;
  record('U13', '热启动 < 1s', ms < 1000, `${ms.toFixed(0)}ms（目标 <1000ms，冷启动会慢）`);
}

// ---------- U9 放文件即新增（新增指标）----------
{
  restoreBaseline();
  const newId = 'u9-temp-scene';
  const dir = join(SCENES_ROOT, newId);
  const data = join(dir, 'data');
  rmSync(dir, { recursive: true, force: true });

  // 只写 3 个文件，不改任何代码
  const mkdir = (p) => { try { execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(p)}, {recursive:true})`]); } catch {} };
  mkdir(data);

  writeFileSync(join(dir, 'scene.json'), JSON.stringify({
    id: newId, name: '临时场景', desc: 'U9 测试', check: 'check.mjs',
    protects: ['uniqueness', 'required-field'],
  }, null, 2));
  writeFileSync(join(data, 'rows.json'), JSON.stringify([
    { id: 'R-1', name: '甲', v: 10 }, { id: 'R-2', name: '乙', v: 20 },
  ], null, 2));
  writeFileSync(join(dir, 'check.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const DATA = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data');",
    "const rows = JSON.parse(readFileSync(join(DATA, 'rows.json'), 'utf8'));",
    "const problems = [];",
    "const ids = rows.map(r => r.id);",
    "const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];",
    "if (dup.length) problems.push(`重复 ${dup.length}(${dup.join(', ')})`);",
    "const noName = rows.filter(r => !r.name || r.name.trim() === '').map(r => r.id);",
    "if (noName.length) problems.push(\`缺名称 \${noName.length}(\${noName.join(', ')})\`);",
    "if (problems.length === 0) { console.log('PASS u9-temp-scene: 差异集合 = 0'); process.exit(0); }",
    "console.log(`FAIL u9-temp-scene: 差异集合 = ${problems.length} 项`);",
    "for (const p of problems) console.log(`  - ${p}`);",
    "process.exit(1);",
  ].join('\n'));

  // 它应该被自动发现、且门禁能认证
  const disc = discover(SCENES_ROOT).find(s => s.id === newId);
  let gateOk = false;
  if (disc && !disc.error) {
    try {
      execFileSync('node', [GATE, 'validate', disc.check, newId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      gateOk = true;
    } catch { gateOk = false; }
  }

  rmSync(dir, { recursive: true, force: true });
  record('U9', '放文件即新增', !!(disc && !disc.error) && gateOk,
    `自动发现=${!!(disc && !disc.error)} 门禁认证=${gateOk}（零代码改动）`);
}

// ---------- 收尾 ----------
restoreBaseline();
rmSync(BACKUP, { recursive: true, force: true });
resetSnaps();

const passed = results.filter(r => r.pass).length;
console.log(`\n===== 好用度量：${passed}/${results.length} 通过（${scenes.length} 个场景）=====`);
writeFileSync(join(HERE, 'usability-report.json'),
  JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, scenes: scenes.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
