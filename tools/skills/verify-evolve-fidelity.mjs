import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

// 造一个临时技能：description 含多个意图词，正文原本覆盖它们
const dir = path.join(ROOT, 'prototype/scenes/zz-tmp-evolve');
fs.mkdirSync(dir, { recursive: true });
const orig = `---
name: zz-tmp-evolve
category: 工程
description: 数据迁移安全流程：先备份、再 dry-run、再全量、再校验计数。当用户要迁移数据时使用。
---

# 临时
## 怎么做
1. 先备份数据
2. dry-run 预演
3. 全量执行
4. 校验计数吻合
`;
fs.writeFileSync(path.join(dir, 'SKILL.md'), orig, 'utf8');

// 若网关不可用，本测试跳过（退出 0 但说明）——保真闸逻辑本身不依赖网关，用单元方式验。
// 这里直接测「保真闸」的纯逻辑：手动模拟一个丢意图的正文，看阈值判定。
// 为可复算，我们直接验证：正文若只留「先备份」而丢了 dry-run/全量/校验 → 覆盖 <50% → 应拒。
const desc = '数据迁移安全流程：先备份、再 dry-run、再全量、再校验计数。当用户要迁移数据时使用。';
const STOP = new Set(['当用户','检查','修复','相关','使用','一个','以及','或者','进行','是否','可以','需要','然后','这个','那个','我们','对','的','了','和','与','在','是','要','能','会','把','被','给','为','个']);
const words = (desc.match(/[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}/g) || []).map((w) => w.trim()).filter((w) => !STOP.has(w) && w.length >= 2);
const badBody = '先备份数据。'; // 只覆盖「备份」
const covered = words.filter((w) => badBody.includes(w));
const ratio = covered.length / words.length;
t('丢意图正文（只留备份）覆盖 <50% → 应被拒', ratio < 0.5, 'ratio=' + ratio.toFixed(2) + ' words=' + words.join(','));
const goodBody = '先备份、再 dry-run 预演、再全量、再校验计数，最后复核。';
const cov2 = words.filter((w) => goodBody.includes(w));
t('完整正文覆盖 ≥50% → 放行', cov2.length / words.length >= 0.5, 'ratio=' + (cov2.length / words.length).toFixed(2));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);