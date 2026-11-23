#!/usr/bin/env node
// 工具/派单验证生成.mjs —— 从管线契约 + 场景职责生成可验证的 verify
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（发现的断层）
// ══════════════════════════════════════════════════════════════════════
//  派单的四件套里，verify 是最容易写虚的：
//
//    实测台账 32 条派单，verify 全是流程性的：
//      「台账里出现这条记录」
//      「场景的真实回复」
//      「派单台账里该单 state=closed」
//
//    **没有一条说「产出哪个文件、文件里要有什么」。**
//
//  为什么这是问题：
//    · 中枢代写.mjs 的回执校验（断点7）要「回复对得上 verify」
//    · 如果 verify 是「台账里有这条记录」，那任何回复都算对得上
//    · 也就是说：verify 写虚了，回执校验就形同虚设
//
//  正确做法：verify 必须能从「管线产物契约」推出来：
//    · 产物文件是什么（files）
//    · 该文件要满足什么（行数/章节/关键词）
//
//  这个工具就是做这件事。
//
// ══════════════════════════════════════════════════════════════════════
//  用法
// ══════════════════════════════════════════════════════════════════════
//    node 工具/派单验证生成.mjs --scene 竞品拆解
//    node 工具/派单验证生成.mjs --scene 竞品拆解 --task "拆解竞品功能矩阵"
//    node 工具/派单验证生成.mjs --artifact feature-matrix
//    node 工具/派单验证生成.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const CONTRACT_FILE = path.join(DATA, '产物契约.json');
const SKILLS = path.join(DATA, 'skills');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

const SCENE_ID = {
  '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
  '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
  '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
};

/** 每条 artifact 的「合格判据」——不是随便写的，是对应场景的标准 */
const QUALITY = {
  'competitor-list': { minLines: 0, minBytes: 1500, requireSections: ['##'], hint: '至少 1.5KB，有分节' },
  'tech-candidates': { minLines: 0, minBytes: 1500, requireSections: ['##'], hint: '至少 1.5KB，有分节' },
  'reference-index': { minLines: 0, minBytes: 2000, requireSections: ['##'], hint: '至少 2KB，带来源' },
  'feature-matrix': { minTableRows: 8, minBytes: 1500, hint: '表格至少 8 行，每行指到具体文件' },
  'impl-details': { minBytes: 2000, requireSections: ['##'], hint: '至少 2KB，每条结论带代码证据' },
  'reusable-patterns': { minBytes: 800, hint: '写明可复用模式' },
  'architecture-plan': { minBytes: 2000, requireSections: ['##'], hint: '至少 2KB，含取舍理由' },
  'risk-list': { minBytes: 500, hint: '列出风险与代价' },
};

function loadContract() {
  try {
    if (!fs.existsSync(CONTRACT_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return j.artifacts || j;
  } catch { return null; }
}

function fileStat(sceneCn, name) {
  const p = path.join(MEM, sceneCn, name);
  try {
    const st = fs.statSync(p);
    const text = fs.readFileSync(p, 'utf8');
    return {
      exists: true,
      bytes: st.size,
      lines: text.split('\n').length,
      sections: (text.match(/^#{2,3}\s+/gm) || []).length,
      tableRows: (text.match(/^\|.+\|$/gm) || []).length,
    };
  } catch {
    return { exists: false, bytes: 0, lines: 0, sections: 0, tableRows: 0 };
  }
}

/**
 * 给一个 artifact 生成 verify 文本
 * @returns {{ verify: string, checks: string[] }}
 */
export function buildVerify(artifact, entry) {
  const files = (entry && entry.files) || [];
  const sceneCn = entry && entry.sceneCn || '';
  const q = QUALITY[artifact] || {};

  if (!files.length) {
    return {
      verify: '⚠ 契约表未定义产出文件，无法生成 verify',
      checks: [],
    };
  }

  const checks = [];
  const fileList = files.map((f) => '`' + f + '`').join(' / ');
  checks.push('文件存在: ' + fileList);

  if (q.minBytes) checks.push('总大小 >= ' + q.minBytes + ' B');
  if (q.minTableRows) checks.push('表格行数 >= ' + q.minTableRows);
  if (q.requireSections && q.requireSections.length) checks.push('含至少 1 个二级标题');

  const verify = '产出 ' + fileList +
    (checks.length > 1 ? '，且' + checks.slice(1).join('、') : '') +
    (q.hint ? '（' + q.hint + '）' : '');

  return { verify, checks };
}

/** 检查某场景的产出是否达标 */
export function checkArtifact(artifact, entry) {
  const files = (entry && entry.files) || [];
  const sceneCn = entry && entry.sceneCn || '';
  const q = QUALITY[artifact] || {};

  const results = files.map((f) => {
    const st = fileStat(sceneCn, f);
    const problems = [];
    if (!st.exists) problems.push('文件不存在');
    else {
      if (q.minBytes && st.bytes < q.minBytes) problems.push('大小 ' + st.bytes + ' < ' + q.minBytes);
      if (q.minTableRows && st.tableRows < q.minTableRows) problems.push('表格行 ' + st.tableRows + ' < ' + q.minTableRows);
      if (q.requireSections && st.sections < q.requireSections.length) problems.push('二级标题 ' + st.sections + ' < ' + q.requireSections.length);
    }
    return { file: f, ...st, problems, ok: problems.length === 0 };
  });

  return { files: results, ok: results.every((r) => r.ok) };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  派单验证生成 · 自测');
  console.log('='.repeat(72));
  console.log();

  const contract = loadContract();

  console.log('【一】契约表');
  chk('契约表可读', !!contract);
  chk('契约非空', contract && Object.keys(contract).length > 0,
    contract ? Object.keys(contract).length + ' 个' : '0');

  console.log();
  console.log('【二】verify 生成');
  {
    const r = buildVerify('feature-matrix', contract['feature-matrix']);
    chk('能生成 verify', typeof r.verify === 'string' && r.verify.length > 10);
    chk('verify 含具体文件名', r.verify.includes('项目功能矩阵.md'), r.verify.slice(0, 60));
    chk('verify 含量化判据', />=|至少/.test(r.verify), r.verify.slice(0, 80));
    chk('checks 数组非空', r.checks.length > 1, r.checks.length + ' 条');
  }

  console.log();
  console.log('【三】反例：契约缺失时必须明确报出来，不能编一个');
  {
    const r = buildVerify('__nonexistent__', null);
    chk('反例：无契约时 verify 明确报缺', r.verify.includes('未定义'), r.verify);
    chk('反例：checks 为空', r.checks.length === 0);
  }

  console.log();
  console.log('【四】实际产出检查');
  {
    const c = checkArtifact('feature-matrix', contract['feature-matrix']);
    chk('能检查实际文件', Array.isArray(c.files) && c.files.length > 0, c.files.length + ' 个文件');
    chk('检查结果含 ok 字段', typeof c.ok === 'boolean', String(c.ok));
  }

  console.log();
  console.log('【五】反例：不存在的文件必须判不过');
  {
    const fake = { sceneCn: '调研', files: ['__绝对不存在的文件__.md'] };
    const c = checkArtifact('reference-index', fake);
    chk('反例：不存在的文件判不过', c.ok === false, String(c.ok));
    chk('反例：给出问题原因', c.files[0].problems.length > 0, c.files[0].problems.join(','));
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

  const contract = loadContract();
  if (!contract) { console.log('✗ 产物契约.json 不存在'); process.exit(2); }

  const scene = val('scene', null);
  const artifact = val('artifact', null);

  console.log('='.repeat(78));
  console.log('  派单验证生成 —— 从管线契约推出可验证的 verify');
  console.log('='.repeat(78));
  console.log();

  if (artifact) {
    const entry = contract[artifact];
    if (!entry) { console.log('  ✗ 契约表里没有: ' + artifact); process.exit(2); }
    const v = buildVerify(artifact, entry);
    const c = checkArtifact(artifact, entry);
    console.log('  artifact: ' + artifact + '（' + entry.sceneCn + '）');
    console.log();
    console.log('  建议 verify:');
    console.log('    ' + v.verify);
    console.log();
    console.log('  当前产出状态:');
    for (const f of c.files) {
      console.log('    ' + (f.ok ? '✓' : '✗') + ' ' + f.file +
        '  ' + f.bytes + 'B  ' + f.lines + ' 行  ' + f.sections + ' 节  ' + f.tableRows + ' 表格行');
      if (f.problems.length) console.log('        ' + f.problems.join(', '));
    }
    console.log();
    console.log('  合计: ' + (c.ok ? '✓ 达标' : '✗ 未达标'));
    return;
  }

  if (scene) {
    // 找该场景负责的 artifact
    const owned = Object.entries(contract).filter(([, e]) => e.sceneCn === scene || e.scene === scene || e.scene === SCENE_ID[scene]);
    if (!owned.length) {
      console.log('  ' + scene + ' 不负责任何管线的产物契约（可能是管线末端或独立场景）');
      console.log();
      console.log('  所有 artifact 清单:');
      for (const [a, e] of Object.entries(contract)) {
        console.log('    ' + a.padEnd(22) + '（' + e.sceneCn + '）');
      }
      return;
    }

    console.log('  ' + scene + ' 负责 ' + owned.length + ' 个产物:');
    console.log();
    for (const [a, e] of owned) {
      const v = buildVerify(a, e);
      const c = checkArtifact(a, e);
      console.log('  ── ' + a + ' ──');
      console.log('    建议 verify:');
      console.log('      ' + v.verify);
      console.log('    当前: ' + (c.ok ? '✓ 达标' : '✗ 未达标'));
      for (const f of c.files) {
        if (!f.ok) console.log('      ✗ ' + f.file + ': ' + f.problems.join(', '));
      }
      console.log();
    }
    return;
  }

  // 无参数：列出全部
  console.log('  全部 artifact 的 verify 建议：');
  console.log();
  let okN = 0;
  for (const [a, e] of Object.entries(contract)) {
    const v = buildVerify(a, e);
    const c = checkArtifact(a, e);
    if (c.ok) okN++;
    console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + a.padEnd(22) + '（' + e.sceneCn + '）');
    console.log('      ' + v.verify);
  }
  console.log();
  console.log('-'.repeat(78));
  console.log('  达标: ' + okN + ' / ' + Object.keys(contract).length);

  // ⚠ 2026-11-12 加：检查「所有有 outputs 的场景都能生成 verify」
  //
  //   为什么加：契约表达标 ≠ 每个场景都能派单。
  //   实测发现：实施计划是管线末端（调研→竞品→逆向→架构→实施计划），
  //   它的场景契约里定义了 outputs: [milestones]，
  //   但产物契约表里**没有 milestones** → 中枢派单给它时生成不了量化 verify，
  //   只能写「做完就行」。
  //
  //   这是管线设计的真实缺口：契约两层不闭合。
  const SCEN_DIR = path.join(WB, 'sceneboard', 'scenes');
  const noVerify = [];
  if (fs.existsSync(SCEN_DIR)) {
    for (const f of fs.readdirSync(SCEN_DIR).filter((x) => x.endsWith('.json'))) {
      let sj;
      try { sj = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
      const outs = Array.isArray(sj.outputs) ? sj.outputs : [];
      if (!outs.length) continue;   // 无产出的场景不需要 verify
      // 它的任一 output 在契约表里有定义就算能生成
      const covered = outs.some((o) => {
        const id = o.id || o.name;
        return id && contract[id];
      });
      if (!covered) {
        noVerify.push({
          scene: sj.name || sj.id,
          outputs: outs.map((o) => o.id || o.name),
        });
      }
    }
  }

  console.log();
  if (noVerify.length) {
    console.log('  ⚠ 这些场景有 outputs 但产物契约表里一个都没有 → 派单时生成不了 verify：');
    for (const s of noVerify) {
      console.log('    · ' + s.scene + '  outputs=' + JSON.stringify(s.outputs));
    }
    console.log('    修法：往 数据/.dsh/产物契约.json 补对应 artifact');
    process.exitCode = 1;
  } else {
    console.log('  ✓ 所有有 outputs 的场景都能生成量化 verify');
  }

  // ⚠ 2026-11-12 修（破坏性验证抓出来的）：
  //   原来不管达标几个都 exit 0 —— 实测 7/8 仍然「成功」。
  //   检查工具不设 exitCode，机制体检就判不出失败 = 装饰。
  if (okN < Object.keys(contract).length) process.exitCode = 1;
}

main();
