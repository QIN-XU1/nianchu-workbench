import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const HERE = import.meta.dirname;
const PROJECT = join(HERE, '..');

function snapState() {
  const s = {};
  const capsFile = join(HERE, 'capabilities.json');
  s.caps = existsSync(capsFile) ? readFileSync(capsFile, 'utf8') : null;

  const authFile = join(HERE, 'auth-mode.json');
  s.auth = existsSync(authFile) ? readFileSync(authFile, 'utf8') : null;

  for (const d of ['boards', 'collab', 'would-do']) {
    const p = join(HERE, d);
    s[d] = existsSync(p) ? readdirSync(p).sort().join(',') : null;
  }

  // 场景 .review
  const scenesDir = join(HERE, 'scenes');
  const reviews = [];
  if (existsSync(scenesDir)) {
    for (const sc of readdirSync(scenesDir)) {
      if (existsSync(join(scenesDir, sc, '.review'))) reviews.push(sc);
    }
  }
  s.reviews = reviews.join(',');

  return s;
}

function run(script, args) {
  try {
    const out = execFileSync('node', [join(HERE, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJECT,
    });
    return { code: 0, out: out.replace(/\x1b\[[0-9;]*m/g, '') };
  } catch (e) {
    return { code: e.status ?? 1, out: ((e.stdout || '') + (e.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '') };
  }
}

console.log('=== 幂等性检查：连续跑两轮，比较每项结果 ===\n');

const ROUNDS = 2;
const results = [];

for (let r = 1; r <= ROUNDS; r++) {
  const round = {};
  // 逐个跑各套件，记录结果
  const suites = [
    ['boards', 'boards.mjs', ['selftest']],
    ['collab', 'collab.mjs', ['selftest']],
    ['auth', 'auth.mjs', ['selftest']],
    ['inject', 'inject.mjs', ['selftest']],
    ['induct', 'induct.mjs', ['selftest']],
    ['shell', 'shell-guard.mjs', ['selftest']],
    ['ask', 'ask.mjs', ['selftest']],
  ];

  for (const [key, script, args] of suites) {
    const out = run(script, args);
    const m = out.out.match(/(\d+)\/(\d+)/);
    round[key] = { code: out.code, pass: m ? Number(m[1]) : -1, total: m ? Number(m[2]) : -1 };
  }
  results.push(round);
  console.log(`第 ${r} 轮：` + Object.entries(round).map(([k, v]) => `${k}=${v.pass}/${v.total}`).join(' '));
}

console.log('\n=== 对比 ===');
let allSame = true;
for (const key of Object.keys(results[0])) {
  const a = results[0][key], b = results[1][key];
  const same = a.pass === b.pass && a.total === b.total && a.code === b.code;
  if (!same) allSame = false;
  console.log(`${same ? '✓' : '✗'} ${key.padEnd(10)} 第1轮=${a.pass}/${a.total} 第2轮=${b.pass}/${b.total}`);
}

// 检查状态是否被污染
const state = snapState();
console.log('\n=== 跑完后残留状态 ===');
console.log('  capabilities:', state.caps ? (JSON.parse(state.caps).bridge?.sites?.deepseek?.on ? '桥开着(污染!)' : '正常') : '无文件');
console.log('  auth:', state.auth ? JSON.parse(state.auth).global : '无文件');
console.log('  boards:', state.boards || '(无)');
console.log('  collab:', state.collab || '(无)');
console.log('  would-do:', state['would-do'] || '(无)');
console.log('  reviews:', state.reviews || '(无)');

console.log(`\n===== 幂等性：${allSame ? '通过' : '不通过'} =====`);
process.exit(allSame ? 0 : 1);
