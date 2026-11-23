#!/usr/bin/env node
// 数据/.dsh/skills/tool-forge/check.mjs —— 「工具工坊」的可执行验收
//
// ══════════════════════════════════════════════════════════════════════
//  这个场景负责什么
// ══════════════════════════════════════════════════════════════════════
//  工具层的自我进化载体 —— 从缺口反推需要什么工具、写出来、自测、注册进体检、淘汰失效的、记账。
//
//  这个项目的铁律与工具直接相关：
//    「如果一个检查永远通过，它就不是检查，是装饰」
//    「自测通过 ≠ 真的在跑」
//    「一个永远红的检查也是装饰」
//
// ──────────────────────────────────────────────────────────────────────
//  七项检查（T1-T7）
// ──────────────────────────────────────────────────────────────────────
//    T1 通用底线        非空 / 无占位 / ≥2 标题
//    T2 缺口可证         ★ 新工具必须证明「缺口是真的」，不能凭想象
//    T3 自测有反例       ★ 自测必须含「必须失败」的反例，否则是装饰
//    T4 注册真实模式     ★ 注册进体检必须用只读参数（不是只跑 --selftest）
//    T5 工具文件存在     提到的工具 .mjs 必须真实存在且语法正确
//    T6 有淘汰机制       必须说明「什么情况下该删掉这个工具」
//    T7 记账             必须在进化账本/机制清单里留痕
//
//  依据：这个项目历史上最贵的教训是「28 个检查只跑 selftest」——
//  自测全绿但真实数据坏了一律不报。T3/T4 就是堵这个。
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const SCENE_NAME = '工具工坊';

export const LIMITS = { MIN_LENGTH: 50 };

/** T4：只读参数（注册进体检必须用这些，不能只 --selftest） */
export const READONLY_ARGS = ['--check', '--list', '--scan', '--status', '--audit', '--verify', '--health', '--json'];

/**
 * T2：判「缺口」是否被证明
 *
 * 好：「机制体检 104 项里没有一项检查模型连通性，实测两边都挂时无人报」
 * 坏：「应该加一个检查」
 */
export function judgeGap(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: '缺口描述为空' };
  // 必须提到现有状态（有数字/有文件名/有实测）
  const hasEvidence = /\d/.test(t) || /\.mjs|\.json|机制体检|体检项|实测/.test(t);
  if (!hasEvidence) return { ok: false, why: '缺口没被证明（既无数字也无现存文件引用）：' + t.slice(0, 30) };
  return { ok: true, why: '' };
}

/**
 * T3：判「自测」是否含反例
 * @param {string} toolPath
 */
export function judgeSelftest(toolPath) {
  if (!fs.existsSync(toolPath)) return { ok: false, why: '工具文件不存在：' + toolPath };
  const c = fs.readFileSync(toolPath, 'utf8');
  const hasSelftest = /--selftest|function selftest/.test(c);
  if (!hasSelftest) return { ok: false, why: '工具没有自测' };
  // 反例标志
  const hasNeg = /反例|必须失败|should fail|expected.*fail/i.test(c);
  const hasChkFalse = /chk\([^)]*false|ok === false|\.ok === false/.test(c);
  if (!hasNeg && !hasChkFalse) {
    return { ok: false, why: '自测里没有反例（全是正例 = 装饰）' };
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

  // ══ T1 通用底线 ══
  if (t.trim().length < LIMITS.MIN_LENGTH) problems.push('T1 产物过短（' + t.trim().length + ' 字符）');
  else passed.push('T1 非空（' + t.length + ' 字符）');

  if (/（待补）|（待填）|\(TODO\)|TODO:/i.test(t)) problems.push('T1 有未填的占位');
  else passed.push('T1 无占位残留');

  const headings = (t.match(/^#{1,4}\s+\S/gm) || []).length;
  ev.headings = headings;
  if (headings < 2) problems.push('T1 结构太简单（' + headings + ' 个标题）');
  else passed.push('T1 有 ' + headings + ' 个标题分节');

  // ══ T2 缺口可证 ══
  {
    // ⚠ 正则要排除表格分隔行（|---|---| 里的 - 会被 [\s\-*]* 吃掉）
    //   第一版 /^[\s\-*]*(?:\*{0,2})(?:缺口|...)/ 会匹配到 `- 缺口:` 但也可能
    //   匹配到别的行首短横。加「行首必须是 - 或 * 或 空」且后面紧跟关键字的约束。
    const gap = [...t.matchAll(/^\s*(?:[-*]\s+)?\*{0,2}(?:缺口|为什么需要|要解决)\*{0,2}\s*[:：]\s*(.+)$/gm)]
      .map((m) => m[1].trim())
      .filter((x) => x && !/^[-:|\s]+$/.test(x));
    ev.gaps = gap.length;
    if (gap.length === 0) {
      problems.push('T2 没有「缺口:」字段 —— 新工具必须证明缺口是真的');
    } else {
      let bad = 0;
      for (const g of gap) {
        const j = judgeGap(g);
        if (!j.ok) { problems.push('T2 ' + j.why); bad++; }
      }
      if (!bad) passed.push('T2 ' + gap.length + ' 条缺口都有证据');
    }
  }

  // ══ T3 / T5：工具文件存在 + 自测有反例 ══
  {
    const tools = [...new Set([...t.matchAll(/(workbench[\/\\]工具[\/\\][^\s|`"'）)]+\.mjs)/g)].map((m) => m[1]))];
    ev.tools = tools.length;
    if (tools.length === 0) {
      problems.push('T5 没有提到工具文件路径 —— 工具工坊的产物必须指向具体 .mjs');
    } else {
      let bad = 0;
      for (const tp of tools) {
        const abs = path.join(path.dirname(PROJECT_ROOT), tp.replace(/\\/g, '/'));
        if (!fs.existsSync(abs)) { problems.push('T5 工具不存在：' + tp); bad++; continue; }
        const j = judgeSelftest(abs);
        if (!j.ok) { problems.push('T3 ' + path.basename(tp) + '：' + j.why); bad++; }
      }
      if (!bad) passed.push('T3/T5 ' + tools.length + ' 个工具都存在且自测含反例');
    }
  }

  // ══ T4 注册用只读参数 ══
  {
    // 找「注册」相关的行
    const regLines = t.split(/\r?\n/).filter((l) => /注册|接入|进机制体检|加进体检/.test(l));
    ev.regLines = regLines.length;
    if (regLines.length === 0) {
      problems.push('T4 没写「怎么注册进机制体检」');
    } else {
      const hasReadonly = READONLY_ARGS.some((a) => t.includes(a));
      // 如果只提了 --selftest 而没提只读参数 → 不合格
      const onlySelftest = /--selftest/.test(t) && !hasReadonly;
      if (onlySelftest) {
        problems.push('T4 只注册了 --selftest —— 必须用只读参数（' + READONLY_ARGS.slice(0, 4).join('/') + ' 等）');
      } else if (!hasReadonly) {
        problems.push('T4 没写注册时用哪个参数（必须有 ' + READONLY_ARGS.slice(0, 4).join('/') + ' 之一）');
      } else {
        passed.push('T4 注册用了只读参数');
      }
    }
  }

  // ══ T6 有淘汰机制 ══
  {
    const hasRetire = /淘汰|删掉|下线|废弃|退场|什么情况下.*(删|退役)/.test(t);
    if (!hasRetire) problems.push('T6 没写「什么情况下该淘汰这个工具」');
    else passed.push('T6 写了淘汰条件');
  }

  // ══ T7 记账 ══
  {
    const hasLedger = /进化账本|机制清单|台账|留痕|记录到/.test(t);
    if (!hasLedger) problems.push('T7 没写「在哪里记账」（进化账本 / 机制清单）');
    else passed.push('T7 有记账位置');
  }

  return { ok: problems.length === 0, problems, passed, evidence: ev };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(66));
  console.log('  工具工坊 · check 自测');
  console.log('═'.repeat(66));
  console.log();

  const GOOD = `# 新工具提案 · 模型健康

## 一、缺口

- 缺口: 机制体检 104 项里没有一项检查模型连通性，实测两个 provider 全挂时无人报
- 为什么现在没有: 之前的检查都是文件级静态检查

## 二、工具

- 文件: workbench/工具/机制体检.mjs
- 职责: 秒级检查所有 provider 能不能用

## 三、自测

含 12 条自测，其中 4 条反例（连不上 / 401 / 402 / 500 都必须判不可用）

## 四、注册

注册进机制体检，用 --status 只读模式（不是只跑 --selftest）

## 五、淘汰条件

如果引擎改成内置健康检查端点，这个工具就该删掉

## 六、记账

记到机制清单（机制审计会扫）和进化账本
`;

  console.log('【一】合格产物必须通过');
  {
    const r = check(GOOD);
    chk('完整工具提案 → 通过', r.ok === true, r.problems.join(' | ') || 'ok');
    chk('识别出 1 条缺口', r.evidence.gaps === 1, String(r.evidence.gaps));
    chk('识别出 1 个工具', r.evidence.tools === 1, String(r.evidence.tools));
  }

  console.log();
  console.log('【二】★T2：缺口必须被证明');
  {
    const vague = GOOD.replace('机制体检 104 项里没有一项检查模型连通性，实测两个 provider 全挂时无人报', '应该加一个检查');
    const r = check(vague);
    chk('反例：「应该加一个检查」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('T2')) || '').slice(0, 60));

    chk('对照：带数字的缺口通过', judgeGap('机制体检 104 项里没有一项查模型').ok === true);
    chk('反例：无证据 → 失败', judgeGap('应该加个检查').ok === false);
  }

  console.log();
  console.log('【三】★T3：自测必须有反例');
  {
    // 机制体检 确实有反例，应该通过
    // ⚠ 路径：PROJECT_ROOT 是 workbench/，所以直接拼「工具/...」即可。
    //   （不能再用 dirname，否则会跳出去一层 —— 第一版就是这里错的）
    const realTool = path.join(PROJECT_ROOT, '工具', '机制体检.mjs');
    const j = judgeSelftest(realTool);
    chk('真实的机制体检.mjs 自测含反例', j.ok === true, j.why || 'ok');

    // 造一个只有正例的假工具
    const tmp = path.join(process.env.TEMP || '/tmp', 'no-neg-' + Date.now() + '.mjs');
    fs.writeFileSync(tmp, 'function selftest(){ const a = chk("a", true); return a }\n', 'utf8');
    const j2 = judgeSelftest(tmp);
    chk('反例：自测全正例 → 必须失败', j2.ok === false, j2.why);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }

  console.log();
  console.log('【四】★T4：注册必须用只读参数');
  {
    const onlySelf = GOOD.replace('用 --status 只读模式（不是只跑 --selftest）', '只跑 --selftest');
    const r = check(onlySelf);
    chk('反例：只注册 --selftest → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('T4')) || '').slice(0, 60));
  }

  console.log();
  console.log('【五】T5/T6/T7');
  {
    const badTool = GOOD.replace('workbench/工具/机制体检.mjs', 'workbench/工具/不存在.mjs');
    chk('反例：工具不存在 → 失败', check(badTool).ok === false);

    const noRetire = GOOD.replace('## 五、淘汰条件\n\n如果引擎改成内置健康检查端点，这个工具就该删掉\n', '');
    chk('反例：没写淘汰条件 → 失败', check(noRetire).ok === false);

    const noLedger = GOOD.replace('记到机制清单（机制审计会扫）和进化账本', '');
    chk('反例：没写记账 → 失败', check(noLedger).ok === false);
  }

  console.log();
  console.log('【六】关键：这个 check 必须会失败');
  {
    const bads = [
      GOOD.replace('机制体检 104 项里没有一项检查模型连通性，实测两个 provider 全挂时无人报', '应该加一个检查'),
      GOOD.replace('用 --status 只读模式（不是只跑 --selftest）', '只跑 --selftest'),
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
