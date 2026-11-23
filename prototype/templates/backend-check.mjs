#!/usr/bin/env node
// 数据/.dsh/skills/backend-craft/check.mjs —— 「后端工坊」的可执行验收
//
// ══════════════════════════════════════════════════════════════════════
//  这个场景负责什么
// ══════════════════════════════════════════════════════════════════════
//  后端正确性与性能的唯一对口人。
//  产出三类：后端改法单 / 接口契约 / 性能证据。
//
// ──────────────────────────────────────────────────────────────────────
//  五项检查（B1-B5）
// ──────────────────────────────────────────────────────────────────────
//    B1 通用底线      非空 / 无占位 / ≥2 标题
//    B2 错误条件可判定  ★「什么条件下会坏」必须写成可执行判据，不能写「可能有问题」
//    B3 性能证据有数字  ★ 说「变快了」必须有改前/改后数字 + 单位
//    B4 接口契约完整    契约必须含：输入 / 输出 / 错误码 / 幂等性
//    B5 落点可核查      提到的文件路径必须真实存在
//
//  设计依据：后端最常见的两种空话——
//    「这个接口可能有性能问题」（没说在什么条件下）
//    「优化后快了很多」（没有数字）
//  这两条对应 B2 / B3，是本 check 的核心。
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const SCENE_NAME = '后端工坊';

export const LIMITS = { MIN_LENGTH: 50 };

/** 不可判定的模糊说法（B2 会拒） */
export const VAGUE_CONDITIONS = ['可能有性能问题', '可能存在隐患', '可能有问题', '性能不太好', '感觉慢', '有点问题', '需要优化'];

/** B2：判一个「错误条件」是否可判定 */
export function judgeCondition(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: '错误条件为空' };
  for (const v of VAGUE_CONDITIONS) {
    if (t.includes(v) && !/\d/.test(t)) {
      return { ok: false, why: '错误条件不可判定（"' + v + '" 且没有具体数字）：' + t.slice(0, 30) };
    }
  }
  // 可判定的标志：有数字阈值、有具体条件词、有复现步骤
  const ok = /\d/.test(t) || /当|如果|一旦|超过|低于|大于|等于|并发|并发数|QPS|TPS|超时|重试/.test(t);
  return { ok, why: ok ? '' : '错误条件没有可执行判据（既无数字也无条件词）：' + t.slice(0, 30) };
}

/** B3：判性能证据是否有数字 */
export function judgePerf(text) {
  const t = String(text || '');
  if (!t.trim()) return { ok: false, why: '没有性能证据' };
  // 必须有数字 + 单位
  const hasNum = /\d/.test(t);
  const hasUnit = /(ms|毫秒|s|秒|QPS|TPS|MB|GB|KB|%|倍|次\/秒|req\/s)/i.test(t);
  if (!hasNum || !hasUnit) return { ok: false, why: '性能证据缺数字或单位（要「改前 X ms → 改后 Y ms」）' };
  // 要有前后对比
  const hasCompare = /改前|改后|之前|之后|before|after|→|->/.test(t);
  if (!hasCompare) return { ok: false, why: '性能证据只有绝对值，没有改前/改后对比' };
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

  // ══ B1 通用底线 ══
  if (t.trim().length < LIMITS.MIN_LENGTH) problems.push('B1 产物过短（' + t.trim().length + ' 字符）');
  else passed.push('B1 非空（' + t.length + ' 字符）');

  if (/（待补）|（待填）|\(TODO\)|TODO:/i.test(t)) problems.push('B1 有未填的占位');
  else passed.push('B1 无占位残留');

  const headings = (t.match(/^#{1,4}\s+\S/gm) || []).length;
  ev.headings = headings;
  if (headings < 2) problems.push('B1 结构太简单（' + headings + ' 个标题）');
  else passed.push('B1 有 ' + headings + ' 个标题分节');

  // ══ B2 错误条件可判定 ══
  //   找所有「条件:」/「错误条件:」/「会坏在:」字段
  const conds = [...t.matchAll(/^[\s\-*]*(?:\*{0,2})(?:条件|错误条件|会坏在|触发条件|失败条件)(?:\*{0,2})\s*[:：]\s*(.+)$/gm)].map((m) => m[1]);
  ev.conditions = conds.length;
  if (conds.length === 0) {
    // 退一步：找「症状」段里有没有条件描述
    const hasAny = /什么条件下|什么时候会|在.{0,10}时(会|就)/.test(t);
    if (!hasAny) problems.push('B2 没有「错误条件」字段 —— 后端问题必须写清在什么条件下会坏');
    else passed.push('B2 有条件描述（但没有规整的「条件:」字段）');
  } else {
    let bad = 0;
    for (const c of conds) {
      const j = judgeCondition(c);
      if (!j.ok) { problems.push('B2 ' + j.why); bad++; }
    }
    if (!bad) passed.push('B2 ' + conds.length + ' 条错误条件都可判定');
  }

  // ══ B3 性能证据有数字 ══
  //   只在产物声称有性能改进时才要求
  const claimsPerf = /性能|快|慢|延迟|吞吐|QPS|TPS|耗时|变快|变慢|优化/.test(t);
  if (claimsPerf) {
    const perfSection = (t.match(/^#{1,4}\s*.*(性能|证据|压测|基准).*$[\s\S]{0,1200}/m) || [''])[0];
    const j = judgePerf(perfSection || t);
    ev.hasPerf = j.ok;
    if (!j.ok) problems.push('B3 ' + j.why);
    else passed.push('B3 性能证据有前后对比数字');
  } else {
    passed.push('B3 未涉及性能声称（跳过）');
  }

  // ══ B4 接口契约完整 ══
  const hasContract = /接口契约|契约|API|请求|响应/.test(t);
  if (hasContract && /接口契约/.test(t)) {
    const need = [
      { k: '输入', re: /输入|入参|request|参数/ },
      { k: '输出', re: /输出|出参|response|返回/ },
      { k: '错误码', re: /错误码|error.?code|状态码|4\d\d|5\d\d/ },
      { k: '幂等', re: /幂等|idempoten|重复调用/ },
    ];
    const miss = need.filter((n) => !n.re.test(t));
    if (miss.length) problems.push('B4 接口契约缺：' + miss.map((x) => x.k).join('/'));
    else passed.push('B4 接口契约完整（输入/输出/错误码/幂等）');
  } else {
    passed.push('B4 未涉及接口契约（跳过）');
  }

  // ══ B5 落点可核查 ══
  const paths = [...new Set([...t.matchAll(/(workbench[\/\\][^\s|`"'）)]+\.\w{2,4})/g)].map((m) => m[1]))];
  ev.paths = paths.length;
  if (paths.length) {
    let miss = 0;
    for (const p of paths) {
      const abs = path.join(path.dirname(PROJECT_ROOT), p.replace(/\\/g, '/'));
      if (!fs.existsSync(abs)) { problems.push('B5 落点文件不存在：' + p); miss++; }
    }
    if (!miss) passed.push('B5 ' + paths.length + ' 个落点都存在');
  } else {
    passed.push('B5 未引用具体文件（跳过）');
  }

  return { ok: problems.length === 0, problems, passed, evidence: ev };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(66));
  console.log('  后端工坊 · check 自测');
  console.log('═'.repeat(66));
  console.log();

  const GOOD = `# 后端改法单 · 会话列表

## 一、问题

- 条件: 当并发数超过 200 时，session/list 响应时间从 80ms 涨到 1.2s
- 症状: 前端加载会话列表转圈
- 根因: 每次请求都全表扫描 workspace 表

## 二、改法

- 改动文件: workbench/工具/机制体检.mjs
- 具体: 加索引 + 分页

## 三、性能证据

改前 1200 ms → 改后 95 ms（200 并发，压测 1000 次取 P95）
`;

  console.log('【一】合格产物必须通过');
  {
    const r = check(GOOD);
    chk('完整改法单 → 通过', r.ok === true, r.problems.join(' | ') || 'ok');
    chk('识别出 1 条条件', r.evidence.conditions === 1, String(r.evidence.conditions));
    chk('性能证据通过', r.evidence.hasPerf === true, '');
  }

  console.log();
  console.log('【二】★B2：错误条件必须可判定');
  {
    const vague = GOOD.replace('当并发数超过 200 时，session/list 响应时间从 80ms 涨到 1.2s', '可能有性能问题');
    const r = check(vague);
    chk('反例：「可能有性能问题」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('B2')) || '').slice(0, 60));

    chk('对照：有数字的条件通过', judgeCondition('当并发数超过 200 时延迟上涨').ok === true);
    chk('对照：有条件词但无数字也通过', judgeCondition('如果上游超时就会重试风暴').ok === true);
    chk('反例：纯形容词 → 失败', judgeCondition('性能不太好').ok === false);
  }

  console.log();
  console.log('【三】★B3：性能证据必须有数字+前后对比');
  {
    const noNum = GOOD.replace('改前 1200 ms → 改后 95 ms（200 并发，压测 1000 次取 P95）', '优化后快了很多');
    const r = check(noNum);
    chk('反例：「快了很多」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('B3')) || '').slice(0, 60));

    const noCompare = GOOD.replace('改前 1200 ms → 改后 95 ms', '现在 95 ms');
    const r2 = check(noCompare);
    chk('反例：只有绝对值没对比 → 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.startsWith('B3')) || '').slice(0, 60));

    chk('对照：合法性能证据通过', judgePerf('改前 1200 ms → 改后 95 ms').ok === true);
  }

  console.log();
  console.log('【四】B4 接口契约 / B5 落点');
  {
    const badTarget = GOOD.replace('workbench/工具/机制体检.mjs', 'workbench/不存在/假文件.mjs');
    const r = check(badTarget);
    chk('反例：落点不存在 → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('B5')) || '').slice(0, 60));

    const incomplete = GOOD + '\n## 四、接口契约\n\n只有一段描述\n';
    const r2 = check(incomplete);
    chk('反例：接口契约缺输入/输出/错误码/幂等 → 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.startsWith('B4')) || '').slice(0, 60));
  }

  console.log();
  console.log('【五】关键：这个 check 必须会失败');
  {
    const bads = [
      GOOD.replace('当并发数超过 200 时，session/list 响应时间从 80ms 涨到 1.2s', '性能不太好'),
      GOOD.replace('改前 1200 ms → 改后 95 ms（200 并发，压测 1000 次取 P95）', '快了很多'),
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
