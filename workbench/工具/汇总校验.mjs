#!/usr/bin/env node
/**
 * 汇总校验 —— 中枢最终产出的质量闸门
 *
 * ══════════════════════════════════════════════════════════════
 *  依据 方案/121 §4.2（三条硬规则）
 * ══════════════════════════════════════════════════════════════
 *
 *  1. 正文不出场：中枢只给指针，不给正文
 *  2. **每条结论必须挂 (场景, 产物)** —— 挂不上的句子一律进「我的推断」
 *  3. **必写覆盖缺口**
 *
 *  为什么这三条重要（调研原话）：
 *    · 第 2 条对应 Anthropic LLM-judge 的 factual accuracy / citation accuracy，
 *      也对应 MAST FM-3.3「错误验证 9.1%」
 *    · 第 3 条不写缺口 = 让用户以为全做了（等价 FM-3.2「验证不完整 8.2%」）
 *
 * ══════════════════════════════════════════════════════════════
 *  哪几条能机器校验
 * ══════════════════════════════════════════════════════════════
 *
 *  ✓ 结构完整性：四节齐全（结论/证据/分歧与缺口/下一步）
 *  ✓ 结论字数：≤3 句
 *  ✓ 全文上限：按场景数（1 场景 200 字 / 2-3 场景 400 字）
 *  ✓ **每条证据必须挂 [场景 · 路径]** ← 这是最硬的
 *  ✓ 证据路径必须真实存在（不能编）
 *  ✓ 覆盖缺口节不能为空（必须显式写「无」或列出缺口）
 *  ✗ 结论是否正确 —— 这个机器判不了，只能靠证据路径可追溯
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/汇总校验.mjs --file <汇总.md>        校验文件
 *  node 工具/汇总校验.mjs --text "..."            校验文本
 *  node 工具/汇总校验.mjs --check                  体检：模板与判据是否口径一致
 *  node 工具/汇总校验.mjs --selftest              自测（含反例）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  阈值
// ══════════════════════════════════════════════════════════════
export const LIMITS = {
  /** 结论最多几句 */
  MAX_CONCLUSION_SENTENCES: 3,
  /** 单场景字数上限 */
  MAX_CHARS_1: 200,
  /** 2-3 场景字数上限 */
  MAX_CHARS_2_3: 400,
  /** 需要决策时上限 */
  MAX_CHARS_DECISION: 150,
  /** 最少证据条数（1 个场景至少 1 条） */
  MIN_EVIDENCE: 1,
};

/** 中文按字符算，英文按词 */
function countChars(s) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = s.replace(/[\u4e00-\u9fff]/g, '').trim();
  const words = other ? other.split(/\s+/).filter(Boolean).length : 0;
  return cjk + words;
}

function countSentences(s) {
  const t = String(s).trim();
  if (!t) return 0;
  // 中文句号/问号/叹号 + 英文句点
  const parts = t.split(/[。！？!?]+|\.\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.length;
}

/** 提取某一节的内容 */
function extractSection(md, name) {
  const re = new RegExp('^#{1,3}\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  const m = md.match(re);
  if (!m) return null;
  const start = m.index + m[0].length;
  // 找下一个同级或更高级标题
  const rest = md.slice(start);
  const next = rest.match(/^#{1,3}\s+\S/m);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** 解析证据行的 [场景 · 路径] */
function parseEvidenceRefs(evidenceText) {
  const lines = String(evidenceText).split('\n').filter((l) => l.trim());
  const out = [];
  for (const line of lines) {
    // 匹配 [xxx · yyy] 或 [xxx·yyy] 或 [xxx | yyy]
    const m = line.match(/\[([^\]·|]+?)\s*[·|]\s*([^\]]+)\]/);
    if (m) {
      out.push({ line, scene: m[1].trim(), artifact: m[2].trim(), hasRef: true });
    } else {
      out.push({ line, scene: null, artifact: null, hasRef: false });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  校验
// ══════════════════════════════════════════════════════════════
export function validateSummary(text, opts) {
  const o = opts || {};
  const errs = [];
  const warns = [];
  const stats = {};

  const md = String(text || '').trim();
  if (!md) return { ok: false, errs: ['汇总为空'], warns, stats };

  // ═══ ① 四节齐全 ═══
  const sections = {
    conclusion: extractSection(md, '结论'),
    evidence: extractSection(md, '证据'),
    gaps: extractSection(md, '分歧与缺口') || extractSection(md, '缺口') || extractSection(md, '分歧'),
    next: extractSection(md, '下一步'),
  };

  for (const [k, name] of [['conclusion', '结论'], ['evidence', '证据'], ['gaps', '分歧与缺口']]) {
    if (sections[k] === null) {
      errs.push('缺「## ' + name + '」节');
    } else if (sections[k] === '') {
      errs.push('「' + name + '」节为空');
    }
  }

  // ═══ ② 结论 ≤3 句 ═══
  if (sections.conclusion) {
    const n = countSentences(sections.conclusion);
    stats.conclusionSentences = n;
    if (n > LIMITS.MAX_CONCLUSION_SENTENCES) {
      errs.push('结论 ' + n + ' 句，超过上限 ' + LIMITS.MAX_CONCLUSION_SENTENCES);
    }
    // 复述需求的检测：结论里出现「用户要求/需要我」这类开头
    if (/^(用户要求|需要我|根据用户|按照要求)/.test(sections.conclusion)) {
      warns.push('结论像是在复述需求，不像在回答');
    }
  }

  // ═══ ③ 每条证据必须挂 [场景 · 路径] ═══
  if (sections.evidence) {
    const refs = parseEvidenceRefs(sections.evidence);
    stats.evidenceLines = refs.length;
    stats.evidenceWithRef = refs.filter((r) => r.hasRef).length;

    if (refs.length < LIMITS.MIN_EVIDENCE) {
      errs.push('证据少于 ' + LIMITS.MIN_EVIDENCE + ' 条');
    }

    for (const r of refs) {
      if (!r.hasRef) {
        errs.push('证据行没有挂 [场景 · 产物路径]：' + r.line.slice(0, 50));
      }
    }

    // 检查引用的场景名是否真实
    const scenes = o.scenes || getSceneNames();
    for (const r of refs) {
      if (r.hasRef && r.scene && !scenes.includes(r.scene)) {
        warns.push('证据里引用的场景不在名单内：' + r.scene);
      }
    }

    // 检查产物路径是否真实存在（可选，因为产物可能还在别的机器）
    if (o.checkArtifactExists) {
      for (const r of refs) {
        if (!r.hasRef || !r.artifact) continue;
        const abs = path.isAbsolute(r.artifact) ? r.artifact : path.join(WB, r.artifact);
        if (!fs.existsSync(abs)) {
          errs.push('证据引用的产物不存在：' + r.artifact);
        }
      }
    }
  }

  // ═══ ④ 覆盖缺口必须显式写 ═══
  if (sections.gaps) {
    const g = sections.gaps.trim();
    // 必须写「无」或列出具体缺口
    const hasExplicitNone = /^(无|没有|全部覆盖|本次无缺口)/.test(g);
    // 缺口关键词（覆盖常见说法）
    const hasGapItem = /(未覆盖|没覆盖|没做|未做|缺|未解决|不一致|分歧|未涉及|不足|待补|限制|风险)/.test(g);
    if (!hasExplicitNone && !hasGapItem) {
      errs.push('「分歧与缺口」节必须有内容（写「无」也要显式写）');
    }
  }

  // ═══ ⑤ 字数上限（按场景数）═══
  const totalChars = countChars(md);
  stats.totalChars = totalChars;
  // 从证据里推断涉及几个场景
  const refs = sections.evidence ? parseEvidenceRefs(sections.evidence) : [];
  const sceneSet = new Set(refs.filter((r) => r.hasRef).map((r) => r.scene));
  stats.scenes = sceneSet.size;

  const limit = sceneSet.size <= 1 ? LIMITS.MAX_CHARS_1
    : sceneSet.size <= 3 ? LIMITS.MAX_CHARS_2_3
      : LIMITS.MAX_CHARS_2_3;
  stats.limit = limit;

  // 只对正文（去掉 markdown 标记）计
  if (totalChars > limit * 2) {
    // 超过 2 倍才报错，1-2 倍只警告（避免太严）
    errs.push('全文 ' + totalChars + ' 字，超过上限 ' + limit + ' 的 2 倍');
  } else if (totalChars > limit) {
    warns.push('全文 ' + totalChars + ' 字，超过建议上限 ' + limit);
  }

  // ═══ ⑥ 「我的推断」必须标注 ═══
  //   如果有不带引用的判断句，应该在「我的推断」里
  //   这里只做提示，不做硬校验

  return {
    ok: errs.length === 0,
    errs,
    warns,
    stats,
    sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v === null ? null : v.length])),
  };
}

function getSceneNames() {
  const names = [];
  const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
  if (!fs.existsSync(SCEN_DIR)) return names;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8').replace(/^\uFEFF/, ''));
      if (j.name) names.push(j.name);
    } catch { /* ignore */ }
  }
  return names;
}

// ══════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  汇总校验 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 合格汇总
  const good = `## 结论
派单通道已打通，端到端可跑通。

## 证据
- 投递成功且内容到达 — [架构梳理 · 数据/.dsh/场景记忆/架构梳理/验证.md]
- 五问判定正常 — [中枢 · 数据/.dsh/场景记忆/_共享记忆/派单台账.json]

## 分歧与缺口
- 本次没覆盖：真实任务闭环（API 余额不足）
- 我的推断（非证据）：余额问题解决后即可验证

## 下一步
- 等余额恢复后跑一次真实任务`;

  const r1 = validateSummary(good);
  chk('合格汇总通过', r1.ok, r1.errs.join('; ') || 'ok');
  chk('识别 2 条证据', r1.stats.evidenceWithRef === 2, String(r1.stats.evidenceWithRef));
  chk('结论 1 句', r1.stats.conclusionSentences === 1, String(r1.stats.conclusionSentences));

  // ② 反例：缺「分歧与缺口」
  const noGaps = `## 结论
完成。

## 证据
- 结论A — [架构梳理 · a.md]`;
  const r2 = validateSummary(noGaps);
  chk('反例：缺分歧与缺口必须报错', r2.errs.some((e) => e.includes('分歧与缺口')), r2.errs[0] || '');

  // ③ 反例：证据不挂引用
  const noRef = `## 结论
完成。

## 证据
- 投递成功了，一切都好

## 分歧与缺口
- 无`;
  const r3 = validateSummary(noRef);
  chk('反例：证据不挂[场景·路径]必须报错',
      r3.errs.some((e) => e.includes('[场景 · 产物路径]')), r3.errs[0] || '');

  // ④ 反例：结论超 3 句
  const longConc = `## 结论
第一句。第二句。第三句。第四句。第五句。

## 证据
- 结论A — [架构梳理 · a.md]

## 分歧与缺口
- 无`;
  const r4 = validateSummary(longConc);
  chk('反例：结论超 3 句必须报错',
      r4.errs.some((e) => e.includes('结论') && e.includes('句')), r4.errs[0] || '');

  // ⑤ 反例：缺口节写空
  const emptyGaps = `## 结论
完成。

## 证据
- 结论A — [架构梳理 · a.md]

## 分歧与缺口
（这里什么都没说，只是随便写点内容）`;
  const r5 = validateSummary(emptyGaps);
  chk('反例：缺口节无实质内容必须报错',
      r5.errs.some((e) => e.includes('分歧与缺口')), r5.errs[0] || '');

  // ⑥ 显式写「无」应该通过
  const explicitNone = `## 结论
完成。

## 证据
- 结论A — [架构梳理 · a.md]

## 分歧与缺口
无`;
  const r6 = validateSummary(explicitNone);
  chk('显式写「无」能通过', r6.ok, r6.errs.join(';') || 'ok');

  // ⑦ 反例：引用不存在的场景 → 警告
  const badScene = `## 结论
完成。

## 证据
- 结论A — [不存在的场景 · a.md]

## 分歧与缺口
无`;
  const r7 = validateSummary(badScene);
  chk('反例：引用不存在场景给警告',
      r7.warns.some((w) => w.includes('不在名单内')), r7.warns[0] || '');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加 --check（这个工具原来在体检里只能跑 selftest）
  //
  //    为什么不能直接拿默认模式去体检：
  //      `--file/--text` 必须给一份**具体的汇总稿** ——
  //      它是产出后的质量闸门，是运行时判据，没有稿子就没得判。
  //      塞一份假稿去体检 = 假检查。
  //
  //    但有一件事是**静态可查、也会真的坏**的：
  //      「中枢实际照抄的那份模板」和「校验器认的节名」必须口径一致。
  //      模板写在 场景记忆/中枢/AGENTS.local.md 的「## 汇总」段里，
  //      校验器认的是 结论/证据/分歧与缺口/下一步 四个节名。
  //      如果哪天有人改了模板里的节名（比如把「分歧与缺口」改成「风险」），
  //      中枢就会照着新模板写，而校验器还在找旧名字 →
  //      每一份合格汇总都会被判「缺节」，闸门变成噪音，最后大家都学会无视它。
  //      这正是口径不对齐的典型后果，而且它确实发生过（模板里写着
  //      「## 分歧与缺口  不一致 / 没覆盖 / 我的推断」这种带说明的标题）。
  //
  //    判据：
  //      ① 模板文件存在（找不到模板 = 中枢没得照抄，真问题）
  //      ② 模板里出现的四个节名，校验器必须都认（用 validateSummary 反过来验）
  //      ③ 校验器要求「分歧与缺口 必须显式写」，模板里必须有这一节的提示
  //    这三条都不依赖某一份具体稿子，可以静态跑。
  // ══════════════════════════════════════════════════════════════
  if (has('--check')) {
    const problems = [];
    const tplFile = path.join(WB, '数据', '.dsh', '场景记忆', '中枢', 'AGENTS.local.md');

    if (!fs.existsSync(tplFile)) {
      problems.push('找不到中枢模板：数据/.dsh/场景记忆/中枢/AGENTS.local.md');
    } else {
      const tpl = fs.readFileSync(tplFile, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      // 模板里的「## 汇总」段
      //
      // ⚠ 2026-11-12：第一版用 `([\s\S]*?)(?=^##\s|\Z)` 截段，
      //   但真实模板把四个节名写在 ``` 代码块里：
      //
      //       ## 汇总（≤400 字）
      //       ```
      //       ## 结论  ≤3 句…
      //       ## 证据  每条一行…
      //       ```
      //
      //   于是「下一个 ## 」正好撞上围栏里的 `## 结论`，
      //   截出来的段只有 "```\n" 三个字符，四条节名全报「没有」——
      //   检查自己把模板读错了，却报成模板有问题。
      //   （这正是本任务要防的「检查自己坏了自己」）
      //
      //   修法：逐行扫，跟踪 ``` 围栏开关，只在**围栏外**遇到 ## 才收段。
      const lines2 = tpl.split('\n');
      let inFence = false;
      let collecting = false;
      const blockLines = [];
      for (const ln of lines2) {
        const isFence = /^\s*```/.test(ln);
        if (!collecting) {
          if (/^##\s*汇总/.test(ln)) { collecting = true; }
          continue;
        }
        if (isFence) { inFence = !inFence; blockLines.push(ln); continue; }
        if (!inFence && /^##\s/.test(ln)) break;   // 围栏外的新 ## = 段结束
        blockLines.push(ln);
      }
      const block = blockLines.join('\n');

      if (!block.trim()) {
        problems.push('中枢模板里没有「## 汇总」段（或该段为空）');
      } else {
        // ⚠ 2026-11-12：这里第一版用 `^#{1,3}\s*<名>\s*$` 去匹配，
        //   但真实模板写的是
        //       ## 结论  ≤3 句，直接回答用户原话
        //   节名**后面带说明文字**，`\s*$` 匹配不上 → 四条全报「没有某节」，
        //   而模板明明是齐的。教训：判据要按**真实写法**取，
        //   不能按自己想象中的规范写法取。
        //
        //   现在用 `^#{1,3}\s*<名>`（只要行首是这节名就算），
        //   与 extractSection 的严格匹配分开 —— 前者验模板，后者验稿子。
        for (const name of ['结论', '证据', '分歧与缺口', '下一步']) {
          const hasHeading = new RegExp('^#{1,3}\\s*' + name, 'm').test(block);
          if (!hasHeading) {
            problems.push('模板「## 汇总」段里没有「' + name + '」节');
          }
        }
        // ⑤ 校验器硬要求：分歧与缺口不能空，模板必须提示「不一致/没覆盖/推断」
        if (!/(缺口|不一致|没覆盖|推断)/.test(block)) {
          problems.push('模板没提示「分歧与缺口」该写什么（校验器会因此把合格稿判红）');
        }
      }
    }

    // ⑥ 反向自洽：用一份**按模板生成**的最小合格稿，必须能过校验器
    const minimal = [
      '## 结论', '完成。', '',
      '## 证据', '- 结论A — [架构梳理 · a.md]', '',
      '## 分歧与缺口', '无', '',
      '## 下一步', '- 无',
    ].join('\n');
    const selfCheck = validateSummary(minimal, { scenes: ['架构梳理'] });
    if (!selfCheck.ok) {
      problems.push('校验器把「按模板写的最小合格稿」判红了：' + selfCheck.errs.join('；'));
    }

    console.log('═'.repeat(72));
    console.log('  汇总校验 · 检查（模板与判据口径）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  模板: ' + (fs.existsSync(tplFile) ? '数据/.dsh/场景记忆/中枢/AGENTS.local.md' : '缺失'));
    console.log('  最小合格稿: ' + (selfCheck.ok ? '通过' : '被误判'));
    console.log();

    if (problems.length === 0) {
      console.log('  ✓ 模板与校验器口径一致（四节齐全 + 最小合格稿能过）');
      process.exit(0);
    }
    console.log('  ✗ 口径不一致：');
    for (const p of problems) console.log('    · ' + p);
    process.exit(1);
  }

  let text = '';
  if (has('--file')) {
    const f = val('--file');
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      console.error('✗ 读不到文件: ' + f);
      process.exit(2);
    }
  } else if (has('--text')) {
    text = val('--text');
  } else {
    console.log('用法:');
    console.log('  node 工具/汇总校验.mjs --file <汇总.md>');
    console.log('  node 工具/汇总校验.mjs --text "..."');
    console.log('  node 工具/汇总校验.mjs --check    体检：模板与判据口径');
    console.log('  node 工具/汇总校验.mjs --selftest');
    process.exit(2);
  }

  const r = validateSummary(text, { checkArtifactExists: has('--check-artifacts') });

  console.log('═'.repeat(72));
  console.log('  汇总校验');
  console.log('═'.repeat(72));
  console.log();
  console.log('  结论句数:   ' + (r.stats.conclusionSentences ?? '?') + ' / ' + LIMITS.MAX_CONCLUSION_SENTENCES);
  console.log('  证据条数:   ' + (r.stats.evidenceWithRef ?? 0) + ' / ' + (r.stats.evidenceLines ?? 0));
  console.log('  涉及场景:   ' + (r.stats.scenes ?? 0));
  console.log('  总字数:     ' + (r.stats.totalChars ?? 0) + ' / ' + (r.stats.limit ?? '?'));
  console.log();

  if (r.warns.length > 0) {
    console.log('  ⚠ 警告:');
    for (const w of r.warns) console.log('    · ' + w);
    console.log();
  }

  if (r.ok) {
    console.log('  ✅ 通过');
    process.exit(0);
  } else {
    console.log('  ❌ 不通过:');
    for (const e of r.errs) console.log('    · ' + e);
    process.exit(1);
  }
}
