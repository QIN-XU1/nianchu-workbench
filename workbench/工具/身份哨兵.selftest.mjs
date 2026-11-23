#!/usr/bin/env node
/**
 * 身份哨兵的变异测试 —— 证明它真的会失败
 *
 * 六个不变量，每个至少一个变异用例：
 *   INV-1 有 AI 面板的场景必须在索引里
 *   INV-2 索引里的场景必须存在
 *   INV-3 sessionId 格式必须合法
 *   INV-4 sessionId 不能是占位符
 *   INV-5 定位卡必须存在
 *   INV-6 场景 json id = 文件名
 *   INV-7 sessionId 必须在引擎会话库里真实存在
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite, runCase } from './变异测试.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '身份哨兵.mjs');

// ══════════════════════════════════════════════════════════════
//  造基线：一个完全合规的最小项目结构
// ══════════════════════════════════════════════════════════════

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'idguard-base-'));

const REAL_SID = 'session-11111111-1111-4111-8111-111111111111';
const FAKE_SID = 'session-99999999-9999-4999-8999-999999999999';

function makeBaseline() {
  fs.rmSync(BASE, { recursive: true, force: true });

  const scenDir = path.join(BASE, 'scen');
  const dataRoot = path.join(BASE, 'dsh');
  const tuiRoot = path.join(BASE, 'tui');
  const memRoot = path.join(dataRoot, '场景记忆');
  const shared = path.join(memRoot, '_共享记忆');

  fs.mkdirSync(scenDir, { recursive: true });
  fs.mkdirSync(shared, { recursive: true });

  // 场景配置（合规）
  fs.writeFileSync(path.join(scenDir, 'demo.json'), JSON.stringify({
    id: 'demo',
    name: '演示',
    panels: [
      { id: 'dm-ai', type: 'harness', title: 'AI·演示', sessionId: REAL_SID, sessionTitle: '演示' },
    ],
  }, null, 2), 'utf8');

  // 定位卡（合规）
  fs.writeFileSync(path.join(scenDir, 'demo-context.md'), '# 演示 · 定位卡\n\n- 测试\n', 'utf8');

  // 引擎会话库（含真实会话）
  const ws = path.join(tuiRoot, 'sessions', '--D-test--');
  fs.mkdirSync(path.join(ws, REAL_SID), { recursive: true });
  fs.writeFileSync(path.join(ws, REAL_SID, 'session.v4.jsonl'), '{}\n', 'utf8');

  // 身份索引（合规）
  fs.writeFileSync(path.join(shared, '身份索引.json'), JSON.stringify({
    rows: [{
      scene: 'demo', name: '演示', panel: 'dm-ai',
      sessionTitle: '演示', sessionId: REAL_SID,
      context: 'demo-context.md', memory: '场景记忆/演示/',
    }],
  }, null, 2), 'utf8');

  return { scenDir, dataRoot, tuiRoot };
}

const paths = makeBaseline();

// 变异辅助：读某文件 → 改 → 写回
function editJson(file, fn) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(j);
  fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
}
function editText(file, fn) {
  fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')), 'utf8');
}

const SCEN = path.join(BASE, 'scen');
const DATA = path.join(BASE, 'dsh');
const TUI = path.join(BASE, 'tui');
const IDX = path.join(DATA, '场景记忆', '_共享记忆', '身份索引.json');

//   ★ 自检修复：env 必须指向**临时目录**（{{DIR}}），不能指向 BASE
//     否则 mutate 改了 tmp，check 却读 BASE → 永远 PASS（变异测试形同虚设）
function mkCheck() {
  return {
    file: CHECK,
    env: {
      SEA_SCEN_DIR: '{{DIR}}/scen',
      SEA_DATA_DIR: '{{DIR}}/dsh',
      SEA_TUI_ROOT: '{{DIR}}/tui',
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  用例
// ══════════════════════════════════════════════════════════════

const cases = [
  {
    name: '原始基线应 PASS',
    baseline: BASE,
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS identity-guard: 差异集合 = 0'] },
  },

  // ── INV-1 ──
  {
    name: 'INV-1 变异: 有 AI 面板但索引里没这行 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      fs.writeFileSync(path.join(d, 'scen', 'extra.json'), JSON.stringify({
        id: 'extra', name: '额外',
        panels: [{ id: 'ex-ai', type: 'harness', sessionId: REAL_SID }],
      }), 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '有 AI 面板但索引里没有对应行'] },
  },

  // ── INV-2 ──
  {
    name: 'INV-2 变异: 索引里有不存在的场景 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      editJson(path.join(d, 'dsh', '场景记忆', '_共享记忆', '身份索引.json'), (j) => {
        j.rows.push({
          scene: 'ghost', name: '幽灵', panel: 'gh-ai',
          sessionTitle: '幽灵', sessionId: REAL_SID,
          context: 'ghost-context.md', memory: '场景记忆/幽灵/',
        });
      });
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '没有对应场景配置'] },
  },

  // ── INV-3 ──
  {
    name: 'INV-3 变异: sessionId 格式不合法 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      editJson(path.join(d, 'dsh', '场景记忆', '_共享记忆', '身份索引.json'), (j) => {
        j.rows[0].sessionId = 'not-a-session-id';
      });
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '格式不合法'] },
  },

  // ── INV-4 ──
  {
    name: 'INV-4 变异: sessionId 是占位符 0000 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      editJson(path.join(d, 'dsh', '场景记忆', '_共享记忆', '身份索引.json'), (j) => {
        j.rows[0].sessionId = 'session-00000000-0000-0000-0000-000000000000';
      });
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '占位符'] },
  },

  // ── INV-5 ──
  {
    name: 'INV-5 变异: 定位卡文件不存在 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      fs.rmSync(path.join(d, 'scen', 'demo-context.md'), { force: true });
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '定位卡'] },
  },

  // ── INV-6 ──
  {
    name: 'INV-6 变异: 场景 json 的 id 与文件名不符 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      fs.writeFileSync(path.join(d, 'scen', 'mismatch.json'), JSON.stringify({
        id: 'different', name: '不同名',
        panels: [{ id: 'mm-ai', type: 'harness', sessionId: REAL_SID }],
      }), 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '与文件名不一致'] },
  },

  // ── INV-7 最关键：格式合法但会话不存在 ──
  {
    name: 'INV-7 变异: sessionId 格式合法但引擎里不存在 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      // 改索引和场景 json，都指向一个不存在的会话
      editJson(path.join(d, 'dsh', '场景记忆', '_共享记忆', '身份索引.json'), (j) => {
        j.rows[0].sessionId = FAKE_SID;
      });
      editJson(path.join(d, 'scen', 'demo.json'), (j) => {
        j.panels[0].sessionId = FAKE_SID;
      });
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '在引擎里不存在'] },
  },

  // ── 边界：sessionId 合法且存在，必须 PASS ──
  {
    name: '边界: sessionId 存在但用裸 uuid 命名目录 → 必须 PASS',
    baseline: BASE,
    mutate: (d) => {
      // 把目录改名成裸 uuid（引擎有时这样存）
      const ws = path.join(d, 'tui', 'sessions', '--D-test--');
      const oldDir = path.join(ws, REAL_SID);
      const newDir = path.join(ws, REAL_SID.replace('session-', ''));
      if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },
];

// ══════════════════════════════════════════════════════════════
//  运行
// ══════════════════════════════════════════════════════════════

console.log();
const result = runSuite('身份哨兵 · 变异测试（证明检查真的会失败）', cases);

// 清理
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
