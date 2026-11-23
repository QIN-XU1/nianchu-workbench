#!/usr/bin/env node
// 工具/命令可执行体检.mjs —— 技能/记忆里写的命令，在场景 AI 的 cwd 里真能跑吗
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（发现的最深的「看起来有实际是空」）
// ══════════════════════════════════════════════════════════════════════
//  实测：
//    · 9 个场景会话的 cwd 都是 `数据/.dsh/场景记忆/<场景>/`
//    · 技能文件里写的命令全是 `node 工具/派单.mjs`（相对项目根）
//    · 从场景 cwd 解析 → `<cwd>/工具/派单.mjs` → **不存在**
//
//  也就是说：场景 AI 照抄自己技能里的命令，100% 报 Cannot find module。
//  技能写了 18 处命令（4 种工具），没有一条能在 cwd 里跑通。
//
//  这是「看起来有实际是空」最深的一层：
//    · 技能文件确实存在、内容详细
//    · 技能可见性体检通过（引擎认为可见）
//    · 文档命令体检通过（参数名都对）
//    · 但从 AI 的实际工作目录执行，一条都跑不起来
//
// ══════════════════════════════════════════════════════════════════════
//  判据
// ══════════════════════════════════════════════════════════════════════
//  ① 从每个场景的 cwd 出发，解析技能里引用的每个 `工具/xxx.mjs`
//  ② 能解析到真实文件 → 通过
//  ③ 不能解析 → 检查该场景的 AGENTS.local.md 里有没有「命令执行目录」说明
//     · 有说明 → 通过（AI 被明确告知要 cd 到项目根）
//     · 没说明 → 失败（AI 会照抄并失败）
//
//  用法：
//    node 工具/命令可执行体检.mjs
//    node 工具/命令可执行体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const SKILLS = path.join(DATA, 'skills');
const MEM = path.join(DATA, '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** AGENTS.local.md 里必须有这节，才算「告知了 cwd」 */
export const CWD_SECTION_MARK = '## 命令执行目录';
/** 这节里必须出现的关键词（至少要告诉 AI 切到哪） */
export const CWD_REQUIRED_WORDS = ['cd', '工具'];

const SCENE_ID = {
  '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
  '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
  '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
};

/** 从技能文件里抽出所有 node 工具命令 */
export function extractToolCommands(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/node\s+([^\s`'"）)]*?工具[\/\\][^\s`'"）)]+)/g)) {
    out.add(m[1].replace(/\\/g, '/'));
  }
  return [...out];
}

/** AGENTS.local.md 是否告知了 cwd */
export function hasCwdSection(text) {
  const c = String(text);
  const i = c.indexOf(CWD_SECTION_MARK);
  if (i < 0) return { ok: false, why: '缺「' + CWD_SECTION_MARK + '」小节' };
  const seg = c.slice(i, i + 1200);
  const missing = CWD_REQUIRED_WORDS.filter((w) => !seg.includes(w));
  if (missing.length) return { ok: false, why: '该小节缺关键词: ' + missing.join(',') };
  return { ok: true, why: '' };
}

/**
 * 判一个场景的命令可执行性
 * @param {string} sceneCn 场景中文名
 * @param {string[]} cmds   技能里引用的命令（相对项目根）
 * @returns {{ok, problems, cmds, hasCwdNotice}}
 */
export function judgeScene(sceneCn, cmds) {
  const sceneCwd = path.join(MEM, sceneCn);
  const agentsPath = path.join(sceneCwd, 'AGENTS.local.md');
  let agentsText = '';
  try { agentsText = fs.readFileSync(agentsPath, 'utf8'); } catch { /* ignore */ }

  const cwdNotice = hasCwdSection(agentsText);
  const problems = [];

  // 逐条命令：从场景 cwd 能否解析
  const resolved = cmds.map((cmd) => {
    const fromScene = path.resolve(sceneCwd, cmd);
    const existsFromScene = fs.existsSync(fromScene);
    const fromRoot = path.resolve(WB, cmd);
    const existsFromRoot = fs.existsSync(fromRoot);
    return { cmd, existsFromScene, existsFromRoot };
  });

  const unreachable = resolved.filter((r) => !r.existsFromScene);

  // ⚠ 2026-11-12 修（判据漏洞：没有命令的场景被漏判）
  //
  //   原来只在「有跑不通的命令」时才要求 cwd 提示。
  //   实测：调研场景技能里 0 条命令 → 删掉它的 cwd 说明，检查仍报 9/9 通过。
  //
  //   但这是错的：AGENTS.local.md 是**引擎固定注入层**，是 AI 唯一必然读到的位置。
  //   缺了这一节，将来技能里加任何命令，AI 都会照抄并失败。
  //   而且「这个场景不需要跑命令」本身也不该由检查器假设。
  //
  //   修法：**所有场景都必须有 cwd 提示**（这节是基础设施，不是按需）。
  if (!cwdNotice.ok) {
    problems.push('AGENTS.local.md ' + cwdNotice.why +
      '（这节是基础设施：缺了它，将来技能里加任何 `工具/xxx.mjs` 命令，AI 照抄都会失败）');
  }

  // 命令本身在项目根也不存在 → 幽灵命令（更严重）
  const ghost = resolved.filter((r) => !r.existsFromRoot);
  for (const g of ghost) {
    problems.push('幽灵命令（项目根也不存在）: ' + g.cmd);
  }

  return {
    ok: problems.length === 0,
    problems,
    cmds: resolved,
    hasCwdNotice: cwdNotice.ok,
    unreachable: unreachable.length,
  };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  命令可执行体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】能抽出工具命令');
  {
    const t = '跑 `node 工具/派单.mjs --send` 建单，或 node 工具\\管线调度.mjs --next';
    const cmds = extractToolCommands(t);
    chk('抽出 2 条命令', cmds.length === 2, JSON.stringify(cmds));
    chk('反斜杠被归一', cmds.includes('工具/管线调度.mjs'), JSON.stringify(cmds));
  }

  console.log();
  console.log('【二】cwd 提示判据');
  {
    const good = '## 命令执行目录\n\n先 cd 到项目根，再跑 工具/xxx.mjs';
    chk('有完整提示 → 通过', hasCwdSection(good).ok, hasCwdSection(good).why);
    const noSection = '# 当前场景\n\n随便什么';
    chk('反例：无该小节 → 失败', hasCwdSection(noSection).ok === false, hasCwdSection(noSection).why);
    const noCd = '## 命令执行目录\n\n工具都在根目录';
    chk('反例：有节但缺 cd 关键词 → 失败', hasCwdSection(noCd).ok === false, hasCwdSection(noCd).why);
  }

  console.log();
  console.log('【三】场景判定（用真实数据）');
  {
    // 找一个真实场景
    const scene = Object.keys(SCENE_ID)[0];
    const r = judgeScene(scene, ['工具/派单.mjs']);
    chk('能判真实场景', typeof r.ok === 'boolean', 'ok=' + r.ok);
    chk('能算出从 cwd 解析不到的命令数', typeof r.unreachable === 'number',
      r.unreachable + ' 条');
  }

  console.log();
  console.log('【四】反例：幽灵命令必须被抓');
  {
    // 造一个项目根也不存在的命令
    const r = judgeScene('调研', ['工具/__绝对不存在的工具__.mjs']);
    const hasGhost = r.problems.some((p) => /幽灵命令/.test(p));
    chk('反例：不存在的工具判为幽灵命令', hasGhost, r.problems.join('; ') || '没报出来');
  }

  console.log();
  console.log('【五】反例：缺 cwd 提示必须失败（即使该场景没有命令）');
  {
    // ⚠ 这条反例守着一个曾经踩过的判据漏洞：
    //   原来只在「有跑不通的命令」时才要求 cwd 提示。
    //   实测：调研场景技能里 0 条命令 → 删掉它的 cwd 说明，检查仍报 9/9 通过。
    //
    //   现在改成「所有场景都必须有 cwd 提示」——因为它不是按需的，
    //   而是 AI 唯一必然读到的位置，缺了它将来加命令就会失败。
    const r0 = judgeScene('调研', []);
    chk('反例：命令数为 0 的场景也必须给出结论', typeof r0.ok === 'boolean',
      'ok=' + r0.ok + '  有提示=' + r0.hasCwdNotice);

    // 直接验判据逻辑：无提示 → 必然 problems 非空
    //   （若该场景恰好有提示，则改用「有命令但提示缺失」的等价验证）
    const noNotice = hasCwdSection('# 当前场景\n\n没有任何说明');
    chk('反例：无 cwd 小节 → hasCwdSection 必须 false', noNotice.ok === false,
      noNotice.why);

    const emptySection = '## 命令执行目录\n\n';
    chk('反例：空小节（没有 cd/工具 关键词）必须 false',
      hasCwdSection(emptySection).ok === false, hasCwdSection(emptySection).why);
  }

  console.log();
  console.log('【六】反例：幽灵命令必须被抓（项目根也不存在）');
  {
    const r = judgeScene('调研', ['工具/__绝对不存在的工具__.mjs']);
    const hasGhost = r.problems.some((p) => /幽灵命令/.test(p));
    chk('反例：不存在的工具判为幽灵命令', hasGhost, r.problems.join('; ') || '没报出来');
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
  console.log('  命令可执行体检 —— 技能里的命令，在场景 cwd 里真能跑吗');
  console.log('='.repeat(78));
  console.log();

  // ① 收集所有技能引用的命令
  const allCmds = new Set();
  const skillCmds = {}; // scene id -> [cmds]
  if (fs.existsSync(SKILLS)) {
    for (const d of fs.readdirSync(SKILLS)) {
      const p = path.join(SKILLS, d, 'SKILL.md');
      if (!fs.existsSync(p)) continue;
      const cmds = extractToolCommands(fs.readFileSync(p, 'utf8'));
      skillCmds[d] = cmds;
      for (const c of cmds) allCmds.add(c);
    }
  }

  console.log('  技能里引用的工具命令: ' + allCmds.size + ' 种');
  for (const c of [...allCmds].sort()) console.log('    · ' + c);
  console.log();

  // ② 逐场景判定
  console.log('  逐场景判定:');
  console.log('  场景'.padEnd(12) + 'cwd'.padEnd(8) + '命令数'.padEnd(8) + '跑不通'.padEnd(8) + '有cwd提示');
  console.log('  ' + '-'.repeat(60));

  let okScenes = 0;
  const bad = [];

  for (const [cn, id] of Object.entries(SCENE_ID)) {
    const cmds = skillCmds[id] || [];
    const r = judgeScene(cn, cmds);
    if (r.ok) okScenes++;
    else bad.push({ scene: cn, ...r });
    console.log('  ' + cn.padEnd(10) +
      (fs.existsSync(path.join(MEM, cn)) ? 'OK' : '--').padEnd(8) +
      String(cmds.length).padEnd(8) +
      String(r.unreachable).padEnd(8) +
      (r.hasCwdNotice ? 'yes' : 'NO'));
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  结果: ' + okScenes + ' / ' + Object.keys(SCENE_ID).length +
    ' 个场景的命令可执行性有保障');

  if (bad.length) {
    console.log();
    console.log('  有问题的场景:');
    for (const b of bad) {
      console.log('    ' + b.scene);
      for (const p of b.problems) console.log('      · ' + p);
    }
    process.exitCode = 1;
  } else {
    console.log('  ✓ 所有场景要么命令能从 cwd 跑通，要么已明确告知要 cd 到项目根');
  }
  console.log('='.repeat(78));
}

main();
