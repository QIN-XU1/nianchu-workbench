#!/usr/bin/env node
/**
 * 场景加载器：把"放文件即新增场景"变成现实。
 *
 * 场景目录结构（scenes/<id>/）：
 *   scene.json   { id, name, desc, check?, dataDir? }
 *   check.mjs    实现 <check.mjs> <sceneId>；exit 0=通过，非0=失败且输出差异集合
 *   data/        该场景的数据（check 读取 $SEA_DATA_DIR）
 *
 * 发现规则：扫描 scenes/ 下每个含 scene.json 的目录。
 * 这意味着：**新增一个场景 = 建一个目录，不改任何代码。**
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const SCENES_ROOT = join(HERE, 'scenes');

/** 读取一个场景目录 */
function loadScene(dir) {
  const manifestPath = join(dir, 'scene.json');
  if (!existsSync(manifestPath)) return null;
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { error: `scene.json 不是合法 JSON：${String(e).slice(0, 80)}`, dir };
  }
  if (!m.id) return { error: 'scene.json 缺少 id', dir };

  const check = m.check ? join(dir, m.check) : join(dir, 'check.mjs');
  const dataDir = m.dataDir ? join(dir, m.dataDir) : join(dir, 'data');
  // baselineDir：干净基线（门禁用它证明 check 不是恒定失败）。
  // 没有时退回 data/ —— 但若 data/ 本身有问题，门禁会判"不可认证"。
  const baselineDir = m.baselineDir ? join(dir, m.baselineDir) : dataDir;

  const problems = [];
  if (!existsSync(check)) problems.push(`缺少 check 脚本：${check}`);
  if (!existsSync(dataDir)) problems.push(`缺少数据目录：${dataDir}`);

  // protects 是场景声明的「它保护哪些不变量」，门禁据此生成变异。
  // 没有声明的场景无法被门禁认证 —— 这是刻意的：不声明的检查不可信。
  const protects = Array.isArray(m.protects) ? m.protects : [];
  if (protects.length === 0) problems.push('scene.json 缺少 protects（未声明保护哪些不变量）');

  return {
    id: m.id,
    name: m.name || m.id,
    desc: m.desc || '',
    dir,
    check,
    dataDir,
    baselineDir,
    protects,
    error: problems.length ? problems.join('；') : undefined,
  };
}

/** 发现全部场景（按 id 排序；坏场景也返回，但带 error） */
export function discover(root = SCENES_ROOT) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch { continue; }
    const s = loadScene(dir);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 只返回健康的场景 */
export function healthy(root = SCENES_ROOT) {
  return discover(root).filter(s => !s.error);
}

/** CLI：node scene-loader.mjs —— 列出发现的场景 */
if (process.argv[1] && /scene-loader\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const all = discover();
  console.log(`发现 ${all.length} 个场景（${SCENES_ROOT}）`);
  for (const s of all) {
    console.log(s.error
      ? `  ✗ ${s.id.padEnd(20)} ${s.error}`
      : `  ✓ ${s.id.padEnd(20)} ${s.name}  ${s.desc}`);
  }
}
