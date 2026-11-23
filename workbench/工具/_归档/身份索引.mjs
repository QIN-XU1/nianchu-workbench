#!/usr/bin/env node
/**
 * 身份索引生成器 —— 从真实数据生成身份索引表
 *
 * 原则：**不编造**。
 *   · sessionId 从场景 json 里读真实值
 *   · 没有的标记为 missing，不填假值
 *   · 定位卡路径从实际文件推断
 *
 * 用法：
 *   node 工具/身份索引.mjs            # 打印将要生成的表
 *   node 工具/身份索引.mjs --save     # 写入 _共享记忆/身份索引.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN = path.join(WB, '外壳', 'scenarios');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const OUT = path.join(SHARED, '身份索引.json');

function readJson(p, fb) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // 剥离 BOM
    return JSON.parse(s);
  } catch { return fb; }
}

function collect() {
  const rows = [];
  const warnings = [];

  // 从场景配置列表
  const scenFiles = fs.existsSync(SCEN)
    ? fs.readdirSync(SCEN).filter(f => f.endsWith('.json')).sort()
    : [];

  // 从注册表拿中文名
  const reg = readJson(path.join(SHARED, '索引.json'), { areas: [] });
  const nameById = {};
  for (const a of (reg.areas || [])) nameById[a.id] = a.name;

  for (const f of scenFiles) {
    const sid = f.replace(/\.json$/, '');
    const j = readJson(path.join(SCEN, f), null);
    if (!j) continue;

    const name = j.name || nameById[sid] || sid;
    const panels = j.panels || [];

    // 找 AI 面板
    const aiPanels = panels.filter(p => p.type === 'harness' || p.type === 'main-agent');
    const ctxPath = sid + '-context.md';
    const hasCtx = fs.existsSync(path.join(SCEN, ctxPath));

    for (const p of aiPanels) {
      const sessionId = String(p.sessionId || '').trim();
      const sessionTitle = String(p.sessionTitle || '').trim();

      if (!sessionId) {
        warnings.push('场景「' + name + '」面板 ' + p.id + ' 没有 sessionId（AI 面板会退化）');
      } else if (/0000-0000|xxxx-xxxx/.test(sessionId)) {
        warnings.push('场景「' + name + '」面板 ' + p.id + ' 的 sessionId 是占位符：' + sessionId);
      }
      if (!sessionTitle) {
        warnings.push('场景「' + name + '」面板 ' + p.id + ' 没有 sessionTitle');
      }

      rows.push({
        scene: sid,
        name,
        panel: p.id,
        panelType: p.type,
        sessionTitle: sessionTitle || '(缺)',
        sessionId: sessionId || '(缺)',
        context: hasCtx ? ctxPath : '(缺)',
        memory: '场景记忆/' + name + '/',
      });
    }

    // 没有 AI 面板的场景也要记录（它有记忆，可能需要认领）
    if (aiPanels.length === 0) {
      rows.push({
        scene: sid,
        name,
        panel: '(无AI面板)',
        panelType: null,
        sessionTitle: null,
        sessionId: null,
        context: hasCtx ? ctxPath : '(缺)',
        memory: '场景记忆/' + name + '/',
      });
    }

    if (!hasCtx) {
      warnings.push('场景「' + name + '」缺定位卡（' + ctxPath + '）');
    }
  }

  return { rows, warnings };
}

function print(result) {
  const { rows, warnings } = result;

  console.log('═'.repeat(78));
  console.log('  身份索引（从真实数据生成）');
  console.log('═'.repeat(78));
  console.log();
  console.log('  共 ' + rows.length + ' 行');
  console.log();

  // 表头
  console.log('  ' + '场景'.padEnd(22) + '面板'.padEnd(14) + '会话标题'.padEnd(16) + 'sessionId');
  console.log('  ' + '─'.repeat(74));
  for (const r of rows) {
    const sid = r.sessionId === null ? '—' : (r.sessionId === '(缺)' ? '*(缺)*' : r.sessionId.slice(0, 22));
    console.log('  ' + r.scene.padEnd(22) + String(r.panel).padEnd(14) +
      String(r.sessionTitle || '—').padEnd(16) + sid);
  }

  console.log();
  if (warnings.length) {
    console.log('  ⚠ 警告 ' + warnings.length + ' 条:');
    for (const w of warnings) console.log('    · ' + w);
  } else {
    console.log('  ✅ 无警告');
  }
  console.log();
}

const args = process.argv.slice(2);
const result = collect();
print(result);

if (args.includes('--save')) {
  fs.mkdirSync(SHARED, { recursive: true });
  const doc = {
    _at: new Date().toISOString(),
    _note: '身份索引 —— "我是谁"的唯一对照表。生成自真实场景配置，不手工编造。',
    _warning: result.warnings,
    rows: result.rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2), 'utf8');
  console.log('已保存: ' + path.relative(path.resolve(WB, '..'), OUT));
  console.log();
  console.log('注意：' + result.warnings.length + ' 条警告未解决。');
  console.log('      身份哨兵会把这些报为违规 —— 这是设计意图。');
}
