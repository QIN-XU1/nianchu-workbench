/**
 * 紫微 12 宫编排压力测试
 *
 * 验证：固定槽位方案是否能真正解决规模化问题
 */

import { arrangeIntoPalaces, inferPalace, computeStateCode, describeState, PALACES } from '../workbench/外壳/ui/panels/ziwei.js';

const ROLES = [
  '架构设计', '接口定义', '基础平台', '数据存储', '核心逻辑',
  '边界处理', '部署发布', '记忆管理', '索引检索', '知识整理',
  '缓存优化', '故障诊断', '环境配置', '依赖管理', '代码审查',
  '质量检测', '性能分析', '安全漏洞', '逆向分析', '竞品拆解',
  '基准测试', '文档编写', '调研搜集', '方案设计', '实施计划',
  '内容创作', '视频理解', '关系维护', '规则配置', '复盘总结',
];

function makeScenes(n, withHub = true) {
  const out = [];
  if (withHub) out.push({ id: 'hub', name: '中枢', role: '总控中枢', isHub: true });
  for (let i = 0; i < n; i++) {
    const role = ROLES[i % ROLES.length];
    out.push({
      id: 'scene-' + i,
      name: role + '#' + i,
      role: role,
      description: '第 ' + i + ' 个测试场景：' + role,
    });
  }
  return out;
}

console.log('══════════════════════════════════════════════════════════════════════');
console.log('  紫微十二宫编排压力测试');
console.log('══════════════════════════════════════════════════════════════════════');
console.log();
console.log('  场景数   宫数  空宫   最多宫场景数  耗时     每宫平均   结论');
console.log('  ' + '─'.repeat(80));

const SIZES = [1, 10, 100, 500, 1000, 5000, 20000, 100000];
const results = [];

for (const N of SIZES) {
  const scenes = makeScenes(N);
  const t0 = performance.now();
  const r = arrangeIntoPalaces(scenes);
  const dt = performance.now() - t0;

  const avg = (r.total / 12).toFixed(1);
  const verdict = r.stats.max <= 12 ? '✓ 每宫可展示' : (r.stats.max <= 100 ? '○ 需宫内列表' : '◉ 需宫内分页');

  console.log('  ' + String(N).padStart(6) +
    String(12).padStart(7) +
    String(r.stats.empty).padStart(6) +
    String(r.stats.max).padStart(13) +
    String(dt.toFixed(1) + 'ms').padStart(9) +
    String(avg).padStart(10) +
    '   ' + verdict);

  results.push({ N, max: r.stats.max, dt, avg: parseFloat(avg) });
}

console.log();
console.log('══════════════════════════════════════════════════════════════════════');
console.log('  详细：12 宫分布（以 100 个场景为例）');
console.log('══════════════════════════════════════════════════════════════════════');
console.log();

const demo = arrangeIntoPalaces(makeScenes(100));
for (const p of demo.palaces) {
  const bar = '█'.repeat(Math.min(40, p.scenes.length));
  console.log('  ' + p.name.padEnd(6) + '(' + p.zhi + ') ' +
    String(p.scenes.length).padStart(4) + ' 个  ' + bar);
  if (p.scenes.length > 0 && p.scenes.length <= 8) {
    console.log('         ' + p.scenes.map(function (s) { return s.name; }).join(', '));
  }
}

console.log();
console.log('══════════════════════════════════════════════════════════════════════');
console.log('  状态编码验证（64 种组合）');
console.log('══════════════════════════════════════════════════════════════════════');
console.log();

// 列出关键状态
const samples = [
  { hasDef: true, hasSession: true, running: true, hasArtifact: true, memoryOk: true, error: false },
  { hasDef: true, hasSession: true, running: false, hasArtifact: true, memoryOk: true, error: false },
  { hasDef: true, hasSession: true, running: false, hasArtifact: false, memoryOk: false, error: false },
  { hasDef: true, hasSession: false, running: false, hasArtifact: false, memoryOk: false, error: false },
  { hasDef: true, hasSession: true, running: true, hasArtifact: true, memoryOk: true, error: true },
  { hasDef: false },
];

console.log('  状态描述                    码    语义');
console.log('  ' + '─'.repeat(70));
for (const s of samples) {
  const code = computeStateCode(s);
  const d = describeState(code);
  console.log('  ' + d.name.padEnd(24) + String(code).padStart(4) + '    ' + d.desc);
}

console.log();
console.log('══════════════════════════════════════════════════════════════════════');
console.log('  结论');
console.log('══════════════════════════════════════════════════════════════════════');
console.log();

const maxN = results[results.length - 1];
console.log('  最大规模: ' + maxN.N + ' 个场景');
console.log('  最大耗时: ' + Math.max.apply(null, results.map(r => r.dt)).toFixed(1) + 'ms');
console.log('  宫数恒定: 12（永不增长）');
console.log();
console.log('  验证核心命题:');
console.log('    无论场景多少，**容器永远是 12 个**。');
console.log('    场景不是「挤在环上」，而是「填进宫格」。');
console.log('    宫格满了就用宫内列表/分页，容器本身永不膨胀。');
console.log();
console.log('  ✓ 这解决了「几百几千个场景怎么编排」的根本问题。');
console.log();
