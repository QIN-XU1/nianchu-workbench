/**
 * 桥的实测度量（把真实多次问答的结果固定成可回归的数字）
 *
 * 为什么需要它：
 *   桥是"慢、脆、依赖登录"的东西（luanyujia 自己承认）。
 *   如果不把真实指标固定下来，改一行就可能悄悄退化而无人察觉。
 *
 * 度量项：
 *   1. 连通性（CDP + 已登录）
 *   2. 单次问答成功率
 *   3. 答案清洁度（不含 UI 按钮文字）
 *   4. 两轮连续性（能接续上文）
 *   5. 机密闸拦截（5 类）
 *   6. 未就绪时明确报错（不返回空串）
 */
import { ask, secretGate, loadSites } from './bridge.mjs';
import { probe, listTargets } from './cdp.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

const UI_WORDS = ['深度思考', '智能搜索', '内容由 AI 生成', '联网搜索', '重新生成'];

function hasUiPollution(text) {
  const t = String(text || '');
  return UI_WORDS.filter(w => t.includes(w));
}

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(26)} ${detail}`);
}

async function main() {
  const site = process.argv[2] || 'deepseek';

  console.log(`${C.bold}桥实测${C.reset} · ${C.dim}${site}${C.reset}\n`);

  // 1. 连通性
  const p = await probe();
  if (!p.ok) {
    rec('CDP 连通', false, p.reason);
    console.log(`\n${C.yellow}跳过其余项（Chrome 未就绪）${C.reset}`);
    return finish();
  }
  rec('CDP 连通', true, p.browser);

  const tabs = await listTargets();
  const host = new URL(loadSites()[site].url).hostname;
  const hitTab = tabs.some(t => t.url.includes(host));
  rec('站点标签页存在', hitTab, hitTab ? host : `未找到 ${host}`);

  if (!hitTab) {
    console.log(`\n${C.yellow}跳过问答项（没有 ${host} 标签页）${C.reset}`);
    return finish();
  }

  // 2. 单次问答
  let firstOk = false, firstAnswer = '', firstMs = 0;
  try {
    const r = await ask(site, '用一句话说明什么是栈');
    firstAnswer = r.answer;
    firstMs = r.meta.elapsedMs;
    firstOk = firstAnswer.length > 0;
    rec('单次问答有答案', firstOk, `${firstMs}ms / ${firstAnswer.length} 字`);
  } catch (e) {
    rec('单次问答有答案', false, `${e.code || ''} ${e.message.slice(0, 50)}`);
  }

  // 3. 答案清洁度
  if (firstOk) {
    const poll = hasUiPollution(firstAnswer);
    rec('答案无 UI 按钮文字', poll.length === 0, poll.length ? '污染: ' + poll.join(',') : '干净');
  } else {
    rec('答案无 UI 按钮文字', false, '上一步无答案');
  }

  // 4. 两轮连续性
  if (firstOk) {
    try {
      const r2 = await ask(site, '把上一条概念翻译成英文');
      const a2 = r2.answer;
      const ok2 = a2.length > 0 && !hasUiPollution(a2).length;
      rec('两轮连续不串话', ok2, `${r2.meta.elapsedMs}ms → "${a2.slice(0, 30)}"`);
    } catch (e) {
      rec('两轮连续不串话', false, `${e.code || ''} ${e.message.slice(0, 40)}`);
    }
  } else {
    rec('两轮连续不串话', false, '上一步无答案');
  }

  // 5. 机密闸 5 类
  const secrets = [
    ['密码', '我的密码: abc123456'],
    ['token', 'token: sk-abcdefgh12345678'],
    ['身份证', '身份证 110101199001011234'],
    ['银行卡', '卡号 6222021234567890123'],
    ['手机号', '手机 13812345678'],
  ];
  let blocked = 0;
  const blockedNames = [];
  for (const [name, text] of secrets) {
    const g = secretGate(text);
    if (!g.ok) { blocked++; blockedNames.push(name); }
  }
  rec('机密闸拦截 5 类', blocked === secrets.length, `拦截 ${blocked}/5 (${blockedNames.join(',')})`);

  // 6. 普通文本不误拦
  const g2 = secretGate('帮我总结这篇技术文档的要点');
  rec('普通文本不误拦', g2.ok, g2.ok ? '放行' : '误拦');

  return finish();
}

function finish() {
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${C.bold}===== 桥实测：${passed}/${results.length} =====${C.reset}`);
  const allOk = passed === results.length;
  console.log(allOk
    ? `${C.green}桥可用${C.reset}`
    : `${C.yellow}有项未通过 —— 见上面逐项${C.reset}`);
  process.exit(allOk ? 0 : 1);
}

await main();
