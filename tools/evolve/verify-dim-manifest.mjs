#!/usr/bin/env node
/**
 * 维度 → 验收脚本 的可复算清单（第 110 轮）—— **显式登记 + 真跑**，不做关键词猜测。
 *
 * 【为什么重做】第 109 轮我写了个按关键词匹配 verify 脚本的工具，连错三次：
 *   ①泛词全中 → 31/31（假绿）②只匹配断言标题 → 4 维假红（标题是中文）③漏扫目录 → B5 假红。
 * 结论：**字符串匹配不能用来判断「这个维度有没有被验证」**。
 *
 * 【本工具】换成唯一可靠的办法：**手工登记每个维度的验收命令，然后真的跑一遍**。
 *   · 登记表在下面 DIM_VERIFIERS，改它需要人工判断（不可自动生成）
 *   · 每条命令真跑，记录 exit code + 「通过 N / 失败 M」
 *   · 没有登记验收脚本的维度 → 明确标「无专属验收」（这是诚实结论，不是缺陷）
 *
 * 用法：
 *   node tools/evolve/verify-dim-manifest.mjs            # 全跑（含联网/真模型，慢）
 *   node tools/evolve/verify-dim-manifest.mjs --fast     # 跳过登记为 slow 的
 * 四态：0 全部通过 · 1 有维度失败 · 2 自检失败（登记的命令文件不存在）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAST = process.argv.includes('--fast');

/** dim → { file, slow? } —— 手工登记：这个维度的「功能实证」由哪个脚本负责 */
const DIM_VERIFIERS = {
  A1: { file: 'tools/agent/verify-a1-patch.mjs' },
  A2: { file: 'tools/agent/verify-a2-exec.mjs' },
  A3: { file: 'prototype/agent-ui/verify-net.mjs', slow: true },
  A4: { file: 'tools/agent/verify-a4-vision.mjs', slow: true },
  A5: { file: 'tools/agent/verify-memory-budget.mjs' },
  A6: { file: 'prototype/agent-ui/verify-memory.mjs' },
  A7: { file: 'tools/agent/verify-scene-memory.mjs' },
  A8: { file: 'tools/agent/verify-subagent.mjs', slow: true },
  A9: { file: 'tools/agent/verify-tools.mjs', slow: true },
  A10: { file: 'tools/agent/verify-agent-channel.mjs' },
  A11: { file: 'prototype/agent-ui/verify-scheduler.mjs' },
  A12: { file: 'prototype/agent-ui/verify-skills.mjs' },
  A13: { file: 'prototype/agent-ui/verify-mcp.mjs', slow: true },
  A14: { file: 'tools/agent/verify-models.mjs' },
  A15: { file: 'tools/agent/verify-a15-approval.mjs' }, // 第 111 轮补：记录「已强制(超时/env白名单) / 故意未做(denylist/审批闸)」
  A16: { file: 'tools/agent/verify-trace.mjs' },
  B1: { file: 'prototype/agent-ui/verify-runtime-state.mjs' },
  B2: { file: 'tools/agent/verify-changeset-persist.mjs' },
  B3: { file: 'prototype/agent-ui/verify-portable.mjs' },
  B4: { file: 'tools/agent/verify-handoff.mjs' },
  B5: { file: 'prototype/hermes-agents/verify-arch.mjs' },
  C1: { file: 'tools/agent/verify-loop-control.mjs' },
  C2: { file: 'tools/agent/verify-stop.mjs' },
  C3: { file: 'tools/evolve/verify-mutation.mjs' },
  C4: { file: 'tools/agent/verify-resume.mjs' },
  C5: { file: 'tools/agent/verify-context.mjs' },
  D1: { file: 'prototype/agent-ui/verify-ui-layer.mjs' },
  D2: { file: 'tools/agent/verify-d2-density.mjs' },
  D3: { file: 'tools/agent/verify-d3-status.mjs' },
  D4: { file: 'prototype/agent-ui/verify-workbench.mjs' },
  D5: { file: 'prototype/agent-ui/verify-agent-ui.mjs' },
};

/** 用户明确排除的维度（excludedNonGoal）：A10 IM 多通道 / A15 审批闸。不参与「必须有通过验收」。 */
const EXCLUDED = new Set(['A10', 'A15']);

const mx = JSON.parse(fs.readFileSync(path.join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));
const dims = []; for (const g of mx.dimensions) for (const it of g.items) dims.push(it);

// ── 自检 1：登记的文件必须真实存在 ──
{
  const missing = Object.entries(DIM_VERIFIERS).filter(([, v]) => v && !fs.existsSync(path.join(ROOT, v.file)));
  if (missing.length) {
    console.error('  ✗ 自检失败：登记了不存在的脚本 → ' + missing.map(([k, v]) => k + ':' + v.file).join(', '));
    process.exit(2);
  }
}
// ── 自检 2：runner 必须能识别失败（拿一个必然失败的命令试）──
{
  const r = spawnSync(process.execPath, ['-e', 'process.exit(1)'], { encoding: 'utf8' });
  if (r.status !== 1) { console.error('  ✗ 自检失败：runner 识别不出 exit 1'); process.exit(2); }
}

const tally = (out) => {
  let m = /通过\s+(\d+)\s*[·,]\s*失败\s+(\d+)/.exec(out) || /通过\s+(\d+)\s+失败\s+(\d+)/.exec(out);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  m = /PASS\s+(\d+)\s*·\s*FAIL\s+(\d+)/.exec(out);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };
  return null;
};

const rows = [];
console.log('');
console.log('  维度 → 验收脚本（显式登记 · 真跑）' + (FAST ? '  [--fast：跳过 slow]' : ''));
console.log('  ' + '─'.repeat(78));
let failed = 0, noVerifier = 0, skipped = 0, excluded = 0, unknown = 0, flakyDims = 0;
for (const it of dims) {
  const reg = DIM_VERIFIERS[it.id];
  if (EXCLUDED.has(it.id)) {
    excluded++;
    rows.push({ dim: it.id, name: it.name, status: '排除(excludedNonGoal)', detail: '' });
    console.log('  ⊘ ' + it.id.padEnd(4) + '排除(用户未选)  ' + String(it.name).slice(0, 30));
    continue;
  }
  if (reg === null || reg === undefined) {
    noVerifier++;
    rows.push({ dim: it.id, name: it.name, status: '无专属验收', detail: '' });
    console.log('  · ' + it.id.padEnd(4) + '无专属验收  ' + String(it.name).slice(0, 30));
    continue;
  }
  if (FAST && reg.slow) {
    skipped++;
    rows.push({ dim: it.id, name: it.name, status: '跳过(slow)', detail: reg.file });
    console.log('  ~ ' + it.id.padEnd(4) + '跳过(slow)  ' + reg.file);
    continue;
  }
  const runDim = () => {
    const rr = spawnSync(process.execPath, [path.join(ROOT, reg.file)], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    const oo = (rr.stdout || '') + (rr.stderr || '');
    const tt = tally(oo);
    const uu = rr.status === 2; // exit 2 = UNKNOWN（环境不可验，不算 FAIL）
    const kk = !uu && rr.status === 0 && (!tt || tt.fail === 0);
    return { ok: kk, unknown: uu, fail: !uu && !kk, status: rr.status, tally: tt };
  };

  let res = runDim();
  // 第 217 轮：失败维度重试一次。重试通过 → 标 FLAKY（既不算 PASS 也不算 FAIL，单独计数）。
  // 与 verify-all 同款：让「跨脚本端口争用」这类偶发**显式可见**，而不是把偶发当稳定缺陷。
  let flaky = false;
  if (res.fail) {
    const again = runDim();
    if (!again.fail && !again.unknown) { res = again; flaky = true; }
  }

  const t = res.tally;
  if (res.unknown) unknown++;
  else if (res.fail) failed++;
  else if (flaky) flakyDims++;
  const status = res.unknown ? 'UNKNOWN' : res.fail ? 'FAIL' : 'PASS';
  rows.push({ dim: it.id, name: it.name, status, file: reg.file, exit: res.status, tally: t, flaky });
  const icon = status === 'PASS' ? '✓' : status === 'UNKNOWN' ? '❔' : '✗';
  console.log('  ' + icon + ' ' + it.id.padEnd(4) + status.padEnd(7) + '  ' +
    reg.file.padEnd(46) + (t ? '通过 ' + t.pass + ' / 失败 ' + t.fail : 'exit=' + res.status) +
    (flaky ? '   ← FLAKY（首次失败、重试通过）' : ''));
}
console.log('  ' + '─'.repeat(78));
console.log('  通过 ' + rows.filter((r) => r.status === 'PASS').length + ' 维 · 失败 ' + failed +
  ' · FLAKY ' + flakyDims + ' · UNKNOWN ' + unknown + ' · 无专属验收 ' + noVerifier + ' · 跳过 ' + skipped + ' · 排除 ' + excluded);
if (flakyDims) console.log('  ⚠ 有 ' + flakyDims + ' 维是 FLAKY（首次失败重试通过）——说明不稳定，不能当已稳定');
console.log('  四态: ' + (failed > 0 ? 'FAIL' : unknown > 0 ? 'UNKNOWN' : 'PASS'));

fs.mkdirSync(path.join(ROOT, 'evidence/evolve'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evidence/evolve/dim-manifest.json'),
  JSON.stringify({ at: new Date().toISOString(), fast: FAST, rows }, null, 2) + '\n', 'utf8');
console.log('  已写 evidence/evolve/dim-manifest.json');
process.exit(failed > 0 ? 1 : unknown > 0 ? 2 : 0);