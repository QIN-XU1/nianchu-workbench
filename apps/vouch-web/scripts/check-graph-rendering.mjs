#!/usr/bin/env node
/**
 * 神经记忆元「图谱画法」的反例测试。
 *
 * 【为什么需要这个文件】
 * 2026-11-18 用户两次指出问题：
 *   ① 第一版是方框卡片 —— 看起来像思维导图/列表，不是知识图谱
 *   ② 第二版分了层但仍是方框 —— 还是思维导图
 * 改成「圆节点 + 大小按度数 + 选中邻域高亮、其余压暗」后，
 * 必须能证明这些性质**真的在代码里生效**，而不是"看起来像"。
 *
 * 判据来源（都是实测读过的项目源码）：
 *   · Yuxi    D:/refs/Yuxi/frontend/src/modules/knowledge/ui/GraphCanvas.vue:315-319
 *             size = Math.min(15 + degree * 5, 50)   ← G6 的 size 是直径
 *   · RAGFlow D:/refs/ragflow/web/src/components/artifact-force-graph/node-style.ts
 *             DimmedAlpha = 0.2（无关节点压暗）
 *             DefaultLinkWidth=1 / HighlightLinkWidth=2
 *
 * 用法：node apps/vouch-web/scripts/check-graph-rendering.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SRC = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/workbench/NeuronHomeScene.tsx');
const SCSS = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/workbench/NeuronHomeScene.scss');

let tsx = '';
let scss = '';
try {
  tsx = fs.readFileSync(SRC, 'utf8');
  scss = fs.readFileSync(SCSS, 'utf8');
} catch (e) {
  console.log('  ❔ 读不到源文件：' + String(e && e.message).slice(0, 90));
  console.log('  四态: UNKNOWN');
  process.exit(2);
}

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

// ① 节点必须是圆，不能是方框卡片
// 换成 AntV G6 后，节点不再是 HTML，判据改为「用 G6 + circle 节点类型」
t('用 AntV G6 渲染', /import \{ Graph \} from '@antv\/g6'/.test(tsx));
t('节点类型是 circle', /type: 'circle'/.test(tsx));
t('不再自绘 HTML 节点（.nhn-node 已移除）',
  !/\.nhn-node\s*\{/.test(scss) && !/className="nhn-node"/.test(tsx),
  '仍有 .nhn-node');

// ② 大小必须按 Yuxi 的绝对刻度公式，而不是相对归一化
t('大小用绝对刻度（按我们 0..15 度数校准）',
  /DOT_MIN\s*=\s*14/.test(tsx) &&
  /DOT_MAX\s*=\s*52/.test(tsx) &&
  /DOT_DEG_MAX\s*=\s*15/.test(tsx) &&
  /DOT_MIN \+ \(d \/ DOT_DEG_MAX\) \* \(DOT_MAX - DOT_MIN\)/.test(tsx));
t('没有退回 RAGFlow 的相对归一化（min-max 插值）',
  !/degRange\.max <= degRange\.min/.test(tsx),
  '仍存在 min-max 归一化分支');

// ③ 选中/悬停要激活邻域，其余压暗到 0.2
t('三态里的 inactive 压暗到 0.2（G6 node.state）',
  /inactive:\s*\{\s*opacity:\s*0\.2/.test(tsx));
t('悬停激活邻域（G6 hover-activate behavior）', /'hover-activate'/.test(tsx));
t('点选三态（G6 click-select + neighborState）',
  /type:\s*'click-select'/.test(tsx) && /neighborState:\s*'active'/.test(tsx)
  && /unselectedState:\s*'inactive'/.test(tsx));

// ④ 高亮边要加粗（RAGFlow HighlightLinkWidth=2）
t('高亮边加粗（G6 edge.state.active）',
  /active:\s*\{\s*opacity:\s*1,\s*lineWidth:\s*2/.test(tsx));
t('无关边压暗（G6 edge.state.inactive）',
  /inactive:\s*\{\s*opacity:\s*0\.12/.test(tsx));

// ⑤ 页内不能再有第二个 agent（真 agent 已全局右侧停靠）
t('本页没有自绘 agent（避免两个 agent 并存）',
  !/className="nhn__agent"/.test(tsx) && !/nhn__agent-head/.test(tsx));

// G6 的关键布局参数必须和 Yuxi 一致（这是"照抄"的凭据）
t('力导向核心参数照 Yuxi（charge -400 / link 100,0.8）',
  /charge:\s*\{\s*strength:\s*-400/.test(tsx) &&
  /link:\s*\{\s*distance:\s*100,\s*strength:\s*0\.8/.test(tsx));

// collide 半径是**有意偏离** Yuxi 的：40 时节点标签互相压住（实测「实施计划」压「改进台账」），
// 改成 56 后标签才分开。判据要跟着实测值，不能写死 40。
t('防重叠半径按实测调大到 56（40 时标签互相压住）',
  /collide:\s*\{\s*radius:\s*56/.test(tsx));
t('preventOverlap 已开（防重叠）', /preventOverlap:\s*true/.test(tsx));

// ⑥ 力导向布局仍在使用
t('仍用力导向布局（G6 d3-force）', /type:\s*'d3-force'/.test(tsx));

/** ★反例：把公式常量改坏，上面的判据必须失败 —— 证明判据不是摆设 */
const brokenBase = tsx.replace('DOT_MIN = 14', 'DOT_MIN = 99');
const fmtStillPasses =
  /DOT_MIN\s*=\s*14/.test(brokenBase) &&
  /DOT_MAX\s*=\s*52/.test(brokenBase) &&
  /DOT_DEG_MAX\s*=\s*15/.test(brokenBase);
t('★反例：把 DOT_MIN 改成 99 ⇒ 尺寸判据必须失败', fmtStillPasses === false);

const brokenDim = tsx.replace(/inactive:\s*\{\s*opacity:\s*0\.2/g, 'inactive: { opacity: 1');
const dimStillPasses = /inactive:\s*\{\s*opacity:\s*0\.2/.test(brokenDim);
t('★反例：把 inactive 压暗改成 1 ⇒ 变暗判据必须失败', dimStillPasses === false);

/** 统计实际度数分布，供人核对公式是否给出合理视觉差异 */
try {
  const topo = JSON.parse(fs.readFileSync(
    path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/topology.json'), 'utf8'));
  const deg = new Map();
  for (const e of topo.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const sizes = topo.nodes.map((n) => {
    const d = deg.get(n.id) ?? 0;
    const dd = Math.max(0, Math.min(d, 15));
    return { label: n.label, deg: d, dia: Math.round(14 + (dd / 15) * (52 - 14)) };
  }).sort((a, b) => b.deg - a.deg);
  const uniq = [...new Set(sizes.map((s) => s.dia))];
  console.log('');
  console.log('  度数分布 → 直径（绝对刻度 14..52px）：');
  for (const s of sizes.slice(0, 5)) {
    console.log('    ' + String(s.dia).padStart(2) + 'px  deg=' + String(s.deg).padStart(2) + '  ' + s.label);
  }
  console.log('  ...共 ' + uniq.length + ' 档尺寸，范围 ' + Math.min(...uniq) + '..' + Math.max(...uniq) + 'px');
  t('尺寸有可辨差异（至少 5 档）', uniq.length >= 5, '只有 ' + uniq.length + ' 档');
} catch {
  console.log('  ❔ 拓扑数据读不到，跳过尺寸分布统计');
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0 ? 'PASS —— 圆节点 / Yuxi 尺寸公式 / 邻域高亮压暗 / 反例有效' : 'FAIL'));
console.log('');
process.exit(fails.length === 0 ? 0 : 1);