/**
 * 自动归纳（Auto-Induction）
 *
 * 这是 luanyujia 公开版**明确留白**的两件事之一：
 *   "自动归纳：从对话里提'候选写回'，再经人审并入记忆。
 *    没有它，记忆要靠人手写 —— 这就是'越用越强'的速度差。"
 *
 * 设计原则（极其克制，因为写错记忆比不写更坏）：
 *   1. **只提名，不自动写**：产出"候选"给人和门禁看，不直接改 MEMORY.md
 *   2. **每条候选必须有出处**：哪句话、什么时候、哪个文件
 *   3. **写回判据**：只有"实质工作"才提（照 luanyujia 的表）
 *   4. **量有上限**：每次 ≤10 行 / ≤2 KB（照 luanyujia 的规矩）
 *   5. **去重**：已经在记忆里的不再提
 *
 * 为什么必须"人审"：
 *   luanyujia 的另一件留白是"验证闸"，它的经验是
 *   "没有它，写得越多越可能坏"。我们的门禁能验收 check，
 *   但**记忆内容对不对**只能人判断。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = import.meta.dirname;

/** 写回判据（照 luanyujia 的表） */
const KEEP = [
  { kind: 'build', re: /(建了|新增了|创建了|写了一个|加了一个|实现了)/, label: '建/改应用或模块' },
  { kind: 'fix', re: /(修好|修复了|解决了|改对了|bug\s*已修)/, label: '修 bug' },
  { kind: 'doc', re: /(写了一份|产出了|生成了|记录了|整理了)(文档|报告|方案|说明)/, label: '写报告/文档' },
  { kind: 'refactor', re: /(重构|架构变更|重新设计|重写了)/, label: '重构/架构变更' },
  { kind: 'decision', re: /(决定用|选定|确定了方案|改方案|采用)/, label: '选定技术方案' },
  { kind: 'convention', re: /(约定|规矩|规范|以后都|统一)/, label: '用户约定的规矩' },
  { kind: 'pitfall', re: /(踩坑|坑是|发现.{0,10}(问题|缺陷|错误)|根因)/, label: '新踩的坑' },
];

/** 不该记的（照 luanyujia 的表） */
const DROP = [
  { re: /(搜索结果|搜了一下|百度|谷歌)/, label: '搜索结果' },
  { re: /(临时路径|temp|%TEMP%|C:\\Windows)/i, label: '临时路径' },
  { re: /(报错原文|stack trace|Exception)/, label: '工具报错原文' },
  { re: /(这次先这样|暂时这样|一次性)/, label: '一次性约束' },
  { re: /(聊了|聊天记录|说了些)/, label: '聊天过程' },
];

/**
 * 从一段对话/工作记录里提候选。
 * 输入：文本（可以是当轮总结、几行工作日志、一段对话摘录）
 * 输出：{ candidates: [...], dropped: [...] }
 */
export function induce(text, opts = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const candidates = [];
  const dropped = [];

  for (const line of lines) {
    // 太长的不提（那是过程不是结论）
    if (line.length > 300) {
      dropped.push({ line: line.slice(0, 80) + '…', why: '过长（>300 字，像过程而非结论）' });
      continue;
    }

    // 先判"不该记"
    let dropHit = null;
    for (const d of DROP) {
      if (d.re.test(line)) { dropHit = d.label; break; }
    }
    if (dropHit) {
      dropped.push({ line: line.slice(0, 80), why: `不该记：${dropHit}` });
      continue;
    }

    // 再判"该记"
    let keepHit = null;
    for (const k of KEEP) {
      if (k.re.test(line)) { keepHit = k; break; }
    }
    if (keepHit) {
      candidates.push({
        kind: keepHit.kind,
        kindLabel: keepHit.label,
        text: line,
        at: new Date().toISOString(),
        source: opts.source || 'unknown',
      });
    }
  }

  // 量上限：≤10 条
  const maxItems = opts.maxItems ?? 10;
  if (candidates.length > maxItems) {
    const kept = candidates.slice(0, maxItems);
    const over = candidates.slice(maxItems);
    return { candidates: kept, dropped: dropped.concat(over.map(c => ({ line: c.text.slice(0, 60), why: '超出每次 ≤10 条上限' }))) };
  }

  return { candidates, dropped };
}

/** 与已有记忆去重（按文本指纹） */
export function dedupe(candidates, memoryText) {
  const norm = s => String(s || '').replace(/\s+/g, '').replace(/[：:，,。.]/g, '');
  const existing = new Set(
    String(memoryText || '').split(/\r?\n/).filter(Boolean).map(norm)
  );
  const fresh = [];
  const dup = [];
  for (const c of candidates) {
    const key = norm(c.text);
    // 完全相同的行
    if (existing.has(key)) { dup.push(c); continue; }
    // 很像的行（去掉前缀符号后相同）
    const core = key.replace(/^[-*•]/,'');
    const similar = [...existing].some(e => e.replace(/^[-*•]/, '') === core);
    if (similar) { dup.push(c); continue; }
    fresh.push(c);
  }
  return { fresh, dup };
}

/**
 * 生成"候选写回"报告（不直接改记忆）。
 * 写入 `scenes/<id>/.review/candidates-<时间>.md`，等人审。
 */
export function propose(sceneDir, text, opts = {}) {
  const { candidates, dropped } = induce(text, opts);
  if (candidates.length === 0) {
    return { ok: true, proposed: 0, dropped: dropped.length, note: '没有符合写回判据的候选' };
  }

  const memPath = join(sceneDir, 'MEMORY.md');
  const memText = existsSync(memPath) ? readFileSync(memPath, 'utf8') : '';
  const { fresh, dup } = dedupe(candidates, memText);

  if (fresh.length === 0) {
    return { ok: true, proposed: 0, duplicates: dup.length, note: '候选都已在记忆里（去重后为 0）' };
  }

  const reviewDir = join(sceneDir, '.review');
  mkdirSync(reviewDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = join(reviewDir, `candidates-${stamp}.md`);

  const body = [
    `# 自动归纳候选（${sceneDir.split(/[\\/]/).pop()}）`,
    '',
    `> 生成时间：${new Date().toISOString()}`,
    `> 来源：${opts.source || 'unknown'}`,
    '> ⛔ **这些只是候选，不会自动写进记忆。** 需要人确认后才并入 MEMORY.md。',
    '',
    `## 建议写回（${fresh.length} 条）`,
    '',
    ...fresh.map((c, i) => `${i + 1}. **[${c.kindLabel}]** ${c.text}`),
    '',
    dup.length ? `## 已存在（${dup.length} 条，跳过）\n\n${dup.map(c => `- ${c.text}`).join('\n')}\n` : '',
    dropped.length ? `## 未采纳（${dropped.length} 条）\n\n${dropped.map(d => `- ${d.line}  \n  → ${d.why}`).join('\n')}\n` : '',
    '---',
    '',
    '## 怎么并入',
    '',
    '人工确认后，把这些行**追加**到 `MEMORY.md` 的「历史记录」或「§五 坑与决策」段。',
    '⛔ 不要整段复制；只加确认过的那几条。',
  ].join('\n');

  writeFileSync(file, body, 'utf8');

  return {
    ok: true,
    proposed: fresh.length,
    duplicates: dup.length,
    dropped: dropped.length,
    file,
    candidates: fresh,
  };
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/induct.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const [, , cmd, sceneId, ...rest] = process.argv;

  if (cmd === 'propose') {
    if (!sceneId) {
      console.log('用法：node induct.mjs propose <sceneId> "<你的工作记录>"');
      process.exit(2);
    }
    const text = rest.join(' ');
    const sceneDir = join(HERE, 'scenes', sceneId);
    if (!existsSync(sceneDir)) { console.log(`${C.red}场景不存在：${sceneId}${C.reset}`); process.exit(2); }

    const r = propose(sceneDir, text, { source: 'cli' });
    if (r.proposed === 0) {
      console.log(`${C.yellow}没有新候选${C.reset}（${r.note}）`);
      process.exit(0);
    }
    console.log(`${C.green}提出 ${r.proposed} 条候选${C.reset}（跳过重复 ${r.duplicates} 条，未采纳 ${r.dropped} 条）`);
    console.log(`${C.dim}→ ${r.file}${C.reset}`);
    for (const c of r.candidates) console.log(`  ${C.dim}[${c.kindLabel}]${C.reset} ${c.text}`);
    process.exit(0);
  }

  if (cmd === 'selftest') {
    // 自检：判据必须真的区分该记/不该记
    console.log(`${C.bold}自动归纳自检${C.reset}\n`);
    const cases = [
      { text: '修好了 bridge 的输入框识别 bug', expect: 'keep', label: '修 bug 应记' },
      { text: '搜索结果里翻到三篇博客', expect: 'drop', label: '搜索结果不记' },
      { text: '临时路径 C:\\Users\\xxx\\Temp\\a.txt', expect: 'drop', label: '临时路径不记' },
      { text: '决定用 CDP 方案驱动浏览器', expect: 'keep', label: '技术方案应记' },
      { text: '踩坑：虚拟滚动导致字数检测失效', expect: 'keep', label: '新坑应记' },
      { text: '这次先这样，以后再改', expect: 'drop', label: '一次性约束不记' },
      { text: 'A'.repeat(400), expect: 'drop', label: '过长不记' },
    ];
    let pass = 0;
    for (const c of cases) {
      const r = induce(c.text);
      const got = r.candidates.length > 0 ? 'keep' : 'drop';
      const ok = got === c.expect;
      if (ok) pass++;
      console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${c.label.padEnd(20)} 期望=${c.expect} 实际=${got}`);
    }
    // 去重自检
    const r2 = dedupe(
      [{ text: '修好了输入框识别 bug' }, { text: '新增了能力开关' }],
      '- 修好了输入框识别bug\n'
    );
    const dedupeOk = r2.fresh.length === 1 && r2.dup.length === 1;
    if (dedupeOk) pass++;
    console.log(`${dedupeOk ? C.green + '✓' : C.red + '✗'}${C.reset} ${'去重生效'.padEnd(20)} fresh=${r2.fresh.length} dup=${r2.dup.length}`);

    const total = cases.length + 1;
    console.log(`\n===== 自动归纳自检：${pass}/${total} =====`);
    console.log(pass === total
      ? `${C.green}判据有效${C.reset}`
      : `${C.red}判据有缺陷${C.reset}`);
    process.exit(pass === total ? 0 : 1);
  }

  console.log('用法：');
  console.log('  node induct.mjs propose <sceneId> "<工作记录>"   生成候选（不自动写）');
  console.log('  node induct.mjs selftest                        判据自检');
  process.exit(2);
}
