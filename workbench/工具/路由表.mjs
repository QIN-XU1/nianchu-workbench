#!/usr/bin/env node
/**
 * 路由表 —— 「这活归谁」的查询工具
 *
 * ══════════════════════════════════════════════════════════════
 *  依据 方案/121 调研
 * ══════════════════════════════════════════════════════════════
 *
 *  1. 归属判断不能靠 LLM 自由发挥
 *     Anthropic 对 routing 的限定：「classification can be handled accurately」
 *     —— 这是测出来的，不是天赋。
 *
 *  2. does_not 三处复用（否则会漂移）：
 *     ① 路由排除项  ② 工单边界段  ③ 验收拒绝条件
 *
 *  3. 五件套缺一不可：
 *     ① 闭集枚举 + 严格 JSON + 代码校验
 *     ② 置信阈值 + 标注集校准
 *     ③ 负向路由（does_not 命中优先排除）
 *     ④ 回执复述校验
 *     ⑤ 便宜探针 + 低改派成本
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/路由表.mjs                     列出所有场景能力
 *  node 工具/路由表.mjs --scene arch-review  看单个场景详情
 *  node 工具/路由表.mjs --check "要拆竞品功能矩阵"
 *                                            判断一句话归谁（含排除判断）
 *  node 工具/路由表.mjs --json               JSON 输出
 *  node 工具/路由表.mjs --selftest           自测（含反例）
 */

import fs from 'node:fs';
import { sceneIds } from './_场景清单.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROUTE_YAML = path.join(WB, '数据', '.dsh', '场景路由.yaml');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  极简 YAML 解析（只支持本文件用到的结构）
//
//  不引第三方库：路由表结构固定，手写解析更可控，
//  也避免给工作台增加依赖。
// ══════════════════════════════════════════════════════════════
export function parseRouteYaml(text) {
  const scenes = [];
  let cur = null;
  let curKey = null;
  let curList = null;

  for (const rawLine of text.split('\n')) {
    // 去掉行尾注释（但要小心字符串里的 #）
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // 新的场景条目
    const mStart = line.match(/^-\s+id:\s*(.+)$/);
    if (mStart) {
      if (cur) {
        if (curList) cur[curKey] = curList;
        scenes.push(cur);
      }
      cur = { id: mStart[1].trim(), does_not: [], inputs: [], outputs_to: [] };
      curKey = null;
      curList = null;
      continue;
    }

    if (!cur) continue;

    // 列表项
    const mItem = line.match(/^\s{4,}-\s+(.+)$/);
    if (mItem && curList) {
      curList.push(mItem[1].trim());
      continue;
    }

    // 键值对
    const mKv = line.match(/^  (\w+):\s*(.*)$/);
    if (mKv) {
      if (curList) {
        cur[curKey] = curList;
        curList = null;
      }
      const key = mKv[1];
      const rawVal = mKv[2].trim();
      curKey = key;

      if (rawVal === '') {
        // 下面是列表
        curList = [];
      } else if (rawVal.startsWith('[')) {
        // 内联数组 [a, b]
        const inner = rawVal.replace(/^\[|\]$/g, '');
        cur[key] = inner.split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        cur[key] = rawVal;
      }
    }
  }
  if (cur) {
    if (curList) cur[curKey] = curList;
    scenes.push(cur);
  }
  return scenes;
}

/** 读路由表 */
export function loadRoutes(file) {
  const p = file || ROUTE_YAML;
  const t = readTextSafe(p);
  if (!t) return { ok: false, error: '路由表不存在: ' + p };
  try {
    const scenes = parseRouteYaml(t);
    if (scenes.length === 0) return { ok: false, error: '路由表解析为空' };
    return { ok: true, scenes };
  } catch (e) {
    return { ok: false, error: '解析失败: ' + (e && e.message) };
  }
}

// ══════════════════════════════════════════════════════════════
//  路由判断
//
//  算法（纯本地，不调 LLM）：
//    ① 负向优先：命中某场景的 does_not → 排除该场景
//    ② 正向打分：dispatch_when / deliverable 的关键词命中
//    ③ 输出候选 + 置信度 + 理由
//
//  为什么不调 LLM：这一步必须可复现、可测试、零成本。
//  LLM 只在「本地打不出结果」时才介入（见 --needs-llm）。
// ══════════════════════════════════════════════════════════════
function tokenize(s) {
  // 中文按 2-gram 切，英文按词切
  const out = new Set();
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) {
      out.add(seg.slice(i, i + 2));
    }
  }
  const words = s.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [];
  for (const w of words) out.add(w.toLowerCase());
  return out;
}

/** 归一化：只保留排除项的正文，去掉括号里的解释
 *
 *  为什么（自测抓到的真实缺陷）：
 *    does_not 写的是「拆竞品功能（那是竞品拆解的活）」，
 *    括号里是给人看的解释，但它会稀释关键词命中率：
 *      整句 10 个 token，命中的只有前 4 个 → 0.40，达不到 0.50 阈值
 *      去掉括号后 4 个 token 全命中 → 1.00，正确排除
 *
 *  这是负向路由的关键一环：排除项必须是「动作词」，不是「解释句」。
 */
function stripParen(s) {
  return String(s).replace(/[（(][^）)]*[）)]/g, '').trim();
}

export function routeOne(need, scenes) {
  const needTokens = tokenize(need);
  const needStr = String(need || '');

  const results = scenes.map((s) => {
    // ① 负向排除（用正文，不含括号解释）
    const excludedBy = [];
    for (const bad of (s.does_not || [])) {
      const badTokens = tokenize(stripParen(bad));
      if (badTokens.size === 0) continue;
      let hit = 0;
      for (const t of badTokens) if (needTokens.has(t)) hit++;
      // 排除项命中率 >= 50% 且至少 2 个 token → 排除该场景
      if (badTokens.size >= 2 && hit / badTokens.size >= 0.5) {
        excludedBy.push(bad);
      }
    }

    // ② 正向打分
    //
    //  ⚠ 2026-11-10 修正（自测没说出的真实缺陷）：
    //    原来用「命中率 = 命中数 / 描述总 token 数」，
    //    但描述越长分母越大 → 长描述的准确场景反而分数低。
    //    实测：「拆竞品功能矩阵」命中竞品拆解 4 个关键词，
    //         但 dispatch_when 有 19 个 token → 0.211，被判定为 low。
    //
    //    改用「命中数 + 覆盖率」的复合分：
    //      · 命中数占主导（命中越多越相关）
    //      · 覆盖率作加成（描述短而精准的略优）
    //
    //    这样：命中 4 个 → 分数够高；只命中 1 个 → 分数低。
    const when = stripParen(s.dispatch_when || '') + ' ' + stripParen(s.deliverable || '');
    const whenTokens = tokenize(when);
    let hit = 0;
    const hitWords = [];
    for (const t of whenTokens) {
      if (needTokens.has(t)) { hit++; hitWords.push(t); }
    }
    const coverage = whenTokens.size > 0 ? hit / whenTokens.size : 0;
    // 复合分：命中数（归一化到 0-0.8）+ 覆盖率（0-0.2）
    const hitScore = Math.min(hit / 5, 1) * 0.8;
    let score = hitScore + coverage * 0.2;

    // ③ 场景名直接命中 —— 最强信号（2026-11-10 补）
    //
    //   实测缺陷：问「架构梳理」时判定为 low，因为场景名本身
    //   不在 dispatch_when 的 token 里（dispatch_when 写的是职责描述）。
    //
    //   直接提到场景名，说明用户明确点名要这个场景 → 直接给高置信。
    const nameHit = s.name && needStr.includes(String(s.name));
    const idHit = s.id && needStr.toLowerCase().includes(String(s.id).toLowerCase());
    if (nameHit || idHit) {
      score = Math.max(score, 0.90);
      hitWords.push(nameHit ? '@场景名' : '@场景id');
    }

    return {
      id: s.id,
      name: s.name,
      score: +score.toFixed(3),
      hitWords: hitWords.slice(0, 6),
      excludedBy,
      excluded: excludedBy.length > 0,
    };
  });

  // ③ 排序：未被排除的按分数降序
  const viable = results.filter((r) => !r.excluded).sort((a, b) => b.score - a.score);
  const best = viable[0] || null;

  // 置信判断：最高分与次高分差距
  let confidence = 'low';
  let needsClarification = true;
  if (best && best.score >= 0.30) {
    const second = viable[1];
    const gap = second ? best.score - second.score : best.score;
    if (best.score >= 0.45 && gap >= 0.10) {
      confidence = 'high';
      needsClarification = false;
    } else if (best.score >= 0.30 && gap >= 0.05) {
      confidence = 'medium';
      needsClarification = false;
    }
  }

  return {
    chosen: confidence === 'low' ? null : best,
    confidence,
    needsClarification,
    candidates: viable.slice(0, 3),
    all: results,
  };
}

/**
 * 严格 JSON 路由结果 —— 供中枢的 route 决策点使用
 *
 * ══════════════════════════════════════════════════════════════
 *  依据 方案/121 §8.1
 * ══════════════════════════════════════════════════════════════
 *
 *  「route 与 progress 必须是严格 JSON + 代码校验，
 *    因为这两个决策最容易漂。」
 *
 *  所以输出必须是：
 *    · 闭集枚举（scene 只能是 8 个之一，或 null）
 *    · 明确 confidence（high/medium/low 三档）
 *    · 带 evidence（命中了哪些词）
 *    · 带 alternative（次选是谁）
 *    · 带 why_not（为什么没选它）
 *    · 带 needs_clarification（要不要追问）
 *
 *  任何字段越界 → validateRouteJson 直接报错。
 */
// ⚠ 2026-11-14 改：不再硬编码，从 scenarios/*.json 动态读
//
//   原来这里写死 9 个场景 id，新增 3 个工坊后忘了更新
//   → 自测报「场景数正确（与 SCENE_IDS 一致）」失败
//   → 而且 routeJson 的 validateRouteJson 会把新场景判成「越界」：
//     「scene 不在闭集内：backend-craft（允许：research/... 9 个）」
//
//   唯一权威是 外壳/scenarios/*.json（界面真正在用的配置）。
export const SCENE_IDS = sceneIds();

export function routeJson(need, scenes) {
  const r = routeOne(need, scenes);
  const best = r.chosen;
  const second = r.candidates.find((c) => !best || c.id !== best.id) || null;

  // 被排除的场景
  const excluded = r.all.filter((x) => x.excluded).map((x) => ({
    scene: x.id,
    reason: x.excludedBy[0] || '',
  }));

  return {
    need: String(need),
    scene: best ? best.id : null,
    confidence: r.confidence,
    evidence_span: best ? best.hitWords.join(',') : '',
    score: best ? best.score : 0,
    alternative: second ? second.id : null,
    why_not: second
      ? second.id + ' 得分 ' + second.score + ' < ' + (best ? best.score : 0)
      : (best ? '' : '无候选达到阈值'),
    excluded,
    needs_clarification: r.needsClarification,
  };
}

/**
 * 校验 route JSON —— 越界直接抛错
 *
 * 这是「严格 JSON + 代码校验」的落地：
 * 中枢如果自己编了一个不在闭集里的场景名，这里会直接拒绝。
 */
export function validateRouteJson(obj) {
  const errs = [];

  if (typeof obj !== 'object' || obj === null) {
    return ['route 结果必须是对象'];
  }

  // scene 必须是闭集之一或 null
  if (obj.scene !== null && !SCENE_IDS.includes(obj.scene)) {
    errs.push('scene 不在闭集内：' + String(obj.scene) + '（允许：' + SCENE_IDS.join('/') + ' 或 null）');
  }

  // confidence 必须是三档之一
  if (!['high', 'medium', 'low'].includes(obj.confidence)) {
    errs.push('confidence 必须是 high/medium/low，收到：' + String(obj.confidence));
  }

  // needs_clarification 必须是布尔
  if (typeof obj.needs_clarification !== 'boolean') {
    errs.push('needs_clarification 必须是布尔，收到：' + typeof obj.needs_clarification);
  }

  // 一致性：低置信必须要求澄清
  if (obj.confidence === 'low' && obj.needs_clarification !== true) {
    errs.push('low 置信必须 needs_clarification = true（不许猜）');
  }

  // 一致性：选了场景就不该要求澄清
  if (obj.scene !== null && obj.needs_clarification === true) {
    errs.push('已选定场景却要求澄清，矛盾');
  }

  // alternative 必须是闭集之一或 null
  if (obj.alternative !== null && obj.alternative !== undefined && !SCENE_IDS.includes(obj.alternative)) {
    errs.push('alternative 不在闭集内：' + String(obj.alternative));
  }

  // 选了场景必须有证据
  if (obj.scene !== null && (!obj.evidence_span || String(obj.evidence_span).trim() === '')) {
    errs.push('选了场景却没有 evidence_span（必须有命中依据）');
  }

  return errs;
}

// ══════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  路由表 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① YAML 解析
  const r = loadRoutes();
  chk('路由表可加载', r.ok, r.ok ? r.scenes.length + ' 个场景' : r.error);

  if (r.ok) {
    const ids = r.scenes.map((s) => s.id);
    chk('场景数正确（与 SCENE_IDS 一致）', r.scenes.length === SCENE_IDS.length, r.scenes.length + ' 个: ' + ids.join(', '));
    chk('每个场景有 dispatch_when', r.scenes.every((s) => s.dispatch_when), '');
    chk('每个场景有 does_not', r.scenes.every((s) => (s.does_not || []).length > 0), '');
    chk('每个场景有 verify_hint', r.scenes.every((s) => s.verify_hint), '');

    // ② 正向路由（应该命中）
    const t1 = routeOne('要拆竞品的功能矩阵和能力边界', r.scenes);
    chk('正向：拆竞品功能矩阵 → 竞品拆解',
        t1.chosen?.id === 'competitor-analyze',
        (t1.chosen?.name || '无') + ' conf=' + t1.confidence);

    const t2 = routeOne('出一份架构方案，定分层，列风险清单', r.scenes);
    chk('正向：出架构方案 → 架构梳理',
        t2.chosen?.id === 'arch-review',
        (t2.chosen?.name || '无') + ' conf=' + t2.confidence);

    const t3 = routeOne('清磁盘，找大文件，释放空间', r.scenes);
    chk('正向：清磁盘 → 本地电脑',
        t3.chosen?.id === 'pc-cleanup',
        (t3.chosen?.name || '无') + ' conf=' + t3.confidence);

    // ③ 负向排除（关键反例）
    //    「拆竞品」这句话里含有「拆」和「竞品」，
    //    但架构梳理的 does_not 里写着「拆竞品功能」→ 必须被排除
    const t4 = routeOne('拆竞品功能矩阵', r.scenes);
    const archExcluded = t4.all.find((x) => x.id === 'arch-review')?.excluded;
    chk('负向：架构梳理被排除（does_not 命中）',
        archExcluded === true,
        'excluded=' + archExcluded);

    // ④ 无法判断时必须要求澄清，不许瞎猜
    const t5 = routeOne('帮我看看这个东西', r.scenes);
    chk('低置信必须要求澄清', t5.needsClarification === true,
        'conf=' + t5.confidence);

    // ⑤ 反例：空输入必须不能命中
    const t6 = routeOne('', r.scenes);
    chk('反例：空输入不得命中', t6.chosen === null, 'conf=' + t6.confidence);

    // ⑥ 反例：完全无关的内容不得高置信命中
    const t7 = routeOne('qwertyuiop asdfghjkl', r.scenes);
    chk('反例：无关内容不得高置信', t7.confidence !== 'high',
        'conf=' + t7.confidence);

    // ⑥b 场景名直接命中（实测补上的缺陷）
    const t8 = routeOne('架构梳理', r.scenes);
    chk('场景名直接命中 → arch-review',
        t8.chosen?.id === 'arch-review',
        (t8.chosen?.name || '无') + ' conf=' + t8.confidence);

    const t9 = routeOne('给架构梳理写经验记录', r.scenes);
    chk('含场景名的句子也能命中',
        t9.chosen?.id === 'arch-review',
        (t9.chosen?.name || '无') + ' conf=' + t9.confidence);

    const t10 = routeOne('调研一下这个项目', r.scenes);
    chk('「调研」能命中 research',
        t10.chosen?.id === 'research',
        (t10.chosen?.name || '无') + ' conf=' + t10.confidence);

    // ⑦ 严格 JSON 输出
    const j1 = routeJson('拆竞品功能矩阵', r.scenes);
    chk('routeJson 能出结果', j1.scene === 'competitor-analyze',
        'scene=' + j1.scene + ' conf=' + j1.confidence);
    chk('routeJson 通过校验', validateRouteJson(j1).length === 0,
        validateRouteJson(j1).join(';'));

    // ⑧ 反例：越界场景名必须被拒
    const bad1 = { ...j1, scene: '不存在的场景' };
    chk('反例：越界场景名必须被拒', validateRouteJson(bad1).length > 0,
        validateRouteJson(bad1)[0] || '');

    // ⑨ 反例：非法 confidence 必须被拒
    const bad2 = { ...j1, confidence: 'maybe' };
    chk('反例：非法 confidence 必须被拒', validateRouteJson(bad2).length > 0,
        validateRouteJson(bad2)[0] || '');

    // ⑩ 反例：low 置信却不要求澄清必须被拒
    const bad3 = { ...j1, confidence: 'low', needs_clarification: false };
    chk('反例：low 置信不提澄清必须被拒', validateRouteJson(bad3).length > 0,
        validateRouteJson(bad3)[0] || '');

    // ⑪ 反例：选了场景却没有证据必须被拒
    const bad4 = { ...j1, evidence_span: '' };
    chk('反例：选场景无证据必须被拒', validateRouteJson(bad4).length > 0,
        validateRouteJson(bad4)[0] || '');
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

  const r = loadRoutes();
  if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }

  if (has('--json')) {
    console.log(JSON.stringify(r.scenes, null, 2));
    process.exit(0);
  }

  // ── 单个场景详情 ──
  if (has('--scene')) {
    const id = val('--scene');
    const s = r.scenes.find((x) => x.id === id || x.name === id);
    if (!s) { console.error('找不到场景: ' + id); process.exit(2); }
    console.log('═'.repeat(72));
    console.log('  ' + s.name + '（' + s.id + '）');
    console.log('═'.repeat(72));
    console.log();
    console.log('什么时候派给它：');
    console.log('  ' + s.dispatch_when);
    console.log();
    console.log('绝对不碰：');
    for (const d of (s.does_not || [])) console.log('  ✗ ' + d);
    console.log();
    console.log('产物：' + s.deliverable);
    console.log('验收：' + s.verify_hint);
    console.log('证据类型：' + s.evidence_type);
    console.log('依赖输入：' + ((s.inputs || []).join(', ') || '无'));
    console.log('产出去向：' + ((s.outputs_to || []).join(', ') || '无'));
    process.exit(0);
  }

  // ── 判断归属（严格 JSON 输出，供中枢 route 决策点用）──
  if (has('--route-json')) {
    const need = val('--route-json');
    const obj = routeJson(need, r.scenes);
    const errs = validateRouteJson(obj);
    if (errs.length > 0) {
      // 校验失败 → 输出错误，不输出结果
      console.error(JSON.stringify({ ok: false, errors: errs }, null, 2));
      process.exit(2);
    }
    console.log(JSON.stringify(obj, null, 2));
    process.exit(obj.needs_clarification ? 1 : 0);
  }

  // ── 只读自检：判据表本身是否健康（2026-11-13 加）──
  //
  //  ⚠ 为什么加：
  //    机制体检把这一项从 --selftest 改成了「跑真实检查」，
  //    但它当时注册的参数是 `--check` —— 而 --check 需要跟一个需求文本，
  //    不跟就 argparse 拿到 undefined → tokenize(undefined) 崩溃（TypeError）。
  //
  //    这是我的误判：「--check」看起来像只读检查，实际是「判归属」。
  //    现在加一个真正的只读模式 `--health`：
  //      不接收外部输入，只检查判据表本身有没有结构问题
  //      （场景漏了 dispatch_when / 排除项写成了说明句 / 场景数不对……）。
  if (has('--health')) {
    const errs = [];
    const scenes = r.scenes || [];
    if (!scenes.length) errs.push('判据表里一个场景都没有');

    for (const s of scenes) {
      if (!s.id) errs.push('有场景缺 id');
      if (!s.name) errs.push((s.id || '?') + ' 缺 name');
      const dw = s.dispatch_when;
      if (!dw || (Array.isArray(dw) && !dw.length)) {
        errs.push((s.name || s.id) + ' 缺 dispatch_when（这个场景永远不会被路由到）');
      }
      // 排除项写不写括号解释都行 ——
      //
      // ⚠ 2026-11-13 修（第一版这里判得太严，14 条全是误报）
      //
      //   第一版：只要 does_not 里出现括号就报错。
      //   实测 14 条全红，但逐条看发现：
      //     代码在 L182 已经 `tokenize(stripParen(bad))` ——
      //     也就是运行时**已经去掉括号**，所以功能完全正常。
      //     数据里保留「（那是竞品拆解的活）」只是**给人看的注释**，
      //     而且它确实有用（说明为什么这是排除项）。
      //
      //   只有「去掉括号后什么都不剩」才是真错
      for (const d of (s.does_not || [])) {
        const bare = stripParen(String(d));
        if (!bare || bare.length < 2) {
          errs.push((s.name || s.id) + ' 的 does_not 去掉括号后没有内容: ' + String(d).slice(0, 30));
        }
      }
    }

    console.log('═'.repeat(72));
    console.log('  判据表健康检查（只读）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  场景数: ' + scenes.length);
    console.log('  问题:   ' + errs.length);
    if (errs.length) {
      console.log();
      for (const e of errs.slice(0, 15)) console.log('    · ' + e);
      if (errs.length > 15) console.log('    ... 还有 ' + (errs.length - 15) + ' 个');
      process.exit(1);
    }
    console.log();
    console.log('  ✓ 判据表结构健康（每个场景都有 dispatch_when，排除项都是动作词）');
    process.exit(0);
  }

  // ── 判断归属 ──
  if (has('--check')) {
    const need = val('--check');
    if (!need) {
      // ⚠ 2026-11-13 加防崩：--check 后面必须跟需求文本
      console.error('  ✗ --check 需要跟一个需求文本，例如：');
      console.error('      node 工具/路由表.mjs --check "帮我看看这个竞品有什么功能"');
      console.error('    只检查判据表本身用 --health');
      process.exit(2);
    }
    const res = routeOne(need, r.scenes);
    console.log('═'.repeat(72));
    console.log('  归属判断');
    console.log('═'.repeat(72));
    console.log();
    console.log('需求：' + need);
    console.log();
    if (res.chosen) {
      console.log('判定：→ ' + res.chosen.name + '（' + res.chosen.id + '）');
      console.log('置信：' + res.confidence);
      console.log('命中词：' + res.chosen.hitWords.join(', '));
    } else {
      console.log('判定：⚠ 无法确定归属（置信 ' + res.confidence + '）');
      console.log('     必须向用户追问，不许猜。');
    }
    console.log();
    console.log('候选：');
    for (const c of res.candidates) {
      console.log('  ' + (c.excluded ? '✗' : '·') + ' ' + c.name.padEnd(10) +
        ' 分数 ' + String(c.score).padEnd(6) +
        (c.excluded ? '（被排除：' + c.excludedBy[0] + '）' : ''));
    }
    process.exit(res.needsClarification ? 1 : 0);
  }

  // ── 列出所有场景 ──
  console.log('═'.repeat(72));
  console.log('  场景路由表');
  console.log('═'.repeat(72));
  console.log();
  for (const s of r.scenes) {
    console.log(s.name + '（' + s.id + '）');
    console.log('  派给它：' + s.dispatch_when);
    console.log('  不碰：  ' + (s.does_not || []).join(' / '));
    console.log();
  }
}
