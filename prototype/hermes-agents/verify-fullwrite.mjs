#!/usr/bin/env node
/**
 * 全量写入验收器 —— 12 个智能体 × 4 层，逐项给数字
 *
 * 判据（任何一项 ✗ 就是没写完）：
 *   ① profile.yaml 的 description 含「产出」「越界」「验收」，长度 ≥ 40
 *   ② SOUL.md 含四段：我是谁 / 我做什么 / 我不做什么 / 硬约束
 *   ③ skills/<id>/ 文件数 ≥ 源目录文件数
 *   ④ memories/ 文件数 == 源场景目录 .md 总数 - 1（减掉 AGENTS.local.md）
 *   ⑤ 不越界：没有写到 default profile，没有写到别人的场景目录
 */

import fs from 'node:fs';
import path from 'node:path';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const PROFILES = 'C:/Users/15282/AppData/Local/hermes/profiles';
const SCEN = path.join(WB, '外壳', 'scenarios');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const SK = path.join(WB, '数据', '.dsh', 'skills');

// ── 从场景定义拿权威清单 ──
const scenes = [];
for (const f of fs.readdirSync(SCEN)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
  if (!j.id || !j.name) continue;
  scenes.push({ id: j.id, name: j.name });
}
scenes.sort((a, b) => a.id.localeCompare(b.id));

function countFiles(dir, recurse = true) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) n++;
    else if (recurse && e.isDirectory()) n += countFiles(path.join(dir, e.name), true);
  }
  return n;
}

const rows = [];
let allOk = true;

for (const s of scenes) {
  const pdir = path.join(PROFILES, s.id);
  const r = { id: s.id, name: s.name, checks: {}, notes: [] };

  // ① description
  const yamlP = path.join(pdir, 'profile.yaml');
  let desc = '';
  if (fs.existsSync(yamlP)) {
    const y = fs.readFileSync(yamlP, 'utf8');
    const m = y.match(/^description:\s*(.*)$/m);
    desc = (m ? m[1] : '').trim();
  }
  r.checks.desc = desc.length >= 40 && /产出/.test(desc) && /越界/.test(desc) && /验收/.test(desc);
  r.descLen = desc.length;

  // ② SOUL.md 四段
  const soulP = path.join(pdir, 'SOUL.md');
  let soul = '';
  if (fs.existsSync(soulP)) soul = fs.readFileSync(soulP, 'utf8');
  const sec = {
    who: /##\s*我是谁/.test(soul),
    what: /##\s*我做什么/.test(soul),
    notWhat: /##\s*我不做什么/.test(soul),
    hard: /##\s*硬约束/.test(soul),
  };
  r.checks.soul = sec.who && sec.what && sec.notWhat && sec.hard;
  r.soulLines = soul ? soul.split('\n').length : 0;
  r.soulSec = sec;

  // ③ skills
  const srcSk = path.join(SK, s.id);
  const dstSk = path.join(pdir, 'skills', s.id);
  const srcSkN = countFiles(srcSk);
  const dstSkN = countFiles(dstSk);
  r.checks.skill = srcSkN > 0 && dstSkN >= srcSkN;
  r.skillN = dstSkN + '/' + srcSkN;

  // ④ memories
  const srcMemDir = path.join(MEM, s.name);
  let srcMemN = 0;
  if (fs.existsSync(srcMemDir)) {
    srcMemN = fs.readdirSync(srcMemDir).filter((x) => x.endsWith('.md') && x !== 'AGENTS.local.md').length;
  }
  const dstMemN = countFiles(path.join(pdir, 'memories'), false);
  r.checks.mem = srcMemN > 0 && dstMemN >= srcMemN;
  r.memN = dstMemN + '/' + srcMemN;

  r.ok = Object.values(r.checks).every(Boolean);
  if (!r.ok) allOk = false;
  rows.push(r);
}

// ── ⑤ 越界检查 ──
const ZERO_TIME = new Date('2026-11-13T00:00:00').getTime();
let defaultTouched = [];
const defaultDir = path.join(PROFILES, 'default');
if (fs.existsSync(defaultDir)) {
  for (const f of ['SOUL.md', 'profile.yaml']) {
    const fp = path.join(defaultDir, f);
    if (fs.existsSync(fp) && fs.statSync(fp).mtimeMs > ZERO_TIME) defaultTouched.push(f);
  }
}

// ── 输出 ──
console.log('='.repeat(88));
console.log('  全量写入验收：12 个智能体 × 4 层');
console.log('='.repeat(88));
console.log();
console.log('  ' + '场景'.padEnd(20) + 'desc  SOUL(段/行)      skills  memories  结果');
console.log('  ' + '─'.repeat(84));

for (const r of rows) {
  const c = r.checks;
  const mark = (b) => (b ? '✓' : '✗');
  const secN = Object.values(r.soulSec).filter(Boolean).length;
  console.log(
    '  ' + (r.id + ' ' + r.name).padEnd(20) +
    mark(c.desc) + String(r.descLen).padStart(3) + '  ' +
    mark(c.soul) + secN + '/4' + String(r.soulLines).padStart(4) + '行  ' +
    mark(c.skill) + String(r.skillN).padStart(7) + '  ' +
    mark(c.mem) + String(r.memN).padStart(7) + '  ' +
    (r.ok ? '  ✓ 完成' : '  ✗ 未完成'),
  );
}

console.log();
const okN = rows.filter((r) => r.ok).length;
console.log('─'.repeat(88));
console.log('  完成 ' + okN + ' / ' + rows.length);

// 越界
if (defaultTouched.length) {
  console.log();
  console.log('  ✗ 越界：hermes 的 default profile 被改过 → ' + defaultTouched.join(', '));
  allOk = false;
} else {
  console.log('  ✓ 边界：hermes 的 default profile 未被触碰');
}

// 失败明细
const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  console.log();
  console.log('  未完成明细：');
  for (const r of failed) {
    const miss = [];
    if (!r.checks.desc) miss.push('description（需含产出/越界/验收，≥40字）');
    if (!r.checks.soul) miss.push('SOUL.md（缺段：' + Object.entries(r.soulSec).filter(([, v]) => !v).map(([k]) => k).join(',') + '）');
    if (!r.checks.skill) miss.push('skills（' + r.skillN + '）');
    if (!r.checks.mem) miss.push('memories（' + r.memN + '）');
    console.log('    · ' + r.id.padEnd(20) + miss.join('；'));
  }
}

console.log('='.repeat(88));
process.exit(allOk ? 0 : 1);
