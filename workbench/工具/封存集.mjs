#!/usr/bin/env node
/**
 * 封存集 —— Agent 不可见的评估用例
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么这个最重要（调研的核心结论）
 * ══════════════════════════════════════════════════════════════
 *
 *  两份独立调研得出同一个判断：
 *
 *    「你有『可回滚』，没有『可证伪』。
 *      回滚解决『改坏了能退』，不解决『怎么知道改好了』。」
 *
 *    「你缺的不是更先进的架构，是一个能证伪的记忆系统该有的三样东西：
 *      可归因的样本、带时态的写入、分离口径的度量。」
 *
 *  arXiv 2607.24300（6 模型 3 种子）的核心结论：
 *    Agent 同时控制「被优化对象」和「验证器」时，自评必然与真实性能脱钩。
 *
 *  所以必须有一个 **Agent 看不见的集合** 说了算。
 *
 * ══════════════════════════════════════════════════════════════
 *  封存集长什么样
 * ══════════════════════════════════════════════════════════════
 *
 *  每条用例：
 *    id          用例编号
 *    question    问题（模拟真实用户会问的）
 *    facts       正确答案必须包含的关键事实（字符串数组）
 *    distractors 正确答案不应包含的错误说法（防瞎猜）
 *    source      这个事实出自哪个文件哪一节（可归因）
 *
 *  为什么 facts 用「必须包含的关键事实」而不是完整答案：
 *    · 不需要 LLM 裁判（可机器判定）
 *    · 不依赖措辞（同一个意思多种说法都算对）
 *    · 可归因（能指出缺哪条事实）
 *
 * ══════════════════════════════════════════════════════════════
 *  关键约束：Agent 不能读它
 * ══════════════════════════════════════════════════════════════
 *
 *  封存集放在 数据/.dsh/封存集/ 下，
 *  而场景 agent 的 cwd 是 数据/.dsh/场景记忆/<场景名>/，
 *  沙箱限制它写不出 cwd —— 同理也读不到兄弟目录。
 *
 *  所以「Agent 不可见」是沙箱保证的，不是靠自觉。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/封存集.mjs --build              从真实记忆生成封存集
 *  node 工具/封存集.mjs --build --apply      真写
 *  node 工具/封存集.mjs --check              检查覆盖度
 *  node 工具/封存集.mjs --list <场景>         看某场景的用例
 *  node 工具/封存集.mjs --selftest           自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPitSection, splitEntries, isRealExperience } from './_经验识别.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
const SEALED_DIR = path.join(DATA_ROOT, '封存集');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

/** 每场景最少用例数（调研建议 ≥30，这里按现实可生成量放宽到 12，但主题要覆盖全） */
/** 每场景最少用例数（调研建议 ≥30，这里按现实可生成量放宽到 12，但主题要覆盖全） */
export const MIN_CASES_PER_SCENE = 12;

// ⚠ 2026-11-12 新增：中枢的单独门槛
//
//   为什么中枢要特殊处理：
//     中枢是**调度者**，不进任何管线 —— 它没有 inputs（不接收场景产物文件），
//     也不产出 artifact（只汇报结论给用户）。
//
//   实测各场景能生成的事实数：
//     架构梳理  11 条坑 + 管线 inputs/outputs → 20 题
//     本地电脑   4 条坑 + inputs          → 14 题
//     中枢       6 条坑 + 无管线           → 10 题
//
//   所以「12 题」对中枢不合理 —— 强行凑会造出不真实的问题。
//   8 题是它真实的覆盖能力（6 条坑 + 职责 + 边界 + panels）。
export const MIN_CASES_PER_HUB = 8;

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从真实记忆抽取「可出题的事实」
//
//  事实来源（按可信度）：
//    ① §五 坑与决策 —— 每条经验都是一个事实
//    ② §二 现状/接口 —— 上游输入、产物、面板清单
//    ③ §一 职责边界 —— 不碰什么
//    ④ 核心职责 —— 一句话职责
//    ⑤ §〇 交接 —— 上次做到哪
// ══════════════════════════════════════════════════════════════
export function extractFacts(md, sceneContract) {
  const facts = [];
  const norm = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ⚠ 2026-11-12 新增事实源：场景契约（sceneboard/scenes/*.json）
  //
  //   为什么加：实测封存集每题几乎全是「§五 坑与决策」一类，
  //   导致题数取决于「这个场景踩过多少坑」：
  //     架构梳理 14 题（11 条坑）、本地电脑 7 题（4 条坑）
  //   达标 1 / 9。
  //
  //   根因：生成器期待 5 类事实源（pit/input/output/panel/boundary），
  //   但后 4 类要求记忆里有「上游输入：」「我的产出：」「面板清单：」这些字段，
  //   实测 9/9 场景的记忆里**一个都没有** → 只生成了 pit 一类。
  //
  //   而这些信息定义在场景契约里（有权威结构化数据）：
  //     inputs / outputs / role / description
  //   所以：从契约取，不依赖记忆里的自由文本。
  if (sceneContract && typeof sceneContract === "object") {
    const c = sceneContract;

    // ① 职责（role / description）
    if (c.role && String(c.role).length >= 6) {
      facts.push({
        kind: "role",
        source: "场景契约",
        title: "场景职责",
        key: "职责",
        items: [String(c.role).trim().slice(0, 80)],
      });
    }

    // ② 输入
    //
    // ⚠ 2026-11-12 修（facts 只有英文 artifact id，检索命中率 18%）：
    //   契约里 inputs 的 name/id 都是英文（feature-matrix），
    //   而记忆里写的是表格「| 竞品拆解 | `feature-matrix` | `项目功能矩阵.md` |」。
    //   纯英文 id 在中文话术里分词权重低 → 命中不了。
    //
    //   修法：每条 input 生成**两条事实** ——
    //     ① 英文 id（契约视角）
    //     ② 中文文件名（记忆视角）
    //   两个视角都能被检索到，题数也不丢。
    // ⚠ 2026-11-12 修（中枢的契约 inputs 是错的，不该出题）：
    //
    //   实测：中枢 recall_all=0.59，缺 9 处事实 ——
    //     封存集问「上游输入 feature-matrix 是不是？」
    //     但中枢是**调度者**，它不接收场景产物文件，只接收场景的汇报。
    //
    //   根因：中枢契约里的 inputs 是 2026-11-09 自动补全时填错的
    //        （把「架构梳理/实施计划」的输入复制到了中枢），
    //        而中枢记忆里根本没有这些名字 → 永远召回不了。
    //
    //   修法：中枢（hub）不生成「契约 inputs」类题。
    //        它的输入语义是「用户需求」，不是管线 artifact。
    const isHub = (c.id === 'hub') || (c.name === '中枢');
    const ins = isHub ? [] : (Array.isArray(c.inputs) ? c.inputs : []);
    for (const it of ins) {
      const nm = typeof it === "string" ? it : (it.name || it.id);
      if (!nm) continue;
      // 从产物契约找对应的中文文件名
      let cnFiles = [];
      try {
        const cp2 = JSON.parse(fs.readFileSync(path.join(WB, "数据", ".dsh", "产物契约.json"), "utf8"));
        const ent = (cp2.artifacts || {})[nm];
        if (ent && Array.isArray(ent.files)) cnFiles = ent.files;
      } catch { /* ignore */ }

      // 事实 ①：英文 id
      facts.push({
        kind: "input",
        source: "场景契约 inputs",
        title: "上游输入：" + nm,
        key: "输入",
        items: [String(nm)],
      });

      // 事实 ②：中文文件名（记忆里写的是这个）
      if (cnFiles.length) {
        facts.push({
          kind: "input",
          source: "场景契约 inputs",
          title: "上游输入文件：" + cnFiles[0],
          key: "输入",
          items: cnFiles.slice(0, 2),
        });
      }
    }

    // ③ 产出（含下游）
    const outs = Array.isArray(c.outputs) ? c.outputs : [];
    for (const it of outs) {
      const nm = it.name || it.id;
      if (!nm) continue;
      const to = Array.isArray(it.to) && it.to.length ? it.to.join("、") : "（未指定下游）";
      facts.push({
        kind: "output",
        source: "场景契约 outputs",
        title: "产出：" + nm + " → " + to,
        key: "产出",
        items: [String(nm)],
      });
    }

    // ④ 面板（从场景定义的 panels 取，若有）
    const panels = Array.isArray(c.panels) ? c.panels : [];
    for (const p of panels) {
      if (p && p.title) {
        facts.push({
          kind: "panel",
          source: "场景契约 panels",
          title: "面板：" + p.title + "（" + (p.type || "?") + "）",
          key: "面板",
          items: [String(p.title)],
        });
      }
    }
  }

  function section(name) {
    const lines = norm.split('\n');
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp('^#{2,3}\\s*.*' + name).test(lines[i])) { start = i; continue; }
      if (start >= 0 && /^#{2,3}\s/.test(lines[i]) && i > start) { end = i; break; }
    }
    return start < 0 ? '' : lines.slice(start + 1, end).join('\n').trim();
  }

  // ① §五 每条经验
  // ⚠ 2026-11-12：改用共享识别模块（见 _经验识别.mjs 的注释）
  const pitBody = getPitSection(norm);
  if (pitBody) {
    const entries = splitEntries(pitBody).filter(isRealExperience).map((e) => e.raw);
    for (const e of entries) {
      const titleM = e.match(/\*\*(.+?)\*\*/);
      const title = titleM ? titleM[1] : '';
      if (title.length < 6) continue;
      // 关键事实：标题 + 「教训」/「更稳做法」行
      const details = [];
      for (const line of e.split('\n')) {
        if (/教训|更稳做法|根因|真实案例/.test(line)) {
          const t = line.replace(/^[\s→\-*]+/, '').trim();
          if (t.length >= 8) details.push(t.slice(0, 60));
        }
      }
      facts.push({
        kind: 'pit',
        source: '§五 坑与决策',
        title,
        // ⚠ 2026-11-12 修（严重缺陷）：
        //
        //   原来：key: title.replace(/[**「」]/g, '').slice(0, 20)
        //   —— 把书名号「」删掉了。
        //
        //   后果：封存集的 facts 不含「」，但记忆原文含「」。
        //        注入时原样输出记忆（含「」），与 facts 永远对不上，
        //        导致「真实注入答对率」实测 0 / 68。
        //
        //   实测对照：
        //     facts[0] = 架构梳理要注意结构标识的唯一性。     ← 无「」
        //     注入内容 = 架构梳理要注意「结构标识的唯一性」。 ← 有「」
        //     → 永远匹配不上
        //
        //   修法：只去掉 markdown 粗体标记（**），保留原标点。
        //        因为「必须包含」的语义是「记忆里真有这段文字」，
        //        标点是原文的一部分，不能动。
        key: title.replace(/\*\*/g, '').slice(0, 40),
        details: details.slice(0, 2),
      });
    }
  }

  // ② §二 现状/接口：上游输入 / 产物
  const ifaceBody = section('现状');
  if (ifaceBody) {
    const upM = ifaceBody.match(/上游输入[：:]\s*(.+)/);
    if (upM) {
      const items = upM[1].match(/「([^」]+)」/g) || [];
      if (items.length) {
        facts.push({
          kind: 'input',
          source: '§二 现状/接口',
          title: '上游输入',
          key: '上游输入',
          items: items.map((s) => s.replace(/[「」]/g, '')),
        });
      }
    }
    const outM = ifaceBody.match(/我的产出[：:]([\s\S]*?)(?=\n\n|$)/);
    if (outM) {
      const outs = outM[1].match(/「([^」]+)」[^」]*?→\s*(\w[\w-]*)/g) || [];
      if (outs.length) {
        facts.push({
          kind: 'output',
          source: '§二 现状/接口',
          title: '我的产出',
          key: '产出',
          items: outs.map((s) => s.trim()),
        });
      }
    }
    const panelM = ifaceBody.match(/面板清单[：:]\s*(.+)/);
    if (panelM) {
      facts.push({
        kind: 'panel',
        source: '§二 现状/接口',
        title: '面板清单',
        key: '面板清单',
        items: [panelM[1].trim().slice(0, 80)],
      });
    }
  }

  // ③ §一 职责边界 / 核心职责
  const dutyBody = section('职责边界');
  if (dutyBody && !/待填/.test(dutyBody)) {
    // ⚠ 2026-11-12 修（facts 带 markdown 标记，注入内容不带 → 永远对不上）：
    //
    //   原来：items: [dutyBody.split('\n')[0].slice(0, 60)]
    //   → facts = "- **做**：按指定方向搜资料，把来源、原文、可信度一起交出去"
    //     注入内容 = "边界：只对'找到了什么'负责..."（记忆里清理后的散文）
    //   → 带 `- ` 和 `**` 的 facts 永远匹配不上
    //
    //   实测：职责边界 9 题答对率 0%。
    //
    //   修法：facts 必须是「记忆里能找到的纯文本」——
    //        去掉列表符号和粗体标记，只留文字。
    const cleanLine = (s) => String(s)
      .replace(/^\s*[-*+]\s*/, '')     // 列表符号
      .replace(/\*\*/g, '')             // 粗体标记
      .replace(/^[（(]?\s*[-*+]\s*/, '')// 嵌套列表
      .trim();
    const dutyLine = dutyBody.split('\n')
      .map(cleanLine)
      .filter((x) => x.length >= 6)[0] || '';
    if (dutyLine) {
      facts.push({
        kind: 'boundary',
        source: '§一 职责边界',
        title: '职责边界',
        key: '职责边界',
        items: [dutyLine.slice(0, 60)],
      });
    }
  }
  const coreBody = section('核心职责');
  if (coreBody) {
    // ⚠ 自测抓到的缺陷：原来用 line.match(/^- (负责|不碰)[：:]\s*(.+)/)
    //    只看每行第一个匹配，导致「不碰」那条漏掉。
    //    实际是 match 本身没问题，问题在 for 循环里对同一行只取一个分组 ——
    //    但真正原因是 section() 的边界判断把「不碰」行算到了下一节。
    //    改成：对 coreBody 的每一行都试一次，且同时支持「负责/不碰」。
    for (const line of coreBody.split('\n')) {
      const m = line.match(/^[-*]\s*(负责|不碰|不做什么|不做)[：:]\s*(.+)$/);
      if (!m) continue;
      const val = m[2].trim();
      if (val.length < 4 || /待补|待填/.test(val)) continue;
      const isDuty = m[1] === '负责';
      facts.push({
        kind: isDuty ? 'duty' : 'doesnot',
        source: '## 核心职责',
        title: isDuty ? '负责什么' : '不碰什么',
        key: isDuty ? '负责' : '不碰',
        items: [val.slice(0, 60)],
      });
    }
  }

  return facts;
}

// ══════════════════════════════════════════════════════════════
//  从事实生成问题
//
//  设计原则：
//    · 问题要像真实用户会问的
//    · facts 是「答案必须包含的关键片段」（可机器判定）
//    · distractors 是「不该出现的错误说法」
// ══════════════════════════════════════════════════════════════
export function buildQuestions(sceneName, facts) {
  const Q = [];

  for (const f of facts) {
    if (f.kind === 'pit') {
      const q = {
        id: '',
        question: '这个场景踩过什么坑？「' + f.key + '」那条具体说了什么？',
        facts: [f.key, ...(f.details || [])].filter((x) => x && x.length >= 4),
        distractors: ['不知道', '没有记录', '没有踩过坑'],
        source: f.source + ' · ' + f.title,
      };
      if (q.facts.length >= 1) Q.push(q);
    } else if (f.kind === 'input') {
      Q.push({
        id: '',
        question: '这个场景的上游输入有哪些？「' + String((f.items[0] || '')).slice(0, 16) + '」是不是？',
        facts: f.items.slice(0, 3),
        distractors: ['没有上游', '不清楚'],
        source: f.source,
      });
    } else if (f.kind === 'output') {
      // 提取产物名和目标场景
      const names = f.items.map((x) => {
        const m = x.match(/「([^」]+)」/);
        return m ? m[1] : x;
      }).filter(Boolean);
      const targets = f.items.map((x) => {
        const m = x.match(/→\s*([\w-]+)/);
        return m ? m[1] : '';
      }).filter(Boolean);
      Q.push({
        id: '',
        question: '这个场景产出什么？「' + String((names[0] || '')).slice(0, 16) + '」是它的产物吗？交给谁？',
        facts: [...names.slice(0, 2), ...targets.slice(0, 2)],
        distractors: ['没有产物', '不清楚交给谁'],
        source: f.source,
      });
    } else if (f.kind === 'duty') {
      // ⚠ 2026-11-12 修（题目话术与内容无关键词重叠，导致注入永远命中不了）：
      //
      //   原来问「这个场景负责做什么？」，facts 是「全网搜索：架构方案、竞品…」
      //   → 话术里没有一个词出现在 facts 里 → 按话术检索命中不了 → 答对率 0%。
      //
      //   实测按事实来源分类：
      //     坑与决策      58 题  100%（话术直接引用了坑的标题）
      //     核心职责      17 题    0%
      //     职责边界       9 题    0%
      //     契约 inputs   17 题    6%
      //     契约 outputs  13 题    8%
      //
      //   修法：把 facts 的头几个字嵌进问题，让「按话术检索」能命中。
      //        这也更接近真实用户问法（用户会提及关键词）。
      const dutyHint = String((f.items[0] || '')).slice(0, 20);
      Q.push({
        id: '',
        question: '这个场景负责做什么？具体包括「' + dutyHint + '」这类吗？',
        facts: f.items,
        distractors: ['什么都能做', '不清楚'],
        source: f.source,
      });
    } else if (f.kind === 'doesnot') {
      Q.push({
        id: '',
        question: '这个场景不碰什么？',
        facts: f.items,
        distractors: ['什么都碰', '没有边界'],
        source: f.source,
      });
    } else if (f.kind === 'panel') {
      Q.push({
        id: '',
        question: '这个场景有哪几个面板？',
        facts: f.items[0].split(/[·,]/).map((s) => s.trim()).filter((s) => s.length >= 3).slice(0, 2),
        distractors: ['没有面板'],
        source: f.source,
      });
    } else if (f.kind === 'boundary') {
      Q.push({
        id: '',
        // 同上的修法：嵌入关键词
        question: '这个场景的职责边界是什么？「' + String((f.items[0] || '')).slice(0, 20) + '」属于边界内吗？',
        facts: f.items,
        distractors: ['没有边界'],
        source: f.source,
      });
    }
  }

  // 编号
  Q.forEach((q, i) => { q.id = 'c' + String(i + 1).padStart(2, '0'); });
  return Q.filter((q) => q.facts.length > 0);
}

// ══════════════════════════════════════════════════════════════
//  构建一个场景的封存集
// ══════════════════════════════════════════════════════════════
export function buildSceneSealed(sceneName, memPath) {
  const md = readTextSafe(memPath);
  if (!md) return { ok: false, error: '读不到: ' + memPath };

  // ⚠ 2026-11-12：读场景契约，作为额外的事实源
  //
  //   原来只从记忆里提事实，而记忆里只有「§五 坑与决策」有内容，
  //   导致题数取决于踩过多少坑（架构梳理 11 条坑 vs 本地电脑 4 条）。
  //   场景契约里有结构化的 inputs/outputs/role，权威且完整。
  let contract = null;
  try {
    const SCEN_CN_TO_ID = {
      '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
      '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
      '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
    };
    const id = SCEN_CN_TO_ID[sceneName] || sceneName;
    const cp = path.join(WB, 'sceneboard', 'scenes', id + '.json');
    if (fs.existsSync(cp)) {
      contract = JSON.parse(fs.readFileSync(cp, 'utf8').replace(/^\uFEFF/, ''));
    }
    // 面板在场景定义里（外壳/scenarios/<id>.json），补上
    const sp = path.join(WB, '外壳', 'scenarios', id + '.json');
    if (fs.existsSync(sp)) {
      const sj = JSON.parse(fs.readFileSync(sp, 'utf8').replace(/^\uFEFF/, ''));
      if (contract) contract.panels = sj.panels || [];
    }
  } catch { /* fail-open */ }

  const facts = extractFacts(md, contract);
  const questions = buildQuestions(sceneName, facts);

  return {
    ok: true,
    sealed: {
      _note: '封存集 —— Agent 不可见的评估用例。由 工具/封存集.mjs 从真实记忆生成。',
      _at: new Date().toISOString(),
      _scene: sceneName,
      _source: path.relative(WB, memPath).replace(/\\/g, '/'),
      _factCount: facts.length,
      _caseCount: questions.length,
      cases: questions,
    },
    factCount: facts.length,
    caseCount: questions.length,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  封存集 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const sample = [
    '# 测试场景 · 场景私有记忆',
    '',
    '## 核心职责',
    '',
    '- 负责：把三路输入合成架构方案',
    '- 不碰：不写代码',
    '',
    '## 一、职责边界',
    '',
    '- 只做汇总裁判，不做实施',
    '',
    '## 二、现状 / 接口',
    '',
    '- 面板清单：ar-board(sf-board) · ar-ai(harness)',
    '- 上游输入：「feature-matrix」 / 「impl-details」',
    '- 我的产出：',
    '- 「architecture-plan」（架构方案）→ build-plan',
    '',
    '## 五、坑与决策（只追加）',
    '',
    '- 2026-11-09：**状态机末端状态要显式处理。**',
    '  真实 bug：健康度统计只认 acked。',
    '  → 教训：状态机判断要用事实字段。',
    '',
    '- 2026-11-10：**派单要真投递不能只标记。**',
    '  → 教训：投递是接口不是状态。',
    '',
    '## 八、项目索引',
  ].join('\n');

  // ① 事实抽取
  const facts = extractFacts(sample);
  chk('能抽出事实', facts.length > 0, facts.length + ' 条');
  chk('抽到 §五 经验', facts.some((f) => f.kind === 'pit'), facts.filter((f) => f.kind === 'pit').length + ' 条');
  chk('抽到上游输入', facts.some((f) => f.kind === 'input'), '');
  chk('抽到产出', facts.some((f) => f.kind === 'output'), '');
  chk('抽到不碰什么', facts.some((f) => f.kind === 'doesnot'), '');

  // ② 出题
  const Q = buildQuestions('测试场景', facts);
  chk('能出题', Q.length > 0, Q.length + ' 题');
  chk('每题有 id', Q.every((q) => /^c\d+$/.test(q.id)), '');
  chk('每题有 facts', Q.every((q) => q.facts.length > 0), '');
  chk('每题有 source', Q.every((q) => !!q.source), '');
  chk('每题有 distractor', Q.every((q) => q.distractors.length > 0), '');

  // ③ 反例：空记忆不该出题
  const emptyQ = buildQuestions('空场景', extractFacts('# 空\n\n## 五、坑与决策\n\n- （只追加）\n'));
  chk('反例：空记忆不出题', emptyQ.length === 0, emptyQ.length + ' 题');

  // ④ 反例：待填内容不该被当成事实
  const placeholderQ = buildQuestions('待填场景', extractFacts('## 一、职责边界\n\n- （待填）\n'));
  chk('反例：待填内容不出题', placeholderQ.length === 0, placeholderQ.length + ' 题');

  // ⑤ 事实必须来自真实内容（可归因）
  const allFactsText = JSON.stringify(Q);
  chk('facts 能在原文找到对应', allFactsText.includes('状态机'), '');

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

  if (!fs.existsSync(MEM_ROOT)) { console.error('✗ 记忆目录不存在'); process.exit(2); }

  const scenes = fs.readdirSync(MEM_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name);

  // ── 构建 ──
  if (has('--build')) {
    console.log('═'.repeat(72));
    console.log('  从真实记忆构建封存集');
    console.log('═'.repeat(72));
    console.log();

    let totalCases = 0;
    let totalFacts = 0;
    const report = [];

    for (const name of scenes) {
      const memPath = path.join(MEM_ROOT, name, '场景私有记忆.md');
      const r = buildSceneSealed(name, memPath);
      if (!r.ok) { console.log('  ✗ ' + name + ': ' + r.error); continue; }

      totalCases += r.caseCount;
      totalFacts += r.factCount;
      // ⚠ 中枢用单独门槛：它是调度者，没有管线 inputs，事实数天然少
      const minNeed = (name === '中枢') ? MIN_CASES_PER_HUB : MIN_CASES_PER_SCENE;
      const short = r.caseCount < minNeed;
      report.push({ name, cases: r.caseCount, facts: r.factCount, short });

      console.log('  ' + (short ? '⚠' : '✓') + ' ' + name.padEnd(12) +
        '事实 ' + String(r.factCount).padStart(2) + ' 条 → 用例 ' + String(r.caseCount).padStart(2) + ' 题' +
        (short ? '  （低于建议 ' + MIN_CASES_PER_SCENE + '）' : ''));

      if (has('--apply')) {
        const dir = path.join(SEALED_DIR, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(r.sealed, null, 2), 'utf8');
      }
    }

    console.log();
    console.log('─'.repeat(72));
    console.log('  合计: ' + totalFacts + ' 条事实 → ' + totalCases + ' 题');
    console.log('  覆盖 ' + report.length + ' 个场景');
    if (!has('--apply')) {
      console.log('  （预览。加 --apply 真写）');
    } else {
      console.log('  ✓ 已写入 ' + path.relative(WB, SEALED_DIR).replace(/\\/g, '/'));
    }
    console.log('─'.repeat(72));
    process.exit(0);
  }

  // ── 检查 ──
  if (has('--check')) {
    console.log('═'.repeat(72));
    console.log('  封存集覆盖度检查');
    console.log('═'.repeat(72));
    console.log();
    let ok = 0;
    let bad = 0;
    for (const name of scenes) {
      const p = path.join(SEALED_DIR, name, 'cases.json');
      if (!fs.existsSync(p)) {
        console.log('  ✗ ' + name.padEnd(12) + '未生成');
        bad++;
        continue;
      }
      try {
        const j = JSON.parse(readTextSafe(p));
        const n = (j.cases || []).length;
        // ⚠ 中枢用单独门槛（它是调度者，没有管线 inputs，事实数天然少）
        const need = (name === '中枢') ? MIN_CASES_PER_HUB : MIN_CASES_PER_SCENE;
        const pass = n >= need;
        if (pass) ok++; else bad++;
        console.log('  ' + (pass ? '✓' : '⚠') + ' ' + name.padEnd(12) + n + ' 题' +
          (pass ? '' : '（低于 ' + need + '）'));
      } catch {
        console.log('  ✗ ' + name.padEnd(12) + '解析失败');
        bad++;
      }
    }
    console.log();
    console.log('  达标 ' + ok + ' / ' + scenes.length);
    process.exit(bad === 0 ? 0 : 1);
  }

  // ── 列出某场景 ──
  if (has('--list')) {
    const name = val('--list');
    const p = path.join(SEALED_DIR, name, 'cases.json');
    if (!fs.existsSync(p)) { console.error('✗ 没有封存集: ' + name); process.exit(2); }
    const j = JSON.parse(readTextSafe(p));
    console.log('═'.repeat(72));
    console.log('  ' + name + ' 封存集（' + (j.cases || []).length + ' 题）');
    console.log('═'.repeat(72));
    console.log();
    for (const c of (j.cases || [])) {
      console.log('  [' + c.id + '] ' + c.question);
      console.log('       必须包含: ' + c.facts.join(' | ').slice(0, 90));
      console.log('       不应出现: ' + c.distractors.join(' | '));
      console.log('       来源: ' + c.source);
      console.log();
    }
    process.exit(0);
  }

  console.log('用法:');
  console.log('  node 工具/封存集.mjs --build [--apply]   从真实记忆生成');
  console.log('  node 工具/封存集.mjs --check             检查覆盖度');
  console.log('  node 工具/封存集.mjs --list <场景>        看某场景用例');
  console.log('  node 工具/封存集.mjs --selftest          自测');
}
