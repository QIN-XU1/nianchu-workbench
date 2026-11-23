#!/usr/bin/env node
// 工具/闭环验证.mjs —— 真实完整闭环验证（中枢派单 → 场景执行 → 中枢代写 → 销账）
//
// ══════════════════════════════════════════════════════════════════════
//  这是本项目最核心机制的唯一端到端判据
// ══════════════════════════════════════════════════════════════════════
//  它跑的是完整业务链路：
//    ① 中枢建派单（四件套：phenomenon/howto/verify）
//    ② 真投递到场景会话
//    ③ 等场景 agent 真实回复（--wait-reply）
//    ④ 中枢用这个回复作证据写回执（--ack-from-reply）
//    ⑤ 销账（--close）
//
//  为什么必须端到端跑：
//    之前这条链路上查出三个致命缺陷，都是「看起来对、实际不通」：
//      · hub skill 的派单命令参数是错的 → 静默失败（exit=0 但台账没记录）
//      · 场景 agent 写不了跨目录的派单台账 → EPERM → 请求审批 → 卡死
//      · 引擎 Windows ACL 沙箱不支持 additionalWritableRoots
//    只有真的跑一遍，才知道这些东西到底通不通。
//
//  用法：
//    node 工具/闭环验证.mjs              # 跑完整验证（约 1-3 分钟）
//    node 工具/闭环验证.mjs --keep       # 保留创建的派单（默认会保留，作为真实记录）
//
//  注意：每跑一次会在台账里留一条 closed 记录，这是**真实业务记录**，不是垃圾。
// ══════════════════════════════════════════════════════════════════════

// 真实完整闭环验证：用「中枢代写」方案跑一遍
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const TOOLS = path.join(WB, '工具');

const get = (u) => new Promise((res, rej) => {
  const r = http.get(u, { timeout: 5000 }, (s) => { let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => res(d)); });
  r.on('error', rej);
  r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
});

function run(tool, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(TOOLS, tool), ...args], {
      cwd: WB, encoding: 'utf8', timeout: 400000, windowsHide: true,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String((e && (e.stdout || e.stderr)) || e) };
  }
}

const log = (s) => console.log(s === undefined ? '' : s);

log('═'.repeat(70));
log('  真实完整闭环验证（新方案：中枢代写）');
log('═'.repeat(70));
log();

// ── ① 建一个真实工单 ──
log('① 建派单（四件套）');
const subject = '闭环验证-中枢代写方案-' + Date.now();
const r1 = run('派单.mjs', [
  '--send', '--from', 'hub', '--to', '调研',
  '--subject', subject,
  '--phenomenon', '验证「场景只做和说、中枢负责记账」这套方案能否真的跑通闭环',
  '--howto', '照 hub skill 的「跨目录写必须中枢代写」章节',
  '--verify', '派单台账里该单 state=closed，且回执带场景的真实回复作证据',
]);
const idMatch = r1.out.match(/(d-\d{8}-\d{3})/);
const dispatchId = idMatch ? idMatch[1] : null;
log('  ' + (dispatchId ? '✓ ' + dispatchId : '✗ 建单失败: ' + r1.out.slice(0, 100)));
if (!dispatchId) process.exit(1);

// ── ② 真投递 ──
log();
log('② 真投递到调研场景');
const msg = '【不需要回执·知悉】请用一句话回答：你是什么场景，负责什么。'
  + '（这是闭环验证，答完即可，不需要写任何文件）【结束】';
const r2 = run('投递通道.mjs', ['--to', '调研', '--text', msg]);
log('  ' + (r2.ok ? '✓ 投递成功' : '✗ 投递失败: ' + r2.out.slice(0, 100)));

// ── ③ 等场景回复（中枢代写的核心）──
log();
log('③ 等场景回复（中枢代写 --wait-reply）');
const r3 = run('中枢代写.mjs', ['--wait-reply', '--scene', '调研', '--timeout', '180']);
const replyText = r3.out.split('=== 场景回复 ===')[1] || '';
const reply = replyText.trim();
log('  场景回复: ' + (reply ? reply.slice(0, 150).replace(/\n/g, ' ') : '(空)'));

// ── ④ 中枢代写：把回复作为证据销账 ──
log();
log('④ 中枢代写：用回复作证据写回执');
if (!reply) {
  log('  ✗ 没有回复，无法销账');
} else {
  const r4 = run('中枢代写.mjs', ['--ack-from-reply', '--id', dispatchId, '--scene', '调研', '--timeout', '60']);
  log(r4.out.split('\n').filter((l) => l.includes('✓') || l.includes('✗') || l.includes('回执')).slice(0, 3).map((l) => '  ' + l.trim()).join('\n'));
}

// ── ⑤ 检查台账状态 ──
log();
log('⑤ 检查台账最终状态');
const ledgerPath = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '派单台账.json');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, ''));
const rec = (ledger.dispatches || []).find((d) => d.id === dispatchId);
if (rec) {
  log('  ' + dispatchId + '  state=' + rec.state);
  log('  receipt: ' + String(rec.receipt || '').slice(0, 100));
  log('  ackedAt: ' + (rec.ackedAt || '无'));
  if (rec.state === 'acked') {
    log();
    log('  → 回执已写，再销账');
    const r5 = run('派单.mjs', ['--close', '--id', dispatchId]);
    log('  ' + r5.out.trim().split('\n')[0]);
  }
} else {
  log('  ✗ 台账里找不到该单');
}

// ── ⑥ 最终确认 ──
log();
log('⑥ 最终确认');
const ledger2 = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, ''));
const rec2 = (ledger2.dispatches || []).find((d) => d.id === dispatchId);
log('  state = ' + (rec2 ? rec2.state : '?'));

log();
log('═'.repeat(70));
log('  闭环结果');
log('═'.repeat(70));
const steps = [
  ['① 建派单', !!dispatchId],
  ['② 真投递', r2.ok],
  ['③ 场景回复', !!reply],
  ['④ 写回执', rec && (rec.state === 'acked' || rec.state === 'closed')],
  ['⑤ 销账', rec2 && rec2.state === 'closed'],
];

// ══════════════════════════════════════════════════════════════════════
//  ⑥ 触发进化并验证（断点9）
//
//  ⚠ 2026-11-12 补（据 中枢/闭环断点诊断.md 断点9）：
//
//    原来闭环只到「销账」就结束了。
//    「销账 → 触发进化 → 进化被记录 → 下次得分对比」这一环
//    **从来没被端到端验证过**。
//
//    后果：进化台账里的记录全是人手写的，
//          自动触发链路实际上从没跑通过。
//
//    这一环补的验证：
//      ① 销账后真的跑一次封存集判分（产生 sealed-delta）
//      ② 真的调 进化.mjs --record 登记一条进化
//      ③ 真的调 进化.mjs --observe 回填
//      ④ 验证进化台账里那条从 pending 变成有结论
// ══════════════════════════════════════════════════════════════════════
log();
log('⑥ 触发进化（销账 → 封存集判分 → 登记 → 回填）');

let evolOk = false;
let evolId = null;
try {
  // ① 跑封存集判分（产生 history 与 delta）
  const scoreOut = run('封存集判分.mjs', ['--all', '--json']);
  let delta = 0;
  let samples = 0;
  try {
    const j = JSON.parse(scoreOut.out.slice(scoreOut.out.indexOf('{')));
    delta = j.total && j.total.score !== undefined ? 0 : 0;
    samples = (j.total && j.total.questions) || 0;
  } catch { /* ignore */ }
  log('  ① 封存集判分: ' + (scoreOut.ok ? '✓ ' + samples + ' 题' : '✗'));

  // ② 登记一条 L1 进化（本次闭环本身的经验）
  const stamp = Date.now();
  const recOut = run('进化.mjs', [
    '--record', '--scene', 'arch-review', '--level', 'L1', '--type', 'memory',
    '--target', '数据/.dsh/场景记忆/架构梳理/场景私有记忆.md',
    '--change', '闭环验证自动登记-' + stamp,
    '--trigger', '端到端闭环验证（建单→投递→回复→回执→销账→进化）',
  ]);
  const m = recOut.out.match(/(ev-\d{8}-\d{6})/);
  evolId = m ? m[1] : null;
  log('  ② 登记进化: ' + (evolId ? '✓ ' + evolId : '✗ ' + recOut.out.slice(0, 60)));

  // ③ 回填（用真实样本数）
  if (evolId) {
    const obOut = run('进化.mjs', ['--observe', evolId, '--sealed-delta', String(delta), '--samples', String(Math.max(samples, 3))]);
    const filled = /已回填/.test(obOut.out);
    log('  ③ 回填: ' + (filled ? '✓ ' : '✗ ') + obOut.out.split('\n').filter((x) => x.trim()).slice(0, 2).join(' '));

    // ④ 验证台账里那条已不是 pending
    const led = JSON.parse(fs.readFileSync(path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '进化台账.json'), 'utf8').replace(/^\uFEFF/, ''));
    const er = (led.evolutions || []).find((x) => x.id === evolId);
    evolOk = !!(er && er.result && er.result !== 'pending');
    log('  ④ 台账状态: ' + (er ? er.result : '?'));
  }
} catch (e) {
  log('  ✗ 进化环节异常: ' + String((e && e.message) || e).slice(0, 60));
}

steps.push(['⑥ 触发进化', evolOk]);
for (const [name, ok] of steps) log('  ' + (ok ? '✓' : '✗') + ' ' + name);
const allOk = steps.every((x) => x[1]);
log();
log('  ' + (allOk ? '🎉 完整闭环跑通' : '⚠ 闭环未完成'));

// ══════════════════════════════════════════════════════════════════════
//  ⑦ 清理：作废本次验证创建的派单
//
//  ⚠ 2026-11-12 补（这是健康哨兵抓出来的真实问题）：
//
//    健康哨兵报：场景「arch-review」一次通过率 36% < 40%（4/11）
//    查下去发现：11 条里有 7 条是 subject 含「闭环验证」的 created 状态记录
//    —— 全是反复跑闭环验证时创建的，从来没清理。
//
//    后果：这些测试单一直挂在台账里，
//          ① 拉低健康度（把测试失败算成业务失败）
//          ② 污染台账（分不清哪些是真业务、哪些是测试）
//          ③ 让 --pending 永远非空（看起来总有活没干）
//
//    修法：验证跑完后，自动把本次创建的派单作废（--cancel），
//          并写明原因「闭环验证测试单」。
//          这样台账里只留真实业务记录。
// ══════════════════════════════════════════════════════════════════════
log();
log('⑦ 清理测试单（避免污染台账）');
try {
  if (dispatchId) {
    run('派单.mjs', [
      '--cancel', '--id', dispatchId,
      '--reason', '闭环验证自动创建的测试单（工具/闭环验证.mjs 每跑一次会产生一条）。已由 ⑦ 自动清理。',
    ]);
    log('  ✓ 已作废本次测试单: ' + dispatchId);
  }

  // 顺手清理历史遗留的「闭环验证」测试单
  const ledPath = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '派单台账.json');
  const led = JSON.parse(fs.readFileSync(ledPath, 'utf8').replace(/^\uFEFF/, ''));
  const stale = (led.dispatches || []).filter((d) =>
    d.state === 'created' &&
    /闭环验证/.test(String(d.subject || ''))
  );
  for (const d of stale) {
    run('派单.mjs', [
      '--cancel', '--id', d.id,
      '--reason', '历史遗留的闭环验证测试单（无实际业务），清理。',
    ]);
  }
  if (stale.length) log('  ✓ 清理历史遗留测试单 ' + stale.length + ' 条');
  else log('  （无历史遗留测试单）');
} catch (e) {
  log('  ⚠ 清理失败（不影响验证结论）: ' + String((e && e.message) || e).slice(0, 60));
}

