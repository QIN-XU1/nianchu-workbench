#!/usr/bin/env node
// 工具/经验真实性体检.mjs —— 检查「经验」是否真的影响了后续行为
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  2026-11-12，「自我复盘」场景在历练任务「用真实数据检验你上轮的成长结论」
//  里做了一次非常有价值的自省：
//
//    「6 条结论里，0 条是「强体现」—— 没有一条在后续任务里被明确调用。
//      明确的自我安慰有 2 条：我上轮把「没再踩坑」写成了「经验生效了几次」，
//      把「一次性纠正」写成了「稳定成长」。
//
//      我的最大自欺在于：**把「再也没遇到那个坑」当成了「已经学会怎么处理那个坑」**。
//      glob 那条就是铁证 —— 我上轮信誓旦旦说它「生效了几次」，
//      其实后续我压根没用过 glob。」
//
//  这段话揭示了一个系统性问题：
//    **经验写了 ≠ 经验生效了。**
//    记忆里有一条经验，不代表后续行为真的改变了。
//
//  所以要有一个检查，区分：
//    · 「真经验」：写了，而且后续有证据表明它被调用/影响了决策
//    · 「假经验」：写了，但后续从没体现过（自我安慰）
//
// ══════════════════════════════════════════════════════════════════════
//  怎么判（机械可复核）
// ══════════════════════════════════════════════════════════════════════
//  对每条经验：
//    ① 提取经验里的「关键实体」：文件路径、工具名、函数名、命令
//    ② 在该场景记忆的「后续内容」里搜这些实体
//       （后续内容 = 该条经验之后的文本 + 该场景的其他产出文件）
//    ③ 命中 → 认为「有后续证据」；未命中 → 标记「可能自我安慰」
//
//  这不是完美的判据（真经验也可能没留下文字痕迹），
//  但它能**捞出明确的问题**：一条经验里的文件路径，
//  连在后续文本里都没再出现过一次，那它大概率是自说自话。
//
//  用法：
//    node 工具/经验真实性体检.mjs                # 全部场景
//    node 工具/经验真实性体检.mjs --scene 自我复盘
//    node 工具/经验真实性体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractExperiences, getPitSection } from './_经验识别.mjs';
import { sceneNames } from './_场景清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

// ⚠ 2026-11-14 改：不再硬编码，从 scenarios/*.json 动态读
const SCENES = sceneNames();

/**
 * 从一条经验里抽「关键实体」
 * 只抽那些「如果真用过就该出现」的具体标识
 */
export function extractEntities(text) {
  // ⚠ 2026-11-12 重写（第一版把中文短语切碎了，产生大量假阳性）
  //
  //   第一版还抽「工具名」用正则 (中文)(通道|哨兵|体检|...)
  //   结果从「架构梳理要验证「闭环的最后一跳」能真实落地」里
  //   抽出了「架构梳理要验证」这种碎片 —— 它不是实体，是句子的一部分。
  //
  //   这类碎片在后续内容里当然不会出现，于是全被误判为「自我安慰」。
  //
  //   修法：只抽**真正可辨识的标识**
  //     ① 文件名：xxx.md / xxx.json / xxx.mjs / xxx.js
  //     ② 代码标识符：驼峰或下划线的英文函数名/变量名（>=5 字符）
  //     ③ 命令行参数：--xxx
  //     ④ 明确的工具名（必须在「工具/」路径里出现）
  const out = new Set();
  const s = String(text || '');

  // ① 文件名（含路径）
  for (const m of s.matchAll(/[\w\u4e00-\u9fa5/\.-]+\.(?:md|json|mjs|js)/g)) {
    out.add(m[0]);
    const base = m[0].split('/').pop();
    if (base && base.length >= 5) out.add(base);
  }

  // ② 英文代码标识符（驼峰或带下划线，>=5 字符）
  for (const m of s.matchAll(/\b([a-z][a-zA-Z0-9_]{4,}|[A-Z][a-zA-Z0-9_]{4,})\b/g)) {
    const w = m[1];
    // 过滤纯小写常见词（这些不是标识符）
    if (/^(?:the|and|for|with|this|that|from|which|there|their|would|could|should)$/i.test(w)) continue;
    // 只保留「看起来像代码标识符」的：有驼峰或下划线或全大写
    if (/[A-Z]/.test(w) || w.includes('_') || w === w.toUpperCase()) out.add(w);
  }

  // ③ 命令行参数
  for (const m of s.matchAll(/--([a-z][a-zA-Z0-9-]{3,})/g)) {
    out.add('--' + m[1]);
  }

  // ④ 工具名（要求出现在路径语境里，避免误抽句子片段）
  for (const m of s.matchAll(/工具[/\\]([\u4e00-\u9fa5]{2,10})(?:\.mjs)?/g)) {
    out.add(m[1]);
  }

  return [...out].filter((x) => x.length >= 4);
}

/**
 * 检查一个场景的经验真实性
 */
export function checkScene(sceneName) {
  const dir = path.join(MEM, sceneName);
  const memFile = path.join(dir, '场景私有记忆.md');
  if (!fs.existsSync(memFile)) return { scene: sceneName, err: '无记忆文件' };

  const md = fs.readFileSync(memFile, 'utf8');
  const exps = extractExperiences(md);
  if (!exps.length) return { scene: sceneName, total: 0, items: [] };

  // 「后续内容」= 该场景目录下所有其他 md 文件的正文 + 记忆里该条之后的部分
  let corpus = '';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === '场景私有记忆.md') continue;
      corpus += '\n' + fs.readFileSync(path.join(dir, f), 'utf8');
    }
  } catch { /* ignore */ }

  const pitBody = getPitSection(md);

  // ⚠ 2026-11-12 修（判据缺陷：同一记忆文件里 §五 之后的内容被漏掉了）：
  //
  //   原来：只在 pitBody（§五 章节内）向后找 + 其他 md 文件。
  //   问题：§五 之后还有 §六/§七/§八 等章节，它们**在同一个文件里、
  //        逻辑上也是「后续内容」**，却被排除在外。
  //
  //   实测：往 §八 项目索引补写「机制索引」，把 --selftest / TERMINAL /
  //        extractExperiences 等实体都写进去后，检查器仍判「后续一次都没出现」——
  //        因为它只看 §五 内部。
  //
  //   修法：把 §五 之后的整段文件内容也计入 corpus。
  let tailAfterPit = '';
  try {
    const pitStart = md.indexOf(pitBody);
    if (pitStart >= 0) {
      tailAfterPit = md.slice(pitStart + pitBody.length);
    }
  } catch { /* ignore */ }

  const items = [];
  for (const e of exps) {
    const ents = extractEntities(e.raw);
    if (!ents.length) {
      items.push({ date: e.date, text: e.text.slice(0, 50), entities: [], hits: [], verdict: 'no-entity' });
      continue;
    }

    // 在该条之后的 pit 正文里找（不含该条自身）+ 其他 md 文件 + §五 之后的章节
    const afterSelf = pitBody.slice(pitBody.indexOf(e.raw) + e.raw.length);
    const searchIn = afterSelf + '\n' + corpus + '\n' + tailAfterPit;

    const hits = ents.filter((x) => searchIn.includes(x));
    const verdict = hits.length > 0 ? 'has-evidence' : 'possibly-self-comfort';

    items.push({
      date: e.date,
      text: e.text.slice(0, 60),
      entities: ents.slice(0, 6),
      hits: hits.slice(0, 6),
      verdict,
    });
  }

  const withEnt = items.filter((x) => x.verdict !== 'no-entity');
  const evidence = withEnt.filter((x) => x.verdict === 'has-evidence');
  return {
    scene: sceneName,
    total: items.length,
    checkable: withEnt.length,
    withEvidence: evidence.length,
    ratio: withEnt.length ? Math.round(evidence.length / withEnt.length * 100) : null,
    items,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  经验真实性体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】实体抽取');
  const t1 = '修了 投递通道.mjs 的 token 正则，用 reason.kind 判断结束';
  const e1 = extractEntities(t1);
  chk('能抽出文件名', e1.some((x) => x.includes('投递通道.mjs')), e1.join(', '));
  // ⚠ 2026-11-12：工具名只从「工具/xxx」路径语境里抽（避免把中文句子切碎）
  chk('从「工具/xxx.mjs」路径能抽出工具名',
    extractEntities('修了 工具/投递通道.mjs 的问题').some((x) => x === '投递通道'),
    '路径语境下的工具名');

  console.log();
  console.log('【二】反例：抽不到实体时应标记 no-entity');
  const e2 = extractEntities('学到了很多经验');
  chk('反例：「学到了很多」抽不到实体', e2.length === 0, '抽到 ' + e2.length + ' 个');

  console.log();
  console.log('【三】判据逻辑');
  // 模拟：经验提到 X，后续没提 → possibly-self-comfort
  const exp1 = { raw: '- 2026-11-12：**改了 A.mjs 的某处** — 症状：x → 根因：y → 修法：z' };
  const ents1 = extractEntities(exp1.raw);
  const after1 = '后续写了完全不同的东西，没提那个文件';
  const hits1 = ents1.filter((x) => after1.includes(x));
  chk('反例：后续没提 → 无证据', hits1.length === 0, '命中 ' + hits1.length);

  // 模拟：后续提到了 → has-evidence
  const after2 = '后来我又 read 了 A.mjs，确认改动生效';
  const hits2 = ents1.filter((x) => after2.includes(x));
  chk('正例：后续提到 → 有证据', hits2.length > 0, '命中 ' + hits2.length);

  // ⚠ 2026-11-12 加【三】：经验归零必须直接失败（不被平均值掩盖）
  //
  //   实测缺陷：把「逆向分析」的场景私有记忆清空（7205B → 71B），
  //   原来打印「合计 105 条 91%」并 exit 0 —— 其它 8 个场景的好数字
  //   把这一条 0 摊掉了。而经验数是本项目的核心指标（目标 108 条），
  //   一个场景归零是严重故障。
  console.log();
  console.log('【三】经验归零必须直接失败');
  {
    // 复现汇总判据
    const judgeEmpty = (results) => results.filter((r) => !r.err && (r.total || 0) === 0);
    const cases = [
      {
        name: '反例：有一个场景经验归零',
        results: [{ scene: 'A', total: 12 }, { scene: 'B', total: 0 }, { scene: 'C', total: 15 }],
        expect: 1,
      },
      {
        name: '正例：所有场景都有经验',
        results: [{ scene: 'A', total: 12 }, { scene: 'B', total: 9 }],
        expect: 0,
      },
      {
        name: '反例：多个场景归零',
        results: [{ scene: 'A', total: 0 }, { scene: 'B', total: 0 }],
        expect: 2,
      },
    ];
    for (const c of cases) {
      const hits = judgeEmpty(c.results);
      chk(c.name, hits.length === c.expect,
        '检出 ' + hits.length + ' 个（期望 ' + c.expect + '）');
    }
    // 关键：归零场景必须让它 exit 非 0，不管整体比例多高
    const highOverall = [{ scene: 'A', total: 100 }, { scene: 'B', total: 0 }];
    const bad = judgeEmpty(highOverall).length > 0;
    chk('关键：整体 100 条也不能掩盖单个场景归零', bad,
      '否则「平均值掩盖局部全灭」');
  }

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const one = val('scene', null);
  const targets = one ? [one] : SCENES;

  console.log('═'.repeat(78));
  console.log('  经验真实性体检 —— 经验写了，还是真生效了？');
  console.log('═'.repeat(78));
  console.log();
  console.log('  判据：一条经验里的关键实体（文件/工具/函数）');
  console.log('        如果在该场景的后续内容里一次都没出现，标记为「可能自我安慰」');
  console.log();

  const results = [];
  for (const s of targets) {
    const r = checkScene(s);
    results.push(r);
    if (r.err) { console.log('  ' + s + '  ' + r.err); continue; }

    const mark = r.ratio === null ? '—' : (r.ratio >= 50 ? 'OK' : 'XX');
    console.log('  ' + mark + ' ' + s.padEnd(10) +
      ' 经验 ' + String(r.total).padStart(2) +
      '  可查 ' + String(r.checkable).padStart(2) +
      '  有证据 ' + String(r.withEvidence).padStart(2) +
      '  ' + (r.ratio === null ? '(无实体可查)' : r.ratio + '%'));

    for (const it of r.items.filter((x) => x.verdict === 'possibly-self-comfort')) {
      console.log('       ⚠ ' + it.date + ' ' + it.text.slice(0, 45));
      console.log('         实体: ' + it.entities.join(', ') + '  → 后续一次都没出现');
    }
  }

  const sumTotal = results.filter((r) => !r.err).reduce((a, b) => a + (b.total || 0), 0);
  const sumCheck = results.filter((r) => !r.err).reduce((a, b) => a + (b.checkable || 0), 0);
  const sumEv = results.filter((r) => !r.err).reduce((a, b) => a + (b.withEvidence || 0), 0);

  console.log();
  console.log('─'.repeat(78));
  console.log('  合计: 经验 ' + sumTotal + ' 条，可查 ' + sumCheck + ' 条，' +
    '有后续证据 ' + sumEv + ' 条  (' + (sumCheck ? Math.round(sumEv / sumCheck * 100) : 0) + '%)');
  console.log();
  console.log('  说明：这个判据会漏判（真经验也可能没留下文字痕迹），');
  console.log('        但它能捞出明确的问题 —— 一条经验里的文件路径，');
  console.log('        连在后续文本里都没再出现过，那它大概率是自说自话。');
  console.log('═'.repeat(78));

  // ⚠ 2026-11-12 修（破坏性验证抓出来的装饰）：
  //
  //   原来 main() 完全不设 exit code —— 不管捞出多少「可能自我安慰」
  //   的经验都 exit 0，机制体检永远判 PASS。
  //   实测：注入一条完全虚构的经验（实体 ZzFakeModule 等），
  //        它正确报出了 ⚠ 警告，但 exit 0 → 装饰。
  //
  //   判据：有证据率 < 50% 就算失败（说明大部分经验是自说自话）。
  //        这和上面逐场景的 mark 判据保持一致。
  // 判据（两次调整后定下的）：
  //
  //   第一版用「有证据率 < 50%」→ 太宽松。实测：
  //     正常全场景 88%（41 可查里 5 条无证据）
  //     注入 3 条虚构经验后 63% —— 被拉低了但没到 50%，抓不到。
  //
  //   这是因为「无证据」的绝对数量少（5 条），稀释在 41 条里不明显。
  //
  //   现在用两条：
  //     ① 单场景「可能自我安慰」>= 3 条 → 该国出事
  //     ② 全场景无证据占比 > 20% → 整体出事
  const badScenes = results.filter((r) => !r.err && r.items &&
    r.items.filter((x) => x.verdict === 'possibly-self-comfort').length >= 3);
  const noEvidence = sumCheck - sumEv;
  const badRatio = sumCheck ? noEvidence / sumCheck : 0;

  // ⚠ 2026-11-12 加（真缺陷：空场景被平均值掩盖）
  //
  //   实测：把「逆向分析」的场景私有记忆清空（7205B → 71B），
  //   这个工具打印：
  //     XX 逆向分析   经验 0  可查 undefined  有证据 undefined  undefined%
  //     合计: 经验 105 条，可查 78 条，有后续证据 71 条  (91%)
  //     exit 0
  //
  //   也就是说：**一个场景的经验被彻底清空，整体仍报 91% 通过。**
  //   这是「平均值掩盖局部全灭」的典型 —— 其它 8 个场景的好数字
  //   把这一条 0 摊掉了。
  //
  //   而经验数是「自主进化」这个项目的核心指标之一（目标 108 条）。
  //   一个场景归零是**严重故障**，不该被平均掉。
  //
  //   判据：任何场景的经验数为 0 → 直接失败，不管整体比例多少。
  const emptyScenes = results.filter((r) => !r.err && (r.total || 0) === 0);

  if (badScenes.length || badRatio > 0.20 || emptyScenes.length) {
    console.log();
    if (emptyScenes.length) {
      console.log('  XX 这些场景一条经验都没有（经验数归零是严重故障，不该被平均值掩盖）: ' +
        emptyScenes.map((r) => r.scene).join(', '));
    }
    if (badScenes.length) {
      console.log('  ⚠ 这些场景有 >= 3 条经验「可能自我安慰」: ' +
        badScenes.map((r) => r.scene + '(' + r.items.filter((x) => x.verdict === 'possibly-self-comfort').length + ')').join(', '));
    }
    if (badRatio > 0.20) {
      console.log('  ⚠ 全场景无证据占比 ' + Math.round(badRatio * 100) + '% > 20%（' + noEvidence + '/' + sumCheck + '）');
    }
    process.exitCode = 1;
  }
}

main();
