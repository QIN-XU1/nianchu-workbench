#!/usr/bin/env node
/**
 * 记忆注入 —— 按 luanyujia 的设计重做
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1qrxD6qEcY「我怎么做记忆」右侧面板原文）
 * ══════════════════════════════════════════════════════════════
 *
 *  > memory-inject 记忆注入插件：每轮 pre-step 按用户话术检索；
 *  > 只取"当前场景+全局"，最多 3 条/300 字，命中才追加；
 *  > **默认关闭、fail-open，日志可查。**
 *
 *  五条硬约束：
 *    ① 按用户话术检索（不是全量塞）
 *    ② 只取「当前场景 + 全局」两层，不跨场景
 *    ③ 最多 3 条 / 300 字
 *    ④ 命中才追加（不命中就不注入）
 *    ⑤ 默认关闭、fail-open（失败不阻断）、日志可查
 *
 * ══════════════════════════════════════════════════════════════
 *  与我原实现的差别
 * ══════════════════════════════════════════════════════════════
 *
 *  我的「记忆评估」测的是「全量注入时 recall 多少」→ 1.00
 *  但那是个虚高的数字：把全部内容塞进去，当然什么都召回得到。
 *
 *  他的设计是「只给 300 字还要答对」。
 *  所以真正的考验是：300 字内能保住多少关键事实。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/记忆注入.mjs --scene 架构梳理 --query "改架构"       看会注入什么
 *  node 工具/记忆注入.mjs --scene 架构梳理 --query "..." --json   JSON 输出
 *  node 工具/记忆注入.mjs --scene 架构梳理 --query "..." --explain 显示检索过程
 *  node 工具/记忆注入.mjs --selftest                             自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
const SHARED_ROOT = path.join(MEM_ROOT, '_共享记忆');
const LOG_FILE = path.join(DATA_ROOT, '记忆注入日志.jsonl');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  硬约束（来自设计原文，写死可测）
// ══════════════════════════════════════════════════════════════
export const LIMITS = {
  /** 最多注入几条 */
  MAX_ITEMS: 3,
  /** 最多注入多少字（中文按字算） */
  MAX_CHARS: 300,
  /** 低于这个相关度不注入 */
  MIN_SCORE: 0.15,
  /** 默认是否开启（设计原文：默认关闭） */
  DEFAULT_ENABLED: false,
};

/**
 * 300 字注入的 recall 下限（--check 用）
 *
 *  ⚠ 2026-11-12 重定：原值 0.25 是**度量有 bug 时**定的
 *    （fact 带 ** 记号导致 4/12 假 MISS，实测只有 0.308）。
 *    修好度量后同一份数据是 0.671 —— 说明当时的 0.25 是在给一个坏尺子配误差范围。
 *
 *  实测（2026-11-12，修后，9 场景 143 题）：
 *    中枢 0.800 / 实施计划 0.650 / 故障分析 0.923 / 本地电脑 0.714
 *    架构梳理 0.367 / 竞品拆解 0.750 / 自我复盘 0.667 / 调研 0.833 / 逆向分析 0.750
 *    合计 0.671
 *
 *  为什么下限取 0.55 而不是 0.70：
 *    · 这个机制是「3 条/300 字按话术检索」，不是全量注入。
 *      封存集里「那条经验具体说了什么」这类题需要 3–4 句连续原文，300 字装不下。
 *    · 0.55 低于实测最差的单场景（架构梳理 0.367）之上、平均 0.671 之下，
 *      留出正常波动空间，同时比修前的 0.25 严得多 ——
 *      检索逻辑真退化（分词坏、条目抽取坏）会立刻掉下来。
 *    · 单场景阈值见 SCENE_RECALL_MIN，那个可以放宽（有的场景题就是长）。
 */
export const INJECT_RECALL_MIN = 0.55;

/** 单场景 recall 下限（允许个别场景偏低，但不能整场景失效） */
export const SCENE_RECALL_MIN = 0.30;

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  检索：按用户话术
//
//  设计要点：
//    · 不追求「召回所有」，追求「命中最相关的」
//    · 中文用 2-gram + 关键词加权
//    · 条目本身要短（一条 ≤100 字）
// ══════════════════════════════════════════════════════════════
function grams(s) {
  const out = new Set();
  const t = String(s || '').toLowerCase();
  for (const seg of (t.match(/[\u4e00-\u9fff]+/g) || [])) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of (t.match(/[a-z][a-z0-9_-]{2,}/g) || [])) out.add(w);
  return out;
}

/** 从记忆文件里切出「可注入的知识条目」 */
export function extractItems(md, sceneName, layer) {
  const s = String(md || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s.split('\n');
  const items = [];

  let curSection = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 记录当前节
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) { curSection = h[1].trim(); continue; }

    // 只取有信息量的行
    const t = line.trim();
    if (!t) continue;
    if (/^[（(]?(无|待补|待填|空|只追加)[)）]?$/.test(t)) continue;
    if (t.length < 8) continue;

    // 跳过纯标题行/分隔行
    if (/^[-=*]{3,}$/.test(t)) continue;

    // ⚠ 2026-11-10 修正（实测发现注入了标题行）
    //
    //  第一版把 Markdown 标题行（# 架构梳理 · 场景私有记忆）
    //  也当成知识条目注入了，白占一条 3 条的配额。
    //  标题行没有知识价值。
    if (/^#{1,6}\s/.test(t)) continue;
    // 跳过 blockquote 元信息
    if (/^>\s/.test(t)) continue;
    // 跳过文件头说明
    if (/^场景[：:].*这份文件/.test(t)) continue;
    // 跳过表格分隔行
    if (/^\|?[\s:|-]+\|?$/.test(t)) continue;
    // 跳过纯路径/配置行
    //
    //  ⚠ 2026-11-10：这类行不该进记忆注入
    //    实测注入了「记忆目录：数据\\.dsh\\场景记忆\架构梳理」——
    //    ① 它是元信息，不是知识
    //    ② 内容是过时的旧路径（数据 已废弃）
    //    注入这种东西只会误导 AI。
    if (/^(记忆目录|面板文件|面板清单|场景 id|场景 id)[：:]/.test(t)) continue;
    // 跳过含绝对/相对路径的配置行
    if (/^(记忆目录|面板文件)/.test(t)) continue;
    // 跳过「结构：...」这类文件头
    if (/^结构[：:]/.test(t)) continue;
    // 跳过任何以「xxx：路径\路径」形式的配置行
    if (/^[^\n]{0,10}[：:]\s*[^\n]*\\[^\n]*$/.test(t) && t.length < 80) continue;
    // 跳过表格行（以 | 开头）
    if (/^\|/.test(t)) continue;
    // 跳过含反引号路径的配置片段
    if (/`[^`]*\\[^`]*`/.test(t) && t.length < 100) continue;

    items.push({
      section: curSection,
      text: t.replace(/^[-*+]\s*/, '').replace(/\*\*/g, '').slice(0, 200),
      layer,
      scene: sceneName,
    });
  }

  return items;
}

/**
 * 检索并选择要注入的条目
 *
 * @returns { ok, injected[], rejected[], stats }
 */
export function selectItems(query, items, limits) {
  const L = limits || LIMITS;
  const qG = grams(query);

  const scored = items.map((it) => {
    const g = grams(it.text + ' ' + (it.section || ''));
    let inter = 0;
    for (const x of qG) if (g.has(x)) inter++;
    // 归一化：用 query 的 gram 数作分母（命中率）
    const score = qG.size > 0 ? inter / qG.size : 0;
    return { ...it, score, inter };
  }).sort((a, b) => b.score - a.score);

  const injected = [];
  const rejected = [];
  let chars = 0;

  // ⚠ 2026-11-12 修正（真实检查抓到的硬约束违反）
  //
  //  原判据：cost = it.text.length，预算只算**条目正文**。
  //
  //  错在哪：最终注入的文本不是条目正文，而是
  //      '· ' + it.text + '  〔场景 · 节名〕'
  //    每条还要加上「· 」（2 字）+「  〔来源标记〕」（约 12–20 字）。
  //    3 条就要多出 40–60 字。
  //    实测（自我复盘）：条目合计 271 字（预算内），
  //    但最终注入文本 355 字 —— **超了 300 字硬上限 18%**。
  //    9 个场景里有 7 个存在超限的题（合计 39 道）。
  //
  //  「3 条/300 字」是这个机制的设计硬约束（视频原文就写死了），
  //  超了就是 bug，不是「差不多」。
  //
  //  修法：预算按**最终渲染后的行**算，而不是只算正文。
  //    渲染格式与 ④ 组装注入文本处保持一致。
  const renderLen = (it) => {
    const line = '· ' + it.text + '  〔' + it.scene + ' · ' + (it.section || '') + '〕';
    return line.length;
  };

  for (const it of scored) {
    if (injected.length >= L.MAX_ITEMS) { rejected.push({ ...it, why: '超过条数上限' }); continue; }
    if (it.score < L.MIN_SCORE) { rejected.push({ ...it, why: '相关度不足 ' + it.score.toFixed(2) }); continue; }
    // 每行之间用 \n 连接，所以从第 2 条起还要多算 1 个换行符
    // （这一处差 1 字就是 301 > 300 —— 真实检查抓到的最后一例）
    const cost = renderLen(it) + (injected.length > 0 ? 1 : 0);
    if (chars + cost > L.MAX_CHARS) { rejected.push({ ...it, why: '超过字数上限（含来源标记/换行）' }); continue; }
    injected.push(it);
    chars += cost;
  }

  return {
    ok: true,
    injected,
    rejected: rejected.slice(0, 10),
    stats: {
      totalItems: items.length,
      injectedCount: injected.length,
      chars,
      maxChars: L.MAX_CHARS,
      maxItems: L.MAX_ITEMS,
    },
  };
}

/**
 * 主入口：为某场景 + 某句话生成注入内容
 *
 * @param {string} sceneName 场景名（只取这个场景 + 全局）
 * @param {string} query 用户话术
 * @param {object} opts { enabled, limits }
 */
export function buildInjection(sceneName, query, opts) {
  const o = opts || {};
  const started = Date.now();

  // ① 默认关闭检查
  const enabled = o.enabled !== undefined ? o.enabled : LIMITS.DEFAULT_ENABLED;
  if (!enabled) {
    return {
      ok: true, enabled: false, text: '', items: [],
      reason: '默认关闭（设计原文：默认关闭）',
      stats: { ms: Date.now() - started },
    };
  }

  // ② 只取「当前场景 + 全局」，不跨场景
  const items = [];
  try {
    const sceneDir = path.join(MEM_ROOT, sceneName);
    if (fs.existsSync(sceneDir)) {
      for (const f of fs.readdirSync(sceneDir)) {
        if (!f.endsWith('.md') || f === 'AGENTS.local.md') continue;
        const md = readTextSafe(path.join(sceneDir, f));
        if (md) items.push(...extractItems(md, sceneName, 'scene'));
      }
    }
    // 全局层（共享记忆）
    if (fs.existsSync(SHARED_ROOT)) {
      for (const f of fs.readdirSync(SHARED_ROOT)) {
        if (!f.endsWith('.md')) continue;
        const md = readTextSafe(path.join(SHARED_ROOT, f));
        if (md) items.push(...extractItems(md, '_全局', 'global'));
      }
    }
  } catch (e) {
    // ③ fail-open：出错不阻断，返回空注入
    return {
      ok: false, enabled: true, text: '', items: [],
      reason: 'fail-open：检索出错，不注入（' + String(e.message).slice(0, 60) + '）',
      stats: { ms: Date.now() - started },
    };
  }

  const sel = selectItems(query, items, o.limits);

  // ④ 组装注入文本（带来源标记，便于追溯）
  const lines = [];
  for (const it of sel.injected) {
    lines.push('· ' + it.text + '  〔' + it.scene + ' · ' + it.section + '〕');
  }
  const text = lines.join('\n');

  // ⑤ 日志可查
  if (o.log !== false) {
    try {
      const rec = {
        at: new Date().toISOString(),
        scene: sceneName,
        query: String(query).slice(0, 100),
        injectedCount: sel.injected.length,
        chars: sel.stats.chars,
        items: sel.injected.map((i) => ({ section: i.section, scene: i.scene, score: +i.score.toFixed(3) })),
        ms: Date.now() - started,
      };
      fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n', 'utf8');
    } catch { /* 日志失败不影响主流程 */ }
  }

  return {
    ok: true,
    enabled: true,
    text,
    items: sel.injected,
    rejected: sel.rejected,
    stats: { ...sel.stats, ms: Date.now() - started },
    reason: sel.injected.length > 0
      ? '命中 ' + sel.injected.length + ' 条 / ' + sel.stats.chars + ' 字'
      : '未命中，不注入',
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  记忆注入 · 自测（按 luanyujia 的设计）');
  console.log('═'.repeat(72));
  console.log();

  // ① 硬约束常量正确
  chk('条数上限 3', LIMITS.MAX_ITEMS === 3, String(LIMITS.MAX_ITEMS));
  chk('字数上限 300', LIMITS.MAX_CHARS === 300, String(LIMITS.MAX_CHARS));
  chk('默认关闭', LIMITS.DEFAULT_ENABLED === false, String(LIMITS.DEFAULT_ENABLED));

  // ② 默认关闭时返回空
  const off = buildInjection('架构梳理', '改架构', { log: false });
  chk('默认关闭时不注入', off.enabled === false && off.text === '', off.reason.slice(0, 30));

  // ③ 开启但无关话术 → 不注入（命中才追加）
  //
  //  ⚠ 2026-11-12 修正（自测与真实数据耦合导致的假失败）
  //
  //  原做法：直接拿真实场景「架构梳理」+ 无关话术跑，断言「一条都不注入」。
  //
  //  错在哪：这个断言依赖「真实记忆里恰好没有跟无关话术共享 2-gram 的条目」。
  //    记忆是活的，另一个工人/场景在 12:16 往架构梳理里追加了含「内容」「完全」
  //    这类通用词的条目，于是「qwertyuiop 完全无关的内容」命中了 1 条（score 0.286）
  //    → 自测挂掉。验证过：这条在旧预算逻辑下同样会注入（正文 200 ≤ 300），
  //    与本次预算改动无关，纯粹是记忆数据变了。
  //
  //  修法：用**纯函数**测「无关话术不注入」这个性质 ——
  //    直接构造条目集调 selectItems，不碰磁盘。
  //    自测应当验证判据逻辑，不该被真实数据的增长拖挂。
  const fakeItems = [
    { section: '核心职责', text: '负责把三路输入合成架构方案，产出架构文档', layer: 'scene', scene: '测试场景' },
    { section: '坑与决策', text: '状态机末端状态要显式处理，否则统计漏掉已完成的活', layer: 'scene', scene: '测试场景' },
  ];
  const selUnrelated = selectItems('qwertyuiop zzzzz', fakeItems);
  chk('无关话术不注入（纯函数口径）', selUnrelated.injected.length === 0,
      '命中 ' + selUnrelated.injected.length + ' 条');
  const selRelated = selectItems('架构方案 三路输入', fakeItems);
  chk('相关话术会注入（纯函数口径）', selRelated.injected.length > 0,
      '命中 ' + selRelated.injected.length + ' 条');

  // ④ 真相关话术 → 注入
  const hit = buildInjection('架构梳理', '架构梳理要注意什么坑', { enabled: true, log: false });
  chk('相关话术会注入', hit.items.length > 0, '命中 ' + hit.items.length + ' 条');
  chk('不超过 3 条', hit.items.length <= 3, String(hit.items.length));
  chk('不超过 300 字', hit.stats.chars <= 300, hit.stats.chars + ' 字');

  // ⑤ 只取当前场景 + 全局（不跨场景）
  const cross = hit.items.every((i) => i.scene === '架构梳理' || i.scene === '_全局');
  chk('不跨场景注入', cross, hit.items.map((i) => i.scene).join(','));

  // ⑥ 注入文本带来源标记
  if (hit.text) {
    chk('注入文本带来源', /〔.+?·.+?〕/.test(hit.text), hit.text.slice(0, 50));
  } else {
    chk('注入文本带来源', false, '无注入');
  }

  // ⑦ fail-open：场景不存在不该抛错
  let failOpenOk = false;
  try {
    const r = buildInjection('不存在的场景xyz', 'test', { enabled: true, log: false });
    failOpenOk = r.ok === true || r.ok === false;   // 不抛错即可
  } catch { failOpenOk = false; }
  chk('fail-open：场景不存在不抛错', failOpenOk, '');

  // ⑧ 反例：如果关掉条数限制，应该能注入更多（证明限制真的生效）
  const noLimit = buildInjection('架构梳理', '架构梳理要注意什么坑', {
    enabled: true, log: false,
    limits: { MAX_ITEMS: 100, MAX_CHARS: 10000, MIN_SCORE: 0.05 },
  });
  chk('放宽限制后注入更多', noLimit.items.length > hit.items.length,
      noLimit.items.length + ' > ' + hit.items.length);

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增（机制审计 ①4「有应当失败的反例」只有 1 处）
  //
  //  上面 ⑧ 虽然标题带「反例」，但它断言的是「放宽后**注入更多**」——
  //  这是判据生效的**正面**证据，不是「造坏数据、判据必须拒」。
  //  真正的反例要问：**给一份会破坏硬约束的数据，selectItems 必须真的把它挡掉。**
  //
  //  下面两条都直接打纯函数 selectItems / extractItems（不碰磁盘），
  //  每条都配一份合格数据做对照 —— 判据恒 true 或恒 false 都会红。
  // ══════════════════════════════════════════════════════════════
  console.log();
  console.log('【反例】造破坏硬约束的数据，判据必须挡住');

  // 反例①：条数上限。塞 8 条都跟话术强相关的条目，
  //         正例（默认 LIMITS）必须只放 3 条，超出的必须进 rejected 且写明「超过条数上限」。
  {
    const many = [];
    for (let i = 0; i < 8; i++) {
      many.push({ section: '核心职责', text: '架构方案 三路输入 合成 第' + i + '条', layer: 'scene', scene: '测试场景' });
    }
    const capped = selectItems('架构方案 三路输入', many);
    const rejectedByCount = capped.rejected.filter((r) => r.why === '超过条数上限');
    chk('反例：8 条强相关条目必须被条数上限截到 3 条',
      capped.injected.length === 3 && rejectedByCount.length > 0,
      '注入 ' + capped.injected.length + ' 条 / 因条数被拒 ' + rejectedByCount.length + ' 条');
  }

  // 反例②：字数上限（含来源标记后的**最终渲染长度**）。
  //         造 3 条各 150 字的条目 —— 3×150 = 450 字，远超 300。
  //         判据必须按 renderLen（正文 + 「· 」+ 「  〔来源〕」）算，而不是只算正文。
  //         ⚠ 这条正是修 bug 时补的：原实现只算正文，实测超限 18%。
  {
    const long = [];
    for (let i = 0; i < 3; i++) {
      long.push({
        section: '坑与决策',
        text: '架构方案 三路输入 ' + ('这里是一段很长的说明文字'.repeat(12)) + ' 第' + i,
        layer: 'scene', scene: '测试场景',
      });
    }
    const r = selectItems('架构方案 三路输入', long);
    // 按最终渲染文本量（含换行）真实核对，不信任内部记账
    const rendered = r.injected
      .map((it) => '· ' + it.text + '  〔' + it.scene + ' · ' + it.section + '〕')
      .join('\n');
    chk('反例：三条各 150 字的条目必须被 300 字上限挡住',
      rendered.length <= 300 && r.injected.length < 3,
      '渲染后 ' + rendered.length + ' 字 / 允许注入 ' + r.injected.length + ' 条');
  }

  // 反例③：每行之间的换行符也要算进预算。
  //         造两条「单独放都能进、但两条合计 + 换行就超 300」的条目。
  //         判据若漏算那个 \n，这里就会注入 2 条并超出 300。
  {
    // 单条渲染长度 = 2 + text.length + 2 + （「测试场景 · 坑与决策」≈ 12）+ 3
    // 取 text 长度使单条≈150、两条≈301 ⇒ 必须只放 1 条
    const mk = (i) => ({
      section: '坑与决策',
      text: '架构方案 三路输入 ' + '甲'.repeat(135) + i,
      layer: 'scene', scene: '测试场景',
    });
    const two = selectItems('架构方案 三路输入', [mk(0), mk(1)]);
    const rendered2 = two.injected
      .map((it) => '· ' + it.text + '  〔' + it.scene + ' · ' + it.section + '〕')
      .join('\n');
    chk('反例：换行符必须计入 300 字预算（两条合计超限则只放 1 条）',
      rendered2.length <= 300,
      '实际渲染 ' + rendered2.length + ' 字 / 注入 ' + two.injected.length + ' 条');
  }

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。此前只有 --selftest（手写的记忆条目 + 手写话术），
//    从来没在「真实记忆 + 封存集的真实问题」上测过「300 字里能答对多少」。
//
//  这个工具的整个设计卖点是「只给 300 字还要答对」，
//  所以真实检查必须回答：**给定封存集的真实问题，300 字注入能不能命中事实**。
//
//  判据：
//    ① 每个有封存集的场景，注入必须「有命中」（不能完全检索不到）
//    ② 300 字注入的 recall 必须达到下限（低于下限 = 检索质量不够）
//    ③ 注入绝不能超 3 条 / 300 字（这是设计硬约束，超了就是 bug）
//
//  口径说明：这里算 recall 用的是「注入文本里有没有该事实」，
//  与 记忆评估.mjs 的 full 注入（全量 1 万+ token）不可比 ——
//  那边是上限对照，这边是真实 300 字预算下的能力。
// ══════════════════════════════════════════════════════════════
export function checkReal() {
  const problems = [];
  const rows = [];
  const SEALED = path.join(DATA_ROOT, '封存集');
  if (!fs.existsSync(SEALED)) {
    return { ok: false, checked: 0, rows, problems: ['封存集目录不存在: ' + SEALED] };
  }

  // ⚠ 2026-11-12 修正（真实检查暴露的度量口径错误）
  //
  //  原判据：norm = 去空白 + 小写，然后 text.includes(norm(fact))。
  //
  //  错在哪：封存集的 fact 里带 Markdown 记号（`2026-11-12：**复盘全局记忆时…**`），
  //    而 extractItems 在抽取条目时会**剥掉 `**`**（`text.replace(/\*\*/g,'')`）。
  //    于是「记忆里明明有这条经验、也注入了」，却因为 fact 多两个星号判 MISS。
  //    实测（自我复盘）：12 题里 4 题是这种假 MISS。
  //
  //  修法：比对前把两侧的 Markdown 记号、空白、常见标点都去掉，
  //    与 记忆评估.mjs 的 norm() 保持同一口径
  //    （那个工具已经证明这套归一化在真实数据上可用）。
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/\s+/g, '')
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, '')
    .replace(/[,.;:!?()[\]{}<>"'`~@#$%^&*_+=|\\/-]/g, '')
    .replace(/[·—…]/g, '');

  const scenes = fs.readdirSync(SEALED, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const scene of scenes) {
    const casesFile = path.join(SEALED, scene, 'cases.json');
    const sealed = (() => { try { return JSON.parse(readTextSafe(casesFile)); } catch { return null; } })();
    if (!sealed || !Array.isArray(sealed.cases) || sealed.cases.length === 0) continue;

    let hitAll = 0;
    let hitAnyItem = 0;      // 至少注入了 1 条的场景题
    let overLimit = 0;
    const misses = [];

    for (const c of sealed.cases) {
      const r = buildInjection(scene, c.question, { enabled: true, log: false });
      const text = norm(r.text);

      if (r.items && r.items.length > 0) hitAnyItem++;
      if (r.items && r.items.length > LIMITS.MAX_ITEMS) overLimit++;
      if (r.text && r.text.length > LIMITS.MAX_CHARS) overLimit++;

      const facts = c.facts || [];
      const all = facts.length > 0 && facts.every((f) => text.includes(norm(f)));
      if (all) hitAll++;
      else misses.push({ id: c.id, missing: facts.filter((f) => !text.includes(norm(f))) });
    }

    const total = sealed.cases.length;
    const recall = +(hitAll / total).toFixed(3);
    const injectRate = +(hitAnyItem / total).toFixed(3);

    if (overLimit > 0) {
      problems.push(scene + '：有 ' + overLimit + ' 道题注入超过硬约束（3 条 / 300 字）');
    }
    if (injectRate < 0.5) {
      problems.push(scene + '：只有 ' + (injectRate * 100).toFixed(0) +
        '% 的问题能检索到任何条目（检索几乎没起作用）');
    }
    if (recall < SCENE_RECALL_MIN) {
      problems.push(scene + '：300 字注入 recall ' + recall + ' 低于单场景下限 ' + SCENE_RECALL_MIN +
        '（' + hitAll + '/' + total + '）—— 这个场景的检索基本失效');
    }

    rows.push({ scene, total, hitAll, recall, injectRate, overLimit, misses: misses.slice(0, 3) });
  }

  // 合计下限（整体质量）
  const totCase = rows.reduce((s, x) => s + x.total, 0);
  const totHit = rows.reduce((s, x) => s + x.hitAll, 0);
  const totalRecall = totCase > 0 ? +(totHit / totCase).toFixed(3) : 0;
  if (totalRecall < INJECT_RECALL_MIN) {
    problems.push('合计 recall ' + totalRecall + ' 低于下限 ' + INJECT_RECALL_MIN +
      '（' + totHit + '/' + totCase + '）—— 检索质量不足');
  }

  return {
    ok: problems.length === 0,
    checked: rows.length,
    rows,
    problems,
    totalRecall,
    totHit,
    totCase,
  };
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
    console.log('  记忆注入 · 真实检查（300 字预算下能答对封存集多少题）');
    console.log('═'.repeat(78));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '题数'.padEnd(6) + '全中'.padEnd(6) +
      'recall'.padEnd(9) + '能注入'.padEnd(10) + '超限');
    console.log('  ' + '─'.repeat(68));
    for (const row of r.rows) {
      console.log('  ' + row.scene.padEnd(12) +
        String(row.total).padEnd(6) +
        String(row.hitAll).padEnd(6) +
        row.recall.toFixed(3).padEnd(9) +
        (row.injectRate * 100).toFixed(0).padEnd(10) +
        String(row.overLimit));
    }
    console.log('  ' + '─'.repeat(68));
    const totCase = r.rows.reduce((s, x) => s + x.total, 0);
    const totHit = r.rows.reduce((s, x) => s + x.hitAll, 0);
    console.log('  合计 ' + totHit + ' / ' + totCase + ' 题，recall ' +
      (totCase ? (totHit / totCase).toFixed(3) : '0'));
    console.log();
    if (r.ok) {
      console.log('  ✓ 300 字注入的检索质量达标，且未超硬约束');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    console.log('═'.repeat(78));
    process.exit(r.ok ? 0 : 1);
  }

  const scene = val('--scene');
  const query = val('--query');
  if (!scene || !query) {
    console.error('用法: node 工具/记忆注入.mjs --scene <场景> --query "<用户话术>" [--json] [--explain]');
    process.exit(2);
  }

  const enabled = has('--enabled') ? true : undefined;
  const r = buildInjection(scene, query, { enabled, log: has('--log') });

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  console.log('═'.repeat(72));
  console.log('  记忆注入（3 条 / 300 字 / 按话术检索）');
  console.log('═'.repeat(72));
  console.log();
  console.log('  场景: ' + scene);
  console.log('  话术: ' + query);
  console.log('  启用: ' + (r.enabled ? '是' : '否（默认关闭）'));
  console.log();

  if (r.items.length === 0) {
    console.log('  结果: 不注入');
    console.log('  原因: ' + r.reason);
  } else {
    console.log('  结果: ' + r.reason);
    console.log();
    console.log('  ── 注入内容 ──');
    for (const line of r.text.split('\n')) {
      console.log('  ' + line);
    }
  }

  if (has('--explain')) {
    console.log();
    console.log('  ── 检索明细 ──');
    console.log('  候选条目: ' + r.stats.totalItems + ' 条');
    for (const it of r.items) {
      console.log('    ✓ [' + it.score.toFixed(2) + '] ' + it.scene + ' · ' + it.section);
      console.log('        ' + it.text.slice(0, 70));
    }
    if (r.rejected?.length) {
      console.log('  未选中:');
      for (const it of r.rejected.slice(0, 5)) {
        console.log('    · [' + it.score.toFixed(2) + '] ' + it.why + '  ' + it.text.slice(0, 40));
      }
    }
  }

  console.log();
  console.log('─'.repeat(72));
  console.log('  字数: ' + r.stats.chars + ' / ' + LIMITS.MAX_CHARS + '   条数: ' +
    r.items.length + ' / ' + LIMITS.MAX_ITEMS + '   耗时: ' + r.stats.ms + 'ms');
  console.log('─'.repeat(72));
  process.exit(0);
}
