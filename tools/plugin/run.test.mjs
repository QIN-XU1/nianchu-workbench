#!/usr/bin/env node
/**
 * 插件运行器的反例测试。
 *
 * 纪律：每个新主张都要有「应当失败的反例」。
 * 这里验的不是「插件能跑」，而是**能力声明检查真的会拦**：
 * 如果这些反例不报，那「按 caps 限制」就是一句空话。
 *
 * 每个用例都构造一个**必须被拒绝**的插件行为：
 *   1. 只声明 fs.read 的插件去写文件 → 必须抛
 *   2. 声明 fs.write:evidence/** 的插件写 src/ → 必须抛
 *   3. 用 ../../ 穿越出仓库 → 必须抛
 *   4. 调 exec → 必须抛（没有插件声明 exec）
 *   5. 读越出仓库的绝对路径 → 必须抛
 *   6. 正常声明内读/写 → 必须成功（正例，防止「全拒绝」也算过）
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPlugins } from './run.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

// 在仓库里建临时插件目录（必须在 ROOT 内，否则路径规整会先拒掉）
const REL = 'tools/plugin/__tmp_run_test';
const DIR = join(process.cwd(), REL);

function mkPlugin(name, caps, body) {
  const d = join(DIR, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', entry: 'index.mjs', caps, requires: [] }));
  writeFileSync(join(d, 'index.mjs'), body);
}

const PROBE = `
export async function activate(ctx) {
  const out = {};
  for (const [k, fn] of Object.entries({
    write_evidence: () => ctx.fs.write('evidence/plugin-probe/tmp-ok.txt', 'ok'),
    write_src: () => ctx.fs.write('src/evil.txt', 'x'),
    traverse: () => ctx.fs.write('../../outside.txt', 'x'),
    abs_out: () => ctx.fs.read('C:/Windows/win.ini'),
    exec: () => ctx.exec('powershell'),
    read_manifest: () => ctx.fs.read('${REL}/readonly/plugin.json'),
  })) {
    try { fn(); out[k] = 'ALLOWED'; } catch (e) { out[k] = 'blocked: ' + e.code; }
  }
  return out;
}
`;

try {
  rmSync(DIR, { recursive: true, force: true });
  mkPlugin('readonly', ['fs.read:**'], PROBE);
  mkPlugin('writer', ['fs.read:**', 'fs.write:evidence/**'], PROBE);

  const ro = await runPlugins({ root: DIR, writeEvidence: false });
  const roRes = (ro.results.find((r) => r.plugin === 'readonly') || {}).result || {};

  // 1) 只声明 read 的插件不能写
  t('反例：只声明 fs.read 的插件写 evidence/ → 被拒', /blocked/.test(String(roRes.write_evidence)), JSON.stringify(roRes.write_evidence));
  // 2) 正常声明内读 → 允许（正例，防止「全拒绝」也过）
  t('正例：声明内 fs.read 自己的清单 → 允许', roRes.read_manifest === 'ALLOWED', JSON.stringify(roRes.read_manifest));
  // 3) 越出仓库绝对路径 → 拒
  t('反例：读 C:/Windows/win.ini → 被拒', /blocked/.test(String(roRes.abs_out)), JSON.stringify(roRes.abs_out));
  // 4) exec → 拒
  t('反例：调 exec → 被拒', /blocked/.test(String(roRes.exec)), JSON.stringify(roRes.exec));

  const w = await runPlugins({ root: DIR, writeEvidence: false });
  const wRes = (w.results.find((r) => r.plugin === 'writer') || {}).result || {};
  // 5) 声明 evidence/** 的插件写 src/ → 拒
  t('反例：声明 fs.write:evidence/** 却写 src/ → 被拒', /blocked/.test(String(wRes.write_src)), JSON.stringify(wRes.write_src));
  // 6) 用 ../../ 穿越 → 拒
  t('反例：../../outside.txt 穿越出仓库 → 被拒', /blocked/.test(String(wRes.traverse)), JSON.stringify(wRes.traverse));
  // 7) 声明内写 → 允许
  t('正例：声明内写 evidence/plugin-probe/ → 允许', wRes.write_evidence === 'ALLOWED', JSON.stringify(wRes.write_evidence));

  // 8) 入口不存在要报错，不能静默跳过
  const d = join(DIR, 'noentry');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name: 'noentry', version: '1.0.0', entry: 'missing.mjs', caps: [] }));
  const ne = await runPlugins({ root: DIR, writeEvidence: false });
  const neRes = ne.results.find((r) => r.plugin === 'noentry');
  t('反例：entry 指向不存在的文件 → 报错而不是静默跳过',
    Boolean(neRes) && neRes.ok === false, JSON.stringify(neRes));

  // 9) 内核本身要能跑通（否则上面全是空转）
  // 注意：ne 的目录里有坏插件 noentry，所以这里**不能**断言 kernelOk===true ——
  // 上一版就是这么写错的（断言与构造矛盾）。用干净目录单独验。
  const clean = await runPlugins({ root: DIR + '/../builtin', writeEvidence: false });
  t('正例：干净目录下内核 activateAll 成功且拓扑序稳定',
    clean.kernelOk === true && clean.order.join(',') === 'probe-reader,probe-audit', JSON.stringify(clean.order));
} finally {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(join(process.cwd(), 'evidence/plugin-probe/tmp-ok.txt'), { force: true });
}

console.log('');
console.log('  插件运行器反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
