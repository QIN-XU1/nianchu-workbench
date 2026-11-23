#!/usr/bin/env node
// 工具/固定注入层体检.mjs —— 稳定前提信息是不是真的进了 AGENTS.local.md
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（真实事故）
// ══════════════════════════════════════════════════════════════════════
//  第 14 轮给 场景注入.mjs 加了「## 管线位置」一节，理由是：
//    按话术检索「上游输入有哪些？feature-matrix 是不是？」时，
//    管线表格标题得分只有 0.11，被 0.22 分的条目挤出 top 3
//    → 架构梳理封存集答对率只有 50%。
//  所以把它放进了固定注入层（AGENTS.local.md）。
//
//  但实测 9 个场景里**只有「调研」有这一节**，其余 8 个全没有。
//
//  根因：clampBytes() 在超预算（3000B）时按 MUST_KEEP 优先保留、
//        其余段从后往前丢弃。「## 管线位置」不在 MUST_KEEP 里 → 被丢掉。
//        调研是唯一「管线位置靠前、还没超预算就写完了」的场景。
//
//  后果：实施计划的上游输入（architecture-plan / risk-list）AI 根本看不到，
//        封存集「上游输入有哪些？」6 道题全错，注入效果 65%。
//
//  修法：把「## 管线位置」加入 MUST_KEEP。修完注入效果 80% → 89%。
//
//  这个工具验的就是「修完之后真的生效了吗」：
//    · 所有**在管线里**的场景，AGENTS.local.md 必须有「## 管线位置」
//    · 且内容里要出现它真正的上游/下游产物名（不是空标题）
//    · 不在管线里的场景不要求（那是正常的）
//
//  用法：
//    node 工具/固定注入层体检.mjs
//    node 工具/固定注入层体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const PIPES = path.join(WB, 'sceneboard', 'pipelines');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** AGENTS.local.md 里必须有的小节标题 */
export const REQUIRED_SECTION = '## 管线位置';
/** 场景中文名 → id */
export const SCENE_CN2ID = {
  '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
  '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
  '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
};

/**
 * 从管线数据里算出某场景的上游/下游
 * @returns {{ups: string[], downs: string[]}} 产物 id 列表
 */
export function pipelineNeighbors(sceneId, pipeDir) {
  const dir = pipeDir || PIPES;
  const ups = [];
  const downs = [];
  if (!fs.existsSync(dir)) return { ups, downs };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let pj;
    try { pj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const e of (pj.edges || [])) {
      if (e.to === sceneId && e.artifact) ups.push(e.artifact);
      if (e.from === sceneId && e.artifact) downs.push(e.artifact);
    }
  }
  return { ups: [...new Set(ups)], downs: [...new Set(downs)] };
}

/**
 * 判一个场景的固定注入层是否合格
 * @param {string} sceneCn
 * @param {{ups:string[], downs:string[]}} nb
 * @param {string} agentsText
 * @returns {{ok, problems:string[], inPipeline:boolean}}
 */
export function judgeScene(sceneCn, nb, agentsText) {
  const problems = [];
  const inPipeline = nb.ups.length > 0 || nb.downs.length > 0;

  if (!inPipeline) {
    return { ok: true, problems: [], inPipeline: false };
  }

  const text = String(agentsText || '');
  if (!text.includes(REQUIRED_SECTION)) {
    problems.push('缺「' + REQUIRED_SECTION + '」小节（该场景在管线里有 ' +
      nb.ups.length + ' 个上游 / ' + nb.downs.length + ' 个下游）');
    return { ok: false, problems, inPipeline: true };
  }

  // 小节内容里必须出现真实的产物名
  const i = text.indexOf(REQUIRED_SECTION);
  const seg = text.slice(i, i + 2000);
  const missing = [];
  for (const a of nb.ups) {
    if (!seg.includes(a)) missing.push('上游 ' + a);
  }
  for (const a of nb.downs) {
    if (!seg.includes(a)) missing.push('下游 ' + a);
  }
  if (missing.length) {
    problems.push('管线位置里缺产物名: ' + missing.join(', '));
  }

  return { ok: problems.length === 0, problems, inPipeline: true };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  固定注入层体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】能算出管线上游/下游');
  {
    const nb = pipelineNeighbors('build-plan');
    chk('build-plan 有上游', nb.ups.length > 0, JSON.stringify(nb.ups));
    chk('build-plan 上游含 architecture-plan', nb.ups.includes('architecture-plan'));
    const nb2 = pipelineNeighbors('research');
    chk('research 有下游', nb2.downs.length > 0, JSON.stringify(nb2.downs));
    const nb3 = pipelineNeighbors('hub');
    chk('hub 不在管线里', nb3.ups.length === 0 && nb3.downs.length === 0);
  }

  console.log();
  console.log('【二】正例：有完整管线位置的必须通过');
  {
    const nb = { ups: ['architecture-plan'], downs: ['milestones'] };
    const text = '## 管线位置\n**上游（我要等）**\n- 来自 架构梳理：产物 `architecture-plan`\n' +
      '**下游（我该给）**\n- 给 实施计划：产物 `milestones`';
    const r = judgeScene('实施计划', nb, text);
    chk('完整内容通过', r.ok, r.problems.join('; ') || '无问题');
  }

  console.log();
  console.log('【三】反例：缺小节必须失败（这是真实事故）');
  {
    const nb = { ups: ['architecture-plan', 'risk-list'], downs: [] };
    const text = '## 职责\n- 场景 id：build-plan\n\n## 全局铁律\n...';
    const r = judgeScene('实施计划', nb, text);
    chk('反例：缺「## 管线位置」必须失败', r.ok === false, r.problems.join('; '));
    chk('反例：判定为在管线里', r.inPipeline === true);
  }

  console.log();
  console.log('【四】反例：有标题但内容空必须失败');
  {
    const nb = { ups: ['architecture-plan'], downs: [] };
    const text = '## 管线位置\n\n（空）\n';
    const r = judgeScene('实施计划', nb, text);
    chk('反例：标题在但产物名缺必须失败', r.ok === false, r.problems.join('; '));
  }

  console.log();
  console.log('【五】反例：不在管线的场景不要求（不能全拒）');
  {
    const nb = { ups: [], downs: [] };
    const text = '## 职责\n- 场景 id：hub\n';
    const r = judgeScene('中枢', nb, text);
    chk('不在管线的场景缺该节也算通过', r.ok === true, r.problems.join('; ') || '正确豁免');
    chk('不在管线的场景 inPipeline=false', r.inPipeline === false);
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  console.log('='.repeat(78));
  console.log('  固定注入层体检 —— 稳定前提信息真的进了 AGENTS.local.md 吗');
  console.log('='.repeat(78));
  console.log();
  console.log('  判据: 在管线里的场景，AGENTS.local.md 必须有「## 管线位置」，');
  console.log('        且内容里出现它真正的上游/下游产物名');
  console.log('        （不在管线里的场景不要求 —— 那是正常的）');
  console.log();

  let inPipeline = 0;
  let ok = 0;
  const bad = [];

  for (const [cn, id] of Object.entries(SCENE_CN2ID)) {
    const nb = pipelineNeighbors(id);
    const p = path.join(MEM, cn, 'AGENTS.local.md');
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const r = judgeScene(cn, nb, text);

    if (r.inPipeline) inPipeline++;
    if (r.ok) ok++;

    const mark = r.inPipeline ? (r.ok ? 'OK ' : 'XX ') : '-- ';
    console.log('  ' + mark + cn.padEnd(10) +
      '上游 ' + String(nb.ups.length).padStart(2) +
      '  下游 ' + String(nb.downs.length).padStart(2) +
      (r.inPipeline ? '' : '  （不在管线，豁免）'));
    if (!r.ok) {
      bad.push({ scene: cn, problems: r.problems });
      for (const pr of r.problems) console.log('        · ' + pr);
    }
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  结果: ' + ok + ' / ' + Object.keys(SCENE_CN2ID).length + ' 个场景合格' +
    '（其中 ' + inPipeline + ' 个在管线里）');

  if (bad.length) {
    console.log();
    console.log('  不合格:');
    for (const b of bad) console.log('    ' + b.scene);
    console.log();
    console.log('  修复：把「' + REQUIRED_SECTION + '」加入 场景注入.mjs 的 clampBytes MUST_KEEP');
    process.exitCode = 1;
  } else {
    console.log('  ✓ 所有在管线里的场景都带管线位置，且产物名齐全');
  }
  console.log('='.repeat(78));
}

main();
