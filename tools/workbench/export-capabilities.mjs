#!/usr/bin/env node
/**
 * 导出「能力」面板的数据：插件与技能的真实清单。
 *
 * 三件事必须是真的：
 *   1. 用真的 kernel.discover() 扫，不是手写清单
 *   2. 用真的 validateManifest() 校验，坏清单要报出来
 *   3. 每个插件标注它**是否真的接进了产品**（运行中 / 已发现未接线 / 清单损坏）
 *      —— 这一步是关键。审计判我们 A12「部分」的理由就是「无 import 者、未接主链路」，
 *      如果这里只列名字不标接线状态，就是又一层假绿。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, validateManifest, topoSort, pluginId } from '../plugin/kernel.mjs';
import { runPlugins } from '../plugin/run.mjs';
import { validateSkill } from '../skills/loader.mjs';
import { execFileSync } from 'node:child_process';

/** 本仓 git 追踪的技能文件集合。用来区分「我们的资产」与「外部参考资产」。 */
function trackedSkillFiles() {
  try {
    const out = execFileSync('git', ['ls-files', 'hermes/optional-skills'], { cwd: ROOT, encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch {
    return new Set(); // 不是 git 仓库 / git 不可用 → 一律当外部，宁可少算
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'apps/vouch-web/src/web-ui/src/app/scenes/workbench/data/capabilities.json');

/**
 * 【2026-11-17 独立审计抓到的假绿，已修】
 * 原来这里是一张硬编码表 RUNNING = [memory-neuron, sea-workbench, workbench-launcher]，
 * 界面据此显示「运行中」—— 那只是「我们声称它在跑」，不是验证过的。
 * 现在只报「声明挂载」：判据是 plugins/<id>/cordis.patch.yml 存在，
 * 并如实说明本 checkout 无法验证 DSH 是否真的加载了它。
 */
const declaredIfPatch = (dir) => existsSync(join(dir, 'cordis.patch.yml'));
// ── 0) 真跑插件：产品数据管线真的执行插件（这是「接进主链路」的实证）──
let liveRun = null;
try {
  liveRun = await runPlugins({ writeEvidence: true });
} catch (e) {
  liveRun = { error: String(e.message) };
}
const ranOk = new Set((liveRun && liveRun.results ? liveRun.results : []).filter((r) => r.ok).map((r) => r.plugin));

// ── 1) 我们自己的 kernel 插件（plugin.json 格式） ──
const kernelRoots = ['tools/plugin/builtin', 'tools/plugin'];
const seen = new Set();
const kernelPlugins = [];
for (const root of kernelRoots) {
  for (const d of discover(join(ROOT, root))) {
    if (seen.has(d.path)) continue;
    seen.add(d.path);
    const v = d.raw ? validateManifest(d.raw) : { ok: false, errors: ['清单解析失败'] };
    kernelPlugins.push({
      source: 'kernel',
      name: (d.raw && d.raw.name) || '(坏清单)',
      version: (d.raw && d.raw.version) || '',
      description: (d.raw && d.raw.description) || '',
      caps: (d.raw && d.raw.caps) || [],
      requires: (d.raw && d.raw.requires) || [],
      manifestOk: v.ok === true,
      errors: v.errors || [],
      path: d.path.replace(ROOT + '\\', '').replace(ROOT + '/', '').split('\\').join('/'),
      // wired 按「是否真的被产品数据管线执行过」判定，不再硬编码 false
      wired: ranOk.has((d.raw && (d.raw.name || d.raw.id)) || ''),
      wiredWhy: ranOk.has((d.raw && (d.raw.name || d.raw.id)) || '')
        ? '被产品数据管线（export-capabilities）真的执行过，产物 evidence/plugin-probe/live-run.json'
        : '已发现但未被执行',
    });
  }
}

// ── 2) 真实运行的 DSH 插件（package.json 格式） ──
const dshPlugins = [];
const dshDir = join(ROOT, 'plugins');
if (existsSync(dshDir)) {
  for (const name of readFileSync ? (await import('node:fs')).readdirSync(dshDir) : []) {
    const dir = join(dshDir, name);
    const pkg = join(dir, 'package.json');
    if (!existsSync(pkg)) continue;
    let p = {};
    try { p = JSON.parse(readFileSync(pkg, 'utf8')); } catch { p = {}; }
    const declared = declaredIfPatch(dir);
    dshPlugins.push({
      source: 'dsh',
      name,
      version: p.version || '',
      description: p.description || '',
      caps: Object.keys(p.dsh || p.contributes || {}),
      requires: [],
      manifestOk: true,
      errors: [],
      path: 'plugins/' + name,
      // 不再用「运行中」冒充已验证：只有「声明挂载」这一条可核实的事实
      wired: false,
      declared,
      wiredWhy: declared
        ? '声明挂载（cordis.patch.yml 存在）；本 checkout 无法验证 DSH 是否真的加载了它'
        : '没有 cordis.patch.yml —— 未声明挂载',
    });
  }
}

// ── 4) 拓扑排序：证明依赖解析是真的在跑 ──
let topo = null;
try {
  const manifests = kernelPlugins.filter((p) => p.manifestOk).map((p) => ({
    name: p.name, version: p.version, entry: 'index.mjs', caps: p.caps, requires: p.requires,
  }));
  // topoSort 返回 { ok, issues, order }，不是数组 —— 上一版我直接 .map() 导致报错
  const r = topoSort(manifests);
  topo = {
    ok: r.ok === true,
    issues: (r.issues || []).map((i) => i.message),
    order: (r.order || []).map((m) => (typeof m === 'string' ? m : m.name || pluginId(m))),
  };
} catch (e) {
  topo = '拓扑排序失败: ' + e.message;
}

// ── 4) 技能：hermes/optional-skills 下的真实目录 ──
const skills = [];
const trackedSet = trackedSkillFiles();
const skillRoot = join(ROOT, 'hermes/optional-skills');
if (existsSync(skillRoot)) {
  const { readdirSync } = await import('node:fs');
  // 结构是 optional-skills/<分类>/<技能>/ —— 两层，不是一层（上一版扫一层所以数到 0）
  for (const cat of readdirSync(skillRoot)) {
    const catDir = join(skillRoot, cat);
    let entries = [];
    try { entries = readdirSync(catDir, { withFileTypes: true }); } catch { continue; }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (files.includes('SKILL.md') || files.includes('README.md')) {
      // 分类目录自己就是一个技能
      skills.push({ name: cat, category: '(root)', path: 'hermes/optional-skills/' + cat });
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sd = join(catDir, e.name);
      let inner = [];
      try { inner = readdirSync(sd); } catch { continue; }
      if (inner.includes('SKILL.md') || inner.includes('README.md') || inner.includes('DESCRIPTION.md')) {
        // 【2026-11-17 独立审计抓到的假绿，已修】原来只数目录 = 「技能 138」，
        // 但一个目录存在不等于它是一个合法技能。现在用真 loader 校验 frontmatter。
        const skillMd = join(sd, 'SKILL.md');
        let valid = null;
        let issues = [];
        if (existsSync(skillMd)) {
          const v = validateSkill(e.name, readFileSync(skillMd, 'utf8'));
          valid = v.ok === true;
          issues = (v.issues || []).map((i) => i.code);
        }
        const relPath = 'hermes/optional-skills/' + cat + '/' + e.name;
        const mdRel = relPath + '/SKILL.md';
        skills.push({
          name: e.name,
          category: cat,
          path: relPath,
          hasSkillMd: existsSync(skillMd),
          valid,
          issues,
          // 【2026-11-17 修假绿】hermes/ 在 .gitignore 里，干净克隆没有这些技能。
          // 不能把外部参考资产算成我们的生态广度。
          tracked: trackedSet.has(mdRel),
        });
      }
    }
  }
}

const payload = {
  at: new Date().toISOString(),
  liveRun,
  kernelPlugins,
  dshPlugins,
  topo,
  skills,
  summary: {
    kernelDiscovered: kernelPlugins.length,
    kernelValid: kernelPlugins.filter((p) => p.manifestOk).length,
    kernelWired: kernelPlugins.filter((p) => p.wired).length,
    dshRunning: dshPlugins.filter((p) => p.wired).length,
    dshTotal: dshPlugins.length,
    skills: skills.length,
    skillsWithSkillMd: skills.filter((s) => s.hasSkillMd).length,
    skillsValid: skills.filter((s) => s.valid === true).length,
    skillsInvalid: skills.filter((s) => s.valid === false).length,
    // 本仓（git 追踪）与外部参考资产分开 —— 这两者不能混为一谈
    skillsTrackedValid: skills.filter((s) => s.valid === true && s.tracked).length,
    skillsExternalValid: skills.filter((s) => s.valid === true && !s.tracked).length,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('  ✓ 写出 → apps/vouch-web/src/web-ui/src/app/scenes/workbench/data/capabilities.json');
console.log('  kernel 插件：发现 ' + payload.summary.kernelDiscovered + '，清单有效 ' + payload.summary.kernelValid + '，已接线 ' + payload.summary.kernelWired);
for (const p of kernelPlugins) {
  console.log('    ' + (p.manifestOk ? '✓' : '✗') + ' ' + p.name.padEnd(16) + ' caps=' + JSON.stringify(p.caps) + ' requires=' + JSON.stringify(p.requires) + (p.wired ? '  [已接线]' : '  [未接线]'));
}
console.log('  DSH 插件：' + payload.summary.dshTotal + ' 个，运行中 ' + payload.summary.dshRunning);
for (const p of dshPlugins) console.log('    ' + (p.wired ? '●' : '○') + ' ' + p.name);
console.log('  拓扑排序：ok=' + topo.ok + ' 顺序=' + JSON.stringify(topo.order) + (topo.issues.length ? ' 问题=' + JSON.stringify(topo.issues) : ''));
console.log('  技能：目录 ' + payload.summary.skills + ' 个 · 有 SKILL.md ' + payload.summary.skillsWithSkillMd
  + ' · 校验通过 ' + payload.summary.skillsValid + ' · 校验失败 ' + payload.summary.skillsInvalid);
console.log('    其中 本仓(git 追踪) ' + payload.summary.skillsTrackedValid
  + ' · 外部参考资产(不在 git 里) ' + payload.summary.skillsExternalValid);
if (liveRun && !liveRun.error) {
  console.log('  真跑：内核 ' + (liveRun.kernelOk ? 'ok' : '失败') + ' · 拓扑 ' + JSON.stringify(liveRun.order));
  for (const x of liveRun.results || []) {
    console.log('    ' + (x.ok ? '✓' : '✗') + ' ' + x.plugin + (x.result && x.result.escapeAttempt ? '  越界尝试 → ' + x.result.escapeAttempt : '') + (x.error ? '  ' + x.error : ''));
  }
  if (liveRun.evidencePath) console.log('    证据 → ' + liveRun.evidencePath);
} else if (liveRun) {
  console.log('  真跑失败：' + liveRun.error);
}
