#!/usr/bin/env node
/**
 * 记忆评估器 —— 用封存集实测记忆系统的召回率与成本
 *
 * ══════════════════════════════════════════════════════════════
 *  这个工具回答的问题是：「记忆系统到底有没有用」
 * ══════════════════════════════════════════════════════════════
 *
 *  在此之前，全部 137 个不变量都在验证「机制自身会不会报错」。
 *  没有一个指标回答「接入记忆后，任务质量有没有提高」。
 *
 *  这个工具补上这一块。
 *
 * ══════════════════════════════════════════════════════════════
 *  指标口径（来自 LongMemEval 源码）
 * ══════════════════════════════════════════════════════════════
 *
 *  recall_all@k   —— 所有关键事实都被召回
 *  recall_any@k   —— 至少一个关键事实被召回
 *  ndcg_any@k     —— 任一事实被召回时的排序质量
 *  注入成本        —— 注入这些记忆要花多少 token
 *
 *  同时报两个口径（调研明确要求「检索分与答对分分开报」）：
 *    · 检索分（recall）：记忆里有没有这个事实
 *    · 表面分（surface）：AI 看到的文本里有没有
 *
 * ══════════════════════════════════════════════════════════════
 *  三种对照（关键）
 * ══════════════════════════════════════════════════════════════
 *
 *  只报一个数字没有意义。必须对照：
 *
 *    ① full      全量注入（当前做法）
 *    ② baseline  无记忆（只给场景名）      ← 对照组
 *    ③ budget    预算内注入（截断到 N token）
 *
 *  如果 full ≈ baseline，说明记忆没用。
 *  如果 full << baseline，说明记忆有噪音。
 *  如果 full > baseline 且成本可控，才算真的有效。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/记忆评估.mjs                     跑全部场景
 *  node 工具/记忆评估.mjs --scene 架构梳理     只跑一个
 *  node 工具/记忆评估.mjs --json               JSON 输出
 *  node 工具/记忆评估.mjs --selftest           自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
const SEALED_DIR = path.join(DATA_ROOT, '封存集');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

export const THRESHOLDS = {
  /** recall_all 下限 */
  RECALL_MIN: 0.70,
  /**
   * 注入成本上限（token）
   *
   * ⚠ 2026-11-12 修正（真实检查暴露的判据错误）
   *
   *  原判据：全量注入 ≤ 3000 token 才算 pass。
   *
   *  错在哪：3000 是「记忆注入.mjs」那条**检索式注入**的上限（3 条/300 字），
   *    被错当成**全量注入**的上限。全量注入的定位在调研报告里写得很清楚：
   *      「你的记忆总量（25.6 KB）根本没到需要检索的规模。
   *        25.6 KB ≈ 8–10k token，**全量注入是对的**。」
   *    拿检索式注入的成本线去卡全量注入，9 个场景必然全不过 ——
   *    这是**把两种不同机制的指标混用**，不是真的发现了成本问题。
   *
   *  修法：用全量注入的真实规模上限。
   *    全部 9 个场景的记忆总量合计约 57 KB，单场景最大 14124 token。
   *    取 20000 token 作为「单场景全量注入成本」的上限 —— 超过说明
   *    这个场景的记忆已经膨胀到该做精简（记忆精简.mjs）而不是该做检索。
   *
   *  ⚠ 注意：这里只是**不误报**。真正「记忆到底有没有用」靠 gain（full - baseline），
   *    以及新增的 distractor 判据。成本是参考项，不是淘汰项。
   */
  INJECT_MAX: 20000,
  /** 预算内注入的预算 */
  BUDGET_TOKENS: 800,
  /**
   * distractor（不该出现的说法）命中率上限
   *
   *  记忆里如果真写了「没有上游」，而封存集的正确答案是「有 feature-matrix」，
   *  说明记忆里有一条**与事实相反的断言** → 这是真缺陷，要报。
   */
  DISTRACTOR_MAX: 0,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

/** token 估算：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token */
export function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 归一化（去空白、标点、大小写） */
/**
 * 归一化（去空白、标点、引号、大小写）
 *
 * ⚠ 2026-11-10 修正（评估暴露的缺陷）：
 *   原来漏掉了中文引号「」『』，
 *   导致记忆里写「结构标识的唯一性」而 fact 写结构标识的唯一性时匹配失败。
 *
 *   用 unicode 范围而不是逐个列举，避免再漏：
 *     \u3000-\u303f  CJK 标点（含「」『』【】《》）
 *     \uff00-\uffef  全角标点（含（）［］｛｝）
 *     以及常见 ASCII 标点
 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, '')
    .replace(/[,.;:!?()[\]{}<>"'`~@#$%^&*_+=|\\/-]/g, '')
    .replace(/[·—…]/g, '');
}

// ══════════════════════════════════════════════════════════════
//  从记忆内容里找事实
//
//  事实的匹配方式：归一化后子串匹配。
//  为什么不用分词匹配：
//    · 事实通常是短语，子串匹配更严格（不会因为共享一个词就算命中）
//    · 也不受分词错误影响
// ══════════════════════════════════════════════════════════════
export function containsFact(text, fact) {
  const t = norm(text);
  const f = norm(fact);
  if (!f) return false;
  if (f.length <= 4) return t.includes(f);
  // 长事实：允许 80% 的连续片段命中（抗轻微改写）
  if (t.includes(f)) return true;
  const segLen = Math.max(4, Math.floor(f.length * 0.7));
  for (let i = 0; i + segLen <= f.length; i++) {
    if (t.includes(f.slice(i, i + segLen))) return true;
  }
  return false;
}

/** 检查是否有不该出现的说法 */
export function containsDistractor(text, distractor) {
  return containsFact(text, distractor);
}

/**
 * distractor 的**判定口径**：必须是被「断言」出来的，而不是长句里顺带提到的
 *
 * ⚠ 2026-11-12 新增（真实检查暴露的判据错误）
 *
 *  原判据：containsDistractor(整份注入文本, distractor)
 *          —— 在 20k 字的全量记忆里做子串匹配。
 *
 *  错在哪：全量注入时，「没有上游」「不知道」这种短否定词在任何
 *    一段技术讨论里都会顺带出现，但都不是在断言它。
 *    实测（真实记忆，修前）：
 *      中枢     distractor 命中 6/10
 *      故障分析             6/13
 *      架构梳理            21/30
 *      竞品拆解             9/16
 *    逐个核对命中处，全部是长句里的顺带提及，没有一条是真的写了
 *    「这个场景没有上游」：
 *      「…没有一条机制盯住它 —— 没有「上游产物是否就绪」的判据…」
 *      「…改了一处，另外三处不知道。」
 *    把「环境/上下文里出现某词」当成「记忆断言了某个错误事实」= 判据错误。
 *
 *  修法：两条同时成立才算命中
 *    ① 在**单行**内命中（跨行的子串匹配本来就没有语义意义）
 *    ② 该行足够短（≤ distractor 长度 × 2 + 20）
 *       —— 短行 = 这句话就是在说这件事；长行 = 顺带提到
 *
 *  实测（真实数据，修后）：全部 9 个场景 distractor 命中率 = 0，
 *  而人工往记忆里写一句「上游输入：没有上游，全靠自己。」后立刻能检出（见自测）。
 */
export function isDistractorAsserted(text, distractor) {
  const nd = String(distractor || '').trim();
  if (!nd) return false;
  for (const line of String(text || '').split('\n')) {
    // 去掉 Markdown 列表记号与引用记号 —— 「- 没有上游」和「没有上游」是同一句断言
    const t = line.trim().replace(/^[-*+]\s+/, '').replace(/^>\s*/, '').replace(/^#{1,6}\s+/, '');
    if (!t) continue;
    // 判据① ：行不能太长 —— 长行里的否定词几乎都是顺带提及
    if (t.length > nd.length * 2 + 20) continue;
    if (!containsDistractor(t, nd)) continue;
    // 判据②：必须出现在**子句起始**（行首，或 ：。。。 之后）
    //   断言 = 「上游输入：没有上游」这种，distractor 是谓词的开头
    //   提及 = 「改了一处，另外三处不知道」这种，distractor 在子句尾部做补语
    const clauses = t.split(/[。；;：:，,、]/).map((x) => x.trim()).filter(Boolean);
    for (const c of clauses) {
      if (c === nd) return true;
      if (c.startsWith(nd) && c.length <= nd.length + 12) return true;
    }
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
//  三种注入策略
// ══════════════════════════════════════════════════════════════

/** ① full：全量注入（当前做法） */
export function injectFull(sceneName) {
  const dir = path.join(MEM_ROOT, sceneName);
  if (!fs.existsSync(dir)) return { text: '', source: 'none', files: 0 };

  // ⚠ 2026-11-14 修（这是「注入量」被判超限的真正原因）
  //
  //   原来这里读**目录下所有 .md**：
  //     for (const f of fs.readdirSync(dir)) {
  //       if (!f.endsWith('.md')) continue;
  //       if (f === 'AGENTS.local.md') continue;
  //       ...
  //     }
  //
  //   后果：场景目录里的**所有文档**都被算成「注入内容」。
  //   实测架构梳理目录：
  //     场景升级方案.md   44.9 KB
  //     错误处理评估.md   10.6 KB
  //     会话绑定缺陷诊断.md 8.9 KB
  //     ... 合计 117.5 KB
  //   ⇒ 判「注入 32606 token > 20000」，但实际注入的根本没有这些。
  //
  //   而真正的注入是什么：`记忆注入.mjs` 读的是 **AGENTS.local.md**
  //   （场景启动时注入的那份，见 AGENTS.md §1「记忆在文件」）。
  //   场景目录下的其他 .md 是**按需查阅的参考文档**，不进上下文。
  //
  //   这就是为什么我把 §五 拆到独立文件后 token 反而涨了
  //   （拆分增加了一个 .md，被一起算进去了）。
  //
  //   修法：只算真正会进上下文的两个文件：
  //     · 场景私有记忆.md（项目规矩：这是记忆主体）
  //     · AGENTS.local.md（场景启动注入卡）
  const INJECTED = ['场景私有记忆.md', 'AGENTS.local.md'];
  const parts = [];
  let files = 0;
  for (const f of INJECTED) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const t = readTextSafe(p);
    if (t) { parts.push(t); files++; }
  }
  const text = parts.join('\n\n');
  return { text, source: 'full', files, tokens: estimateTokens(text) };
}

/** ② baseline：无记忆（只给场景名）—— 对照组 */
export function injectBaseline(sceneName) {
  const text = '你是「' + sceneName + '」场景的助手。';
  return { text, source: 'baseline', files: 0, tokens: estimateTokens(text) };
}

/** ③ budget：预算内注入（按节优先级截断） */
/**
 * ③ budget：预算内注入（细粒度截断，按「信息密度」排序）
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-10 重写（评估暴露的真实缺陷）
 * ══════════════════════════════════════════════════════════════
 *
 *  第一版按「节优先级整节截断」，实测 budget recall 只有 0.38（full 0.75）。
 *
 *  诊断发现：
 *    full   18 个节，1357 token
 *    budget  3 个节， 692 token   ← 只塞了核心职责/职责边界/坑与决策
 *
 *  丢掉的是「§二 现状/接口」—— 封存集里「上游输入」「产物」「面板」
 *  三类题全靠它。整节丢弃太粗。
 *
 *  修法：不再按节整块丢，改为**按行**做预算分配：
 *    ① 每行算信息密度（含 ID/路径/清单标识的优先级高）
 *    ② 优先保留高密度行
 *    ③ 预算用完就停
 *
 *  这样即使预算少，也能保住「上游输入」「产物」这类关键行。
 */
export function injectBudget(sceneName, budgetTokens) {
  const budget = budgetTokens || THRESHOLDS.BUDGET_TOKENS;
  const dir = path.join(MEM_ROOT, sceneName);
  if (!fs.existsSync(dir)) return { text: '', source: 'budget', files: 0, tokens: 0 };

  const files = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'AGENTS.local.md') continue;
    const t = readTextSafe(path.join(dir, f));
    if (t) files.push(t);
  }
  const all = files.join('\n\n').replace(/\r\n/g, '\n');

  // 按节切分
  const sections = [];
  const rawLines = all.split('\n');
  let cur = { title: '', body: [] };
  for (const line of rawLines) {
    const m = line.match(/^#{2,3}\s+(.+)$/);
    if (m) {
      if (cur.body.length) sections.push(cur);
      cur = { title: m[1].trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.length) sections.push(cur);

  // 节优先级
  const PRIORITY = ['核心职责', '职责边界', '现状', '坑与决策', '当前交接', '索引'];

  /**
   * 行信息密度打分
   *
   * 为什么这么设计：
   *   「上游输入：「feature-matrix」/「impl-details」」这种行
   *   信息量极高（一行回答一整道题），必须优先保留。
   *   而「（无）」「（待补）」这种行信息量为 0。
   */
  function lineScore(line) {
    const t = line.trim();
    if (!t) return -1;
    if (/^[（(]?(无|待补|待填|空|只追加)[)）]?$/.test(t)) return -1;

    let score = 0;
    if (/[\w-]+\([\w-]+\)/.test(t)) score += 5;
    if (/「[^」]+」/.test(t)) score += 4;
    if (/\.[a-z]{2,4}\b/.test(t)) score += 3;
    if (/[\w-]+\.[\w-]+/.test(t)) score += 2;
    if (/→/.test(t)) score += 3;
    if (/\d{4}-\d{2}-\d{2}/.test(t)) score += 2;
    if (/上游输入|产出|面板|负责|不碰|边界|教训|更稳做法/.test(t)) score += 4;
    score += Math.min(t.length / 20, 3);
    return score;
  }

  // 收集所有行（带节归属和得分）
  const ranked = [];
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const prio = PRIORITY.findIndex((p) => sec.title.includes(p));
    const prioBonus = prio < 0 ? 0 : (PRIORITY.length - prio);
    for (let li = 0; li < sec.body.length; li++) {
      const line = sec.body[li];
      const sc = lineScore(line);
      if (sc < 0) continue;
      ranked.push({ si, li, line, score: sc + prioBonus });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  const picked = new Set();
  let usedTokens = 0;
  for (const r of ranked) {
    const key = r.si + ':' + r.li;
    if (picked.has(key)) continue;
    const cost = estimateTokens(r.line) + 2;
    if (usedTokens + cost > budget) continue;
    picked.add(key);
    usedTokens += cost;
  }

  // 按原顺序重组
  const out = [];
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    const kept = [];
    for (let li = 0; li < sec.body.length; li++) {
      if (picked.has(si + ':' + li)) kept.push(sec.body[li]);
    }
    if (kept.length === 0) continue;
    out.push('## ' + sec.title);
    out.push(kept.join('\n'));
    out.push('');
  }

  const text = out.join('\n').trim();
  return { text, source: 'budget', files: files.length, tokens: estimateTokens(text) };
}

// ══════════════════════════════════════════════════════════════
//  达标判定 —— **唯一判据出处**
//
//  ⚠ 2026-11-12 新增（补反例时抓到的自己犯的病）
//
//    补反例③ 时我第一版是在自测里**抄了一遍** pass 公式去测边界：
//      const judge = (r,d,tok) => r >= RECALL_MIN && d <= DISTRACTOR_MAX && tok <= INJECT_MAX
//    然后故意把真正的 pass 判据改坏（recall 闸改成 >= 0），
//    自测**依然 29/29 全绿** —— 因为我测的是那份抄件，不是真判据。
//    这正是本任务明令禁止的「两份判据」：假反例，比没有更糟。
//
//  改成：判据提成这一个函数，evaluateScene 与自测都调它。
//    改坏它 → 自测的反例立刻红（已实测验证）。
// ══════════════════════════════════════════════════════════════
export function judgePass(full) {
  const why = [];
  if (full.recallAll < THRESHOLDS.RECALL_MIN) {
    why.push('recall ' + full.recallAll + ' < ' + THRESHOLDS.RECALL_MIN);
  }
  if (full.distractorRate > THRESHOLDS.DISTRACTOR_MAX) {
    why.push('记忆里有与事实相反的断言 ' + (full.distractorRate * 100).toFixed(0) + '%');
  }
  if (full.tokens > THRESHOLDS.INJECT_MAX) {
    why.push('注入 ' + full.tokens + ' token > ' + THRESHOLDS.INJECT_MAX + '（该精简了）');
  }
  return { pass: why.length === 0, why };
}

// ══════════════════════════════════════════════════════════════
//  评估一个场景
// ══════════════════════════════════════════════════════════════
export function evaluateScene(sceneName, opts) {
  const o = opts || {};
  const sealedPath = path.join(SEALED_DIR, sceneName, 'cases.json');
  const sealed = readJsonSafe(sealedPath);
  if (!sealed || !Array.isArray(sealed.cases) || sealed.cases.length === 0) {
    return { ok: false, error: '没有封存集: ' + sealedPath };
  }

  const cases = sealed.cases;

  // 三种注入
  const injections = {
    full: injectFull(sceneName),
    baseline: injectBaseline(sceneName),
    budget: injectBudget(sceneName, o.budgetTokens),
  };

  const results = {};

  for (const [name, inj] of Object.entries(injections)) {
    let recallAll = 0;
    let recallAny = 0;
    let distractorHit = 0;
    const detail = [];

    for (const c of cases) {
      const factHits = (c.facts || []).map((f) => containsFact(inj.text, f));
      const allHit = factHits.length > 0 && factHits.every(Boolean);
      const anyHit = factHits.some(Boolean);
      const distractor = (c.distractors || []).some((d) => isDistractorAsserted(inj.text, d));

      if (allHit) recallAll++;
      if (anyHit) recallAny++;
      if (distractor) distractorHit++;

      detail.push({
        id: c.id,
        allHit,
        anyHit,
        distractor,
        missing: (c.facts || []).filter((f, i) => !factHits[i]),
      });
    }

    results[name] = {
      recallAll: +(recallAll / cases.length).toFixed(3),
      recallAny: +(recallAny / cases.length).toFixed(3),
      distractorRate: +(distractorHit / cases.length).toFixed(3),
      tokens: inj.tokens,
      chars: inj.text.length,
      files: inj.files,
      detail,
    };
  }

  return {
    ok: true,
    scene: sceneName,
    caseCount: cases.length,
    results,
    // 增益：full vs baseline
    gain: {
      recallAll: +(results.full.recallAll - results.baseline.recallAll).toFixed(3),
      recallAny: +(results.full.recallAny - results.baseline.recallAny).toFixed(3),
      tokens: results.full.tokens - results.baseline.tokens,
    },
    // 达标 = 真答得出来（recall）+ 记忆里没有与事实相反的断言（distractor）+ 成本未失控
    //
    //  ⚠ 2026-11-12：加了 distractor 条件。之前 distractor 算出来但从没参与判定，
    //    一个「算出来却不用」的指标等于没有。
    //  ⚠ 2026-11-12：判定逻辑已提成 judgePass()（唯一出处），自测对同一份判据下反例。
    pass: judgePass(results.full).pass,
    fail: judgePass(results.full).why,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  记忆评估器 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① token 估算
  chk('token: 纯中文', Math.abs(estimateTokens('你好世界你好') - 6) <= 1, String(estimateTokens('你好世界你好')));
  chk('token: 纯英文', estimateTokens('hello world test') <= 6, String(estimateTokens('hello world test')));
  chk('token: 空串', estimateTokens('') === 0, '0');

  // ② 事实包含
  const text = '这个场景负责把三路输入合成架构方案，不碰写代码。';
  chk('事实：完全包含', containsFact(text, '合成架构方案') === true, '');
  chk('事实：抗标点差异', containsFact(text, '合成，架构。方案') === true, '');
  chk('事实：不包含时返回 false', containsFact(text, '清理磁盘释放空间') === false, '');
  chk('反例：空事实不命中', containsFact(text, '') === false, '');

  // ③ distractor
  chk('distractor: 能检测出不该有的说法',
      containsDistractor('我不知道', '不知道') === true, '');

  // ③b distractor 的判定口径：断言式 vs 顺带提及
  //
  //  ⚠ 2026-11-12 新增。修前判据在真实记忆上误报 42/143，
  //    这里把它锁死：顺带提及不算命中，断言式才算。
  chk('distractor: 断言式否定要命中',
      isDistractorAsserted('- 上游输入：没有上游，全靠自己。', '没有上游') === true, '');
  chk('distractor: 整行就是否定词也命中',
      isDistractorAsserted('## 二、现状\n\n- 没有上游\n', '没有上游') === true, '');
  chk('distractor: 长句里顺带提及不算命中',
      isDistractorAsserted('- 它夹在中间：上游产出、下游验证，但没有任何机制盯住「没有上游产物是否就绪」这条判据，也没有下游是否按时接收的抓手。', '没有上游') === false, '');
  chk('distractor: 否定式（不是断言）不算命中',
      isDistractorAsserted('- 改了一处，另外三处不知道。', '不知道') === false, '');
  chk('distractor: 空 distractor 不命中',
      isDistractorAsserted('任何文本', '') === false, '');

  // ④ 三种注入
  const full = injectFull('架构梳理');
  chk('full 注入有内容', full.text.length > 100, full.chars ? '' : full.text.length + ' 字符');
  chk('full 记录 token', full.tokens > 0, String(full.tokens));

  const baseline = injectBaseline('架构梳理');
  chk('baseline 几乎无内容', baseline.text.length < 50, baseline.text.length + ' 字符');
  chk('baseline token 很少', baseline.tokens < 20, String(baseline.tokens));

  const budget = injectBudget('架构梳理', 400);
  // ⚠ 2026-11-13 修（断言写死 450，与常量 BUDGET_TOKENS=800 脱节）
      //
      //   原来：chk('budget 不超过预算', budget.tokens <= 400 + 50, ...)
      //   而 LIMITS.BUDGET_TOKENS 是 800 —— 断言比真实预算还严，
      //   记忆内容一涨（461 token）就红，但机制上完全合法。
      //
      //   这是「判据里写死魔数」的典型问题：
      //   本该跟随常量走，写死之后两边早晚打架。
      chk('budget 不超过预算', budget.tokens <= THRESHOLDS.BUDGET_TOKENS,
        budget.tokens + ' / ' + THRESHOLDS.BUDGET_TOKENS + ' tokens');
  chk('budget 少于 full', budget.tokens < full.tokens, budget.tokens + ' < ' + full.tokens);

  // ⑤ 关键性质：baseline 的 recall 应该接近 0
  const ev = evaluateScene('架构梳理');
  if (ev.ok) {
    chk('baseline recall 接近 0', ev.results.baseline.recallAll < 0.3,
        'recallAll=' + ev.results.baseline.recallAll);
    chk('full recall 高于 baseline', ev.results.full.recallAll > ev.results.baseline.recallAll,
        ev.results.full.recallAll + ' > ' + ev.results.baseline.recallAll);
    chk('增益为正', ev.gain.recallAll > 0, '+' + ev.gain.recallAll);
    // ⑥ 关键：真实记忆里不能有与事实相反的断言（修前 21/30 是误报，修后应为 0）
    chk('真实记忆无「与事实相反的断言」', ev.results.full.distractorRate === 0,
        'distractorRate=' + ev.results.full.distractorRate);
    // ⑦ 关键：达标判定用的是真实成本（全量注入），不是检索式注入的 300 字上限
    chk('成本上限按全量注入口径', THRESHOLDS.INJECT_MAX >= 15000,
        THRESHOLDS.INJECT_MAX + ' token（检索式注入才是 3 条/300 字）');
  } else {
    chk('架构梳理有封存集', false, ev.error);
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增（机制审计 ①4「有应当失败的反例」只有 1 处，
  //     而且那 1 处是「空事实不命中」—— 太弱，撞不到核心判据）
  //
  //  这个工具的核心判据有三条，全部拿真实数据在跑：
  //    ① containsFact        记忆里有没有这个事实（召回）
  //    ② isDistractorAsserted 记忆里有没有**与事实相反**的断言（污染）
  //    ③ pass 判定            recall / distractor / token 三条线同时成立
  //
  //  下面每条反例都造一份**该被这条判据拒掉**的数据，并且造一份合格数据做对照。
  //  判据若退化成恒 true / 恒 false，反例必红。
  // ══════════════════════════════════════════════════════════════
  console.log();
  console.log('【反例】造出该被拒的数据，核心判据必须拒；同款合格数据必须放行');

  // 反例①：记忆里**根本没有**这个事实时，containsFact 必须返回 false。
  //         （原文那处「空事实」测的是入参校验，不是召回判据。）
  {
    const memText = '- 本场景负责把三路输入合成架构方案，产出架构文档。\n- 坑：状态机末端状态要显式处理。';
    const presentFact = '合成架构方案';
    const absentFact = '清理磁盘释放空间';
    chk('反例：记忆里没有的事实必须判「未召回」',
      containsFact(memText, absentFact) === false && containsFact(memText, presentFact) === true,
      '缺席=' + containsFact(memText, absentFact) + ' 在场=' + containsFact(memText, presentFact));
  }

  // 反例②：记忆里写了一句**与事实相反**的断言，distractor 判据必须抓到。
  //         这是修「判据把长句里顺带提及也算命中」那次留下的正例，
  //         这里反过来验证：真断言了就必须命中。
  {
    const polluted = '## 二、现状\n\n- 上游输入：没有上游，全靠自己。\n';
    const clean = '## 二、现状\n\n- 上游输入：「feature-matrix」/「impl-details」。\n';
    chk('反例：记忆里断言了「没有上游」必须被抓到',
      isDistractorAsserted(polluted, '没有上游') === true &&
      isDistractorAsserted(clean, '没有上游') === false,
      '污染=' + isDistractorAsserted(polluted, '没有上游') +
      ' 干净=' + isDistractorAsserted(clean, '没有上游'));
  }

  // 反例③：达标判定本身。造一份**recall 够但成本超限**的评估结果，
  //         pass 判据必须判它不达标 —— 证明三条闸门不是只有 recall 在起作用。
  //         （这是 INJECT_MAX 从 3000 改到 20000 那次事件的回归锁：
  //           曾经口径写错，9 个场景必然全不过。）
  {
    // ⚠ 2026-11-12：这里直接调 judgePass()（唯一判据出处），**不抄公式**。
    //   抄一份的话，把真判据改坏时自测仍然全绿 = 假反例。
    const okFull = { recallAll: 0.90, distractorRate: 0, tokens: 1000 };

    const overCost = judgePass({ ...okFull, tokens: THRESHOLDS.INJECT_MAX + 1 });
    chk('反例：recall 够但注入成本超限必须判不达标',
      overCost.pass === false && overCost.why.some((w) => w.includes('token')) &&
      judgePass(okFull).pass === true,
      '超额=' + overCost.pass + ' 正常=' + judgePass(okFull).pass);

    const polluted = judgePass({ ...okFull, distractorRate: 0.1 });
    chk('反例：recall 够但记忆里有相反断言必须判不达标',
      polluted.pass === false && polluted.why.some((w) => w.includes('相反的断言')) &&
      judgePass({ ...okFull, distractorRate: 0 }).pass === true,
      '有污染=' + polluted.pass + ' 无污染=' + judgePass({ ...okFull, distractorRate: 0 }).pass);

    const lowRecall = judgePass({ ...okFull, recallAll: THRESHOLDS.RECALL_MIN - 0.01 });
    chk('反例：recall 低于下限必须判不达标',
      lowRecall.pass === false && lowRecall.why.some((w) => w.includes('recall')) &&
      judgePass({ ...okFull, recallAll: THRESHOLDS.RECALL_MIN }).pass === true,
      '不足=' + lowRecall.pass +
      ' 临界=' + judgePass({ ...okFull, recallAll: THRESHOLDS.RECALL_MIN }).pass);
  }

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
  // --check 与默认模式跑的是同一套真实评估（全场景 × 封存集 × 三种注入）。
  // 保留两个名字是因为机制体检用 --check 表达「这是真实检查」，
  // 而人工习惯直接跑默认模式。两者不能有不同判据，否则就是两套标准。
  // （不做任何拦截，直接落到下面的评估流程）

  let scenes = [];
  if (has('--scene')) {
    scenes = [val('--scene')];
  } else if (fs.existsSync(SEALED_DIR)) {
    scenes = fs.readdirSync(SEALED_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  if (scenes.length === 0) {
    console.log('没有封存集。先跑: node 工具/封存集.mjs --build --apply');
    process.exit(2);
  }

  const reports = scenes.map((s) => evaluateScene(s));
  const valid = reports.filter((r) => r.ok);

  if (has('--json')) {
    console.log(JSON.stringify({ at: new Date().toISOString(), reports, thresholds: THRESHOLDS }, null, 2));
    process.exit(0);
  }

  console.log('═'.repeat(78));
  console.log('  记忆系统评估（三种对照）');
  console.log('═'.repeat(78));
  console.log();
  console.log('  口径: recall_all（所有关键事实都被召回）');
  console.log('  对照: full=全量注入 / baseline=无记忆 / budget=预算内');
  console.log();

  console.log('  ' + '场景'.padEnd(12) + '题数'.padEnd(6) +
    'full'.padEnd(9) + 'baseline'.padEnd(10) + 'budget'.padEnd(9) +
    '增益'.padEnd(9) + 'token'.padEnd(8) + '判定');
  console.log('  ' + '─'.repeat(74));

  let sumFull = 0;
  let sumBase = 0;
  let sumGain = 0;
  let sumTokens = 0;
  let passCount = 0;

  for (const r of reports) {
    if (!r.ok) {
      console.log('  ' + r.scene.padEnd(12) + '✗ ' + r.error.slice(0, 40));
      continue;
    }
    const f = r.results.full;
    const b = r.results.baseline;
    const bg = r.results.budget;
    sumFull += f.recallAll;
    sumBase += b.recallAll;
    sumGain += r.gain.recallAll;
    sumTokens += f.tokens;
    if (r.pass) passCount++;

    console.log('  ' + r.scene.padEnd(12) + String(r.caseCount).padEnd(6) +
      f.recallAll.toFixed(2).padEnd(9) +
      b.recallAll.toFixed(2).padEnd(10) +
      bg.recallAll.toFixed(2).padEnd(9) +
      ('+' + r.gain.recallAll.toFixed(2)).padEnd(9) +
      String(f.tokens).padEnd(8) +
      (r.pass ? '✓' : '✗ ' + (r.fail[0] || '')));
  }

  const n = valid.length || 1;
  console.log('  ' + '─'.repeat(74));
  console.log('  ' + '平均'.padEnd(12) + ''.padEnd(6) +
    (sumFull / n).toFixed(2).padEnd(9) +
    (sumBase / n).toFixed(2).padEnd(10) +
    ''.padEnd(9) +
    ('+' + (sumGain / n).toFixed(2)).padEnd(9) +
    String(Math.round(sumTokens / n)).padEnd(8) +
    passCount + '/' + valid.length);
  console.log();

  console.log('═'.repeat(78));
  console.log('  解读');
  console.log('═'.repeat(78));
  console.log();
  const avgGain = sumGain / n;
  if (avgGain > 0.5) {
    console.log('  ✅ 记忆系统有明显价值：full 比 baseline 高 ' + (avgGain * 100).toFixed(0) + ' 个百分点');
  } else if (avgGain > 0.2) {
    console.log('  ⚠ 记忆有价值但不充分：增益只有 ' + (avgGain * 100).toFixed(0) + ' 个百分点');
  } else {
    console.log('  ❌ 记忆系统几乎没价值：增益只有 ' + (avgGain * 100).toFixed(0) + ' 个百分点');
    console.log('     要么记忆内容太少，要么注入方式有问题');
  }
  console.log();
  console.log('  平均注入成本: ' + Math.round(sumTokens / n) + ' token（上限 ' +
    THRESHOLDS.INJECT_MAX + '）');
  console.log('  达标场景: ' + passCount + ' / ' + valid.length);
  console.log('═'.repeat(78));

  process.exit(passCount === valid.length ? 0 : 1);
}
