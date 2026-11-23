#!/usr/bin/env node
// 工具/沙箱体检.mjs —— DSH 沙箱工具可用性检查
//
// ══════════════════════════════════════════════════════════════════════
//  为什么有这个工具
// ══════════════════════════════════════════════════════════════════════
//  2026-11-11 事故：主 Agent 的 pwsh 和 glob 两个核心工具全部失效，
//  但 read / write 正常。表现是：
//      pwsh → Error: CreateFileW failed (Win32 5): ...dsh-acl-locks\xxx.lock
//      glob → Error: glob could not start its search command
//             (ripgrep launch failed)
//
//  根因：DSH 沙箱把子进程令牌降级为 Low 完整性。
//        Windows 的 MIC 规定 Low 进程不能写 Medium 对象（即使 ACL 允许）。
//        而 %TEMP% 是 Medium → 沙箱创建 ACL 锁文件、mkdtemp 都被拒。
//
//  修法：给引擎一个项目内的 .dsh-temp，并给它加 Low 完整性标签。
//
//  ══════════════════════════════════════════════════════════════════
//  为什么不能只查目录和标签
//  ══════════════════════════════════════════════════════════════════
//  这次事故里，我连续误判了三次：
//    ① 以为是 ACL 权限问题 → 跑 skill 诊断 → NOT_THIS_CLASS
//    ② 以为是 AppContainer 没授权 → 加了 S-1-4-* → 仍失败
//    ③ 以为是权限位缺 READ_CONTROL → 改成 Modify → 仍失败
//  真正的原因是**完整性级别**，前三次都只是「看起来像」。
//
//  所以这个工具**必须有真的跑一次的工具调用**，
//  不能只检查文件系统状态 —— 那是「我以为」，不是判据。
//
//  ══════════════════════════════════════════════════════════════════
//  检查项
// ══════════════════════════════════════════════════════════════════
//    ① .dsh-temp 目录存在
//    ② .dsh-temp 有 Low 完整性标签
//    ③ dsh-acl-locks 在 .dsh-temp 下（不是 %TEMP%）
//    ④ dsh-acl-locks 有 Low 标签（含继承）
//    ⑤ 真实跑一次 agent 的 pwsh 工具 —— **唯一真正的判据**
//    ⑥ 真实跑一次 agent 的 glob 工具
//
//  用法：
//    node 工具/沙箱体检.mjs            # 完整检查（需要工作台在跑）
//    node 工具/沙箱体检.mjs --offline  # 只查文件系统（不跑工具）
//    node 工具/沙箱体检.mjs --selftest # 自测（含反例）
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WB = path.resolve(__dirname, '..');                 // workbench/
const ROOT = path.resolve(WB, '..');                      // 项目根
const DATA = path.join(WB, '数据');
const LOW_TEMP = path.join(DATA, '.dsh-temp');
const LOCK_DIR = path.join(LOW_TEMP, 'dsh-acl-locks');

const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
const OFFLINE = argv.includes('--offline');

const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok, detail });
  console.log('  ' + (ok ? 'OK  ' : 'XX  ') + name + (detail ? '  ' + detail : ''));
}

// ══════════════════════════════════════════════════════════════════════
//  文件系统检查
// ══════════════════════════════════════════════════════════════════════

/** 用 icacls 读 Low 完整性标签 */
function hasLowLabel(p) {
  try {
    const out = execFileSync('icacls', [p], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return /Mandatory Label\\Low Mandatory Level/i.test(out);
  } catch (e) {
    return false;
  }
}

function checkFs() {
  // ① .dsh-temp 存在
  const tempExists = fs.existsSync(LOW_TEMP);
  chk('.dsh-temp 目录存在', tempExists, tempExists ? LOW_TEMP.replace(ROOT + '\\', '') : '缺失');
  if (!tempExists) return;

  // ② .dsh-temp 有 Low 标签
  chk('.dsh-temp 有 Low 完整性标签', hasLowLabel(LOW_TEMP), '');

  // ③ dsh-acl-locks 位置正确
  const lockExists = fs.existsSync(LOCK_DIR);
  chk('dsh-acl-locks 在 .dsh-temp 下', lockExists,
    lockExists ? '' : '不在（可能仍在 %TEMP%，沙箱会失败）');
  if (!lockExists) return;

  // ④ dsh-acl-locks 有 Low 标签
  chk('dsh-acl-locks 有 Low 完整性标签', hasLowLabel(LOCK_DIR), '');

  // 附：锁文件数
  try {
    const n = fs.readdirSync(LOCK_DIR).filter((f) => f.endsWith('.lock')).length;
    if (n > 0) console.log('       锁文件: ' + n + ' 个');
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════
//  真实工具调用（唯一真正的判据）
// ══════════════════════════════════════════════════════════════════════
const get = (u) => new Promise((res, rej) => {
  const r = http.get(u, { timeout: 5000 }, (s) => { let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => res(d)); });
  r.on('error', rej);
  r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 server.log 拿最新 token 换 cookie */
async function getCookie() {
  const logPath = path.join(WB, '外壳', 'server.log');
  if (!fs.existsSync(logPath)) throw new Error('server.log 不存在');
  const log = fs.readFileSync(logPath, 'utf8');
  const ms = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)];
  const token = ms.length ? ms[ms.length - 1][1] : '';
  if (!token) throw new Error('server.log 里没有 token');

  return await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3083,
      path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 5000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function rpc(cookie, method, args, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'sbx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      method, payload: { args: args || {} },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/api/' + method, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': cookie,
        'Origin': 'http://127.0.0.1:3083',
      },
      timeout: timeoutMs || 30000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.write(body);
    req.end();
  });
}

/**
 * 发一条 prompt，等这一轮结束，收集工具调用和结果
 * @returns {{ tools: Array<{name, args, result}>, aiText: string }}
 */
async function runPrompt(cookie, sessionId, text, maxWaitMs) {
  // ⚠ 2026-11-11 关键修复：发送前先记下当前游标。
  //
  //   原来这里直接发 prompt 然后从一开始读事件，结果：
  //     · 上一轮的 turn/end 还在记录里 → 立刻判定「本轮结束」
  //     · 拿到的 tool/result 是上一轮的，甚至为空
  //   实测症状：glob 明明成功（手动验证返回 6 个文件），
  //             但体检报「输出: 」（空字符串）。
  //
  //   修法：发送前先读一次历史，记下最大 seq 作为基线，只处理 > 基线的。
  let baseSeq = 0;
  try {
    const pre = await rpc(cookie, 'session/page', {
      request: { address: { kind: 'session', sessionId } },
    });
    const pv = pre.json && pre.json.result && pre.json.result.value;
    if (pv && typeof pv.cursor === 'number') baseSeq = pv.cursor;
  } catch (e) { /* 拿不到就从头读 */ }

  await rpc(cookie, 'session/prompt', {
    request: {
      requestId: 'sbx-' + Date.now(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  });

  const deadline = Date.now() + (maxWaitMs || 90000);
  const seen = new Set();
  const tools = [];
  let aiText = '';
  let ended = false;

  while (Date.now() < deadline && !ended) {
    await sleep(1500);
    const page = await rpc(cookie, 'session/page', {
      request: { address: { kind: 'session', sessionId } },
    });
    const v = page.json && page.json.result && page.json.result.value;
    if (!v) continue;

    for (const rec of v.records || []) {
      const e = rec && rec.event ? rec.event : rec;
      if (!e || e.seq == null) continue;
      if (e.seq <= baseSeq) continue;      // ★ 只处理本轮新增
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);

      if (e.type === 'tool/call') {
        tools.push({ name: e.data.name, args: e.data.arguments, result: null });
      }
      if (e.type === 'tool/result' && tools.length) {
        const msg = e.data.message || {};
        const txt = (msg.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
        const target = tools[tools.length - 1];
        if (target.result === null) target.result = txt;
        else target.result += '\n' + txt;
      }
      if (e.type === 'assistant/message') {
        const msg = e.data.message || {};
        const txt = (msg.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
        if (txt.trim()) aiText = txt;
      }
      if (e.type === 'turn/end') ended = true;
    }
  }

  return { tools, aiText };
}

async function checkRuntime() {
  let cookie = '';
  try {
    cookie = await getCookie();
  } catch (e) {
    chk('引擎可连接', false, String(e.message).slice(0, 60));
    return;
  }
  if (!cookie) {
    chk('引擎可连接', false, '拿不到 cookie（引擎可能没起）');
    return;
  }
  chk('引擎可连接', true);

  // 建一个测试会话（不污染中枢的历史）
  const cwd = path.join(DATA, '.dsh', '场景记忆', '中枢');
  const c = await rpc(cookie, 'session/create', { request: { cwd } }, 40000);
  const sid = c.json && c.json.result && c.json.result.value && c.json.result.value.sessionId;
  if (!sid) {
    chk('创建测试会话', false, '失败');
    return;
  }
  chk('创建测试会话', true, sid.slice(0, 20) + '…');

  // ⑤ 真实跑 pwsh
  console.log();
  console.log('  ── 真实工具调用（这是唯一真正的判据）──');
  let r1 = null;
  try {
    r1 = await runPrompt(cookie, sid,
      '请只用 pwsh 工具执行 `Write-Output "SANDBOX-PROBE-OK"`，然后把工具的原始输出贴给我。不要用别的工具。', 90000);
  } catch (e) { /* ignore */ }

  const pwshTool = r1 && r1.tools.find((t) => t.name === 'pwsh');
  const pwshResult = (pwshTool && pwshTool.result) || '';
  const pwshOk = /SANDBOX-PROBE-OK/.test(pwshResult) && !/Error:|EPERM|Win32/.test(pwshResult);
  chk('pwsh 工具真的能执行命令', pwshOk,
    pwshOk ? '输出含 SANDBOX-PROBE-OK' : '输出: ' + pwshResult.slice(0, 90).replace(/\n/g, ' '));

  // ⑥ 真实跑 glob
  let r2 = null;
  try {
    r2 = await runPrompt(cookie, sid,
      '请只用 glob 工具找出当前目录下所有的 .md 文件（pattern 用 **/*.md），把结果原样贴给我。', 90000);
  } catch (e) { /* ignore */ }

  const globTool = r2 && r2.tools.find((t) => t.name === 'glob');
  const globResult = (globTool && globTool.result) || '';
  const globOk = globResult.length > 0 && !/ripgrep launch failed|Error:/.test(globResult);
  chk('glob 工具真的能搜索文件', globOk,
    globOk ? '返回 ' + globResult.split('\n').filter(Boolean).length + ' 行' :
      '输出: ' + globResult.slice(0, 90).replace(/\n/g, ' '));
}

// ══════════════════════════════════════════════════════════════════════
//  自测（含反例 —— AGENTS.md：自证必须带会失败的反例）
// ══════════════════════════════════════════════════════════════════════
async function selftest() {
  console.log('═'.repeat(72));
  console.log('  沙箱体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】Low 标签检测');
  // 正例：真的有 Low 标签的目录
  const lowTarget = fs.existsSync(LOW_TEMP) ? LOW_TEMP : null;
  if (lowTarget) {
    chk('正例：.dsh-temp 被检出有 Low 标签', hasLowLabel(lowTarget));
  } else {
    chk('正例：.dsh-temp 存在', false, '目录缺失，跳过');
  }
  // 反例：%TEMP% 应该没有 Low 标签（这是本次事故的根因）
  const sysTemp = process.env.TEMP || process.env.TMP || '';
  if (sysTemp && fs.existsSync(sysTemp)) {
    const sysLow = hasLowLabel(sysTemp);
    chk('反例：系统 %TEMP% 无 Low 标签（检出为 false）', !sysLow,
      sysLow ? '← 竟然有 Low 标签，与预期不符' : '符合预期');
  }

  console.log();
  console.log('【二】错误文本判据');
  // 模拟：失败输出必须被判为失败
  const failTexts = [
    'Error: CreateFileW failed (Win32 5): C:\\...\\dsh-acl-locks\\x.lock',
    'Error: EPERM: operation not permitted, mkdtemp',
    'Error: glob could not start its search command (ripgrep launch failed)',
  ];
  for (const t of failTexts) {
    const looksOk = /SANDBOX-PROBE-OK/.test(t) && !/Error:|EPERM|Win32/.test(t);
    chk('反例：「' + t.slice(0, 32) + '…」被判为失败', !looksOk);
  }
  // 正例：成功输出必须被判为成功
  const okText = 'SANDBOX-PROBE-OK';
  const okLooks = /SANDBOX-PROBE-OK/.test(okText) && !/Error:|EPERM|Win32/.test(okText);
  chk('正例：「SANDBOX-PROBE-OK」被判为成功', okLooks);

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  ' + (f.detail || ''));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (SELFTEST) {
    await selftest();
    return;
  }

  console.log('═'.repeat(72));
  console.log('  DSH 沙箱工具可用性检查');
  console.log('═'.repeat(72));
  console.log();

  console.log('【文件系统】');
  checkFs();

  if (!OFFLINE) {
    await checkRuntime();
  } else {
    console.log();
    console.log('  （--offline：跳过真实工具调用）');
  }

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  const failed = R.filter((x) => !x.ok);
  console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  ' + (f.detail || ''));
    console.log();
    console.log('  排查顺序：');
    console.log('    1. icacls <目录> | Select-String "Mandatory|Low"   看完整性标签');
    console.log('    2. 见 数据/.dsh/事故档案/事故-DSH沙箱工具失效.md');
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

main().catch((e) => {
  console.error('  ✗ 异常: ' + ((e && e.stack) || e));
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
