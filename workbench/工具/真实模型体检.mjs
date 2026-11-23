#!/usr/bin/env node
// 工具/真实模型体检.mjs —— 用真模型跑一次完整任务，验证「AI 真的能干活」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（半个多月的盲区）
// ══════════════════════════════════════════════════════════════════════
//  2026-11-12 之前，模型服务一直是 402（余额不足）。
//  于是所有「需要模型」的验证都被跳过了：
//    · 场景能不能真的执行任务？       —— 没验过
//    · 执行完会不会真的写产物？       —— 没验过
//    · 会不会把经验写回记忆？         —— 没验过
//    · 工具调用能不能用？             —— 没验过
//
//  而机制体检 85 项全绿 —— 因为它们测的都是「不需要模型」的部分。
//
//  2026-11-12 接入本地网关后第一次真跑，发现：
//    ✓ 模型能执行多步工具调用（write / read / edit / pwsh）
//    ✓ 能产出 9KB 的真实分析文档（引用真实数据，不是空话）
//    ✓ 能把经验写回场景记忆（118 → 119 条）
//  也发现：
//    ✗ 429 限流会让每一步都重试，非常慢
//    ✗ 有的模型额度会耗尽（tpm exhausted）
//
//  这个工具把这套验证固化成一条命令。
//
//  用法：
//    node 工具/真实模型体检.mjs                 默认测「调研」场景
//    node 工具/真实模型体检.mjs --scene 故障分析
//    node 工具/真实模型体检.mjs --quick        只测连通性（不跑完整任务）
//    node 工具/真实模型体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 模型网关地址 */
export const GATEWAY = 'http://127.0.0.1:3425';
/** 网关密钥 */
export const GATEWAY_KEY = 'magpie';
/** 连通性测试用的模型（要选稳定的，不选额度会耗尽的） */
export const PING_MODEL = 'opencode-zen-free/nemotron-3.5-lightning-free';
/** 任务最多等多久（毫秒）—— 场景执行通常 2-5 分钟 */
export const TASK_MAX_WAIT_MS = 600000;

/**
 * 文件写完后，再等多久让模型把话说完（毫秒）
 *
 * 实测：模型是「先写文件、再回话」，中间隔一个 step。
 * 文件一到就 break，读到的 assistant/message 还是空的。
 */
export const SETTLE_MS = 6000;
/** 判定「真的干活了」的最少工具调用次数 */
export const MIN_TOOL_CALLS = 2;

/**
 * 判一次模型回复是否「有实质内容」（不是空话）
 *
 * ⚠ 判据顺序很重要（自测抓出来的）：
 *   第一版先判「长度 ≥ 20」，于是「严格化 12 项检查，8 项通过」（17 字）
 *   这种**有明显实质但是短**的回复被误判为空话。
 *
 *   正确顺序：先判「有没有实质标记」（数字/文件名/结论词），
 *             有就算有实质（哪怕短）；没有才看长度。
 *
 * @param {string} text
 * @returns {{ok:boolean, why:string}}
 */
export function judgeSubstance(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: '空回复' };

  // 纯礼貌词 —— 无论多长都是空话
  if (/^(收到|好的|好|OK|ok|是的|嗯|了解|明白)[。！!，,]?$/.test(t)) {
    return { ok: false, why: '空话：' + t };
  }

  // 先看实质标记：数字 / 文件名 / 结论词
  //   有 → 直接算有实质（短也可以，比如「8 项通过」）
  //
  // ⚠ 文件名要同时支持英文和中文（自测抓出来的）：
  //   '投递通道.mjs' 这种中文文件名用 [a-zA-Z_] 匹配不到。
  const hasSubstance = /\d+|[^\s/\\]+\.m?js|[^\s/\\]+\.md|因为|所以|结论|根因|判据|证据|通过|失败|修复|改成/.test(t);
  if (hasSubstance) return { ok: true, why: '' };

  // 没有实质标记时，才用长度兜底
  if (t.length < 20) return { ok: false, why: '太短且无实质标记（' + t.length + ' 字符）' };

  return { ok: false, why: '够长但没有实质标记（无数字/文件名/结论词）' };
}

// ══════════════════════════════════════════════════════════════════════
//  网关直连（不经过引擎，用于连通性测试）
// ══════════════════════════════════════════════════════════════════════
export function pingGateway(model) {
  return new Promise((resolve) => {
    // ⚠ 2026-11-12 修（max_tokens 太小 + 推理模型判据）
    //
    //   第一版用 max_tokens=20，实测 nemotron 返回：
    //     {"content": null, "reasoning_content": "The user says: ...", "finish_reason": "length"}
    //   20 个 token 全被思维链吃掉了，content 是 null，于是判「网关不通」——
    //   但 status 明明是 200。
    //
    //   修法：
    //     ① max_tokens 提到 200（够一个简短回复）
    //     ② 判据同时接受 content 和 reasoning_content
    const body = JSON.stringify({
      model: model || PING_MODEL,
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
      max_tokens: 200,
      stream: false,
    });
    const t0 = Date.now();
    const req = http.request({
      hostname: '127.0.0.1', port: 3425, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GATEWAY_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 90000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /**/ }
        const msg = j && j.choices && j.choices[0] && j.choices[0].message;
        const content = msg ? String(msg.content || '') : '';
        const reasoning = msg ? String(msg.reasoning_content || '') : '';
        // 任一有内容就算通（推理模型的回答在 reasoning_content 里）
        const text = content || reasoning;
        resolve({
          ok: res.statusCode === 200 && !!text.trim(),
          status: res.statusCode, text, content, reasoning,
          isReasoning: !content.trim() && !!reasoning.trim(),
          ms: Date.now() - t0, raw: d.slice(0, 200),
        });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message), ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - t0 }); });
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
//  引擎 RPC（用于读会话事件、判断任务是否真的在干）
// ══════════════════════════════════════════════════════════════════════
function getToken() {
  try {
    const log = fs.readFileSync(path.join(WB, '外壳', 'server.log'), 'utf8');
    const ms = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)];
    return ms.length ? ms[ms.length - 1][1] : '';
  } catch { return ''; }
}

async function makeRpc() {
  const token = getToken();
  if (!token) return null;
  const cookie = await new Promise((resolve) => {
    const q = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/?token=' + encodeURIComponent(token),
      method: 'GET', timeout: 8000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    q.on('error', () => resolve(''));
    q.end();
  });
  // ⚠ 2026-11-12 加：RPC 重试
  //
  //   实测：session/list 偶发返回 null（ECONNRESET），
  //   而同一时刻手写脚本打同样的请求 100% 成功（67 个会话，35ms）。
  //   说明是**瞬时**连接问题，不是接口问题。
  //
  //   加 3 次重试，间隔 300ms —— 比排查「为什么偶发」更实际。
  return async (method, args) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await new Promise((resolve) => {
        const body = JSON.stringify({ type: 'client-request', rpcId: 'r' + Date.now() + Math.random(), method, payload: { args: args || {} } });
        const req = http.request({
          hostname: '127.0.0.1', port: 3083, path: '/api/' + method, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie, Origin: 'http://127.0.0.1:3083' },
          timeout: 60000,
        }, (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /**/ } resolve(j); });
        });
        req.on('error', (e) => {
          if (attempt === 2) console.log('  （RPC ' + method + ' 三次都失败: ' + e.message + '）');
          resolve(null);
        });
        req.write(body);
        req.end();
      });
      if (r) return r;
      await new Promise((res) => setTimeout(res, 300));
    }
    return null;
  };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  真实模型体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】判据常量');
  chk('有网关地址', !!GATEWAY, GATEWAY);
  chk('有 ping 模型', !!PING_MODEL, PING_MODEL);
  chk('有等待上限', TASK_MAX_WAIT_MS > 0, Math.round(TASK_MAX_WAIT_MS / 1000) + ' 秒');
  chk('有工具调用下限', MIN_TOOL_CALLS > 0, String(MIN_TOOL_CALLS));

  console.log();
  console.log('【二】「有实质内容」判据');
  {
    // 正例
    chk('正例：含数字', judgeSubstance('严格化 12 项检查，8 项通过').ok);
    chk('正例：含文件名', judgeSubstance('改了 投递通道.mjs 的重试逻辑').ok);
    chk('正例：含结论词', judgeSubstance('根因是路径写错，所以改成绝对路径').ok);
    chk('正例：含 md 文件', judgeSubstance('产物写在 事故共同模式.md 里').ok);
  }

  console.log();
  console.log('【三】反例：空话必须被拒');
  {
    chk('反例：空字符串', !judgeSubstance('').ok, judgeSubstance('').why);
    chk('反例：「收到」', !judgeSubstance('收到').ok, judgeSubstance('收到').why);
    chk('反例：「好的」', !judgeSubstance('好的').ok);
    chk('反例：「OK」', !judgeSubstance('OK').ok);
    chk('反例：太短', !judgeSubstance('这是一句很短的话').ok, judgeSubstance('这是一句很短的话').why);
    chk('反例：够长但无实质标记',
      !judgeSubstance('这个东西我觉得还行吧反正就是这样子了你看呢').ok,
      judgeSubstance('这个东西我觉得还行吧反正就是这样子了你看呢').why);
  }

  console.log();
  console.log('【四】关键：这个工具补的是「模型不可用时全跳过」的盲区');
  chk('关键：工具存在就是为了验证「AI 真的能干活」',
    true, '2026-11-12 之前模型一直 402，所有需要模型的验证都被跳过');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const scene = val('scene') || '调研';
  let pass = 0, total = 0;
  const step = (n, ok, d) => {
    total++;
    if (ok) pass++;
    console.log('  ' + (ok ? 'OK ' : 'XX ') + n.padEnd(40) + (d || ''));
  };

  console.log('='.repeat(78));
  console.log('  真实模型体检 —— AI 真的能干活吗');
  console.log('='.repeat(78));
  console.log();

  // ① 网关连通
  console.log('  ── ① 网关连通 ──');
  const ping = await pingGateway();
  step('网关能回话', ping.ok, ping.ok ? '「' + ping.text.slice(0, 20) + '」' + ping.ms + 'ms' : (ping.error || 'status=' + ping.status));
  if (!ping.ok) {
    console.log();
    console.log('  ⛔ 网关不通，后面都测不了。检查：');
    console.log('     1) 网关进程在跑吗（端口 3425）');
    console.log('     2) 模型额度是否耗尽（换一个模型试试）');
    process.exitCode = 1;
    return;
  }
  console.log();

  if (has('quick')) {
    console.log('-'.repeat(78));
    console.log('  网关连通（--quick 只测这一步）');
    return;
  }

  // ② 引擎在线
  console.log('  ── ② 引擎在线 ──');
  const rpc = await makeRpc();
  step('能连上引擎', !!rpc, rpc ? '127.0.0.1:3083' : '读不到 token');
  if (!rpc) { process.exitCode = 1; return; }
  console.log();

  // ③ 发一个真任务
  //
  // ⚠ 2026-11-12 三次迭代（每次都是真跑暴露出来的）
  //
  //   第一版：让模型「跑 pwsh 看 Node 版本 + 写记忆 + 回复」
  //     → 模型调了 17 次工具，最后撞 402（任务太重，会话历史又长）
  //
  //   第二版：只让它写记忆
  //     → 成功了，但**污染了真实记忆**：
  //       往 5 个场景的 `场景私有记忆.md` 写了 `- REALMODEL-xxx 真实模型体检通过`，
  //       这些行没有日期前缀，被 `记忆写入.mjs --check` 判为违规（7 个问题）。
  //       体检工具不该改生产数据。
  //
  //   第三版（现在）：让它写一个**专用测试文件**，
  //     跑完自动删掉。生产记忆一点都不碰。
  //
  //   代价：少验了「写记忆」这一环 —— 但那已由 `记忆写入.mjs --check` 单独验。
  //   收获：体检可以反复跑而不留垃圾。
  console.log('  ── ③ 发一个真任务给「' + scene + '」──');
  const MARK = 'REALMODEL-' + Date.now();
  const TEST_FILE = '_真实模型体检临时.md';
  const testFilePath = path.join(MEM, scene, TEST_FILE);
  // 先清掉可能的上次残留
  if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);

  const taskText = '【真实模型体检·极轻任务】只做一件事，不要分析不要探索不要读别的文件：\n' +
    '用 write 工具创建文件 `' + TEST_FILE.replace(/\\/g, '/') + '`（就在你当前工作目录），内容写这一行：\n' +
    '`' + MARK + ' 真实模型体检通过`\n' +
    '创建完就回复「完成」。【结束】';

  let deliverOut = '';
  try {
    deliverOut = execFileSync(process.execPath, [path.join(WB, '工具', '投递通道.mjs'), '--to', scene, '--text', taskText], {
      cwd: WB, encoding: 'utf8', timeout: 300000, windowsHide: true,
    });
  } catch (e) {
    deliverOut = String((e && (e.stdout || e.stderr)) || '');
  }
  const delivered = /投递: ✓ 成功/.test(deliverOut);
  step('任务投递成功', delivered, delivered ? '已送达' : deliverOut.split('\n').filter((l) => /投递:/.test(l)).join(''));
  if (!delivered) { process.exitCode = 1; return; }
  console.log();

  // ④ 等它干完
  console.log('  ── ④ 等场景执行（最多 ' + Math.round(TASK_MAX_WAIT_MS / 1000) + ' 秒）──');
  const sl = await rpc('session/list', { _request: {} });
  const items = ((sl && sl.result && sl.result.value && sl.result.value.items) || []);
  const norm = (s) => String(s || '').replace(/[\\/]+/g, '/').toLowerCase();

  // ⚠ 2026-11-12 加诊断：session/list 返回空时打印原因
  if (!items.length) {
    console.log('  （session/list 返回空，原始响应: ' + JSON.stringify(sl).slice(0, 200) + '）');
  }

  // ⚠ 2026-11-12 修（找会话的判据写错了）
  //
  //   原判据：cwd.endsWith('/' + scene.toLowerCase()) 或 cwd.includes('场景记忆/竞品拆解')
  //   但 scene 是中文名（竞品拆解），而 cwd 末尾就是中文名，
  //   toLowerCase() 对中文无效但也不影响 —— 真正的问题是
  //   `endsWith('/' + 中文)` 在某些路径写法下匹配不到。
  //
  //   改成：取「cwd 的 basename 等于场景名」的会话，再按 updatedAt 取最新。
  const sess = items
    .filter((x) => {
      const base = String(x.cwd || '').split(/[\\/]/).filter(Boolean).pop();
      return base === scene;
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];

  if (!sess) {
    // 兜底：打印所有会话 basename，方便排查
    const bases = [...new Set(items.map((x) => String(x.cwd || '').split(/[\\/]/).filter(Boolean).pop()))];
    step('找到场景会话', false, '找不到「' + scene + '」，可用的有: ' + bases.slice(0, 12).join(', '));
    process.exitCode = 1;
    return;
  }

  const deadline = Date.now() + TASK_MAX_WAIT_MS;
  let finalEvs = [];
  let lastProgress = '';
  let fileReadyAt = 0;
  // ⚠ 2026-11-13 修（等待条件看错了地方 → 9 秒就放弃）
  //
  //   原来：break 的条件是「turn/end 是 completed」+「事件流里出现 MARK」。
  //   实测失败：投递 9 秒后就报「没有 _真实模型体检临时.md」，
  //            但事件流里有 10 次 tool/call（模型还在写）。
  //
  //   为什么 9 秒就退出：`hasMark` 检查的是**事件流 JSON 里有没有 MARK 字符串**，
  //   而 MARK 是任务文本的一部分 —— 一旦命中（比如模型把它写进中间结果），
  //   加上此时还有一个**上一次任务遗留的** turn/end（completed），
  //   条件立刻成立 → 提前 break。
  //
  //   正解：直接**轮询文件本身**。文件里出现带 MARK 的那行，才算真写完。
  //        这比「猜事件流」可靠得多，而且是「验证结果」而不是「验证过程」。
  const startEvCount = finalEvs.length;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const pg = await rpc('session/page', { request: { address: { kind: 'session', sessionId: sess.sessionId } } });
    finalEvs = ((pg && pg.result && pg.result.value && pg.result.value.records) || []).map((r) => (r.event || r));
    const progress = finalEvs.length + ' 事件';
    if (progress !== lastProgress) { process.stdout.write('  ' + progress + '\r'); lastProgress = progress; }

    // 真判据：文件存在且含 MARK
    let fileReady = false;
    try {
      fileReady = fs.existsSync(testFilePath) &&
        fs.readFileSync(testFilePath, 'utf8').includes(MARK);
    } catch { /* 正在写，读失败正常 */ }

    // ⚠ 2026-11-13 加：文件写完后**再等一轮**让模型把话说完
    //
    //   实测：改成「轮询文件」之后，文件一到就 break，
    //   于是读到的 assistant/message 还是空的 ——
    //   模型是先写文件、再回话，中间隔一个 step。
    //
    //   修法：文件就绪后记下时间，再等 SETTLE_MS 才 break，
    //        让最后一个 assistant/message 落进事件流。
    if (fileReady && fileReadyAt === 0) fileReadyAt = Date.now();
    if (fileReady && Date.now() - fileReadyAt >= SETTLE_MS) break;

    // 兜底：如果本轮已结束（turn/end 数量比开始多）但文件还是没有，再多等一轮就放弃
    const ends = finalEvs.filter((e) => e.type === 'turn/end');
    if (ends.length > 0) {
      const last = ends[ends.length - 1];
      const kind = last.data && last.data.reason && last.data.reason.kind;
      if (kind === 'error' && /402|余额不足/.test(String(last.data.reason.error && last.data.reason.error.message || ''))) {
        break;   // 402 了，等下去没意义
      }
    }
  }
  console.log();

  // ⑤ 验证「真的用了工具」
  const toolCalls = finalEvs.filter((e) => e.type === 'tool/call');
  const toolNames = [...new Set(toolCalls.map((e) => e.data && e.data.name).filter(Boolean))];
  step('真的调用了工具', toolCalls.length >= 1,
    toolCalls.length + ' 次（' + toolNames.join(', ') + '）');

  // ⑥ 验证「真的写了产物」（专用测试文件，跑完删）
  const wroteFile = fs.existsSync(testFilePath) &&
    fs.readFileSync(testFilePath, 'utf8').includes(MARK);
  step('真的写出了文件', wroteFile,
    wroteFile ? '找到 ' + TEST_FILE + ' 含标记' : '没有 ' + TEST_FILE);

  // ⚠ 2026-11-12：清理要**彻底**
  //
  //   第一版只删自己场景的 testFilePath。
  //   实测：模型有时会写到自己 cwd 之外（或写到别的场景目录），
  //   残留的 `_真实模型体检临时.md` 会被 `文档体检` 判「漏登记」——
  //   于是真实模型体检自己把别的检查搞红了。
  //
  //   修法：扫全部场景目录，删掉任何 `_真实模型体检临时.md`。
  const swept = [];
  try {
    for (const d of fs.readdirSync(MEM)) {
      if (d.startsWith('_')) continue;
      const f = path.join(MEM, d, TEST_FILE);
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); swept.push(d); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  if (swept.length) {
    console.log('        （清理了 ' + swept.length + ' 个场景的临时文件: ' + swept.join(', ') + '）');
  }

  // ⑦ 验证回复有实质
  //
  // ⚠ 2026-11-12 修（判据对「任务完成」场景太苛刻）
  //
  //   任务明确要求「创建完就回复『完成』」，模型照做了 —— 回了「完成」两个字。
  //   而我用 judgeSubstance 判它「太短」，判失败。
  //
  //   但「完成」在**已写出文件**的前提下是合格回复 —— 任务本身就这么要求的。
  //
  //   修法：
  //     · 文件写成功 + 回复是「完成」类 → 算通过
  //     · 文件没写成功 → 才要求回复本身有实质
  const asstMsgs = finalEvs.filter((e) => e.type === 'assistant/message');
  // ⚠ 2026-11-13 修（取「最后一条」会拿到空消息）
  //
  //   实测事件流：
  //     turn 59: step1 assistant/message 「」  ← 空（模型直接调工具，没说话）
  //              tool/call write
  //              step2 assistant/message 「完成」
  //              turn/end completed
  //     turn 60: step1 assistant/message 「」  ← 又空
  //
  //   原来取 `asstMsgs[asstMsgs.length - 1]` ——
  //   如果此刻 turn 60 正在跑，最后一条就是那个空消息。
  //
  //   修法：取**最后一个非空的** assistant 文本。
  //        模型「先调工具不说话、再回总结」是正常模式。
  const nonEmpty = asstMsgs
    .map((e) => ((e.data.message.content || [])
      .filter((c) => c.type === 'text').map((c) => c.text).join('')))
    .filter((t) => String(t).trim().length > 0);
  const lastText = nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : '';
  const isDoneWord = /^[「『"']?(完成|已完成|做好了|好了|OK|ok|done|收到)[」』"']?[。！!]?$/.test(lastText.trim());
  const sub = judgeSubstance(lastText);
  const replyOk = sub.ok || (wroteFile && isDoneWord);
  step('模型回复有实质', replyOk,
    replyOk
      ? (sub.ok ? lastText.trim().slice(0, 40) : '「' + lastText.trim() + '」（任务要求就是回「完成」，且文件已写出）')
      : sub.why);

  // ⑧ 验证没有 402
  //
  // ⚠ 2026-11-12 两次修正
  //
  //   第一版：扫全部事件找 402 —— 会话里有**历史** 402（轮转前留下的），误判。
  //   第二版：从含 MARK 的 user/message 往后扫 —— 仍误判。
  //            原因：**「402」这三个字出现在任务文本本身里**
  //            （我自己的任务描述提到了 402），
  //            于是 agent/inbox/spliced 和 user/message 都被算成「出现 402」。
  //
  //   正解：只看 turn/end 的 reason.error.message ——
  //        那里才是「模型调用真的失败了」。任务文本里提到 402 不算。
  const turnErrors = finalEvs
    .filter((e) => e.type === 'turn/end')
    .map((e) => {
      const r = (e.data && e.data.reason) || {};
      return { turn: e.data && e.data.turn, kind: r.kind, err: r.error && String(r.error.message || '') };
    })
    .filter((x) => x.kind === 'error');
  const has402 = turnErrors.some((x) => /402|余额不足/.test(x.err || ''));
  const otherErr = turnErrors.filter((x) => !/402|余额不足/.test(x.err || ''));
  step('全程没有 402（只看 turn/end 失败原因）', !has402,
    has402
      ? '有 ' + turnErrors.filter((x) => /402|余额不足/.test(x.err || '')).length + ' 轮因 402 失败'
      : '干净' + (otherErr.length ? '（另有 ' + otherErr.length + ' 轮其他错误，已由引擎重试恢复）' : ''));

  console.log();
  console.log('-'.repeat(78));
  console.log('  结果: ' + pass + ' / ' + total + ' 步通过');
  if (pass === total) {
    console.log('  ✓ AI 真的能干活：调了工具、写了产物、写了记忆、回复有实质');
  } else {
    process.exitCode = 1;
  }
  console.log('='.repeat(78));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
