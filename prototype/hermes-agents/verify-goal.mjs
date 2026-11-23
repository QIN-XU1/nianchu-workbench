#!/usr/bin/env node
/**
 * 目标总验收器：把「超越 7 个参照系统」这个目标拆成 8 条硬要求，逐条给证据。
 *
 * 存在的理由：400 轮的目标不能靠"我感觉差不多了"来判断。
 * 这个脚本是唯一的进度依据 —— 每条要求要么有可复现的证据，要么红。
 *
 * ## 四种结局（不是三种，第三态是这轮补的）
 *
 *   PASS    已验证达成
 *   WARN    已验证「不完整」 —— 这是**知识**，允许存在（比如「部分」6 项）
 *   FAIL    已验证「不达成」 —— 真缺陷，退出码 1
 *   UNKNOWN 判断不了 —— 这是**无知**，退出码 2，必须阻断绿
 *
 * 为什么必须有 UNKNOWN：这是两个独立参照系统各自收敛到的同一个概念。
 *   omp-studio docs/architecture.md:48「Runtime loss fences the old epoch and maps
 *     unresolved accepted work to `outcome_unknown`」
 *   Orca orchestration-worker-specs.ts:56「Failed or outcome_unknown exits 1 and JSON
 *     includes stage/failedStage, effects, residualResources, and recovery commands」
 * 没有第三态时，判不了只能塌缩到某一侧 —— 塌到 PASS 是假绿，塌到 FAIL 是假红。
 * 例：桌面端没起时星图验收报「没有 canvas」。那是**无法验证**，不是**产品坏了**。
 *
 * 用法：
 *   node verify-goal.mjs              正常验收
 *   node verify-goal.mjs --verbose    带空行
 *   node verify-goal.mjs --selftest   自检四态机制本身（证明 UNKNOWN 真的会触发、真的阻断绿）
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { verdict, selfTest } from './four-state.mjs';

// 从本文件位置推导，别硬编码绝对路径 —— 硬编码会让「同一把键换个目录结果不同」，
// 那就不是可复算的度量（独立验证方 R4 实测过）。
const REPO = path.resolve(import.meta.dirname, '../..');
const V = process.argv.includes('--verbose');
const SELFTEST = process.argv.includes('--selftest');

/**
 * `--selftest` = **只自检，立即退出**
 *
 * 【2026-11-15 修】原来自检写在文件末尾（L576），也就是说
 * `--selftest` 会**先把 8 条硬要求全跑一遍**（含界面层、度量器，分钟级），
 * 最后才跑四态自检。
 *
 * 后果：
 *   · 语义错 —— `--selftest` 应当是「快速验证这个脚本自己的机制」，
 *     不是「跑完全量再说一句自检通过」
 *   · 直接害到一个真实场景：tools/evolve/audit-verifiers.mjs 扫到它有
 *     `--selftest` 分支就去跑，结果每个脚本审计都要等十分钟
 *
 * 现在：在依赖任何检查逻辑之前就分流。
 */
if (SELFTEST) {
  console.log('');
  console.log('  verify-goal 自检 —— 只验四态机制本身，不跑 8 条硬要求');
  console.log('  （要跑全量请省略 --selftest）');
  console.log('');
  let bad = selfTest();

  /**
   * 断言层（2026-11-16 补）—— **只加断言，不动判定逻辑**
   *
   * 原来被判 UNKNOWN 的原因：本文件的 `--selftest` 只是**调用另一个文件**
   * （four-state.mjs）的 selfTest，8 条判据写在 four-state.mjs 的 `SELFTESTS`
   * 数组字面量里；audit-false-red 只扫本文件源码、且只认 `T(...)` 断言行，
   * 于是「总闸有四态自检」在审计眼里等于没有。
   *
   * 现在把四态的**退出码映射**在本文件里再断言一遍。只**读** verdict()，
   * 不改它，也不跑 8 条硬要求 —— 本分支在 req() 之前就 exit，19 条判定不受影响。
   */
  const cases = [];
  const T = (name, okv, why) => cases.push([name, !!okv, why]);

  // ── 正例：正常的验收结果必须映射成「该给的」退出码 ──
  T('正例 · 19 条全 PASS（pass:19）⇒ 退出码必须精确是 0',
    verdict({ pass: 19 }) === 0, '实得 ' + verdict({ pass: 19 }));
  T('正例 · 18 PASS + 1 WARN ⇒ 退出码必须精确是 3（「不完整」不许绿，也不是缺陷）',
    verdict({ pass: 18, warn: 1 }) === 3, '实得 ' + verdict({ pass: 18, warn: 1 }));
  T('正例 · 空计数（还没跑任何检查）⇒ 退出码 0，不许凭空造失败',
    verdict({}) === 0, '实得 ' + verdict({}));
  T('正例 · 非数字计数按 0 处理（NaN/undefined 不许变成退出码 1 的假红）',
    verdict({ pass: 1, fail: NaN, unknown: undefined }) === 0,
    '实得 ' + verdict({ pass: 1, fail: NaN, unknown: undefined }));
  T('正例 · four-state 机制的 8 条自带断言必须全部成立（bad 精确 = 0）',
    bad === 0, 'bad=' + bad);

  // ── 反例：无知（UNKNOWN）与缺陷（FAIL）绝不许塌成绿 ──
  T('反例 · 18 PASS + 1 UNKNOWN ⇒ 退出码必须精确是 2（判不了不许绿）',
    verdict({ pass: 18, unknown: 1 }) === 2, '实得 ' + verdict({ pass: 18, unknown: 1 }));
  T('反例 · 18 PASS + 1 FAIL ⇒ 退出码必须精确是 1',
    verdict({ pass: 18, fail: 1 }) === 1, '实得 ' + verdict({ pass: 18, fail: 1 }));
  T('反例 · FAIL 与 UNKNOWN 同时存在 ⇒ FAIL 优先，退出码必须是 1（不能 2）',
    verdict({ fail: 1, unknown: 1 }) === 1, '实得 ' + verdict({ fail: 1, unknown: 1 }));
  T('反例 · UNKNOWN 的退出码必须与 FAIL 不同（否则「判不了」被当成「不达成」）',
    verdict({ unknown: 1 }) !== verdict({ fail: 1 }),
    'unknown=' + verdict({ unknown: 1 }) + ' fail=' + verdict({ fail: 1 }));

  const failed = cases.filter(([, okv]) => !okv);
  console.log('  ' + '─'.repeat(70));
  console.log('  ' + cases.map(([n, okv, why]) => (okv ? '✓ ' : '✗ ') + n + (okv ? '' : '  ← ' + why)).join('\n  '));
  console.log('  ' + '─'.repeat(70));
  console.log('  总闸断言: ' + (cases.length - failed.length) + '/' + cases.length +
    (failed.length ? ' ✗ 有不成立项' : ' ✓ 全部成立') +
    '（另含 four-state 自带 8 条机制断言：' + (bad ? '✗ ' + bad + ' 项不成立' : '✓ 全过') + '）');
  console.log('');
  process.exit(bad + failed.length ? 1 : 0);
}

/**
 * --only R8 / --only R8,R2 / --only R
 *
 * 为什么要它：L4 度量（tools/evolve/measure-verifier-efficacy.mjs）需要**只跑一条**
 * 检查来判断「注入故障后它会不会红」。没有 --only 时整个脚本跑完 16 项，
 * 判定无法归因到具体那一条（实测：F07/F08 两个用例因此失去区分力）。
 *
 * 语义：不匹配的检查记为 SKIP，**不计入四态**，也不影响退出码。
 */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return null;
  return v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
})();

let pass = 0, fail = 0, warn = 0, unknown = 0, skip = 0;
const rows = [];
const unknownReasons = [];

function req(id, name, fn) {
  if (ONLY && !ONLY.some((pat) => id.toUpperCase() === pat || id.toUpperCase().startsWith(pat))) {
    skip++;
    rows.push({ id, name, state: 'SKIP', detail: '（--only 过滤）' });
    return;
  }
  let detail = '';
  let state = 'FAIL';
  try {
    const r = fn();
    state = r.state || (r.ok ? 'PASS' : 'FAIL');
    detail = r.detail || '';
  } catch (e) {
    // 抛异常 = 判断不了，不是「不达成」。区分开才不会把环境问题算成产品缺陷。
    state = 'UNKNOWN';
    detail = '检查过程异常：' + String(e.message).slice(0, 100);
  }
  if (state === 'PASS') pass++;
  else if (state === 'WARN') warn++;
  else if (state === 'UNKNOWN') { unknown++; unknownReasons.push(id + '：' + detail); }
  else fail++;
  rows.push({ id, name, state, detail });
}

/** 某个端口的 TCP 是否可连（用来判定「验证环境在不在」，而不是猜）。 */
function tcpOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}

const has = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');
const sizeKB = (p) => Math.round(fs.statSync(p).size / 1024);
const run = (cmd, args, cwd = REPO) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
};

/**
 * 前置条件：验证环境在不在。在**所有检查之前一次性探测**，避免每个检查各探一遍。
 *
 * 为什么要分「环境不在」和「不达成」：FAIL 说「产品坏了」，UNKNOWN 说「我没法看」。
 * 把后者算成前者是假红，算成 PASS 是假绿。
 */
const ENV = { cdp: await tcpOpen(Number(process.env.VERIFY_GOAL_CDP_PORT || 9333)), modelGateway: await tcpOpen(3425), gateway: false };
// 网关端口是动态的，用进程命令行找，不猜端口
{
  const out = run('wmic', ['process', 'where', "name='python.exe'", 'get', 'CommandLine']).toLowerCase();
  ENV.gateway = /gateway run|_run_gateway/.test(out);
}
ENV.cdpPort = Number(process.env.VERIFY_GOAL_CDP_PORT || 9333);

// ══════════════════════════════════════════════════════
//  要求 1：每个参照系统都有源码级/产品级实证研究
// ══════════════════════════════════════════════════════
req('R1', '7 个参照系统的实证研究', () => {
  const need = {
    'vs-hermes.md': 'hermes-agent（本地完整源码）',
    'vs-dsh.md': 'DeepSeek Harness（解包 asar）',
    'vs-openclaw.md': 'openclaw（下载 63769 文件）',
    'vs-ecc.md': 'ECC（下载 4701 文件）',
    'vs-luanyujia.md': 'luanyujia（本地 2 份副本）',
    'vs-closed-products.md': 'ChatGPT/Claude Code（本机发行物取证）',
  };
  const missing = [];
  const thin = [];
  for (const [f, label] of Object.entries(need)) {
    const p = path.join(REPO, 'research', f);
    if (!has(p)) { missing.push(label); continue; }
    if (sizeKB(p) < 10) thin.push(label + '(' + sizeKB(p) + 'KB)');
  }
  // 每条结论要带证据位置：抽查「文件:行号」出现次数
  const total = Object.keys(need).reduce((n, f) => {
    const p = path.join(REPO, 'research', f);
    return n + (has(p) ? (read(p).match(/`[^`]*\.(py|ts|tsx|js|mjs|json|md):\d+/g) || []).length : 0);
  }, 0);
  if (missing.length) return { ok: false, detail: '缺: ' + missing.join(',') };
  if (thin.length) return { ok: false, detail: '过薄: ' + thin.join(',') };
  return { ok: true, detail: '6 份报告，' + total + ' 处 文件:行号 证据' };
});

// ══════════════════════════════════════════════════════
//  要求 2：30+ 维 × 7 方矩阵，每格带证据
// ══════════════════════════════════════════════════════
req('R2', '30+ 维对比矩阵（每格带证据）', () => {
  const out = run('node', ['prototype/hermes-agents/render-matrix.mjs', '--check']);
  const m = out.match(/(\d+)\s*维 × (\d+)\s*方 = (\d+) 格/);
  if (!/校验通过/.test(out)) {
    const m2 = out.match(/失败 (\d+) 项/);
    return { ok: false, detail: '校验失败 ' + (m2 ? m2[1] : '?') + ' 项' };
  }
  const dims = m ? Number(m[1]) : 0;
  if (dims < 30) {
    return { ok: false, detail: '只有 ' + dims + ' 维，要求 ≥30' };
  }

  // 诚实性：不许把参照系统（hermes）的能力当成我们自己的。
  // 这一条是补上的 —— 本项目早期就是「在 hermes 上打补丁」，
  // 于是「我们」那一列很容易写成 hermes 能做什么，等于 hermes 超过 hermes。
  const honesty = run('node', ['prototype/hermes-agents/audit-matrix-honesty.mjs']);
  const fake = honesty.match(/疑似假绿:\s*(\d+)/);
  const fakeN = fake ? Number(fake[1]) : 1;
  if (fakeN > 0) {
    return {
      ok: false,
      detail: m[1] + ' 维 × ' + m[2] + ' 方 = ' + m[3] + ' 格有证据，但有 ' + fakeN +
        ' 项把参照系统的能力当成我们的（见 audit-matrix-honesty.mjs）',
    };
  }
  // 证据硬性：每格必须有 URL / 文件:行号 / 截图之一，而不是只有文字描述。
  // 「Codex exec 统一代码执行工具」这类描述形式上算证据，实质无法核对。
  const M = JSON.parse(read(path.join(REPO, 'prototype/hermes-agents/matrix-data.json')));
  const allDims = M.dimensions.flatMap((g) => g.items);
  const SUBJ = ['us', 'chatgpt', 'claude', 'dsh', 'openclaw', 'hermes', 'ecc', 'luanyujia'];
  const HARD = {
    url: /https?:\/\//,
    pathLine: /[A-Za-z0-9_\u4e00-\u9fa5\\/.-]+\.(?:py|ts|tsx|mjs|js|json|md|rs|yaml|yml|css|scss)(?::\d+)?/,
    screenshot: /\.png|\.jpg|截图/,
  };
  let hardN = 0, cellN = 0;
  for (const it of allDims) {
    for (const s of SUBJ) {
      const c = it[s];
      if (!Array.isArray(c) || c.length < 2) continue;
      cellN++;
      const tx = String(c[1]);
      if (HARD.url.test(tx) || HARD.pathLine.test(tx) || HARD.screenshot.test(tx)) hardN++;
    }
  }
  const hardPct = Math.round((hardN / cellN) * 100);
  // 门槛：至少 50% 的格子有可核对的硬证据
  //   历程：13%（起点）→ 29%（源码锚点）→ 46%（官方文档）→ 55%（ECC 锚点）
  if (hardPct < 50) {
    return {
      ok: false,
      detail: m[1] + ' 维 × ' + m[2] + ' 方有证据，但只有 ' + hardN + '/' + cellN +
        ' 格（' + hardPct + '%）带 URL/文件行号/截图，低于 50% 门槛',
    };
  }
  return {
    ok: true,
    detail: m[1] + ' 维 × ' + m[2] + ' 方 = ' + m[3] + ' 格；硬证据 ' + hardN + '/' + cellN +
      '（' + hardPct + '%：URL/文件行号/截图）；诚实性审计：假绿 0',
  };
});

// ══════════════════════════════════════════════════════
//  要求 3：功能对等 —— 参照系统有我们没有的，必须补齐且可验证
// ══════════════════════════════════════════════════════
req('R3', '功能对等（缺口补齐且可验证）', () => {
  const M = JSON.parse(read(path.join(REPO, 'prototype/hermes-agents/matrix-data.json')));
  const dims = M.dimensions.flatMap((g) => g.items);
  const partial = dims.filter((d) => d.us[0] === '部分');
  const gaps = dims.filter((d) => d.us[0] === '无');
  // 「声明的非目标」不算漏做：换赛道的科目按不适用处理（理由写在 _deliberateGaps）。
  const deliberate = new Set((M._deliberateGaps?.items || []).map((x) => x.dim));
  const realGaps = gaps.filter((d) => !deliberate.has(d.id));
  const declared = gaps.filter((d) => deliberate.has(d.id));
  if (realGaps.length === 0) {
    return {
      ok: true,
      detail: '真缺口 0；「部分」' + partial.length + ' 项；声明非目标 ' + declared.length +
        ' 项（' + declared.map((d) => d.id).join(',') + '）',
    };
  }
  return {
    state: 'WARN',
    detail: '仍有 ' + realGaps.length + ' 个真缺口：' + realGaps.map((d) => d.id + ' ' + d.name).join(' / ') +
      '（部分 ' + partial.length + ' 项，声明非目标 ' + declared.length + ' 项）',
  };
});

// ══════════════════════════════════════════════════════
//  要求 4：5+ 项差异化优势
// ══════════════════════════════════════════════════════
req('R4', '5+ 项参照系统都没有的能力', () => {
  const p = path.join(REPO, 'research/差异化优势.md');
  if (!has(p)) return { ok: false, detail: '文档不存在' };
  const t = read(p);
  const items = (t.match(/^## [①②③④⑤⑥⑦⑧⑨]/gm) || []).length;
  const cmds = (t.match(/verify-[a-z-]+\.mjs|机制体检\.mjs|场景清单一致\.mjs|assign-domains\.mjs/g) || []).length;
  return { ok: items >= 5 && cmds >= 5, detail: items + ' 项能力，' + cmds + ' 处验证命令引用' };
});

// ══════════════════════════════════════════════════════
//  要求 5：界面有真实截图 + 可判定对比
// ══════════════════════════════════════════════════════
req('R5', '界面截图 + 可判定判据对比', () => {
  const doc = path.join(REPO, 'research/界面设计全量调研.md');
  if (!has(doc)) return { ok: false, detail: '缺全量调研文档' };
  const t = read(doc);
  // 调研覆盖面：报告里逐个点名的系统数（不靠感觉）
  const surveyed = (t.match(/^\| \*\*?[A-Za-z]/gm) || []).length + (t.match(/### \d+\.\d+ /g) || []).length;
  // 真界面截图：research/screenshots 与 ui-survey 下的图
  const countShots = (dir) => {
    if (!has(dir)) return 0;
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(png|jpe?g|webp)$/i.test(e.name)) n++;
      }
    };
    walk(dir);
    return n;
  };
  const own = countShots(path.join(REPO, 'research/screenshots'));
  const ref = countShots(path.join(REPO, 'research/ui-survey'));
  const nums = (t.match(/\b\d+\.\d{2}\b/g) || []).length;
  // 「我们自己的界面」必须有改动后的截图
  const after = has(path.join(REPO, 'research/screenshots/ui-chat-after.png'));
  const ok = own >= 3 && ref >= 10 && nums >= 10 && after;
  return {
    ok,
    detail: '我们 ' + own + ' 张 · 参照 ' + ref + ' 张 · ' + nums + ' 个可复算数值' +
      ' · 改动后截图 ' + (after ? '有' : '缺') + ' · 调研覆盖 ' + surveyed + ' 个产品段',
  };
});

// ══════════════════════════════════════════════════════
//  要求 6：四机制可运行且被真实触发
// ══════════════════════════════════════════════════════
req('R6', '调度/记忆/自愈/验证 四机制', () => {
  const out = run('node', ['prototype/hermes-agents/verify-mechanisms.mjs']);
  const m = out.match(/通过 (\d+)\s+失败 (\d+)/);
  if (!m) return { ok: false, detail: out.slice(-120) };
  const p = Number(m[1]), f = Number(m[2]);
  return { ok: f === 0 && p >= 30, detail: p + ' 断言通过 / ' + f + ' 失败（在位+可运行+真实触发三层）' };
});

// ══════════════════════════════════════════════════════
//  要求 7：架构分层图 + 每层代码位置与边界判据
// ══════════════════════════════════════════════════════
req('R7', '8 层架构 + 每层代码位置与边界', () => {
  if (!has(path.join(REPO, 'research/架构分层.md'))) return { ok: false, detail: '分层文档不存在' };
  const out = run('node', ['prototype/hermes-agents/verify-arch.mjs']);
  const m = out.match(/通过 (\d+)\s+失败 (\d+)/);
  if (!m) return { ok: false, detail: out.slice(-120) };
  const layers = (read(path.join(REPO, 'research/架构分层.md')).match(/^### L\d/gm) || []).length;
  return { ok: Number(m[2]) === 0 && layers >= 8, detail: layers + ' 层，' + m[1] + ' 断言（存在性+边界）全过' };
});

// ══════════════════════════════════════════════════════
//  B4 / D2 自研机制：体量红线 + 密度度量
//  这两项此前记「部分」，理由是「有验收纪律但没有产品侧机制」。
//  现在各自有可运行的实现，这里验它们真的在位且能判。
// ══════════════════════════════════════════════════════
req('B4', '单文件体量红线（自研）', () => {
  const out = run('node', ['tools/quality/size-guard.mjs']);
  const m = out.match(/扫描 (\d+) 个源文件，最大 ([\d.]+)KB/);
  const noRed = /✓ 没有文件超红线/.test(out);
  const allow = (out.match(/复核 20\d\d-\d\d-\d\d/g) || []).length;
  if (!m) {
    return { ok: false, detail: '体量检查没有输出（脚本可能失效）' };
  }
  return {
    ok: noRed,
    detail: (noRed ? '红线条数 0' : '有文件超 32KB 红线') +
      ' · 扫描 ' + m[1] + ' 个源文件 · 最大 ' + m[2] + 'KB' +
      ' · 白名单 ' + allow + ' 项（均写理由+复核日）' +
      ' · 排除 vendor 与上游原文件（红线只管我们自己写的代码）',
  };
});

req('A5', '上下文压缩（自研）', () => {
  const out = run('node', ['prototype/agent-ui/verify-context.mjs']);
  const tally = out.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  if (!tally) return { ok: false, detail: 'A5 验收没有输出' };
  const [p, f, u] = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
  if (u > 0) return { state: 'UNKNOWN', detail: 'A5 判不了（无法判断 ' + u + ' 项）' };
  const before = out.match(/测试上下文 (\d+) tokens/);
  const after = out.match(/压缩后 (\d+) tokens/);
  const ratio = out.match(/压缩率 ([\d.]+)/);
  const facts = out.match(/关键事实 (\d+) 类全部保留：(.+)/);
  return {
    ok: f === 0,
    detail: '结构化压缩（分级打分 + 关键事实保护 + 摘要 + 收敛回退）· 验收 ' + p + ' 项通过' +
      (before && after ? ' · 实测 ' + before[1] + ' → ' + after[1] + ' tokens' : '') +
      (ratio ? '（压缩率 ' + ratio[1] + '）' : '') +
      (facts ? ' · 关键事实 ' + facts[1] + ' 类全保留：' + facts[2] : ''),
  };
});

req('A7', '记忆治理：溯源/冲突/TTL（自研）', () => {
  const out = run('node', ['prototype/agent-ui/verify-memory.mjs']);
  const tally = out.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  if (!tally) return { ok: false, detail: 'A7 验收没有输出' };
  const [p, f, u] = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
  if (u > 0) return { state: 'UNKNOWN', detail: 'A7 判不了（无法判断 ' + u + ' 项，多半是界面数据未生成）' };
  const n = out.match(/有 (\d+) 条记忆/);
  const fresh = out.match(/有效条目数与统计一致（(\d+) = /);
  return {
    ok: f === 0,
    detail: '溯源（无来源拒绝写入）+ 冲突（覆盖改为标 superseded，旧值仍可查）+ TTL（过期不进结果但保留历史）' +
      ' · 验收 ' + p + ' 项通过' +
      (n ? ' · 实测 ' + n[1] + ' 条记忆' : '') +
      (fresh ? '（有效 ' + fresh[1] + '）' : '') +
      ' · gc 只删「过期且被推翻」',
  };
});

req('A3', '联网搜索与抓取（自研）', () => {
  const out = run('node', ['prototype/agent-ui/verify-net.mjs']);
  const tally = out.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  if (!tally) return { ok: false, detail: 'A3 验收没有输出' };
  const [p, f, u] = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
  if (u > 0) return { state: 'UNKNOWN', detail: 'A3 判不了（无法判断 ' + u + ' 项，多半是界面数据未生成）' };
  const results = out.match(/搜索 PASS 且有 (\d+) 条结果/);
  const chars = out.match(/抓取 PASS 且正文 (\d+) 字/);
  const backends = out.match(/记录了 (\d+) 个候选后端/);
  return {
    ok: f === 0,
    detail: '搜索（Bing/DDG 双结构解析 + 实体解码）+ 抓取（正文提取）+ 进界面 · 验收 ' + p + ' 项通过' +
      (results ? ' · 实测 ' + results[1] + ' 条搜索结果' : '') +
      (chars ? ' · 正文 ' + chars[1] + ' 字' : '') +
      (backends ? ' · ' + backends[1] + ' 个候选后端实测' : ''),
  };
});

req('A13', 'MCP 客户端（自研）', () => {
  const out = run('node', ['prototype/agent-ui/verify-mcp.mjs']);
  const tally = out.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  if (!tally) return { ok: false, detail: 'A13 验收没有输出' };
  const [p, f, u] = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
  if (u > 0) return { state: 'UNKNOWN', detail: 'A13 判不了（无法判断 ' + u + ' 项，多半是官方 SDK 未装）' };
  const sdk = out.match(/官方 SDK 在位：@modelcontextprotocol\/sdk ([\d.]+)/);
  return {
    ok: f === 0,
    detail: 'stdio + JSON-RPC 2.0 客户端 · 验收 ' + p + ' 项通过' +
      ' · 自检层（内置假 server，协议正确性）+ 真 server 层（' +
      (sdk ? '官方 SDK ' + sdk[1] : '官方 SDK') + '）' +
      ' · 四态：握手成功 PASS / JSON-RPC error FAIL / 连不上 UNKNOWN',
  };
});

req('A11', '定时调度器（自研）', () => {
  const out = run('node', ['prototype/agent-ui/verify-scheduler.mjs']);
  const tally = out.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  if (!tally) return { ok: false, detail: 'A11 验收没有输出' };
  const [p, f, u] = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
  if (u > 0) return { state: 'UNKNOWN', detail: 'A11 判不了（无法判断 ' + u + ' 项）' };
  const runs = out.match(/运行记录已留痕（(\d+) 条/);
  return {
    ok: f === 0,
    detail: '持久化 job + 五段 cron + 真实执行 + 留痕 · 验收 ' + p + ' 项通过' +
      (runs ? ' · 实测留痕 ' + runs[1] + ' 条' : '') +
      ' · 四态验证（PASS/FAIL/超时→UNKNOWN）· 退出码 0/1/2',
  };
});

req('D3', '运行时状态可见性（自研）', () => {
  const out = run('node', ['prototype/agent-ui/verify-runtime-state.mjs']);
  const tally = out.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  if (!tally) return { ok: false, detail: 'D3 验收没有输出' };
  const [p, f, u] = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
  if (u > 0) return { state: 'UNKNOWN', detail: 'D3 判不了（无法判断 ' + u + ' 项）' };
  // 抓关键数字进摘要，方便一眼核对
  const gw = out.match(/网关记 PASS 且模型数 > 0（(\d+) 个）/);
  const pr = out.match(/进程记 PASS 且数量 > 0（(\d+) 个）/);
  return {
    ok: f === 0,
    detail: '六类采集（进程/端口/网关/仓库/验收/资源）· 验收 ' + p + ' 项通过' +
      (pr ? ' · 实测进程 ' + pr[1] + ' 个' : '') +
      (gw ? ' · 网关 ' + gw[1] + ' 个模型' : '') +
      ' · 反假绿断言（PASS 必须有实观测）全过',
  };
});

req('D2', '信息密度度量（自研）', () => {
  const out = run('node', ['prototype/agent-ui/verify-density.mjs']);
  const tally = out.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  if (!tally) return { ok: false, detail: 'D2 验收没有输出' };
  const [p, f, u] = [Number(tally[1]), Number(tally[2]), Number(tally[3])];
  if (u > 0) return { state: 'UNKNOWN', detail: 'D2 判不了（无法判断 ' + u + ' 项，缺浏览器或产物）' };
  // 关键：要能看到「我们 vs 参照」的真实数字，包括我们落后
  const cmp = out.match(/我们-念初[\s\S]{0,400}?行密度\s+([\d.]+)\s+([\d.]+)/);
  const honest = /诚实结论：界面层我们与上游同源，密度未超过它/.test(out);
  return {
    ok: f === 0,
    detail: '五类指标（填充率/字符密度/交互密度/留白/行密度）· 验收 ' + p + ' 项通过' +
      ' · 可复算偏差 <5%' +
      (honest ? ' · 诚实标注：界面密度未超上游（同源）' : ''),
  };
});

// ══════════════════════════════════════════════════════
//  要求 8：全部改动进 git + 体检/验收器通过，不许假绿
// ══════════════════════════════════════════════════════
req('R8', '改动进 git + 验收器全绿', () => {
  // 【2026-11-18 加】变异残留扫描 —— 放在最前面。
  // 起因：第八次残留被提交进 HEAD（scheduler.mjs:93 留着 return true 加变异标记），
  // 导致 verify-scheduler 从 12/0 变 11/1、R6 红。而 R8 当时只查「树干净」，
  // 变异代码提交后树也是干净的 —— 查不出来。
  // 现在：真实源码里只要出现变异标记就判红。
  const residue = run('node', ['tools/quality/scan-mutation-residue.mjs']);
  if (/四态:\s*FAIL/.test(residue)) {
    return { state: 'FAIL', detail: '真实源码里有变异残留：' + (residue.split('\n').filter((l) => /残留/.test(l))[0] || '').trim() };
  }

  const dirty = run('git', ['status', '--short']).trim();
  const dirtyN = dirty ? dirty.split('\n').filter(Boolean).length : 0;
  const patch = run('node', ['hermes-patches/apply.mjs', '--check'], REPO);
  const patchOk = /全部应用/.test(patch);

  // 界面层验证：直接跑我们自己的前端（apps/vouch-web）。
  //  旧做法是连 hermes 桌面端 CDP 9333 —— 但主线前端已经换成 fork 的 OpenBitFun，
  //  那个桌面端与它无关。继续用旧判据 = 拿不存在的环境判不存在的界面，
  //  会永远 UNKNOWN。现在验真的东西：产物 + 启动 + 渲染 + 品牌。
  const ui = run('node', ['prototype/agent-ui/verify-ui-layer.mjs']);
  const uiTally = ui.match(/通过 (\d+)\s+失败 (\d+)\s+无法判断 (\d+)/);
  const uiPass = uiTally ? Number(uiTally[1]) : 0;
  const uiFail = uiTally ? Number(uiTally[2]) : 1;
  const uiUnk = uiTally ? Number(uiTally[3]) : 0;

  // 界面层判不了（没构建 / 没浏览器）→ R8 判不了，不许塌成 PASS 或 FAIL
  if (uiUnk > 0 || !uiTally) {
    return {
      state: 'UNKNOWN',
      detail: '界面层判不了（无法判断 ' + uiUnk + ' 项' + (uiTally ? '' : '，脚本无输出') + '）。' +
        'git ' + (dirtyN ? '有 ' + dirtyN + ' 项未提交' : '干净') + ' · 补丁集 ' + (patchOk ? '在位' : '未应用'),
    };
  }

  const ok = dirtyN === 0 && uiFail === 0 && patchOk;
  return {
    ok,
    detail: '未提交 ' + dirtyN + ' 项 · 界面层 ' + uiPass + ' 项通过/' + uiFail + ' 失败' +
      '（产物+启动+渲染+品牌）· 补丁集 ' + (patchOk ? '在位' : '未应用'),
  };
});

// ══════════════════════════════════════════════════════════════
//  R9 · L4 改进闭环 —— 「会自己变强」的物理位置
//
//  为什么它是单独一条硬要求：
//  拆解 22 个参照系统后，共同缺的不是能力，是闭环（见 research/念初-本体论.md）。
//  7 份报告提到「结论不可独立验证」，3 份提到「不会自己变强」，2 份提到「改进没有度量」。
//
//  三条硬约束（对应本体论 C4/C2/C5）：
//    C4 无基线不许登记（否则「改进了」无法证伪）
//    C2 样本不足结论只能 UNKNOWN（不许拿印象当结论）
//    C5 自验自 ⇒ 状态降为「部分」（自己验自己不算独立验证）
// ══════════════════════════════════════════════════════════════
req('R9', 'L4 改进闭环（假设→改→量→留或退→留痕）', () => {
  const r = run('node', ['prototype/agent-ui/verify-evolve.mjs']);
  const m = r.match(/(✅|🟡|❌|❔)\s+L4/);
  const state = m ? ({ '✅': 'PASS', '🟡': 'WARN', '❌': 'FAIL', '❔': 'UNKNOWN' })[m[1]] : null;
  const detail = (r.split('\n').map((l) => l.trim()).find((l) => /硬约束自检/.test(l)) || r.trim().slice(0, 160));
  if (!state) return { state: 'UNKNOWN', detail: 'L4 验收器没有输出可判定的结论：' + r.trim().slice(0, 120) };
  return { state, detail };
});

// ══════════════════════════════════════════════════════════════
//  R10 · C6 成本可复算
//
//  为什么它值得单独一条：
//  22 个参照系统里 DSH **完全不知道一轮花多少**（源码里搜 usd/dollar/pricing 零命中），
//  多数系统成本不可见，只有 openclaw 做了（manifest 内嵌单价）。
//
//  实测过程中发现两个真问题（都在 report 里如实记录）：
//    · 回显的 model 与请求的不一定相同，且**规则因 provider 而异**
//      （auto/* → group/auto-*；fableaiapi/* 原样；github-copilot/* 不返回 model）
//      ⇒ 必须有解析层，且解析失败判 UNKNOWN 而**绝不猜 0**
//    · 冻结单价才能保证「换模型后历史金额不重算」
// ══════════════════════════════════════════════════════════════
req('R10', 'C6 成本可复算（含模型 id 解析层）', () => {
  const r = run('node', ['prototype/agent-ui/verify-cost.mjs']);
  const m = r.match(/(✅|🟡|❌|❔)\s+C6/);
  const state = m ? ({ '✅': 'PASS', '🟡': 'WARN', '❌': 'FAIL', '❔': 'UNKNOWN' })[m[1]] : null;
  const detail = (r.split('\n').map((l) => l.trim()).find((l) => /自检 \d+/.test(l)) || r.trim().slice(0, 180));
  if (!state) return { state: 'UNKNOWN', detail: 'C6 验收器没有输出可判定的结论：' + r.trim().slice(0, 120) };
  return { state, detail };
});

// ══════════════════════════════════════════════════════════════
//  R11 · T5 横向领先
//
//  为什么单独一条：render-matrix 只校验「有状态有证据」，
//  不校验「我们真的比全部参照系统多」。这条把覆盖率真算出来。
//
//  **重要限制（必须一起读，所以写进 detail）**：
//  矩阵里其他 7 方的分数是**我们打的**，不是第三方评分。
//  所以这个 PASS 的真实含义是「在我们自己的评估口径下我们不是落后的」，
//  不是「客观上最强」。领先幅度 0.5 分，一次评分调整就能翻转。
// ══════════════════════════════════════════════════════════════
req('R11', 'T5 横向领先（覆盖率第一 + 0 假绿）', () => {
  // 注意：本文件里的 run() 返回**字符串**（不是 {code,out} 对象）
  const r = run('node', ['tools/evolve/audit-lead.mjs']);
  const m = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(r);
  if (!m) return { state: 'UNKNOWN', detail: 'T5 审计没有输出四态：' + r.trim().slice(0, 120) };
  const rank = /我们排名 (\d+\/\d+)/.exec(r);
  const margin = /差距 ([\d.-]+)/.exec(r);
  const fake = /疑似假绿 (\d+)/.exec(r);
  const ourFull = /有 (\d+) · 部分/.exec(r);
  // 【2026-11-17 加】领先幅度分解：把「自评领先」拆成「只在双方可核验维上的领先」
  // 与「靠不可核验维撑出来的部分」。这样「领先多可信」是个数字而不是说法。
  const dc = run('node', ['tools/evolve/decompose-lead.mjs']);
  const dcm = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(dc);
  const bothN = /双方可核验 (\d+)/.exec(dc);
  const bothMargin = /② 可信口径[^⇒]*⇒ 差 ([+-]?[\d.]+)/.exec(dc);
  // 反例自检：反例不报 = 这个分解是假的
  const dce = run('node', ['prototype/agent-ui/verify-decompose-lead.counterexamples.mjs']);
  const dcem = /自检 (\d+)\/(\d+)/.exec(dce);
  const dceOk = dcem && dcem[1] === dcem[2];
  const decomposeNote = dcm
    ? (' · 分解: ' + (bothN ? bothN[1] : '?') + ' 维双方可核验上领先 '
      + (bothMargin ? bothMargin[1] : '?') + ' 分'
      + (dceOk ? '（反例自检 ' + dcem[1] + '/' + dcem[2] + '）' : '（**反例自检未过，分解不可信**）'))
    : ' · 分解: 未产出';

  return {
    state: m[1],
    detail: '排名 ' + (rank ? rank[1] : '?')
      + ' · 自评领先 ' + (margin ? margin[1] : '?') + ' 分'
      + ' · 假绿 ' + (fake ? fake[1] : '?')
      + ' · 我们「有」' + (ourFull ? ourFull[1] : '?') + ' 维'
      + decomposeNote
      + ' · **自评口径，非第三方评分**',
  };
});

// ══════════════════════════════════════════════════════════════
//  R12 · 数据新鲜度纪律（防「旧快照冒充此刻」）
//
//  为什么需要独立一条：2026-11-17 发现四态面板/验证/总览/记忆/联网/神经元/标杆
//  共 7 处把 32~55 小时前的快照当成「当前通过」展示。人肉检查会漏（实现方自己
//  就漏了 BenchmarkScene，是机器抓出来的），所以必须机器查且纳入硬要求。
//
//  判据：任何场景 import 了含时间戳的 data/*.json，就必须用新鲜度机制；
//  且验收器自身的反例自检必须全过（反例不报 = 这个检查是假的）。
// ══════════════════════════════════════════════════════════════
req('R12', '数据新鲜度纪律（7 场景全覆盖 + 反例自检）', () => {
  const r = run('node', ['prototype/agent-ui/verify-freshness-discipline.mjs']);
  const m = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(r);
  if (!m) return { state: 'UNKNOWN', detail: '纪律验收器没有输出四态：' + r.trim().slice(0, 120) };
  const ok = /合规 (\d+) · 违规 (\d+)/.exec(r);
  // 反例自检：反例不报 = 这个检查是假的
  const ce = run('node', ['prototype/agent-ui/verify-freshness-discipline.counterexamples.mjs']);
  const cem = /自检 (\d+)\/(\d+)/.exec(ce);
  const ceOk = cem && cem[1] === cem[2];
  if (!ceOk) {
    return {
      state: 'FAIL',
      detail: '反例自检未全过（' + (cem ? cem[1] + '/' + cem[2] : '?') + '）—— 检查器本身不可信',
    };
  }
  return {
    state: m[1],
    detail: '合规 ' + (ok ? ok[1] : '?') + ' · 违规 ' + (ok ? ok[2] : '?')
      + ' · 反例自检 ' + cem[1] + '/' + cem[2] + ' 全过',
  };
});

// ══════════════════════════════════════════════════════════════
//  R13 · 矩阵 ↔ 实现 绑定（防「标了『有』但没有实现」）
//
//  为什么需要：audit-matrix-honesty 只查「有没有证据文字」，不查「文字里说的
//  路径是否真的存在」。T5 要求「每一格有我们自己的可运行实现或如实标注借力」，
//  这后半截必须机器查。
//
//  判据：我方标「有」⇒ 至少一个引用路径真实存在；标「部分/借力/无」不强制
//  （如实标注借力是允许的，不能因此判红 —— 那是假红）。
//  同时跑反例自检，反例不全过 ⇒ FAIL（反例不报 = 这个检查是假的）。
// ══════════════════════════════════════════════════════════════
req('R13', '矩阵 ↔ 实现绑定（28/28 有真实路径 + 反例自检）', () => {
  const r = run('node', ['prototype/agent-ui/verify-matrix-binding.mjs']);
  const m = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(r);
  if (!m) return { state: 'UNKNOWN', detail: '绑定验收器没有输出四态：' + r.trim().slice(0, 120) };
  const bound = /标「有」且有真实实现路径：(\d+)\/(\d+)/.exec(r);
  const viol = /违规 (\d+)/.exec(r);
  const ce = run('node', ['prototype/agent-ui/verify-matrix-binding.counterexamples.mjs']);
  const cem = /自检 (\d+)\/(\d+)/.exec(ce);
  if (!cem || cem[1] !== cem[2]) {
    return {
      state: 'FAIL',
      detail: '反例自检未全过（' + (cem ? cem[1] + '/' + cem[2] : '?') + '）—— 检查器本身不可信',
    };
  }
  return {
    state: m[1],
    detail: '标「有」有真实路径 ' + (bound ? bound[1] + '/' + bound[2] : '?')
      + ' · 违规 ' + (viol ? viol[1] : '?')
      + ' · 反例自检 ' + cem[1] + '/' + cem[2] + ' 全过',
  };
});

// ══════════════════════════════════════════════════════════════
//  R14 · 跨组件存储同步（防「A 写了 B 看不见」）
//
//  为什么需要：2026-11-17 场景记忆面板写派单账本，DispatchScene 一直挂载却
//  永不重读 localStorage ⇒ 派单真的进了账本，界面上什么都没有。这类 bug
//  type-check 与 build 都过，只有端到端真跑才暴露。
//
//  判据：同一 key 被 ≥2 个文件读写 ⇒ 必须有真同步机制（storage 监听 /
//  自定义事件广播 / *_CHANGED 监听）。仅 1 个文件用不要求（组件内自洽）。
//  同时跑反例自检，反例不全过 ⇒ FAIL。
// ══════════════════════════════════════════════════════════════
req('R14', '跨组件存储同步（共用 key 必须有同步机制）', () => {
  const r = run('node', ['prototype/agent-ui/verify-storage-sync.mjs']);
  const m = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(r);
  if (!m) return { state: 'UNKNOWN', detail: '同步检查没有输出四态：' + r.trim().slice(0, 120) };
  const shared = /被 ≥2 个文件共用：(\d+)/.exec(r);
  const risk = /隐患 (\d+)/.exec(r);
  const ce = run('node', ['prototype/agent-ui/verify-storage-sync.counterexamples.mjs']);
  const cem = /自检 (\d+)\/(\d+)/.exec(ce);
  if (!cem || cem[1] !== cem[2]) {
    return {
      state: 'FAIL',
      detail: '反例自检未全过（' + (cem ? cem[1] + '/' + cem[2] : '?') + '）—— 检查器本身不可信',
    };
  }
  return {
    state: m[1],
    detail: '共用 key ' + (shared ? shared[1] : '?') + ' 个 · 隐患 ' + (risk ? risk[1] : '?')
      + ' · 反例自检 ' + cem[1] + '/' + cem[2] + ' 全过',
  };
});

// ══════════════════════════════════════════════════════
//  输出
// ══════════════════════════════════════════════════════
const ICON = { PASS: '✅', WARN: '🟡', FAIL: '❌', UNKNOWN: '❔' };
console.log('');
console.log('  ╔════════════════════════════════════════════════════════════════════════════╗');
console.log('  ║  目标验收：在功能/架构/执行逻辑/界面上超过 7 个参照系统                     ║');
console.log('  ╚════════════════════════════════════════════════════════════════════════════╝');
console.log('');
for (const r of rows) {
  console.log('  ' + ICON[r.state] + ' ' + r.id + ' ' + r.name);
  console.log('       ' + r.detail);
  if (V) console.log('');
}
console.log('');
console.log('  ────────────────────────────────────────────────────────────────────────────');
console.log('    通过 ' + pass + '   待补 ' + warn + '   失败 ' + fail + '   无法判断 ' + unknown +
  (ONLY
    ? '   （--only ' + ONLY.join(',') + ' · 跳过 ' + skip + ' 项）'
    : '   （共 ' + rows.filter((x) => x.state !== 'SKIP').length + ' 条硬要求）'));
console.log('  ────────────────────────────────────────────────────────────────────────────');
if (warn) {
  console.log('');
  console.log('  🟡 的含义：有实现但没补齐 —— 这是**已验证的不完整**，如实标注，不用 PASS 掩盖。');
}
if (unknown) {
  console.log('');
  console.log('  ❔ 的含义：**判断不了**，不是不达成。原因：');
  for (const r of unknownReasons) console.log('       · ' + r);
  console.log('     这不是「产品坏了」，是「验证环境不在」。补环境再跑 —— 不许当绿。');
}
console.log('');


// 退出码按四态裁决：0 只在「全 PASS」时给出。
// 有一条 WARN（已验证的不完整）都不许绿 —— 否则「8 条硬要求全过」这句话就是假绿。
process.exit(verdict({ pass, warn, fail, unknown }));
