/**
 * 上下文装配验证 —— 有界历史窗口 + 跨会话记忆召回，含反例。
 *
 * 【要证明什么】
 *  ① 长会话**一定**被裁剪，而且裁掉的部分**显式标注**（不静默丢）
 *  ② 保留的是**最近**的消息（别把最新一问裁掉、留一堆陈年旧事）
 *  ③ token 预算真的生效（不是"看起来裁了"）
 *  ④ 记忆召回按相关性：相关能搜到，无关不硬塞，空查询不倾倒整库
 *  ⑤ 关掉 memory 就不注入
 *
 * 故意做两条反向判据：无关查询必须 0 命中；memory:false 必须无记忆块。
 *
 * 用法：node tools/agent/verify-context.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, buildHistory, recallMemory, assembleMessages } from './context.mjs';
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
console.log('  上下文装配验证（历史窗口 + 记忆召回）');
console.log('  ' + '─'.repeat(72));

// ══ 一、token 估算 ══
{
  t('estimateTokens: 空 → 0', estimateTokens('') === 0 && estimateTokens(null) === 0);
  t('estimateTokens: 中文比英文"贵"（同字符数下更大）',
    estimateTokens('中文十个字符测试') > estimateTokens('abcdefgh'));
}

// ══ 二、历史窗口 ══
{
  const short = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你' },
  ];
  const w1 = buildHistory(short);
  t('短历史不裁剪、无省略标记', w1.dropped === 0 && w1.elided === false && w1.history.length === 2);

  // 造 60 条长历史
  const long = [];
  for (let i = 0; i < 60; i++) {
    long.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '第' + i + '条消息内容' + 'x'.repeat(40) });
  }
  const w2 = buildHistory(long, { maxTurns: 5, maxTokens: 800 });
  t('★长历史被裁剪（dropped > 0）', w2.dropped > 0, String(w2.dropped));
  t('★裁掉的部分有**显式标注**（含"未纳入本次上下文"）',
    w2.history.length > 0 && /未纳入本次上下文/.test(String(w2.history[0].content)),
    String(w2.history[0] && w2.history[0].content).slice(0, 60));
  t('★保留的是**最近**的消息（最后一条在）',
    w2.history[w2.history.length - 1].content.includes('第59条'), '');
  t('★最早的那条已不在', !w2.history.some((m) => m.content.includes('第0条消息')));
  t('预测 token 在预算内（或单条即超预算）', w2.tokens <= 800 || w2.history.length <= 2,
    String(w2.tokens));

  // 反例：预算极小也不能崩，也不能返回空
  const w3 = buildHistory(long, { maxTurns: 100, maxTokens: 1 });
  t('★反例：极小预算仍至少保留 1 条且带省略标注',
    w3.history.length >= 1 && w3.dropped > 0, JSON.stringify({ n: w3.history.length, d: w3.dropped }));

  // 只有 user/assistant 进历史（system/meta 被过滤）
  const mixed = [
    { role: 'user', content: 'a' },
    { role: 'system', content: 'meta 行不该进历史' },
    { role: 'assistant', content: 'b' },
  ];
  const w4 = buildHistory(mixed);
  t('system/meta 行不混进对话历史', w4.history.length === 2 && !w4.history.some((m) => m.content.includes('meta')));
}

// ══ 三、记忆召回（临时写入 → 断言 → 还原）══
{
  mkdirSync(dirname(STORE), { recursive: true });
  const backup = existsSync(STORE) ? readFileSync(STORE) : null;
  try {
    const db = memLoad();
    memPut(db, {
      key: 'nianchu.test.deploy-target',
      value: '部署目标是 127.0.0.1:47124，单进程，数据在 %APPDATA%\\Nianchu',
      source: 'verify-context', by: 'verify', onConflict: 'supersede',
    });
    memPut(db, {
      key: 'nianchu.test.unrelated',
      value: '无关内容：今天午饭吃了面条',
      source: 'verify-context', by: 'verify', onConflict: 'supersede',
    });
    memSave(db);

    const hit = recallMemory('部署目标是哪个端口', { limit: 5 });
    t('相关查询能召回记忆', hit.hits.length > 0 && hit.hits.some((h) => h.key === 'nianchu.test.deploy-target'),
      JSON.stringify(hit.hits.map((h) => h.key)));
    t('召回块里带来源标注', /来源：/.test(hit.block), hit.block.slice(0, 80));
    t('召回块标明「可能过时」', /可能过时/.test(hit.block));

    const miss = recallMemory('量子纠缠的贝尔不等式', { limit: 5 });
    t('★反例：无关查询不硬塞记忆', miss.hits.length === 0 && miss.block === '',
      JSON.stringify(miss.hits.map((h) => h.key)));

    const empty = recallMemory('', { limit: 5 });
    t('★反例：空查询不倒库', empty.hits.length === 0 && empty.block === '');

    // assembleMessages 顺序：system 在最前
    const asm = assembleMessages({
      systemPrompt: '你是念初。',
      messages: [{ role: 'user', content: '部署目标是哪个端口' }],
      userText: '部署目标是哪个端口',
      memory: true,
    });
    t('装配后第一条是 system', asm.messages[0].role === 'system');
    t('system 里同时含角色设定与记忆块',
      asm.messages[0].content.includes('你是念初') && asm.messages[0].content.includes('已知事实'));
    t('装配后记忆命中数 > 0', asm.memoryHits.length > 0, String(asm.memoryHits.length));

    // 反例：关掉 memory
    const off = assembleMessages({
      systemPrompt: '你是念初。',
      messages: [{ role: 'user', content: '部署目标是哪个端口' }],
      userText: '部署目标是哪个端口',
      memory: false,
    });
    t('★反例：memory=false 时不注入记忆', off.memoryHits.length === 0
      && !off.messages[0].content.includes('已知事实'));
  } finally {
    // 原样还原记忆库，别污染真实数据
    if (backup !== null) writeFileSync(STORE, backup);
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 历史窗口有界且显式标注、保留最近、记忆按相关性召回且无幻觉注入'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;