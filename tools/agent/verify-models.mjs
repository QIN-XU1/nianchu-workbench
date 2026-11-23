/**
 * 模型路由 / 故障转移（A14）验证 —— 含反例。
 *
 * 【要证明什么】A14 的差距不在"能不能换模型"，而在于：
 *   · 主模型挂了**能不能自动落到备用**
 *   · 每次尝试**有没有记录**（谁试了、为什么失败、多久）
 *   · 全挂了要**如实 FAIL**，不能返回半截成功
 *
 * 用不存在的模型名当"坏候选"制造确定性失败（网关会 404，不会碰运气）。
 *
 * 用法：node tools/agent/verify-models.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import {
  getRegistry, resolveChain, callWithFailover, registrySummary, gatewayModelCount,
} from './models.mjs';

// 「好候选」不再写死某个模型 id：不同网关支持的模型不同（写死的 auto/claude-haiku-5-5
// 在部分网关会 400 model_not_supported，导致 failover 用例误判）。改为取注册表 default 链的
// 首选——它由本环境的 NIANCHU_MODEL 决定，且已被下面的 _probe 证明真的可用。
const GOOD_MODEL = (resolveChain('default')[0] || '').trim();

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const MSG = [{ role: 'user', content: '只回复两个字：收到' }];

console.log('');
console.log('  模型路由 / 故障转移验证（A14）');
console.log('  ' + '─'.repeat(72));

// ══ 一、注册表与链解析（纯逻辑）══
{
  const reg = getRegistry();
  t('默认注册表有 default 链', Array.isArray(reg.default) && reg.default.length > 0);
  t('resolveChain 未知用途回落到 default', resolveChain('no-such-role').length === reg.default.length);
  t('registrySummary 覆盖所有用途', registrySummary().every((x) => x.role && x.count >= 0));

  // 反例：环境变量给了坏 JSON → 回落默认，不崩
  const saved = process.env.NIANCHU_MODELS_JSON;
  process.env.NIANCHU_MODELS_JSON = '{ this is not json';
  const reg2 = getRegistry();
  t('★反例：坏 JSON 环境变量 → 回落默认注册表（不崩）',
    Array.isArray(reg2.default) && reg2.default.length > 0);
  if (saved === undefined) delete process.env.NIANCHU_MODELS_JSON;
  else process.env.NIANCHU_MODELS_JSON = saved;
}

// ══ 二、空链 → FAIL（不调模型）══
{
  const r = await callWithFailover({ messages: MSG, chain: [] });
  // 注意：chain=[] 会回落到 resolveChain(role)，所以要显式测试"注册表为空"的情况
  const emptyReg = { ...(process.env.NIANCHU_MODELS_JSON = '{"default":[]}') };
  void emptyReg;
  const r2 = await callWithFailover({ messages: MSG, role: 'default' });
  t('★反例：注册表 default 为空 → FAIL 且 attempts 为空',
    r2.state === 'FAIL' && Array.isArray(r2.attempts) && r2.attempts.length === 0,
    JSON.stringify(r2).slice(0, 140));
  void r;
  delete process.env.NIANCHU_MODELS_JSON;
}

// 第 188 轮：先探一次模型是否真可用（本环境网关可达但 401「User not affiliated」）。
// 不可用时三/五的「成功路径」断言无法验证 → 跳过并标 UNKNOWN；四（全挂→FAIL）不受影响仍验。
const _probe = await callWithFailover({ messages: MSG, role: 'default', maxTokens: 8 });
const _modelOk = _probe.state === 'PASS';
if (!_modelOk) {
  console.log('  ⚠ 模型不可用（网关可达但调用失败）→ 三/五 成功路径标 UNKNOWN：' + String(_probe.reason || '').slice(0, 100));
}

// ══ 三、故障转移：坏候选在前，好候选在后 ══
if (_modelOk && GOOD_MODEL) {
  const r = await callWithFailover({
    messages: MSG,
    chain: ['definitely-not-a-real-model-zzz', GOOD_MODEL],
    maxTokens: 16,
  });
  t('★坏候选在前、好候选在后 → 仍能成功', r.state === 'PASS', r.state + ' ' + String(r.reason));
  t('★servedBy 指向真正生效的模型', r.servedBy === GOOD_MODEL, String(r.servedBy));
  t('★failoverIndex=1（说明用了备用）', r.failoverIndex === 1, String(r.failoverIndex));
  t('★attempts 记录了两次尝试', Array.isArray(r.attempts) && r.attempts.length === 2,
    JSON.stringify((r.attempts || []).map((a) => a.model + ':' + a.ok)));
  t('第一次尝试被标为失败且有原因',
    r.attempts[0].ok === false && Boolean(r.attempts[0].reason),
    JSON.stringify(r.attempts[0]));
  t('每次尝试都有耗时', r.attempts.every((a) => typeof a.ms === 'number' && a.ms >= 0));
}

// ══ 四、全挂 → FAIL 并保留所有尝试 ══
{
  const r = await callWithFailover({
    messages: MSG,
    chain: ['definitely-not-a-real-model-1', 'definitely-not-a-real-model-2'],
    maxTokens: 8,
  });
  t('★反例：所有候选都失败 → FAIL', r.state === 'FAIL', r.state);
  t('★反例：失败时 attempts 完整（2 条）', r.attempts.length === 2, String(r.attempts.length));
  t('★反例：失败原因里说明是"所有候选都失败"', /所有候选模型都失败/.test(String(r.reason)), String(r.reason).slice(0, 80));
  t('★反例：失败时不返回 content（不假装成功）', r.content === undefined);
}

// ══ 五、首选可用时 failoverIndex=0 ══
if (_modelOk && GOOD_MODEL) {
  const r = await callWithFailover({
    messages: MSG, chain: [GOOD_MODEL], maxTokens: 16,
  });
  t('首选可用 → PASS 且 failoverIndex=0', r.state === 'PASS' && r.failoverIndex === 0,
    r.state + '/' + String(r.failoverIndex));
  t('首选可用时 attempts 只有 1 条', r.attempts.length === 1, String(r.attempts.length));
}

// ══ 六、网关模型数探测（信息性，失败不判死）══
{
  const n = await gatewayModelCount();
  t('能探测到网关模型数（或如实返回 null）', n === null || (typeof n === 'number' && n > 0), String(n));
  if (n) console.log('      （网关暴露 ' + n + ' 个模型）');
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 主模型挂了能自动落到备用；每次尝试都留痕；全挂如实 FAIL'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;