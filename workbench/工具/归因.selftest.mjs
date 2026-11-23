#!/usr/bin/env node
/**
 * 归因的测试 —— 证明归因真的能识别问题
 *
 * 归因如果只会输出"一切正常"，就毫无价值。
 * 必须证明：造出对应的数据，能得出对应的归因。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { analyze, renderSection, writeSection, RULES } from './归因.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = [];

function chk(name, ok, detail) {
  R.push({ name, ok: !!ok });
  console.log((ok ? '  OK   ' : '  XX   ') + name + (detail ? '  ' + String(detail).slice(0, 60) : ''));
}

const NOW_MS = Date.parse('2026-11-09T12:00:00Z');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-test-'));
const DATA = path.join(BASE, 'dsh');
const SHARED = path.join(DATA, '场景记忆', '_共享记忆');

function hoursAgo(h) {
  return new Date(NOW_MS - h * 3600000).toISOString();
}

function makeDispatch(over) {
  return Object.assign({
    id: 'd-' + Math.random().toString(36).slice(2, 10),
    type: 'dispatch',
    from: 'hub',
    to: 'demo',
    subject: '普通任务',
    phenomenon: '测试现象描述文本',
    howto: '测试照做说明文本',
    verify: '测试验证方式文本',
    createdAt: hoursAgo(2),
    state: 'acked',
    deliveredAt: hoursAgo(1.5),
    ackedAt: hoursAgo(1),
    receipt: '这是一段足够长的证据文字用来通过校验',
    deadlineHours: 24,
  }, over || {});
}

function setup(dispatches, boundaryEvents) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(SHARED, { recursive: true });
  fs.writeFileSync(path.join(SHARED, '派单台账.json'),
    JSON.stringify({ dispatches }, null, 2), 'utf8');
  fs.writeFileSync(path.join(SHARED, '越界记录.json'),
    JSON.stringify({ events: boundaryEvents || [] }, null, 2), 'utf8');
  fs.writeFileSync(path.join(SHARED, '健康度.json'),
    JSON.stringify({ scenes: { demo: { firstPassRate: 0.5 } } }, null, 2), 'utf8');
  // 场景记忆
  const memDir = path.join(DATA, '场景记忆', '演示');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '场景私有记忆.md'),
    '# 演示 · 场景私有记忆\n\n## §〇 当前交接\n\n- 测试\n\n## 一、职责边界\n\n- 测试\n', 'utf8');
}

console.log('═'.repeat(66));
console.log('  归因 · 测试');
console.log('═'.repeat(66));
console.log();

// ═══ 1. 没有数据 → 无归因 ═══
console.log('【1】没有派单数据');
{
  setup([], []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  chk('无数据时不产生场景', Object.keys(r.scenes).length === 0, Object.keys(r.scenes).length + ' 个场景');
}

// ═══ 2. 正常数据 → 无异常 ═══
console.log();
console.log('【2】正常数据');
{
  setup([makeDispatch()], []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const s = r.scenes.demo;
  chk('识别出场景', !!s, s ? s.taskCount + ' 任务' : '无');
  chk('无异常归因', s && !s.hasFindings, s ? s.findings.length + ' 条' : '');
}

// ═══ 3. 技能缺口：同类任务失败 3 次 ═══
console.log();
console.log('【3】技能缺口（同类失败 ' + RULES.SKILL_GAP_THRESHOLD + ' 次）');
{
  const ds = [
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '普通任务' }),
  ];
  setup(ds, []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const s = r.scenes.demo;
  const gap = s.findings.find(f => f.type === 'skill-gap');
  chk('识别出技能缺口', !!gap, gap ? gap.subject : '无');
  chk('归因指向技能文件', gap && gap.level === 'L2', gap ? gap.level : '');
  chk('说明了具体缺什么', gap && gap.attribution.includes('竞品功能矩阵'), gap ? gap.attribution.slice(0, 40) : '');
}

// ═══ 4. 流程缺失：同类返工 2 次 ═══
console.log();
console.log('【4】流程缺失（同类返工 ' + RULES.PROCESS_THRESHOLD + ' 次）');
{
  const ds = [
    makeDispatch({ subject: '报告交付' }),
    makeDispatch({ subject: '报告交付' }),
    makeDispatch({ subject: '报告交付' }),
  ];
  setup(ds, []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const s = r.scenes.demo;
  const proc = s.findings.find(f => f.type === 'process-missing');
  chk('识别出流程缺失', !!proc, proc ? proc.subject : '无');
  chk('归因指向验收标准', proc && proc.attribution.includes('验收标准'), proc ? proc.attribution.slice(0, 40) : '');
}

// ═══ 5. 越界：2 次 ═══
console.log();
console.log('【5】越界（' + RULES.BOUNDARY_THRESHOLD + ' 次）');
{
  setup([makeDispatch()], [
    { at: hoursAgo(3), scene: 'demo', path: 'workbench/外壳/scenarios/other.json', tier: 'E' },
    { at: hoursAgo(2), scene: 'demo', path: 'workbench/外壳/scenarios/other2.json', tier: 'E' },
  ]);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const s = r.scenes.demo;
  const b = s.findings.find(f => f.type === 'boundary-misread');
  chk('识别出越界', !!b, b ? b.count + ' 次' : '无');
  chk('归因指向权限误解', b && b.level === 'L3', b ? b.level : '');
}

// ═══ 6. 未回执 ═══
console.log();
console.log('【6】未回执');
{
  setup([
    makeDispatch({ state: 'delivered' }),
    makeDispatch({ state: 'created' }),
  ], []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const s = r.scenes.demo;
  const u = s.findings.find(f => f.type === 'unacked');
  chk('识别出未回执', !!u, u ? u.subject : '无');
}

// ═══ 7. 渲染 §六 ═══
console.log();
console.log('【7】渲染 §六 文本');
{
  setup([
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
  ], []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const text = renderSection(r, 'demo');
  chk('渲染出 §六 标题', text.includes('## §六 归因摘要'), text.split('\n')[0]);
  chk('包含归因四问之一', text.includes('哪类任务总失败'), '');
  chk('包含动作建议', text.includes('动作：'), '');
}

// ═══ 8. 写入场景记忆 ═══
console.log();
console.log('【8】写入场景记忆');
{
  setup([
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '竞品功能矩阵', state: 'delivered', needsRework: true }),
  ], []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const text = renderSection(r, 'demo');
  const w = writeSection(DATA, '演示', text);
  chk('写入成功', w.ok, w.ok ? w.file : w.error);

  const after = fs.readFileSync(path.join(DATA, '场景记忆', '演示', '场景私有记忆.md'), 'utf8');
  chk('§六 已写入文件', after.includes('## §六 归因摘要'), '');
  chk('原有内容未丢', after.includes('## 一、职责边界'), '');
}

// ═══ 9. 重复写入是替换不是追加 ═══
console.log();
console.log('【9】重复写入是替换（不是追加）');
{
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const text = renderSection(r, 'demo');
  writeSection(DATA, '演示', text);
  writeSection(DATA, '演示', text);

  const after = fs.readFileSync(path.join(DATA, '场景记忆', '演示', '场景私有记忆.md'), 'utf8');
  const count = (after.match(/## §六 归因摘要/g) || []).length;
  chk('§六 只有一份（替换写）', count === 1, count + ' 份');
}

// ═══ 反例验证 ═══
console.log();
console.log('【反例验证】');
{
  // 如果归因永远"无异常"，这里会失败
  setup([
    makeDispatch({ subject: '必失败任务', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '必失败任务', state: 'delivered', needsRework: true }),
    makeDispatch({ subject: '必失败任务', state: 'delivered', needsRework: true }),
  ], []);
  const r = analyze({ dataRoot: DATA, nowMs: NOW_MS });
  const s = r.scenes.demo;
  if (s && s.hasFindings) {
    console.log('  OK   归因确实能发现问题（不是永远"无异常"）');
  } else {
    console.log('  XX   归因永远无异常 —— 是装饰不是归因！');
    R.push({ name: '反例验证', ok: false });
  }
}

console.log();
console.log('─'.repeat(66));
const passed = R.filter(x => x.ok).length;
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
console.log('─'.repeat(66));
console.log();

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
process.exit(R.every(x => x.ok) ? 0 : 1);
