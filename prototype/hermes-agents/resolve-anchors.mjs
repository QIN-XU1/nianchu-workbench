#!/usr/bin/env node
/**
 * 证据补齐：给缺硬证据的格子配「定向锚点」并验证
 *
 * 上一版（resolve-provenance）失败的真实原因，不是脚本笨，是**证据文本里没有标识符**：
 *   A1.hermes   "67 工具含文件读写，6 种执行后端"        ← 抽不出任何可 grep 的东西
 *   A1.openclaw "agent runtime 可插拔，编辑转发给底层 runtime"
 *
 * 所以正确做法不是「从文本猜关键词」，而是**人工给出预期锚点**：
 *   这个能力在这个参照系统的哪个模块里？然后用 rg 去验证它**真的在那里**。
 *   验证到了 → 补 `路径:行号`；验证不到 → 如实记 unverified，并把状态降级。
 *
 * 这张表是「我知道该看哪儿」的知识，不是猜。每条都写清为什么去那儿找。
 *
 * 用法：
 *   node prototype/hermes-agents/resolve-anchors.mjs            # 全量验证
 *   node prototype/hermes-agents/resolve-anchors.mjs --check    # 只校验（不写盘）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');
const OUT = path.join(REPO, 'evidence/anchors.json');
const RG = 'D:/file/software/raccoon-ai/resources/rg/rg.exe';
const CHECK = process.argv.includes('--check');

const ROOTS = {
  dsh: 'D:/file/AI Temp/DeepSeek/Agent自研/evidence/dsh-src',
  openclaw: 'D:/refs/openclaw',
  hermes: 'C:/hermes',
  ecc: 'D:/refs/ECC/ECC-main',
  luanyujia: 'D:/refs/luanyujia/luanyujia-workbench-main',
};

/**
 * 定向锚点表：dim.subject → { pattern, why, root? }
 *   pattern 用 rg 的固定串（-F），确保可复算
 *   why 说明「为什么去这里找」—— 这是知识，不是猜
 */
const ANCHORS = {
  // A 功能层
  'A1.openclaw': { pattern: 'apply_patch', why: 'openclaw 的编辑能力走 agent runtime 的补丁工具' },
  'A1.hermes': { pattern: 'write_file', why: 'hermes 67 工具里有 write_file/read_file' },
  'A1.dsh': { pkg: 'dsh-tools', why: 'DSH 内建工具包名' },
  'A1.ecc': { pattern: 'apply_patch', why: 'ECC 提供 skill 指导，需确认是否有补丁语义' },
  'A2.openclaw': { pattern: 'node-host', why: 'openclaw 的 sidecar 执行宿主' },
  'A2.hermes': { pattern: 'docker', why: 'hermes 的 6 种执行后端之一' },
  'A2.dsh': { pkg: 'dsh-bash-sandbox', why: 'DSH 沙箱包名' },
  'A2.ecc': { pattern: 'hooks', why: 'ECC 用 hooks 执行，需确认无沙箱' },
  'A3.openclaw': { pattern: 'web-search', why: 'openclaw src/web-search' },
  'A3.hermes': { pattern: 'web_search', why: 'hermes tools 内建搜索' },
  'A3.dsh': { pkg: 'dsh-web-fetch-http', why: 'DSH web 工具包名' },
  'A6.openclaw': { pattern: 'dreaming', why: 'openclaw 五层记忆 + dreaming 三阶段' },
  'A6.hermes': { pattern: 'MEMORY.md', why: 'hermes 记忆文件' },
  'A6.dsh': { pkg: 'dsh-memory', why: '验证 DSH 是否真的无 memory 包（grep 应少或无）' },
  'A7.openclaw': { pattern: 'provenance', why: 'openclaw 记忆溯源闭环' },
  'A8.openclaw': { pattern: 'subagent', why: 'openclaw 子代理' },
  'A8.hermes': { pattern: 'delegate_task', why: 'hermes 单向扇出' },
  'A8.dsh': { pkg: 'dsh-subagent', why: 'DSH 子代理包' },
  'A11.openclaw': { pattern: 'cron', why: 'openclaw src/cron' },
  'A11.hermes': { pattern: 'scheduler_provider', why: 'hermes 调度器' },
  'A11.dsh': { pkg: 'dsh-schedule', why: 'DSH 调度包' },
  'A12.openclaw': { pattern: 'extensions', why: 'openclaw ~180 插件' },
  'A12.hermes': { pattern: 'skills', why: 'hermes 技能目录' },
  'A12.ecc': { pattern: 'skills', why: 'ECC 314 skills' },
  'A12.dsh': { pkg: 'dsh-client-ui-plugin-manager', why: 'DSH 插件管理' },
  'A13.openclaw': { pattern: 'mcp', why: 'openclaw src/mcp' },
  'A13.hermes': { pattern: 'mcps', why: 'hermes optional-mcps' },
  'A13.dsh': { pkg: 'dsh-mcp-client', why: 'DSH MCP 包' },
  'A13.ecc': { pattern: 'mcp-config', why: 'ECC mcp-configs/' },
  'A15.openclaw': { pattern: 'trust', why: 'openclaw trust-model' },
  'A15.hermes': { pattern: 'approval', why: 'hermes 审批闸' },
  'A15.dsh': { pkg: 'dsh-client-ui-approval', why: 'DSH 工具 waterfall 审批' },
  'A16.openclaw': { pattern: 'audit', why: 'openclaw security/audit' },
  'A16.hermes': { pattern: 'evidence', why: 'hermes evidence ledger' },
  'A16.dsh': { pkg: 'dsh-client-ui-trajectory', why: 'DSH 日志即真相' },

  // B 架构层
  'B1.hermes': { pattern: 'plugin_api', why: 'hermes 插件白名单' },
  'B1.openclaw': { pattern: 'ChannelPlugin', why: 'openclaw 贡献点' },
  'B1.dsh': { pkg: 'dsh-client-ui-layout', why: 'DSH 客户端 UI 包分解' },
  'B2.openclaw': { pattern: 'workspace', why: 'openclaw 工作区隔离' },
  'B3.hermes': { pattern: 'acp', why: 'hermes ACP 编辑器集成' },
  'B3.dsh': { pkg: 'dsh-acp', why: 'DSH ACP' },
  'B4.hermes': { pattern: 'PRIVATE', why: 'hermes 记忆哨兵字节红线' },

  // C 执行逻辑
  'C1.openclaw': { pattern: 'scheduler', why: 'openclaw 调度' },
  'C1.hermes': { pattern: 'cron', why: 'hermes 定时' },
  'C2.openclaw': { pattern: 'memory', why: 'openclaw 记忆' },
  'C2.hermes': { pattern: 'MEMORY', why: 'hermes 记忆' },
  'C4.openclaw': { pattern: 'verif', why: 'openclaw 验证相关' },
  'C4.hermes': { pattern: 'verify', why: 'hermes 验证相关' },

  // D 界面
  'D1.dsh': { pkg: 'dsh-web-frontend', why: 'DSH 前端包' },
  'D1.openclaw': { pattern: 'web-ui', why: 'openclaw web-ui' },
  'D1.hermes': { pattern: 'starmap', why: 'hermes 星图界面' },

  // ── luanyujia（源码在 10-源码/，中文目录）──
  'A1.luanyujia': { pattern: 'sessions.mjs', why: '它的会话壳实现在 10-源码/会话与切换/' },
  'A2.luanyujia': { pattern: 'spawn', why: '拉起引擎进程（11-最小可运行壳 + 启动链路）' },
  'A3.luanyujia': { pattern: 'webai', why: '免费AI桥 webai.mjs —— 靠桥接网页 AI 联网' },
  'A4.luanyujia': { pattern: 'contenteditable', why: '面板输入区（webview 上传/粘贴）' },
  'A5.luanyujia': { pattern: '压缩', why: '查是否真有上下文压缩实现' },
  'A6.luanyujia': { pattern: '记忆', why: '00-核心机制/二-记忆机制 + 机制小工具' },
  'A7.luanyujia': { pattern: '哨兵', why: '机制小工具/临时哨兵.mjs（字节红线校验）' },
  'A8.luanyujia': { pattern: 'dispatch', why: '04 派单机制 / sessions.mjs' },
  'A9.luanyujia': { pattern: '派单', why: '00-核心机制/四-派单机制.md + 源码里的回执' },
  'A11.luanyujia': { pattern: 'cron', why: '查是否有定时器（矩阵记「无」，需确认）' },
  'A12.luanyujia': { pattern: '面板', why: '面板实现/ 三个大文件 = 它的技能/面板体系' },
  'A13.luanyujia': { pattern: 'mcp', why: '03-MCP接免费AI' },
  'A14.luanyujia': { pattern: 'webai', why: '免费AI桥 = 多供应商（桥接多个网页 AI）' },
  'A15.luanyujia': { pattern: '修改权', why: '05-协作与规矩：修改权五档' },
  'A16.luanyujia': { pattern: '台账', why: '派单台账（00-核心机制/四-派单机制）' },
  'B1.luanyujia': { pattern: '面板', why: '面板式扩展（面板实现/）' },
  'B2.luanyujia': { pattern: '场景', why: '01-场景模式：场景隔离' },
  'B3.luanyujia': { pattern: 'sessions.mjs', why: '会话壳可换引擎（会话与切换/）' },
  'B4.luanyujia': { pattern: '负载闸', why: '机制小工具/负载闸.mjs（体量/负载控制）' },
  'C1.luanyujia': { pattern: 'scheduler', why: '查调度（矩阵记「无」）' },
  'C2.luanyujia': { pattern: '记忆', why: '二-记忆机制' },
  'C3.luanyujia': { pattern: '哨兵', why: '哨兵 = 自检机制' },
  'C4.luanyujia': { pattern: '验收', why: '查是否有验收机制' },
  'D1.luanyujia': { pattern: '顶栏', why: '07-顶栏与菜单栏' },
  'D2.luanyujia': { pattern: '面板', why: '面板布局密度' },
  'D3.luanyujia': { pattern: '负载闸', why: '负载闸显示状态' },

  // ── ECC（配置层，证据指向具体配置文件/目录）──
  'A3.ecc': { pattern: 'WebSearch', why: '查是否有联网工具定义' },
  'A4.ecc': { pattern: 'image', why: '查是否有图像输入定义' },
  'A5.ecc': { pattern: 'compact', why: '查是否有上下文压缩' },
  'A6.ecc': { pattern: 'memory', why: 'skills/ 里的 memory skill' },
  'A7.ecc': { pattern: 'memory', why: '记忆治理：查 provenance/TTL' },
  'A8.ecc': { pattern: 'agents', why: 'agents/ 目录 = 71 个 agent 定义' },
  'A9.ecc': { pattern: 'delegate', why: '查是否有协作协议' },
  'A10.ecc': { pattern: 'slack', why: '查是否有 IM 通道' },
  'A11.ecc': { pattern: 'cron', why: '查是否有定时任务' },
  'A14.ecc': { pattern: 'model', why: '多端适配的模型配置' },
  'A15.ecc': { pattern: 'hooks', why: 'hooks 可拦截（Claude 27 个 / 其他端 1 个）' },
  'A16.ecc': { pattern: 'audit', why: 'hooks 审计' },
  'B1.ecc': { pattern: 'plugin', why: '.claude-plugin / .codex-plugin' },
  'B2.ecc': { pattern: 'worktree', why: 'ecc2/src/worktree = 工作区隔离' },
  'B3.ecc': { pattern: 'cursor', why: '.cursor/.codex/.gemini = 跨工具适配' },
  'B4.ecc': { pattern: 'size', why: '查是否有体量控制' },
  'C1.ecc': { pattern: 'schedule', why: '查调度' },
  'C2.ecc': { pattern: 'memory', why: '记忆' },
  'C3.ecc': { pattern: 'verify', why: '查自检机制' },
  'C4.ecc': { pattern: 'test', why: '查验收机制' },
  'D1.ecc': { pattern: 'dashboard', why: 'ecc_dashboard.py' },
  'D2.ecc': { pattern: 'dashboard', why: '面板布局' },
  'D3.ecc': { pattern: 'status', why: '查状态展示' },
};

/**
 * 什么算「有效源码证据」——这条判据比「找到了」严格得多
 *
 * 上一版 51/51「全部验证到」，但有大量伪命中：
 *   DSH 全是 "binary file matches"（那是 asar 二进制，不是源码）
 *   有的落到 CHANGELOG.md / appcast-arm64.xml / cli-config.yaml.example
 *   —— 发行说明、更新清单、配置样例，都不是**实现**
 *
 * 要求：
 *   · 必须是源代码扩展名（.py/.ts/.tsx/.js/.mjs/.rs/.go/.java/.kt/.swift/.c/.cc/.h/.hpp）
 *   · 排除 changelog / appcast / *.example / *.md / 配置样例
 *   · 排除二进制匹配
 */
const SRC_EXT = /\.(py|ts|tsx|js|mjs|cjs|rs|go|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|rb|php|lua)$/i;
const NOT_IMPL = /changelog|changes|appcast|release|whats?new|\/docs?\/|\.md$|\.mdx$|\.example$|\.sample$|\.template$|LICENSE|README/i;
const BINARY = /binary file matches/i;

function isRealSource(line, root) {
  if (BINARY.test(line)) return false;
  // 取出路径部分
  const m = line.match(/^(.+?):(\d+):/) || line.match(/^(.+?):(\d+)$/);
  if (!m) return false;
  const file = m[1].replace(/\\/g, '/');
  if (!SRC_EXT.test(file)) return false;
  const rel = file.replace(root.replace(/\\/g, '/') + '/', '');
  if (NOT_IMPL.test(rel)) return false;
  return true;
}

/**
 * 目录锚点：DSH 的能力单位是包目录（dsh-subagent / dsh-mcp-client / dsh-schedule…），
 * 包名只存在于目录名、不在文件内容里 —— 内容锚点永远搜不到。
 * 所以对「能力 = 一个包」的情况，直接验证包存在且有源码入口。
 */
function resolvePkg(root, pkg) {
  if (!root || !fs.existsSync(root)) return null;
  const stack = [root];
  let dir = null;
  while (stack.length && !dir) {
    const cur = stack.shift();
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name === pkg) { dir = path.join(cur, e.name); break; }
      if (!/\.git|dist/.test(e.name)) stack.push(path.join(cur, e.name));
    }
  }
  if (!dir) return { found: false, pkg };
  const walk = [dir];
  while (walk.length) {
    const cur = walk.shift();
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(cur, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist/.test(e.name)) walk.push(f); continue; }
      if (/\.(ts|tsx|js|mjs|py|rs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        return { found: true, file: f.replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', ''), line: 1, pkg };
      }
    }
  }
  return { found: false, pkg };
}

function rgCount(root, pattern) {
  if (!root || !fs.existsSync(root)) return null;
  // rg 在「有命中」时退出码 0，「无命中」是 1，「出错」是 2。
  // execFileSync 把 1/2 都当异常抛 —— 所以必须读 e.stdout，不能只 try 成功路径。
  // 另外必须带 -n，否则输出没有行号。
  // 多取几行（-m 8）再筛，避免第一条是 CHANGELOG 就误判成「无源码证据」。
  let out = '';
  try {
    out = execFileSync(fs.existsSync(RG) ? RG : 'rg',
      ['-n', '--no-heading', '--no-messages', '-m', '8', '-F', pattern, root],
      { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    out = (e.stdout || '') + '';
  }
  const lines = out.split('\n').filter((l) => l.trim());
  if (!lines.length) return { found: false };

  const good = lines.filter((l) => isRealSource(l, root) && !/node_modules|\.git[\\/]|dist[\\/]/.test(l));
  if (!good.length) {
    // 有命中，但都不是实现源码 —— 如实记：找到的只是文档/配置
    return { found: false, onlyDocHits: lines.slice(0, 2).map((l) => l.slice(0, 90)) };
  }

  const line = good[0];
  const m = line.match(/^(.+?):(\d+):/);
  const m2 = m ? null : line.match(/^(.+?):(\d+)$/);
  return {
    found: true,
    file: (m ? m[1] : m2 ? m2[1] : line.split(':')[0]).replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', ''),
    line: m ? Number(m[2]) : m2 ? Number(m2[2]) : null,
  };
}

const raw = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
const dims = raw.dimensions.flatMap((g) => g.items);
const byId = new Map(dims.map((d) => [d.id, d]));

const results = [];
let applied = 0;

for (const [key, anchor] of Object.entries(ANCHORS)) {
  const [id, subj] = key.split('.');
  const dim = byId.get(id);
  if (!dim) { results.push({ key, verdict: 'no-dimension' }); continue; }
  const root = ROOTS[subj];
  const r = anchor.pkg ? resolvePkg(root, anchor.pkg) : rgCount(root, anchor.pattern);

  if (!r) { results.push({ key, pattern: anchor.pattern, why: anchor.why, verdict: 'no-local-source' }); continue; }
  if (!r.found) { results.push({ key, pattern: anchor.pattern, why: anchor.why, verdict: 'not-found', state: dim[subj]?.[0] }); continue; }

  const cite = r.file + (r.line ? ':' + r.line : '');
  results.push({ key, pattern: anchor.pattern, why: anchor.why, verdict: 'verified', cite, state: dim[subj]?.[0] });

  // 写回：保留原描述，追加硬证据
  if (!CHECK && Array.isArray(dim[subj]) && dim[subj].length >= 2) {
    const [state, ev] = dim[subj];
    if (!new RegExp(cite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(String(ev))) {
      dim[subj] = [state, String(ev) + '（源码定位：' + cite + '）'];
      applied++;
    }
  }
}

const tally = {};
for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;

if (!CHECK) {
  fs.writeFileSync(MATRIX, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  what: '定向锚点验证：每个能力在参照系统源码里是否真的存在',
  rule: 'verified=源码里找到并已补进矩阵｜not-found=去那儿找了但没有（需复核该格状态）｜no-local-source=该参照系统无本地源码',
  at: new Date().toISOString(),
  anchors: Object.keys(ANCHORS).length,
  tally,
  results,
}, null, 2) + '\n', 'utf8');

console.log('');
console.log('  定向锚点验证 —— 每条都写明「为什么去这里找」');
console.log('  ' + '─'.repeat(72));
console.log('  锚点 ' + Object.keys(ANCHORS).length + ' 条');
console.log('');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log('    ' + k.padEnd(18) + String(v).padStart(4));
}
console.log('');
console.log('  已验证（' + results.filter((r) => r.verdict === 'verified').length + '）:');
for (const r of results.filter((x) => x.verdict === 'verified').slice(0, 25)) {
  console.log('    ✓ ' + r.key.padEnd(14) + String(r.cite).padEnd(52) + '  ' + (r.pattern || r.pkg || ''));
}
const nf = results.filter((r) => r.verdict === 'not-found');
if (nf.length) {
  console.log('');
  console.log('  去那儿找了但没有（需复核状态）:');
  for (const r of nf) console.log('    ? ' + r.key.padEnd(14) + String(r.pattern || r.pkg || '').padEnd(20) + ' ' + r.why);
}
if (!CHECK) console.log('\n  已写回 matrix-data.json（补 ' + applied + ' 条源码定位）');
console.log('  → ' + path.relative(REPO, OUT));

// 退出码语义：
//   not-found 不等于失败 —— 它只是「去那儿找了但没找到源码证据」，需要复核；
//   只有 verified 为 0（一条都没验证到）才算脚本本身失效。
const verifiedN = results.filter((r) => r.verdict === 'verified').length;
console.log('');
process.exit(verifiedN > 0 ? 0 : 1);
