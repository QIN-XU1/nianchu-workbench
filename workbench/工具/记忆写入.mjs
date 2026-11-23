#!/usr/bin/env node
/**
 * 记忆写入协议 —— ADD / UPDATE / DELETE / NOOP 四选一
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么要这个（调研点名的架构级缺陷）
 * ══════════════════════════════════════════════════════════════
 *
 *  依据 Mem0 论文（arXiv 2504.19413）：
 *    "写入 = LLM 选 ADD/UPDATE/DELETE/NOOP"
 *    LOCOMO 上 LLM-judge 比 OpenAI 相对高 26%，p95 延迟低 91%，token 省 >90%
 *
 *  根本问题（另一篇 arXiv 2610.36308）：
 *    把一条无关证据换成一条**过期的竞争事实**，
 *    准确率从 100% 掉到 44.6%。
 *    检索预算从 64→512 token，准确率反而从 45% 掉到 32%。
 *
 *  也就是说：**只追加 = 结构性制造过期事实**。
 *  记忆越多，命中过期事实的概率越高，准确率越低。
 *
 * ══════════════════════════════════════════════════════════════
 *  四种操作
 * ══════════════════════════════════════════════════════════════
 *
 *  ADD     新增事实（记忆里没有类似的）
 *  UPDATE  更新已有事实（有类似的，但内容变了 → 替换而不是并存）
 *  DELETE  删除已失效事实（明确被推翻）
 *  NOOP    不写（已有相同或更好的表述，别灌水）
 *
 *  ⚠ 关键：NOOP 是最重要的一种。
 *    AI 在闭环里自己说过：
 *      「反复派发"追加经验"类任务时，要防"为闭环而灌水"。
 *        记忆的价值在密度、不在条数；
 *        没有真新结论就宁可合并，别为满足闭环而造数。」
 *    这个工具让 NOOP 成为一个正式的、被鼓励的选择。
 *
 * ══════════════════════════════════════════════════════════════
 *  怎么判断该用哪个（相似度 + 冲突检测）
 * ══════════════════════════════════════════════════════════════
 *
 *  纯本地算法（不调 LLM，可复现）：
 *    ① 对新事实做 2-gram 分词
 *    ② 与 §五 每条已有经验算 Jaccard 相似度
 *    ③ 相似度 >= 0.75 → 可能是 UPDATE 或 NOOP
 *        · 新内容包含旧内容的全部要点 → NOOP（旧的是子集）
 *        · 否则 → UPDATE
 *    ④ 相似度 0.45~0.75 → 相关但不重复 → ADD（可能是补充）
 *    ⑤ 明确的「作废」「推翻」「不再适用」关键词 → DELETE 候选
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/记忆写入.mjs --scene 架构梳理 --text "新经验..."           判定该用哪个操作
 *  node 工具/记忆写入.mjs --scene 架构梳理 --text "..." --apply         真的写
 *  node 工具/记忆写入.mjs --scene 架构梳理 --text "..." --op add --apply 强制指定操作
 *  node 工具/记忆写入.mjs --scene 架构梳理 --list                       列出现有经验
 *  node 工具/记忆写入.mjs --selftest                                    自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM_ROOT = path.join(WB, '数据', '.dsh', '场景记忆');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  阈值（写死，可测）
// ══════════════════════════════════════════════════════════════
export const THRESHOLDS = {
  /**
   * ⚠ 2026-11-10 重写：从「Jaccard 相似度」改为「containment 包含度」
   *
   *  真实数据实测证明 Jaccard 不适用（见 decideOp 的注释）：
   *    完全重复 Jaccard 0.293 / 同事实扩展 Jaccard 0.408
   *    → 都会被误判成 ADD，导致记忆里并存多个版本 = 过期事实。
   *
   *  containment 的实测值：
   *    完全重复 0.935 / 同事实扩展 0.875 / 全新事实 0.05
   *    → 判别力足够。
   */

  /** forward（新被旧解释）>= 这个 → NOOP（别灌水） */
  NOOP_FORWARD: 0.85,
  /** forward >= 这个 → UPDATE（同一事实的更新版） */
  UPDATE_FORWARD: 0.60,
  /** backward（旧被新覆盖）>= 这个且 forward >= 0.30 → UPDATE */
  UPDATE_BACKWARD: 0.80,
  /** forward >= 这个 → 相关内容（ADD 时提示） */
  RELATED: 0.45,
  /**
   * NOOP 的第二个条件：backward 必须 <= 这个
   *
   *  实测（真实记忆）：
   *    完全重复:   forward 0.935  backward 0.299
   *    同事实扩展: forward 0.875  backward 0.433
   *
   *  只看 forward 会把两者都判成 NOOP，但「同事实扩展」带了新信息
   *  （「更稳做法：给每节固定唯一锚点 id」），NOOP 会丢掉它。
   *
   *  backward 高 = 新内容覆盖了旧条目更多要点 = 有新信息 → 不该 NOOP。
   *  取 0.38 作为分界（0.299 < 0.38 < 0.433）。
   */
  NOOP_BACKWARD_MAX: 0.38,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

/** 中文 2-gram + 英文词 */
export function tokenize(s) {
  const out = new Set();
  const str = String(s || '');
  for (const seg of (str.match(/[\u4e00-\u9fff]+/g) || [])) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of (str.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [])) {
    out.add(w.toLowerCase());
  }
  return out;
}

/** Jaccard 相似度 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ══════════════════════════════════════════════════════════════
//  解析 §五 的条目
//
//  条目格式（现有）：
//    - 2026-11-10：**标题**
//      正文...
//      → 教训：...
//      → 更稳做法：...
// ══════════════════════════════════════════════════════════════
export function parsePitEntries(md) {
  const norm = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = norm.split('\n');

  // 找 §五 节
  //
  // ⚠ 2026-11-12 修正（真实检查暴露的缺陷：中枢的 6 条经验读不出来）
  //
  //  原判据：节尾 = 第一个 /^#{2,3}\s/ 的行。
  //          —— 把 `###` 三号标题也当成「节结束」。
  //
  //  错在哪：中枢的 §五 是这样写的：
  //      ## 五、坑与决策
  //      ### 2026-11-10 · 记忆神经元插件的三个关键教训
  //      1. ...
  //      - 2026-11-12：**销账不看执行是否真完成导致假闭环** ...
  //    `###` 一出现就判节尾 → 节内只剩 1 行 → 解析出 0 条经验。
  //    实测：中枢 §五 有 6 条真实经验，工具读出 0 条。
  //
  //  修法：节尾只认「## （二级）」或更高级标题，`###` 属于节内子标题，不截断。
  //        这与 Markdown 的层级语义一致：### 是 ## 的子节。
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,3}\s*.*坑与决策/.test(lines[i])) { start = i; continue; }
    // 只有 level<=2 的标题才是节边界
    if (start >= 0 && /^#{1,2}\s/.test(lines[i]) && i > start) { end = i; break; }
  }
  if (start < 0) return { entries: [], start: -1, end: -1, lines };

  // 切条目（以 "- " 开头且不是缩进续行）
  const entries = [];
  let cur = null;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (/^-\s+/.test(line)) {
      if (cur) entries.push(cur);
      cur = { startLine: i, lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) entries.push(cur);

  for (const e of entries) {
    e.text = e.lines.join('\n').trim();
    e.tokens = tokenize(e.text);
    // 提取标题（**...** 或冒号后第一句）
    const m = e.text.match(/\*\*(.+?)\*\*/);
    e.title = m ? m[1] : e.text.split('\n')[0].slice(0, 40);
  }

  return { entries, start, end, lines };
}

// ══════════════════════════════════════════════════════════════
//  判定操作（ADD / UPDATE / DELETE / NOOP）
// ══════════════════════════════════════════════════════════════
/**
 * 判定操作（ADD / UPDATE / DELETE / NOOP）
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-10 重写（真实数据暴露的缺陷）
 * ══════════════════════════════════════════════════════════════
 *
 *  第一版用「Jaccard 相似度」，实测在真实记忆上完全失效：
 *
 *    1. 完全重复（改写措辞）   → Jaccard 0.293 → 被判 ADD  ✗
 *    2. 同事实扩展（补充细节） → Jaccard 0.408 → 被判 ADD  ✗
 *
 *  根因：Jaccard 的分母是「两个集合的并集」。
 *  记忆条目动辄 100+ 字 → 并集很大 → 即使内容高度重合，分数也很低。
 *  **Jaccard 适合短文本，不适合长文本的包含关系判断。**
 *
 *  实测什么指标有判别力（真实数据）：
 *
 *    完全重复:   新被旧覆盖 0.935
 *    同事实扩展: 新被旧覆盖 0.875
 *    全新事实:   新被旧覆盖 ~0.05
 *
 *  → 「新内容有多少 token 能在旧条目里找到」（containment）
 *    才是正确判据。它回答的是：
 *      「这条新记忆，我已经知道多少了？」
 *
 *  所以重写为 containment 优先：
 *
 *    forward  = 新内容的 token 有多少在旧条目里  → 「我已经知道了吗」
 *    backward = 旧条目的 token 有多少在新内容里  → 「旧的是新的子集吗」
 *
 *    forward >= 0.85              → NOOP（几乎全知道，别灌水）
 *    forward >= 0.60              → UPDATE（大部分知道，同一事实的更新）
 *    backward >= 0.80 且 forward >= 0.30 → UPDATE（新覆盖旧的）
 *    其余                         → ADD（新事实）
 */
export function decideOp(newText, existingEntries, thresholds) {
  const th = thresholds || THRESHOLDS;
  const newTokens = tokenize(newText);

  // 明确的删除/作废意图
  //
  // ⚠ 2026-11-12 修正（真实数据暴露的判据错误）
  //
  //  原判据：newText 里出现「作废|推翻|不再适用|已失效|…」任一关键词 → 有删除意图。
  //
  //  错在哪：这些词在**描述机制本身**时也会出现，不是对记忆下指令。
  //    真实反例（中枢 §五 第 1 条经验，原样重写自己）：
  //      「…执行未完成（lastTurnDone=false）的单禁止销账只能打回或**作废**。」
  //    这里的「作废」是描述销账动作，不是「把这条经验作废」。
  //    实测后果：把一条经验原样复述回去，被判成 DELETE —— 会误删真实经验。
  //
  //  修法：删除意图必须**指向已有记忆**才成立。
  //    ① 关键词附近 40 字内要有指代词（之前/前面/上文/那条/这条/前文/此前…），
  //       或者整条就是一句元指令（特此更正/纠正前文）；
  //    ② 然后才去匹配它指向哪一条。
  //
  //  这样「之前的『状态机…』这条经验已失效，特此更正」仍然判 DELETE（自测覆盖），
  //  而「打回或作废」这种机制描述不再误触发。
  const DELETE_WORDS = /(作废|推翻|不再适用|已失效|废弃|不再单独保留|不再保留)/;
  const META_REF = /(之前|前面|先前|上面|上文|前文|此前|刚才|原来那条|上一条|那条|这条|该条|这条经验|那条经验|以上)/;
  const META_SELF = /(特此更正|纠正前文)/;

  const deleteIntent = (function () {
    if (!META_SELF.test(newText) && !DELETE_WORDS.test(newText)) return false;
    if (META_SELF.test(newText)) return true;
    const m = newText.match(DELETE_WORDS);
    if (!m) return false;
    const i = m.index;
    const near = newText.slice(Math.max(0, i - 40), i + m[0].length + 40);
    return META_REF.test(near);
  })();

  const scored = existingEntries.map((e) => {
    // forward：新内容有多少能被旧条目解释
    let fw = 0;
    if (newTokens.size > 0) {
      let hit = 0;
      for (const t of newTokens) if (e.tokens.has(t)) hit++;
      fw = hit / newTokens.size;
    }
    // backward：旧条目有多少被新内容覆盖
    let bw = 0;
    if (e.tokens.size > 0) {
      let hit = 0;
      for (const t of e.tokens) if (newTokens.has(t)) hit++;
      bw = hit / e.tokens.size;
    }
    return {
      entry: e,
      sim: jaccard(newTokens, e.tokens),   // 保留供参考
      forward: fw,
      backward: bw,
    };
  }).sort((a, b) => b.forward - a.forward);

  const best = scored[0] || null;

  const cands = scored.slice(0, 3).map((s) => ({
    title: s.entry.title,
    sim: +s.sim.toFixed(3),
    forward: +s.forward.toFixed(3),
    backward: +s.backward.toFixed(3),
  }));

  // ── DELETE：明确推翻 ──
  //
  //  自测抓到的缺陷：原来要求 sim >= RELATED(0.45)，
  //  但「之前那条『xxx』已失效」只是**引用标题**，相似度很低 → 判不成 DELETE。
  //
  //  修法：DELETE 不依赖整体相似度，检查「是否明显指向前文」。
  if (deleteIntent) {
    let bestRef = null;
    let bestRefScore = 0;
    let refBy = '';
    for (const e of existingEntries) {
      // ① 新内容引用了这条的标题（取标题前 10 字）
      const titleCore = String(e.title || '').replace(/[**「」『』""'']/g, '').trim();
      if (titleCore.length >= 6 && newText.includes(titleCore.slice(0, 10))) {
        bestRef = e;
        bestRefScore = 1.0;
        refBy = '标题引用';
        break;
      }
      // ② 否则取 forward 最高的
      const s2 = scored.find((x) => x.entry === e);
      if (s2 && s2.forward > bestRefScore) {
        bestRefScore = s2.forward;
        bestRef = e;
        refBy = '内容相似';
      }
    }

    if (bestRef && (bestRefScore >= th.RELATED || bestRefScore === 1.0)) {
      return {
        op: 'delete',
        target: bestRef,
        similarity: +bestRefScore.toFixed(3),
        reason: '新内容含作废/推翻意图（' + refBy + '），指向「' + bestRef.title + '」',
        alternatives: cands,
      };
    }
    // 有作废意图但无对应条目 → 不删，走 ADD（记下这个更正本身）
  }

  // ── NOOP：新内容几乎全被旧条目解释，且没带来新信息 ──
  //
  //  ⚠ 2026-11-10 二次修正（真实数据暴露）
  //
  //    第一版只看 forward >= 0.85。实测两案例：
  //      完全重复:   forward 0.935  backward 0.299
  //      同事实扩展: forward 0.875  backward 0.433   ← 都判成 NOOP ✗
  //
  //    问题：NOOP 会丢掉新内容（新内容加了「更稳做法：给每节固定唯一锚点 id」）。
  //
  //    区分点：backward（旧条目被新内容覆盖的比例）
  //      完全重复 0.299 → 只是换说法，没新信息 → NOOP 对
  //      同事实扩展 0.433 → 覆盖了旧的更多要点，带新信息 → 应 UPDATE
  //
  //  ⚠ 边界情况（自测抓到的）：
  //    如果新旧内容**逐 token 完全一致**，forward 和 backward 都是 1.0，
  //    会被上面的 backward 条件排除 → 判成 UPDATE（其实什么都没变）。
  //    所以完全一致要优先判 NOOP。
  const identical = best && best.forward >= 0.99 && best.backward >= 0.99;

  if (identical) {
    return {
      op: 'noop',
      target: best.entry,
      similarity: +best.forward.toFixed(3),
      reason: '与「' + best.entry.title + '」内容完全一致 → 不写入',
      alternatives: cands,
    };
  }

  if (best && best.forward >= th.NOOP_FORWARD && best.backward <= th.NOOP_BACKWARD_MAX) {
    return {
      op: 'noop',
      target: best.entry,
      similarity: +best.forward.toFixed(3),
      reason: '新内容 ' + (best.forward * 100).toFixed(0) + '% 已被「' + best.entry.title +
        '」覆盖且旧内容被覆盖仅 ' + (best.backward * 100).toFixed(0) + '% → 无新信息，别灌水',
      alternatives: cands,
    };
  }

  // ── UPDATE：同一事实的更新版 ──
  if (best && (best.forward >= th.UPDATE_FORWARD ||
      (best.backward >= th.UPDATE_BACKWARD && best.forward >= 0.30))) {
    return {
      op: 'update',
      target: best.entry,
      similarity: +best.forward.toFixed(3),
      reason: '与「' + best.entry.title + '」是同一事实（新被旧解释 ' +
        (best.forward * 100).toFixed(0) + '% / 旧被新覆盖 ' + (best.backward * 100).toFixed(0) +
        '%）→ 应替换而非并存',
      alternatives: cands,
    };
  }

  // ── ADD：新事实 ──
  return {
    op: 'add',
    target: null,
    similarity: best ? +best.forward.toFixed(3) : 0,
    reason: best
      ? '最相似条目也只能解释新内容的 ' + (best.forward * 100).toFixed(0) +
        '%（低于 ' + (th.UPDATE_FORWARD * 100) + '%）→ 是新事实'
      : '记忆里还没有条目',
    related: best && best.forward >= th.RELATED ? cands : [],
  };
}

// ══════════════════════════════════════════════════════════════
//  执行写入
// ══════════════════════════════════════════════════════════════
export function applyOp(md, decision, newText, dateStr) {
  const parsed = parsePitEntries(md);
  const norm = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = norm.split('\n');

  const stamp = dateStr || new Date().toISOString().slice(0, 10);
  // 新条目：如果 newText 已经带日期前缀就不重复加
  const body = /^-?\s*\d{4}-\d{2}-\d{2}/.test(newText.trim())
    ? newText.trim()
    : '- ' + stamp + '：' + newText.trim();
  const newEntryLines = body.split('\n');

  if (decision.op === 'noop') {
    return { changed: false, md: norm, reason: 'NOOP：不写入' };
  }

  if (decision.op === 'add') {
    if (parsed.start < 0) {
      // 没有 §五 节，追加到文件末尾
      return {
        changed: true,
        md: norm.trimEnd() + '\n\n## 五、坑与决策（只追加）\n\n' + newEntryLines.join('\n') + '\n',
        reason: '新建 §五 节并写入',
      };
    }
    // 插到 §五 节末尾（end 之前，跳过尾部空行）
    let insertAt = parsed.end;
    while (insertAt > parsed.start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    const out = [...lines];
    out.splice(insertAt, 0, '', ...newEntryLines);
    return { changed: true, md: out.join('\n'), reason: '追加到 §五 末尾' };
  }

  if (decision.op === 'update') {
    const t = decision.target;
    if (!t) return { changed: false, md: norm, reason: 'UPDATE 没有目标条目' };
    // 替换目标条目的全部行
    const out = [...lines];
    const rep = body.split('\n');
    out.splice(t.startLine, t.lines.length, ...rep);
    return { changed: true, md: out.join('\n'), reason: '替换「' + t.title + '」' };
  }

  if (decision.op === 'delete') {
    const t = decision.target;
    if (!t) return { changed: false, md: norm, reason: 'DELETE 没有目标条目' };
    const out = [...lines];
    out.splice(t.startLine, t.lines.length);
    return { changed: true, md: out.join('\n'), reason: '删除「' + t.title + '」' };
  }

  return { changed: false, md: norm, reason: '未知操作' };
}

/** 场景名 → 记忆文件路径 */
export function sceneMemFile(sceneName) {
  // 支持中文名或 id
  if (fs.existsSync(path.join(MEM_ROOT, sceneName))) {
    return path.join(MEM_ROOT, sceneName, '场景私有记忆.md');
  }
  if (fs.existsSync(SCEN_DIR)) {
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, f)));
        if (j.id === sceneName || j.name === sceneName) {
          return path.join(MEM_ROOT, j.name || sceneName, '场景私有记忆.md');
        }
      } catch { /* ignore */ }
    }
  }
  return path.join(MEM_ROOT, sceneName, '场景私有记忆.md');
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  记忆写入协议 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ── 准备 ──
  const md = [
    '# 场景私有记忆',
    '',
    '## §〇 当前交接',
    '',
    '- 上次做完 A',
    '',
    '## 五、坑与决策（只追加）',
    '',
    '- 2026-11-09：**状态机末端状态要显式处理。**',
    '  真实 bug：健康度统计只认 acked，漏了 closed。',
    '  → 教训：状态机判断要用事实字段。',
    '',
    '- 2026-11-10：**派单要真投递不能只标记。**',
    '  真实案例：派单只改状态没真发。',
    '  → 教训：投递是接口，不是状态。',
    '',
    '## 八、项目索引',
    '',
    '- 无',
  ].join('\n');

  const parsed = parsePitEntries(md);
  chk('能解析出 2 条经验', parsed.entries.length === 2, parsed.entries.length + ' 条');
  chk('提取了标题', parsed.entries[0]?.title?.includes('状态机') === true, parsed.entries[0]?.title);

  // ── ADD：全新事实 ──
  const d1 = decideOp('今天天气很好适合出门散步', parsed.entries);
  chk('全新内容 → ADD', d1.op === 'add', d1.op + ' sim=' + d1.similarity);

  // ── NOOP：完全重复 ──
  const dupText = '状态机末端状态要显式处理。真实 bug：健康度统计只认 acked，漏了 closed。教训：状态机判断要用事实字段。';
  const d2 = decideOp(dupText, parsed.entries);
  chk('几乎相同 → NOOP', d2.op === 'noop', d2.op + ' sim=' + d2.similarity + ' cov=' + (d2.target ? '有' : '无'));

  // ── UPDATE：同一事实的新版本 ──
  const updateText = '状态机末端状态要显式处理。真实 bug：健康度统计只认 acked，漏了 closed 和 cancelled 两种。教训：状态机判断要用事实字段而非状态字符串，并且要覆盖所有终态。';
  const d3 = decideOp(updateText, parsed.entries);
  chk('同事实扩展 → UPDATE 或 NOOP', d3.op === 'update' || d3.op === 'noop', d3.op + ' sim=' + d3.similarity);

  // ── DELETE：明确推翻 ──
  const deleteText = '之前的「状态机末端状态要显式处理」这条经验已失效，因为那套状态机已经重写了。特此更正。';
  const d4 = decideOp(deleteText, parsed.entries);
  chk('含作废意图 → DELETE', d4.op === 'delete', d4.op);

  // ── 反例：无关内容不该被误判为 UPDATE/DELETE ──
  const unrelated = '磁盘清理时要注意先备份用户文档';
  const d5 = decideOp(unrelated, parsed.entries);
  chk('反例：无关内容 → ADD', d5.op === 'add', d5.op + ' sim=' + d5.similarity);

  // ── 反例：作废意图但无相关条目 → 不该 DELETE ──
  const deleteNoTarget = '今天天气很好，不算作废任何东西';
  const d6 = decideOp(deleteNoTarget, parsed.entries);
  chk('反例：作废意图但无相关条目 → 不是 DELETE', d6.op !== 'delete', d6.op);

  // ── 执行 ADD ──
  const addResult = applyOp(md, { op: 'add' }, '新发现：清理磁盘前必须备份', '2026-11-10');
  chk('ADD 会改动文件', addResult.changed === true, '');
  chk('ADD 后含新内容', addResult.md.includes('清理磁盘前必须备份'), '');
  chk('ADD 不破坏原有条目', addResult.md.includes('状态机末端状态要显式处理'), '');

  // ── 执行 NOOP ──
  const noopResult = applyOp(md, { op: 'noop' }, 'x', '2026-11-10');
  chk('NOOP 不改动文件', noopResult.changed === false, '');

  // ── 执行 UPDATE ──
  const parsed2 = parsePitEntries(md);
  const updResult = applyOp(md, { op: 'update', target: parsed2.entries[0] }, '更新后的内容替换旧条目', '2026-11-10');
  chk('UPDATE 会改动文件', updResult.changed === true, '');
  chk('UPDATE 后旧内容消失', !updResult.md.includes('健康度统计只认 acked'), '');
  chk('UPDATE 后含新内容', updResult.md.includes('更新后的内容替换旧条目'), '');
  chk('UPDATE 不影响其它条目', updResult.md.includes('派单要真投递'), '');

  // ── 执行 DELETE ──
  const delResult = applyOp(md, { op: 'delete', target: parsed2.entries[0] }, '', '2026-11-10');
  chk('DELETE 会改动文件', delResult.changed === true, '');
  chk('DELETE 后目标消失', !delResult.md.includes('状态机末端状态要显式处理'), '');
  chk('DELETE 保留其它条目', delResult.md.includes('派单要真投递'), '');

  // ── 反例：DELETE 无目标不崩 ──
  const delNoTarget = applyOp(md, { op: 'delete', target: null }, '', '2026-11-10');
  chk('反例：DELETE 无目标不崩', delNoTarget.changed === false, '');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。此前只有 --selftest，全程用构造的 Markdown 跑，
//    所以下面两个只在真实数据上出现的缺陷一个都没抓到：
//      ① §五 里出现 ### 子标题 → 节被提前截断 → 中枢 6 条经验读不出来
//      ② 「作废」作为机制描述出现 → 被当成删除意图 → 原样重写会被误判 DELETE
//
//  判据（对每个真实场景的 §五）：
//    ① §五 节必须能被解析出条目（节存在但 0 条 = 解析器坏了）
//    ② 跑一遍「判定逻辑」：把每条经验原样重写回去，必须判 NOOP
//       —— 原样重写还判 ADD/UPDATE 说明阈值失效（永远判 ADD = 只追加）
//       —— 原样重写判 DELETE 说明删除意图误触发（会误删真实经验）
//    ③ 每条经验必须带日期前缀（`- YYYY-MM-DD：`），否则无法判断新鲜度
//       （「- （只追加）」这种说明行不算经验，跳过）
// ══════════════════════════════════════════════════════════════
export function checkReal() {
  const problems = [];
  const rows = [];
  if (!fs.existsSync(MEM_ROOT)) {
    return { ok: false, checked: 0, rows, problems: ['记忆根目录不存在: ' + MEM_ROOT] };
  }

  for (const d of fs.readdirSync(MEM_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const file = path.join(MEM_ROOT, d.name, '场景私有记忆.md');
    const md = readTextSafe(file);
    if (md === null) {
      rows.push({ scene: d.name, skipped: true, why: '没有场景私有记忆.md' });
      continue;
    }

    const parsed = parsePitEntries(md);
    if (parsed.start < 0) {
      problems.push(d.name + '：没有「## 五、坑与决策」节（经验无处追加）');
      rows.push({ scene: d.name, entries: 0, noop: 0, bad: 0 });
      continue;
    }

    // §五 里实际有多少「- 」开头的行（用来判断解析器是不是漏读了）
    //
    //  ⚠ 2026-11-12 修正（破坏性验证暴露的判据漏洞）
    //
    //  原判据：只检查「§五 里有 - 行 但 解析出 0 条」。
    //
    //  错在哪：解析器被 ### 截断时**不是解析出 0 条**，而是只解析出截断前的那几条。
    //    实测：把节尾判据改回 /^#{2,3}\s/ 后，9 个场景合计从 61 条掉到 55 条，
    //    中枢 6 条全丢 —— 但检查照样 ✓ 通过（55 条也 > 0）。
    //    这正是「造了破坏却不报错」。
    //
    //  修法：不再只看「是否 0 条」，而是**逐个数**：
    //    §五 节内（到下一个 ## 为止）以 `- ` 开头的行 = 应有的经验条数，
    //    解析器给出的条数必须与它相等，少一条都算漏读。
    //    这样即使只丢 1 条也能抓出来。
    const pitEnd = (function () {
      // 手工算「到下一个 ## 为止」，不依赖解析器（解析器本身正在被检验）
      let e = parsed.lines.length;
      for (let i = parsed.start + 1; i < parsed.lines.length; i++) {
        if (/^#{1,2}\s/.test(parsed.lines[i])) { e = i; break; }
      }
      return e;
    })();

    const rawListLines = parsed.lines
      .slice(parsed.start + 1, pitEnd)
      .filter((l) => /^-\s+/.test(l))
      .filter((l) => !/^-\s*[（(](只追加|待补|无)[^）)]*[）)]\s*$/.test(l.trim()));

    // ⚠ 两边必须用同一个「什么算经验」的口径再比：
    //   格式提示行（`- （只追加）`）解析器会当成一条，但它不是经验，
    //   所以比较时把它从解析结果里也剔掉，否则会算出「漏读 -1 条」这种假警报。
    const parsedEntriesReal = parsed.entries.filter((e) =>
      !/^-\s*[（(](只追加|待补|无)[^）)]*[）)]\s*$/.test(e.lines[0].trim()));

    if (rawListLines.length !== parsedEntriesReal.length) {
      const miss = rawListLines.length - parsedEntriesReal.length;
      problems.push(d.name + '：§五 实际有 ' + rawListLines.length +
        ' 条 `- ` 经验行，解析器只读出 ' + parsedEntriesReal.length +
        ' 条（' + (miss > 0 ? '漏读 ' + miss + ' 条' : '多读 ' + (-miss) + ' 条') +
        ' —— 节被 ### 子标题截断了？）');
    }

    let noop = 0;
    let bad = 0;
    const badDetail = [];
    for (const e of parsed.entries) {
      const body = e.text.replace(/^-\s*\d{4}-\d{2}-\d{2}[：:]\s*/, '').trim();
      if (!body) continue;

      // ① 日期前缀
      //
      //  ⚠ 2026-11-12 修正（真实检查暴露的判据错误）
      //
      //  原判据：所有 `- ` 条目都必须有日期前缀。
      //
      //  错在哪：§五 里有一类**说明性文字**，不是经验：
      //      `- （只追加：症状 → 根因 → 修法）`
      //      `- （只追加）`
      //    它们是节标题下的格式提示，本来就没有日期，
      //    报「缺日期」属于把格式提示当经验 —— 误报。
      //
      //  修法：整行是括号包裹的短说明（≤ 30 字）→ 不是经验，跳过。
      //        只有「看起来是经验却没有日期」才报。
      const isFormatHint = /^-\s*[（(][^）)]{0,30}[）)]\s*$/.test(e.lines[0].trim());
      if (!isFormatHint && !/^-\s*\d{4}-\d{2}-\d{2}/.test(e.lines[0])) {
        problems.push(d.name + '：有条经验没有日期前缀 —— 「' + e.text.split('\n')[0].slice(0, 40) + '」');
      }

      // ② 原样重写必须判 NOOP
      const r = decideOp(body, parsed.entries);
      if (r.op === 'noop') {
        noop++;
      } else {
        bad++;
        badDetail.push({ title: String(e.title).slice(0, 30), op: r.op, sim: r.similarity });
      }
    }

    for (const b of badDetail.slice(0, 5)) {
      problems.push(d.name + '：原样重写自己的经验「' + b.title + '」被判 ' +
        b.op.toUpperCase() + '（sim=' + b.sim + '）—— 判定逻辑会对真实经验做错事');
    }

    rows.push({
      scene: d.name,
      entries: parsed.entries.length,
      noop,
      bad,
    });
  }

  return { ok: problems.length === 0, checked: rows.filter((r) => !r.skipped).length, rows, problems };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 真实检查 ──
  if (has('--check')) {
    const r = checkReal();
    console.log('═'.repeat(78));
    console.log('  记忆写入协议 · 真实检查（读真实 §五 并验证四选一判定）');
    console.log('═'.repeat(78));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '经验条数'.padEnd(10) + '原样重写判NOOP'.padEnd(16) + '误判');
    console.log('  ' + '─'.repeat(70));
    for (const row of r.rows) {
      if (row.skipped) {
        console.log('  ' + row.scene.padEnd(12) + '—  ' + row.why);
        continue;
      }
      console.log('  ' + row.scene.padEnd(12) +
        String(row.entries).padEnd(10) +
        String(row.noop).padEnd(16) +
        (row.bad ? '✗ ' + row.bad : '0'));
    }
    console.log('  ' + '─'.repeat(70));
    const totalEntries = r.rows.reduce((s, x) => s + (x.entries || 0), 0);
    const totalNoop = r.rows.reduce((s, x) => s + (x.noop || 0), 0);
    console.log('  检查了 ' + r.checked + ' 个场景，共 ' + totalEntries +
      ' 条经验，原样重写判 NOOP ' + totalNoop + ' 条');
    console.log();
    if (r.ok) {
      console.log('  ✓ 全部场景可解析，判定逻辑对真实经验正确（原样重写=NOOP）');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    console.log('═'.repeat(78));
    process.exit(r.ok ? 0 : 1);
  }

  const scene = val('--scene');
  if (!scene) { console.error('需要 --scene <场景名或id>'); process.exit(2); }

  const file = sceneMemFile(scene);
  const md = readTextSafe(file);
  if (md === null) { console.error('✗ 读不到: ' + file); process.exit(2); }

  const parsed = parsePitEntries(md);

  // ── 列出 ──
  if (has('--list')) {
    console.log('═'.repeat(72));
    console.log('  ' + scene + ' 的 §五 坑与决策（' + parsed.entries.length + ' 条）');
    console.log('═'.repeat(72));
    console.log();
    for (let i = 0; i < parsed.entries.length; i++) {
      const e = parsed.entries[i];
      console.log('  [' + (i + 1) + '] ' + e.title);
      console.log('      ' + e.text.split('\n')[0].slice(0, 80));
      console.log();
    }
    process.exit(0);
  }

  const text = val('--text');
  if (!text) { console.error('需要 --text "新经验内容"'); process.exit(2); }

  // ── 判定 ──
  const forced = val('--op');
  const decision = forced
    ? { op: forced, target: parsed.entries[0] || null, similarity: null, reason: '强制指定' }
    : decideOp(text, parsed.entries);

  console.log('═'.repeat(72));
  console.log('  记忆写入判定');
  console.log('═'.repeat(72));
  console.log();
  console.log('  场景: ' + scene);
  console.log('  新内容: ' + text.slice(0, 100));
  console.log();
  console.log('  判定: ' + decision.op.toUpperCase());
  if (decision.similarity !== null) console.log('  相似度: ' + decision.similarity);
  console.log('  理由: ' + decision.reason);
  if (decision.target) console.log('  目标: 「' + decision.target.title + '」');
  if (decision.alternatives) {
    console.log('  其它候选:');
    for (const a of decision.alternatives) console.log('    · ' + a.title + '  (' + a.sim + ')');
  }
  if (decision.related) {
    console.log('  相关内容:');
    for (const a of decision.related) console.log('    · ' + a.title + '  (' + a.sim + ')');
  }
  console.log();

  if (!has('--apply')) {
    console.log('  （预览。加 --apply 真写）');
    process.exit(0);
  }

  if (decision.op === 'noop') {
    console.log('  ✓ NOOP：不写入（已有覆盖）');
    process.exit(0);
  }

  const result = applyOp(md, decision, text);
  if (!result.changed) { console.log('  ⚠ 未改动: ' + result.reason); process.exit(0); }
  fs.writeFileSync(file, result.md, 'utf8');
  console.log('  ✓ 已写入: ' + result.reason);
  console.log('  文件: ' + path.relative(WB, file).replace(/\\/g, '/'));
  process.exit(0);
}
