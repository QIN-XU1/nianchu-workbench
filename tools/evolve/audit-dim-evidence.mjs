#!/usr/bin/env node
/**
 * 维度 → 功能实证 映射审计（第 109 轮）。
 *
 * 【要解决的问题】我们对 30 个维度自评「有/部分」，`audit-self-claims` 只验证
 * 「证据里引的路径在本仓库真实存在」——**存在 ≠ 能用**。
 * 第 102 轮就撞到过：A 维度自评「有」，但界面依赖的 git 集成其实一个方法都没有。
 *
 * 【本工具】给每个维度配一组关键词，在全部 verify-*.mjs 里找「有断言覆盖它」的脚本：
 *   · 找到 → 记为「有功能实证」，列出脚本名
 *   · 找不到 → 记为「**无功能实证**」（只有文件存在，或只有人工判断）
 * 这不是判分，是**列出薄弱维度**，让人知道哪些「有」还没被真正跑过。
 *
 * 四态：0 输出报告（审计不判失败）· 2 自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mx = JSON.parse(fs.readFileSync(path.join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));

/** 维度 → 关键词（在 verify 脚本里搜）。刻意用「能力词」而不是维度名。 */
const KEYWORDS = {
  // 【第 109 轮修】关键词必须按**真实断言标题里的用词**写。
  // 首版用英文泛词（model/config/四态）→ 31/31 全中（假绿）；
  // 收紧后只匹配标题 → 4 维判「无实证」（假红，因为标题是中文：沙箱/握手/渲染/品牌）。
  A1: [/补丁|applyPatch|dry_run|行尾|改错/i],
  A2: [/沙箱|sandbox|PATH|HOME|密钥|命令|超时|env/i],
  A3: [/抓取|搜索|web_fetch|web_search|Bing/i],
  A4: [/看图|图片|vision|视觉/i],
  A5: [/压缩|compress|预算|budget/i],
  A6: [/记忆|memory|记忆库/i],
  A7: [/跨会话|记忆|handoff/i],
  A8: [/子代理|subagent|并行/i],
  A9: [/工具调用|tool_call|toolkit|工具集/i],
  A10: [/渠道|channel|IM/i],
  A11: [/调度|scheduler|cron|tick/i],
  A12: [/技能|skill|doctor/i],
  A13: [/握手|MCP|工具列表|serverInfo|server/i],
  A14: [/多模型|供应商|provider|价格|模型/i],
  A15: [/审批|拦截|越界|approval|危险/i],
  A16: [/trace|审计|决策/i],
  B1: [/持久化|persist|runtime-state|恢复/i],
  B2: [/变更集|changeset|原子|回滚|rollback/i],
  B3: [/可移植|投影|宿主|host|portable/i],
  B4: [/交接|handoff|体量|预算/i],
  B5: [/分层|layer|secretbox|单进程/i],
  C1: [/循环|loop|轮次|round/i],
  C2: [/停止|中断|stop|abort|取消/i],
  C3: [/四态|判据|反例|可复算/i],
  C4: [/自愈|恢复|resume|失败/i],
  C5: [/恢复|recover|回滚|注入/i],
  D1: [/渲染|结构|界面结构|布局|三栏|DOM/i],
  D2: [/密度|density|排版/i],
  D3: [/状态|可见|徽章|status/i],
  D4: [/场景|scene|工作区/i],
  D5: [/品牌|主题|theme|css|颜色/i],
};

// 收集所有 verify 脚本，并抽取**断言标题**（t('...') / T('...') 的第一个字符串参数）
// 【为什么只匹配标题】第 109 轮首版按整份源码匹配，`model`/`config`/`四态` 这类泛词几乎命中所有文件，
// 得到「31/31 维都有功能实证」的**假绿**。改成只看断言标题，才是「有没有人真的断言过这件事」。
const ASSERT_RE = /\b(?:t|T|ok|assert)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const scripts = [];
for (const dir of ['tools/agent', 'tools/workbench', 'tools/hostapi', 'tools/quality', 'tools/skills', 'prototype/agent-ui', 'prototype/hermes-agents']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (!/^verify-.*\.mjs$/.test(f)) continue;
    const text = fs.readFileSync(path.join(abs, f), 'utf8');
    const titles = [];
    let m;
    const re = new RegExp(ASSERT_RE.source, 'g');
    while ((m = re.exec(text))) titles.push(m[2]);
    scripts.push({ name: f, dir, text, titles });
  }
}

// ── 自检 ──
{
  if (scripts.length === 0) { console.error('  ✗ 自检失败：一个 verify 脚本都没找到'); process.exit(2); }
  // 一个必然不存在的关键词，必须匹配 0 个脚本（证明搜索是真在搜）
  const probe = scripts.filter((s) => /__no_such_keyword_zzz__/.test(s.text));
  if (probe.length !== 0) { console.error('  ✗ 自检失败：不存在的关键词居然匹配到了'); process.exit(2); }
}

const dims = []; for (const g of mx.dimensions) for (const it of g.items) dims.push(it);
const rows = [];
for (const it of dims) {
  const us = Array.isArray(it.us) ? it.us[0] : '?';
  if (us === '判不了') continue;
  const pats = KEYWORDS[it.id] || [];
  const hits = scripts
    .filter((s) => s.titles.some((title) => pats.some((re) => re.test(title))))
    .map((s) => s.name);
  // 第二信号：脚本文件名暗示该维度（verify-a2-exec → A2；verify-mcp → A13；verify-ui-layer → D1/D5）
  const idLow = it.id.toLowerCase();
  const NAME_HINT = { A13: /mcp/i, D1: /ui-layer|workbench/i, D5: /ui-layer|theme|design/i, A2: /a2-exec|sandbox/i };
  const hintRe = NAME_HINT[it.id];
  const hinted = hintRe ? scripts.filter((s) => hintRe.test(s.name)).map((s) => s.name) : [];
  const strength = hits.length ? '强' : (hinted.length ? '弱' : '无');
  rows.push({ dim: it.id, name: it.name || '', us, hits: [...new Set(hits)], hinted: [...new Set(hinted)], strength });
}

const noEvidence = rows.filter((r) => r.strength === '无');
const weakEvidence = rows.filter((r) => r.strength === '弱');
console.log('');
console.log('  维度 → 功能实证 映射（脚本 ' + scripts.length + ' 个 · 维度 ' + rows.length + ' 个）');
console.log('  ' + '─'.repeat(76));
for (const r of rows) {
  const mark = r.strength === '强' ? '✓' : (r.strength === '弱' ? '~' : '✗');
  console.log('  ' + mark + ' ' + r.dim.padEnd(4) + String(r.us).padEnd(4) + String(r.name).slice(0, 14).padEnd(16) +
    (r.hits.length ? r.hits.slice(0, 3).join(', ') : (r.hinted.length ? '弱：仅脚本名相关 ' + r.hinted.slice(0, 2).join(', ') : '**无功能实证**')));
}
console.log('  ' + '─'.repeat(76));
console.log('  强实证 ' + rows.filter((r) => r.strength === '强').length + ' · 弱实证 ' + weakEvidence.length + ' · 无实证 ' + noEvidence.length + ' / 共 ' + rows.length + ' 维');
if (noEvidence.length) {
  console.log('  无功能实证（' + noEvidence.length + ' 维，只有文件存在或人工判断）：');
  for (const r of noEvidence) console.log('    · ' + r.dim + ' ' + r.name + '（自评 ' + r.us + '）');
}
console.log('  说明：这是**启发式提示，不是判定**。实测它连错三次：泛词全中(31/31 假绿)→只匹配标题(4 维假红)→漏扫目录(B5 假红)。');
console.log('        「无实证」只表示「断言标题里没搜到该词」，不代表没验证过；「强实证」也只表示有断言提到，不代表覆盖充分。');

fs.mkdirSync(path.join(ROOT, 'evidence/evolve'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evidence/evolve/dim-evidence-map.json'),
  JSON.stringify({ at: new Date().toISOString(), scripts: scripts.length, rows, noEvidence: noEvidence.map((r) => r.dim) }, null, 2) + '\n', 'utf8');
console.log('  已写 evidence/evolve/dim-evidence-map.json');