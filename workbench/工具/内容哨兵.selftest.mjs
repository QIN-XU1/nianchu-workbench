#!/usr/bin/env node
/**
 * 内容哨兵的变异测试
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runSuite } from './变异测试.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '内容哨兵.mjs');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cguard-base-'));

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function makeBaseline() {
  const WB = path.join(BASE, 'wb');
  fs.rmSync(WB, { recursive: true, force: true });

  const mem = path.join(WB, '数据', '.dsh', '场景记忆');
  const scen = path.join(WB, '外壳', 'scenarios');
  const skills = path.join(WB, '数据', '.dsh', 'skills');

  // 注册表：1 个场景
  writeFile(path.join(mem, '_共享记忆', '索引.json'),
    JSON.stringify({ areas: [{ id: 'demo', name: '演示' }] }, null, 2));

  // 合规身份卡（900 B）
  writeFile(path.join(mem, '演示', '身份卡.md'), [
    '# 演示 · 身份卡',
    '',
    '## 我是谁',
    '',
    '我是演示场景，负责演示。',
    '',
    '## 我能做什么',
    '',
    '| 能力 | 做什么 |',
    '|---|---|',
    '| A | B |',
    '',
    '## 我不做什么',
    '',
    '| 不做 | 谁做 |',
    '|---|---|',
    '| X | Y |',
    '',
    '## 我的判据',
    '',
    '这里是判据说明，要有足够多的字才够长度。'.repeat(10),
  ].join('\n'));

  // 合规定位卡（>500 B，有不碰）
  writeFile(path.join(scen, 'demo-context.md'), [
    '# 演示 · 定位卡',
    '',
    '## 一、身份与职责',
    '',
    '- 场景 id：`demo`',
    '- 不碰什么：',
    '    · 不碰 A',
    '    · 不碰 B',
    '',
    '## 二、面板地图',
    '',
    '这里是面板说明。'.repeat(20),
    '',
    '## 三、流程',
    '',
    '这里是流程说明。'.repeat(20),
  ].join('\n'));

  // 合规技能（有流程 + 验收）
  writeFile(path.join(skills, 'demo', 'SKILL.md'), [
    '# 演示 · 技能',
    '',
    '## 一、标准流程（三步）',
    '',
    '第 1 步：做 A',
    '第 2 步：做 B',
    '第 3 步：做 C',
    '',
    '## 二、验收标准',
    '',
    '✅ 有 A',
    '✅ 有 B',
  ].join('\n'));

  // 场景记忆（含 §五）
  writeFile(path.join(mem, '演示', '场景私有记忆.md'), [
    '# 演示 · 场景私有记忆',
    '',
    '## §〇 当前交接',
    '',
    '### 1) 上次交接',
    '- 无',
    '### 2) 当前项目',
    '- 无',
    '### 3) 私有记忆变更',
    '- 无',
    '### 4) 下一步 / 卡点',
    '- 无',
    '### 5) 全貌',
    '- 无',
    '',
    '## 五、坑与决策',
    '',
    '- 学到了 X',
  ].join('\n'));

  return { WB, mem, scen, skills };
}

const P = makeBaseline();

function mkCheck() {
  return {
    file: CHECK,
    env: { SEA_WB_ROOT: '{{DIR}}/wb' },
  };
}

console.log('═'.repeat(66));
console.log('  内容哨兵 · 变异测试');
console.log('═'.repeat(66));
console.log();

const cases = [
  {
    name: '原始基线应 PASS',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS content-guard'] },
  },

  // INV-1 身份卡模板
  {
    name: 'INV-1: 身份卡含"待明确" → 必须 FAIL',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '数据', '.dsh', '场景记忆', '演示', '身份卡.md');
      fs.appendFileSync(f, '\n- 备注：待明确\n', 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '模板'] },
  },

  // INV-2 身份卡缺节
  {
    name: 'INV-2: 身份卡缺"我不做什么" → 必须 FAIL',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '数据', '.dsh', '场景记忆', '演示', '身份卡.md');
      let t = fs.readFileSync(f, 'utf8');
      t = t.replace('## 我不做什么', '## 别的节');
      fs.writeFileSync(f, t, 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '不做什么'] },
  },

  // INV-3 定位卡待补
  {
    name: 'INV-3: 定位卡含"（待补）" → 必须 FAIL',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '外壳', 'scenarios', 'demo-context.md');
      fs.appendFileSync(f, '\n- 某字段：（待补）\n', 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '待补'] },
  },

  // INV-4 定位卡缺边界
  {
    name: 'INV-4: 定位卡缺"不碰" → 必须 FAIL',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '外壳', 'scenarios', 'demo-context.md');
      let t = fs.readFileSync(f, 'utf8');
      t = t.replace('不碰什么：', '边界：');
      t = t.replace(/· 不碰 [AB]/g, '· 边界项');
      fs.writeFileSync(f, t, 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '不碰什么'] },
  },

  // INV-5 定位卡过短
  {
    name: 'INV-5: 定位卡只有 100 字节 → 必须 FAIL',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '外壳', 'scenarios', 'demo-context.md');
      fs.writeFileSync(f, '# 演示\n\n- 不碰 A\n- 不碰 B\n', 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '过短'] },
  },

  // INV-6 技能缺流程
  {
    name: 'INV-6: 技能缺"流程" → 必须 FAIL',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '数据', '.dsh', 'skills', 'demo', 'SKILL.md');
      // ★ 自检修复：原来把"第 N 步"替换成"步骤"，结果残留"步骤"二字
      //   哨兵判据是 !流程 && !步骤 → 仍认为合格 → 测试假通过
      //   改成不含这两个词的内容
      fs.writeFileSync(f, [
        '# 演示 · 技能',
        '',
        '## 一、概述',
        '',
        '这里是概述，不含那两个关键词。',
        '',
        '## 二、验收标准',
        '',
        '- OK',
      ].join('\n'), 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '流程/步骤'] },
  },

  // INV-7 技能缺验收
  {
    name: 'INV-7: 技能缺"验收" → 必须 FAIL',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '数据', '.dsh', 'skills', 'demo', 'SKILL.md');
      let t = fs.readFileSync(f, 'utf8');
      t = t.replace('## 二、验收标准', '## 二、总结');
      fs.writeFileSync(f, t, 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: true, includes: ['FAIL', '验收'] },
  },

  // 边界：定位卡刚好 500 字节
  {
    name: '边界: 定位卡刚好 500 字节且有边界 → 必须 PASS',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '外壳', 'scenarios', 'demo-context.md');
      const head = '# 演示\n\n- 不碰 A\n- 不碰 B\n';
      const pad = 500 - Buffer.byteLength(head, 'utf8');
      fs.writeFileSync(f, head + 'x'.repeat(Math.max(0, pad)), 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: false, includes: ['PASS'] },
  },

  // 反例验证
  {
    name: '【反例验证】期望"应通过"但实际会失败 → 框架必须识别',
    baseline: BASE,   // ★ 复制整个 BASE，这样 tmp/wb 存在
    mutate: (d) => {
      const f = path.join(d, 'wb', '数据', '.dsh', '场景记忆', '演示', '身份卡.md');
      fs.appendFileSync(f, '\n待明确\n', 'utf8');
    },
    check: mkCheck(),
    expect: { exitNonZero: false },
  },
];

const normalCases = cases.slice(0, -1);
const negCase = cases[cases.length - 1];

runSuite('内容哨兵 · 变异测试', normalCases);

console.log('═'.repeat(66));
console.log('  反例验证');
console.log('═'.repeat(66));
console.log();

const { runCase } = await import('./变异测试.mjs');
const nr = runCase(negCase);
if (nr.ok === false) console.log('  OK   框架正确识别了错误的期望');
else { console.log('  XX   框架没能识别错误期望'); process.exitCode = 1; }
console.log();

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
