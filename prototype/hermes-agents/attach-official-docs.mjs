#!/usr/bin/env node
/**
 * 闭源系统的证据补强：给 ChatGPT / Claude 的格子挂官方文档 URL 并**实测可达**
 *
 * 为什么需要单独处理：
 *   这两个系统闭源，没有本地源码。R1 规定证据优先级「本地源码 > 联网文档 > 二手描述」，
 *   所以它们的合法证据形式就是**官方文档 URL**（且必须实测可达，不能只是写上去）。
 *
 * 与「贴个链接」的区别：
 *   每条的 URL 都过 tools/net/fetch.mjs 抓一遍，四态落盘。
 *   FAIL 的 URL 不许留在矩阵里；UNKNOWN 标注「本次未连上，需重试」。
 *
 * 用法：
 *   node prototype/hermes-agents/attach-official-docs.mjs            # 抓取 + 写回
 *   node prototype/hermes-agents/attach-official-docs.mjs --dry      # 只抓不写
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchUrl, S } from '../../tools/net/fetch.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');
const OUT = path.join(REPO, 'evidence/official-docs.json');
const DRY = process.argv.includes('--dry');

/**
 * 官方文档锚点：dim → { chatgpt?: url, claude?: url }
 *
 * 每条都对应「这个能力在该产品的哪一页文档」。选页面的依据：
 *   · 优先官方 reference / docs 的稳定路径
 *   · 不选博客、不选社区帖（二手描述不合格）
 */

/**
 * 403 的处理 —— 这条判据是实测逼出来的
 *
 * 实测：OpenAI 全部 4 个域名（openai.com / platform.openai.com /
 * developers.openai.com / cookbook.openai.com）对这台机器一律返回 **HTTP 403**，
 * 带代理也是 403。这是站点级的访问控制（Cloudflare 一类），不是 URL 写错。
 *
 * 所以 403 必须与 404 区分：
 *   404 = 这一页不存在           → 说明我引错了，该改 URL
 *   403 = 站点不让我看           → 判不了，不能说「证据不存在」
 * 把 403 当 FAIL 会得出「OpenAI 没有文档」这种荒谬结论；
 * 当 PASS 则是假绿。正确做法是 UNKNOWN，并在报告里说明为什么。
 */
function reclassify(r) {
  if (r.httpCode === 403) {
    return {
      ...r,
      state: 'UNKNOWN',
      why: 'HTTP 403 —— 站点级访问控制（实测该域名对本机及代理均返回 403），' +
        '判不了，不等于文档不存在',
    };
  }
  return r;
}
const DOCS = {
  // A 功能层
  A1: { chatgpt: 'https://platform.openai.com/docs/guides/code-generation', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/tool-use' },
  A2: { chatgpt: 'https://platform.openai.com/docs/guides/tools-shell', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/bash-tool' },
  A3: { chatgpt: 'https://platform.openai.com/docs/guides/tools-web-search', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool' },
  A4: { chatgpt: 'https://platform.openai.com/docs/guides/vision', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/vision' },
  A5: { chatgpt: 'https://platform.openai.com/docs/guides/conversation-state', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/context-windows' },
  A6: { chatgpt: 'https://platform.openai.com/docs/guides/memory', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/memory' },
  A7: { chatgpt: 'https://platform.openai.com/docs/guides/safety-best-practices', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/memory' },
  A8: { chatgpt: 'https://platform.openai.com/docs/guides/agents', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/agents' },
  A11: { chatgpt: 'https://platform.openai.com/docs/assistants/deep-dive', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/agents' },
  A12: { chatgpt: 'https://platform.openai.com/docs/assistants/tools', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills' },
  A13: { chatgpt: 'https://platform.openai.com/docs/mcp', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/mcp' },
  A14: { chatgpt: 'https://platform.openai.com/docs/models', claude: 'https://docs.anthropic.com/en/docs/about-claude/models' },
  A15: { chatgpt: 'https://platform.openai.com/docs/guides/safety-best-practices', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview' },
  A16: { chatgpt: 'https://platform.openai.com/docs/guides/production-best-practices', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/usage-cost-api' },
  // B 架构层
  B1: { chatgpt: 'https://platform.openai.com/docs/guides/agents', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/agents' },
  B2: { chatgpt: 'https://platform.openai.com/docs/guides/safety-best-practices', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/context-windows' },
  B3: { chatgpt: 'https://platform.openai.com/docs/libraries', claude: 'https://docs.anthropic.com/en/api/client-sdks' },
  B4: { chatgpt: 'https://platform.openai.com/docs/guides/production-best-practices', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching' },
  // C 执行逻辑
  C1: { chatgpt: 'https://platform.openai.com/docs/assistants/deep-dive', claude: 'https://docs.anthropic.com/en/docs/agents-and-tools/agents' },
  C2: { chatgpt: 'https://platform.openai.com/docs/guides/memory', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/memory' },
  C3: { chatgpt: 'https://platform.openai.com/docs/guides/production-best-practices', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching' },
  C4: { chatgpt: 'https://platform.openai.com/docs/guides/evals', claude: 'https://docs.anthropic.com/en/docs/test-and-evaluate' },
  // D 界面
  D1: { chatgpt: 'https://platform.openai.com/docs/overview', claude: 'https://docs.anthropic.com/en/docs/overview' },
  D2: { chatgpt: 'https://platform.openai.com/docs/overview', claude: 'https://docs.anthropic.com/en/docs/overview' },
  D3: { chatgpt: 'https://platform.openai.com/docs/guides/usage', claude: 'https://docs.anthropic.com/en/docs/build-with-claude/usage-cost-api' },
};

const raw = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
const dims = raw.dimensions.flatMap((g) => g.items);
const byId = new Map(dims.map((d) => [d.id, d]));

// 收集待抓 URL（去重）
const urls = new Set();
for (const v of Object.values(DOCS)) {
  if (v.chatgpt) urls.add(v.chatgpt);
  if (v.claude) urls.add(v.claude);
}
console.log('');
console.log('  闭源系统证据补强 —— 官方文档 URL 实测');
console.log('  ' + '─'.repeat(72));
console.log('  待抓 ' + urls.size + ' 个唯一 URL（' + Object.keys(DOCS).length + ' 个维度）');
console.log('');

const result = new Map();
for (const url of urls) {
  const r = reclassify(await fetchUrl(url, { retries: 2, timeoutSec: 30 }));
  result.set(url, r);
  const mark = r.state === S.PASS ? '✓' : r.state === S.WARN ? '🟡' : r.state === S.FAIL ? '✗' : '?';
  console.log('  ' + mark + ' ' + r.state.padEnd(8) + url.slice(0, 72));
}

// 只把 PASS / WARN 的 URL 写进矩阵（FAIL 的绝不写）
let applied = 0;
const detail = [];
for (const [id, pair] of Object.entries(DOCS)) {
  const dim = byId.get(id);
  if (!dim) continue;
  for (const subj of ['chatgpt', 'claude']) {
    const url = pair[subj];
    if (!url) continue;
    const r = result.get(url);
    const ok = r && (r.state === S.PASS || r.state === S.WARN);
    detail.push({ dim: id, subject: subj, url, state: r ? r.state : 'MISSING', accepted: !!ok });
    if (!ok) continue;

    const cell = dim[subj];
    if (!Array.isArray(cell) || cell.length < 2) continue;
    const [state, ev] = cell;
    if (String(ev).includes(url)) continue;
    if (!DRY) {
      dim[subj] = [state, String(ev) + '（官方文档：' + url + '，实测 ' + r.state + '）'];
      applied++;
    }
  }
}

const tally = { pass: 0, warn: 0, fail: 0, unknown: 0 };
for (const r of result.values()) {
  if (r.state === S.PASS) tally.pass++;
  else if (r.state === S.WARN) tally.warn++;
  else if (r.state === S.FAIL) tally.fail++;
  else tally.unknown++;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  what: '闭源系统（ChatGPT / Claude）官方文档 URL 的实测可达性',
  rule: '只有 PASS/WARN 的 URL 才写进矩阵；FAIL 的绝不写入；UNKNOWN 待重试',
  at: new Date().toISOString(),
  tally,
  detail,
  results: [...result.values()],
}, null, 2) + '\n', 'utf8');

if (!DRY && applied > 0) {
  fs.writeFileSync(MATRIX, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  PASS ' + tally.pass + ' · WARN ' + tally.warn + ' · FAIL ' + tally.fail + ' · UNKNOWN ' + tally.unknown);
console.log('  写入矩阵: ' + applied + ' 条' + (DRY ? '（--dry，未写盘）' : ''));
if (tally.fail) {
  console.log('  ✗ 有 ' + tally.fail + ' 个 URL 真的不存在（404 等）—— 那些格子保持原状，不写无效链接');
}
if (tally.unknown) {
  console.log('  ? 有 ' + tally.unknown + ' 个 URL 判不了（403 站点级屏蔽 / 连不上）—— ' +
    '不写成 FAIL，也不当 PASS；这些格子保持原状并记录在 official-docs.json');
}
console.log('  → ' + path.relative(REPO, OUT));
console.log('');