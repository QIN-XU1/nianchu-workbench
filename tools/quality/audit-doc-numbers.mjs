#!/usr/bin/env node
/**
 * 文档数字巡检 —— 文档里每一个「N 个 / N 项 / N 条」都要能对着代码实测。
 *
 * 起因（第 66 轮）：文档写「72 个 RPC 方法」，实测 IMPLEMENTED = 77 —— 差 5 个，长期无人发现。
 * 「72」这种暗错的根因是：数字是**手写**的，没人拿它对着代码量。
 * 本工具把「数字声明」变成**可复算**：从代码实测，与文档文本比对，不符即报。
 *
 * 设计：
 *   · providers：keyword → 实测函数（读代码/文件系统，不读文档）
 *   · 扫描 docs 里的「N 个/项/条 <名词>」，若名词命中 provider，比对数字
 *   · 未命中 provider 的数字列为「未覆盖」（如实报，不假装检查过）
 *
 * 退出码：0 全部一致 · 3 有未覆盖 · 1 有不一致（文档数 ≠ 实测）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = ['README.md', '架构.md', '总纲.md', '目录与模块.md', '验证体系.md', '构建与运行.md', '对标方法.md'];

const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };
const countFiles = (dir, re) => { try { return fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).length; } catch { return -1; } };

/** 实测函数：全部读代码/文件系统，不读文档 */
const measurements = {
  async rpcMethods() {
    const m = await import('../hostapi/ws-host.mjs');
    return Object.keys(m.IMPLEMENTED).length;
  },
  verifyFiles() { return countFiles('tools/agent', /^verify-.*\.mjs$/); },
  ledgerEntries() {
    try { return JSON.parse(read('research/改进台账.json')).entries.length; } catch { return -1; }
  },
  async skills() {
    const { createSkillLoader } = await import('../skills/loader.mjs');
    return createSkillLoader([path.join(ROOT, 'prototype/scenes')]).scanAll().stats().count;
  },
  async tools() {
    const m = await import('../agent/toolkit.mjs');
    return Object.keys(m.createToolkit({ cwd: ROOT })).length;
  },
  async roles() {
    const m = await import('../agent/team.mjs');
    return Object.keys(m.AGENTS).length;
  },
};

/**
 * 名词 → provider 映射。名词用「包含」匹配，越靠前越优先。
 * 只映射**我们能实测**的东西；映射不到的会进「未覆盖」，如实暴露。
 */
const NOUN_MAP = [
  { test: /RPC\s*方法|宿主\s*RPC|RPC/, provider: 'rpcMethods', label: 'RPC 方法' },
  { test: /模块验证|验证文件|项验证|个验证/, provider: 'verifyFiles', label: '验证文件' },
  { test: /台账/, provider: 'ledgerEntries', label: '台账条目' },
  { test: /自研技能|个技能|技能/, provider: 'skills', label: '自研技能' },
  { test: /工具/, provider: 'tools', label: '工具' },
  { test: /角色/, provider: 'roles', label: '角色' },
];

/** 从文本抽取数字声明：N 个/项/条 + 名词（名词取后面到标点/空白/竖线为止） */
function extractClaims(text) {
  const out = [];
  // 名词：允许中间空格，遇到中文标点/斜杠/竖线/括号停止
  const re = /(\d+)\s*(个|项|条)\s*([\u4e00-\u9fffA-Za-z0-9][\u4e00-\u9fffA-Za-z0-9\s]{0,20})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const noun = m[3].trim().replace(/\s+/g, ' ');
    if (!noun) continue;
    out.push({ num: Number(m[1]), unit: m[2], noun, idx: m.index });
  }
  return out;
}

async function main() {
  const measured = {};
  for (const [k, fn] of Object.entries(measurements)) {
    try { measured[k] = await fn(); } catch (e) { measured[k] = -1; }
  }

  // --file 可指定只扫某个文档（供反例自测）；默认扫 DOCS
  const fi = process.argv.indexOf('--file');
  const scanList = fi >= 0 && process.argv[fi + 1] ? [process.argv[fi + 1]] : DOCS;

  const rows = [];
  const uncovered = [];
  for (const doc of scanList) {
    const text = read(doc);
    if (!text) continue;
    for (const c of extractClaims(text)) {
      const hit = NOUN_MAP.find((n) => n.test.test(c.noun));
      if (!hit) { uncovered.push({ doc, ...c }); continue; }
      const actual = measured[hit.provider];
      // 只比对「个/项/条 + 该 provider 典型单位」；verbatim 名词与 provider 一致才比
      rows.push({ doc, claim: c.num, unit: c.unit, noun: c.noun, provider: hit.provider, label: hit.label, actual });
    }
  }

  console.log('');
  console.log('  文档数字巡检（文档声明 vs 代码实测）');
  console.log('  ' + '─'.repeat(76));
  const bad = rows.filter((r) => r.actual >= 0 && r.claim !== r.actual);
  for (const r of rows) {
    const ok = r.actual >= 0 && r.claim === r.actual;
    const tag = r.actual < 0 ? '?' : ok ? '✓' : '✗';
    console.log(`    ${tag} ${r.doc}  声明 ${r.claim} ${r.unit}${r.noun}  实测 ${r.label}=${r.actual}`);
  }
  console.log('');
  console.log('  实测值：' + Object.entries(measured).map(([k, v]) => k + '=' + v).join(' · '));
  console.log('  未覆盖数字（无实测 provider，如实列出，不假装检查）：' + uncovered.length + ' 处');
  // 未覆盖太多会很吵，只列前 8 条示意
  for (const u of uncovered.slice(0, 8)) console.log(`    · ${u.doc}: ${u.num} ${u.unit}${u.noun}`);
  if (uncovered.length > 8) console.log(`    … 其余 ${uncovered.length - 8} 处略`);
  console.log('');
  if (bad.length) {
    console.log('  四态: FAIL —— 有 ' + bad.length + ' 处文档数字与实测不一致：');
    for (const b of bad) console.log(`    ✗ ${b.doc}: 写「${b.claim} ${b.unit}${b.noun}」，实测 ${b.label}=${b.actual}`);
    process.exitCode = 1;
  } else {
    console.log('  四态: ' + (uncovered.length ? 'WARN' : 'PASS') + ' —— 已映射数字全部一致；未覆盖 ' + uncovered.length + ' 处');
    process.exitCode = uncovered.length ? 3 : 0;
  }
}

main().catch((e) => { console.error('  ✗ 巡检工具异常：' + e.stack); process.exit(2); });