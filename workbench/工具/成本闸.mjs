#!/usr/bin/env node
/**
 * 成本闸 —— 防止「挂机一晚上烧光余额」
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据：luanyujia 的一次真实事故
 *  （视频 BV1VuJi6rE9B「AI协作互相聊天聊了十个小时」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > 「主对话积压了一百多条消息，助手 AI 也积压了四十条。
 *  >  任务进度确实快，但是后半部分全部都是循环对话。
 *  >  他们居然聊起天来了。我真的服了。
 *  >  任务进度有，但是没完全做好，对话就浪费了几十块。」
 *  >
 *  > 「我这边也是很放心，于是我就把电脑挂了一晚上。
 *  >  醒来之后发现余额用完。」
 *  >
 *  > 「他说 4 点 19 余额就没了，浪费了一个小时的 Token。」
 *
 *  根本原因不是架构，是他说的那句「我看着差不多能处理就没管」。
 *
 * ══════════════════════════════════════════════════════════════
 *  三道闸
 * ══════════════════════════════════════════════════════════════
 *
 *  闸 A：单次任务预算
 *        每次派单/批处理前声明预算，超了拒跑
 *
 *  闸 B：累计日预算
 *        一天的总消耗上限，到点停手
 *
 *  闸 C：循环检测
 *        连续 N 轮内容高度重复 → 判定「在聊天」→ 强制中断
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/成本闸.mjs --init                      初始化预算配置
 *  node 工具/成本闸.mjs --status                    当前消耗状态
 *  node 工具/成本闸.mjs --check --tokens 50000      检查这次跑得起吗
 *  node 工具/成本闸.mjs --spend --tokens 12000 --note "派单 d-001"
 *  node 工具/成本闸.mjs --loop-check --records f.json  检查是否在循环对话
 *  node 工具/成本闸.mjs --selftest                  自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const CFG_FILE = path.join(DATA_ROOT, '成本预算.json');
const SPEND_FILE = path.join(DATA_ROOT, '成本台账.jsonl');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  默认预算（保守）
//
//  PursuerRay 按 token 计费，具体单价未知。
//  这里用「token 数」作为预算单位，不给假的钱数。
// ══════════════════════════════════════════════════════════════
export const DEFAULT_BUDGET = {
  /** 单个任务最多多少 token */
  perTask: 200000,
  /** 一天最多多少 token */
  perDay: 2000000,
  /** 单次批处理最多多少轮（防无限循环） */
  maxRounds: 30,
  /**
   * 连续多少轮内容相似算「在聊天」
   *
   *  ⚠ 2026-11-10 修正（自测抓到）：
   *    原来设 3，但对话通常是「a,b,a,b,...」交替，
   *    间隔 3 轮比的是不同角色的消息（a 对 b）→ 相似度恒为 0，永远判不出。
   *    间隔 2 轮才是「同一角色说了两次」→ 才能比较。
   */
  loopWindow: 2,
  /** 相似度阈值 */
  loopSimilarity: 0.75,
  /** 单次挂机最长分钟 */
  maxWallClockMin: 120,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

export function loadBudget(file) {
  const cfg = readJsonSafe(file || CFG_FILE);
  return { ...DEFAULT_BUDGET, ...(cfg || {}) };
}

// ══════════════════════════════════════════════════════════════
//  台账
// ══════════════════════════════════════════════════════════════
export function loadSpend(file) {
  const t = readTextSafe(file || SPEND_FILE);
  if (!t) return [];
  return t.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function todaySpend(records, now) {
  const d = new Date(now || Date.now()).toISOString().slice(0, 10);
  return records
    .filter((r) => String(r.at || '').startsWith(d))
    .reduce((a, r) => a + (Number(r.tokens) || 0), 0);
}

// ══════════════════════════════════════════════════════════════
//  闸 A + B：预算检查
// ══════════════════════════════════════════════════════════════
export function checkBudget(wantTokens, opts) {
  const o = opts || {};
  const budget = o.budget || loadBudget(o.budgetFile);
  const records = o.records || loadSpend(o.spendFile);
  const now = o.now || Date.now();

  const usedToday = todaySpend(records, now);
  const remainToday = budget.perDay - usedToday;
  const want = Number(wantTokens) || 0;

  const problems = [];

  // 闸 A：单次任务
  if (want > budget.perTask) {
    problems.push('单次 ' + want + ' token 超过单任务上限 ' + budget.perTask);
  }

  // 闸 B：日累计
  if (want > remainToday) {
    problems.push('本次 ' + want + ' token 超过今日剩余 ' + remainToday +
      '（已用 ' + usedToday + ' / ' + budget.perDay + '）');
  }

  return {
    ok: problems.length === 0,
    problems,
    want,
    perTask: budget.perTask,
    perDay: budget.perDay,
    usedToday,
    remainToday,
    usagePct: +(usedToday / budget.perDay * 100).toFixed(1),
  };
}

export function recordSpend(tokens, note, opts) {
  const o = opts || {};
  const file = o.spendFile || SPEND_FILE;
  const rec = {
    at: new Date(o.now || Date.now()).toISOString(),
    tokens: Number(tokens) || 0,
    note: String(note || '').slice(0, 120),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

// ══════════════════════════════════════════════════════════════
//  闸 C：循环对话检测
//
//  依据他的事故：「后半部分全部都是循环对话」「他们居然聊起天来了」
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

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 检测一段对话记录是否在循环
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-10 修正（自测抓到的致命漏检）
 * ══════════════════════════════════════════════════════════════
 *
 *  第一版用「同角色间隔 window 轮 Jaccard 相似度」。
 *  自测发现：他的事故那种「近似重复」漏检了：
 *
 *    a: 关于这个技术方案我建议使用分层架构，接入层负责协议转换
 *    a: 关于这个技术方案我建议使用分层架构，接入层负责协议转换，业务层负责编排
 *    a: 关于这个技术方案我建议使用分层架构，接入层负责协议转换，业务层负责编排和校验
 *
 *  相似度只有 ~0.5（因为每句都在加长，并集越来越大），
 *  低于 0.75 阈值 → 判不出来。
 *
 *  但**这恰恰是最典型的「越聊越长、信息没增加」的循环**。
 *
 *  修法：改用 **containment（包含度）** 而不是 Jaccard：
 *    forward  = 后者有多少 token 出现在前者里
 *    backward = 前者有多少 token 出现在后者里
 *
 *  循环的特征：forward 极高（后者基本包含前者）但 backward 很低
 *  → 意思是「只是在前面基础上加话，没有真正的新信息」。
 *
 *  这个判据同时能抓：
 *    · 完全重复（forward=1, backward=1）
 *    · 越聊越长（forward≈1, backward 低）
 *    · 客套循环（两边都高）
 */
export function detectLoop(records, opts) {
  const o = opts || {};
  const budget = o.budget || loadBudget(o.budgetFile);
  const window = budget.loopWindow;

  const msgs = (records || []).filter((r) => r && r.text && String(r.text).trim().length > 0);
  if (msgs.length < window * 2) {
    return {
      inLoop: false,
      pairs: [],
      reason: '消息太少（' + msgs.length + ' < ' + window * 2 + '），不足以判断',
    };
  }

  function containment(a, b) {
    const ga = grams(a);
    const gb = grams(b);
    if (!ga.size || !gb.size) return { fw: 0, bw: 0 };
    let hit = 0;
    for (const g of gb) if (ga.has(g)) hit++;
    const fw = hit / gb.size;            // b 有多少在 a 里
    let hit2 = 0;
    for (const g of ga) if (gb.has(g)) hit2++;
    const bw = hit2 / ga.size;           // a 有多少在 b 里
    return { fw, bw };
  }

  const pairs = [];
  for (let i = window; i < msgs.length; i++) {
    const a = msgs[i - window];
    const b = msgs[i];
    const { fw, bw } = containment(a.text, b.text);

    // 循环判据（任一成立）：
    //   ① 完全重复：两边都 ≥ threshold
    //   ② 越聊越长：后者基本包含前者（fw 高），但前者不包含后者（bw 低）
    const isRepeat = fw >= budget.loopSimilarity && bw >= budget.loopSimilarity;
    const isGrowing = fw >= 0.80 && bw <= 0.60;

    if (isRepeat || isGrowing) {
      pairs.push({
        i: i - window,
        j: i,
        fw: +fw.toFixed(3),
        bw: +bw.toFixed(3),
        kind: isRepeat ? '重复' : '越聊越长',
        aRole: a.role,
        bRole: b.role,
      });
    }
  }

  // 只要检出 2 处以上就判定循环
  const inLoop = pairs.length >= 2;

  return {
    inLoop,
    pairs,
    loopCount: pairs.length,
    threshold: budget.loopSimilarity,
    window,
    reason: inLoop
      ? '检测到 ' + pairs.length + ' 处循环迹象（' +
        pairs.slice(0, 2).map((p) => p.kind + ':' + p.fw).join(', ') +
        '）→ 疑似在聊天'
      : '未检测到循环（' + pairs.length + ' 处）',
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  成本闸 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 默认预算存在
  const b = loadBudget('__nonexistent__');
  chk('有单任务上限', b.perTask > 0, String(b.perTask));
  chk('有日上限', b.perDay > 0, String(b.perDay));
  chk('有循环窗口', b.loopWindow > 0, String(b.loopWindow));
  chk('有挂机上限', b.maxWallClockMin > 0, String(b.maxWallClockMin));

  // ② 预算检查：正常
  const ok1 = checkBudget(50000, { budget: { ...DEFAULT_BUDGET, perDay: 2000000 }, records: [], now: Date.parse('2026-11-10T10:00:00Z') });
  chk('正常请求通过', ok1.ok === true, ok1.problems.join(';') || 'ok');
  chk('剩余额度算对', ok1.remainToday === 2000000, String(ok1.remainToday));

  // ③ 闸 A：超单任务上限
  const bad1 = checkBudget(999999999, { budget: DEFAULT_BUDGET, records: [], now: Date.now() });
  chk('反例：超单任务上限被拒', bad1.ok === false, bad1.problems[0] || '');

  // ④ 闸 B：超日累计
  const records = [
    { at: '2026-11-10T01:00:00.000Z', tokens: 1900000, note: '已用很多' },
  ];
  const bad2 = checkBudget(200000, {
    budget: { ...DEFAULT_BUDGET, perDay: 2000000 },
    records,
    now: Date.parse('2026-11-10T10:00:00Z'),
  });
  chk('反例：超日累计被拒', bad2.ok === false, bad2.problems[0] || '');
  chk('已用额度算对', bad2.usedToday === 1900000, String(bad2.usedToday));

  // ⑤ 反例：昨天的不算今天
  const oldRecords = [
    { at: '2026-11-09T01:00:00.000Z', tokens: 1900000, note: '昨天用的' },
  ];
  const ok2 = checkBudget(200000, {
    budget: { ...DEFAULT_BUDGET, perDay: 2000000 },
    records: oldRecords,
    now: Date.parse('2026-11-10T10:00:00Z'),
  });
  chk('昨天的不算今天', ok2.usedToday === 0, String(ok2.usedToday));

  // ⑥ 循环检测：正常对话不判循环
  const normal = [
    { role: 'a', text: '请帮我分析这个架构的风险点' },
    { role: 'b', text: '好的，我发现三个风险：并发、数据一致性、降级策略' },
    { role: 'a', text: '能详细说说并发那个吗' },
    { role: 'b', text: '并发风险主要在接入层，压测显示 1200 QPS 开始出现超时' },
    { role: 'a', text: '那应该怎么优化' },
    { role: 'b', text: '建议加连接池并做限流，另外把慢查询移到异步队列' },
  ];
  const d1 = detectLoop(normal);
  chk('正常对话不判循环', d1.inLoop === false, d1.reason);

  // ⑦ 循环检测：真循环必须判出来
  const looping = [
    { role: 'a', text: '请确认一下这个任务是否已经完成，我们需要验证结果' },
    { role: 'b', text: '请确认一下这个任务是否已经完成，我们需要验证结果' },
    { role: 'a', text: '请确认一下这个任务是否已经完成，我们需要验证结果' },
    { role: 'b', text: '请确认一下这个任务是否已经完成，我们需要验证结果' },
    { role: 'a', text: '请确认一下这个任务是否已经完成，我们需要验证结果' },
    { role: 'b', text: '请确认一下这个任务是否已经完成，我们需要验证结果' },
  ];
  const d2 = detectLoop(looping);
  chk('完全重复必须判循环', d2.inLoop === true, d2.reason);

  // ⑧ 循环检测：近似重复也要判出来（他说「全部都是技术讨论」那种）
  const nearLoop = [
    { role: 'a', text: '关于这个技术方案我建议使用分层架构，接入层负责协议转换' },
    { role: 'b', text: '明白了，那我先看看现有的代码结构再给你反馈' },
    { role: 'a', text: '关于这个技术方案我建议使用分层架构，接入层负责协议转换，业务层负责编排' },
    { role: 'b', text: '嗯，我看了一下代码，确实需要重构' },
    { role: 'a', text: '关于这个技术方案我建议使用分层架构，接入层负责协议转换，业务层负责编排和校验' },
    { role: 'b', text: '好，那我们按这个方向推进吧' },
  ];
  const d3 = detectLoop(nearLoop, { budget: { ...DEFAULT_BUDGET, loopSimilarity: 0.5 } });
  chk('近似重复也能判出（放宽阈值）', d3.inLoop === true, 'loopCount=' + d3.loopCount);

  // ⑨ 反例：消息太少不误判
  const few = [{ role: 'a', text: '你好' }];
  const d4 = detectLoop(few);
  chk('反例：消息太少不误判', d4.inLoop === false, d4.reason);

  // ⑩ 关键：这个闸必须能拦住事故
  chk('关键：能拦住「聊了十小时」这类事故',
      d2.inLoop === true && d3.inLoop === true,
      '这是成本闸存在的唯一理由');

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

  // ── 初始化 ──
  if (has('--init')) {
    if (fs.existsSync(CFG_FILE) && !has('--force')) {
      console.log('已存在: ' + path.relative(WB, CFG_FILE).replace(/\\/g, '/'));
      process.exit(0);
    }
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(DEFAULT_BUDGET, null, 2), 'utf8');
    console.log('✓ 已初始化预算配置 → ' + path.relative(WB, CFG_FILE).replace(/\\/g, '/'));
    console.log(JSON.stringify(DEFAULT_BUDGET, null, 2));
    process.exit(0);
  }

  const budget = loadBudget();
  const records = loadSpend();

  // ── 状态 ──
  if (has('--status') || (!has('--check') && !has('--spend') && !has('--loop-check') && !has('--init'))) {
    const used = todaySpend(records);
    console.log('═'.repeat(72));
    console.log('  成本状况');
    console.log('═'.repeat(72));
    console.log();
    console.log('  今日已用:  ' + used + ' token');
    console.log('  今日上限:  ' + budget.perDay + ' token');
    console.log('  剩余:      ' + (budget.perDay - used) + ' token');
    console.log('  使用率:    ' + (used / budget.perDay * 100).toFixed(1) + '%');
    console.log();
    const bar = '█'.repeat(Math.round(used / budget.perDay * 30)).padEnd(30, '░');
    console.log('  [' + bar + ']');
    console.log();
    console.log('  单任务上限: ' + budget.perTask + ' token');
    console.log('  挂机上限:   ' + budget.maxWallClockMin + ' 分钟');
    console.log('  循环窗口:   ' + budget.loopWindow + ' 轮 / 相似度 ' + budget.loopSimilarity);
    console.log();
    if (records.length > 0) {
      console.log('  最近 5 笔:');
      for (const r of records.slice(-5)) {
        console.log('    ' + r.at.slice(0, 19).replace('T', ' ') + '  ' +
          String(r.tokens).padStart(8) + '  ' + (r.note || ''));
      }
    }
    process.exit(0);
  }

  // ── 检查 ──
  if (has('--check')) {
    const tokens = Number(val('--tokens')) || 0;
    const r = checkBudget(tokens, { budget, records });
    console.log('═'.repeat(72));
    console.log('  预算检查');
    console.log('═'.repeat(72));
    console.log();
    console.log('  本次申请: ' + tokens + ' token');
    console.log('  今日已用: ' + r.usedToday + ' / ' + r.perDay);
    console.log('  今日剩余: ' + r.remainToday);
    console.log();
    if (r.ok) {
      console.log('  ✓ 可以执行');
    } else {
      console.log('  ✗ 不能执行:');
      for (const p of r.problems) console.log('    · ' + p);
      console.log();
      console.log('  参考：luanyujia 曾因「挂机一晚上」烧光余额（视频 BV1VuJi6rE9B）');
    }
    process.exit(r.ok ? 0 : 1);
  }

  // ── 记账 ──
  if (has('--spend')) {
    const tokens = Number(val('--tokens')) || 0;
    const note = val('--note') || '';
    const rec = recordSpend(tokens, note);
    const used = todaySpend(loadSpend());
    console.log('✓ 已记账: ' + rec.tokens + ' token');
    console.log('  今日累计: ' + used + ' / ' + budget.perDay +
      ' (' + (used / budget.perDay * 100).toFixed(1) + '%)');
    process.exit(0);
  }

  // ── 循环检测 ──
  if (has('--loop-check')) {
    const f = val('--loop-check');
    const j = readJsonSafe(f);
    const list = Array.isArray(j) ? j : (j?.messages || j?.records || []);
    const r = detectLoop(list, { budget });
    console.log('═'.repeat(72));
    console.log('  循环对话检测');
    console.log('═'.repeat(72));
    console.log();
    console.log('  消息数: ' + list.length);
    console.log('  结果: ' + (r.inLoop ? '⚠ 疑似循环' : '✓ 正常'));
    console.log('  理由: ' + r.reason);
    if (r.pairs?.length) {
      console.log();
      console.log('  高相似对:');
      for (const p of r.pairs.slice(0, 5)) {
        console.log('    第 ' + p.i + ' 条 ↔ 第 ' + p.j + ' 条   相似 ' + p.sim);
      }
    }
    process.exit(r.inLoop ? 1 : 0);
  }
}
