/**
 * 上下文用量网格 · 数据契约验证
 *
 * 【要证明什么】
 *  ① 宿主返回的 `context` 里，`historyTokens` / `historyBudget` / `historyDropped`
 *     三个字段**真的存在且是数字** —— 界面靠它们画格子，改名不能让界面静默显示 0
 *  ② 用量**落盘**：appendMessage 之后 getSession 还能读回来（否则一刷新网格就消失）
 *  ③ 「最近一条带有效 context 的消息」这条取值规则，在缺字段/预算为 0 时**不返回假数据**
 *  ④ 预算语义：长历史被裁时 dropped > 0，且 tokens 不超过预算（单条超预算的极端除外）
 *
 * 关键：**直接 import 界面那一份实现**（`contextUsageView.ts`，Node 24 原生跑 .ts），
 * 不再重写一份等价逻辑 —— 重写只证明「我抄得对」，证明不了「界面用的是这个」。
 * 字段名一改，这里立刻红。
 *
 * 用法：node tools/agent/verify-context-usage.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { randomUUID } from 'node:crypto';
import { buildHistory } from './context.mjs';
import { appendMessage, getSession, deleteSession } from './runtime.mjs';
import {
  buildContextUsageView,
  CTX_CELLS,
  formatDropped,
  MEMORY_VIEW_MAX,
  resolveContextUsage,
  resolveMemoryView,
} from '../../apps/vouch-web/src/web-ui/src/app/layout/contextUsageView.ts';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  上下文用量 · 数据契约验证');
console.log('  ' + '─'.repeat(72));

// ══ 一、预算语义（buildHistory）══
{
  const long = [];
  for (let i = 0; i < 80; i++) {
    long.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '第' + i + '条' + 'x'.repeat(60) });
  }
  const win = buildHistory(long, { maxTurns: 40, maxTokens: 900 });
  t('长历史被裁剪（dropped > 0）', win.dropped > 0, String(win.dropped));
  t('裁剪后 tokens 不超过预算', win.tokens <= 900, String(win.tokens));
  t('elided 与 dropped 一致（省略有标记）', win.elided === (win.dropped > 0));

  const small = buildHistory([{ role: 'user', content: '你好' }], { maxTokens: 900 });
  t('短历史不裁剪、dropped=0', small.dropped === 0 && small.tokens > 0);
}

// ══ 二、落盘往返（界面重载后还能显示）══
{
  const sid = 'verify-ctx-' + randomUUID().slice(0, 8);
  try {
    appendMessage(sid, { role: 'meta', type: 'session-created', sessionName: 'verify' });
    appendMessage(sid, {
      role: 'assistant', content: '第一轮', model: 'm1',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      context: {
        historyTokens: 1234, historyBudget: 6000, historyDropped: 7,
        memoryHits: 2,
        memoryHitItems: [{ key: 'deploy.port', preview: '127.0.0.1:47124' }, { key: 'build.cmd', preview: 'vite build' }],
      },
    });
    appendMessage(sid, {
      role: 'assistant', content: '第二轮', model: 'm1',
      context: { historyTokens: 2400, historyBudget: 6000, historyDropped: 0, memoryHits: 0 },
    });

    const back = getSession(sid);
    t('getSession 能读回会话', back.state === 'PASS' && back.messages.length === 3, String(back.messages.length));

    const assistant = back.messages.filter((m) => m.role === 'assistant');
    t('★context 落盘了（不是内存态）', assistant.length === 2 && Boolean(assistant[0].context),
      JSON.stringify(assistant[0] && assistant[0].context));
    t('★三个字段都是数字（界面靠名字取值）',
      typeof assistant[0].context.historyTokens === 'number'
      && typeof assistant[0].context.historyBudget === 'number'
      && typeof assistant[0].context.historyDropped === 'number');

    // ── 用界面真实实现求值 ──
    const u = resolveContextUsage(back.messages);
    t('★取到的是**最近**一轮（2400 而不是 1234）', u && u.tokens === 2400, String(u && u.tokens));
    t('最近一轮没有省略时 dropped=0', u && u.dropped === 0, String(u && u.dropped));

    const view = buildContextUsageView(u);
    t('网格点亮数与比例一致（2400/6000 = 40% → 8 格）',
      view && view.lit === 8, String(view && view.lit));
    t('40% 落在「宽裕」档', view && view.level === 'ok', String(view && view.level));

    // 反例：缺字段 / 预算为 0 必须被跳过
    t('★反例：没有 context 的消息 → null（不显示假进度条）',
      resolveContextUsage([{ role: 'assistant', content: 'x' }]) === null);

    t('★反例：预算为 0 → null（除零/空条都不显示）',
      resolveContextUsage([{ context: { historyTokens: 5, historyBudget: 0 } }]) === null);

    t('★反例：缺 historyTokens → null（不把 undefined 当 0）',
      resolveContextUsage([{ context: { historyBudget: 6000 } }]) === null);

    const neg = resolveContextUsage([{ context: { historyTokens: 10, historyBudget: 6000, historyDropped: -3 } }]);
    t('historyDropped 为负时钳到 0（不显示「省略 -3 条」）', neg.dropped === 0, String(neg.dropped));

    // 阈值边界（产品规则，改常量会红）
    const lv = (tok) => buildContextUsageView({ tokens: tok, budget: 1000, dropped: 0 }).level;
    t('阈值 70% 起转 warn', lv(699) === 'ok' && lv(700) === 'warn');
    t('阈值 90% 起转 danger', lv(899) === 'warn' && lv(900) === 'danger');
    t('超预算只亮满格、不越界', buildContextUsageView({ tokens: 9999, budget: 1000, dropped: 0 }).lit === CTX_CELLS);
    t('省略文案只在 dropped>0 时出现', formatDropped(0) === '' && formatDropped(7).includes('7'));

    // ── 记忆命中：明细也落盘，且界面解析不吞数据（批次 Z.3）──
    const memStored = assistant[0].context.memoryHitItems;
    t('★memoryHitItems 落盘了（不是只有数量）',
      Array.isArray(memStored) && memStored.length === 2, JSON.stringify(memStored));
    const mv = resolveMemoryView([assistant[0]]);
    t('★界面能解析出命中的 key + 预览',
      Boolean(mv) && mv.count === 2 && mv.items.length === 2 && mv.items[0].key === 'deploy.port',
      JSON.stringify(mv));
    t('最近一轮 memoryHits=0 → count=0（界面据此隐藏）',
      (resolveMemoryView([assistant[1]]) || {}).count === 0);
    t('★反例：没有 context → null（不渲染假面板）',
      resolveMemoryView([{ role: 'assistant', content: 'x' }]) === null);
    const trunc = resolveMemoryView([{ context: { memoryHits: 9, memoryHitItems: [{ key: 'a', preview: '' }] } }]);
    t('★count 远大于明细 → truncated=true（如实说还有没展开的）',
      trunc.count === 9 && trunc.truncated === true && trunc.items.length === 1);
    const capMany = Array.from({ length: 10 }, (_, i) => ({ key: 'k' + i, preview: '' }));
    t('明细超过上限只留 ' + MEMORY_VIEW_MAX + ' 条',
      resolveMemoryView([{ context: { memoryHits: 10, memoryHitItems: capMany } }]).items.length === MEMORY_VIEW_MAX);
  } finally {
    deleteSession(sid);
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 用量落盘可读回、字段名与界面一致、缺数据时不显示假进度'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;
