#!/usr/bin/env node
/**
 * 语义相关性检查器 · 验收器（含反例）
 * 用独立验证方指出的真实错配案例做反例，证明检查器能把它们判为不相关。
 */
import { checkRelevance, keywordsOf, evaluateDim } from '../../tools/benchmark/relevance.mjs';

let pass = 0, total = 0;
const lines = [];
function T(name, ok, why) { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  ← ' + why)); }

// ── 正例 1：关键词提取 ──
const kws = keywordsOf('代码编辑与 diff 应用');
T('正例 · 关键词含中文与英文', kws.includes('代码编辑与') === false && kws.some((k) => k.includes('代码')) && kws.includes('diff'),
  JSON.stringify(kws));

// ── 正例 2：相关文件命中 ──
const r1 = checkRelevance({ dimName: '联网搜索与抓取', text: 'export function fetchUrl(){ return http.get(url) } // search & fetch' });
T('正例 · 内容含 fetch/http ⇒ 相关', r1.relevant === true, JSON.stringify(r1.hits));

// ── 反例 1（独立方实证）：A1 维度指向记忆插件类型文件 ──
const r2 = checkRelevance({ dimName: '代码编辑与 diff 应用', text: 'export type ActiveMemoryEntry = { id: string; text: string }' });
T('反例 · A1 错配锚点（记忆类型文件）⇒ 判不相关', r2.relevant === false, JSON.stringify(r2.hits));

// ── 反例 2（独立方实证）：A3 维度指向 model-providers 测试 ──
const r3 = checkRelevance({ dimName: '联网搜索与抓取', text: "describe('model providers', () => { it('lists models', () => {}) })" });
T('反例 · A3 错配锚点（模型供应商测试）⇒ 判不相关', r3.relevant === false, JSON.stringify(r3.hits));

// ── 反例 3（独立方实证）：knip lint 配置（字符串/注释） ──
const r4 = checkRelevance({ dimName: '技能 / 插件生态', text: '// package-mac-app.sh launches the architecture scheduler by path.\nignore: ["scripts/e2e/lib/x.mjs!"]' });
T('反例 · knip 配置锚点 ⇒ 判不相关', r4.relevant === false, JSON.stringify(r4.hits));

// ── 反例 4：空文件 ──
T('反例 · 空内容 ⇒ 判不相关', checkRelevance({ dimName: '记忆治理', text: '   ' }).relevant === false, 'empty 不该相关');

// ── 反例 5：文件不可读 ──
const r5 = checkRelevance({ dimName: '记忆治理', file: 'C:/__definitely_not_here__.ts' });
T('反例 · 文件不存在 ⇒ 判不相关（不抛）', r5.relevant === false && r5.reason === 'unreadable', r5.reason);

// ── 反例 6：minHits 提高后单命中不够 ──
const r6 = checkRelevance({ dimName: '插件化内核 无特权核心', text: 'plugin stuff', minHits: 2 });
T('反例 · minHits=2 时单命中 ⇒ 不相关', r6.relevant === false, JSON.stringify(r6.hits));

// ── 正例 3：evaluateDim 分类正确 ──
const ev = evaluateDim('插件化内核', [
  { file: 'a', text: 'export function createKernel(){ /* plugin kernel */ }' },
  { file: 'b', text: 'totally unrelated content about cooking' },
]);
T('正例 · 批量评估：1 相关 1 不相关', ev.relevant === 1 && ev.irrelevant === 1, JSON.stringify({ r: ev.relevant, i: ev.irrelevant }));

// ── 正例 4：可复算（同输入两次同输出）──
const a1 = checkRelevance({ dimName: '上下文压缩', text: 'compress context by scoring' });
const a2 = checkRelevance({ dimName: '上下文压缩', text: 'compress context by scoring' });
T('正例 · 可复算（两次结果一致）', JSON.stringify(a1) === JSON.stringify(a2), '不一致');

// ── 正例 5：真实文件读取（读本仓库一个真实文件）──
import path from 'node:path';
const REPO = path.resolve(import.meta.dirname, '../..');
const real = checkRelevance({ dimName: '插件化内核', file: path.join(REPO, 'tools/plugin/kernel.mjs') });
T('正例 · 读真实 kernel.mjs ⇒ 相关', real.relevant === true, JSON.stringify(real.hits));

const ok = pass === total;
console.log('  语义相关性检查器验收（含独立方实证反例）');
console.log(lines.join('\n'));
console.log('\n  验收 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
