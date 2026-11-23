/**
 * gate CLI 入口（独立文件，避免"库 vs 入口"的判定问题）。
 *
 * 之前把 CLI 和库混在 gate.mjs 里，靠比较 import.meta.url 与 argv[1] 判断是否直接运行，
 * 但在不同调用路径下（相对路径/绝对路径/大小写）会误判，导致 `node gate.mjs selfcheck`
 * 只打印用法而不执行。
 *
 * 现在：gate.mjs 只导出 validate；本文件只做 CLI。
 */
import { join, basename } from 'node:path';
import { discover, healthy } from './scene-loader.mjs';
import { validate } from './gate.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

function argAfter(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ROOT = argAfter('--root', join(import.meta.dirname, 'scenes'));

const sub = process.argv[2];

if (sub === 'validate') {
  const checkPath = process.argv[3];
  const sceneId = process.argv[4];
  const scenes = discover(ROOT);
  const scene = scenes.find(s => s.id === sceneId);
  if (!scene) {
    console.log(`${C.red}不认识的场景${C.reset}：${sceneId}`);
    console.log(`${C.dim}可用：${scenes.filter(s => !s.error).map(s => s.id).join(' · ')}${C.reset}`);
    process.exit(2);
  }
  if (scene.error) { console.log(`${C.red}场景配置有误${C.reset}：${scene.error}`); process.exit(2); }

  const r = validate(checkPath, scene);
  const ok = r.verdict === 'ACCEPT';
  console.log(`${ok ? C.green + C.bold + 'ACCEPT' : C.red + C.bold + 'REJECT'}${C.reset}  ${basename(checkPath)}  ${C.dim}(${sceneId})${C.reset}`);
  console.log(`${C.dim}  G1 基线通过        : ${r.gates.G1_baseline_pass}${C.reset}`);
  console.log(`${C.dim}  G2 变异全捕获      : ${r.gates.G2_all_mutations_caught} (${r.caught})${C.reset}`);
  console.log(`${C.dim}  G3 失败带差异集合  : ${r.gates.G3_all_failures_have_diffset}${C.reset}`);
  console.log(`${C.dim}  G0 已声明不变量    : ${r.gates.G0_declares_invariants}${C.reset}`);
  console.log(`${C.dim}  G0.5 达到不变量下限 : ${r.gates.G0_5_meets_floor}${C.reset}`);
  for (const m of r.mutations) {
    const mark = m.failed ? (m.hasDiff ? C.green + '✓' : C.yellow + '~') : C.red + '✗';
    console.log(`  ${mark}${C.reset} [${m.invariant}] ${m.name}`);
  }
  for (const why of r.reasons) console.log(`${C.red}  · ${why}${C.reset}`);
  process.exit(ok ? 0 : 1);

} else if (sub === 'selfcheck') {
  const scenes = healthy(ROOT);
  if (scenes.length === 0) { console.log(`${C.red}没有可用场景${C.reset}`); process.exit(2); }

  let pass = 0, total = 0;
  const rows = [];

  const liars = [
    { name: 'liar-always-pass', body: `console.log('PASS liar: 差异集合 = 0'); process.exit(0);` },
    { name: 'vague-no-diffset', body: `console.log('FAIL vague: 有问题'); process.exit(1);` },
    { name: 'silent-fail', body: `process.exit(1);` },
  ];

  for (const scene of scenes) {
    total++;
    const good = validate(scene.check, scene);
    const ok1 = good.verdict === 'ACCEPT';
    if (ok1) pass++;
    rows.push({ scene: scene.id, candidate: 'real', expect: 'ACCEPT', got: good.verdict, ok: ok1 });

    for (const liar of liars) {
      total++;
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(join(tmpdir(), 'sea-bad-'));
      const p = join(dir, 'bad.mjs');
      writeFileSync(p, liar.body + '\n', 'utf8');
      const r = validate(p, scene);
      rmSync(dir, { recursive: true, force: true });
      const ok = r.verdict === 'REJECT';
      if (ok) pass++;
      rows.push({ scene: scene.id, candidate: liar.name, expect: 'REJECT', got: r.verdict, ok });
    }
  }

  console.log(`${C.bold}门禁元验证${C.reset} · ${C.dim}它会不会放坏 check 过去${C.reset}`);
  for (const r of rows) {
    const mark = r.ok ? `${C.green}OK  ` : `${C.red}MISS`;
    console.log(`${mark}${C.reset} [${r.scene}] ${r.candidate.padEnd(16)} 期望=${r.expect} 实际=${r.got}`);
  }
  console.log(`\n===== 元验证：${pass}/${total} =====`);
  const allOk = pass === total;
  console.log(allOk
    ? `${C.green}门禁可信：真 check 通过，说谎/说不清/静默失败全被拒${C.reset}`
    : `${C.red}门禁不可信：有 check 被误判${C.reset}`);
  process.exit(allOk ? 0 : 1);

} else {
  console.log(`用法：node gate-cli.mjs validate <check.mjs> <sceneId> [--root <dir>]`);
  console.log(`      node gate-cli.mjs selfcheck [--root <dir>]`);
  process.exit(2);
}
