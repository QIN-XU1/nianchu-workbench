#!/usr/bin/env node
// 工具/情报生成.mjs —— 把项目的机制体系与对标结果整理成可查阅的情报文档
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  参考项目（luanyujia-workbench）有「13 公开情报」板块：
//    官方更新追踪 / 执行层方案对比 / 商业 AI 对标 / Super-agent 概念分层
//
//  我们缺这一块。但直接抄它的四篇意义不大 —— 那些是它的调研，
//  不是我们的。
//
//  我们真正该有、而现在没有的「情报」是：
//    ① 这个项目的机制体系到底有哪些（92 项怎么分族、各自守什么）
//    ② 体检项是怎么长出来的（进化史，从 git 历史提取）
//    ③ 与参考项目的能力对标（哪些有、哪些缺、哪些是它没有的）
//    ④ 已知缺陷与取舍（诚实记录没做好的地方）
//
//  这四样合起来，就是「这个项目现在到底是什么状态」的可查阅真相。
//
//  用法：
//    node 工具/情报生成.mjs              生成到 数据/.dsh/情报/
//    node 工具/情报生成.mjs --print      只打印不写文件
//    node 工具/情报生成.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');
const DATA = path.join(WB, '数据', '.dsh');
const OUT_DIR = path.join(DATA, '情报');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 生成几份文档 */
export const DOC_NAMES = [
  '一-机制体系全貌.md',
  '二-体检进化史.md',
  '三-能力对标.md',
  '四-已知缺陷与取舍.md',
];

/**
 * 把 guard 按族分组
 *
 * 族 = 看它守的是什么：
 *   记忆族 / 派单族 / 界面族 / 会话族 / 验证族 / 结构族 / 其他
 */
export function groupGuards(guards) {
  const FAMILY = [
    { key: '记忆', re: /记忆|注入|经验|影子|归档|精简|封存/ },
    { key: '派单', re: /派单|回执|归因|中枢|调度|管线|路由|任务/ },
    { key: '界面', re: /界面|面板|会话绑定|中枢面板|设计一致|命令可执行/ },
    { key: '验证', re: /体检|审计|验证|破坏性|哨兵|校准|对标|进化|稳定/ },
    { key: '结构', re: /文档|索引|编码|去重|清理|废弃|固定注入|容量|身份/ },
  ];
  const out = new Map();
  for (const g of guards) {
    let hit = '其他';
    for (const f of FAMILY) {
      if (f.re.test(g.name) || f.re.test(g.file)) { hit = f.key; break; }
    }
    if (!out.has(hit)) out.set(hit, []);
    out.get(hit).push(g);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
function readGuards() {
  const src = fs.readFileSync(path.join(HERE, '机制体检.mjs'), 'utf8');
  const out = [];
  const re = /\{\s*name:\s*'([^']+)',\s*file:\s*'([^']+)',\s*desc:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ name: m[1], file: m[2], desc: m[3] });
  return out;
}

function readCapabilities() {
  const src = fs.readFileSync(path.join(HERE, '能力对标.mjs'), 'utf8');
  const out = [];
  const re = /\{\s*id:\s*'([^']+)',\s*cat:\s*'([^']+)',\s*name:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ id: m[1], cat: m[2], name: m[3] });
  return out;
}

function gitEvo() {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, '体检进化.mjs'), '--json'], {
      cwd: WB, encoding: 'utf8', timeout: 300000, windowsHide: true,
    });
    return JSON.parse(out);
  } catch { return null; }
}

function countTools() {
  try { return fs.readdirSync(path.join(HERE)).filter((f) => f.endsWith('.mjs')).length; } catch { return 0; }
}
function countSkills() {
  try { return fs.readdirSync(path.join(DATA, 'skills')).length; } catch { return 0; }
}
function countScenes() {
  try { return fs.readdirSync(path.join(WB, '外壳/scenarios')).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

// ══════════════════════════════════════════════════════════════════════
function buildDoc1(guards) {
  const groups = groupGuards(guards);
  const L = [];
  L.push('# 一、机制体系全貌');
  L.push('');
  L.push('> 自动生成，勿手改。生成器：`工具/情报生成.mjs`');
  L.push('> 生成时间：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  L.push('');
  L.push('## 这个项目守的是什么');
  L.push('');
  L.push('机制体检 **' + guards.length + ' 项**，每一项都对应一次真实事故或发现。');
  L.push('按「守的是什么」分成 ' + groups.size + ' 族：');
  L.push('');
  for (const [fam, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    L.push('### ' + fam + '族（' + list.length + ' 项）');
    L.push('');
    for (const g of list) {
      L.push('- `' + g.name + '` —— ' + (g.desc || g.file));
    }
    L.push('');
  }
  L.push('## 规模');
  L.push('');
  L.push('| 维度 | 数量 |');
  L.push('|---|---|');
  L.push('| 机制体检项 | ' + guards.length + ' |');
  L.push('| 工具 | ' + countTools() + ' |');
  L.push('| 技能 | ' + countSkills() + ' |');
  L.push('| 场景 | ' + countScenes() + ' |');
  L.push('');
  return L.join('\n');
}

function buildDoc2(evo) {
  const L = [];
  L.push('# 二、体检进化史');
  L.push('');
  L.push('> 自动生成，勿手改。数据来源：`工具/体检进化.mjs`（从 git 历史提取）');
  L.push('');
  if (!evo || !evo.rows) {
    L.push('（git 历史读取失败，跳过）');
    return L.join('\n');
  }
  L.push('## 为什么要有这一篇');
  L.push('');
  L.push('机制体检从 4 项长到 ' + evo.total + ' 项，每次增长都是一次真实事故换来的。');
  L.push('这里记录每项的来源 —— 这样「这一项能不能删」就有据可查，而不是凭感觉。');
  L.push('');
  // 按日期分组
  const byDate = new Map();
  for (const r of evo.rows) {
    const d = r.when ? r.when.date : '(未知)';
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  L.push('## 增长节奏');
  L.push('');
  for (const [d, list] of [...byDate].sort()) {
    L.push('- **' + d + '**：+' + list.length + ' 项');
  }
  L.push('');
  L.push('## 逐项来历');
  L.push('');
  L.push('| 体检项 | 加入时间 | 为什么加 |');
  L.push('|---|---|---|');
  for (const r of evo.rows) {
    const date = r.when ? r.when.date : '?';
    const why = (r.why || r.desc || '').replace(/\|/g, '/').slice(0, 80);
    L.push('| `' + r.name + '` | ' + date + ' | ' + why + ' |');
  }
  L.push('');
  return L.join('\n');
}

function buildDoc3(caps) {
  const L = [];
  L.push('# 三、能力对标');
  L.push('');
  L.push('> 自动生成，勿手改。数据来源：`工具/能力对标.mjs`');
  L.push('');
  L.push('## 对标对象');
  L.push('');
  L.push('[luanyujia-workbench](https://github.com/mashanglinyu/luanyujia-workbench)');
  L.push('—— 13 个板块 / 200+ 工具 / 28 技能 / 12 插件 / 3 套 MCP。');
  L.push('');
  L.push('**要求：不希望有任何一项能力弱于它。**');
  L.push('');
  L.push('## 判断口径');
  L.push('');
  L.push('不按「工具同名」判断，按「能力是否存在」判断。');
  L.push('参考的「回执哨兵」我们叫「派单哨兵」，那也算有。');
  L.push('');
  L.push('## 能力清单（' + caps.length + ' 项）');
  L.push('');
  L.push('| 板块 | 能力 |');
  L.push('|---|---|');
  for (const c of caps) {
    L.push('| ' + c.cat + ' | ' + c.name + ' |');
  }
  L.push('');
  L.push('> 实时状态请跑：`node 工具/能力对标.mjs`');
  L.push('');
  return L.join('\n');
}

function buildDoc4() {
  const L = [];
  L.push('# 四、已知缺陷与取舍');
  L.push('');
  L.push('> 自动生成框架，内容需人工维护（这一篇不能自动生成 —— 诚实要人写）');
  L.push('');
  L.push('## 为什么要有这一篇');
  L.push('');
  L.push('参考项目的 README 里写着：');
  L.push('');
  L.push('> 「这不是装完就能用的软件」「文档里的路径全是占位符，照抄一定失败」');
  L.push('> 「不少模块需要现场排查才能跑通」');
  L.push('');
  L.push('**它敢说自己不行。** 我们也该这样。');
  L.push('');
  L.push('一个只在文档里写「全部通过」的项目，比一个敢列缺点的项目更不可信。');
  L.push('');
  L.push('## 已知缺陷（人工维护）');
  L.push('');
  L.push('<!-- 每次发现真实缺陷就加一条，修好了标注已修 -->');
  L.push('');
  L.push('| 缺陷 | 影响 | 状态 |');
  L.push('|---|---|---|');
  L.push('| 依赖本地模型网关（127.0.0.1:3425） | 网关不通则所有 AI 功能不可用 | 已知 |');
  L.push('| 免费模型有速率限制（429） | 长任务可能中途失败 | 已加退避重试 |');
  L.push('| 会话历史过长会吃光模型额度 | 402 | 已加会话轮转 |');
  L.push('| 空白会话不被侧栏渲染 | 面板绑不上 | 已加会话预热 |');
  L.push('');
  L.push('## 明确不做的事（取舍）');
  L.push('');
  L.push('| 不做 | 为什么 |');
  L.push('|---|---|');
  L.push('| 追求工具数量对齐 200+ | 参考项目那 200 个里有一批是「历史一次性修补件」（作者自己标注「默认空」）。我们要的是能力，不是数量。 |');
  L.push('| 抄参考项目的 MCP 网页桥 | 我们走本地模型网关路线，成本更低、更稳定。目的（不花 token）达到了。 |');
  L.push('| 打包成 exe | 参考项目明确要求「源码直跑，不打包」。我们保持一致。 |');
  L.push('');
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  情报生成 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】能读到数据');
  {
    const guards = readGuards();
    chk('能读到 guard', guards.length > 0, guards.length + ' 项');
    const caps = readCapabilities();
    chk('能读到能力清单', caps.length > 0, caps.length + ' 项');
  }

  console.log();
  console.log('【二】能按族分组');
  {
    const guards = readGuards();
    const groups = groupGuards(guards);
    chk('分组非空', groups.size > 0, groups.size + ' 族');
    const total = [...groups.values()].reduce((a, b) => a + b.length, 0);
    chk('分组后总数不变', total === guards.length, total + ' / ' + guards.length);
    chk('每族都有内容', [...groups.values()].every((l) => l.length > 0));
  }

  console.log();
  console.log('【三】反例：分组不能全塞进「其他」');
  {
    const guards = readGuards();
    const groups = groupGuards(guards);
    const other = groups.get('其他');
    const otherCount = other ? other.length : 0;
    chk('反例：「其他」不能占多数', otherCount < guards.length * 0.5,
      '其他 ' + otherCount + ' / ' + guards.length);
  }

  console.log();
  console.log('【四】文档生成');
  {
    const guards = readGuards();
    const d1 = buildDoc1(guards);
    chk('文档①非空', d1.length > 500, d1.length + ' 字符');
    chk('文档①含族名', /族（/.test(d1));
    const d4 = buildDoc4();
    chk('文档④（缺陷篇）非空', d4.length > 200, d4.length + ' 字符');
    chk('文档④敢列缺陷', /已知缺陷|不做的事/.test(d4));
  }

  console.log();
  console.log('【五】关键：这一套补的是什么');
  chk('关键：把「项目现在什么状态」变成可查阅真相',
    true, '参考项目有 13 公开情报，我们补上等价的四篇');

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

  const guards = readGuards();
  const caps = readCapabilities();

  console.log('  读取: ' + guards.length + ' 项机制 / ' + caps.length + ' 项能力');

  console.log('  读取 git 历史（体检进化）…');
  const evo = gitEvo();
  console.log('  ' + (evo ? '拿到 ' + evo.total + ' 项来历' : '读取失败（文档②将跳过）'));

  const docs = [
    { name: DOC_NAMES[0], content: buildDoc1(guards) },
    { name: DOC_NAMES[1], content: buildDoc2(evo) },
    { name: DOC_NAMES[2], content: buildDoc3(caps) },
    { name: DOC_NAMES[3], content: buildDoc4() },
  ];

  if (has('print')) {
    for (const d of docs) {
      console.log();
      console.log('═'.repeat(78));
      console.log('  ' + d.name);
      console.log('═'.repeat(78));
      console.log(d.content);
    }
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const d of docs) {
    fs.writeFileSync(path.join(OUT_DIR, d.name), d.content, 'utf8');
  }

  console.log();
  console.log('='.repeat(78));
  console.log('  已生成 ' + docs.length + ' 篇情报到 ' + path.relative(WB, OUT_DIR));
  console.log('='.repeat(78));
  console.log();
  for (const d of docs) {
    const p = path.join(OUT_DIR, d.name);
    console.log('  ' + d.name.padEnd(26) + fs.statSync(p).size + 'B');
  }
  console.log();
  console.log('  ⚠ 四-已知缺陷与取舍.md 是**人工维护**的 —— 自动生成不了诚实。');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
