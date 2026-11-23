/**
 * D4 多场景验证 —— 场景隔离记忆（含反例）。
 *
 * 【要证明什么】D4 判决看的不是「界面上有几个 tab」，而是**场景之间有没有隔离模型**。
 * 我们原来记忆是全局一个池子：场景 A 记的，场景 B 也能搜到 —— 那不叫多场景，叫多标签。
 *
 * 钉四条：
 *   ① 键空间：`scene.<id>.<key>` 能正确解析
 *   ② **隔离**：A 的条目在 B 的检索里**一条都不出现**（这是核心反例）
 *   ③ **同名不同值**：两个场景可以有同名 key，各自独立
 *   ④ 全局铁律（core.*）默认不注入，显式要才给
 *
 * 用法：node tools/agent/verify-scene-memory.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneIdOf, sceneKey, putScene, listScene, recallScene } from './scene-memory.mjs';
import { load as memLoad, save as memSave, put as memPut } from '../memory/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const STORE = join(REPO, 'evidence', 'memory', 'store.json');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  D4 多场景验证（场景隔离记忆）');
console.log('  ' + '─'.repeat(72));

// ══ 一、键空间（纯逻辑）══
{
  t('scene.<id>.<key> 能解析出场景 id', sceneIdOf('scene.vouch.deploy') === 'vouch');
  t('scene.<id>.<key> 能解析出场景 id（多级 key）',
    sceneIdOf('scene.bench.a.b.c') === 'bench');
  t('★反例：非场景键返回 null', sceneIdOf('core.rules') === null && sceneIdOf('random') === null);
  t('★反例：缺 id 或 key 返回 null',
    sceneIdOf('scene.') === null && sceneIdOf('scene.onlyid') === null);
  t('sceneKey 拼装正确', sceneKey('vouch', 'deploy') === 'scene.vouch.deploy');
  t('★反例：sceneKey 缺参抛错', (() => {
    try { sceneKey('', 'x'); return false; } catch { return true; }
  })());
}

// ══ 二、隔离（临时污染 → 断言 → 还原）══
{
  mkdirSync(dirname(STORE), { recursive: true });
  const backup = existsSync(STORE) ? readFileSync(STORE) : null;
  try {
    // 两个场景各写一条**同义**但不同值的记忆
    putScene('alpha', 'deploy.target', 'alpha 场景：部署到 47124');
    putScene('beta', 'deploy.target', 'beta 场景：部署到 9999');
    // 一个全局铁律
    const db = memLoad();
    memPut(db, { key: 'core.test.rule', value: '全局铁律：不许删库', source: 'verify', by: 'verify', onConflict: 'supersede' });
    memSave(db);

    const ra = recallScene('alpha', '部署到哪个端口');
    const rb = recallScene('beta', '部署到哪个端口');

    t('alpha 能搜到自己的条目', ra.hits.length > 0, JSON.stringify(ra.hits.map((h) => h.key)));
    t('beta 能搜到自己的条目', rb.hits.length > 0, JSON.stringify(rb.hits.map((h) => h.key)));

    t('★隔离：alpha 搜不到 beta 的值',
      ra.hits.every((h) => !String(h.value).includes('9999')), JSON.stringify(ra.hits));
    t('★隔离：beta 搜不到 alpha 的值',
      rb.hits.every((h) => !String(h.value).includes('47124')), JSON.stringify(rb.hits));

    t('★同名 key 在两个场景里独立（各拿各的值）',
      String(ra.hits[0]?.value).includes('47124') && String(rb.hits[0]?.value).includes('9999'),
      JSON.stringify({ a: ra.hits[0]?.value, b: rb.hits[0]?.value }));

    t('★默认不注入 core 全局铁律', ra.core.length === 0 && rb.core.length === 0);

    const raCore = recallScene('alpha', '全局铁律 删库', { includeCore: true });
    t('显式 includeCore 才给 core 条目', raCore.core.length > 0, JSON.stringify(raCore.core));

    // listScene 只列自己
    const la = listScene('alpha');
    const lb = listScene('beta');
    t('listScene(alpha) 只含 alpha 的键', la.every((x) => !String(x.key).includes('beta')));
    t('listScene 的 key 去掉了场景前缀（对调用方友好）',
      la.some((x) => x.key === 'deploy.target'), JSON.stringify(la.map((x) => x.key)));

    // 反例：不存在的场景
    const rz = recallScene('no-such-scene', '部署');
    t('★反例：不存在的场景 → 0 命中（不串到别的场景）', rz.hits.length === 0, JSON.stringify(rz.hits));
    t('★反例：空查询 → 0 命中', recallScene('alpha', '').hits.length === 0);

    // 反例：普通（非场景）键不会被场景检索带出来
    const db2 = memLoad();
    memPut(db2, { key: 'misc.only', value: '部署到 47124 但不是场景键', source: 'verify', by: 'verify', onConflict: 'supersede' });
    memSave(db2);
    const ra2 = recallScene('alpha', '部署到哪个端口');
    t('★反例：非场景键（misc.*）不会被场景检索带出',
      ra2.hits.every((h) => h.key !== 'misc.only'), JSON.stringify(ra2.hits.map((h) => h.key)));
  } finally {
    if (backup !== null) writeFileSync(STORE, backup);
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 场景之间真隔离：互相搜不到、同名 key 独立、全局铁律需显式索取'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;