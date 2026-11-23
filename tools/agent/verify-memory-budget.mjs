/**
 * 记忆分层与预算验证 —— 含反例。
 *
 * 【为什么认真做这个】记忆一旦没有预算，就会变成「只增不减的垃圾桶」：
 *   每轮注入越来越长、token 越来越贵、模型越来越糊涂。
 * 要证明的不是「有分层」，而是：**超预算时真的少注入，且信息没被删**。
 *
 * 用法：node tools/agent/verify-memory-budget.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCOPES, scopeOf, usageOf, usageAll, planInjection, enforceBudget, checkHandoff,
} from './memory-budget.mjs';
import { load as memLoad, save as memSave, put as memPut } from '../memory/store.mjs';
import { assembleMessages } from './context.mjs';

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
console.log('  记忆分层与预算验证');
console.log('  ' + '─'.repeat(72));

// ══ 一、作用域映射（纯函数）══
{
  t('core.* → core', scopeOf('core.rules') === 'core');
  t('scene.* → scene', scopeOf('scene.handoff') === 'scene');
  t('project.* → project', scopeOf('project.p1.status') === 'project');
  t('其它 → misc', scopeOf('random.key') === 'misc' && scopeOf('') === 'misc');
  t('预算表齐全（core/scene/project/misc）',
    ['core', 'scene', 'project', 'misc'].every((s) => SCOPES[s] && SCOPES[s].cap > 0));
}

// ══ 二、预算、裁剪、闸门（临时污染 → 断言 → 还原）══
{
  mkdirSync(dirname(STORE), { recursive: true });
  const backup = existsSync(STORE) ? readFileSync(STORE) : null;
  try {
    const db = memLoad();
    const put = (k, v) => memPut(db, { key: k, value: v, source: 'verify', by: 'verify', onConflict: 'supersede' });

    // core 塞到超预算（2KB）
    for (let i = 0; i < 12; i++) put('core.rule' + i, '铁律' + i + '：' + 'x'.repeat(300));
    // scene 放一个合规交接
    put('scene.handoff', '结论：已修完 A6 记忆分层。下一步：补 handoff 闸门验证。卡点：无。');

    const uCore = usageOf(db, 'core');
    t('core 用量超过预算', uCore.over === true, uCore.chars + '/' + uCore.cap);

    const plan = planInjection(db, 'core');
    t('★超预算时只注入一部分（skipped > 0）', plan.skipped > 0 && plan.over === true,
      JSON.stringify({ inj: plan.injected.length, skip: plan.skipped }));
    t('★注入量不超预算', plan.chars <= plan.cap, plan.chars + '/' + plan.cap);

    const before = db.entries.length;
    const enforced = enforceBudget(db, 'core');
    t('enforceBudget 有实际改动', enforced.changed > 0, String(enforced.changed));
    t('★裁剪**不删除**条目（信息还在）', db.entries.length === before,
      before + ' → ' + db.entries.length);
    t('★被裁的条目打了 outOfBudget 标记',
      db.entries.some((e) => e.outOfBudget === true));
    t('裁剪后再算用量回到预算内（按注入集）',
      planInjection(db, 'core').chars <= SCOPES.core.cap);

    // 闸门：交接齐全 → 但 core 超预算 → 仍不通过
    const h1 = checkHandoff(db);
    t('★core 超预算时闸门不放行（不过不许换）', h1.ok === false
      && h1.problems.some((p) => /core 层超预算/.test(p)), JSON.stringify(h1.problems));

    // 把 core 修到预算内 → 闸门应通过
    for (const e of db.entries) if (scopeOf(e.key) === 'core') memPut(db, { key: e.key, value: '短', source: 'verify', by: 'verify', onConflict: 'supersede' });
    const h2 = checkHandoff(db);
    t('core 合规 + 交接齐全 → 闸门通过', h2.ok === true, JSON.stringify(h2.problems));

    // 反例：没有交接
    const db2 = memLoad();
    for (const e of [...db2.entries]) if (e.key === 'scene.handoff') db2.entries.splice(db2.entries.indexOf(e), 1);
    const h3 = checkHandoff(db2);
    t('★反例：缺 scene.handoff → 闸门拒绝', h3.ok === false
      && h3.problems.some((p) => /缺少 scene.handoff/.test(p)), JSON.stringify(h3.problems));

    // 反例：交接没写「下一步」
    memPut(db2, { key: 'scene.handoff', value: '结论：都做完了。', source: 'verify', by: 'verify', onConflict: 'supersede' });
    const h4 = checkHandoff(db2);
    t('★反例：交接没写「下一步」→ 闸门拒绝', h4.ok === false
      && h4.problems.some((p) => /没写「下一步」/.test(p)), JSON.stringify(h4.problems));

    // 反例：交接超 scene 预算
    memPut(db2, { key: 'scene.handoff', value: '下一步：' + 'y'.repeat(SCOPES.scene.cap + 100), source: 'verify', by: 'verify', onConflict: 'supersede' });
    const h5 = checkHandoff(db2);
    t('★反例：交接超预算 → 闸门拒绝', h5.ok === false
      && h5.problems.some((p) => /超预算/.test(p)), JSON.stringify(h5.problems));

    // 装配：core 超预算时不把全部 core 塞进去
    memSave(db);
    const asm = assembleMessages({
      systemPrompt: '你是念初。', messages: [{ role: 'user', content: '随便问' }], userText: '随便问', memory: true,
    });
    t('装配结果带 memoryInjection 诊断', Boolean(asm.memoryInjection),
      JSON.stringify(asm.memoryInjection));
    t('★装配时 core 注入量受预算限制',
      asm.memoryInjection.coreChars <= SCOPES.core.cap,
      JSON.stringify(asm.memoryInjection));

    // usageAll 覆盖四层
    const all = usageAll(db);
    t('usageAll 返回 4 个作用域', all.length === 4 && all.every((r) => typeof r.chars === 'number'));
  } finally {
    if (backup !== null) writeFileSync(STORE, backup);
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 超预算少注入不丢信息；换会话闸门对缺交接/超预算都拒绝'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;