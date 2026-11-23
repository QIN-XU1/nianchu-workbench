#!/usr/bin/env node
/**
 * 把工作台的 12 个场景同步进 hermes 的 12 个 profile（幂等）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么需要这个
 * ══════════════════════════════════════════════════════════════════════
 *  全量写入是一次性的；但场景记忆会持续变（情景自己的记忆自己写）。
 *  实测踩到：写完 profile 后又在 `逆向分析/` 里新增了一个记忆文件，
 *  profile 里就少一个，`verify-all.mjs` 报 13/14。
 *
 *  所以需要一个幂等同步器：源变了就补，没变就什么都不做。
 *  它同时是「全量写入」的兜底 —— 任何时候跑一遍都能回到一致状态。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  同步什么
 * ══════════════════════════════════════════════════════════════════════
 *    memories/            源目录 *.md（除 AGENTS.local.md）→ 目标，按内容 SHA 判变化
 *    skills/<id>/         源目录整树 → 目标，按内容 SHA 判变化
 *    profile.yaml         description 缺失/不含三要素 → 从场景 description 重建
 *    SOUL.md              缺四段 → 不自动重建（那是身份，要人写），只报警
 *
 *  不碰：hermes 的 default profile、C:\hermes 源码、其他 11 个场景
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const PROF = 'C:/Users/15282/AppData/Local/hermes/profiles';
const SCEN = path.join(WB, '外壳', 'scenarios');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const SK = path.join(WB, '数据', '.dsh', 'skills');

const DRY = process.argv.includes('--dry');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function walk(d, rel = '') {
  const out = [];
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(d, e.name), r));
    else out.push(r);
  }
  return out;
}

let added = 0;
let updated = 0;
let unchanged = 0;
const warns = [];

const scenes = [];
for (const f of fs.readdirSync(SCEN)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
  if (j.id && j.name) scenes.push(j);
}
scenes.sort((a, b) => a.id.localeCompare(b.id));

console.log('=== 同步 ' + scenes.length + ' 个智能体' + (DRY ? '（dry-run）' : '') + ' ===');
console.log();

for (const s of scenes) {
  const pdir = path.join(PROF, s.id);
  if (!fs.existsSync(pdir)) {
    warns.push(s.id + '：profile 不存在，需先 hermes profile create');
    continue;
  }

  let a = 0;
  let u = 0;
  let k = 0;

  // ── memories ──
  const srcMem = path.join(MEM, s.name);
  const dstMem = path.join(pdir, 'memories');
  if (fs.existsSync(srcMem)) {
    if (!fs.existsSync(dstMem) && !DRY) fs.mkdirSync(dstMem, { recursive: true });
    for (const f of fs.readdirSync(srcMem)) {
      if (!f.endsWith('.md') || f === 'AGENTS.local.md') continue;
      const sp = path.join(srcMem, f);
      const dp = path.join(dstMem, f);
      if (!fs.existsSync(dp)) {
        if (!DRY) fs.copyFileSync(sp, dp);
        a++;
      } else if (sha(sp) !== sha(dp)) {
        if (!DRY) fs.copyFileSync(sp, dp);
        u++;
      } else k++;
    }
  }

  // ── skills ──
  const srcSk = path.join(SK, s.id);
  const dstSk = path.join(pdir, 'skills', s.id);
  if (fs.existsSync(srcSk)) {
    for (const rel of walk(srcSk)) {
      const sp = path.join(srcSk, rel);
      const dp = path.join(dstSk, rel);
      if (!fs.existsSync(dp)) {
        if (!DRY) {
          fs.mkdirSync(path.dirname(dp), { recursive: true });
          fs.copyFileSync(sp, dp);
        }
        a++;
      } else if (sha(sp) !== sha(dp)) {
        if (!DRY) fs.copyFileSync(sp, dp);
        u++;
      } else k++;
    }
  }

  // ── profile.yaml：**只补不改** ──
  //
  // 铁律：手写的合同比场景 json 的 description 强得多。
  // 实测：reverse-eng 的 profile.yaml 是 154 字、含产出/越界/验收三要素的完整合同；
  // 而场景 json 的 description 只有 44 字、缺「越界」「验收」。
  // 如果拿后者去覆盖前者，等于把合同退化成一句简介 —— 所以只在**文件不存在**时创建，
  // 且来源 description 必须先过三要素检查，不合格就不写、只报警。
  const yp = path.join(pdir, 'profile.yaml');
  if (!fs.existsSync(yp)) {
    const desc = (s.description || '').replace(/\s+/g, ' ').trim();
    const ok = desc.length >= 40 && /产出/.test(desc) && /越界/.test(desc) && /验收/.test(desc);
    if (ok) {
      if (!DRY) fs.writeFileSync(yp, 'description: ' + desc + '\ndescription_auto: false\n', 'utf8');
      a++;
      if (!DRY) console.log('      + profile.yaml（来源：场景 description）');
    } else {
      warns.push(s.id + '：profile.yaml 不存在，且场景 description 不合格（' +
        desc.length + ' 字，缺' + ['产出', '越界', '验收'].filter((x) => !new RegExp(x).test(desc)).join('/') +
        '）→ 需人写合同');
    }
  } else {
    const m = fs.readFileSync(yp, 'utf8').match(/^description:\s*(.*)$/m);
    const d = m ? m[1].trim() : '';
    const ok = d.length >= 40 && /产出/.test(d) && /越界/.test(d) && /验收/.test(d);
    if (!ok) {
      warns.push(s.id + '：profile.yaml 的 description 不合格（' + d.length + ' 字）→ 需人写，不自动改');
    }
  }

  // ── SOUL.md：只检查，不自动改 ──
  const sp2 = path.join(pdir, 'SOUL.md');
  if (fs.existsSync(sp2)) {
    const soul = fs.readFileSync(sp2, 'utf8');
    const miss = ['我是谁', '我做什么', '我不做什么', '硬约束'].filter((x) => !new RegExp('##\\s*' + x).test(soul));
    if (miss.length) warns.push(s.id + '：SOUL.md 缺段 ' + miss.join(',') + '（需人写，不自动改）');
  } else {
    warns.push(s.id + '：SOUL.md 不存在');
  }

  added += a;
  updated += u;
  unchanged += k;
  const flag = a || u ? '✓' : '·';
  console.log('  ' + flag + ' ' + (s.id + ' ' + s.name).padEnd(24) +
    '新增 ' + String(a).padStart(2) + '  更新 ' + String(u).padStart(2) + '  不变 ' + String(k).padStart(2));
}

console.log();
console.log('  合计：新增 ' + added + ' 个文件，更新 ' + updated + ' 个，不变 ' + unchanged + ' 个');
if (warns.length) {
  console.log();
  console.log('  需人处理 ' + warns.length + ' 项：');
  for (const w of warns) console.log('    · ' + w);
}
console.log();
process.exit(warns.length ? 1 : 0);
