/**
 * 错误分类化 · 判据验证（批次 Z.4）
 *
 * 【要证明什么】
 *  ① 五类错误（网络/代理/DNS/超时/模型）都能被正确归到对应类别
 *  ② 每类都给出「下一步」（不是只换个标题）
 *  ③ 判不出来就返回 null —— 界面退回原文，不臆断类别
 *  ④ 原始错误串**原样保留**（不吞原文）
 *  ⑤ 优先级：代理/DNS 不能被吞成泛泛的「网络错误」（用户要采取的动作不同）
 *
 * 直接 import 界面那一份实现（`errorDiagnosis.ts`），不重写等价逻辑：
 * 改了分类规则/文案，这里立刻反映。
 *
 * 用法：node tools/agent/verify-error-diagnosis.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import {
  ERROR_CATEGORIES,
  diagnoseError,
} from '../../apps/vouch-web/src/web-ui/src/app/layout/errorDiagnosis.ts';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  错误分类化 · 判据验证（是哪一类 / 下一步做什么）');
console.log('  ' + '─'.repeat(72));

const cases = [
  ['network', 'TypeError: fetch failed'],
  ['network', 'connect ECONNREFUSED 127.0.0.1:47124'],
  ['network', 'WebSocket connection failed'],
  ['proxy', 'HTTP 407 Proxy Authentication Required'],
  ['dns', 'getaddrinfo ENOTFOUND api.example.com'],
  ['timeout', 'connect ETIMEDOUT 1.2.3.4:443'],
  ['model', 'request failed with status 401'],
  ['model', '429 Too Many Requests'],
  ['model', '{"error":{"code":"model_not_found"}}'],
];
for (const [expected, raw] of cases) {
  const d = diagnoseError(raw);
  t(`${expected} ← ${raw.slice(0, 40)}`, d && d.category === expected, d ? d.category : 'null');
}

// 每类都要有下一步 + 徽标 + 标题（防「新增类别漏文案」）
const samples = {
  network: 'fetch failed',
  proxy: 'proxy error 407',
  dns: 'ENOTFOUND x',
  timeout: 'ETIMEDOUT',
  model: 'context_length_exceeded',
};
for (const cat of ERROR_CATEGORIES) {
  const d = diagnoseError(samples[cat]);
  t(`★${cat} 给出了下一步（不是只换标题）`, Boolean(d && d.nextStep && d.nextStep.length > 4), d && d.nextStep);
  t(`★${cat} 徽标带符号+文字（不只靠颜色）`, Boolean(d && /\S+\s?\S+/.test(d.badge)), d && d.badge);
}

// 优先级：代理/DNS 不被吞成网络
t('★代理优先于网络（proxy + socket hang up → proxy）', diagnoseError('proxy error: socket hang up')?.category === 'proxy');
t('★DNS 优先于网络（fetch failed + ENOTFOUND → dns）', diagnoseError('fetch failed: getaddrinfo ENOTFOUND')?.category === 'dns');

// 原文保留
{
  const raw = 'connect ECONNREFUSED 127.0.0.1:47124 (宿主未启动)';
  const d = diagnoseError(raw);
  t('★原始错误串原样保留（不吞原文）', d && d.detail === raw, d && d.detail);
}

// 反例：不猜
t('★反例：普通提示 → null（界面显示原文，不硬套类别）', diagnoseError('这是一段普通提示') === null);
t('★反例：空串 → null', diagnoseError('') === null);
t('★反例：null/undefined → null', diagnoseError(null) === null && diagnoseError(undefined) === null);
t('★反例：裸数字不算状态码（「跑了 403 步」→ null）', diagnoseError('跑了 403 步') === null);
t('反例：正常用量文案不误判', diagnoseError('本次会话累计 1200 tokens') === null);

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 五类可判、每类有下一步、原文保留、判不出不臆断'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;
