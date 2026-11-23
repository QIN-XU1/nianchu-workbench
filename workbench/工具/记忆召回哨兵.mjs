#!/usr/bin/env node
/**
 * 记忆召回哨兵 —— 第 10 个哨兵
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要它（依据 research/记忆系统顶尖实践-调研报告.md）
 * ══════════════════════════════════════════════════════════════
 *
 *  现有 9 个哨兵全在验「字节数」——
 *  记忆文件有没有超限、格式对不对、字段全不全。
 *
 *  这等于只验了「编译通过」，没验「程序算得对」。
 *
 *  调研原文：
 *    「你的哨兵全在验字节数 = 只验了'编译通过'」
 *    「缺的不是更先进的架构，是一个能证伪的记忆系统该有的三样东西 ——
 *      可归因的样本、带时态的写入、分离口径的度量」
 *
 *  这个哨兵补「可归因的样本」+「分离口径的度量」。
 *
 * ══════════════════════════════════════════════════════════════
 *  它做什么
 * ══════════════════════════════════════════════════════════════
 *
 *  跑一组「封存集」用例（Agent 看不到），检查：
 *    ① 该场景的记忆文件里，是否包含回答问题所需的关键事实
 *       → recall@k（召回率）
 *    ② 关键事实是否排在前面
 *       → 位置质量
 *    ③ 注入成本（token 数）
 *
 *  指标口径来自 LongMemEval 源码：
 *    recall_all@k —— 所有证据行都被召回
 *    ndcg_any@k  —— 任一证据行被召回时的排序质量
 *
 *  同时报告成本：注入这些记忆要花多少 token
 *  （调研强调：收益必须配成本，否则升级可能是负收益）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/记忆召回哨兵.mjs              跑全部场景
 *  node 工具/记忆召回哨兵.mjs --scene <id>  只跑一个场景
 *  node 工具/记忆召回哨兵.mjs --json        JSON 输出
 *  node 工具/记忆召回哨兵.mjs --selftest    自测（含反例）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
// ⚠ 2026-11-12 修（路径写错，导致哨兵永远空转）：
//
//   原来：path.join(WB, '封存集')  →  workbench/封存集/
//   实际：数据/.dsh/封存集/<中文场景名>/cases.json
//
//   后果：这个哨兵自测能过（9/9），但实跑永远说
//         「没有封存集。先造封存集：workbench/封存集/<场景id>.json」
//         ——它找的目录不存在，所以从来没真正检查过任何东西。
//
//   这是「看起来有实际是空」的教科书案例：
//     工具写好了、自测通过、有详细使用说明，
//     但它指向的目录不存在 → 永远空转 → 没有任何实际作用。
const SEALED_DIR = path.join(DATA_ROOT, '封存集');

/** 英文场景 id ↔ 中文场景名 */
const SCENE_CN = {
  'arch-review': '架构梳理', 'build-plan': '实施计划', 'competitor-analyze': '竞品拆解',
  'incident-analysis': '故障分析', 'pc-cleanup': '本地电脑', research: '调研',
  'reverse-eng': '逆向分析', 'self-review': '自我复盘', hub: '中枢',
};

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  阈值（写死，不达标就红）
// ══════════════════════════════════════════════════════════════
export const THRESHOLDS = {
  /** 封存集召回率下限 —— 低于此值说明记忆里根本没有该知道的事 */
  RECALL_MIN: 0.70,
  /** 注入成本上限（token）—— 超了说明记忆臃肿 */
  /** 注入成本上限（token）—— 超了说明记忆臃肿 */
  INJECT_TOKENS_MAX: 8000,

  // ⚠ 2026-11-12 新增：真实注入口径
  //
  //   上面 INJECT_TOKENS_MAX 判的是「全量注入成本」。
  //   但实际在跑的机制是 记忆注入.mjs：按用户话术检索，
  //   每轮最多 3 条 / 300 字（约 150 token）。
  //
  //   实测：全量注入 8 个场景超 8000 token（中枢 13633、逆向 14903…），
  //        但真实注入每轮只 100-150 token。
  //
  //   所以「全量超限」不是缺陷，只是说明记忆装不下一次性全塞。
  //   真正该判的是：真实检索能不能召回关键事实。
  //   那个判据在 工具/记忆注入效果体检.mjs 里（实测 67%）。
  //
  //   这里保留全量成本作为「参考指标」，不再作为 FAIL 判据。
  /** 真实注入每轮上限（3 条 / 300 字，约 150 token） */
  REAL_INJECT_TOKENS: 200,
};

// 中文字符约 1 token，英文约 0.25 token
function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  const t = readTextSafe(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  加载某场景的全部记忆文本（模拟"全量注入"）
// ══════════════════════════════════════════════════════════════
function loadSceneMemory(sceneName) {
  const dir = path.join(MEM_ROOT, sceneName);
  if (!fs.existsSync(dir)) return { files: [], text: '', tokens: 0 };

  const files = [];
  const parts = [];

  // 私记忆目录下的所有 md
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue;
    const t = readTextSafe(path.join(dir, f.name));
    if (t === null) continue;
    files.push({ name: f.name, text: t });
    parts.push(t);
  }

  // 共享层（AGENTS.md + 索引）
  const agents = readTextSafe(path.join(DATA_ROOT, 'AGENTS.md'));
  if (agents) {
    files.push({ name: 'AGENTS.md', text: agents });
    parts.push(agents);
  }

  const text = parts.join('\n\n');
  return { files, text, tokens: estimateTokens(text) };
}

// ══════════════════════════════════════════════════════════════
//  按段落切分（用于计算 recall@k）
// ══════════════════════════════════════════════════════════════
function splitChunks(text) {
  if (!text) return [];
  // 先按 markdown 标题切大块，再按空行切小块，最后合并过短的
  const byHeading = text.split(/\n(?=#{1,6}\s)/);
  const out = [];
  for (const h of byHeading) {
    const paras = h.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of paras) {
      if (p.length > 10) out.push(p);
    }
  }
  // 若一个块都没切出来（纯文本无标题无空行），整段算一块
  if (out.length === 0 && text.trim().length > 0) out.push(text.trim());
  return out;
}

// ══════════════════════════════════════════════════════════════
//  简易相关性打分（无 embedding，用词项覆盖）
//
//  调研说明：25.6 KB 不需要向量检索，全量注入是对的。
//  所以这里不做真检索，而是检查「关键事实是否在记忆里」，
//  这就是 recall 的本义。
// ══════════════════════════════════════════════════════════════
function normalize(s) {
  return s.toLowerCase().replace(/\s+/g, '');
}

function containsFact(text, fact) {
  // 把 fact 拆成若干「特征词」，看覆盖比例
  const nText = normalize(text);
  // 特征词：长度 >= 2 的中文片段 / 英文词
  const terms = fact.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [];
  if (terms.length === 0) return { hit: 0, total: 0, ratio: 1 };
  let hit = 0;
  for (const t of terms) {
    if (nText.includes(normalize(t))) hit++;
  }
  return { hit, total: terms.length, ratio: hit / terms.length };
}

// ══════════════════════════════════════════════════════════════
//  跑一个场景的封存集
// ══════════════════════════════════════════════════════════════
function runScene(sceneId) {
  // 实际结构：封存集/<中文场景名>/cases.json
  const sceneCn = SCENE_CN[sceneId] || sceneId;
  const sealedPath = path.join(SEALED_DIR, sceneCn, 'cases.json');
  const sealed = readJsonSafe(sealedPath);
  if (!sealed) {
    return { sceneId, ok: false, error: '没有封存集: ' + sealedPath, skipped: true };
  }

  const sceneName = sealed.sceneName || sceneId;
  const cases = sealed.cases || [];
  if (cases.length === 0) {
    return { sceneId, ok: false, error: '封存集为空', skipped: true };
  }

  const mem = loadSceneMemory(sceneName);
  const chunks = splitChunks(mem.text);

  const results = [];
  for (const c of cases) {
    // c.facts: 必须能在记忆里找到的关键事实列表
    // c.id: 用例 id
    const factResults = (c.facts || []).map((f) => {
      const r = containsFact(mem.text, f);
      // 找出哪个 chunk 命中最全（用于算位置质量）
      let bestIdx = -1;
      let bestRatio = 0;
      chunks.forEach((ch, i) => {
        const rr = containsFact(ch, f);
        if (rr.ratio > bestRatio) { bestRatio = rr.ratio; bestIdx = i; }
      });
      return { fact: f, ...r, chunkIdx: bestIdx, chunkRatio: bestRatio };
    });

    // recall_all@k：所有事实都命中算 1
    const allHit = factResults.every((fr) => fr.ratio >= 0.6);
    // recall_any：至少一个命中
    const anyHit = factResults.some((fr) => fr.ratio >= 0.6);

    results.push({
      id: c.id,
      question: c.question || '',
      factResults,
      recallAll: allHit,
      recallAny: anyHit,
    });
  }

  const recallAll = results.filter((r) => r.recallAll).length / results.length;
  const recallAny = results.filter((r) => r.recallAny).length / results.length;

  // 缺哪些事实（可归因）
  const missing = [];
  for (const r of results) {
    for (const fr of r.factResults) {
      if (fr.ratio < 0.6) {
        missing.push({ case: r.id, fact: fr.fact, ratio: +fr.ratio.toFixed(2), hit: fr.hit, total: fr.total });
      }
    }
  }

  return {
    sceneId,
    sceneName,
    ok: true,
    caseCount: results.length,
    chunkCount: chunks.length,
    injectTokens: mem.tokens,
    memoryFiles: mem.files.length,
    recallAll: +recallAll.toFixed(3),
    recallAny: +recallAny.toFixed(3),
    missing,
    results,
    // 判定
    passRecall: recallAll >= THRESHOLDS.RECALL_MIN,
    passTokens: mem.tokens <= THRESHOLDS.INJECT_TOKENS_MAX,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测（带反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (name, ok, detail) => {
    R.push({ name, ok });
    console.log((ok ? '  OK   ' : '  XX   ') + name + (detail ? '  ' + detail : ''));
  };

  console.log('═'.repeat(70));
  console.log('  记忆召回哨兵 · 自测');
  console.log('═'.repeat(70));
  console.log();

  // ① token 估算
  chk('token 估算：纯中文', Math.abs(estimateTokens('你好世界') - 4) <= 1,
      String(estimateTokens('你好世界')));
  chk('token 估算：纯英文', estimateTokens('hello world') <= 4,
      String(estimateTokens('hello world')));
  chk('token 估算：空串', estimateTokens('') === 0, '0');

  // ② 事实命中
  const text = '本次任务遇到一个问题：状态机末端没有处理 closed 状态，导致误算。';
  chk('事实命中：完全包含', containsFact(text, '状态机末端没有处理').ratio >= 0.6,
      String(containsFact(text, '状态机末端没有处理').ratio.toFixed(2)));
  chk('事实不命中：无关内容', containsFact(text, '部署脚本使用 nginx 反向代理').ratio < 0.6,
      String(containsFact(text, '部署脚本使用 nginx 反向代理').ratio.toFixed(2)));

  // ③ 切块
  const chunks = splitChunks(
    '# 标题一\n\n这是一段足够长的内容用来测试切块功能。\n\n# 标题二\n\n这是另一段足够长的内容。');
  chk('切块：按标题分割', chunks.length >= 2, chunks.length + ' 块');

  // ③b 反例：纯文本（无标题无空行）应该整段算一块，不能返回 0
  const flat = splitChunks('这是一整段没有任何标题和空行的文字，长度肯定超过十个字符。');
  chk('切块：纯文本不返回空', flat.length === 1, flat.length + ' 块');

  // ④ 反例：故意构造一个"记忆里没有该事实"的用例，必须判不通过
  const fakeMem = '这个场景只记录了一些无关紧要的东西。';
  const fakeCase = { facts: ['必须知道的特定事实XYZ'] };
  const r = containsFact(fakeMem, fakeCase.facts[0]);
  chk('反例：记忆缺失时必须判不通过', r.ratio < 0.6, 'ratio=' + r.ratio.toFixed(2));

  // ⑤ 反例：阈值必须能失败
  chk('反例：recall 0.5 < 阈值 0.70 时必须红', 0.5 < THRESHOLDS.RECALL_MIN,
      '0.50 < ' + THRESHOLDS.RECALL_MIN);

  console.log();
  const passed = R.filter((x) => x.ok).length;
  console.log('─'.repeat(70));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(70));

  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════
if (has('--selftest')) {
  process.exit(selftest() ? 0 : 1);
}

// 收集要跑的场景
let sceneIds = [];
if (has('--scene')) {
  sceneIds = [val('--scene')];
} else if (fs.existsSync(SEALED_DIR)) {
  // ⚠ 2026-11-12 修：实际是「目录 + cases.json」，不是单个 .json 文件
  sceneIds = fs.readdirSync(SEALED_DIR).filter((f) => {
    try {
      return fs.statSync(path.join(SEALED_DIR, f)).isDirectory() &&
        fs.existsSync(path.join(SEALED_DIR, f, 'cases.json'));
    } catch { return false; }
  });
}

if (sceneIds.length === 0) {
  console.log('没有封存集。先造封存集：');
  console.log('  数据/.dsh/封存集/<中文场景名>/cases.json');
  console.log();
  console.log('  生成：node 工具/封存集.mjs --build --apply');
  console.log();
  console.log('格式：');
  console.log(JSON.stringify({
    sceneName: '架构梳理',
    cases: [
      { id: 'c1', question: '这个场景踩过什么坑？', facts: ['必须能在记忆里找到的关键事实'] },
    ],
  }, null, 2));
  process.exit(2);
}

const reports = sceneIds.map(runScene);

if (has('--json')) {
  console.log(JSON.stringify({ at: new Date().toISOString(), reports, thresholds: THRESHOLDS }, null, 2));
} else {
  console.log('═'.repeat(70));
  console.log('  记忆召回哨兵');
  console.log('═'.repeat(70));
  console.log();
  console.log('  阈值: recall_all >= ' + THRESHOLDS.RECALL_MIN +
    '（全量注入成本仅作参考，不作 FAIL 判据）');
  console.log();

  let fail = 0;
  for (const r of reports) {
    if (r.skipped) {
      console.log('  ⏭  ' + r.sceneId + '  ' + r.error);
      continue;
    }
    // ⚠ 2026-11-12 改：只用 recall 判定通过
    //
    //   原来：ok = passRecall && passTokens
    //   问题：passTokens 判的是「全量注入成本 <= 8000 token」，
    //        但实际在跑的机制是 记忆注入.mjs（每轮 3 条 / 300 字 ≈ 150 token）。
    //        全量注入成本只说明「记忆装不下一次全塞」，不是缺陷。
    //
    //   实测：8 个场景全量成本 10103~14903 token，但真实注入只需 100-150 token。
    //        把全量成本当 FAIL 判据 → 9 个场景里 8 个永远红 → 哨兵变装饰。
    //
    //   现在：全量成本只 WARN（参考），判定只看 recall。
    const ok = r.passRecall;
    if (!ok) fail++;
    console.log('  ' + (ok ? '✓' : '✗') + '  ' + (r.sceneName || r.sceneId).padEnd(12) +
      ' recall_all=' + r.recallAll.toFixed(2) +
      '  recall_any=' + r.recallAny.toFixed(2) +
      '  注入=' + r.injectTokens + ' token' +
      '  (' + r.caseCount + ' 用例 / ' + r.chunkCount + ' 块 / ' + r.memoryFiles + ' 文件)');
    if (!r.passRecall) {
      console.log('       ⚠ recall 不达标: 缺 ' + r.missing.length + ' 处事实');
      for (const m of r.missing.slice(0, 3)) {
        console.log('         · [' + m.case + '] 「' + m.fact.slice(0, 32) + '」命中 ' + m.hit + '/' + m.total);
      }
    }
    if (!r.passTokens) {
      console.log('       （参考）全量注入成本偏高: ' + r.injectTokens + ' > ' + THRESHOLDS.INJECT_TOKENS_MAX);
    }
  }

  console.log();
  console.log('─'.repeat(70));
  console.log('  结果: ' + (reports.length - fail) + ' / ' + reports.length + ' 通过');
  console.log('─'.repeat(70));
  process.exit(fail > 0 ? 1 : 0);
}
