const fs = require('fs');
const path = require('path');
const ROOT = 'D:/file/AI Temp/DeepSeek/Agent自研';

const mx = JSON.parse(fs.readFileSync(path.join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));

// 31 维的紧凑规格（id + 名称 + 分组），给拆解 agent 当输出模板
const dims = [];
for (const g of mx.dimensions) for (const it of g.items) dims.push({ id: it.id, name: it.name, group: g.group });

// 22 个参照项目（来自 research/拆解/汇总.md，权威清单）
const subjects = [
  { id: 'openbitfun', name: 'OpenBitFun（我们的基座）', report: 'openbitfun.md', kind: '本地源码' },
  { id: 'dsh', name: 'DeepSeek Harness', report: 'dsh-openclaw.md', kind: '本地源码' },
  { id: 'openclaw', name: 'openclaw', report: 'dsh-openclaw.md', kind: '本地源码' },
  { id: 'hermes', name: 'hermes-agent', report: 'hermes-ecc.md', kind: '本地源码' },
  { id: 'ecc', name: 'ECC', report: 'hermes-ecc.md', kind: '本地源码' },
  { id: 'pi', name: 'pi', report: 'three.md', kind: '本地源码' },
  { id: 'open-design', name: 'open-design', report: 'three.md', kind: '本地源码' },
  { id: 'luanyujia', name: 'luanyujia-workbench', report: 'three.md', kind: '本地源码' },
  { id: 'weknora', name: 'WeKnora', report: 'new3.md', kind: '本地源码' },
  { id: 'craft-anything', name: 'craft-anything', report: 'new3.md', kind: '本地源码' },
  { id: 'solo-to-team-skills', name: 'solo-to-team-skills', report: 'new3.md', kind: '本地源码' },
  { id: 'cl4r1t4s', name: 'CL4R1T4S（80 份厂商提示词）', report: 'spec.md', kind: '本地源码' },
  { id: 'orca', name: 'orca', report: 'orca.md', kind: '本地源码' },
  { id: 'omp-studio', name: 'omp-studio', report: 'omp-aion.md', kind: '本地源码' },
  { id: 'aionui', name: 'AionUi', report: 'omp-aion.md', kind: '本地源码' },
  { id: 'qoder', name: 'Qoder', report: 'closed.md', kind: '闭源' },
  { id: 'workbuddy', name: 'WorkBuddy', report: 'closed.md', kind: '闭源' },
  { id: 'chatgpt', name: 'ChatGPT/Codex', report: 'closed.md', kind: '闭源' },
  { id: 'claude', name: 'Claude Code', report: 'closed.md', kind: '闭源' },
  { id: 'cursor', name: 'Cursor', report: 'closed.md', kind: '闭源' },
  { id: 'trae', name: 'Trae', report: 'closed.md', kind: '闭源' },
  { id: 'codebuddy', name: 'CodeBuddy', report: 'closed.md', kind: '闭源' },
];

const out = {
  _purpose: '把 research/拆解/ 下 22 个项目的分析，按矩阵 31 维口径抽成结构化判定。',
  _legend: mx._legend,
  _evidenceRule: mx._evidenceRule,
  _rule: [
    '只从拆解报告里读，**不要凭产品名猜**。报告里没写的，判「判不了」，不许猜。',
    '每条必须带证据：报告里的 文件:行号 / 路径 / 命令 或「报告未提及」。',
    '报告里说「部分/残缺/只在某端」的判「部分」，不要拔高成「有」。',
  ],
  dimensions: dims,
  subjects,
  // 报告 → 覆盖哪些 subject，方便分派
  reports: [...new Set(subjects.map((s) => s.report))].map((r) => ({
    report: r,
    subjects: subjects.filter((s) => s.report === r).map((s) => s.id),
  })),
};

const p = path.join(ROOT, 'evidence/evolve/extract-22-spec.json');
fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('  写出 evidence/evolve/extract-22-spec.json');
console.log('  维度 ' + dims.length + ' · 项目 ' + subjects.length + ' · 报告 ' + out.reports.length);
for (const r of out.reports) console.log('    ' + r.report.padEnd(18) + ' → ' + r.subjects.join(', '));
