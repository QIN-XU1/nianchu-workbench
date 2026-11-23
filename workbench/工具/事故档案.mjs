#!/usr/bin/env node
/**
 * 事故档案 —— 真实踩过的坑，和它们留下的机械抓手
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 04-工作台搭建/事故复盘-三起.md）
 * ══════════════════════════════════════════════════════════════
 *
 *  > 「这套工作台里有几条规矩看起来『过分小心』，比如：
 *  >    ⛔ 永不打包 · ⛔ 不许动启动器里的 exe · ⛔ 改文本不许用 PowerShell 往返读写。
 *  >    **它们不是洁癖，是三起真事故留下的。**」
 *
 *  【格式】（他定的，五段 + 一条铁律）
 *    **现象**：（用户看到什么）
 *    **我当时以为**：（错误判断 —— 这段最有价值）
 *    **真实原因**：（机制层面）
 *    **怎么救的**：（具体动作，包括「没救回来」）
 *    **现在的抓手**：（哪个检查/哪条纪律，能让它不再发生）
 *
 *  【四条要求】
 *    1. **写「我当时以为」** —— 不写这段，复盘就变成炫耀
 *    2. **写「没救回来」的部分** —— 真实感来自这里
 *    3. **一定要落到「抓手」** —— 没有抓手的复盘 = 故事
 *    4. **只追加，不改写** —— 事故档案是证据，不是宣传稿
 *
 *  【三起事故的共同点】（他认为最值得抄的部分）
 *    | 共同点 | 含义 | 对应做法 |
 *    | 都不报错 | 灰白、乱码、静默丢失，没有任何错误提示 | 体检必须有「应当失败的反例」 |
 *    | 都是「看起来很小」的操作 | 改个版本号 / 跑个替换 / 写一次文件 | 危险操作按后果分级，不按代码量 |
 *    | 救回来的都不是靠「小心」 | 靠日志、靠重启、靠事先的联接设计 | 关键路径要留可回溯的东西 |
 *    | 事后都变成了机械抓手 | 不能停留在「下次注意」 | 一条规矩 ⇒ 一个会失败的检查 |
 *
 * ══════════════════════════════════════════════════════════════
 *  这个工具干什么
 * ══════════════════════════════════════════════════════════════
 *
 *  1. 存档案（JSON 主数据 + 渲染 Markdown）
 *  2. **校验**：每条事故必须有「我当时以为」和「抓手」——缺了就报错
 *  3. **统计**：有多少事故还没落到抓手（= 还是故事）
 *  4. 只追加：已有条目不许改写（SHA 校验）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/事故档案.mjs                          看档案
 *  node 工具/事故档案.mjs --verify                 校验（缺抓手就红）
 *  node 工具/事故档案.mjs --stats                  统计
 *  node 工具/事故档案.mjs --add --file <新事故.json> 追加一条
 *  node 工具/事故档案.mjs --build --apply          重新渲染 Markdown
 *  node 工具/事故档案.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DIR = path.join(WB, '数据', '.dsh', '事故档案');
const DATA = path.join(DIR, '事故档案.json');
const RENDER = path.join(DIR, '事故档案.md');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  格式定义（五段 + 可信度）
// ══════════════════════════════════════════════════════════════
export const FIELDS = [
  { key: 'phenomenon', name: '现象', required: true, hint: '用户看到什么（可观察的，不要形容词）' },
  { key: 'assumed', name: '我当时以为', required: true, hint: '错误判断 —— 这段最有价值' },
  { key: 'cause', name: '真实原因', required: true, hint: '机制层面，不是表面现象' },
  { key: 'fix', name: '怎么救的', required: true, hint: '具体动作，包括「没救回来」' },
  { key: 'guard', name: '现在的抓手', required: true, hint: '哪个检查/哪条纪律能让它不再发生' },
];

/** 严重程度 */
export const SEVERITY = {
  fatal: { name: '致命', desc: '数据丢失 / 系统起不来' },
  major: { name: '严重', desc: '功能不可用 / 错误结论' },
  minor: { name: '轻微', desc: '体验问题 / 返工' },
};

/** 可信度（是不是真的确认了根因） */
export const CONFIDENCE = {
  confirmed: { name: '已确认', desc: '复现过 / 日志证实' },
  inferred: { name: '推测', desc: '现象消失了但没证实原因' },
  unknown: { name: '未知', desc: '到现在也不知道为什么' },
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

export function loadArchive() {
  const j = readJsonSafe(DATA);
  if (!j || !Array.isArray(j.items)) return { items: [], note: '' };
  return j;
}

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function saveArchive(a) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(a, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  校验一条事故
// ══════════════════════════════════════════════════════════════
export function validateItem(item) {
  const problems = [];
  const i = item || {};

  if (!i.title || String(i.title).trim().length < 4) {
    problems.push('缺标题（至少 4 字）');
  }

  for (const f of FIELDS) {
    if (!f.required) continue;
    const v = i[f.key];
    if (!v || String(v).trim().length < 10) {
      problems.push('缺「' + f.name + '」或太短（至少 10 字）—— ' + f.hint);
    }
  }

  // 「我当时以为」必须包含错误的自我认知
  if (i.assumed && !/(以为|觉得|以为是|当时想|判断成|看成)/.test(String(i.assumed))) {
    problems.push('「我当时以为」要写清误判了什么（缺「以为/觉得/判断成」这类词）');
  }

  // 「抓手」必须指向具体的东西
  if (i.guard && !/(\.mjs|\.md|哨兵|体检|闸|检查|规则|纪律|工具)/.test(String(i.guard))) {
    problems.push('「抓手」必须是具体的东西（工具名/检查项/纪律），不能只说「下次注意」');
  }

  return { ok: problems.length === 0, problems };
}

// ══════════════════════════════════════════════════════════════
//  追加（只追加，不改写）
// ══════════════════════════════════════════════════════════════
export function addItem(item, opts) {
  const o = opts || {};
  const v = validateItem(item);
  if (!v.ok) return { ok: false, error: '不合格式', problems: v.problems };

  const a = loadArchive();
  const id = 'AC-' + String((a.items.length + 1)).padStart(3, '0');

  // 只追加：同 id / 同 title 已存在就拒绝
  if (a.items.some((x) => x.title === item.title)) {
    return { ok: false, error: '已存在同名事故: ' + item.title };
  }

  const rec = {
    id,
    title: String(item.title).trim(),
    severity: SEVERITY[item.severity] ? item.severity : 'major',
    confidence: CONFIDENCE[item.confidence] ? item.confidence : 'confirmed',
    at: item.at || new Date().toISOString().slice(0, 10),
    phenomenon: item.phenomenon,
    assumed: item.assumed,
    cause: item.cause,
    fix: item.fix,
    guard: item.guard,
    // 额外字段（可选）
    notSaved: item.notSaved || null,       // 没救回来的是什么
    lesson: item.lesson || null,
    _sha: sha(JSON.stringify([item.title, item.phenomenon, item.assumed, item.cause, item.fix, item.guard])),
  };

  a.items.push(rec);
  saveArchive(a);

  return { ok: true, item: rec, total: a.items.length };
}

// ══════════════════════════════════════════════════════════════
//  只追加校验：检测已有条目是否被改
// ══════════════════════════════════════════════════════════════
export function verifyArchive(opts) {
  const o = opts || {};
  const a = o.archive || loadArchive();
  const problems = [];
  let okCount = 0;

  for (const it of a.items) {
    const v = validateItem(it);
    if (!v.ok) {
      for (const p of v.problems) problems.push(it.id + ': ' + p);
    }

    // SHA 校验（只追加）
    if (it._sha) {
      const expect = sha(JSON.stringify([it.title, it.phenomenon, it.assumed, it.cause, it.fix, it.guard]));
      if (expect !== it._sha) {
        problems.push(it.id + ': 内容被改过（SHA 不符）—— 事故档案只追加，不改写');
        continue;
      }
    }
    if (v.ok) okCount++;
  }

  // 抓手重复检查（两条事故用同一个抓手 ⇒ 可能有条是故事）
  const guardMap = {};
  for (const it of a.items) {
    const g = String(it.guard || '').trim();
    if (g) guardMap[g] = (guardMap[g] || 0) + 1;
  }
  const dupeGuards = Object.entries(guardMap).filter(([, n]) => n > 1);

  return {
    ok: problems.length === 0,
    total: a.items.length,
    okCount,
    problems,
    dupeGuards,
    reason: problems.length === 0
      ? '档案完整：' + okCount + ' 条全部合格式且未被改写'
      : problems.length + ' 个问题',
  };
}

// ══════════════════════════════════════════════════════════════
//  统计
// ══════════════════════════════════════════════════════════════
export function stats(opts) {
  const o = opts || {};
  const a = o.archive || loadArchive();

  const bySeverity = {};
  for (const k of Object.keys(SEVERITY)) bySeverity[k] = 0;
  const byConfidence = {};
  for (const k of Object.keys(CONFIDENCE)) byConfidence[k] = 0;

  let withGuard = 0;
  let withNotSaved = 0;
  let withLesson = 0;

  for (const it of a.items) {
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    byConfidence[it.confidence] = (byConfidence[it.confidence] || 0) + 1;
    if (it.guard && String(it.guard).trim()) withGuard++;
    if (it.notSaved) withNotSaved++;
    if (it.lesson) withLesson++;
  }

  return {
    total: a.items.length,
    bySeverity,
    byConfidence,
    withGuard,
    withNotSaved,
    withLesson,
    guardRate: a.items.length > 0 ? Math.round(withGuard / a.items.length * 100) : 0,
  };
}

// ══════════════════════════════════════════════════════════════
//  渲染 Markdown
// ══════════════════════════════════════════════════════════════
export function renderArchive(a) {
  const L = [];
  L.push('# 事故档案');
  L.push('');
  L.push('> **只追加，不改写** —— 事故档案是证据，不是宣传稿。');
  L.push('>');
  L.push('> 依据：参考项目 `04-工作台搭建/事故复盘-三起.md`');
  L.push('> 「比起『我搭了个工作台』，『我搞坏过、这样救回来』通常更有用。」');
  L.push('');
  L.push('## 为什么要有这个');
  L.push('');
  L.push('参考项目里几条看起来「过分小心」的规矩：');
  L.push('');
  L.push('> ⛔ 永不打包 · ⛔ 不许动启动器里的 exe · ⛔ 改文本不许用 PowerShell 往返读写');
  L.push('');
  L.push('**它们不是洁癖，是真事故留下的。**');
  L.push('');
  L.push('## 三起事故的共同点（最值得抄的部分）');
  L.push('');
  L.push('| 共同点 | 含义 | 对应做法 |');
  L.push('|---|---|---|');
  L.push('| **都不报错** | 灰白、乱码、静默丢失 —— 没有任何一条错误提示 | 体检必须有「应当失败的反例」 |');
  L.push('| **都是「看起来很小」的操作** | 改个版本号 / 跑个替换 / 写一次文件 | 危险操作按**后果**分级，不按代码量 |');
  L.push('| **救回来的都不是靠「小心」** | 靠日志、靠重启、靠事先的联接设计 | 关键路径要留**可回溯的东西** |');
  L.push('| **事后都变成了机械抓手** | 不能停留在「下次注意」 | 一条规矩 ⇒ 一个**会失败的检查** |');
  L.push('');
  L.push('## 四条要求');
  L.push('');
  L.push('1. 写「我当时以为」—— 不写这段，复盘就变成炫耀');
  L.push('2. 写「没救回来」的部分 —— **真实感来自这里**');
  L.push('3. 一定要落到「抓手」—— 没有抓手的复盘 = 故事');
  L.push('4. 只追加，不改写 —— 事故档案是证据，不是宣传稿');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 档案（' + a.items.length + ' 条）');
  L.push('');

  for (const it of a.items) {
    const sev = SEVERITY[it.severity] || SEVERITY.major;
    const conf = CONFIDENCE[it.confidence] || CONFIDENCE.confirmed;

    L.push('### ' + it.id + '：' + it.title);
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push('| 严重程度 | **' + sev.name + '** — ' + sev.desc + ' |');
    L.push('| 可信度 | ' + conf.name + ' — ' + conf.desc + ' |');
    L.push('| 日期 | ' + it.at + ' |');
    L.push('');
    L.push('**现象**');
    L.push('');
    L.push(String(it.phenomenon).split('\n').map((l) => '> ' + l).join('\n'));
    L.push('');
    L.push('**我当时以为**');
    L.push('');
    L.push(String(it.assumed).split('\n').map((l) => '> ' + l).join('\n'));
    L.push('');
    L.push('**真实原因**');
    L.push('');
    L.push(String(it.cause).split('\n').map((l) => '> ' + l).join('\n'));
    L.push('');
    L.push('**怎么救的**');
    L.push('');
    L.push(String(it.fix).split('\n').map((l) => '> ' + l).join('\n'));
    L.push('');

    if (it.notSaved) {
      L.push('**🔴 没救回来的**');
      L.push('');
      L.push(String(it.notSaved).split('\n').map((l) => '> ' + l).join('\n'));
      L.push('');
    }

    L.push('**现在的抓手**');
    L.push('');
    L.push('> ' + it.guard);
    L.push('');

    if (it.lesson) {
      L.push('**教训**');
      L.push('');
      L.push('> ' + it.lesson);
      L.push('');
    }

    L.push('---');
    L.push('');
  }

  if (a.items.length === 0) {
    L.push('还没有事故记录。');
    L.push('');
  }

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  事故档案 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 格式定义
  chk('五段格式', FIELDS.length === 5, FIELDS.map((f) => f.name).join(' → '));
  chk('「我当时以为」是必需的', FIELDS.find((f) => f.key === 'assumed').required === true, '');
  chk('「现在的抓手」是必需的', FIELDS.find((f) => f.key === 'guard').required === true, '');
  chk('三级严重程度', Object.keys(SEVERITY).length === 3, Object.keys(SEVERITY).join(','));
  chk('三档可信度', Object.keys(CONFIDENCE).length === 3, Object.keys(CONFIDENCE).join(','));

  // ② 合规条目通过
  const good = {
    title: '测试事故：某处静默失败',
    severity: 'major',
    confidence: 'confirmed',
    phenomenon: '某个检查一直显示通过，但实际上从来没生效过',
    assumed: '我当时以为只要代码写了 if 判断就会生效',
    cause: '判断只记录了统计字段，没有生成 diff，所以永远不会报错',
    fix: '把 stats 记录改成 diffs.push，重新跑自测确认会报',
    guard: '工具/机制审计.mjs 会检查每项是否有「反例」',
  };
  const v1 = validateItem(good);
  chk('合规条目通过', v1.ok === true, v1.problems.join(';') || 'ok');

  // ③ 反例：缺「我当时以为」
  const noAssumed = { ...good };
  delete noAssumed.assumed;
  const v2 = validateItem(noAssumed);
  chk('反例：缺「我当时以为」被拒', v2.ok === false,
      v2.problems.find((p) => p.includes('我当时以为')) || '');

  // ④ 反例：缺「抓手」
  const noGuard = { ...good };
  delete noGuard.guard;
  const v3 = validateItem(noGuard);
  chk('反例：缺「抓手」被拒', v3.ok === false,
      v3.problems.find((p) => p.includes('抓手')) || '');

  // ⑤ 反例：「我当时以为」写成陈述句（不是误判）
  const badAssumed = { ...good, assumed: '这个功能需要修复因为代码有问题' };
  const v4 = validateItem(badAssumed);
  chk('反例：误判写成陈述句被拒', v4.ok === false,
      v4.problems.find((p) => p.includes('误判')) || '');

  // ⑥ 反例：抓手是「下次注意」
  const badGuard = { ...good, guard: '下次注意一点就好了' };
  const v5 = validateItem(badGuard);
  chk('反例：抓手是「下次注意」被拒', v5.ok === false,
      v5.problems.find((p) => p.includes('具体')) || '');

  // ⑦ 反例：标题太短
  const badTitle = { ...good, title: '坏了' };
  const v6 = validateItem(badTitle);
  chk('反例：标题太短被拒', v6.ok === false, v6.problems[0] || '');

  // ⑧ 真实档案校验
  const a = loadArchive();
  chk('能加载真实档案', Array.isArray(a.items), a.items.length + ' 条');

  const ver = verifyArchive({ archive: { items: [] } });
  chk('空档案也算通过', ver.ok === true, ver.reason);

  const s = stats({ archive: { items: [good] } });
  chk('统计能跑', s.total === 1 && s.bySeverity.major === 1, JSON.stringify(s.bySeverity));

  // ⑨ 渲染
  const md = renderArchive({ items: [{ ...good, id: 'AC-001', at: '2026-11-11', _sha: 'x' }] });
  chk('能渲染', md.length > 500, md.length + ' 字符');
  chk('渲染含「我当时以为」', md.includes('我当时以为'), '');
  chk('渲染含「没救回来」说明', md.includes('没救回来') || md.includes('真实感来自这里'), '');
  chk('渲染含只追加声明', md.includes('只追加，不改写'), '');

  // ⑩ SHA 校验：改了要报
  const tampered = { items: [{ ...good, id: 'AC-001', _sha: 'wronghash' }] };
  const v7 = verifyArchive({ archive: tampered });
  chk('改过内容会被检出', v7.problems.some((p) => p.includes('SHA')), '');

  // ⑪ 关键：没抓手的档案 = 故事
  chk('关键：没抓手的复盘 = 故事',
      v3.ok === false && FIELDS.find((f) => f.key === 'guard').required,
      '这是「把规矩变成机制」在事故档案上的应用');

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

  // ── 校验 ──
  if (has('--verify')) {
    const r = verifyArchive();
    console.log('═'.repeat(74));
    console.log('  事故档案校验（格式 + 只追加）');
    console.log('═'.repeat(74));
    console.log();
    console.log('  总数: ' + r.total);
    console.log('  完好: ' + r.okCount);
    console.log();
    if (r.ok) {
      console.log('  ✓ ' + r.reason);
    } else {
      console.log('  ✗ ' + r.reason);
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    if (r.dupeGuards.length > 0) {
      console.log();
      console.log('  ⚠ 多条事故用同一个抓手（可能有一条是故事）:');
      for (const [g, n] of r.dupeGuards) {
        console.log('    · ' + n + ' 条都用「' + String(g).slice(0, 40) + '」');
      }
    }
    console.log();
    console.log('─'.repeat(74));
    process.exit(r.ok ? 0 : 1);
  }

  // ── 统计 ──
  if (has('--stats')) {
    const s = stats();
    console.log('═'.repeat(74));
    console.log('  事故档案统计');
    console.log('═'.repeat(74));
    console.log();
    console.log('  总数: ' + s.total);
    console.log();
    console.log('  严重程度:');
    for (const [k, v] of Object.entries(s.bySeverity)) {
      if (v > 0) console.log('    ' + SEVERITY[k].name + '：' + v);
    }
    console.log();
    console.log('  可信度:');
    for (const [k, v] of Object.entries(s.byConfidence)) {
      if (v > 0) console.log('    ' + CONFIDENCE[k].name + '：' + v);
    }
    console.log();
    console.log('  有抓手: ' + s.withGuard + ' / ' + s.total + '（' + s.guardRate + '%）');
    console.log('  写了「没救回来」: ' + s.withNotSaved + ' / ' + s.total);
    console.log('  写了教训: ' + s.withLesson + ' / ' + s.total);
    console.log();
    console.log('─'.repeat(74));
    process.exit(s.guardRate === 100 ? 0 : 1);
  }

  // ── 追加 ──
  if (has('--add')) {
    const f = val('--file');
    if (!f) { console.error('需要 --file <事故.json>'); process.exit(2); }
    const item = readJsonSafe(f);
    if (!item) { console.error('读不到或不是合法 JSON: ' + f); process.exit(2); }
    const r = addItem(item);
    if (!r.ok) {
      console.error('✗ ' + r.error);
      if (r.problems) for (const p of r.problems) console.error('  · ' + p);
      process.exit(2);
    }
    console.log('✓ 已追加 ' + r.item.id + '：' + r.item.title);
    console.log('  当前共 ' + r.total + ' 条');
    console.log('  重新渲染: node 工具/事故档案.mjs --build --apply');
    process.exit(0);
  }

  // ── 渲染 ──
  if (has('--build')) {
    const a = loadArchive();
    const md = renderArchive(a);
    if (has('--apply')) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(RENDER, md, 'utf8');
      console.log('✓ 已写入 ' + path.relative(WB, RENDER).replace(/\\/g, '/') + '（' + a.items.length + ' 条）');
    } else {
      console.log(md);
    }
    process.exit(0);
  }

  // 默认：看档案
  const a = loadArchive();
  if (a.items.length === 0) {
    console.log('═'.repeat(74));
    console.log('  事故档案');
    console.log('═'.repeat(74));
    console.log();
    console.log('  还没有记录。');
    console.log();
    console.log('  为什么要有这个：');
    console.log('  「比起『我搭了个工作台』，『我搞坏过、这样救回来』通常更有用。」');
    console.log();
    console.log('  格式（五段，缺一段就不合格）：');
    for (const f of FIELDS) {
      console.log('    · ' + f.name + ' —— ' + f.hint);
    }
    console.log();
    console.log('  四条要求：');
    console.log('    1. 写「我当时以为」—— 不写这段，复盘就变成炫耀');
    console.log('    2. 写「没救回来」的部分 —— 真实感来自这里');
    console.log('    3. 一定要落到「抓手」—— 没有抓手的复盘 = 故事');
    console.log('    4. 只追加，不改写 —— 事故档案是证据，不是宣传稿');
    console.log();
    console.log('─'.repeat(74));
    process.exit(0);
  }

  // 有档案就输出渲染内容
  console.log(renderArchive(a));
}
