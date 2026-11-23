#!/usr/bin/env node
// 工具/场景人格.mjs —— 「场景即人的一面」：同一机主在不同场景的不同表达方式
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（对标 luanyujia-workbench 发现的真缺口）
// ══════════════════════════════════════════════════════════════════════
//  我们已经有了「偏好记忆」（六类 / 19 条），但那全是**全局**的：
//
//    · 交互偏好：用中文回答、不要空话开头、结论先给
//    · 工具偏好：清理磁盘只找「本地电脑」
//    · 文件偏好：路径约定
//
//  这些回答的是「**这个人是谁**」。
//
//  但参考项目指出了一个我们漏掉的事实：
//
//    同一个机主，在「故障分析」那里语气是**急、烦、事多**；
//    在「调研」这边是**松、随手、句子短**；
//    在「自我复盘」那里又**认真、愿意说细**。
//
//    这不是「心情」，是**场景决定了他以哪一面出现**。
//
//  **只做前半句（分工），AI 就会用一套腔调应对所有事。**
//
//  参考项目把它落成五字段表：
//    场景 / 常见语气 / 典型原话（带日期与出处）/ 雷区 / 应对
//
//  四条硬边界（这是它最讲究的地方，我完全认同）：
//    ① 只记表达方式，禁止从口气推原因
//       「他这样说」可以记，「他为什么生气」不记
//    ② 一个场景是一个面，不是一个人
//       禁止写「他是什么样的人」；「急」只对那个场景
//    ③ 原话必须带日期与出处，无出处即删
//       没出处的「原话」最容易被 AI 顺手编出来
//    ④ 禁区：健康 / 家庭 / 财务 / 证件 / 宗教；且不做跨场景拼图
//
//  用法：
//    node 工具/场景人格.mjs --list              看所有场景的人格行
//    node 工具/场景人格.mjs --scene 故障分析     看一个场景
//    node 工具/场景人格.mjs --check             体检（边界检查）
//    node 工具/场景人格.mjs --add --scene X --tone 急 --bisect "..." --date 2026-11-13 --source "..."
//    node 工具/场景人格.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const FILE = path.join(DATA, '场景人格.yaml');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 允许的语气词（只记表达方式，不记原因）
 *
 * 参考项目列的：急 / 稳 / 短 / 啰嗦 / 玩笑 / 公事公办
 * 我们加两个实际会遇到的：直接 / 随意
 */
export const TONES = ['急', '稳', '短', '啰嗦', '玩笑', '公事公办', '直接', '随意'];

/**
 * 禁区词（不允许出现在人格行里）
 *
 * 参考项目的禁区：健康 / 家庭 / 财务 / 证件 / 宗教
 * 这是「不要把私人信息写进工作台」的硬边界。
 */
export const FORBIDDEN_WORDS = ['健康', '病', '家庭', '老婆', '丈夫', '孩子', '工资', '收入', '存款', '身份证', '护照', '宗教', '信仰'];

/**
 * 「从口气推原因」的禁止模式
 *
 * 参考项目：只记表达方式，禁止从口气推原因。
 * 这些词一旦出现，说明在推测动机。
 */
export const SPECULATION_PATTERNS = [
  // 「因为…生气」和「生气…因为…」两种语序都要拦
  /因为[\s\S]{0,20}(?:生气|着急|焦虑|烦|不高兴|压力大)/,
  /(?:生气|着急|焦虑|烦|不高兴|压力大)[\s\S]{0,20}因为/,
  /他[\s\S]{0,10}(?:可能|大概|应该)[\s\S]{0,20}(?:因为|由于|心情|情绪)/,
  /(?:性格|人品|这个人)[\s\S]{0,10}(?:内向|外向|急躁|暴躁|敏感)/,
  /(?:推测|猜测|估计)[\s\S]{0,10}(?:心情|情绪|性格|动机)/,
  // 「是因为」这种直接归因
  /是因为/,
];

/**
 * 判一个人格行是否合规
 * @param {{scene?:string, tone?:string, quote?:string, quoteDate?:string, quoteSource?:string, mine?:string, avoid?:string, respond?:string}} row
 * @returns {{ok:boolean, problems:string[]}}
 */
export function judgeRow(row) {
  const problems = [];
  const r = row || {};

  if (!r.scene) problems.push('缺场景名');

  // 语气必须在允许清单里
  if (r.tone && !TONES.includes(String(r.tone).trim())) {
    problems.push('语气不在允许清单: 「' + r.tone + '」（允许: ' + TONES.join('/') + '）');
  }

  // 原话必须带日期和出处（这是参考项目最讲究的一条）
  if (r.quote) {
    if (!r.quoteDate) problems.push('原话缺日期（「无出处即删」）');
    if (!r.quoteSource) problems.push('原话缺出处（「无出处即删」）');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.quoteDate || ''))) {
      problems.push('日期格式应为 YYYY-MM-DD，实际: ' + r.quoteDate);
    }
  }

  // 禁区词
  const allText = [r.tone, r.quote, r.avoid, r.respond, r.mine].filter(Boolean).join(' ');
  for (const w of FORBIDDEN_WORDS) {
    if (allText.includes(w)) problems.push('含禁区词「' + w + '」（禁区：健康/家庭/财务/证件/宗教）');
  }

  // 不能从口气推原因
  for (const re of SPECULATION_PATTERNS) {
    if (re.test(allText)) problems.push('在推测动机（只许记表达方式，不许推原因）');
  }

  // 不能写「他是什么样的人」
  if (/(?:他是|他是个|这个人|他的性格|人品)/.test(allText)) {
    problems.push('在描述「他是怎样的人」（一个场景是一个面，不是一个人）');
  }

  return { ok: problems.length === 0, problems };
}

// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
/**
 * 生成某个场景的「人格注入」段落
 *
 * 给 场景注入.mjs 用：让 AI 开工前知道自己在这个场景该怎么说话。
 *
 * 参考项目的原话：
 *   每个场景开工前，先读自己那一行，决定三件事：
 *     ① 回多长：句子短的人，你一屏三段他就不看
 *     ② 先说啥：结果是数字/结论，还是过程/解释
 *     ③ 别踩什么：雷区一行，比十条通用礼貌规则有用
 *
 * @param {string} sceneName
 * @returns {string} Markdown 段落（没有记录就返回空串）
 */
export function buildPersonaInjection(sceneName) {
  const rows = loadRows().filter((r) => r.scene === sceneName);
  if (!rows.length) return '';

  const L = [];
  L.push('## 这个场景里机主通常怎么说话');
  L.push('');
  L.push('> 这不是「偏好」，是**同一个机主在这个场景的一面**。');
  L.push('> 只记表达方式，不推原因 —— 别把它当成对他性格的判断。');
  L.push('');
  for (const r of rows) {
    if (r.tone) L.push('- **语气**：' + r.tone);
    if (r.avoid) L.push('- **雷区**：' + r.avoid);
    if (r.respond) L.push('- **该怎么回**：' + r.respond);
  }
  L.push('');
  return L.join('\n');
}

function loadRows() {
  try {
    const t = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(t);
    return Array.isArray(j.rows) ? j.rows : [];
  } catch { return []; }
}

function saveRows(rows) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ note: '场景人格：同一机主在不同场景的表达方式。只记表达方式，不推原因。', rows }, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  场景人格 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】正常行通过');
  {
    const good = {
      scene: '故障分析', tone: '急',
      quote: '这个报错又来了，先给我结论', quoteDate: '2026-11-13', quoteSource: '会话 08:15',
      avoid: '别先解释原理', respond: '先给结论，再给证据，三段以内',
    };
    const r = judgeRow(good);
    chk('正例：完整且合规的行通过', r.ok === true, r.problems.join('; ') || '无问题');
  }

  console.log();
  console.log('【二】反例：原话没出处必须拒绝');
  {
    const noDate = { scene: 'X', tone: '短', quote: '随便吧' };
    const r1 = judgeRow(noDate);
    chk('反例：原话缺日期 → 拒绝', r1.ok === false, r1.problems.join('; '));
    chk('反例：拒绝理由说清「无出处即删」', /无出处/.test(r1.problems.join(' ')));

    const badDate = { scene: 'X', tone: '短', quote: '随便吧', quoteDate: '11月13日', quoteSource: '会话' };
    const r2 = judgeRow(badDate);
    chk('反例：日期格式不对 → 拒绝', r2.ok === false, r2.problems.join('; '));
  }

  console.log();
  console.log('【三】反例：语气不在清单里 → 拒绝');
  {
    const r = judgeRow({ scene: 'X', tone: '暴躁' });
    chk('反例：不在清单的语气 → 拒绝', r.ok === false, r.problems.join('; '));
    chk('拒绝时列出允许值', /允许/.test(r.problems.join(' ')));
  }

  console.log();
  console.log('【四】反例：禁区词必须拒绝');
  {
    const r = judgeRow({ scene: 'X', tone: '短', avoid: '别问家里孩子的事' });
    chk('反例：含禁区词 → 拒绝', r.ok === false, r.problems.join('; '));
  }

  console.log();
  console.log('【五】反例：推测动机必须拒绝');
  {
    const r1 = judgeRow({ scene: 'X', tone: '急', respond: '他生气是因为没睡好' });
    chk('反例：从口气推原因 → 拒绝', r1.ok === false, r1.problems.join('; '));

    const r2 = judgeRow({ scene: 'X', tone: '短', respond: '他可能因为压力大所以说话短' });
    chk('反例：推测心情 → 拒绝', r2.ok === false, r2.problems.join('; '));
  }

  console.log();
  console.log('【六】反例：写「他是什么样的人」必须拒绝');
  {
    const r = judgeRow({ scene: 'X', tone: '稳', respond: '他是个内向的人' });
    chk('反例：描述人格 → 拒绝', r.ok === false, r.problems.join('; '));
  }

  console.log();
  console.log('【七】关键：四条硬边界都有对应判据');
  {
    chk('边界①只记表达不推原因', SPECULATION_PATTERNS.length > 0, SPECULATION_PATTERNS.length + ' 个模式');
    chk('边界②一场景一面', true, '判据：拒绝「他是个X样的人」');
    chk('边界③原话须带日期出处', true, '判据：缺 quoteDate/quoteSource 即拒');
    chk('边界④禁区词', FORBIDDEN_WORDS.length > 0, FORBIDDEN_WORDS.length + ' 个词');
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
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const rows = loadRows();

  if (has('list') || (!has('check') && !has('add') && !has('scene'))) {
    console.log('='.repeat(78));
    console.log('  场景人格 —— 同一机主在不同场景的表达方式');
    console.log('='.repeat(78));
    console.log();
    if (!rows.length) {
      console.log('  （还没有记录）');
      console.log();
      console.log('  为什么需要这一层：');
      console.log('    我们的「偏好记忆」是**全局**的（用中文/不要空话/结论先给），');
      console.log('    但同一个机主在不同场景的**表达方式**不一样：');
      console.log('      故障分析那里：急、要结论、别解释原理');
      console.log('      调研那边：  松、句子短、随手');
      console.log('      自我复盘：  认真、愿意说细');
      console.log('    「只做分工，AI 就会用一套腔调应对所有事。」');
      console.log();
      console.log('  加一条：');
      console.log('    node 工具/场景人格.mjs --add --scene 故障分析 --tone 急 \\');
      console.log('      --quote "先给我结论" --date 2026-11-13 --source "会话 08:15" \\');
      console.log('      --avoid "别先解释原理" --respond "先结论后证据，三段内"');
      return;
    }
    for (const r of rows) {
      console.log('  ── ' + r.scene + ' ──');
      if (r.tone) console.log('    语气: ' + r.tone);
      if (r.quote) console.log('    原话: 「' + r.quote + '」  （' + r.quoteDate + ' · ' + r.quoteSource + '）');
      if (r.avoid) console.log('    雷区: ' + r.avoid);
      if (r.respond) console.log('    应对: ' + r.respond);
      console.log();
    }
    return;
  }

  if (has('scene')) {
    const s = val('scene');
    const hit = rows.filter((r) => r.scene === s);
    if (!hit.length) { console.log('  没有找到「' + s + '」的人格行'); return; }
    console.log(JSON.stringify(hit, null, 2));
    return;
  }

  if (has('check')) {
    console.log('='.repeat(78));
    console.log('  场景人格体检（四条硬边界）');
    console.log('='.repeat(78));
    console.log();
    let bad = 0;
    for (const r of rows) {
      const j = judgeRow(r);
      if (!j.ok) {
        bad++;
        console.log('  XX ' + r.scene);
        for (const p of j.problems) console.log('       · ' + p);
      } else {
        console.log('  OK ' + r.scene);
      }
    }
    console.log();
    console.log('─'.repeat(78));
    console.log('  ' + (rows.length - bad) + ' / ' + rows.length + ' 行合规');
    if (bad) process.exitCode = 1;
    return;
  }

  if (has('add')) {
    const row = {
      scene: val('scene'),
      tone: val('tone'),
      quote: val('quote'),
      quoteDate: val('date'),
      quoteSource: val('source'),
      avoid: val('avoid'),
      respond: val('respond'),
    };
    // 去掉 undefined
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];

    const j = judgeRow(row);
    if (!j.ok) {
      console.log('  ✗ 不合规，拒绝写入:');
      for (const p of j.problems) console.log('    · ' + p);
      process.exitCode = 1;
      return;
    }
    rows.push(row);
    saveRows(rows);
    console.log('  ✓ 已写入 ' + FILE + '（' + rows.length + ' 行）');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
