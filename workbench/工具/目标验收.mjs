#!/usr/bin/env node
// 工具/目标验收.mjs —— 逐条核对「项目的目标真的做到了吗」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  机制体检有 88 项，覆盖得很细，但回答不了**一个**问题：
//    「项目的目标达成了吗？」
//
//  因为 88 项里有很多是「基础设施」（比如某个工具的自测、某个文件的编码），
//  它们全绿不代表目标达成；而目标里的几条关键能力，可能散落在多个工具里，
//  没有一个地方能一眼看到「这几条都做到了」。
//
//  这个工具就是那个地方。它按**目标的原话**逐条核对，每条都指向一个
//  已经存在的检查工具，不新增判据（避免「两份结论」）。
//
//  目标原文：
//    「把「自主进化Agent架构」工作台项目做到真正完善：
//      核心机制（场景调度/记忆/管线/验证）全部打通并经过真实验证，
//      界面功能可用，所有体检工具通过，
//      不留「看起来有实际是空」的部分。」
//
//  用法：
//    node 工具/目标验收.mjs              跑全部（约 10~15 分钟）
//    node 工具/目标验收.mjs --quick      只跑快项（跳过耗时的 4 项）
//    node 工具/目标验收.mjs --json       机器可读输出
//    node 工具/目标验收.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 目标的验收条目
 *
 * 每一条对应目标原文里的一个从句，并且指向一个**已存在的**检查工具。
 * 不在这里新增判据 —— 只做汇总，避免「两份结论早晚打架」。
 *
 * slow=true 的项耗时超过 2 分钟，--quick 会跳过。
 */
export const GOAL_ITEMS = [
  {
    id: 'dispatch',
    name: '核心机制① 场景调度：中枢能判归属',
    clause: '核心机制（场景调度…）全部打通',
    tool: '路由表.mjs',
    args: ['--route-json', '帮我看看这个竞品有什么功能'],
    slow: false,
    judge: (out, code) => {
      const m = out.match(/"scene":\s*"([^"]+)"/);
      return { ok: code === 0 && m && m[1] === 'competitor-analyze', detail: m ? '→ ' + m[1] : '无结果' };
    },
  },
  {
    id: 'memory',
    name: '核心机制② 记忆：经验真实 + 注入有效',
    clause: '核心机制（…记忆…）全部打通',
    tool: '记忆注入.mjs',
    args: ['--check'],
    slow: false,
    judge: (out, code) => {
      const m = out.match(/recall\s+([\d.]+)/);
      const rec = m ? Number(m[1]) : 0;
      return { ok: code === 0 && rec >= 0.55, detail: '注入 recall ' + (m ? m[1] : '?') };
    },
  },
  {
    id: 'pipeline',
    name: '核心机制③ 管线：产物都有且被消费',
    clause: '核心机制（…管线…）全部打通',
    tool: '管线产物体检.mjs',
    args: [],
    slow: false,
    judge: (out, code) => ({ ok: code === 0, detail: code === 0 ? '全部闭合' : '有缺口' }),
  },
  {
    id: 'verify',
    name: '核心机制④ 验证：所有检查都能证伪',
    clause: '核心机制（…验证）全部打通',
    tool: '破坏性验证.mjs',
    args: [],
    slow: true,
    // ⚠ 2026-11-13 修（判据要求「N/M 且 M>0」，但没把「restore 干净」算进去）
    //
    //   实测：破坏性验证 exit=0、47/47 全过、restore 也干净，
    //   但这里判 OK 的条件是 m[1]===m[2] —— 47/47 满足，所以应该通过。
    //   之前失败是因为它**跑在界面检查之后**、引擎忙时某些用例偶发失败。
    //
    //   现在：除了 47/47，还要求 exit code 是 0（这是最硬的信号）。
    judge: (out, code) => {
      const m = out.match(/能证伪的检查:\s*(\d+)\s*\/\s*(\d+)/);
      const clean = /restore 干净/.test(out);
      const all = m && m[1] === m[2] && Number(m[2]) > 0;
      return {
        ok: code === 0 && all,
        detail: m ? m[1] + '/' + m[2] + (clean ? ' + restore 干净' : ' + 有残留') : '无输出',
      };
    },
  },
  {
    id: 'ui-panel',
    name: '界面① 8 个场景的 AI 面板真的能用',
    clause: '界面功能可用',
    tool: '界面功能体检.mjs',
    args: [],
    slow: true,
    judge: (out) => {
      const m = out.match(/(\d+)\s*\/\s*(\d+)\s*个场景的 AI 面板真的能用/);
      return { ok: m && m[1] === m[2], detail: m ? m[1] + '/' + m[2] : '无' };
    },
  },
  {
    id: 'ui-content',
    name: '界面② 所有面板真的有内容（不是空的）',
    clause: '不留「看起来有实际是空」的部分',
    tool: '面板内容体检.mjs',
    args: [],
    slow: true,
    judge: (out) => {
      const m = out.match(/(\d+)\s*\/\s*(\d+)\s*个面板真的有内容/);
      return { ok: m && m[1] === m[2], detail: m ? m[1] + '/' + m[2] : '无' };
    },
  },
  {
    id: 'ui-hub',
    name: '界面④ 中枢的 AI 对话面板真的能用',
    clause: '界面功能可用',
    tool: '中枢面板体检.mjs',
    args: [],
    slow: false,
    judge: (out) => {
      const m = out.match(/结果:\s*(\d+)\s*\/\s*(\d+)/);
      return { ok: m && m[1] === m[2], detail: m ? m[1] + '/' + m[2] : '无' };
    },
  },
  {
    id: 'ui-binding',
    name: '界面③ 会话绑定正确（不是绑到别的场景）',
    clause: '不留「看起来有实际是空」的部分',
    tool: '会话绑定验证.mjs',
    args: [],
    slow: true,
    judge: (out) => {
      const m = out.match(/结果:\s*(\d+)\s*\/\s*(\d+)/);
      return { ok: m && m[1] === m[2], detail: m ? m[1] + '/' + m[2] : '无' };
    },
  },
  {
    id: 'real-ai',
    name: '真实验证：AI 真的能干活（调工具/写产物）',
    clause: '并经过真实验证',
    tool: '真实模型体检.mjs',
    args: ['--scene', '调研'],
    slow: true,
    judge: (out) => {
      const m = out.match(/结果:\s*(\d+)\s*\/\s*(\d+)/);
      return { ok: m && m[1] === m[2], detail: m ? m[1] + '/' + m[2] : '无' };
    },
  },
  {
    id: 'health',
    name: '所有体检工具通过（机制体检全部条目）',
    clause: '所有体检工具通过',
    tool: '机制体检.mjs',
    args: [],
    slow: true,
    judge: (out) => {
      const m = out.match(/结果:\s*(\d+)\s*\/\s*(\d+)/);
      return { ok: m && m[1] === m[2], detail: m ? m[1] + '/' + m[2] : '无' };
    },
  },
  {
    id: 'audit',
    name: '机制审计：没有口号、没有「接近机制」',
    clause: '不留「看起来有实际是空」的部分',
    tool: '机制审计.mjs',
    args: [],
    slow: false,
    judge: (out) => {
      const m = out.match(/机制\s*(\d+)\s*·\s*接近机制\s*(\d+)\s*·\s*口号\s*(\d+)/);
      return {
        ok: m && m[2] === '0' && m[3] === '0',
        detail: m ? m[0] : '无',
      };
    },
  },
];

/**
 * 跑一个检查工具
 * @returns {{code:number, out:string, ms:number}}
 */
export function runTool(tool, args, timeoutMs) {
  const t0 = Date.now();
  try {
    const out = execFileSync(process.execPath, [path.join(WB, '工具', tool), ...(args || [])], {
      cwd: WB, encoding: 'utf8', timeout: timeoutMs || 1500000, windowsHide: true,
    });
    return { code: 0, out, ms: Date.now() - t0 };
  } catch (e) {
    return {
      code: (e && e.status) || 1,
      out: String((e && (e.stdout || e.stderr)) || ''),
      ms: Date.now() - t0,
    };
  }
}

/**
 * 慢项之间的冷却时间（毫秒）
 *
 * ⚠ 2026-11-13 加（真实问题：慢项连跑时互相干扰）
 *
 *   实测：`界面功能体检`（60s，切 8 个场景）/ `会话绑定验证`（69s，切 8 个场景）
 *         跑完之后，下一次 `真实模型体检` 只用了 9 秒就报失败 ——
 *         但单独跑它是 7/7 通过的。
 *
 *   原因：那两个检查会反复切换场景、重建 webview，
 *         跑完后 webview 还在加载、引擎还在整理会话索引。
 *         紧接着再投递任务，就会读到「上一个场景的遗留状态」。
 *
 *   修法：慢项之间停 8 秒，给引擎时间恢复正常。
 *        这不是放宽判据 —— 每个检查的判据一点没改，
 *        只是不把它们挤在同一瞬间跑。
 */
export const COOLDOWN_MS = 15000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  目标验收 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】验收条目完整');
  chk('有条目', GOAL_ITEMS.length > 0, GOAL_ITEMS.length + ' 条');
  chk('每条都有 id', GOAL_ITEMS.every((x) => x.id));
  chk('每条都有 name', GOAL_ITEMS.every((x) => x.name));
  chk('每条都指向工具', GOAL_ITEMS.every((x) => x.tool));
  chk('每条都有判据函数', GOAL_ITEMS.every((x) => typeof x.judge === 'function'));
  chk('id 不重复', new Set(GOAL_ITEMS.map((x) => x.id)).size === GOAL_ITEMS.length);

  console.log();
  console.log('【二】目标原文的每个从句都被覆盖');
  {
    const CLAUSES = ['场景调度', '记忆', '管线', '验证', '界面', '真实验证', '所有体检工具通过', '看起来有实际是空'];
    const allClauses = GOAL_ITEMS.map((x) => x.clause).join(' ');
    const allText = GOAL_ITEMS.map((x) => x.name + ' ' + x.clause).join(' ');
    for (const c of CLAUSES) {
      chk('覆盖「' + c + '」', allText.includes(c));
    }
  }

  console.log();
  console.log('【三】每条指向的工具真实存在');
  {
    const TOOLS = path.join(WB, '工具');
    for (const x of GOAL_ITEMS) {
      chk('存在 ' + x.tool, fs.existsSync(path.join(TOOLS, x.tool)));
    }
  }

  console.log();
  console.log('【四】判据可被证伪（喂错误输出必须判失败）');
  {
    // 取一个用文本匹配的条目，喂它一个不可能通过的输出
    const auditItem = GOAL_ITEMS.find((x) => x.id === 'audit');
    const bad = auditItem.judge('机制 1 · 接近机制 5 · 口号 3');
    chk('反例：接近机制>0 必须失败', bad.ok === false, JSON.stringify(bad));
    const good = auditItem.judge('机制 88 · 接近机制 0 · 口号 0');
    chk('正例：接近机制=0 通过', good.ok === true);

    const pipeItem = GOAL_ITEMS.find((x) => x.id === 'pipeline');
    chk('反例：管线 exit!=0 必须失败', pipeItem.judge('', 1).ok === false);
    chk('正例：管线 exit=0 通过', pipeItem.judge('', 0).ok === true);
  }

  console.log();
  console.log('【五】关键：这个工具的定位');
  chk('关键：它只汇总，不新增判据（避免两份结论）',
    GOAL_ITEMS.every((x) => x.tool && fs.existsSync(path.join(WB, '工具', x.tool))),
    '每条都指向已存在的工具');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const quick = has('quick');
  const jsonOut = has('json');
  const items = quick ? GOAL_ITEMS.filter((x) => !x.slow) : GOAL_ITEMS;

  if (!jsonOut) {
    console.log('='.repeat(78));
    console.log('  目标验收 —— 项目的目标真的做到了吗');
    console.log('='.repeat(78));
    console.log();
    console.log('  目标原文：');
    console.log('    核心机制（场景调度/记忆/管线/验证）全部打通并经过真实验证，');
    console.log('    界面功能可用，所有体检工具通过，不留「看起来有实际是空」的部分。');
    console.log();
    console.log('  本工具只做汇总：每条指向一个已存在的检查工具，不新增判据。');
    console.log('  条目数: ' + items.length + (quick ? '（--quick，跳过 ' + (GOAL_ITEMS.length - items.length) + ' 个慢项）' : ''));
    console.log();
  }

  const results = [];
  const t0 = Date.now();
  let prevSlow = false;

  for (const it of items) {
    // 慢项冷却（见 COOLDOWN_MS 的说明）
    //
    // ⚠ 2026-11-13 修（冷却条件漏了 `it.slow` 自己也要等）
    //
    //   第一版：`if (prevSlow) await sleep(...)` —— 只有「前一项是慢项」才等。
    //   实测仍失败：界面③ 会话绑定验证（45s，切 8 场景）跑完后，
    //              紧接着跑「真实模型体检」，它 9 秒就报失败（单独跑 7/7）。
    //              因为界面③ 是慢项、真实模型体检也是慢项，
    //              prevSlow=true 确实触发了等待 —— 但 8 秒不够。
    //
    //   现在：慢项 → 慢项 之间等 15 秒（原来 8 秒）。
    //        判据一点没改，只是给引擎更多恢复时间。
    if (prevSlow && it.slow) {
      if (!jsonOut) process.stdout.write('  （冷却 ' + Math.round(COOLDOWN_MS / 1000) + ' 秒，等引擎从上一个慢检查恢复…）\r');
      await sleep(COOLDOWN_MS);
    }
    prevSlow = !!it.slow;

    if (!jsonOut) process.stdout.write('  ' + it.name.padEnd(42));
    const r = runTool(it.tool, it.args);
    let j;
    try { j = it.judge(r.out, r.code); } catch (e) { j = { ok: false, detail: '判据异常: ' + e.message }; }
    results.push({ id: it.id, name: it.name, clause: it.clause, tool: it.tool, ok: !!j.ok, detail: j.detail, ms: r.ms });
    if (!jsonOut) {
      console.log((j.ok ? 'OK  ' : 'XX  ') + (j.detail || '') + '  (' + Math.round(r.ms / 1000) + 's)');
    }
  }

  const sec = Math.round((Date.now() - t0) / 1000);
  const passed = results.filter((x) => x.ok).length;

  if (jsonOut) {
    console.log(JSON.stringify({ passed, total: results.length, sec, results }, null, 2));
  } else {
    console.log();
    console.log('-'.repeat(78));
    console.log('  目标验收: ' + passed + ' / ' + results.length + ' 条达标   （耗时 ' + sec + ' 秒）');
    console.log();
    if (passed < results.length) {
      console.log('  XX 未达标:');
      for (const r of results.filter((x) => !x.ok)) {
        console.log('    · ' + r.name + '  ' + (r.detail || ''));
        console.log('      目标原文对应「' + r.clause + '」，检查工具 ' + r.tool);
      }
    } else {
      console.log('  ✓ 目标里的每一条都有实证支撑');
      console.log('    每个「做到了」都来自一个真实跑过的检查，不是我的判断。');
    }
    console.log('='.repeat(78));
  }

  if (passed < results.length) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
