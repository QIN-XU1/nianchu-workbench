#!/usr/bin/env node
/**
 * 从 22 个拆解里找「所有人共同缺的那一块」
 *
 * 方法：把每个项目报告里的「缺点」抽出来，看有没有一条是**所有项目都有**的。
 * 如果有，那它就是行业的结构性空白 —— 也就是我们能定义新赛道的地方。
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'research/拆解';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md'));

// 把缺点归到「结构性主题」上
const THEMES = [
  { id: 'no-learn',     re: /不学习|无学习|不自进化|不会变强|手工改|靠人改|无法自我|没有反馈回路|无对照实验|无前后|未证明有效|靠自觉|0 行代码保证/i, name: '不会自己变强（改进靠人手工做）' },
  { id: 'no-measure',   re: /没有数据|无数据|未量化|无法量化|无对照|无前后发生率|不可复算|无法复算|数字不可信/i, name: '改进没有度量（不知道有没有变好）' },
  { id: 'no-verify',    re: /无法审计|不可审计|无法验证|不可验证|无测试|删行机制不可审计|未运行/i, name: '结论不可独立验证' },
  { id: 'no-uncertain', re: /二态|只有通过|没有判不了|无 UNKNOWN|断言|二元/i, name: '不确定性不是一等公民' },
  { id: 'no-memory-ttl',re: /无.*TTL|无.*衰减|陈旧记忆|无时效|supersede.*无|trust.*死字段/i, name: '记忆不会老化（旧事实永久污染）' },
  { id: 'god-file',     re: /god-file|单文件.*行|单文件有|万行|行单文件/i, name: '单文件过大' },
  { id: 'no-cost',      re: /无成本|没有成本|无计价|无预算|成本不可见/i, name: '成本不可见' },
  { id: 'copy-drift',   re: /漂移|副本|不一致|不同步|落后/i, name: '多副本漂移' },
  { id: 'vendor-lock',  re: /封闭|闭源|依赖.*供应商|无法自托管|CDN|升级即断/i, name: '被供应商或平台锁住' },
];

const hits = {};   // theme → [项目]
for (const t of THEMES) hits[t.id] = new Set();

// 项目名从文件名推
for (const f of files) {
  if (f === '标准.md' || f === '汇总.md') continue;
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  // 只看「缺点」相关章节，避免把别人的优点误算
  const chunks = [];
  for (const m of text.matchAll(/##+\s*[^\n]*(缺点|弱点|不足|短板)[^\n]*\n([\s\S]{0,12000}?)(?=\n##+\s|$)/g)) {
    chunks.push(m[2]);
  }
  const body = chunks.join('\n');
  if (!body) continue;
  const label = f.replace(/\.md$/, '');
  for (const t of THEMES) {
    if (t.re.test(body)) hits[t.id].add(label);
  }
}

console.log('');
console.log('  行业结构性空白扫描 —— 谁都有这条缺点？');
console.log('  ' + '='.repeat(76));
console.log('  （只统计各报告「缺点」章节，源文件 ' + (files.length - 2) + ' 份）');
console.log('');

const ranked = THEMES.map((t) => ({ ...t, n: hits[t.id].size, who: [...hits[t.id]] }))
  .sort((a, b) => b.n - a.n);

for (const t of ranked) {
  const bar = '█'.repeat(Math.min(30, t.n)).padEnd(30, '·');
  console.log('  ' + String(t.n).padStart(2) + ' 份  ' + bar + '  ' + t.name);
  if (t.n) console.log('         ' + t.who.slice(0, 8).join(' · '));
}

console.log('');
console.log('  ' + '─'.repeat(76));
console.log('  同一主题被提及最多的三条 = 行业共同短板');
console.log('');

// 交叉：同时命中 top3 的项目
const top3 = ranked.slice(0, 3).map((t) => t.id);
const cross = [];
for (const f of files) {
  if (f === '标准.md' || f === '汇总.md') continue;
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const chunks = [...text.matchAll(/##+\s*[^\n]*(缺点|弱点|不足|短板)[^\n]*\n([\s\S]{0,12000}?)(?=\n##+\s|$)/g)].map((m) => m[2]).join('\n');
  if (!chunks) continue;
  const n = top3.filter((id) => THEMES.find((t) => t.id === id).re.test(chunks)).length;
  if (n >= 2) cross.push(f.replace(/\.md$/, '') + '(' + n + ')');
}
console.log('  同时命中 top3 中 ≥2 条的项目 (' + cross.length + ')');
console.log('    ' + cross.join('  '));
console.log('');
console.log('  结论：如果「不会自己变强」+「改进没有度量」+「结论不可独立验证」');
console.log('        是几乎所有项目的共同空白，那它就是新赛道的位置。');
console.log('');