#!/usr/bin/env node
/**
 * D3 运行时状态采集器（自研，不借 hermes insights）
 *
 * 之前 D3 记「部分」，证据是「hermes insights 能显示 16 会话 / 86,970 token」——
 * 那是 hermes 的能力。我们自研的只有验收侧快照，**产品运行时状态没有采集**。
 *
 * 这一层采的是**真实可观测的事实**，不是估算也不是编造：
 *
 *   进程   node/python 进程数与内存占用（从进程表读）
 *   端口   关键端口是否在听（3425 模型网关 / 自己的静态服务 / CDP）
 *   网关   模型网关可达性与模型清单（HTTP 探一下，四态判定）
 *   仓库   git 分支 / HEAD / 未提交数 / 最近提交
 *   验收   各套件的四态结果（跑真脚本，读汇总行）
 *   资源   CPU 核数、内存、磁盘剩余
 *
 * 四态纪律贯穿：
 *   拿不到的（比如网关没起）记 UNKNOWN，不记 0，不写成「正常」。
 *   每个字段都带 `at` 采集时间与 `source` 说清从哪儿来。
 *
 * 用法：
 *   node tools/state/collect.mjs            # 采集并写 evidence/runtime-state.json
 *   node tools/state/collect.mjs --json     # 只打印
 *   node tools/state/collect.mjs --fast     # 跳过验收套件（省时）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(REPO, 'evidence/runtime-state.json');
// 网关地址可用 GATEWAY_URL 环境变量覆盖 —— 让「构造不可判定场景」成为可能
// （T3 要求：真的能构造出 UNKNOWN，而不是只在代码里写着 UNKNOWN）
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3425/v1/models';

const FAST = process.argv.includes('--fast');
const JSON_ONLY = process.argv.includes('--json');

const NOW = () => new Date().toISOString();

function run(cmd, args, cwd = REPO) {
  try {
    return execFileSync(cmd, args, {
      cwd, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
  } catch (e) {
    return (e.stdout || '') + '';
  }
}

// ── 1. 进程 ──
function procs() {
  // Windows：用 tasklist 的 CSV 输出，比自己解析更稳
  const out = run('tasklist', ['/FO', 'CSV', '/NH']);
  if (!out.trim()) return { state: 'UNKNOWN', why: 'tasklist 无输出' };
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const l of lines) {
    const m = l.match(/^"([^"]+)","(\d+)","([^"]+)","(\d+)","([\d,]+) K"$/);
    if (m) rows.push({ name: m[1], pid: Number(m[2]), memKB: Number(m[5].replace(/,/g, '')) });
  }
  if (!rows.length) return { state: 'UNKNOWN', why: 'tasklist 格式不符，解析出 0 行' };
  const by = (re) => rows.filter((r) => re.test(r.name));
  const nodeP = by(/^node\.exe$/i);
  const pyP = by(/^python/i);
  const sum = (a) => Math.round(a.reduce((s, r) => s + r.memKB, 0) / 1024);
  return {
    state: 'PASS',
    source: 'tasklist /FO CSV /NH',
    totalProcesses: rows.length,
    node: { count: nodeP.length, memMB: sum(nodeP) },
    python: { count: pyP.length, memMB: sum(pyP) },
    topMem: rows.slice().sort((a, b) => b.memKB - a.memKB).slice(0, 3)
      .map((r) => ({ name: r.name, memMB: Math.round(r.memKB / 1024) })),
  };
}

// ── 2. 端口 ──
async function ports() {
  const WATCH = [
    { port: 3425, what: '模型网关' },
    { port: 9333, what: 'CDP（桌面端调试）' },
    { port: 48032, what: '我们的静态服务' },
  ];
  const out = [];
  for (const w of WATCH) {
    const open = await tcpOpen(w.port);
    out.push({ ...w, open, state: open ? 'PASS' : 'UNKNOWN', why: open ? '在听' : '没在听（不等于坏，可能没启动）' });
  }
  return { state: 'PASS', source: 'TCP connect', ports: out };
}

function tcpOpen(port, timeout = 900) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch { /* */ } resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });
}

// ── 3. 模型网关（HTTP 探活，四态）──
export async function gateway(url = GATEWAY_URL) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      return { state: 'FAIL', source: 'GET /v1/models', httpCode: r.status, why: 'HTTP ' + r.status };
    }
    const j = await r.json().catch(() => null);
    const models = Array.isArray(j?.data) ? j.data.map((m) => m.id).slice(0, 8) : [];
    return {
      state: 'PASS', source: 'GET /v1/models', httpCode: r.status,
      modelCount: Array.isArray(j?.data) ? j.data.length : 0, models,
    };
  } catch (e) {
    return {
      state: 'UNKNOWN', source: 'GET /v1/models',
      why: '连不上（' + String(e.message).slice(0, 60) + '）—— 判不了，不等于网关坏了',
    };
  }
}

// ── 4. 仓库 ──
function repoState() {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const head = run('git', ['rev-parse', '--short', 'HEAD']).trim();
  const dirty = run('git', ['status', '--short']).split('\n').filter(Boolean).length;
  const lastCommits = run('git', ['log', '--oneline', '-3']).split('\n').filter(Boolean);
  if (!head) return { state: 'UNKNOWN', why: 'git 无输出（可能不是仓库）' };
  return {
    state: dirty === 0 ? 'PASS' : 'WARN',
    source: 'git rev-parse / status / log',
    branch, head, dirtyFiles: dirty, lastCommits,
  };
}

// ── 5. 验收四态 ──
function suites() {
  if (FAST) return { state: 'UNKNOWN', why: '--fast 模式跳过验收套件' };
  const LIST = [
    ['verify-goal', 'prototype/hermes-agents/verify-goal.mjs'],
    ['verify-arch', 'prototype/hermes-agents/verify-arch.mjs'],
    ['verify-mechanisms', 'prototype/hermes-agents/verify-mechanisms.mjs'],
    ['verify-ui-layer', 'prototype/agent-ui/verify-ui-layer.mjs'],
    ['verify-density', 'prototype/agent-ui/verify-density.mjs'],
  ];
  const out = [];
  for (const [name, rel] of LIST) {
    const p = path.join(REPO, rel);
    if (!fs.existsSync(p)) { out.push({ name, state: 'UNKNOWN', why: '脚本不存在' }); continue; }
    const t0 = Date.now();
    const txt = run(process.execPath, [p]);
    const ms = Date.now() - t0;

    // 三种汇总格式必须都认（这是上一版把 arch/mechanisms 判成 UNKNOWN 的原因）：
    //   通过 N  待补 N  失败 N          （agent-ui 系）
    //   通过 N  失败 N  无法判断 N      （verify-goal / ui-layer / density）
    //   断言：通过 N  失败 N            （verify-arch / verify-mechanisms）
    let pass = null, fail = null, unknown = 0;
    let m;
    if ((m = txt.match(/通过\s+(\d+)\s+待补\s+(\d+)\s+失败\s+(\d+)/))) {
      pass = Number(m[1]); fail = Number(m[3]);
    } else if ((m = txt.match(/通过\s+(\d+)\s+失败\s+(\d+)\s+无法判断\s+(\d+)/))) {
      pass = Number(m[1]); fail = Number(m[2]); unknown = Number(m[3]);
    } else if ((m = txt.match(/断言：通过\s+(\d+)\s+失败\s+(\d+)/))) {
      pass = Number(m[1]); fail = Number(m[2]);
    }

    if (pass === null) { out.push({ name, state: 'UNKNOWN', why: '没有可识别的汇总行', ms }); continue; }
    out.push({
      name,
      state: fail > 0 ? 'FAIL' : unknown > 0 ? 'UNKNOWN' : 'PASS',
      pass, fail, unknown, ms,
    });
  }
  return { state: 'PASS', source: '真跑验收脚本并解析汇总行（三种格式）', suites: out };
}

// ── 6. 资源 ──
function resources() {
  const cpus = os.cpus() || [];
  const load = os.loadavg ? os.loadavg()[0] : 0;
  return {
    state: 'PASS',
    source: 'node:os',
    cpuCores: cpus.length,
    cpuModel: cpus[0]?.model || 'unknown',
    load1: Math.round(load * 100) / 100,
    totalMemGB: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    freeMemGB: Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10,
    uptimeHours: Math.round(os.uptime() / 3600),
    node: process.version,
  };
}

// ── 汇总 ──
const state = {
  what: '念初运行时状态（自研采集，非 hermes insights）',
  rule: '四态：PASS 观测到 · WARN 观测到但需注意 · FAIL 观测到异常 · UNKNOWN 没观测到（不等于坏）',
  at: NOW(),
  collector: 'tools/state/collect.mjs',
  proc: procs(),
  ports: await ports(),
  gateway: await gateway(),
  repo: repoState(),
  suites: suites(),
  resources: resources(),
};

// 一行总览：界面直接读这个
state.summary = {
  proc: state.proc.state,
  gateway: state.gateway.state,
  repo: state.repo.state,
  suites: state.suites.state,
  portsOpen: state.ports.ports.filter((p) => p.open).length + '/' + state.ports.ports.length,
  suitesPass: state.suites.suites ? state.suites.suites.filter((s) => s.state === 'PASS').length : 0,
  suitesTotal: state.suites.suites ? state.suites.suites.length : 0,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n', 'utf8');

// 同时写到前端 data 目录 —— 界面直接 import 这份，不再二次请求
const UI_OUT = path.join(REPO, 'apps/agent-ui/src/data/runtime-state.json');
fs.mkdirSync(path.dirname(UI_OUT), { recursive: true });
fs.writeFileSync(UI_OUT, JSON.stringify(state, null, 2) + '\n', 'utf8');

if (JSON_ONLY) {
  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

const mark = (s) => (s === 'PASS' ? '✓' : s === 'WARN' ? '🟡' : s === 'FAIL' ? '✗' : '?');
console.log('');
console.log('  念初运行时状态（自研采集）');
console.log('  ' + '─'.repeat(72));
console.log('  ' + mark(state.proc.state) + ' 进程      ' + (state.proc.totalProcesses ?? '-') + ' 个 · ' +
  'node ' + (state.proc.node?.count ?? '-') + ' 个/' + (state.proc.node?.memMB ?? '-') + 'MB · ' +
  'python ' + (state.proc.python?.count ?? '-') + ' 个/' + (state.proc.python?.memMB ?? '-') + 'MB');
console.log('  ' + mark(state.gateway.state) + ' 模型网关  ' +
  (state.gateway.state === 'PASS' ? state.gateway.modelCount + ' 个模型' : state.gateway.why));
console.log('  ' + mark(state.repo.state) + ' 仓库      ' + state.repo.branch + '@' + state.repo.head +
  ' · 未提交 ' + state.repo.dirtyFiles);
console.log('  ' + mark(state.suites.state) + ' 验收      ' +
  (state.suites.suites ? state.suites.suites.map((s) => s.name.replace('verify-', '') + ':' + s.state).join('  ') : state.suites.why));
console.log('  ' + mark(state.ports.state) + ' 端口      ' +
  state.ports.ports.map((p) => p.port + (p.open ? '✓' : '·')).join(' '));
console.log('  ' + mark(state.resources.state) + ' 资源      ' +
  state.resources.cpuCores + ' 核 · 内存 ' + state.resources.freeMemGB + '/' + state.resources.totalMemGB + 'GB 可用');
console.log('');
console.log('  → ' + path.relative(REPO, OUT));
console.log('');