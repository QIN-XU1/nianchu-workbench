#!/usr/bin/env node
/**
 * 记忆哨兵的变异测试 —— 证明它真的会失败
 *
 * 这是原项目「反例验收」的落地：
 *   "反例不报 = 这个检查是假的"
 *
 * 五个不变量，每个至少一个变异用例：
 *   INV-1 注入层 > 2048
 *   INV-2 §〇 > 4096
 *   INV-3 私有记忆 > 25600
 *   INV-4 §〇 里多份"上次交接"
 *   INV-5 §〇 缺小节
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite } from './变异测试.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

// ══════════════════════════════════════════════════════════════
//  造基线：一个完全合规的最小 .dsh 结构
// ══════════════════════════════════════════════════════════════

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-base-'));

function makeBaseline() {
  // 清空
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });

  // AGENTS.md（合规，< 2048）
  fs.writeFileSync(path.join(BASE, 'AGENTS.md'),
    '# 全局须知\n\n' + 'x'.repeat(500) + '\n', 'utf8');

  // 一个合规场景
  const sceneDir = path.join(BASE, '场景记忆', '测试场景');
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(path.join(sceneDir, '场景私有记忆.md'), [
    '# 测试场景 · 场景私有记忆',
    '',
    '## §〇 当前交接',
    '',
    '### 1) 上次交接',
    '- 完成了一件事',
    '',
    '### 2) 当前项目',
    '| 项目 | 状态 |',
    '|---|---|',
    '| A | 进行中 |',
    '',
    '### 3) 私有记忆变更',
    '- 无',
    '',
    '### 4) 下一步 / 卡点',
    '- 下一步：继续',
    '- 卡点：无',
    '',
    '### 5) 全貌',
    '- 项目 1 个',
    '',
    '## 一、职责边界',
    '',
    '- 测试',
  ].join('\n'), 'utf8');
}

makeBaseline();

// ══════════════════════════════════════════════════════════════
//  变异用例
// ══════════════════════════════════════════════════════════════

const CHECK = path.join(HERE, '记忆哨兵.mjs');

const cases = [
  {
    name: '原始基线应 PASS',
    baseline: BASE,
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: { exitNonZero: false, includes: ['PASS memory-guard: 差异集合 = 0'] },
  },

  // ── INV-1 注入层超限 ──
  {
    name: 'INV-1 变异1: AGENTS.md 灌到 3000 字节 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => fs.writeFileSync(path.join(d, 'AGENTS.md'),
      '# 全局须知\n\n' + 'y'.repeat(3000) + '\n', 'utf8'),
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: {
      exitNonZero: true,
      includes: ['FAIL memory-guard', 'AGENTS.md 注入层超限', '2048'],
    },
  },
  {
    name: 'INV-1 变异2: AGENTS.md 刚好 2048 字节 → 必须 PASS（边界）',
    baseline: BASE,
    mutate: (d) => {
      const head = '# 全局须知\n\n';
      const pad = 2048 - Buffer.byteLength(head, 'utf8');
      fs.writeFileSync(path.join(d, 'AGENTS.md'), head + 'z'.repeat(pad), 'utf8');
    },
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // ── INV-2 §〇 超限 ──
  {
    name: 'INV-2 变异: §〇 灌到 6000 字节 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      const f = path.join(d, '场景记忆', '测试场景', '场景私有记忆.md');
      let t = fs.readFileSync(f, 'utf8');
      // 往 §〇 里灌内容
      t = t.replace('### 3) 私有记忆变更', '### 3) 私有记忆变更\n- ' + 'p'.repeat(5000));
      fs.writeFileSync(f, t, 'utf8');
    },
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: {
      exitNonZero: true,
      includes: ['FAIL memory-guard', '§〇 超限', '4096'],
    },
  },

  // ── INV-3 主文件超限 ──
  {
    name: 'INV-3 变异: 主文件灌到 30000 字节 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      const f = path.join(d, '场景记忆', '测试场景', '场景私有记忆.md');
      let t = fs.readFileSync(f, 'utf8');
      t += '\n## 附录\n\n' + 'q'.repeat(30000);
      fs.writeFileSync(f, t, 'utf8');
    },
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: {
      exitNonZero: true,
      includes: ['FAIL memory-guard', '私有记忆超限', '25600'],
    },
  },

  // ── INV-4 多份"上次交接" ──
  {
    name: 'INV-4 变异: §〇 里塞两份"上次交接" → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      const f = path.join(d, '场景记忆', '测试场景', '场景私有记忆.md');
      let t = fs.readFileSync(f, 'utf8');
      t = t.replace('### 2) 当前项目', '### 1) 上次交接\n- 又一份（说明没覆盖写）\n\n### 2) 当前项目');
      fs.writeFileSync(f, t, 'utf8');
    },
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: {
      exitNonZero: true,
      includes: ['FAIL', '份"上次交接"'],
    },
  },

  // ── INV-5 缺小节 ──
  {
    name: 'INV-5 变异: 删掉"下一步 / 卡点"小节 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      const f = path.join(d, '场景记忆', '测试场景', '场景私有记忆.md');
      let t = fs.readFileSync(f, 'utf8');
      t = t.replace(/### 4\) 下一步 \/ 卡点[\s\S]*?(?=### 5\))/, '');
      fs.writeFileSync(f, t, 'utf8');
    },
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: {
      exitNonZero: true,
      includes: ['FAIL', '缺小节', '下一步'],
    },
  },

  // ── 完全没 §〇 ──
  {
    name: '变异: 整个 §〇 段被删 → 必须 FAIL',
    baseline: BASE,
    mutate: (d) => {
      const f = path.join(d, '场景记忆', '测试场景', '场景私有记忆.md');
      let t = fs.readFileSync(f, 'utf8');
      t = t.replace(/## §〇 当前交接[\s\S]*?(?=## 一、职责边界)/, '');
      fs.writeFileSync(f, t, 'utf8');
    },
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: {
      exitNonZero: true,
      includes: ['FAIL', '缺少 §〇'],
    },
  },

  // ── 反例验证：故意写错期望，框架必须报 XX ──
  {
    name: '【反例验证】期望"应通过"但实际会失败 → 框架必须识别',
    baseline: BASE,
    mutate: (d) => fs.writeFileSync(path.join(d, 'AGENTS.md'),
      'x'.repeat(5000), 'utf8'),
    check: { file: CHECK, dataEnv: 'SEA_DATA_DIR' },
    expect: { exitNonZero: false },   // 故意写错
  },
];

// 最后一个是反例，单独处理
const normalCases = cases.slice(0, -1);
const negCase = cases[cases.length - 1];

console.log();
const result = runSuite('记忆哨兵 · 变异测试（证明检查真的会失败）', normalCases);

// 单独验反例
console.log('═'.repeat(66));
console.log('  反例验证（框架自身可信度）');
console.log('═'.repeat(66));
console.log();
console.log('  故意写一个"期望通过但实际失败"的用例，框架必须报 XX');
console.log();

const { runCase } = await import('./变异测试.mjs');
const nr = runCase(negCase);
if (nr.ok === false) {
  console.log('  OK   框架正确识别了错误的期望（ok=false）');
  console.log('       → 说明框架不会盲信自己的断言');
} else {
  console.log('  XX   框架没能识别错误期望（危险：会误判为通过）');
  process.exitCode = 1;
}
console.log();

// 清理
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
