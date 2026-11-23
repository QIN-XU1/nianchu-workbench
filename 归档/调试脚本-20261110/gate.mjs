#!/usr/bin/env node
/**
 * sea 门禁（Gate）：判断一个 DoneSpec check 是否**值得信任**。
 *
 * 为什么需要它（两篇论文的实证）：
 *   arXiv:2607.24300 —— Agent 同时控制"被优化对象"和"验证器"时，自评接近满分而真实性能下降。
 *   arXiv:2607.13083 —— Agent 会**幻觉出不存在的失败**，并去修它。
 *
 * 关键设计：**变异由门禁生成，不由提案者提供**，且变异分两类：
 *   strict   —— 破坏核心不变量，任何合格 check 都必须捕获（计入 G2）
 *   advisory —— 不一定违反业务规则，check 不捕获也不算错（不计入 G2）
 * 这样既抓漏报，又不误杀正确 check。
 *
 * 三道门（全过才 ACCEPT）：
 *   G1 基线通过        —— 无变异时必须 exit 0
 *   G2 strict 变异全捕获 —— 每个 strict 变异都必须 exit ≠ 0
 *   G3 失败带差异集合  —— 每次失败必须输出「差异集合」
 *
 * 用法：
 *   node gate.mjs validate <check.mjs> <sceneId> [--root <dir>]
 *   node gate.mjs selfcheck [--root <dir>]
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { discover, healthy } from './scene-loader.mjs';
import { mutationsFor, unknownInvariants } from './mutations.mjs';
import { checkFloor } from './invariant-floor.mjs';

const HERE = import.meta.dirname;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

function argAfter(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ROOT = argAfter('--root', join(HERE, 'scenes'));

function materialize(scene, mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'sea-gate-'));
  cpSync(scene.dataDir, dir, { recursive: true });
  if (mutate) mutate(dir);
  return dir;
}

function runCandidate(checkPath, sceneId, dataDir) {
  try {
    const out = execFileSync('node', [checkPath, sceneId], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SEA_DATA_DIR: dataDir },
    });
    return { code: 0, out: out.replace(/\x1b\[[0-9;]*m/g, '') };
  } catch (e) {
    const raw = ((e.stdout || '') + (e.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
    return { code: e.status ?? 1, out: raw };
  }
}

export function validate(checkPath, scene) {
  const report = { scene: scene.id, checkPath, gates: {}, mutations: [], verdict: 'REJECT', reasons: [] };

  if (!existsSync(checkPath)) {
    report.reasons.push(`候选 check 不存在：${checkPath}`);
    return report;
  }

  // ---- G0：场景必须声明可被门禁理解的不变量 ----
  if (!Array.isArray(scene.protects) || scene.protects.length === 0) {
    report.gates.G0_declares_invariants = false;
    report.reasons.push('G0 失败：场景未声明 protects —— 无法生成变异，检查不可认证');
    return report;
  }
  const unknown = unknownInvariants(scene.protects);
  if (unknown.length > 0) {
    report.gates.G0_declares_invariants = false;
    report.reasons.push(`G0 失败：门禁不认识这些不变量：${unknown.join(', ')}`);
    return report;
  }
  report.gates.G0_declares_invariants = true;

  // ---- G0.5：声明必须达到下限（防止"只声明最容易的不变量"）----
  const floor = checkFloor(scene);
  report.gates.G0_5_meets_floor = floor.ok;
  if (!floor.ok) {
    report.reasons.push(
      'G0.5 失败：不变量声明过弱 —— ' +
      floor.missing.map(m => m.invariant + (m.reason ? '(' + m.reason + ')' : '')).join('；')
    );
    return report;
  }

  // ---- G1 基线（用干净基线，证明 check 不是恒定失败）----
  const cleanScene = { ...scene, dataDir: scene.baselineDir || scene.dataDir };
  const baseDir = materialize(cleanScene, null);
  const base = runCandidate(checkPath, scene.id, baseDir);
  rmSync(baseDir, { recursive: true, force: true });
  const g1 = base.code === 0;
  report.gates.G1_baseline_pass = g1;
  if (!g1) report.reasons.push(`G1 失败：基线数据上就报错（exit ${base.code}）—— 恒定失败`);

  // ---- 变异（仅由已声明的不变量生成）----
  const plan = mutationsFor(scene.baselineDir || scene.dataDir, scene.protects);
  let caught = 0, withDiff = 0;

  for (const m of plan) {
    const dir = materialize(scene, m.apply);
    const r = runCandidate(checkPath, scene.id, dir);
    rmSync(dir, { recursive: true, force: true });

    const failed = r.code !== 0;
    const hasDiff = /差异集合/.test(r.out);
    if (failed) caught++;
    if (failed && hasDiff) withDiff++;
    report.mutations.push({ invariant: m.invariant, name: m.name, failed, hasDiff });
  }

  const total = plan.length;
  report.gates.G2_all_mutations_caught = total > 0 && caught === total;
  report.gates.G3_all_failures_have_diffset = total > 0 && withDiff === total;
  report.caught = `${caught}/${total}`;

  if (total === 0) {
    report.reasons.push('G2 失败：声明的不变量无法生成任何变异 —— 检查无法被验证');
  } else {
    if (!report.gates.G2_all_mutations_caught) {
      report.reasons.push(`G2 失败：只捕获 ${caught}/${total} 个违反已声明不变量的变异 —— 会漏报`);
    }
    if (!report.gates.G3_all_failures_have_diffset) {
      report.reasons.push(`G3 失败：${withDiff}/${total} 次失败给出了差异集合`);
    }
  }

  if (g1 && report.gates.G0_5_meets_floor && report.gates.G2_all_mutations_caught && report.gates.G3_all_failures_have_diffset) {
    report.verdict = 'ACCEPT';
  }
  return report;
}

// CLI 已移到 gate-cli.mjs（避免「库 vs 入口」的路径判定问题）
