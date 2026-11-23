#!/usr/bin/env node
/**
 * B3 跨工具可移植 · 验收器（含反例）
 *
 * 证明导出层是真实现而非空壳：
 *  - 正例：真实仓库导出 ⇒ 全部能力可用 ⇒ PASS
 *  - 反例：入口不存在 ⇒ available:false + issue + WARN（不静默当有）
 *  - 反例：schema 非法 ⇒ FAIL
 *  - 反例：缺 available 字段 ⇒ FAIL
 *  - 正例：导出物可被外部消费（JSON 往返一致）
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildPortableManifest, validateManifest, verdict, SCHEMA_VERSION } from '../../tools/portable/export.mjs';

let pass = 0, total = 0;
const lines = [];
function T(name, ok, why) { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  ← ' + why)); }

const REPO = path.resolve(import.meta.dirname, '../..');

// ── 正例 1：真实仓库导出 PASS ──
const real = buildPortableManifest(REPO);
T('正例 · 真实仓库导出：全部能力可用', real.summary.missing === 0 && real.summary.available === real.capabilities.length,
  JSON.stringify(real.summary));
T('正例 · 真实仓库导出判 PASS', verdict(real) === 'PASS', verdict(real));
T('正例 · schema 版本形如 x.y.z', /^\d+\.\d+\.\d+$/.test(real.schemaVersion), real.schemaVersion);

// ── 反例 1：入口不存在 ⇒ available:false + issue + WARN（不静默）──
const fakeExists = () => false;
const missing = buildPortableManifest(REPO, fakeExists);
T('反例 · 入口不存在 ⇒ 该条 available:false',
  missing.capabilities.every((c) => c.available === false), '不该标可用');
T('反例 · 入口不存在 ⇒ 记 issue（不静默）',
  missing.issues.length === missing.capabilities.length, 'issue 数=' + missing.issues.length);
T('反例 · 入口不存在 ⇒ 判 WARN（不是 PASS）', verdict(missing) === 'WARN', verdict(missing));

// ── 反例 2：schema 非法 ⇒ FAIL ──
const badSchema = { ...real, schemaVersion: 'v1' };
T('反例 · schemaVersion 非法 ⇒ 校验失败', validateManifest(badSchema).ok === false, '不该通过');
T('反例 · schemaVersion 非法 ⇒ 判 FAIL', verdict(badSchema) === 'FAIL', verdict(badSchema));

// ── 反例 3：缺 available 字段 ⇒ FAIL ──
const noAvail = { ...real, capabilities: [{ id: 'x', kind: 'tool', entry: 'a', desc: 'd' }] };
T('反例 · 能力缺 available ⇒ 校验失败', validateManifest(noAvail).ok === false, '不该通过');

// ── 反例 4：capabilities 不是数组 ⇒ FAIL ──
T('反例 · capabilities 非数组 ⇒ 校验失败', validateManifest({ ...real, capabilities: {} }).ok === false, '不该通过');

// ── 反例 5：能力缺 id ⇒ FAIL ──
T('反例 · 能力缺 id ⇒ 校验失败',
  validateManifest({ ...real, capabilities: [{ available: true }] }).ok === false, '不该通过');

// ── 正例 2：导出物可被外部消费（JSON 往返一致）──
const roundTrip = JSON.parse(JSON.stringify(real));
T('正例 · 导出物 JSON 往返一致（外部可消费）',
  roundTrip.schemaVersion === real.schemaVersion && roundTrip.capabilities.length === real.capabilities.length,
  '往返不一致');

// ── 正例 3：导出的能力都指向真实文件 ──
const allReal = real.capabilities.every((c) => fs.existsSync(path.join(REPO, c.entry)));
T('正例 · 每条能力入口都真实存在', allReal, '有入口不存在');

// ── 正例 4：schema 版本稳定（外部工具可据此判断兼容）──
T('正例 · SCHEMA_VERSION 常量 = ' + SCHEMA_VERSION, real.schemaVersion === SCHEMA_VERSION, '不一致');

const ok = pass === total;
console.log('  B3 跨工具可移植验收 —— 自研（自描述清单导出层）');
console.log(lines.join('\n'));
console.log('\n  验收 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
