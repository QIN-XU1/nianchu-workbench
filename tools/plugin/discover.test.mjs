#!/usr/bin/env node
/**
 * discover 的反例测试。
 *
 * 纪律：每个新主张都要配「应当失败的反例」——
 * 如果反例不报，说明这个检查是假的。
 *
 * 这里验 5 件事，每件都配一个**必须失败**的构造：
 *   1. 嵌套命名空间能被发现        反例：把 maxDepth 调小 → 必须找不到
 *   2. 深度上限是真的              反例：插件放在超深目录 → 必须找不到
 *   3. 坏清单不会被静默丢弃        反例：写坏 JSON → 必须返回 raw:null 而不是消失
 *   4. node_modules 不被扫描        反例：node_modules 里放假插件 → 必须找不到
 *   5. 单层旧行为不回归            反例：老调用方式仍然能找到 builtin
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from './kernel.mjs';

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

const root = mkdtempSync(join(tmpdir(), 'disc-'));

const mkPlugin = (rel, name) => {
  const d = join(root, rel);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', entry: 'index.mjs', caps: [], requires: [] }));
};

try {
  // 构造：扁平 1 个 + 嵌套命名空间 1 个 + 超深 1 个 + 坏清单 1 个 + node_modules 里 1 个
  mkPlugin('flat', 'flat-plugin');
  mkPlugin('ns/team/deep', 'nested-plugin');
  mkPlugin('a/b/c/d/e/f/g', 'too-deep-plugin');
  mkdirSync(join(root, 'broken'), { recursive: true });
  writeFileSync(join(root, 'broken', 'plugin.json'), '{ this is not json');
  mkPlugin('node_modules/evil', 'should-not-be-found');

  // 1) 嵌套能被发现
  const r3 = discover(root, { maxDepth: 3 });
  const names3 = r3.map((x) => (x.raw && x.raw.name) || 'BAD');
  t('嵌套命名空间被发现（ns/team/deep）', names3.includes('nested-plugin'), JSON.stringify(names3));
  t('扁平插件被发现（flat）', names3.includes('flat-plugin'), JSON.stringify(names3));

  // 1-反例：maxDepth 调到 1 → 嵌套那个必须找不到
  const r1 = discover(root, { maxDepth: 1 });
  const names1 = r1.map((x) => (x.raw && x.raw.name) || 'BAD');
  t('反例：maxDepth=1 时嵌套插件找不到（证明深度参数真的生效）',
    !names1.includes('nested-plugin') && names1.includes('flat-plugin'), JSON.stringify(names1));

  // 2) 深度上限是真的
  t('反例：超深目录（7 层）默认找不到（证明上限不是摆设）',
    !names3.includes('too-deep-plugin'), JSON.stringify(names3));

  // 3) 坏清单不被静默丢弃
  const broken = r3.find((x) => x.path.includes('broken'));
  t('坏清单返回 raw:null 而不是消失（能被上层报错）',
    Boolean(broken) && broken.raw === null, JSON.stringify(broken));

  // 4) node_modules 不被扫描
  t('反例：node_modules 里的假插件找不到',
    !names3.includes('should-not-be-found'), JSON.stringify(names3));

  // 5) 单层旧行为不回归
  const builtin = discover('tools/plugin/builtin');
  const bn = builtin.map((x) => x.raw && x.raw.name);
  t('老调用方式仍能找到 2 个 builtin（无回归）',
    builtin.length === 2 && bn.includes('probe-audit') && bn.includes('probe-reader'), JSON.stringify(bn));

  // 6) 不存在的目录返回空数组而不是抛
  let threw = false;
  let empty = null;
  try { empty = discover(join(root, '__nope__')); } catch { threw = true; }
  t('不存在的目录返回 [] 且不抛', !threw && Array.isArray(empty) && empty.length === 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('  discover 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
