#!/usr/bin/env node
// 工具/文档命令体检.mjs —— 检查文档里写的命令是否真的能跑
//
// ══════════════════════════════════════════════════════════════════════
//  为什么有这个工具
// ══════════════════════════════════════════════════════════════════════
//  2026-11-11 发现：hub 的 SKILL.md 里写的派单命令是
//      node 工具/派单.mjs --to <场景ID> --prompt "..." --needs "..."
//  但派单.mjs 根本不认识 --prompt / --needs，
//  它只会打印帮助然后 exit=0 —— **看起来成功了，台账里什么都没有**。
//
//  这正是「中枢派单发出去、场景收不到」的根因。
//  而且它不会报错，所以长期没人发现。
//
//  规律：**没有会失败的检查 = 文档可以随便写**。
//  所以要有一个工具，真的去跑文档里的命令，看它是否被接受。
//
//  ══════════════════════════════════════════════════════════════════════
//  检查什么
// ══════════════════════════════════════════════════════════════════════
//    ① skill / AGENTS.md 里出现的 `node 工具/xxx.mjs --yyy` 命令
//    ② 提取工具名和参数名
//    ③ 对每个工具，跑一次 --help，看它是否认识那个参数
//    ④ 不认识就报错（这是真缺陷：照着做会静默失败）
//
//  用法：
//    node 工具/文档命令体检.mjs
//    node 工具/文档命令体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WB = path.resolve(__dirname, '..');
const ROOT = path.resolve(WB, '..');

/** 判据常量：token 正则长度下限（各工具必须一致） */
export const TOKEN_RE_MIN_LEN = 20;

const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');

const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok, detail });
  console.log('  ' + (ok ? 'OK  ' : 'XX  ') + name + (detail ? '  ' + detail : ''));
}

// ══════════════════════════════════════════════════════════════════════
//  收集要检查的文档
// ══════════════════════════════════════════════════════════════════════
export function collectDocs() {
  const out = [];
  // skills
  const skillsDir = path.join(WB, '数据', '.dsh', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir)) {
      const p = path.join(skillsDir, d, 'SKILL.md');
      if (fs.existsSync(p)) out.push(p);
    }
  }
  // AGENTS.md
  for (const p of [
    path.join(WB, '数据', '.dsh', 'AGENTS.md'),
    path.join(WB, '数据', '.dsh', '场景记忆', '中枢', 'AGENTS.local.md'),
  ]) {
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  从文档里提取命令
// ══════════════════════════════════════════════════════════════════════
const TOOL_NAMES = new Set();
(function loadToolNames() {
  const dir = path.join(WB, '工具');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.mjs')) TOOL_NAMES.add(f.replace(/\.mjs$/, ''));
  }
})();

/**
 * 从一段文本里提取 `node 工具/<name>.mjs <args...>`
 * 返回 [{ tool, args: [], raw, line }]
 */
export function extractCommands(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ⚠ 2026-11-11：跳过注释行
    //   文档里常有「旧写法（错）」这种对照示例，写成 # 开头的注释。
    //   如果不跳过，检查器会把故意保留的错误写法当成真实命令报错，
    //   结果是「为了通过检查而删掉有价值的历史记录」—— 这是本末倒置。
    //   判据：shell 注释（# 开头）不是可执行命令。
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    // 匹配 node 工具/xxx.mjs 后面的参数
    const m = line.match(/node\s+[\\/]?(?:workbench[\\/])?工具[\\/]([A-Za-z0-9_\u4e00-\u9fa5-]+)\.mjs([^\n]*)/);
    if (!m) continue;
    const tool = m[1];
    const rest = m[2] || '';
    // 行内注释也要剥掉（`xxx --send # 说明`）
    const noComment = rest.split(/\s#/)[0];
    const args = [...noComment.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)/g)].map((x) => x[1]);
    out.push({ tool, args, raw: line.trim(), line: i + 1 });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  对每个工具取它认识的参数（跑 --help）
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
//  对每个工具取它认识的参数
//
//  ⚠ 2026-11-12 重写（第一版用的是错方法，导致我照着它把正确命令改错了）：
//
//    第一版：只跑 `node 工具/xxx.mjs --help`，从 stdout 里抓 --xxx。
//
//    问题：不是所有工具都实现了 --help。
//      实测 回滚.mjs --help 会走「列出快照」的默认分支，
//      输出里完全没有参数清单 → known 集合为空 → 被当成「没有 --help，跳过」。
//
//    更糟的是：我上一轮就是照着这个检查器的报警，
//      把 AGENTS.local.md 里**正确**的 `--snapshot --type ui`
//      改成了**错误**的 `--rollback <值> --diff <值>`。
//      而且改完还截断了字符串。
//
//    → 检查器本身错了，却让我去改正确的文档。
//      **一个错误的检查比没有检查更坏。**
//
//    修法：三层来源合并
//      ① 源码里的字符串字面量：'--xxx' / "--xxx" / `--xxx`
//         （这是最可靠的 —— 参数名必须以字面量出现在代码里才可能被识别）
//      ② --help 的 stdout（如果工具实现了）
//      ③ 源码注释里的用法说明（如 `node 工具/回滚.mjs --snapshot --type ui`）
// ══════════════════════════════════════════════════════════════════════
const toolArgCache = new Map();

export function knownArgsOf(tool) {
  if (toolArgCache.has(tool)) return toolArgCache.get(tool);
  const toolFile = path.join(WB, '工具', tool + '.mjs');
  if (!fs.existsSync(toolFile)) {
    toolArgCache.set(tool, null);
    return null;
  }

  const known = new Set();
  let src = "";
  try { src = fs.readFileSync(toolFile, 'utf8'); } catch { /* ignore */ }

  // ① 源码里的参数名字面量（最可靠）
  //    匹配 '--xxx' / "--xxx" / `--xxx` 以及 含 --xxx 的字符串
  for (const m of src.matchAll(/['"`]([^'"`]*?)--([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    known.add(m[2]);
  }
  //    也匹配纯 --xxx 出现在模板/正则里
  for (const m of src.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    known.add(m[1]);
  }

  // ② --help 输出（如果实现了）
  let out = "";
  try {
    out = execFileSync(process.execPath, [toolFile, '--help'], {
      cwd: WB, encoding: "utf8", timeout: 20000, windowsHide: true,
    });
  } catch (e) {
    out = String((e && (e.stdout || e.stderr)) || "");
  }
  for (const m of out.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)/g)) known.add(m[1]);

  toolArgCache.set(tool, known);
  return known;
}

// ══════════════════════════════════════════════════════════════════════
//  主检查
// ══════════════════════════════════════════════════════════════════════
function checkDocs() {
  const docs = collectDocs();
  chk('找到要检查的文档', docs.length > 0, docs.length + ' 个');
  if (!docs.length) return;

  let totalCmds = 0;
  const problems = [];

  for (const doc of docs) {
    const text = fs.readFileSync(doc, 'utf8');
    const cmds = extractCommands(text);
    const rel = doc.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    for (const c of cmds) {
      totalCmds++;
      const known = knownArgsOf(c.tool);
      if (known === null) {
        problems.push({ doc: rel, line: c.line, tool: c.tool, why: '工具不存在', raw: c.raw });
        continue;
      }
      if (known.size === 0) continue;   // 该工具没有 --help 输出，跳过参数校验
      const unknown = c.args.filter((a) => !known.has(a));
      if (unknown.length) {
        problems.push({
          doc: rel, line: c.line, tool: c.tool,
          why: '参数不存在: ' + unknown.map((u) => '--' + u).join(', '),
          raw: c.raw,
        });
      }
    }
  }

  chk('文档里的工具命令参数都存在', problems.length === 0,
    problems.length === 0 ? '检查 ' + totalCmds + ' 条命令' : problems.length + ' 条有问题');

  if (problems.length) {
    for (const p of problems) {
      console.log('       ' + p.doc + ':' + p.line + '  ' + p.why);
      console.log('         ' + p.raw.slice(0, 100));
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════════════
function selftest() {
  console.log('═'.repeat(72));
  console.log('  文档命令体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】命令提取');
  const t1 = [
    '```bash',
    'node 工具/派单.mjs --send --from hub --to research --subject "x"',
    'node workbench/工具/整体体检.mjs --offline',
    '```',
  ].join('\n');
  const cmds = extractCommands(t1);
  chk('能提取 2 条命令', cmds.length === 2, cmds.length + ' 条');
  chk('提取到第一个工具名', cmds[0] && cmds[0].tool === '派单', cmds[0] ? cmds[0].tool : '空');
  chk('提取到参数列表', cmds[0] && cmds[0].args.includes('send') && cmds[0].args.includes('from'),
    cmds[0] ? cmds[0].args.join(',') : '空');

  // ⚠ 反例：注释行不是可执行命令，不该被提取
  //   （实测踩过：文档里保留「旧写法（错）」对照示例时，
  //    检查器把它当真实命令报错，逼着人删掉有价值的历史记录）
  const t1b = [
    '```bash',
    '# 旧写法 node 工具/派单.mjs --prompt "x" --needs "y"',
    'node 工具/派单.mjs --send --from hub --subject "z"',
    '```',
  ].join('\n');
  const cmdsB = extractCommands(t1b);
  chk('反例：注释行不被当成命令', cmdsB.length === 1, cmdsB.length + ' 条（应为 1）');

  // 正例：行内注释要剥掉，噪声参数不该算进去
  const t1c = 'node 工具/派单.mjs --send --from hub  # 说明：这里说 --prompt 是错的';
  const cmdsC = extractCommands(t1c);
  chk('正例：行内注释里的参数被剥掉',
    cmdsC.length === 1 && !cmdsC[0].args.includes('prompt'),
    cmdsC[0] ? cmdsC[0].args.join(',') : '空');

  console.log();
  console.log('【二】参数识别');
  // 派单.mjs 应该认识 --send / --phenomenon，不认识 --prompt
  const known = knownArgsOf('派单');
  if (known) {
    chk('正例：派单.mjs 认识 --send', known.has('send'));
    chk('正例：派单.mjs 认识 --phenomenon', known.has('phenomenon'));
    chk('反例：派单.mjs 不认识 --prompt（旧 skill 的错误参数）', !known.has('prompt'),
      known.has('prompt') ? '← 竟然认识' : '符合预期');
    chk('反例：派单.mjs 不认识 --needs', !known.has('needs'));
  } else {
    chk('派单.mjs 可读参数', false, '读不到');
  }

  console.log();
  console.log('【三】反例：本次真实缺陷能被检出');
  // 模拟：如果 hub skill 写成 --prompt，检查逻辑应该报错
  const simulated = extractCommands('node 工具/派单.mjs --to research --prompt "x" --needs "y"');
  const k2 = knownArgsOf('派单');
  const bad = k2 ? simulated[0].args.filter((a) => !k2.has(a)) : [];
  chk('反例：--prompt/--needs 会被判为未知参数', bad.length === 2, bad.join(','));

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  ' + (f.detail || ''));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
//  代码一致性检查（防止跨文件的同类逻辑走样）
//
//  ⚠ 2026-11-12 新增，来源是「中枢」场景的诊断报告
//    （数据/.dsh/场景记忆/中枢/闭环断点诊断.md）指出的真实断点：
//
//    断点 2：两个工具抓 token 的正则不一致
//            投递通道.mjs 用 {30,}，中枢代写.mjs 用 {20,}
//            → token 长度落 20-29 时，一个抓得到一个抓不到，静默失败
//
//    这类缺陷的共性是：**同一个事实在两个地方各写了一遍，慢慢走样**。
// ══════════════════════════════════════════════════════════════════════
function checkCodeConsistency() {
  const toolsDir = path.join(WB, '工具');
  if (!fs.existsSync(toolsDir)) return;

  // ① token 正则必须一致
  const tokenRes = [];
  for (const f of fs.readdirSync(toolsDir).filter((x) => x.endsWith('.mjs'))) {
    const p = path.join(toolsDir, f);
    let c = "";
    try { c = fs.readFileSync(p, "utf8"); } catch { continue; }
    const m = c.match(/token=\(\[[^\]]*\]\{(\d+),\}\)/);
    if (m) tokenRes.push({ file: f, min: Number(m[1]) });
  }
  const mins = [...new Set(tokenRes.map((x) => x.min))];
  chk('各工具的 token 正则长度下限一致', mins.length <= 1,
    tokenRes.map((x) => x.file + '={' + x.min + ',}').join(', '));

  // ② 判断 turn 结束的工具必须读 reason.kind
  const endJudgers = [];
  for (const f of fs.readdirSync(toolsDir).filter((x) => x.endsWith('.mjs'))) {
    const p = path.join(toolsDir, f);
    let c = "";
    try { c = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (!c.includes("lastEvent.type === 'turn/end'")) continue;
    endJudgers.push({ file: f, hasReason: /reason\.kind/.test(c) });
  }
  const noReason = endJudgers.filter((x) => !x.hasReason).map((x) => x.file);
  chk('判断 turn 结束的工具都读 reason.kind', noReason.length === 0,
    noReason.length === 0 ? endJudgers.map((x) => x.file).join(', ') || '(无此类工具)' : '缺: ' + noReason.join(', '));

  // ③ 销账必须校验执行真完成（断点8：只读 state 会造成假闭环）
  const toolP = path.join(toolsDir, '派单.mjs');
  let closeOk = true;
  let closeNote = '';
  if (fs.existsSync(toolP)) {
    const c2 = fs.readFileSync(toolP, 'utf8');
    const hasDone = /lastTurnDone/.test(c2);
    const hasKind = /lastTurnKind|turn\.kind/.test(c2);
    closeOk = hasDone && hasKind;
    closeNote = 'lastTurnDone=' + hasDone + ' turnKind=' + hasKind;
  }
  chk('销账前校验执行真完成（防假闭环）', closeOk, closeNote);
}

function main() {
  if (SELFTEST) { selftest(); return; }

  console.log('═'.repeat(72));
  console.log('  文档命令体检 —— 文档里写的命令真的能跑吗');
  console.log('═'.repeat(72));
  console.log();

  checkDocs();
  checkCodeConsistency();

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
  if (failed.length) process.exitCode = 1;
  console.log('═'.repeat(72));
}

main();
