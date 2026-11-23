#!/usr/bin/env node
/**
 * 派单全生命周期验证 —— 不依赖 LLM
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么要这个测试
 * ══════════════════════════════════════════════════════════════
 *
 *  API 余额耗尽，场景 agent 答不了，所以「真实任务闭环」验不了。
 *  但派单机制本身有 5 个状态、7 条拒收规则 —— 这些不需要 AI，
 *  可以用真实工具 + 真实台账验证。
 *
 *  这个测试验的是：
 *    · 四件套校验（缺任一不许派）
 *    · 状态机前置条件（没回执不许销账）
 *    · 证据校验（太短拒收 / 只说"好了"拒收）
 *    · 公告与派单的区别（公告不要求回执）
 *    · 超时判定（unacked）
 *    · 强制冻结（连续退化）
 *
 *  全部用真实 npm 工具跑，不 mock。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/派单闭环验证.mjs
 *  node 工具/派单闭环验证.mjs --keep    保留测试数据（默认清理）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ⚠ 2026-11-12 补（五步法第 2 步「判据唯一出处」）：
//   本工具验的 7 条拒收规则，真正的判据都写在 派单.mjs 里：
//     MIN_EVIDENCE_LEN（证据太短拒收）、validateBody（四件套）、
//     STATE（状态机）、TERMINAL_OK…… 
//   原来这些判据在本文件里是「间接验」（只看 exit code），
//   而机制审计第 2 步要求「判据只有一个出处、可被别的工具 import 复用」。
//   这里直接 import 权威判据，并在下面 export 成本文件可复用的形式，
//   避免「测试里写一份阈值、工具里又写一份」的双份判据。
import { MIN_EVIDENCE_LEN, validateBody, STATE, TYPE } from './派单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOL = path.join(HERE, '派单.mjs');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const LEDGER = path.join(DATA_ROOT, '场景记忆', '_共享记忆', '派单台账.json');

// ══════════════════════════════════════════════════════════════
//  判据（唯一出处，可被复用）
//
//  ⚠ 2026-11-12 新增：原来本文件没有导出任何判据，
//    机制审计第 2 步判「判据未 export（可能各处各写一份）」。
//
//    这些常量把「这个验证认为什么算违规」写死成可被 import 的形式，
//    自测（selftest）和真实验证共用同一份，不再各写一份。
// ══════════════════════════════════════════════════════════════

// 四件套的最小可接受长度（与 派单.validateBody 保持一致：<5 视为缺）
export const RULES = {
  // 四件套每项正文至少这么长，短于此视为「没写」
  FIELD_MIN_LEN: 5,
  // 回执证据最小长度（直接引用权威常量，不另写一个数）
  EVIDENCE_MIN_LEN: MIN_EVIDENCE_LEN,
  // 作废原因最小长度（派单.mjs --cancel 的判据）
  CANCEL_REASON_MIN_LEN: 5,
  // 一条证据只写「好了」「done」这类空话时，长度过关但信息量为零
  EMPTY_EVIDENCE_WORDS: ['好了', 'done', 'ok', '完成', '搞定'],
  // 抠掉空话词之后，剩下的实质内容至少要有这么多字
  // （否则「好了」重复十遍就能凑够长度 —— 自测抓到过这个洞）
  MIN_SUBSTANCE_CHARS: 5,
};

// 应当被拒的四件套样本（自测与破坏性验证共用，避免两处各造一份）
export const BAD_FIELD_CASES = {
  missingVerify: { phenomenon: '缺验收标准描述', howto: '故意不填 verify' },
  missingPhenomenon: { howto: '故意不填 phenomenon', verify: '应该被拒绝' },
  missingHowto: { phenomenon: '故意不填 howto', verify: '应该被拒绝' },
  tooShort: { phenomenon: '短', howto: '短', verify: '短' },
};

// 一条「有信息量」的合格证据（≥ EVIDENCE_MIN_LEN，且不是空话）
export const GOOD_EVIDENCE =
  '产物: 数据/.dsh/场景记忆/架构梳理/验证.md 共 1234 B，关键输出 8/8 通过';

// 终态集合：这些状态是合法收尾，不该再期待回执
export const TERMINAL_STATES = new Set([STATE.CLOSED, STATE.ACKED, STATE.CANCELLED]);

/**
 * 判据：一条证据是否「够」。
 * 这是本工具对「回执带证据」的唯一判断入口，自测直接调它。
 * @param {any} evidence
 * @returns {{ok:boolean, reason:string}}
 */
export function judgeEvidence(evidence) {
  const s = String(evidence === null || evidence === undefined ? '' : evidence).trim();
  if (!s) return { ok: false, reason: '没有证据（只说"做好了"等于没说）' };
  if (s.length < RULES.EVIDENCE_MIN_LEN) {
    return { ok: false, reason: '证据太短（' + s.length + ' < ' + RULES.EVIDENCE_MIN_LEN + ' 字符）' };
  }
  // ⚠ 2026-11-12 修（自测抓出的真判据缺陷）：
  //
  //   原来只判 stripped === w，即「整条证据恰好等于某个空话词」。
  //   实测：「好了」×10 = 20 字，长度过线、也不等于单个空话词
  //        → judgeEvidence 返回 ok=true，被放行。
  //   也就是说「凑字数」这条路一直是开的：把「好了」重复十遍就能交差。
  //
  //   改成：把所有空话词从证据里**全部抠掉**，看剩下多少实质内容。
  //        剩下的字符数 < MIN_SUBSTANCE → 说明通篇是空话，判失败。
  //   这不是放松判据，是把「空话」这个判据补完整。
  let stripped = s.replace(/\s/g, '');
  for (const w of RULES.EMPTY_EVIDENCE_WORDS) stripped = stripped.split(w).join('');
  if (stripped.length < RULES.MIN_SUBSTANCE_CHARS) {
    return {
      ok: false,
      reason: '只有空话（抠掉"好了/done/ok/完成/搞定"后只剩 ' + stripped.length +
        ' 字实质内容，需要 ≥ ' + RULES.MIN_SUBSTANCE_CHARS + '）',
    };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * 判据：四件套是否完整。
 * 直接复用 派单.validateBody（唯一出处），不另写一份规则。
 * @param {object} body
 * @returns {{ok:boolean, missing:string[]}}
 */
export function judgeBody(body) {
  const missing = validateBody(body || {});
  return { ok: missing.length === 0, missing };
}

/**
 * 判据：某状态下是否允许销账。
 * @param {string} state
 * @returns {boolean}
 */
export function canCloseAt(state) {
  // 只有「已回执」才能销账；closed 幂等；其余（created/delivered/unacked）都不许
  return state === STATE.ACKED || state === STATE.CLOSED;
}

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');

const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok, detail });
  console.log('  ' + (ok ? 'OK  ' : 'XX  ') + name + (detail !== undefined ? '  ' + detail : ''));
}

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: WB, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { dispatches: [] };
  }
}

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
//
//  ⚠ 2026-11-12 补：原来没有 selftest、没有反例，机制审计判它
//    「①2 判据未 export · ①4 反例 0 处 · ①5 无自测入口」= 口号。
//
//    为什么必须补：本工具验的是「派单闭环能不能拦住不该放行的事」。
//    它的可信度完全取决于判据（EVIDENCE_MIN_LEN / 四件套 / 终态）
//    是否真的会把坏数据判成坏。下面每条反例都是**真造坏数据**
//    交给导出的判据函数，断言它必须返回 false。
//
//    注意：这里**不碰真实台账**（不调 派单.mjs、不写 LEDGER），
//    只测纯判据函数，所以可以随时反复跑。
//    「判据与真实工具是否一致」由下面的真实验证段交叉断言。
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R2 = [];
  const k = (n, ok, d) => { R2.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  派单闭环 · 判据自测');
  console.log('═'.repeat(72));
  console.log();

  // ── ① 判据常量本身（唯一出处，别被顺手改小）──
  k('证据最小长度 = 20', RULES.EVIDENCE_MIN_LEN === 20, String(RULES.EVIDENCE_MIN_LEN));
  k('四件套单项最小长度 = 5', RULES.FIELD_MIN_LEN === 5, String(RULES.FIELD_MIN_LEN));
  k('作废原因最小长度 = 5', RULES.CANCEL_REASON_MIN_LEN === 5, String(RULES.CANCEL_REASON_MIN_LEN));
  k('合格证据样本确实够长', GOOD_EVIDENCE.length >= RULES.EVIDENCE_MIN_LEN,
      GOOD_EVIDENCE.length + ' ≥ ' + RULES.EVIDENCE_MIN_LEN);

  // ── ② 正例：合格证据 / 合格四件套 / acked 状态 都必须放行 ──
  k('正例：合格证据判通过', judgeEvidence(GOOD_EVIDENCE).ok === true,
      judgeEvidence(GOOD_EVIDENCE).reason);
  k('正例：四件套齐全判通过',
      judgeBody({ phenomenon: '现象描述在这儿', howto: '照这个做就行', verify: '这样验算通过' }).ok === true,
      JSON.stringify(judgeBody({ phenomenon: '现象描述在这儿', howto: '照这个做就行', verify: '这样验算通过' })));
  k('正例：acked 状态允许销账', canCloseAt(STATE.ACKED) === true, String(canCloseAt(STATE.ACKED)));

  // ── ③ 反例 1：证据只写「好了」→ 必须判失败 ──
  {
    const r = judgeEvidence('好了');
    k('反例：证据只写"好了"应当失败', r.ok === false, r.reason);
  }

  // ── ③b 反例 1b：把空话重复到够长（"好了好了好了…" 20 字）→ 仍必须判失败 ──
  //     这条是为了**真的踩到「空话」分支**：
  //     上面那条"好了"只有 2 字，早已被「太短」拦住，
  //     所以 RULES.EMPTY_EVIDENCE_WORDS 那段判据其实没被验证过。
  //     造一个长度过关、信息量为零的证据，才证明「凑字数」拦得住。
  {
    const padded = '好了'.repeat(10);   // 20 字，恰好等于红线
    const r = judgeEvidence(padded);
    k('反例：空话凑到 20 字仍应当失败（拦凑字数）',
        r.ok === false && r.reason.includes('空话'),
        padded.length + ' 字 → ' + r.reason);
  }

  // ── ④ 反例 2：证据完全没给 → 必须判失败 ──
  {
    const r = judgeEvidence(null);
    k('反例：证据为空应当失败', r.ok === false, r.reason);
  }

  // ── ⑤ 反例 3：四件套缺 verify → 必须判失败且点名缺哪项 ──
  {
    const r = judgeBody(BAD_FIELD_CASES.missingVerify);
    k('反例：四件套缺 verify 应当失败',
        r.ok === false && r.missing.includes('怎么验'), '缺: ' + r.missing.join(','));
  }

  // ── ⑥ 反例 4：四件套每项只写 1 个字（长度不够）→ 必须判失败 ──
  {
    const r = judgeBody(BAD_FIELD_CASES.tooShort);
    k('反例：四件套字段太短应当失败', r.ok === false && r.missing.length === 3,
        '缺: ' + r.missing.join(','));
  }

  // ── ⑦ 反例 5：created / delivered 状态不许销账 ──
  {
    const c = canCloseAt(STATE.CREATED);
    const d = canCloseAt(STATE.DELIVERED);
    k('反例：created 状态不许销账', c === false, String(c));
    k('反例：delivered（已投递未回执）不许销账', d === false, String(d));
  }

  // ── ⑧ 边界：证据恰好 20 字（等于红线）→ 应当放行（判据是「< 20 才拒」）──
  {
    const edge = 'x'.repeat(RULES.EVIDENCE_MIN_LEN);
    const r = judgeEvidence(edge);
    k('边界：证据恰好 20 字放行（严格小于才拒）', r.ok === true, r.reason);
  }

  // ── ⑨ 边界：证据 19 字（差 1 字）→ 必须拒 ──
  {
    const almost = 'x'.repeat(RULES.EVIDENCE_MIN_LEN - 1);
    const r = judgeEvidence(almost);
    k('边界：证据 19 字（差 1）必须拒', r.ok === false, r.reason);
  }

  // ── ⑩ 边界：cancelled 是合法终态，不该被当成「未回执」──
  k('边界：cancelled 属于合法终态（不该等回执）', TERMINAL_STATES.has(STATE.CANCELLED),
      [...TERMINAL_STATES].join(','));

  // ── ⑪ 关键：上面 6 条反例必须全部被判失败 ──
  //    ⚠ 2026-11-12：用显式变量攒结果，不靠数组下标切片
  //      （切片写错会让这条「永远通过」，又是一条新的装饰）
  {
    const hits = {
      空话太短: R2[7], 空话凑长: R2[8], 证据为空: R2[9],
      缺verify: R2[10], 字段太短: R2[11], created不许销账: R2[12],
    };
    const all = Object.values(hits).every(v => v === true);
    k('关键：造出的坏证据/坏四件套/坏状态全部被判失败（判据不是装饰）', all,
        Object.entries(hits).map(([n, v]) => n + '=' + v).join(' '));
  }

  console.log();
    // ⚠ 2026-11-12 加：反例守护「清理逻辑不会冲掉并发写入的单」
  //
  //   这个缺陷修了两次才对（见清理段注释）。这条反例把修复锁死：
  //   模拟「测试期间并发写入了一单」，验证清理逻辑只删自己的。
  {
    const beforeIds = new Set(['d-A', 'd-B']);
    const isMine = (x) => !beforeIds.has(x.id) && String(x.subject || '').startsWith('闭环验证');
    const simLedger = [
      { id: 'd-A', subject: '真单A' },
      { id: 'd-B', subject: '真单B' },
      { id: 'd-C', subject: '闭环验证-完整四件套' },
      { id: 'd-D', subject: '并发保护测试-1794463512537' },
    ];
    const keptIds = simLedger.filter((x) => !isMine(x)).map((x) => x.id);

    k('反例：清理必须删掉本工具建的测试单', !keptIds.includes('d-C'), 'd-C 已删');
    k('反例：清理不能冲掉并发写入的真单', keptIds.includes('d-D'),
        keptIds.includes('d-D') ? 'd-D 保住' : 'd-D 被误删');
    k('反例：清理不能动测试前就有的单',
        keptIds.includes('d-A') && keptIds.includes('d-B'), 'd-A/d-B 保留');

    // 再验旧写法（整体覆盖）会丢并发单
    const oldResult = simLedger.filter((x) => beforeIds.has(x.id)).map((x) => x.id);
    k('反例：整体覆盖的旧写法会丢并发单（证明修复必要）', !oldResult.includes('d-D'),
        '旧写法丢了 d-D');
  }

  const passed = R2.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R2.length);
  console.log('─'.repeat(72));
  return R2.every(Boolean);
}

// ⚠ 2026-11-12 补：--selftest 入口（五步法第 5 步「挂到节奏上」）。
//
//   必须放在「真实验证段」之前 —— 本文件顶层就是一次完整验证（会改台账）。
//   process.exit 是同步终止，所以下面所有真实验证代码不会被执行，
//   自测不会污染真实台账。
if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

console.log('═'.repeat(72));
console.log('  派单全生命周期验证（不依赖 LLM）');
console.log('═'.repeat(72));
console.log();

// ⚠ 2026-11-12 加：跑之前先清掉**自己上次留下的**测试单
//
//   问题：这个工具跑一轮要几十秒，如果中途被中断（Ctrl+C / 超时 / 我改脚本），
//        末尾的清理逻辑就没跑，它造的测试单（subject 以「闭环验证」开头）
//        会留在台账里。下次再跑，这些历史残单会被 `归因.mjs` 当成
//        「哪类交付总要返工」和「有多少派单没回执」报出来。
//
//   实测：破坏性验证跑完 → 归因完整性用例正常状态就红（因为台账里有
//        别的用例造的残单）→ 破坏性验证 46/47。
//        而且这形成循环：破坏性验证自己造残留，又因残留而失败。
//
//   修法：在任何断言开始前，先把「state 非终态 且 subject 以闭环验证开头」的
//        历史残单作废（不是删除 —— 保留审计痕迹）。
//        这次运行自己造的残单仍由末尾的清理逻辑处理。
try {
  if (fs.existsSync(LEDGER)) {
    const j0 = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    const TERMINAL0 = new Set(['acked', 'closed', 'cancelled']);
    let staleCleaned = 0;
    for (const dd of (j0.dispatches || [])) {
      if (TERMINAL0.has(dd.state)) continue;
      if (!String(dd.subject || '').startsWith('闭环验证')) continue;
      dd.state = 'cancelled';
      dd.cancelledAt = new Date().toISOString();
      dd.cancelReason = '上次派单闭环验证被中断后留下的残单（本次运行前自动清理）';
      staleCleaned++;
    }
    if (staleCleaned) {
      fs.writeFileSync(LEDGER, JSON.stringify(j0, null, 2), 'utf8');
      console.log('  （先清掉上次中断留下的测试单 ' + staleCleaned + ' 条）');
      console.log();
    }
  }
} catch { /* fail-open：清理失败不阻断验证 */ }

// ── 记录原始台账，结束时恢复 ──
const ledgerBackup = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : null;
const beforeCount = (readLedger().dispatches || []).length;
console.log('  台账初始: ' + beforeCount + ' 条');
console.log();

// ══════════════════════════════════════════════════════════
console.log('【一】四件套校验');
console.log();

// ① 完整四件套 → 应该成功
const r1 = run(['--send', '--from', 'hub', '--to', '架构梳理',
  '--subject', '闭环验证-完整四件套',
  '--phenomenon', '验证派单能正常登记',
  '--howto', '填全四个字段',
  '--verify', '台账里出现这条记录']);
chk('完整四件套能登记', r1.code === 0, 'exit=' + r1.code);

// ② 缺 verify → 必须拒绝
const r2 = run(['--send', '--from', 'hub', '--to', '架构梳理',
  '--subject', '闭环验证-缺verify',
  '--phenomenon', '缺验收标准',
  '--howto', '故意不填 verify']);
chk('缺 verify 必须拒绝', r2.code !== 0, 'exit=' + r2.code);

// ③ 缺 phenomenon → 必须拒绝
const r3 = run(['--send', '--from', 'hub', '--to', '架构梳理',
  '--subject', '闭环验证-缺phenomenon',
  '--howto', '故意不填 phenomenon',
  '--verify', '应该被拒']);
chk('缺 phenomenon 必须拒绝', r3.code !== 0, 'exit=' + r3.code);

// ④ 缺 howto → 必须拒绝
const r4 = run(['--send', '--from', 'hub', '--to', '架构梳理',
  '--subject', '闭环验证-缺howto',
  '--phenomenon', '故意不填 howto',
  '--verify', '应该被拒']);
chk('缺 howto 必须拒绝', r4.code !== 0, 'exit=' + r4.code);

// ══════════════════════════════════════════════════════════
console.log();
console.log('【二】状态机前置条件');
console.log();

// 找到刚才成功登记的那条
//
// ⚠ 2026-11-12 修（找错单 → 5 条断言连环失败）
//
//   原来：find(d => d.subject.includes('闭环验证-完整四件套'))
//        —— 台账里可能有**历史遗留**的同名单（上次运行中断留下的、或别的用例造的），
//           find 取第一个，很可能拿到一条 closed/cancelled 的旧单。
//
//   实测后果：旧单 state=closed → 手改 delivered 后 ack 走「已销账不能回执」分支
//            → 后面 5 条断言连环失败（回执/交叉断言/销账/状态/不许作废）。
//            而真实原因是「拿到了一条不属于本次测试的单」。
//
//   修法：只认「created 状态」的那一条（本次刚建的应该是 created），
//        并且优先取 id 最大的（最新建的）。
const ledger1 = readLedger();
const candidates = (ledger1.dispatches || [])
  .filter((d) => String(d.subject || '').includes('闭环验证-完整四件套'))
  .filter((d) => d.state === 'created');
candidates.sort((a, b) => String(b.id).localeCompare(String(a.id)));
const testItem = candidates[0] ||
  (ledger1.dispatches || []).find((d) => String(d.subject || '').includes('闭环验证-完整四件套'));

chk('台账里能找到测试单', !!testItem, testItem ? testItem.id : '未找到');

if (testItem) {
  // ⑤ 未投递就销账 → 必须拒绝
  const r5 = run(['--close', '--id', testItem.id]);
  chk('未投递不许销账', r5.code !== 0, 'exit=' + r5.code);

  // ⑥ 标记投递（这里不真投递，只验状态机）
  //    注意：--deliver 现在会真投递，所以这里直接改台账模拟
  const lb = readLedger();
  const it = (lb.dispatches || []).find((d) => d.id === testItem.id);
  if (it) {
    it.state = 'delivered';
    it.deliveredAt = new Date().toISOString();
    fs.writeFileSync(LEDGER, JSON.stringify(lb, null, 2), 'utf8');
  }

  // ⑦ delivered 但没回执就销账 → 必须拒绝
  const r7 = run(['--close', '--id', testItem.id]);
  chk('已投递但没回执不许销账', r7.code !== 0, 'exit=' + r7.code);

  // ⑧ 回执太短 → 必须拒绝
  const r8 = run(['--ack', '--id', testItem.id, '--evidence', '好了']);
  chk('回执"好了"必须拒绝', r8.code !== 0, 'exit=' + r8.code);

  // ⑨ 回执不带证据 → 必须拒绝
  const r9 = run(['--ack', '--id', testItem.id]);
  chk('回执不带证据必须拒绝', r9.code !== 0, 'exit=' + r9.code);

  // ⑩ 回执带足够证据 → 成功
  const r10 = run(['--ack', '--id', testItem.id,
    '--evidence', GOOD_EVIDENCE]);
  chk('带证据的回执能成功', r10.code === 0, 'exit=' + r10.code);

  // ⑩b 交叉断言：导出的判据和真实工具必须**判同一件事**
  //
  //  ⚠ 2026-11-12 新增（防止判据变摆设）：
  //    五步法第 2 步把判据 export 出去，是为了「唯一出处可复用」。
  //    但如果导出后只有 selftest 用它、真实检查仍各判各的，
  //    那就成了两份判据里的一份「没人用的副本」—— 比没有更糟。
  //    这里把 judgeEvidence 的结论和 派单.mjs 的真实 exit code 对齐：
  //      · 判据说「合格」→ 真实命令必须接受
  //      · 判据说「不合格」→ 真实命令必须拒绝
  //    两边一旦分叉，这条就红。
  {
    const goodSay = judgeEvidence(GOOD_EVIDENCE).ok;
    chk('交叉断言：合格证据判据 ⇔ 真实工具接受',
        goodSay === (r10.code === 0), '判据ok=' + goodSay + ' 真实exit=' + r10.code);

    const badSay = judgeEvidence('好了').ok;
    chk('交叉断言：坏证据判据 ⇔ 真实工具拒绝',
        badSay === (r8.code === 0), '判据ok=' + badSay + ' 真实exit=' + r8.code);
  }

  // ⑪ 已回执后销账 → 成功
  const r11 = run(['--close', '--id', testItem.id]);
  chk('回执后能销账', r11.code === 0, 'exit=' + r11.code);

  // ⑫ 已销账后再销账 → 应该拒绝或幂等
  const r12 = run(['--close', '--id', testItem.id]);
  const afterState = (readLedger().dispatches || []).find((d) => d.id === testItem.id)?.state;
  chk('销账后状态是 closed', afterState === 'closed', 'state=' + afterState);
}

// ⚠ 2026-11-12 新增【二b】：failed 状态的语义
//
//   实测事故：端到端验证时发现投递失败（402）后
//     ① 台账一点不改（看不出试过投递）
//     ② 而且 --ack 完全没有状态前置检查 ——
//        created 和 failed 的单都能直接 ack，然后 close 也放行
//        → 一单从来没送达任务的单，可以一路走到「已完成」。
//
//   修法：投递失败记 deliverAttempts/lastDeliverError 并转 failed；
//        --ack 只接受 delivered。这里把两条都固化成断言。
console.log();
console.log('【二b】failed 状态的语义');

{
  const TAG2 = '闭环验证-failed语义-' + Date.now();
  const rf1 = run(['--send', '--from', '中枢', '--to', '竞品拆解',
    '--subject', TAG2,
    '--phenomenon', '验证 failed 状态语义',
    '--howto', '造一单并检查状态机',
    '--verify', 'failed 不许 ack / 不许 close / 允许 cancel']);

  const lf = readLedger();
  const item = (lf.dispatches || []).find((d) => d.subject === TAG2);
  chk('能建 failed 语义测试单', rf1.code === 0 && !!item, item ? item.id : '未建成功');

  if (item) {
    // 手工改成 failed（不真投递，避免依赖模型可用性）
    const lb2 = readLedger();
    const it2 = (lb2.dispatches || []).find((d) => d.id === item.id);
    if (it2) {
      it2.state = 'failed';
      it2.deliverAttempts = 1;
      it2.lastDeliverError = '模拟：402 余额不足';
      fs.writeFileSync(LEDGER, JSON.stringify(lb2, null, 2), 'utf8');
    }

    // failed 不许 ack（这是本次修的状态机漏洞）
    const ra = run(['--ack', '--id', item.id,
      '--evidence', '产物: 数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md 共 4028 B，关键输出 8/8 通过']);
    const stA = (readLedger().dispatches || []).find((d) => d.id === item.id)?.state;
    chk('反例：failed 不许 ack（没送达就没有回执）', ra.code !== 0 && stA === 'failed',
      'exit=' + ra.code + ' state=' + stA);

    // failed 不许 close
    const rc = run(['--close', '--id', item.id]);
    const stC = (readLedger().dispatches || []).find((d) => d.id === item.id)?.state;
    chk('反例：failed 不许 close', rc.code !== 0 && stC === 'failed',
      'exit=' + rc.code + ' state=' + stC);

    // failed 允许 cancel（放弃这一单）
    const rk = run(['--cancel', '--id', item.id, '--reason', '投递持续失败，放弃这一单']);
    const stK = (readLedger().dispatches || []).find((d) => d.id === item.id)?.state;
    chk('failed 允许 cancel', rk.code === 0 && stK === 'cancelled',
      'exit=' + rk.code + ' state=' + stK);
  }
}

// ══════════════════════════════════════════════════════════
console.log();
console.log('【三】公告 vs 派单');
console.log();

// ⑬ 公告不要求回执
const r13 = run(['--send', '--from', 'hub', '--to', '架构梳理',
  '--subject', '闭环验证-公告',
  '--phenomenon', '只是通知',
  '--howto', '不需要动手',
  '--verify', '无',
  '--announce']);
chk('能发公告', r13.code === 0, 'exit=' + r13.code);

const lb2 = readLedger();
const ann = (lb2.dispatches || []).find((d) => String(d.subject || '').includes('闭环验证-公告'));
chk('公告类型是 announce', ann?.type === 'announce', 'type=' + ann?.type);

if (ann) {
  // ⑭ 公告不许标记投递
  const r14 = run(['--deliver', '--id', ann.id]);
  chk('公告不许投递', r14.code !== 0, 'exit=' + r14.code);
}

// ══════════════════════════════════════════════════════════
console.log();
console.log('【三b】作废（vs 销账）');
console.log();

// ⑭b 作废必须给原因
if (testItem) {
  const r14b = run(['--cancel', '--id', testItem.id]);
  chk('作废不给原因必须拒绝', r14b.code !== 0, 'exit=' + r14b.code);

  const r14c = run(['--cancel', '--id', testItem.id, '--reason', '短']);
  chk('作废原因太短必须拒绝', r14c.code !== 0, 'exit=' + r14c.code);

  // ⑭d 已销账的不能作废（closed 是终态）
  const r14d = run(['--cancel', '--id', testItem.id, '--reason', '这是一个足够长的作废原因']);
  chk('已销账不许作废', r14d.code !== 0, 'exit=' + r14d.code);
}

// ⑭e 新建一条然后作废
//
//  ⚠ 两个注意点（自测抓到的）：
//    1. subject 要用时间戳，否则撞上之前测试留下的同名单
//    2. 四件套每项至少 5 字符（validateBody 有长度校验），
//       写太短（如「被作废」3 字）会被拒
const cancelSubject = '闭环验证-待作废-' + Date.now();
const r14e1 = run(['--send', '--from', 'hub', '--to', '架构梳理',
  '--subject', cancelSubject,
  '--phenomenon', '测试作废流程是否正常工作',
  '--howto', '什么都不用做，只看能不能建出来',
  '--verify', '台账里出现这条记录并标记作废']);
chk('能建待作废单', r14e1.code === 0, 'exit=' + r14e1.code);

const lb3 = readLedger();
const toCancel = (lb3.dispatches || []).find((d) => String(d.subject || '') === cancelSubject);
chk('台账里找得到待作废单', !!toCancel, toCancel ? toCancel.id : '未找到');

if (toCancel) {
  const r14e2 = run(['--cancel', '--id', toCancel.id, '--reason', '这是测试用的作废单，原因足够长']);
  chk('能正常作废', r14e2.code === 0, 'exit=' + r14e2.code);

  const after = (readLedger().dispatches || []).find((d) => d.id === toCancel.id);
  chk('作废后状态是 cancelled', after?.state === 'cancelled', 'state=' + after?.state);
  chk('作废留了原因', !!after?.cancelReason, after?.cancelReason ? '有' : '无');

  // ⑭f 作废后不应再算「在途」
  const prog = spawnSync(process.execPath, [path.join(HERE, '进度判定.mjs'), '--json'], {
    cwd: WB, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  let progOk = false;
  try {
    const pj = JSON.parse(prog.stdout);
    // 作废单不在 next_action 里被点名
    progOk = !String(pj.next_action || '').includes(toCancel.id);
  } catch { /* ignore */ }
  chk('作废单不再算在途', progOk, '');
}

// ══════════════════════════════════════════════════════════
console.log();
console.log('【四】查询能力');
console.log();

const r15 = run(['--list']);
chk('--list 可执行', r15.code === 0, 'exit=' + r15.code);
chk('--list 输出含表头', r15.out.includes('ID') && r15.out.includes('状态'), '');

// ── --pending ──
//
// ⚠ 2026-11-11 修（真实缺陷：这个断言之前永远失败）
//
//   原来写的是：
//     chk('--pending 可执行', r16.code === 0, ...)
//
//   但 `派单.mjs --pending` 的设计是：
//     process.exit(pend.length ? 1 : 0)
//   —— 有未回执单就返回 1（和 git diff 有变更返回非 0 一样的语义）。
//
//   所以只要台账里有超时未回的派单，这条断言**必然失败**，
//   而它跟本工具的代码质量毫无关系。
//
//   正确的判据分两层：
//     ① 命令本身能跑（不是崩溃、不是参数错）→ 输出里应该有「未回执」表头
//     ② 退出码只能是 0 或 1（0=没有未回执 / 1=有未回执）
//    exit=2 才是真失败（参数错/内部异常）。
const r16 = run(['--pending']);
const pendingRan = r16.out.includes('未回执清单') || r16.out.includes('未回执');
chk('--pending 可执行', pendingRan && (r16.code === 0 || r16.code === 1),
    'exit=' + r16.code + (r16.code === 1 ? '（有未回执单，属正常）' : ''));
// 反例：如果退出码是 2，说明真出错了
chk('--pending 没有内部错误', r16.code !== 2, 'exit=' + r16.code);

// ══════════════════════════════════════════════════════════
console.log();
console.log('═'.repeat(72));
const passed = R.filter((x) => x.ok).length;
const failed = R.filter((x) => !x.ok);

// ── 清理测试数据 ──
//
// ⚠ 2026-11-12 修了两次（第一版不够，记录如下）
//
//   第一版问题：fs.writeFileSync(LEDGER, ledgerBackup, 'utf8')
//               —— 整体覆盖成测试前快照，会冲掉并发写入的单。
//
//   第二版问题：改成「删掉测试前不存在的 id」，仍然不对。
//              因为并发单在测试**开始后**才创建，它也不在测试前快照里，
//              于是被误判成「本次测试创建的」删掉。
//              实测：验证跑着的时候建一单，验证结束后那单没了。
//
//   第三版（本版）：按 **subject 前缀** 精确识别。
//              本工具创建的所有测试单 subject 都以「闭环验证」开头
//              （闭环验证-完整四件套 / -缺verify / -公告 / -作废 ...）。
//              只删「测试前不存在 **且** subject 以闭环验证开头」的，
//              并发写进来的真单（如「并发保护测试-xxx」）不受影响。
if (!keep) {
  try {
    const cur = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    const before = new Set(ledgerBackup
      ? (JSON.parse(ledgerBackup).dispatches || []).map((x) => x.id)
      : []);
    const curList = cur.dispatches || [];
    const isMine = (x) => !before.has(x.id) && String(x.subject || '').startsWith('闭环验证');
    const kept = curList.filter((x) => !isMine(x));
    const removed = curList.length - kept.length;
    const preserved = curList.filter((x) => !before.has(x.id) && !isMine(x)).length;
    cur.dispatches = kept;
    fs.writeFileSync(LEDGER, JSON.stringify(cur, null, 2), 'utf8');
    console.log('  已清理本次测试创建的单 ' + removed + ' 条；' +
      (preserved ? '保留并发写入 ' + preserved + ' 条' : '无并发写入') +
      '（台账共 ' + kept.length + ' 条）');
  } catch (e) {
    // 兜底：解析失败才退回整体覆盖
    if (ledgerBackup !== null) {
      fs.writeFileSync(LEDGER, ledgerBackup, 'utf8');
      console.log('  已恢复台账到测试前状态（' + beforeCount + ' 条，兜底模式）');
    }
  }
} else {
  console.log('  保留测试数据（--keep）');
}

console.log();
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
if (failed.length > 0) {
  console.log('  失败项:');
  for (const f of failed) console.log('    - ' + f.name + (f.detail ? '  ' + f.detail : ''));
}
console.log('═'.repeat(72));

process.exit(failed.length === 0 ? 0 : 1);
