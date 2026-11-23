#!/usr/bin/env node
// 数据/.dsh/skills/frontend-craft/check.mjs —— 「前端工坊」的可执行验收
//
// ══════════════════════════════════════════════════════════════════════
//  这个场景负责什么
// ══════════════════════════════════════════════════════════════════════
//  界面质量的唯一对口人。
//
//  场景铁律（写在 SKILL.md 里）：
//    ⛔ 不许说「这个界面好丑」—— 必须说出具体哪条判据不达标
//    ⛔ 不许没截图就验收 —— 改前改后必须有对比图
//    ⛔ 验收标准不许写成「美观大方」—— 那没法判定
//
//  这个 check 就是把这四条铁律变成机器可验的判据。
//
// ──────────────────────────────────────────────────────────────────────
//  六项检查（F1-F6）
// ──────────────────────────────────────────────────────────────────────
//    F1 通用底线        非空 / 无占位 / ≥2 标题
//    F2 不许「丑」      ★ 不能说「丑/难看/一言难尽」，必须指具体判据
//    F3 判据要可测      ★ 每条问题必须带数值（对比度/px/ms/尺寸）
//    F4 不用空词        「美观大方/大气/高级感」等不可判定词禁用
//    F5 有截图证据      改前改后必须都有图片引用
//    F6 落点可核查      提到的文件必须真实存在
//
//  依据：用户原话「你的界面设计真的是一言难尽」——
//  这句话本身就不是可执行反馈。前端工坊的价值在于把它翻译成
//  「哪个元素、哪个值、应该是多少」。
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const SCENE_NAME = '前端工坊';

export const LIMITS = { MIN_LENGTH: 50 };

/** F2：禁用形容词（说了等于没说） */
export const BANNED_ADJ = ['好丑', '很难看', '一言难尽', '不好看', '太丑', '难看死了'];

/** F4：不可判定的空洞评价词 */
export const VAGUE_WORDS = ['美观大方', '大气', '高级感', '有质感', '简洁优雅', '看着舒服', '感觉很棒', '更美观', '设计感强'];

/** F3：可测的单位 */
export const MEASURABLE = /(\d+(?:\.\d+)?\s*(?:px|rem|em|%|ms|s|Hz|dpi|:1)?)|#[0-9A-Fa-f]{3,8}|rgba?\(/;

/**
 * F2/F3：判一条「问题描述」是否可执行
 *
 * 好例子： 「AI 面板底色 #FFFFFF，与外壳 #0E1114 对比度 21:1，跳」
 * 坏例子： 「界面很丑」
 *
 * @param {string} text
 */
export function judgeIssue(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: '问题描述为空' };

  // ① 禁形容词
  for (const w of BANNED_ADJ) {
    if (t.includes(w) && !MEASURABLE.test(t)) {
      return { ok: false, why: '只说「' + w + '」没给具体判据：' + t.slice(0, 30) };
    }
  }

  // ② 空洞词
  for (const w of VAGUE_WORDS) {
    if (t.includes(w) && !MEASURABLE.test(t)) {
      return { ok: false, why: '「' + w + '」不可判定：' + t.slice(0, 30) };
    }
  }

  // ③ 必须有可测值
  if (!MEASURABLE.test(t)) {
    return { ok: false, why: '没给任何可测值（px/对比度/颜色/ms）：' + t.slice(0, 30) };
  }

  return { ok: true, why: '' };
}

/**
 * 主判定
 * @param {string} productText
 */
export function check(productText) {
  const problems = [];
  const passed = [];
  const t = String(productText || '');
  const ev = { length: t.length };

  // ══ F1 通用底线 ══
  if (t.trim().length < LIMITS.MIN_LENGTH) problems.push('F1 产物过短（' + t.trim().length + ' 字符）');
  else passed.push('F1 非空（' + t.length + ' 字符）');

  if (/（待补）|（待填）|\(TODO\)|TODO:/i.test(t)) problems.push('F1 有未填的占位');
  else passed.push('F1 无占位残留');

  const headings = (t.match(/^#{1,4}\s+\S/gm) || []).length;
  ev.headings = headings;
  if (headings < 2) problems.push('F1 结构太简单（' + headings + ' 个标题）');
  else passed.push('F1 有 ' + headings + ' 个标题分节');

  // ══ F2 / F3：逐条判「问题」 ══
  //   找「问题 1：」「- 问题:」「## 问题」等段落
  const issueBlocks = [...t.matchAll(/^[\s\-*]*(?:\*{0,2})(?:问题\s*\d*|症状|问题描述)(?:\*{0,2})\s*[:：]\s*(.+)$/gm)].map((m) => m[1]);
  ev.issues = issueBlocks.length;

  if (issueBlocks.length === 0) {
    problems.push('F2 找不到「问题」条目 —— 界面改动必须逐条列出具体问题');
  } else {
    let bad = 0;
    for (const b of issueBlocks) {
      const j = judgeIssue(b);
      if (!j.ok) { problems.push('F2/F3 ' + j.why); bad++; }
    }
    if (!bad) passed.push('F2/F3 ' + issueBlocks.length + ' 条问题都可判定');
  }

  // ══ F4 全文不得有空洞评价词（在没有可测值的句子里） ══
  {
    let bad = 0;
    for (const w of VAGUE_WORDS) {
      if (!t.includes(w)) continue;
      // 找含这个词的那一行
      for (const line of t.split(/\r?\n/)) {
        if (!line.includes(w)) continue;
        if (!MEASURABLE.test(line)) {
          problems.push('F4 含空词「' + w + '」且无可测值：' + line.trim().slice(0, 40));
          bad++;
          break;
        }
      }
    }
    if (!bad) passed.push('F4 无空洞评价词');
  }

  // ══ F5 截图证据 ══
  {
    const imgs = [...t.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    ev.images = imgs.length;
    // ⚠ 只认「改前/改后」这种**显式标签**，不能认文件名里的 before/after
    //   （第一版用 /before|after/ 会被 ../shots/before.png 这种路径误判成已标注）
    const hasBefore = /改前[:：]|之前[:：]|^[^\n]*改前\s*$/m.test(t);
    const hasAfter = /改后[:：]|之后[:：]|^[^\n]*改后\s*$/m.test(t);
    if (imgs.length === 0) {
      problems.push('F5 没有任何截图引用 —— 界面改动必须贴改前改后对比图');
    } else if (!hasBefore || !hasAfter) {
      problems.push('F5 有截图但没标清「改前 / 改后」（只有 ' + imgs.length + ' 张）');
    } else {
      passed.push('F5 有截图且标了改前改后（' + imgs.length + ' 张）');
    }
  }

  // ══ F6 落点可核查 ══
  {
    const paths = [...new Set([...t.matchAll(/(workbench[\/\\][^\s|`"'）)]+\.\w{2,4})/g)].map((m) => m[1]))];
    ev.paths = paths.length;
    if (paths.length) {
      let miss = 0;
      for (const p of paths) {
        const abs = path.join(path.dirname(PROJECT_ROOT), p.replace(/\\/g, '/'));
        if (!fs.existsSync(abs)) { problems.push('F6 落点文件不存在：' + p); miss++; }
      }
      if (!miss) passed.push('F6 ' + paths.length + ' 个落点都存在');
    } else {
      passed.push('F6 未引用具体文件（跳过）');
    }
  }

  return { ok: problems.length === 0, problems, passed, evidence: ev };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(66));
  console.log('  前端工坊 · check 自测');
  console.log('═'.repeat(66));
  console.log();

  const GOOD = `# 界面改法单 · AI 面板割裂

## 一、问题

- 问题 1: AI 面板底色 #FFFFFF，与外壳 #0E1114 对比度 21:1，视觉跳断
- 问题 2: 面板间距 4px，低于 hermes 的 8px 基准
- 问题 3: 副标题字号 10px，低于正文 13px 的可读下限

## 二、改法

- 改动文件: workbench/外壳/ui/styles/tokens-hermes.css
- 具体: 统一到 hermes 色板

## 三、验证

改前：![改前](../shots/before.png)
改后：![改后](../shots/after.png)
`;

  console.log('【一】合格产物必须通过');
  {
    const r = check(GOOD);
    chk('完整改法单 → 通过', r.ok === true, r.problems.join(' | ') || 'ok');
    chk('识别出 3 条问题', r.evidence.issues === 3, String(r.evidence.issues));
    chk('识别出 2 张截图', r.evidence.images === 2, String(r.evidence.images));
  }

  console.log();
  console.log('【二】★F2：不许只说「丑」');
  {
    const ugly = GOOD.replace('- 问题 1: AI 面板底色 #FFFFFF，与外壳 #0E1114 对比度 21:1，视觉跳断', '- 问题 1: 这个界面好丑');
    const r = check(ugly);
    chk('反例：「好丑」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.includes('好丑')) || '').slice(0, 60));

    chk('对照：带数值的问题通过', judgeIssue('AI 面板底色 #FFFFFF，对比度 21:1').ok === true);
    chk('反例：纯形容词 → 失败', judgeIssue('界面很难看').ok === false);
  }

  console.log();
  console.log('【三】★F4：不用空词');
  {
    const vague = GOOD + '\n整体感觉更美观大方了\n';
    const r = check(vague);
    chk('反例：「美观大方」且无数值 → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('F4')) || '').slice(0, 60));
  }

  console.log();
  console.log('【四】★F5：必须有截图，且标改前改后');
  {
    const noImg = GOOD.replace(/改前：!\[[^\]]*\]\([^)]+\)\n改后：!\[[^\]]*\]\([^)]+\)/, '看起来好多了');
    const r = check(noImg);
    chk('反例：没截图 → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('F5')) || '').slice(0, 50));

    const noLabel = GOOD.replace('改前：', '').replace('改后：', '');
    const r2 = check(noLabel);
    chk('反例：有图但没标改前改后 → 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.startsWith('F5')) || '').slice(0, 50));
  }

  console.log();
  console.log('【五】F6 落点 / 关键：必须会失败');
  {
    const badPath = GOOD.replace('workbench/外壳/ui/styles/tokens-hermes.css', 'workbench/不存在/x.css');
    chk('反例：落点不存在 → 失败', check(badPath).ok === false);

    const bads = [
      GOOD.replace('- 问题 1: AI 面板底色 #FFFFFF，与外壳 #0E1114 对比度 21:1，视觉跳断', '- 问题 1: 太丑了'),
      GOOD.replace(/改前：!\[[^\]]*\]\([^)]+\)\n改后：!\[[^\]]*\]\([^)]+\)/, ''),
      '',
      '随便一段'.repeat(20),
    ];
    const failed = bads.filter((b) => !check(b).ok).length;
    chk('4 个坏样本全部被判失败', failed === 4, failed + ' / 4');
  }

  console.log();
  console.log('─'.repeat(66));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(66));
  return passed === R.length;
}

// ══════════════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.log('用法: node check.mjs --selftest | --check <产物.md>'); process.exit(2); }
  if (!fs.existsSync(file)) { console.log('文件不存在: ' + file); process.exit(2); }
  const r = check(fs.readFileSync(file, 'utf8'));
  if (argv.includes('--json')) console.log(JSON.stringify({ scene: SCENE_NAME, ...r }, null, 2));
  else {
    console.log('═'.repeat(66));
    console.log('  ' + SCENE_NAME + ' · 产物验收');
    console.log('═'.repeat(66));
    console.log('  ' + (r.ok ? '✓ 合格' : '✗ 不合格'));
    for (const p of r.problems) console.log('  ⛔ ' + p);
    for (const p of r.passed) console.log('  ✓ ' + p);
  }
  process.exit(r.ok ? 0 : 1);
}
