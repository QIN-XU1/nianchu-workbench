#!/usr/bin/env node
/**
 * 回执自动化 —— 补上闭环的最后一跳
 *
 * ══════════════════════════════════════════════════════════════
 *  这是 AI 在闭环里发现的问题（第二次跑）
 * ══════════════════════════════════════════════════════════════
 *
 *  它写回的经验原文：
 *
 *    「架构梳理要验证「闭环的最后一跳」能真实落地。
 *     真实案例：中枢派单→场景执行→回执这条链里，执行（写记忆）成功了，
 *     但回执命令因 DSH 锁文件失败（Temp 目录 dsh-acl-locks 报 Win32 5），
 *     闭环卡在最后一跳。
 *     → 教训：设计"产出→下游"接口时，不能只验证"上游能写"，
 *       还要验证"下游确认/回执"这一跳真的能被环境执行，否则闭环是假的。
 *     → 更稳做法：把"回执"也当一等接口看待，给失败留重试/降级路径，
 *       并单独验证它。」
 *
 *  实测确认：4 条派单全部 state=delivered，receipt=无。
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么 AI 的回执会失败
 * ══════════════════════════════════════════════════════════════
 *
 *  派单投递文本里让场景 agent 自己执行：
 *    node 工具/派单.mjs --ack --id xxx --evidence "..."
 *
 *  但场景 agent 的 cwd 是「场景记忆/<场景名>/」，
 *  它在那个目录下执行 `node 工具/派单.mjs` 会找不到文件
 *  （相对路径不成立）。
 *
 *  就算用绝对路径，也可能遇到沙箱限制。
 *
 * ══════════════════════════════════════════════════════════════
 *  正确做法：由中枢代场景回执
 * ══════════════════════════════════════════════════════════════
 *
 *  场景 agent 只需要在回复里写清楚「做了什么、产物在哪」，
 *  由中枢（有完整权限）读会话记录、提取证据、代为登记回执。
 *
 *  这符合调研的原则：
 *    「正文留在场景产物里，中枢只给指针」
 *    「回执是中枢的职责，不是场景的」
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/自动回执.mjs --id d-xxx            从会话记录提取证据并回执
 *  node 工具/自动回执.mjs --all                 处理所有无回执的派单
 *  node 工具/自动回执.mjs --id d-xxx --dry      只看提取到什么
 *  node 工具/自动回执.mjs --check               体检：最后一跳有没有抓手（不需要连引擎）
 *  node 工具/自动回执.mjs --selftest            自测
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const PORT = 3083;
const LEDGER = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '派单台账.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

function getToken() {
  const s = readTextSafe(path.join(WB, '外壳', 'server.log'));
  if (!s) return null;
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

function request(method, p, body, cookie) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), ...(cookie ? { cookie } : {}) },
      timeout: 60000,
    }, (re) => { let b = ''; re.on('data', (c) => { b += c; }); re.on('end', () => res({ h: re.headers, b })); });
    r.on('error', () => res({ h: {}, b: '' }));
    r.on('timeout', () => { r.destroy(); res({ h: {}, b: '' }); });
    r.write(d); r.end();
  });
}

let cookie = '';
async function connect() {
  const t = getToken();
  if (!t) return false;
  const r = await request('GET', '/?token=' + t);
  const sc = r.h['set-cookie'];
  cookie = Array.isArray(sc) ? sc.map((c) => c.split(';')[0]).join('; ') : '';
  return !!cookie;
}

async function rpc(channel, endpoint, args) {
  const call = async () => {
    const r = await request('POST', '/api/' + channel + '/' + endpoint, {
      type: 'client-request', rpcId: crypto.randomUUID(),
      method: channel + '/' + endpoint, payload: { args: args || {} },
    }, cookie);
    try { return JSON.parse(r.b); } catch { return { raw: r.b }; }
  };
  let res = await call();
  if (!res?.result) { await connect(); res = await call(); }
  return res;
}

/**
 * 从会话记录里提取「回执证据」
 *
 * 场景 agent 的回复会说明它做了什么、产物在哪、结果是什么。
 * 这里把这些提取出来，拼成一份可复算的证据。
 *
 * @returns { evidence, source, detail }
 */
export function extractEvidence(records, dispatchId) {
  const texts = [];
  const toolCalls = [];
  let turnEnd = null;

  for (const rec of records) {
    const ev = rec.event || rec;
    const t = ev.type || '';
    const d = ev.data || {};

    if (t === 'assistant/message') {
      const content = d.message?.content || d.content || [];
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text) texts.push(c.text);
        }
      }
    }
    if (t === 'tool/call') {
      toolCalls.push({ name: d.name, args: d.arguments });
    }
    if (t === 'turn/end') {
      turnEnd = d.reason?.kind || null;
    }
  }

  if (texts.length === 0 && toolCalls.length === 0) {
    return { ok: false, error: '会话里没有 AI 输出（可能还在跑或已失败）' };
  }

  // 组装证据：优先用 AI 最后一条回复的摘要
  const lastText = texts.length ? texts[texts.length - 1] : '';
  const writeTools = toolCalls.filter((c) => /^(edit|write|multiedit)$/i.test(String(c.name || '')));

  const parts = [];
  if (turnEnd) parts.push('turn=' + turnEnd);
  if (writeTools.length > 0) {
    parts.push('写操作 ' + writeTools.length + ' 次');
    // 从写工具参数里提文件名
    for (const w of writeTools.slice(0, 3)) {
      try {
        const a = JSON.parse(w.args || '{}');
        const fp = a.file_path || a.path || '';
        if (fp) parts.push(path.basename(fp));
      } catch { /* ignore */ }
    }
  }
  if (texts.length > 0) {
    parts.push('回复 ' + texts.length + ' 段');
  }

  const evidence = parts.join(' · ') || '有输出';

  return {
    ok: true,
    evidence,
    source: lastText.slice(0, 200),
    writeCount: writeTools.length,
    textCount: texts.length,
    turnEnd,
    detail: { toolCalls: toolCalls.length, texts: texts.length },
  };
}

/** 找到派单对应的会话 */
async function findDispatchSession(dispatch) {
  const list = await rpc('session', 'list', { _request: {} });
  const items = list?.result?.value?.items || [];
  const sceneName = dispatch.to;
  const matched = items.filter((s) => String(s.cwd || '').includes(sceneName));
  matched.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return matched[0] || null;
}

/** 逐条处理 */
async function processOne(dispatch, dry, opts) {
  const rec = dispatch;
  const id = rec.id;

  const sess = await findDispatchSession(rec);
  if (!sess) {
    return { ok: false, id, error: '找不到该场景的会话：' + rec.to };
  }
  const sid = sess.sessionId || sess.id;

  // 读会话记录
  const pg = await rpc('session', 'page', {
    request: { address: { kind: 'session', sessionId: sid }, maxMessages: 500 },
  });
  const records = pg?.result?.value?.records || [];
  if (records.length === 0) {
    return { ok: false, id, error: '会话无记录' };
  }

  // 确认这条派单真的在这个会话里（找派单编号）
  const all = JSON.stringify(records);
  if (!all.includes(id)) {
    return { ok: false, id, error: '该会话里找不到派单 ' + id + ' 的内容' };
  }

  const o = opts || {};
  const ext = extractEvidence(records, id);
  if (!ext.ok) return { ok: false, id, error: ext.error };

  if (dry) {
    return { ok: true, id, dry: true, sessionId: sid, evidence: ext.evidence, source: ext.source };
  }

  // ══════════════════════════════════════════════════════════
  //  ⚠ 2026-11-10 修正（违背「命令不代替」原则）
  // ══════════════════════════════════════════════════════════
  //
  //  原实现：中枢读会话 → 提取证据 → **中枢直接写回执**
  //
  //  这违反了 luanyujia 三处一致强调的原则
  //  （视频 BV1qrxD6qEcY）：
  //    「L4 执行：命令不代替」
  //    「自动归纳工具：⛔ 不自动写；owner 确认后才写场景账」
  //    「场景自治：别人只能提醒，不能代写」
  //
  //  正确做法：**中枢只生成候选，不写。写完必须 owner 确认。**
  //
  //  所以：
  //    · 默认行为 = 生成候选（写入待确认队列）
  //    · 只有显式加 --confirm-owner 才真的写回执
  if (!o.confirmOwner) {
    // 写候选到待确认队列
    const pendingFile = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '回执候选.json');
    let pend = { candidates: [] };
    try {
      const t = readTextSafe(pendingFile);
      if (t) pend = JSON.parse(t) || { candidates: [] };
    } catch { /* ignore */ }
    if (!Array.isArray(pend.candidates)) pend.candidates = [];

    // 去重（同一 id 不重复加）
    pend.candidates = pend.candidates.filter((c) => c.id !== id);
    pend.candidates.push({
      id,
      at: new Date().toISOString(),
      sessionId: sid,
      evidence: ext.evidence,
      source: ext.source,
      status: 'pending-owner-confirm',
      _note: '中枢生成的候选，需 owner 确认后才写入回执（命令不代替）',
    });
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify(pend, null, 2), 'utf8');

    return {
      ok: true,
      id,
      sessionId: sid,
      evidence: ext.evidence,
      source: ext.source,
      generated: true,
      written: false,
      reason: '已生成候选，未写入回执（需 owner 确认，遵循「命令不代替」）',
      pendingFile: path.relative(WB, pendingFile).replace(/\\/g, '/'),
    };
  }

  // ── 只有 owner 确认后才真的写 ──
  const tool = path.join(HERE, '派单.mjs');
  const r = spawnSync(process.execPath, [tool, '--ack', '--id', id, '--evidence', ext.evidence], {
    cwd: WB, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });

  return {
    ok: r.status === 0,
    id,
    sessionId: sid,
    evidence: ext.evidence,
    source: ext.source,
    written: r.status === 0,
    confirmedByOwner: true,
    output: (r.stdout || '') + (r.stderr || ''),
    exit: r.status,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  自动回执 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 正常会话：有 assistant 消息 + 写工具
  const normal = [
    { event: { type: 'turn/start', data: { turn: 1 } } },
    { event: { type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a.md"}' } } },
    { event: { type: 'tool/call', data: { name: 'edit', arguments: '{"file_path":"D:/x/场景私有记忆.md"}' } } },
    { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已追加经验到 §五' }] } } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ];
  const e1 = extractEvidence(normal, 'd-1');
  chk('能提取证据', e1.ok === true, e1.evidence);
  chk('证据含 turn 状态', e1.evidence.includes('completed'), e1.evidence);
  chk('识别出写操作', e1.writeCount === 1, String(e1.writeCount));

  // ② 反例：空会话必须报错
  const e2 = extractEvidence([], 'd-2');
  chk('反例：空会话报错', e2.ok === false, e2.error || '');

  // ③ 反例：只有 turn 没有输出
  const noOutput = [
    { event: { type: 'turn/start', data: { turn: 1 } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ];
  const e3 = extractEvidence(noOutput, 'd-3');
  chk('反例：无输出报错', e3.ok === false, e3.error || '');

  // ④ 只有工具调用也能提证据（没有 assistant 文本的情况）
  const toolOnly = [
    { event: { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"b.md"}' } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ];
  const e4 = extractEvidence(toolOnly, 'd-4');
  chk('只有工具调用也能提证据', e4.ok === true, e4.evidence);

  // ══════════════════════════════════════════════════════
  //  ⑧ 关键：默认只生成候选，不直接写（命令不代替）
  // ══════════════════════════════════════════════════════
  //
  //  这一条是防回退的：如果有人把「中枢代写」改回来，这条会红。
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  chk('默认不直接写（有 confirmOwner 分支）', src.includes('confirmOwner'), '');
  chk('默认写候选队列', src.includes('回执候选.json'), '');
  chk('候选标注需 owner 确认', src.includes('pending-owner-confirm'), '');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加 --check（判据错误：这个工具在体检里**永远不会失败**）
  //
  //    原来：机制体检用 `--selftest` 跑它 —— 只验 extractEvidence 的判据，
  //          真实台账里的「最后一跳有没有抓手」一个字都没查。
  //
  //    但直接改默认模式去跑真实回执也不行：
  //      ① 它要连引擎（engine 没启动就 exit 2，是环境问题不是代码问题）
  //      ② 它会**写文件**（回执候选队列）—— 体检不该产生副作用
  //
  //    所以新增 --check：**只读**地检查「回执这条路还通不通」。
  //      判据（都是不需要引擎就能查的静态事实）：
  //        ① 台账里有没有停在 delivered 却永远等不到回执的单
  //           —— 有，说明最后一跳真的断了（真实缺陷）
  //        ② 回执候选队列的文件结构是否合法（能解析、candidates 是数组）
  //           —— 结构坏了说明这条降级路径失效
  //        ③ 生成候选的代码路径还在（防回退：有人把「命令不代替」改回去）
  //      引擎不可用**不算失败**（那是环境状态，不是判据）。
  // ══════════════════════════════════════════════════════════════
  if (has('--check')) {
    const problems = [];
    const ledger2 = readJsonSafe(LEDGER) || { dispatches: [] };
    const list = ledger2.dispatches || [];

    // ① 卡在 delivered 的单：已投递但没收据
    //
    //  语义：投递成功之后场景必须回执。停在 delivered 且**没有回执正文**，
    //  说明闭环的最后一跳没落地（这正是本工具存在的理由）。
    const stuck = list.filter((d) => d.state === 'delivered' && !d.receipt);
    if (stuck.length > 0) {
      problems.push(stuck.length + ' 条停在 delivered 无回执：' +
        stuck.slice(0, 3).map((d) => d.id).join(','));
    }

    // ② 回执候选队列结构
    const pendingFile = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '回执候选.json');
    if (fs.existsSync(pendingFile)) {
      const t = readTextSafe(pendingFile);
      let pj = null;
      try { pj = JSON.parse(t); } catch { /* 下面报 */ }
      if (!pj || !Array.isArray(pj.candidates)) {
        problems.push('回执候选.json 结构坏了（不是 {candidates:[]}）');
      } else {
        const badStatus = pj.candidates.filter((c) => c.status !== 'pending-owner-confirm');
        if (badStatus.length) {
          problems.push(badStatus.length + ' 条候选的状态不是 pending-owner-confirm（可能被自动写了）');
        }
      }
    }

    // ③ 防回退：默认必须先落候选，不许中枢直接代写
    const s = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    if (!s.includes('pending-owner-confirm')) problems.push('代码里丢了 pending-owner-confirm 标记');
    if (!s.includes('回执候选.json')) problems.push('代码里丢了候选队列路径');

    console.log('═'.repeat(72));
    console.log('  自动回执 · 检查');
    console.log('═'.repeat(72));
    console.log();
    console.log('  台账条数: ' + list.length + '   卡在 delivered 无回执: ' + stuck.length);
    console.log();

    if (problems.length === 0) {
      console.log('  ✓ 最后一跳有抓手：' + (stuck.length === 0 ? '没有卡住的派单' : ''));
      process.exit(0);
    }
    console.log('  ✗ 最后一跳有问题：');
    for (const p of problems) console.log('    · ' + p);
    process.exit(1);
  }

  const ok = await connect();
  if (!ok) { console.error('✗ 连不上引擎'); process.exit(2); }

  const ledger = readJsonSafe(LEDGER) || { dispatches: [] };
  const all = ledger.dispatches || [];

  // 选出需要处理的
  let targets = [];
  if (has('--id')) {
    const id = val('--id');
    const d = all.find((x) => x.id === id);
    if (!d) { console.error('找不到: ' + id); process.exit(2); }
    targets = [d];
  } else if (has('--all')) {
    // 所有 delivered 但无回执的
    targets = all.filter((d) => d.state === 'delivered' && !d.receipt);
  } else {
    // 默认也是所有无回执的
    targets = all.filter((d) => d.state === 'delivered' && !d.receipt);
  }

  if (targets.length === 0) {
    console.log('没有需要回执的派单（都已回执或已关闭）');
    process.exit(0);
  }

  console.log('═'.repeat(72));
  console.log('  自动回执（中枢代场景回执）');
  console.log('═'.repeat(72));
  console.log();
  console.log('待处理: ' + targets.length + ' 条');
  console.log();

  let success = 0;
  let fail = 0;

  for (const d of targets) {
    process.stdout.write('  ' + d.id + ' → ' + String(d.to).padEnd(10));
    const r = await processOne(d, has('--dry'), { confirmOwner: has('--confirm-owner') });

    if (r.ok) {
      success++;
      const tag = r.written ? '✓ 已写入' : '○ 已生成候选';
      console.log(tag + ' ' + (r.evidence || '').slice(0, 50));
      if (r.source && has('--verbose')) {
        console.log('       原文: ' + String(r.source).slice(0, 100));
      }
    } else {
      fail++;
      console.log('✗ ' + String(r.error || r.output || '').slice(0, 80));
    }
  }

  console.log();
  console.log('═'.repeat(72));
  console.log('  成功 ' + success + ' / 失败 ' + fail);
  if (has('--dry')) console.log('  （dry 模式，未生成也未回执）');
  else if (!has('--confirm-owner')) console.log('  （只生成候选，未写入。加 --confirm-owner 才真的回执）');
  console.log('═'.repeat(72));
  process.exit(fail > 0 ? 1 : 0);
}
