/**
 * 新场景加入的界面影响诊断
 *
 * 目标：找出「加入第 11、12、100、1000 个场景」时，界面会在哪里崩
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAU = Math.PI * 2;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..', 'workbench');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  新场景加入 · 界面影响诊断');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ══════════════════════════════════════════════════════════════
//  检查各个界面组件如何应对「场景数变化」
// ══════════════════════════════════════════════════════════════

const CHECKS = [];

function addCheck(name, file, opts) {
  CHECKS.push({ name, file, ...opts });
}

// ① 神经元（球）
addCheck('记忆神经元（球）', path.join(WB, '外壳', 'ui', 'panels', 'neuron.js'));
// ② 主 Agent（中枢面板）
addCheck('主 Agent 面板', path.join(WB, '外壳', 'ui', 'panels', 'main-agent.js'));
// ③ 场景注册表
addCheck('场景注册表读取', path.join(WB, '外壳', 'main.js'));

// ══════════════════════════════════════════════════════════════
//  关键问题清单
// ══════════════════════════════════════════════════════════════

const QUESTIONS = [
  {
    q: '新场景加入后，是否需要重启工作台才能看到？',
    why: '如果需要重启，用户体验极差；如果热更新，按钮在哪？',
  },
  {
    q: '神经元里节点数从 10 → 100 → 1000 时，布局是否还合理？',
    why: '当前是幂律分布 + 领域聚类，1000 个时会不会糊成一团？',
  },
  {
    q: '新场景没有 sessionId 时，点它会发生什么？',
    why: '可能有新场景刚建好还没绑会话',
  },
  {
    q: '新场景的领域无法推断（关键词都不匹配）时，归到哪？',
    why: '当前兜底是 other，但 other 可能越堆越多',
  },
  {
    q: '场景被删除后，神经元里的节点会残留吗？',
    why: '内存泄漏 + 视觉垃圾',
  },
  {
    q: '场景重命名后，神经元标签会更新吗？',
    why: '需要监听变化',
  },
  {
    q: '大量新场景涌入时，是否有"新增"的视觉提示？',
    why: '用户需要知道"刚刚多了个场景"',
  },
  {
    q: '中枢面板现在只有神经元，新场景在哪能看到列表？',
    why: '球上看不清 100 个场景的全貌，需要列表视图',
  },
];

console.log('  待验证的 8 个关键问题:');
console.log();
for (let i = 0; i < QUESTIONS.length; i++) {
  console.log('  ' + (i + 1) + '. ' + QUESTIONS[i].q);
  console.log('     为什么重要: ' + QUESTIONS[i].why);
  console.log();
}

// ══════════════════════════════════════════════════════════════
//  检查代码中的应对机制
// ══════════════════════════════════════════════════════════════
console.log('───────────────────────────────────────────────────────────');
console.log('  代码层检查');
console.log('───────────────────────────────────────────────────────────');
console.log();

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

const neuronSrc = readSafe(path.join(WB, '外壳', 'ui', 'panels', 'neuron.js'));
const mainSrc = readSafe(path.join(WB, '外壳', 'main.js'));
const idxSrc = readSafe(path.join(WB, '外壳', 'ui', 'index.js'));

const checks = [
  ['① 场景热更新（无需重启）', neuronSrc.includes('refresh') || neuronSrc.includes('reload'),
    'neuron.js 有 refresh/reload 方法吗？'],
  ['② 监听到场景变化', neuronSrc.includes('watch') || neuronSrc.includes('subscribe'),
    'neuron.js 订阅了场景变化吗？'],
  ['③ 场景数超阈值降级', neuronSrc.includes('MAX_NODES') || neuronSrc.includes('threshold'),
    '有防爆机制吗？'],
  ['④ 新增场景视觉提示', neuronSrc.includes('isNew') || neuronSrc.includes('#new'),
    '有"新场景"标识吗？'],
  ['⑤ 场景列表视图', neuronSrc.includes('list view') || mainSrc.includes('scene:list'),
    '有列表供大量场景浏览吗？'],
  ['⑥ 场景删除清理', neuronSrc.includes('remove') || neuronSrc.includes('prune'),
    '删除的场景会清理吗？'],
  ['⑦ 主进程注册表读取', mainSrc.includes('readSceneRegistry'),
    'listScenarios 从注册表读吗？'],
  ['⑧ 前端重新加载场景列表', idxSrc.includes('listScenarios') || idxSrc.includes('util.scenes'),
    'index.js 会重新拉场景列表吗？'],
];

let passCount = 0;
for (const [name, cond, hint] of checks) {
  if (cond) passCount++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '   ← ' + hint));
}

console.log();
console.log('  通过 ' + passCount + ' / ' + checks.length);
console.log();

// ══════════════════════════════════════════════════════════════
//  模拟规模变化下的布局质量
// ══════════════════════════════════════════════════════════════
console.log('───────────────────────────────────────────────────────────');
console.log('  布局质量模拟（新场景涌入时）');
console.log('───────────────────────────────────────────────────────────');
console.log();

function seededRandom(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = (h << 5) - h + seedStr.charCodeAt(i);
    h |= 0;
  }
  return function () {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

const DOMAINS = ['eng', 'content', 'tool', 'social', 'mingli', 'other'];

function simulate(n) {
  const R = 200;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const dom = DOMAINS[i % DOMAINS.length];
    const rnd = seededRandom('scene-' + i);
    const rFactor = Math.pow(rnd(), 0.62);
    const dist = R * (0.18 + rFactor * 0.82);
    const lon = (rnd() - 0.5) * TAU;
    const lat = (rnd() - 0.5) * 1.8;
    nodes.push({
      x: Math.cos(lon) * Math.cos(lat) * dist,
      y: Math.sin(lat) * dist,
      z: Math.sin(lon) * Math.cos(lat) * dist,
    });
  }

  // 计算最小间距（判断重叠）
  let minGap = Infinity;
  let overlapping = 0;
  const threshold = 14;   // 节点视觉半径约 14

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const dz = nodes[i].z - nodes[j].z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < minGap) minGap = d;
      if (d < threshold) overlapping++;
    }
  }

  return { n, minGap: minGap === Infinity ? 0 : minGap, overlapping };
}

console.log('  场景数   最小间距   重叠对数   结论');
console.log('  ' + '─'.repeat(60));

for (const n of [10, 30, 60, 100, 200, 500]) {
  const r = simulate(n);
  let verdict;
  if (r.overlapping === 0) verdict = '✓ 无重叠';
  else if (r.overlapping < n * 0.1) verdict = '○ 轻微重叠';
  else verdict = '✗ 严重重叠';

  console.log('  ' + String(n).padStart(6) +
    String(r.minGap.toFixed(1)).padStart(11) +
    String(r.overlapping).padStart(11) +
    '   ' + verdict);
}

console.log();
console.log('═══════════════════════════════════════════════════════════════');
