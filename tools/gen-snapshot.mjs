/**
 * 生成前端快照数据：apps/agent-ui/src/data/snapshot.json
 *
 * 原则：**界面里不出现编造的数字**。
 * 唯一的数据来源是我们自己的验收器 —— 跑一遍，把它们输出的四态计数解析出来。
 * 跑不起来的套件一律记 UNKNOWN（判不了），绝不记成通过。
 *
 * 用法：node tools/gen-snapshot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'apps/agent-ui/src/data/snapshot.json');

const SUITES = [
  { id: 'arch',          name: '架构分层',   file: 'prototype/hermes-agents/verify-arch.mjs' },
  { id: 'mechanisms',    name: '机制',       file: 'prototype/hermes-agents/verify-mechanisms.mjs' },
  { id: 'goal',          name: '目标达成',   file: 'prototype/hermes-agents/verify-goal.mjs' },
  { id: 'agent-ui',      name: '界面设计系统', file: 'prototype/agent-ui/verify-agent-ui.mjs' },
  { id: 's1s2',          name: 'S1+S2 令牌与外壳', file: 'prototype/agent-ui/verify-s1s2.mjs' },
];

import { parseSummary } from './parse-summary.mjs';

function runSuite(s) {
  const file = path.join(ROOT, s.file);
  if (!fs.existsSync(file)) {
    return { ...s, state: 'unknown', pass: 0, warn: 0, fail: 0, unknown: 0, detail: '脚本不存在', ms: 0 };
  }
  const t0 = Date.now();
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status == null ? 1 : e.status;
  }
  const ms = Date.now() - t0;
  const m = parseSummary(out);
  // 四态映射（与 four-state 的约定一致：0 通过 / 3 待补 / 1 失败 / 2 判不了）
  const pass = m ? m.pass : 0;
  const warn = m ? m.warn : 0;
  const fail = m ? m.fail : 0;
  const unknown = m ? m.unknown : 0;
  let state;
  if (!m) state = 'unknown';
  else if (fail > 0 || code === 1) state = 'fail';
  else if (unknown > 0 || code === 2) state = 'unknown';
  else if (code === 3) state = 'warn';
  else state = 'pass';

  // 逐条断言（有些脚本会逐行打印 ✓ / ✗）
  const lines = out.split('\n').map((l) => l.trim());
  const checks = lines
    .filter((l) => /^[✓✗❔]\s+\S/.test(l))
    .slice(0, 200)
    .map((l) => ({
      ok: l.startsWith('✓') ? 'pass' : l.startsWith('✗') ? 'fail' : 'unknown',
      text: l.replace(/^[✓✗❔]\s*/, '').slice(0, 160),
    }));

  return { id: s.id, name: s.name, file: s.file, state, pass, warn, fail, unknown, exit: code, ms, checks };
}

console.log('  跑验收器（每个都是可执行的真脚本）…');
const suites = [];
for (const s of SUITES) {
  process.stdout.write('    ' + s.name.padEnd(18));
  const r = runSuite(s);
  suites.push(r);
  console.log(r.state.padEnd(9) + ' 通过 ' + r.pass + ' 失败 ' + r.fail + ' 判不了 ' + r.unknown + '  (' + r.ms + 'ms)');
}

const totals = suites.reduce((a, s) => {
  a.pass += s.pass; a.fail += s.fail; a.unknown += s.unknown;
  if (s.state === 'fail') a.suitesFail++;
  if (s.state === 'unknown') a.suitesUnknown++;
  if (s.state === 'pass') a.suitesPass++;
  return a;
}, { pass: 0, fail: 0, unknown: 0, suitesPass: 0, suitesFail: 0, suitesUnknown: 0 });

// ── 能力清单：从仓库里真实存在的东西推导，不编 ──
function listDir(p, filter) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return null;
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => (filter ? filter(e) : true))
    .map((e) => e.name).sort();
}

const patches = listDir('hermes-patches', (e) => e.isFile() && /\.(patch|diff)$/.test(e.name)) || [];
const patchDirs = listDir('hermes-patches', (e) => e.isDirectory()) || [];
const skillsDir = listDir('.claude/skills', (e) => e.isDirectory());  // 本仓没有 → 空
const toolsDir = listDir('tools', (e) => e.isFile() && /\.(mjs|js|py)$/.test(e.name)) || [];

const capabilities = {
  source: '仓库文件系统（非编造）',
  skills: (skillsDir || []).map((n) => ({ name: n, source: '.claude/skills/' })),
  mcp: [],           // 目前没有配置任何 MCP server —— 空就是空
  tools: toolsDir.map((n) => ({ name: n, source: 'tools/' })),
  patches: { files: patches, targets: patchDirs },
  models: [],        // 未接模型网关 —— 空就是空
  note: '技能/工具取自仓库目录；MCP 与模型为空，因为确实还没配。',
};

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generator: 'tools/gen-snapshot.mjs',
  source: {
    kind: 'local-snapshot',
    label: '本地快照',
    detail: '由我们自己的验收器与仓库文件生成，不是编造的演示数据',
  },
  verify: { suites, totals },
  capabilities,
  sessions: [],   // 会话来自后端，当前没有 → 空
  tasks: [],      // 同上
  memory: [],     // 同上
  about: {
    product: '四鉴 Vouch',
    version: '0.1.0',
    stage: 'S2 完成 · S3 起待做',
    repo: path.basename(ROOT),
    node: process.version,
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log('\n  ✓ ' + path.relative(ROOT, OUT) + '  ' + Math.round(fs.statSync(OUT).size / 1024) + 'KB');
console.log('    总计：通过 ' + totals.pass + ' / 失败 ' + totals.fail + ' / 判不了 ' + totals.unknown);
console.log('    套件：' + totals.suitesPass + ' 通过, ' + totals.suitesFail + ' 失败, ' + totals.suitesUnknown + ' 判不了');
console.log('    能力：技能 ' + capabilities.skills.length + ' · 工具 ' + capabilities.tools.length +
  ' · 补丁 ' + patches.length + ' · MCP ' + capabilities.mcp.length + ' · 模型 ' + capabilities.models.length);
