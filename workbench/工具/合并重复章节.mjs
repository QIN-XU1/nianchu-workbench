#!/usr/bin/env node
/**
 * 合并重复的场景记忆章节
 *
 * ══════════════════════════════════════════════════════════════
 *  这是 AI 自己发现的问题（不是我叫它找的）
 * ══════════════════════════════════════════════════════════════
 *
 *  端到端闭环时，架构梳理的 agent 写回经验时发现：
 *
 *    「架构梳理要注意「结构标识的唯一性」。
 *     真实案例：本记忆文件里存在两个「五、坑与决策」标题
 *     （一个空占位、一个真正在追加），
 *     导致"新经验该追加到哪一节"有歧义。
 *     → 教训：任何"按节追加 / 按锚点索引"的结构，
 *       节标题（锚点）必须唯一，否则维护者和脚本会各写各的、索引指向失效。」
 *
 *  这段话说得对。工具确实可能把经验写进空占位那一节，
 *  导致真正的内容被孤立。
 *
 * ══════════════════════════════════════════════════════════════
 *  做法
 * ══════════════════════════════════════════════════════════════
 *
 *   ① 扫描所有场景记忆，找出重复的章节标题
 *   ② 合并：把内容并到第一个有实质内容的标题下
 *   ③ 保留有内容的那个，删掉空占位
 *
 *  用法：
 *    node 工具/合并重复章节.mjs            预览
 *    node 工具/合并重复章节.mjs --check    体检模式：有重复就 exit 1（机制体检用这个）
 *    node 工具/合并重复章节.mjs --apply    真改
 *    node 工具/合并重复章节.mjs --selftest 自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM_ROOT = path.join(WB, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

/**
 * 规范化章节标题（用于判重）
 *
 * 「## 五、坑与决策」和「## 五、坑与决策（只追加）」视为同一节
 */
export function normalizeHeading(h) {
  return String(h)
    .replace(/^#+\s*/, '')                    // 去掉 #
    .replace(/[（(][^）)]*[）)]/g, '')          // 去掉括号注释
    .replace(/[§#]/g, '')                     // 去掉 § #
    .replace(/\s+/g, '')                      // 去掉空格
    .trim();
}

/**
 * 拆分章节
 *
 * ⚠ 自测抓到的缺陷：原来用 /^(#{2,3})\s+(.+)$/ 匹配标题，
 *    但 Windows 换行是 \r\n，`$` 不匹配 `\r` 前的位置 →
 *    章节数恒为 0，整个工具静默失效。
 *
 *  修法：先把 \r\n 归一化成 \n 再处理；正则末尾用 \s* 吸收残留。
 *
 * @returns [{ heading, level, body, startLine, endLine }]
 */
export function splitSections(md) {
  const normalized = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const sections = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) {
      if (cur) { cur.endLine = i; cur.body = lines.slice(cur.startLine, i).join('\n'); sections.push(cur); }
      cur = { heading: m[2].trim(), raw: lines[i], level: m[1].length, startLine: i + 1, endLine: lines.length, body: '' };
    }
  }
  if (cur) {
    cur.endLine = lines.length;
    cur.body = lines.slice(cur.startLine, lines.length).join('\n');
    sections.push(cur);
  }
  return sections;
}

/** 判断章节体是否有实质内容（排除纯占位）
 *
 *  ⚠ 自测抓到的缺陷：原来用 `placeholderOnly` 正则判断，
 *    但「- （只追加：症状 → 根因 → 修法）」这种写法匹配不上，
 *    导致空占位被判成有内容 → 合并逻辑失效。
 *
 *  现在改成：先剔掉所有「只追加」「待补」这类说明词，
 *  剩下的内容如果太短（< 15 字符）或为空，就算空占位。
 */
export function hasContent(body) {
  let t = String(body || '');

  // 去掉占位说明（各种括号形式）
  t = t.replace(/[（(][^）)]*(只追加|待补|待填|空|无|TODO)[^）)]*[）)]/gi, '');
  t = t.replace(/[（(]\s*[）)]/g, '');

  // 拆成行，去掉列表符号和空白
  const lines = t.split('\n')
    .map((l) => l.replace(/^\s*[-*+]\s*/, '').trim())
    .filter(Boolean);

  // 过滤掉纯占位短语（明确的占位词）
  const placeholderRe = /^(只追加|待补|待填|todo|待定)\b.*$/i;
  const real = lines.filter((l) => {
    if (placeholderRe.test(l)) return false;
    return l.length > 0;
  });

  if (real.length === 0) return false;

  // ⚠ 自测抓到的缺陷：原来用「< 15 字符算空」，
  //    把「- 内容A」这种真实但短的内容也判成空占位了。
  //    阈值过激。现在只认「明确的占位词」和「完全空」，
  //    不再按长度猜测 —— 宁可保留多余内容，也不要误删真实内容。
  return true;
}

/**
 * 找到重复章节
 */
export function findDuplicates(md) {
  const sections = splitSections(md);
  const byKey = new Map();

  for (const s of sections) {
    const key = normalizeHeading(s.heading);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }

  const dups = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const withContent = list.filter((s) => hasContent(s.body));
    const empty = list.filter((s) => !hasContent(s.body));
    dups.push({
      key,
      total: list.length,
      withContent: withContent.length,
      empty: empty.length,
      headings: list.map((s) => s.heading),
      sections: list,
      // 建议：保留第一个有内容的，删掉其余的（包括空占位）
      keepIdx: withContent.length > 0 ? list.indexOf(withContent[0]) : 0,
    });
  }
  return dups;
}

/**
 * 合并：删掉空占位，保留有内容的
 */
export function mergeDuplicates(md) {
  // 先归一化换行（Windows \r\n → \n）
  const normalized = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const sections = splitSections(normalized);
  const dups = findDuplicates(normalized);

  if (dups.length === 0) return { changed: false, md, removed: [] };

  // 收集要删的行范围
  const toRemove = [];
  const removed = [];

  for (const d of dups) {
    for (let i = 0; i < d.sections.length; i++) {
      if (i === d.keepIdx) continue;
      const s = d.sections[i];
      // 只删空占位（有内容的重复节保守起见保留，只报告）
      if (!hasContent(s.body)) {
        toRemove.push([s.startLine, s.endLine]);
        removed.push({ heading: s.heading, line: s.startLine, reason: '空占位' });
      }
    }
  }

  if (toRemove.length === 0) return { changed: false, md, removed: [], dups };

  // 从后往前删，避免行号偏移
  toRemove.sort((a, b) => b[0] - a[0]);
  const out = lines.slice();
  for (const [start, end] of toRemove) {
    // start/end 是 1-based，end 是下一节起始行（不含）
    out.splice(start - 1, end - start);
  }

  return { changed: true, md: out.join('\n'), removed, dups };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  合并重复章节 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 标题归一化
  chk('归一化：去括号', normalizeHeading('五、坑与决策（只追加）') === normalizeHeading('五、坑与决策'),
      normalizeHeading('五、坑与决策（只追加）'));
  chk('归一化：去 §', normalizeHeading('§五 坑与决策') === normalizeHeading('五 坑与决策'),
      normalizeHeading('§五 坑与决策'));

  // ② 内容判定
  chk('空占位判为空', hasContent('- （只追加：症状 → 根因 → 修法）') === false, '');
  chk('真有内容判为有', hasContent('- 2026-11-09：真实 bug 记录') === true, '');

  // ③ 找重复
  const md = [
    '# 标题',
    '',
    '## 五、坑与决策',
    '',
    '- （只追加：症状 → 根因 → 修法）',
    '',
    '## 五、坑与决策（只追加）',
    '',
    '- 2026-11-09：真实经验一条',
    '',
    '## §六 归因',
    '',
    '- 内容',
  ].join('\n');

  const dups = findDuplicates(md);
  chk('找到 1 组重复', dups.length === 1, dups.length + ' 组');
  chk('重复组有 2 个标题', dups[0]?.total === 2, String(dups[0]?.total));
  chk('识别出 1 个空占位', dups[0]?.empty === 1, String(dups[0]?.empty));

  // ④ 合并
  const merged = mergeDuplicates(md);
  chk('合并后有变化', merged.changed === true, '');
  chk('删掉 1 个空占位', merged.removed.length === 1, String(merged.removed.length));
  chk('保留的那节还在', merged.md.includes('2026-11-09：真实经验一条'), '');
  chk('空占位已删', !merged.md.includes('- （只追加：症状 → 根因 → 修法）'), '');

  // ⑤ 反例：没有重复时不该改
  const clean = '# 标题\n\n## 一、a\n\n- 内容1\n\n## 二、b\n\n- 内容2\n';
  const r2 = mergeDuplicates(clean);
  chk('反例：无重复不改动', r2.changed === false, String(r2.changed));

  // ⑥ 反例：两节都有内容时保守保留（只报告不删）
  const bothHave = [
    '## 五、坑与决策',
    '- 内容A',
    '## 五、坑与决策（只追加）',
    '- 内容B',
  ].join('\n');
  const r3 = mergeDuplicates(bothHave);
  chk('反例：两节都有内容时不删', r3.changed === false,
      r3.changed ? '误删了' : 'ok');

  // ⑦ Windows 换行（CRLF）必须能识别
  //   自测抓到的缺陷：真实文件是 \r\n，正则 $ 匹配不上 → 章节数恒为 0
  const crlf = [
    '## 五、坑与决策',
    '- （只追加）',
    '## 五、坑与决策（只追加）',
    '- 2026-11-09：真实经验',
    '',
  ].join('\r\n');
  const secsCrlf = splitSections(crlf);
  chk('CRLF：能拆出章节', secsCrlf.length === 2, secsCrlf.length + ' 节');
  const r4 = mergeDuplicates(crlf);
  chk('CRLF：能识别重复并合并', r4.changed === true && r4.removed.length === 1,
      'changed=' + r4.changed + ' removed=' + r4.removed.length);

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

  // --root：换一个记忆根目录（造破坏验证用，不碰真实记忆）
  //
  //  ⚠ 2026-11-12 加：要验证「造破坏会失败」，就得能在沙箱目录里
  //     伪造一份重复章节的记忆文件，而不是去改真实数据。
  const rootIdx = argv.indexOf('--root');
  const memRoot = rootIdx >= 0 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1]) : MEM_ROOT;

  console.log('═'.repeat(72));
  console.log('  合并重复的场景记忆章节');
  console.log('═'.repeat(72));
  console.log();

  if (!fs.existsSync(memRoot)) { console.error('✗ 记忆目录不存在: ' + memRoot); process.exit(2); }

  let totalDups = 0;
  let totalRemoved = 0;
  const report = [];

  for (const d of fs.readdirSync(memRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const f = path.join(memRoot, d.name, '场景私有记忆.md');
    const md = readTextSafe(f);
    if (!md) continue;

    const dups = findDuplicates(md);
    if (dups.length === 0) continue;

    totalDups += dups.length;
    const r = mergeDuplicates(md);

    console.log(d.name + '（' + dups.length + ' 组重复）');
    for (const dup of dups) {
      console.log('  · 「' + dup.key + '」×' + dup.total +
        '（有内容 ' + dup.withContent + ' / 空占位 ' + dup.empty + '）');
      for (const h of dup.headings) console.log('      - ' + h);
    }

    if (r.changed) {
      totalRemoved += r.removed.length;
      console.log('  → 可删 ' + r.removed.length + ' 个空占位');
      if (has('--apply')) {
        fs.writeFileSync(f, r.md, 'utf8');
        console.log('  ✓ 已修复');
      }
    } else {
      console.log('  → 无需修改（都是实质内容，保守保留）');
    }
    console.log();
    report.push({ scene: d.name, dups: dups.length });
  }

  console.log('═'.repeat(72));
  console.log('  重复组: ' + totalDups + '   可删空占位: ' + totalRemoved);
  if (!has('--apply') && totalRemoved > 0) {
    console.log('  （预览模式。加 --apply 真改）');
  }
  console.log('═'.repeat(72));

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 修（判据错误：这个工具**永远不会失败**）
  //
  //    原判据：末尾无条件 `process.exit(0)`。
  //
  //    错在哪：机制体检把它当检查项跑，但它无论如何都返回 0。
  //            就算场景记忆里真有重复章节（正是它存在的唯一理由），
  //            体检也永远绿 —— 典型的「装饰检查」。
  //            也就是说：章节唯一性被破坏时，没有任何东西会红。
  //
  //    改成：--check 模式下「发现重复章节就 exit 1」。
  //          · 只报告，不修改（--apply 才改数据）
  //          · 有重复但都是实质内容（不可自动合并，需人工决策）也算失败 ——
  //            因为「标题不唯一」本身就是 AI 闭环里抓到的真实问题，
  //            能不能自动合并不影响「这个体检项该不该红」。
  //          · 默认预览模式仍然 exit 0（人工看报告时不该像报错一样）
  // ══════════════════════════════════════════════════════════════
  if (has('--check')) {
    if (totalDups === 0) {
      console.log('  ✓ 检查通过：所有场景记忆的章节标题都唯一');
      process.exit(0);
    }
    console.log('  ✗ 检查失败：' + totalDups + ' 组重复章节标题');
    console.log('    重复的节标题会让「按节追加 / 按锚点索引」产生歧义，');
    console.log('    维护者和脚本会各写各的，索引指向失效。');
    console.log('    处理：node 工具/合并重复章节.mjs --apply（只删空占位）');
    console.log('          两个都有实质内容的重复节 —— 要人工合并，工具不代删。');
    process.exit(1);
  }

  process.exit(0);
}
