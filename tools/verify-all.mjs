/**
 * 一键复算全部验收脚本 —— 念初对标项目「可复算」的总入口。
 *
 * 用法：node tools/verify-all.mjs
 *   跑 tools 下所有 verify-*.mjs，汇总 通过/失败/UNKNOWN。
 *   某个脚本没有「通过N失败M」输出时，看它的「四态」行归类（PASS/FAIL/UNKNOWN）。
 *
 * 四态：0 全部无失败 · 1 有脚本失败 · 2 工具自检失败
 *
 * 说明：模型/服务依赖的脚本在无 key/无服务时会「如实标 UNKNOWN」而不是 FAIL
 * （见 _model-probe.mjs），所以这里「0 失败」不代表「全部能力已验证」，
 * 只代表「没有脚本报代码缺陷」。UNKNOWN 数量会单独统计。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SELF = path.resolve(import.meta.filename);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git|evidence/.test(p)) walk(p, acc); }
    else if (/^verify-.*\.mjs$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const scripts = walk(path.join(ROOT, 'tools')).filter((f) => path.resolve(f) !== SELF);
scripts.sort();

const rows = [];

/**
 * 跑一个脚本，返回 { out, code }
 *
 * 【第 220 轮】timeout 从 120s 提到 420s。
 * 为什么：真模型可用后，`verify-streaming` / `verify-subagent` / `verify-a4-vision` 等
 * 每个要串行发多次模型调用（每次 1–5s，含重试），2 分钟根本不够 → 进程被 kill →
 * 退出码 1 → 判 FAIL，但**已经打印的「通过 12 · 失败 0」还在**，于是出现
 * 「12/0 但四态 FAIL」这种自相矛盾的输出。超时不是缺陷，是被误判成缺陷。
 */
function runOnce(rel) {
  try {
    const out = execSync('node ' + JSON.stringify(rel), {
      cwd: ROOT, encoding: 'utf8', timeout: 420000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    return { out: String(e.stdout || '') + String(e.stderr || ''), code: typeof e.status === 'number' ? e.status : 1 };
  }
}

function classify(out, code) {
  const m = /通过\s*(\d+)\s*[·\s]*失败\s*(\d+)/.exec(out);
  const sm = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(out);
  // 无「四态」行时按项目自己的 0/1/2/3 约定归类（0 PASS / 1 FAIL / 2 UNKNOWN / 3 WARN）。
  const state = sm ? sm[1] : (code === 0 ? 'PASS' : code === 2 ? 'UNKNOWN' : code === 3 ? 'WARN' : 'FAIL');
  return { state, pass: m ? +m[1] : null, fail: m ? +m[2] : null };
}

for (const abs of scripts) {
  const rel = path.relative(ROOT, abs);
  let r = runOnce(rel);
  let c = classify(r.out, r.code);
  // 第 212 轮：失败脚本重试一次。若重试通过 → 标 FLAKY（既不算 PASS 也不算 FAIL，单独计数）。
  // 这样「跨脚本端口争用」这类偶发会**显式暴露**，而不是被「0 失败」掩盖，也不会把偶发当稳定缺陷。
  let flaky = false;
  if (c.state === 'FAIL' || (c.fail || 0) > 0) {
    const r2 = runOnce(rel);
    const c2 = classify(r2.out, r2.code);
    if (!(c2.state === 'FAIL' || (c2.fail || 0) > 0)) {
      r = r2; c = c2; flaky = true;
    }
  }
  rows.push({ rel, pass: c.pass, fail: c.fail, state: c.state, code: r.code, flaky, crashed: !r.out });
}

const withFail = rows.filter((r) => (r.fail || 0) > 0 || r.state === 'FAIL');
const flakies = rows.filter((r) => r.flaky);
const unknowns = rows.filter((r) => r.state === 'UNKNOWN');
const warns = rows.filter((r) => r.state === 'WARN');
const noParse = rows.filter((r) => r.pass === null);

console.log('');
console.log('  念初 · 一键复算全部验收脚本');
console.log('  ' + '─'.repeat(72));
console.log('  脚本总数: ' + rows.length);
console.log('  有失败: ' + withFail.length + ' · FLAKY(首次失败重试过): ' + flakies.length +
  ' · 四态 UNKNOWN: ' + unknowns.length + ' · 四态 WARN: ' + warns.length + ' · 无通过行: ' + noParse.length);
console.log('');

if (flakies.length) {
  console.log('  ⚠ FLAKY（首次失败、重试通过——说明不稳定，不能当已稳定）:');
  for (const r of flakies) console.log('    - ' + r.rel);
  console.log('');
}

if (withFail.length) {
  console.log('  ✗ 有失败的脚本:');
  for (const r of withFail) console.log('    - ' + r.rel + '  通过 ' + r.pass + ' 失败 ' + r.fail + '  四态 ' + r.state);
} else {
  console.log('  ✓ 没有任何脚本报失败' + (flakies.length ? '（但有 ' + flakies.length + ' 个 FLAKY）' : ''));
}

if (unknowns.length) {
  console.log('');
  console.log('  ❔ 四态 UNKNOWN 的脚本（多为需模型/服务，环境不可验）:');
  for (const r of unknowns) console.log('    - ' + r.rel);
}

console.log('');
console.log('  四态: ' + (withFail.length === 0 ? 'PASS —— 全部脚本无代码缺陷；UNKNOWN 见上（环境依赖）' : 'FAIL —— 有脚本报失败'));
console.log('');
console.log('  提示: 「0 失败」≠「全部能力已验证」；UNKNOWN 的脚本仍需真模型/服务才能验证端到端成功路径。');
console.log('');
process.exit(withFail.length === 0 ? 0 : 1);