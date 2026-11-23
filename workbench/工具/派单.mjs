#!/usr/bin/env node
/**
 * 派单台账 —— 管理"派出去 / 收到 / 回执"的完整生命周期
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么这层必须有（原项目最贵的教训）
 * ══════════════════════════════════════════════════════════════
 *
 *  真实数据：一天发 36 条"通知"，只有 8 条真投递 = 22% 执行率
 *  机主原话：「你这边派单他们没反应啊」
 *
 *  根因：把"公告"当"派单"用 —— 只写进对方记忆文件，不唤醒。
 *       更要命的是：没有"未回执"状态，派单扔进黑洞也没人知道。
 *
 *  MySQL 里叫"消息投递语义"，这里叫"派单机制"。
 *
 * ══════════════════════════════════════════════════════════════
 *  五态状态机（缺任何一态都会漏）
 * ══════════════════════════════════════════════════════════════
 *
 *      ① created      刚登记，还没投递
 *           ↓ 真唤醒成功
 *      ② delivered    已投递到对方会话
 *           ↓ 对方回执
 *      ③ acked        已回执（带证据）
 *           ↓
 *      ⑤ closed       销账
 *
 *      ② ──超时无回执──→ ④ unacked（进"我发出没回"清单）
 *
 *  announce（公告）没有 ②④⑤ —— 只落盘，不唤醒，不要求回执
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/派单.mjs --send --from hub --to research \
 *       --subject "搜集同类项目架构" \
 *       --phenomenon "需要 3 个同类项目的架构资料" \
 *       --howto "按 challenges/c3 的 BRIEF 格式整理" \
 *       --verify "产物有 3 个 md 文件" \
 *       --announce                      # 可选：发公告而非派单
 *
 *  node 工具/派单.mjs --ack --id d-xxx --evidence "跑通了 8/8，产物在 xxx"
 *  node 工具/派单.mjs --list             # 列所有
 *  node 工具/派单.mjs --pending          # 列出未回执的
 *  node 工具/派单.mjs --inbox <scene>    # 列出等某场景回的
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

// ══════════════════════════════════════════════════════════════
//  常量（唯一出处）
// ══════════════════════════════════════════════════════════════
export const LEDGER_REL = path.join('场景记忆', '_共享记忆', '派单台账.json');

export const STATE = {
  CREATED: 'created',
  DELIVERED: 'delivered',
  ACKED: 'acked',
  UNACKED: 'unacked',
  CLOSED: 'closed',
  // 2026-11-10 新增：作废（不做了，与销账「做完了」区分）
  CANCELLED: 'cancelled',
  // ⚠ 2026-11-12 新增：投递失败（试过但没送达）
  //
  //   为什么必须有这个状态：投递可能因余额不足(402)/网络/引擎未启动失败。
  //   原来失败后经 process.exit(2) 直接退出，台账一点不改 ——
  //   单子永远停在 created，看不出「试过投递」，也无法区分
  //   「刚建还没投」和「投了几次都失败」。
  //
  //   failed 态语义：
  //     · 允许重新 --deliver（恢复后重试，成功则变 delivered）
  //     · 不允许 --ack（没送达就没有回执可言）
  //     · 不允许 --close（没做完不能销账）
  //     · 允许 --cancel（放弃这一单，写原因）
  FAILED: 'failed',
};

export const TYPE = {
  DISPATCH: 'dispatch',   // 派单（要动手）
  ANNOUNCE: 'announce',   // 公告（只需知道）
};

// 默认超时（小时）
export const DEFAULT_DEADLINE_HOURS = 24;

// 回执最小证据长度（低于这个视为"只说好了等于没说"）
export const MIN_EVIDENCE_LEN = 20;

// ══════════════════════════════════════════════════════════════
//  读写
// ══════════════════════════════════════════════════════════════

export function ledgerPath(dataRoot) {
  return path.join(dataRoot, LEDGER_REL);
}

export function load(dataRoot) {
  const p = ledgerPath(dataRoot);
  if (!fs.existsSync(p)) return { _note: '派单台账', dispatches: [] };
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);    // 剥离 BOM
    const j = JSON.parse(s);
    if (!Array.isArray(j.dispatches)) j.dispatches = [];
    return j;
  } catch {
    return { _note: '派单台账（解析失败，已重置）', dispatches: [] };
  }
}

export function save(dataRoot, ledger) {
  const p = ledgerPath(dataRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 原子写：先写临时文件再改名（防止写到一半崩溃）
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ══════════════════════════════════════════════════════════════
//  生成 id：d-YYYYMMDD-NNN
// ══════════════════════════════════════════════════════════════

export function nextId(ledger, now) {
  const d = now || new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = 'd-' + ymd + '-';
  const sameDay = ledger.dispatches.filter(x => String(x.id || '').startsWith(prefix));
  let max = 0;
  for (const x of sameDay) {
    const n = parseInt(String(x.id).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(3, '0');
}

// ══════════════════════════════════════════════════════════════
//  派单四件套校验
// ══════════════════════════════════════════════════════════════

/**
 * 检查派单正文是否完整（四件套）
 * @returns {string[]} 缺失项
 */
export function validateBody(d) {
  const missing = [];
  if (!d.phenomenon || String(d.phenomenon).trim().length < 5) missing.push('现象');
  if (!d.howto || String(d.howto).trim().length < 5) missing.push('照哪做');
  if (!d.verify || String(d.verify).trim().length < 5) missing.push('怎么验');
  return missing;
}

// ══════════════════════════════════════════════════════════════
//  状态判定
// ══════════════════════════════════════════════════════════════

/**
 * 判断一条记录当前应处于什么状态（用于 --pending 扫描）
 * 不回写，只计算
 */
export function effectiveState(d, now) {
  const t = now || Date.now();

  if (d.type === TYPE.ANNOUNCE) return d.state || STATE.CREATED;
  if (d.state === STATE.CLOSED) return STATE.CLOSED;
  if (d.state === STATE.ACKED) return STATE.ACKED;

  // 已投递但未回执 → 看是否超时
  if (d.state === STATE.DELIVERED || d.state === STATE.CREATED) {
    const created = new Date(d.createdAt).getTime();
    const hours = (t - created) / 3600000;
    const deadline = d.deadlineHours || DEFAULT_DEADLINE_HOURS;
    if (hours > deadline) return STATE.UNACKED;
    return d.state;
  }

  return d.state || STATE.CREATED;
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════

function argv(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
function has(name) { return process.argv.includes('--' + name); }

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  const ledger = load(dataRoot);

  // ── 列出 ──
  if (has('list')) {
    console.log('═'.repeat(78));
    console.log('  派单台账（共 ' + ledger.dispatches.length + ' 条）');
    console.log('═'.repeat(78));
    console.log();
    if (!ledger.dispatches.length) {
      console.log('  （空）');
    } else {
      console.log('  ' + 'ID'.padEnd(18) + '类型'.padEnd(10) + '从'.padEnd(14) + '到'.padEnd(14) + '状态'.padEnd(12) + '主题');
      console.log('  ' + '─'.repeat(92));
      for (const d of ledger.dispatches) {
        const st = effectiveState(d);
        const mark = st === STATE.UNACKED ? ' ⛔' : (st === STATE.ACKED ? ' ✓' : '');
        console.log('  ' +
          String(d.id).padEnd(18) +
          String(d.type || '?').padEnd(10) +
          String(d.from || '?').padEnd(14) +
          String(d.to || '?').padEnd(14) +
          (st + mark).padEnd(12) +
          String(d.subject || '').slice(0, 30)
        );
      }
    }
    console.log();
    process.exit(0);
  }

  // ── 列出未回执 ──
  if (has('pending')) {
    const pend = ledger.dispatches.filter(d => effectiveState(d) === STATE.UNACKED);
    console.log('═'.repeat(78));
    console.log('  未回执清单（' + pend.length + ' 条）');
    console.log('═'.repeat(78));
    console.log();
    if (!pend.length) {
      console.log('  ✅ 无');
    } else {
      for (const d of pend) {
        const hours = ((Date.now() - new Date(d.createdAt).getTime()) / 3600000).toFixed(1);
        console.log('  ' + d.id + '  → ' + d.to + '  (' + hours + 'h 未回)');
        console.log('      主题: ' + d.subject);
        console.log('      现象: ' + String(d.phenomenon || '').slice(0, 70));
        console.log();
      }
    }
    process.exit(pend.length ? 1 : 0);
  }

  // ── 列出某场景的收件 ──
  const inbox = argv('inbox');
  if (inbox) {
    const mine = ledger.dispatches.filter(d => d.to === inbox ||
      effectiveState(d) === STATE.UNACKED);
    console.log('═'.repeat(78));
    console.log('  ' + inbox + ' 的收件（' + mine.length + ' 条）');
    console.log('═'.repeat(78));
    console.log();
    for (const d of mine) {
      console.log('  ' + d.id + '  来自 ' + d.from + '  [' + effectiveState(d) + ']');
      console.log('      ' + d.subject);
      console.log();
    }
    process.exit(0);
  }

  // ── 发派单 / 公告 ──
  if (has('send')) {
    const from = argv('from');
    const to = argv('to');
    const subject = argv('subject');
    const isAnnounce = has('announce');

    if (!from || from === true) { console.error('缺少 --from'); process.exit(2); }
    if (!to || to === true) { console.error('缺少 --to'); process.exit(2); }
    if (!subject || subject === true) { console.error('缺少 --subject'); process.exit(2); }

    const rec = {
      id: nextId(ledger),
      type: isAnnounce ? TYPE.ANNOUNCE : TYPE.DISPATCH,
      from,
      to,
      subject,
      phenomenon: argv('phenomenon') === true ? '' : (argv('phenomenon') || ''),
      howto: argv('howto') === true ? '' : (argv('howto') || ''),
      verify: argv('verify') === true ? '' : (argv('verify') || ''),
      createdAt: new Date().toISOString(),
      state: STATE.CREATED,
      deadlineHours: DEFAULT_DEADLINE_HOURS,
      ackedAt: null,
      receipt: null,
    };

    // 派单必须四件套齐全
    if (!isAnnounce) {
      const missing = validateBody(rec);
      if (missing.length) {
        console.error('⛔ 派单缺四件套：' + missing.join('、'));
        console.error('   （公告可用 --announce，但派单必须说清"现象/照哪做/怎么验"）');
        process.exit(2);
      }
    }

    ledger.dispatches.push(rec);
    save(dataRoot, ledger);

    console.log('已登记: ' + rec.id + '  [' + rec.type + ']');
    console.log('  ' + from + ' → ' + to);
    console.log('  ' + subject);
    console.log();
    if (isAnnounce) {
      console.log('  注意：这是公告 —— 只落盘，不唤醒、不要求回执。');
    } else {
      console.log('  ⚠ 还差一步：必须真的投递到对方会话（否则只是"公告"）。');
      console.log('     投递成功后运行：');
      console.log('     node 工具/派单.mjs --deliver --id ' + rec.id);
    }
    process.exit(0);
  }

  // ── 投递（真投递，不是改状态）──
  //
  // ⚠ 2026-11-10 重写：这里原来是 `d.state = 'delivered'` + 打时间戳，
  //    也就是说「投递」只是手动把状态改了一下，**任务从来没有真的送出去**。
  //    派单工具自己的提示都写着「⚠ 还差一步：必须真的投递到对方会话」，
  //    但这一步一直没实现 —— 这才是「一天 36 条通知只有 8 条真投递」的根因。
  //
  // 现在改为真正调用引擎 RPC 投递（见 工具/投递通道.mjs）：
  //    ① session/list 找该场景的会话
  //    ② session/create 没有就建（cwd 指向 场景注入/<sceneId>）
  //    ③ session/prompt 把四件套任务文本送进去
  //    ④ session/page 判断是否已跑完
  //
  // 实测：任务文字真的出现在目标会话的 user/message 里。
  if (has('deliver')) {
    const id = argv('id');
    const d = ledger.dispatches.find((x) => x.id === id);
    if (!d) { console.error('找不到: ' + id); process.exit(2); }
    if (d.type === TYPE.ANNOUNCE) {
      console.error('公告不需要投递（它本来就不唤醒）');
      process.exit(2);
    }

    console.log('正在投递 ' + id + ' → ' + d.to + ' …');

    let mod;
    try {
      mod = await import('./投递通道.mjs');
    } catch (e) {
      console.error('⛔ 无法加载投递通道: ' + (e && e.message));
      process.exit(2);
    }

    const client = new mod.EngineClient();
    const conn = await client.connect();
    if (!conn.ok) {
      console.error('⛔ 连不上引擎: ' + conn.error);
      console.error('   引擎没启动？先启动工作台（启动.vbs）');
      process.exit(2);
    }

    const r = await mod.deliverDispatch(client, d, { waitMs: Number(argv('wait') || 8000) });
    if (!r.ok) {
      // ⚠ 2026-11-12 修（投递失败不留痕迹 → 单子永久卡死）
      //
      //   原来：console.error + process.exit(2)，台账一点都不改。
      //
      //   实测（端到端验证时发现）：
      //     建单 state=created → 投递因 402 失败 → 台账仍 created
      //     → 之后 --ack 找不到 delivered 单、--close 报「还没回执」
      //     → 这一单永远卡在 created，且**看不出它试过投递**。
      //
      //   修法：失败也要留痕 —— 记 deliverAttempts / lastDeliverError，
      //        并把 state 从 created 推进到 failed（新增状态）。
      //        failed 态允许重新 --deliver（恢复后重试），不允许 ack/close。
      d.deliverAttempts = (d.deliverAttempts || 0) + 1;
      d.lastDeliverAt = new Date().toISOString();
      d.lastDeliverError = String(r.error || '').slice(0, 300);
      d.lastDeliverStage = r.stage || '?';
      if (d.state === STATE.CREATED) d.state = STATE.FAILED;
      save(dataRoot, ledger);
      console.error('⛔ 投递失败 [' + (r.stage || '?') + ']: ' + r.error);
      console.error('   已在台账记录：第 ' + d.deliverAttempts + ' 次尝试失败，state=' + d.state);
      console.error('   恢复后重试：node 工具/派单.mjs --deliver --id ' + id);
      process.exit(2);
    }

    // 真投递成功才改状态
    d.state = STATE.DELIVERED;
    d.deliveredAt = new Date().toISOString();
    d.deliveredSession = r.sessionId;
    if (r.turnState) {
      d.lastTurnDone = r.turnState.done;
      if (r.turnState.lastError) d.lastTurnError = r.turnState.lastError;
    }
    save(dataRoot, ledger);

    console.log('✓ 已投递: ' + id);
    console.log('  目标场景: ' + d.to + '（' + (r.scene || '') + '）');
    console.log('  会话:     ' + r.sessionId + (r.created ? '（新建）' : '（复用）'));
    if (r.turnState) {
      console.log('  最后一轮: ' + (r.turnState.lastEvent
        ? r.turnState.lastEvent.type + ' (turn ' + r.turnState.lastEvent.turn + ')'
        : '无'));
      console.log('  是否跑完: ' + (r.turnState.done ? '已结束' : '仍在跑'));
      if (r.turnState.lastError) {
        console.log('  ⚠ 引擎报错: ' + String(r.turnState.lastError).slice(0, 120));
      }
    }
    console.log();
    console.log('  等对方回执后运行：');
    console.log('  node 工具/派单.mjs --ack --id ' + id + ' --evidence "产物路径/关键输出"');
    process.exit(0);
  }

  // ── 回执 ──
  if (has('ack')) {
    const id = argv('id');
    const evidence = argv('evidence');
    const d = ledger.dispatches.find(x => x.id === id);
    if (!d) { console.error('找不到: ' + id); process.exit(2); }
    if (!evidence || evidence === true) {
      console.error('⛔ 回执必须带证据（--evidence "..."）');
      console.error('   只说"好了"等于没说（原项目硬规矩）');
      process.exit(2);
    }
    if (String(evidence).length < MIN_EVIDENCE_LEN) {
      console.error('⛔ 证据太短（' + String(evidence).length + ' < ' + MIN_EVIDENCE_LEN + ' 字符）');
      console.error('   "只说好了等于没说" —— 证据要能复算（输出/路径/哈希）');
      process.exit(2);
    }
    // ⚠ 2026-11-12 修（状态机漏洞：没投递也能回执）
    //
    //   原来：检查完「有证据 / 证据够长」就直接 `d.state = STATE.ACKED`，
    //        **完全没有状态前置检查**。
    //
    //   实测（端到端验证时发现）：
    //     · 建单 state=created → 直接 --ack → 成功变 acked
    //     · 投递失败 state=failed → --ack → 成功变 acked
    //       → 然后 --close 看到 acked 就放行 → state=closed
    //   也就是说：**一单从来没送达任务的单，可以一路走到「已完成」。**
    //   而 --close 那道「必须 acked」的检查也形同虚设，因为 ack 本身不设防。
    //
    //   修法：只有 delivered 能回执（没送达就不可能有回执）。
    //        其余状态明确拒绝并提示怎么走。
    {
      const st = effectiveState(d);
      if (d.type === TYPE.DISPATCH && st !== STATE.DELIVERED) {
        console.error('⛔ 不能回执：当前状态 ' + st + '，只有「已投递」才能回执');
        if (st === STATE.CREATED) console.error('   先投递：node 工具/派单.mjs --deliver --id ' + id);
        else if (st === STATE.FAILED) console.error('   投递失败过，恢复后重试：node 工具/派单.mjs --deliver --id ' + id);
        else if (st === STATE.CANCELLED) console.error('   这一单已作废，不能回执');
        else if (st === STATE.CLOSED) console.error('   这一单已销账');
        else if (st === STATE.ACKED) console.error('   已经回执过了');
        process.exit(2);
      }
    }
    d.state = STATE.ACKED;
    d.ackedAt = new Date().toISOString();
    d.receipt = String(evidence);
    save(dataRoot, ledger);
    console.log('已回执: ' + id);
    console.log('  证据: ' + evidence);
    process.exit(0);
  }

  // ── 作废 ──
  //
  //  2026-11-10 新增。为什么需要：
  //    测试/历史遗留的派单会一直停在 delivered，污染进度判定。
  //    但「作废」和「销账」不同：
  //      销账 closed    = 做完了
  //      作废 cancelled = 不做了（必须写原因）
  //
  //  调研 §3.2 指出：派错要先分单错（同场景重发）还是归属错
  //    （cancel 旧单，新单引用旧 id，绝不许同一 subject 挂两个场景）。
  //    所以作废必须支持 --reason，并记录被谁替代。
  if (has('cancel')) {
    const id = argv('id');
    const reason = argv('reason');
    const d = ledger.dispatches.find(x => x.id === id);
    if (!d) { console.error('找不到: ' + id); process.exit(2); }
    if (d.state === STATE.CLOSED) {
      console.error('⛔ 不能作废：已经销账了（closed 是终态）');
      process.exit(2);
    }
    if (!reason || reason === true || String(reason).length < 5) {
      console.error('⛔ 作废必须给 --reason "为什么不做"（至少 5 字）');
      console.error('   作废和销账不同：销账=做完了，作废=不做了，必须留原因');
      process.exit(2);
    }
    d.state = STATE.CANCELLED || 'cancelled';
    d.cancelledAt = new Date().toISOString();
    d.cancelReason = String(reason);
    const replacedBy = argv('replaced-by');
    if (replacedBy) d.replacedBy = String(replacedBy);
    save(dataRoot, ledger);
    console.log('已作废: ' + id);
    console.log('  原因: ' + reason);
    if (replacedBy) console.log('  替代单: ' + replacedBy);
    process.exit(0);
  }

  // ── 销账 ──
  if (has('close')) {
    const id = argv('id');
    const d = ledger.dispatches.find(x => x.id === id);
    if (!d) { console.error('找不到: ' + id); process.exit(2); }
    if (d.type === TYPE.DISPATCH && effectiveState(d) !== STATE.ACKED) {
      console.error('⛔ 不能销账：还没回执（当前状态 ' + effectiveState(d) + '）');
      process.exit(2);
    }
    // ══════════════════════════════════════════════════════════════
    //  ⚠ 2026-11-12 修（据 中枢/闭环断点诊断.md 断点8）：
    //
    //    原来：只看 effectiveState === ACKED 就允许销账，
    //          从不读 lastTurnDone / turn 的结束原因。
    //
    //    后果：执行被中断（turn=interrupted）、AI 根本没跑完的单，
    //          只要有人写了回执就能销账 → 假闭环。
    //
    //    实测佐证：台账 d-20261110-008/009/010
    //              三条 lastTurnDone=false、turn=interrupted 却 state=closed
    //
    //    修法：销账前必须确认「执行真的完成了」
    //      · 如果有 lastTurnDone 字段，必须为 true
    //      · 如果记录了 turn 结束原因，必须是 completed
    //      · 都不满足 → 拒绝销账，提示改用 --cancel 或打回
    // ══════════════════════════════════════════════════════════════
    const turnKind = d.lastTurnKind || (d.turn && d.turn.kind) || null;
    const lastDone = (d.lastTurnDone === undefined) ? null : d.lastTurnDone;

    if (lastDone === false) {
      console.error('⛔ 不能销账：执行未完成（lastTurnDone=false）');
      console.error('   这一单被标记为「执行没真跑完」，销账会造成假闭环。');
      console.error('   如果确实不做了，用 --cancel --id ' + id + ' --reason "..."');
      process.exit(2);
    }

    if (turnKind && turnKind !== 'completed') {
      console.error('⛔ 不能销账：本轮结束原因是 ' + turnKind + '（不是 completed）');
      console.error('   中断/报错的单不能算完成。如果确实不做了，用 --cancel。');
      process.exit(2);
    }

    d.state = STATE.CLOSED;
    d.closedAt = new Date().toISOString();
    save(dataRoot, ledger);
    console.log('已销账: ' + id);
    process.exit(0);
  }

  // ── 用法 ──
  console.log('派单台账');
  console.log();
  console.log('  --send --from <场景> --to <场景> --subject "..." [四件套]  # 发派单');
  console.log('         --phenomenon "现象" --howto "照哪做" --verify "怎么验"');
  console.log('         --announce                                          # 改成公告');
  console.log('  --deliver --id <id>                                        # 标记已真投递');
  console.log('  --ack --id <id> --evidence "..."                           # 回执（必须带证据）');
  console.log('  --close --id <id>                                          # 销账（做完了）');
  console.log('  --cancel --id <id> --reason "..."                          # 作废（不做了，必须写原因）');
  console.log('         --replaced-by <新单id>                                #   可选：被哪张新单替代');
  console.log('  --list                                                     # 列出全部');
  console.log('  --pending                                                  # 列出未回执');
  console.log('  --inbox <场景>                                             # 某场景的收件');
}
