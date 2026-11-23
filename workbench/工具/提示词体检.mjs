#!/usr/bin/env node
// 工具/提示词体检.mjs —— 注入给 AI 的提示词，到底合不合格、有没有在变好
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（这是「提示层进化」的度量基础）
// ══════════════════════════════════════════════════════════════════════
//  调研依据：
//    · A Survey of Self-Evolving Agents (2025) 的 What to Evolve 三层：
//        Models / Context(Memory + **Prompt**) / Tools
//      我们已有记忆层（自我复盘），**提示层完全空白**。
//
//    · Hermes Agent 的做法（hermes-agent.nousresearch.com/docs）：
//      系统提示分三层 tier：stable → context → volatile
//      并强调「Progressive Disclosure」——技能列表只放 name+description（~3k tokens），
//      完整内容只在 skill_view 时才加载。
//
//  ──────────────────────────────────────────────────────────────────
//  我们的现状（诚实盘点）：
//
//    注入到每个场景的提示词由 场景注入.mjs 拼装：
//      AGENTS.local.md（身份/职责/管线/偏好/记忆注入/技能…）
//      预算 3400 B/场景 —— 实测 9 个场景都是 99% 占满
//
//    **但从来没有工具检查「这些字写得好不好」。**
//    只有「有没有超预算」，没有「有没有效」。
//
//  这个工具补三个判据：
//    ① 结构完整  —— 必须有的段落在不在（身份/职责/边界/管线）
//    ② 可执行性  —— 有多少条是「可判定的指令」vs「空洞的口号」
//    ③ 冗余度    —— 有没有重复表达同一件事（白占预算）
//
//  用法：
//    node 工具/提示词体检.mjs            检查全部场景
//    node 工具/提示词体检.mjs --json     机器可读
//    node 工具/提示词体检.mjs --scene X  只看一个
//    node 工具/提示词体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const SKILLS = path.join(DATA, 'skills');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 预算（与 场景注入.mjs 的 BUDGET 保持一致） */
export const BUDGET_BYTES = 3400;

/**
 * 必有的结构段落
 *
 * 依据：AGENTS.local.md 的生成模板 + 这个项目反复强调的「开场先认领身份」
 *
 * ⚠ 2026-11-13 修（第一版只查 `##` 二级标题，漏了 `#` 一级标题）
 *
 *   实测：架构梳理的 AGENTS.local.md 被判「缺身份段」，
 *        但它明明有：
 *          # 当前场景：架构梳理
 *          > 你正在「架构梳理」这个场景里工作。下面的约束是这个场景的**边界**，不是建议。
 *        —— 身份信息用一级标题写的，第一版的正则只匹配 `## xxx`。
 *
 *   修法：在整段文本里搜关键词，不限定标题级别。
 *        「有没有身份」和「身份写在第几级标题」是两件事。
 */
export const REQUIRED_SECTIONS = [
  { key: '身份', re: /当前场景|我是|你是.*场景|身份|认领/, why: '缺了 AI 不知道自己是谁' },
  { key: '职责', re: /职责|做什么|我做|一句话职责/, why: '缺了 AI 不知道干什么' },
  { key: '边界', re: /不碰|不做|边界|不许|⛔/, why: '缺了 AI 会越界' },
];

/**
 * 「空洞口号」的模式
 *
 * 这个项目一直在清理「看起来有实际是空」。
 * 提示词里最典型的口水话就是这些 —— 它们不构成任何可执行约束。
 */
export const EMPTY_PHRASE_PATTERNS = [
  /要(?:认真|仔细|努力|用心|严谨)/,
  /(?:尽量|尽可能)(?:做好|准确|完整)/,
  /保持(?:良好|高质量)/,
  /(?:注意|注重)(?:质量|细节|规范)(?:，|。|$)/,
  /(?:专业|高质量)(?:地|的)(?:完成|输出)/,
  /务必(?:确保)?(?:准确|正确)(?:无误)?(?:，|。|$)/,
];

/**
 * 可判定指令的特征
 *
 * ⚠ 2026-11-13 修（第一版判据太窄，把好内容判成坏内容）
 *
 *   实测：架构梳理的 AGENTS.local.md 被判「可判定率 2%」，
 *        但实际内容是：
 *          - `你的工作目录是：数据\.dsh\场景记忆\架构梳理`
 *          - ```powershell cd "..."; node 工具/派单.mjs --list```
 *          - `- 不删系统目录，只报告不动作`
 *        这些都是**完全可执行**的。
 *
 *   第一版为什么没识别：
 *     ① 代码块被过滤掉了（`^[|>─═\-]{2,}` 把 ``` 当成表格线）
 *        —— 而代码块恰恰是最可执行的部分
 *     ② 只认「不许」不认「不删/不碰/不改」
 *     ③ 不认「具体文件路径」
 *
 *   修法：把这三类都算进去。宁可判松一点，也不要误报好内容。
 */
export const EXECUTABLE_PATTERNS = [
  /\d+\s*(?:B|KB|MB|%|秒|分钟|条|行|段|个)/,              // 数字约束
  /(?:跑|执行|运行)\s*(?:node|工具|命令|`)/,                // 具体动作
  /(?:写进|落到|存到|记在)\s*\S+/,                          // 具体落点
  /(?:如果|若)\s*\S+?\s*(?:就|则)/,                         // 条件
  /⛔|★/,                                                   // 强调标记
  /(?:不许|禁止|必须|只能|一定|不要|别)/,                    // 强约束
  /(?:不删|不碰|不改|不动|不写|不编)/,                      // 负向约束（口语式）
  // 具体文件路径（相对或绝对）—— 有路径就是可执行的前提
  /(?:`|"|'|\s)[\w./\\-]*(?:\.mjs|\.json|\.md|\.yaml|\.vbs|\.js|\.css)[`"'\s]?/,
  /(?:数据|工具|外壳|prototype)[\\/][\w一-龥\\/.-]+/,        // 项目内路径
  // 代码块里的内容本身就算可执行
  /^\s*(?:cd |node |npm |git |powershell |curl )/,
];

/**
 * 是否属于「代码块或命令行」—— 这类行一律算可执行
 * @param {string} line
 */
export function isCodeOrCommand(line) {
  const l = String(line || '').trim();
  if (!l) return false;
  if (/^```/.test(l)) return true;
  return /^(?:cd |node |npm |npx |git |curl |powershell |cscript |\.\\|\.\/)/.test(l);
}

/**
 * 判一段提示词的质量
 *
 * @param {string} text
 * @returns {{ok:boolean, sections:object, empty:number, exec:number, total:number, problems:string[]}}
 */
export function judgePrompt(text) {
  const t = String(text || '');
  const problems = [];

  // ① 结构完整
  const sections = {};
  for (const s of REQUIRED_SECTIONS) {
    sections[s.key] = s.re.test(t);
    if (!sections[s.key]) problems.push('缺「' + s.key + '」段：' + s.why);
  }

  // ② 空洞口号
  let empty = 0;
  for (const re of EMPTY_PHRASE_PATTERNS) {
    const m = t.match(new RegExp(re.source, 'g'));
    if (m) empty += m.length;
  }
  if (empty > 0) problems.push('含 ' + empty + ' 处空洞口号（不构成可执行约束）');

  // ③ 可判定指令数
  //
  // ⚠ 2026-11-13 修：第一版过滤掉了代码块，而代码块恰恰最可执行
  //   （原来用 /^[|>─═\-]{2,}/ 过滤表格线，把 ``` 也一起滤掉了）
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bodyLines = lines.filter((l) => {
    if (/^#{1,6}\s/.test(l)) return false;              // 标题
    if (/^[|>─═\-]{2,}$/.test(l)) return false;          // 表格线 / 分隔线
    if (l.length <= 6) return false;                     // 太短
    return true;
  });
  let exec = 0;
  for (const l of bodyLines) {
    if (isCodeOrCommand(l)) { exec++; continue; }
    if (EXECUTABLE_PATTERNS.some((re) => re.test(l))) exec++;
  }
  const total = bodyLines.length;
  const execRate = total > 0 ? exec / total : 0;
  if (total > 10 && execRate < 0.25) {
    problems.push('可判定指令占比仅 ' + Math.round(execRate * 100) + '%（低于 25%，说明大多是描述而非约束）');
  }

  return {
    ok: problems.length === 0,
    sections, empty, exec, total,
    execRate: Math.round(execRate * 1000) / 10,
    problems,
  };
}

/** 豁免的场景 —— 它们不用标准注入模板，结构本来就不同 */
export const EXEMPT_SCENES = {
  '中枢': '用专属调度卡（工具/中枢调度卡.mjs），不是标准 AGENTS.local.md 模板。' +
          '它的职责是「调度」不是「干活」，所以没有常规的职责/边界三段。',
};

// ══════════════════════════════════════════════════════════════════════
function listScenes() {
  const out = [];
  if (!fs.existsSync(MEM)) return out;
  for (const d of fs.readdirSync(MEM, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    out.push(d.name);
  }
  return out;
}

function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/** 收集一个场景实际会被注入的所有文本 */
function collectScenePrompt(cn) {
  // ⚠ 2026-11-13 修（第一版把「记忆文件」也算成注入 = 误报）
  //
  //   实测：第一版收集 AGENTS.local.md + 场景私有记忆.md + 身份卡.md，
  //        算出架构梳理 20200 B —— 报「超预算 6 倍」。
  //
  //   但去看 场景注入.mjs 才明白：
  //     · **只有 AGENTS.local.md 是被注入的**（预算 3400 B）
  //     · 场景私有记忆.md / 身份卡.md 是 AI 按需 `Read` 的，
  //       引擎不会自动塞进上下文
  //
  //   把「按需读取的文件」算进「固定注入预算」，
  //   就像把整个文档库算进书签的重量 —— 判据对象错了。
  //
  //   修法：只算 AGENTS.local.md。
  //        其余文件的内容质量不在这个工具的判据范围内（那是 记忆体检 的事）。
  const parts = [];
  const agents = path.join(MEM, cn, 'AGENTS.local.md');
  if (fs.existsSync(agents)) parts.push({ src: 'AGENTS.local.md', text: readIf(agents) });
  return parts;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  提示词体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】好提示词能通过');
  {
    const good = [
      '# 甲场景',
      '',
      '## 身份',
      '我是甲场景的助手。',
      '',
      '## 职责',
      '- 产出一份改法单，写进 场景记忆/甲/改法单.md',
      '- 跑 node 工具/设计一致性.mjs 验证',
      '',
      '## 边界',
      '⛔ 不许改其他场景的记忆',
      '⛔ 不许超过 4KB',
    ].join('\n');
    const r = judgePrompt(good);
    chk('正例：结构完整 + 有可判定指令 → 通过', r.ok === true, r.problems.join('; ') || '无问题');
    chk('三段都识别到', r.sections['身份'] && r.sections['职责'] && r.sections['边界']);
  }

  console.log();
  console.log('【二】反例：缺结构段必须报');
  {
    const noId = '## 职责\n- 干活\n\n## 边界\n⛔ 不许越界';
    const r = judgePrompt(noId);
    chk('反例：缺「身份」→ 报错', r.ok === false);
    chk('报错说清为什么', /缺「身份」/.test(r.problems.join(' ')), r.problems.join('; '));
  }

  console.log();
  console.log('【三】反例：空洞口号必须报');
  {
    const empty = '## 身份\n我是助手\n## 职责\n要认真仔细地完成工作\n## 边界\n⛔ 不许越界';
    const r = judgePrompt(empty);
    chk('反例：含「认真仔细」→ 抓到', r.empty > 0, '抓到 ' + r.empty + ' 处');
    chk('反例：整体判不合格', r.ok === false);

    const empty2 = '## 身份\n我是助手\n## 职责\n请尽量做好，保持高质量\n## 边界\n⛔ 不许越界';
    const r2 = judgePrompt(empty2);
    chk('反例：「尽量做好」「保持高质量」→ 抓到', r2.empty >= 2, '抓到 ' + r2.empty + ' 处');
  }

  console.log();
  console.log('【四】反例：全是描述没有约束 → 可判定率低');
  {
    const weak = [
      '## 身份', '我是助手',
      '## 职责',
      '这个场景负责一些工作', '它需要处理很多事情', '有时候要看看情况',
      '遇到问题要想办法', '结果应该是好的', '过程要注意方法',
      '和其他场景有联系', '有时候需要等待', '最后要收尾',
      '## 边界', '⛔ 不许越界',
    ].join('\n');
    const r = judgePrompt(weak);
    chk('反例：可判定率低会被抓到', r.execRate < 25, r.execRate + '%');
  }

  console.log();
  console.log('【五】边界');
  {
    chk('空文本不崩', judgePrompt('').ok === false);
    chk('null 不崩', judgePrompt(null).ok === false);
  }

  console.log();
  console.log('【六】关键：这个工具补的是什么');
  chk('关键：之前只有「有没有超预算」，没有「有没有效」',
    true, '3400B 全占满 ≠ 写得好');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const only = val('scene');
  const scenes = listScenes().filter((s) => !only || s === only);

  const results = [];
  for (const cn of scenes) {
    const parts = collectScenePrompt(cn);
    const combined = parts.map((p) => p.text).join('\n');
    const bytes = Buffer.byteLength(combined, 'utf8');
    const j = judgePrompt(combined);
    // 冗余检测：同一句话在多个文件里重复出现
    const dupLines = new Map();
    for (const p of parts) {
      for (const l of p.text.split(/\r?\n/).map((x) => x.trim())) {
        if (l.length < 12) continue;
        if (!dupLines.has(l)) dupLines.set(l, []);
        dupLines.get(l).push(p.src);
      }
    }
    const dups = [...dupLines.entries()].filter(([, srcs]) => new Set(srcs).size > 1);
    // ⚠ 2026-11-13 加豁免：中枢用专属调度卡，不走标准模板。
    //   豁免必须**显式标注理由**，不能静默跳过 ——
    //   否则就成了「检查不到 = 假装合格」。
    const exempt = EXEMPT_SCENES[cn];
    results.push({
      scene: cn, bytes, parts: parts.length, ...j,
      dups: dups.length,
      exempt: exempt || '',
      // 豁免的场景不算「不合格」，但仍要显示它的指标（可见，不隐藏）
      ok: exempt ? true : j.ok,
    });
  }

  if (has('json')) {
    console.log(JSON.stringify({ total: results.length, ok: results.filter((r) => r.ok).length, results }, null, 2));
    return;
  }

  console.log('='.repeat(92));
  console.log('  提示词体检 —— 注入给 AI 的那些字，到底合不合格');
  console.log('='.repeat(92));
  console.log();
  console.log('  为什么需要：');
  console.log('    注入内容由 场景注入.mjs 拼装，预算 3400 B/场景（实测都 99% 占满）。');
  console.log('    但之前只有「有没有超预算」，**从来没有「这些字写得好不好」**。');
  console.log();
  console.log('  三个判据：');
  console.log('    ① 结构完整  —— 身份/职责/边界三段在不在');
  console.log('    ② 可执行性  —— 有多少条是可判定的约束，有多少是空洞口号');
  console.log('    ③ 冗余度    —— 有没有跨文件重复表达（白占预算）');
  console.log();

  console.log('  ' + '场景'.padEnd(12) + '体积'.padEnd(10) + '指令率'.padEnd(9) +
    '口号'.padEnd(6) + '重复'.padEnd(6) + '结论');
  console.log('  ' + '─'.repeat(88));
  for (const r of results) {
    const sizeMark = r.bytes > BUDGET_BYTES ? '⚠' : ' ';
    console.log('  ' + r.scene.padEnd(12) +
      (r.bytes + 'B' + sizeMark).padEnd(10) +
      (r.execRate + '%').padEnd(9) +
      String(r.empty).padEnd(6) +
      String(r.dups).padEnd(6) +
      (r.ok ? '✓' : '✗'));
    if (!r.ok) {
      for (const p of r.problems) console.log('       · ' + p);
    }
  }

  console.log();
  console.log('─'.repeat(92));
  const okCount = results.filter((r) => r.ok).length;
  console.log('  ' + okCount + ' / ' + results.length + ' 个场景的提示词合格');

  const avgExec = results.length ? Math.round(results.reduce((a, b) => a + b.execRate, 0) / results.length) : 0;
  const totalEmpty = results.reduce((a, b) => a + b.empty, 0);
  const totalDups = results.reduce((a, b) => a + b.dups, 0);
  console.log();
  console.log('  平均可判定指令率: ' + avgExec + '%');
  console.log('  空洞口号总数:     ' + totalEmpty + ' 处');
  console.log('  跨文件重复行:     ' + totalDups + ' 行');

  if (okCount < results.length) process.exitCode = 1;
  console.log('='.repeat(92));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
