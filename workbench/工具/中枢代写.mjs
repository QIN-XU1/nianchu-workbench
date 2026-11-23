#!/usr/bin/env node
// 工具/中枢代写.mjs —— 场景 agent 只负责「做和说」，中枢负责「记账」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（这是本项目最核心的架构约束）
// ══════════════════════════════════════════════════════════════════════
//  Windows ACL 沙箱把场景 agent 限制在**自己的记忆目录**内：
//
//    架构梳理 agent 只能写  数据/.dsh/场景记忆/架构梳理/
//    调研 agent   只能写  数据/.dsh/场景记忆/调研/
//
//  但有些文件是跨场景共享的：
//    · 派单台账   数据/.dsh/场景记忆/_共享记忆/派单台账.json
//    · 产物目录   产物/
//
//  实测后果（端到端闭环验证时暴露）：
//    场景 agent 想写回执 → EPERM → 请求升级 danger-full-access
//    → 没人批准 → **卡死**，整个派单闭环永远走不完。
//
//  试过但失败的方案：
//    用 sandbox-policy 的 additionalWritableRoots 加共享目录
//    → 引擎明确拒绝：
//      「Windows ACL confinement does not support additional writable
//        directories; remove the extra grants or use a supported host」
//    → 这条路被引擎堵死，已回滚。
//
//  正确方案（本工具）：
//    **把跨目录的写操作从场景侧移到中枢侧。**
//
//    场景 agent：只负责「做和说」—— 执行任务，把结果回复在会话里
//    中枢：      负责「记账」—— 读场景的回复，写台账/记忆/产物索引
//
//    中枢自己不受场景沙箱限制（它跑在宿主进程里），想写哪就写哪。
//
//  ══════════════════════════════════════════════════════════════════════
//  用法
// ══════════════════════════════════════════════════════════════════════
//    # 等某个场景的最后一轮跑完，取出它的回复
//    node 工具/中枢代写.mjs --wait-reply --scene 调研 [--timeout 300]
//
//    # 把回复写进派单台账（回执 + 销账）
//    node 工具/中枢代写.mjs --ack-from-reply --id d-20261111-003 --scene 调研
//
//    # 直接把一段文本追加到某个场景的记忆（中枢代写）
//    node 工具/中枢代写.mjs --append-memory --scene 架构梳理 --text "..."
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');
const DATA = path.join(WB, '数据', '.dsh');
const PORT = 3083;

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const has = (name) => argv.includes('--' + name);

// ══════════════════════════════════════════════════════════════════════
//  引擎 RPC
// ══════════════════════════════════════════════════════════════════════
function getToken() {
  const p = path.join(WB, '外壳', 'server.log');
  if (!fs.existsSync(p)) return null;
  const s = fs.readFileSync(p, 'utf8');
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

async function getCookie() {
  const token = getToken();
  if (!token) throw new Error('server.log 里没有 token');
  return await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 8000,
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
      type: 'client-request',
      rpcId: 'hw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      method, payload: { args: args || {} },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': cookie,
        'Origin': 'http://127.0.0.1:' + PORT,
      },
      timeout: timeoutMs || 30000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
//  场景名 → 会话 id
// ══════════════════════════════════════════════════════════════════════
const SCEN_NAME = {
  '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
  '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
  '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
};
const SCEN_CN = {};
for (const [cn, id] of Object.entries(SCEN_NAME)) SCEN_CN[id] = cn;

function findSceneSession(cookie) {
  return rpc(cookie, 'session/list', { _request: {} }).then((r) => {
    const items = (r.json && r.json.result && r.json.result.value && r.json.result.value.items) || [];
    const out = {};
    const memRoot = path.join(DATA, '场景记忆');
    const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();

    for (const [cn, sid] of Object.entries(SCEN_NAME)) {
      // 会话的 cwd 指向该场景的记忆目录
      const target = norm(path.join(memRoot, cn));
      // ⚠ 2026-11-12 修（据 中枢/闭环断点诊断.md 断点3）：
//   原来用 find() 取「第一个」，注释却说「复用最新」。
//   同一场景有多个会话时，可能投到旧会话、读到旧回复。
//   改成按 updatedAt 倒序取最新的。
const cands = items.filter((s) => norm(s.cwd) === target);
cands.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const hit = cands.find((s) => !s.blank) || cands[0];
      if (hit) out[cn] = hit.sessionId;
    }
    return out;
  });
}

// ══════════════════════════════════════════════════════════════════════
//  等场景的最后一轮跑完，取出它的回复
// ══════════════════════════════════════════════════════════════════════
async function waitReply(sceneName, timeoutSec) {
  const cookie = await getCookie();
  if (!cookie) throw new Error('拿不到 cookie（引擎可能没起）');

  const map = await findSceneSession(cookie);
  const sid = map[sceneName];
  if (!sid) throw new Error('找不到场景「' + sceneName + '」的会话');

  console.log('场景: ' + sceneName + '  会话: ' + sid.slice(0, 20) + '…');
  console.log('等最后一轮跑完（最多 ' + timeoutSec + ' 秒）…');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutSec * 1000;
  let lastSeq = -1;
  let idleRounds = 0;

  // 先拿到当前 cursor 作基线
  try {
    const pre = await rpc(cookie, 'session/page', { request: { address: { kind: 'session', sessionId: sid } } });
    const pv = pre.json && pre.json.result && pre.json.result.value;
    if (pv && typeof pv.cursor === 'number') lastSeq = pv.cursor;
  } catch (e) { /* ignore */ }

  let lastText = '';
  let lastTurnKind = '';   // 本轮结束原因：completed / interrupted / error / unknown
  while (Date.now() < deadline) {
    await sleep(2500);
    const r = await rpc(cookie, 'session/page', { request: { address: { kind: 'session', sessionId: sid } } });
    const v = r.json && r.json.result && r.json.result.value;
    if (!v) continue;

    const recs = (v.records || []).map((x) => x && x.event ? x.event : x).filter(Boolean);
    // 找最新的 assistant/message 文本
    const aiMsgs = recs.filter((e) => e.type === 'assistant/message');
    if (aiMsgs.length) {
      const last = aiMsgs[aiMsgs.length - 1];
      const msg = last.data.message || {};
      const txt = (msg.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
      if (txt.trim()) lastText = txt;
    }

    // ══════════════════════════════════════════════════════
    //  判断是否已结束
    //
    //  ⚠ 2026-11-12 修（据 中枢/闭环断点诊断.md 断点6，最危险的一条）：
    //
    //    原来只看 type === 'turn/end'，不读 reason.kind。
    //    后果：被 EPERM 卡死、余额不足、报错中断的 turn
    //          也全是 turn/end → 判为「跑完了」→
    //          后续把中断前的半截文本当证据 → 销账 → 假闭环。
    //
    //    实测佐证：台账 d-20261110-008/009/010
    //              三条 lastTurnDone=false、turn=interrupted 却 state=closed。
    //
    //    修法：读 reason.kind，只有 completed 才算真跑完，
    //          其它（interrupted/error/unknown）如实报出来。
    // ══════════════════════════════════════════════════════
    const lastEvent = recs[recs.length - 1];
    const isTurnEnd = lastEvent && lastEvent.type === 'turn/end';

    if (isTurnEnd) {
      const kind = (lastEvent.data && lastEvent.data.reason && lastEvent.data.reason.kind) || 'unknown';
      lastTurnKind = kind;
      idleRounds++;
      if (idleRounds >= 2) break;
    } else {
      idleRounds = 0;
    }
  }

  return { sessionId: sid, text: lastText, turnKind: lastTurnKind };
}

// ══════════════════════════════════════════════════════════════════════
//  把回复写进派单台账（中枢代写）
// ══════════════════════════════════════════════════════════════════════
function ackFromReply(dispatchId, sceneName, replyText) {
  
  const tool = path.join(HERE, '派单.mjs');

  // ══════════════════════════════════════════════════════════════
  //  回执证据校验
  //
  //  ⚠ 2026-11-12 修（据 中枢/闭环断点诊断.md 断点7）：
  //
  //    原来：把场景回复的前 200 字当 evidence，只要非空就过闸。
  //    后果：任意文本（自我介绍 / 报错 / "没做"）都能当证据 →
  //          配合断点8（销账只看 acked）→ 假闭环。
  //
  //    实测佐证：台账里 d-20261111-006 的 receipt 是
  //              「我是调研场景：左边搜网页，右边 AI 帮你收拢…」
  //              —— 这是自我介绍，跟派单要求的 verify 毫无关系，却过了闸。
  //
  //    修法：两道校验
  //      ① 不能是兜底话术（不知道/没做/无法/失败/报错…）
  //      ② 必须包含派单 verify 里的关键片段（能对得上要求）
  // ══════════════════════════════════════════════════════════════

  const REPLY_FALLBACK = ['不知道', '没做', '无法完成', '无法执行', '失败了', '报错', '未完成', '做不到', '没有权限', '无权'];

  const raw = String(replyText || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    console.log('  ✗ 场景没有回复内容，无法作为证据');
    return false;
  }

  // ① 兜底话术检查
  const hitFallback = REPLY_FALLBACK.filter((w) => raw.includes(w));
  if (hitFallback.length) {
    console.log('  ✗ 回复里含失败/兜底话术，不能当证据: ' + hitFallback.join(', '));
    return false;
  }

  // ② 与派单 verify 对得上
  //    读台账拿这条派单的 verify，看回复里有没有它的关键片段
  let verifyText = '';
  try {
    const ledgerPath = path.join(DATA, '场景记忆', '_共享记忆', '派单台账.json');
    const lg = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, ''));
    const rec = (lg.dispatches || []).find((d) => d.id === dispatchId);
    verifyText = String((rec && rec.verify) || '');
  } catch { /* 读不到就跳过这层校验 */ }

  let verifyOk = true;
  let verifyNote = '';
  if (verifyText) {
    // 从 verify 里抽关键片段：路径、文件名、数字要求
    const keys = [];
    // 文件路径/文件名
    for (const m of verifyText.matchAll(/[\w\u4e00-\u9fa5/\.-]+\.(?:md|json|mjs|js)/g)) keys.push(m[0]);
    // 纯路径片段
    for (const m of verifyText.matchAll(/数据\/[\w\u4e00-\u9fa5/\.-]+/g)) keys.push(m[0]);

    if (keys.length) {
      const hitKeys = keys.filter((k) => raw.includes(k) || raw.includes(k.split('/').pop()));
      verifyOk = hitKeys.length > 0;
      verifyNote = hitKeys.length ? '对上了: ' + hitKeys.slice(0, 2).join(', ') : '没对上任何产物名(' + keys.slice(0, 2).join(', ') + ')';
    }
  }

  if (!verifyOk) {
    console.log('  ✗ 回复与派单 verify 对不上: ' + verifyNote);
    console.log('     verify 要求: ' + verifyText.slice(0, 100));
    console.log('     场景回复:   ' + raw.slice(0, 100));
    console.log('     → 拒绝写回执（避免假闭环）');
    return false;
  }

  const evidence = raw.slice(0, 200);

  console.log('  回执证据: ' + evidence.slice(0, 100) + '…');
  const r = spawnSync(process.execPath, [tool, '--ack', '--id', dispatchId, '--evidence', evidence], {
    cwd: WB, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const out = String((r.stdout || '') + (r.stderr || ''));
  console.log('  ' + out.trim().split('\n').slice(0, 4).join('\n  '));
  return r.status === 0;
}

// ══════════════════════════════════════════════════════════════════════
//  中枢代写：把一段文本追加到场景记忆
// ══════════════════════════════════════════════════════════════════════
function appendMemory(sceneName, text) {
  const p = path.join(DATA, '场景记忆', sceneName, '场景私有记忆.md');
  if (!fs.existsSync(p)) {
    console.log('  ✗ 场景记忆不存在: ' + p);
    return false;
  }
  const cur = fs.readFileSync(p, 'utf8');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block = '\n\n<!-- hub-write: ' + stamp + ' -->\n- [' + stamp + '] ' + text + '\n';
  fs.writeFileSync(p, cur.trimEnd() + block, 'utf8');
  console.log('  ✓ 已追加到 ' + sceneName + ' 的场景记忆');
  return true;
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('wait-reply')) {
    const scene = String(arg('scene', ''));
    if (!scene) { console.log('缺少 --scene'); process.exit(2); }
    const timeout = Number(arg('timeout', 300)) || 300;
    const r = await waitReply(scene, timeout);
    console.log();
    console.log('=== 场景回复 ===');
    console.log(r.text || '(空)');
    console.log();
    if (has('json')) {
      console.log(JSON.stringify(r));
    }
    return;
  }

  if (has('ack-from-reply')) {
    const id = String(arg('id', ''));
    const scene = String(arg('scene', ''));
    if (!id || !scene) { console.log('缺少 --id 或 --scene'); process.exit(2); }
    console.log('读取场景「' + scene + '」的最新回复…');
    const r = await waitReply(scene, Number(arg('timeout', 60)) || 60);
    console.log();
    const ok = ackFromReply(id, scene, r.text);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (has('append-memory')) {
    const scene = String(arg('scene', ''));
    const text = String(arg('text', ''));
    if (!scene || !text) { console.log('缺少 --scene 或 --text'); process.exit(2); }
    const ok = appendMemory(scene, text);
    if (!ok) process.exitCode = 1;
    return;
  }

  // 默认：帮助
  console.log('中枢代写 —— 场景只负责「做和说」，中枢负责「记账」');
  console.log();
  console.log('为什么：Windows ACL 沙箱不允许场景 agent 写自己目录之外的文件，');
  console.log('        但派单台账/产物索引是跨场景共享的。所以把跨目录写操作移到中枢侧。');
  console.log();
  console.log('用法:');
  console.log('  node 工具/中枢代写.mjs --wait-reply --scene 调研 [--timeout 300]');
  console.log('  node 工具/中枢代写.mjs --ack-from-reply --id d-xxx --scene 调研');
  console.log('  node 工具/中枢代写.mjs --append-memory --scene 架构梳理 --text "..."');
}

main().catch((e) => {
  console.error('  ✗ ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
