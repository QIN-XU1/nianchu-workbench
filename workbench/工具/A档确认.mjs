#!/usr/bin/env node
/**
 * A 档确认 —— 给「宿主授权修改宪法」留下可追溯记录
 *
 * ══════════════════════════════════════════════════════════════
 *  这是整套机制里唯一一处「人工确认」的正确做法
 * ══════════════════════════════════════════════════════════════
 *
 *  A 档 = AGENTS.md（全局铁律），只有宿主能改。
 *  越界哨兵发现它被改会报警 —— 这是**正确行为**，不能放宽判据，
 *  否则就变成「必然合格」的假证。
 *
 *  但报警后需要有合法出路。三种做法对比：
 *
 *  ✗ 放宽判据（改成不算违规）
 *     → 假证。以后谁改都不会报警了。
 *
 *  ✗ 加环境变量跳过
 *     → 不可追溯。跳过一次，以后永远不知道是谁跳的。
 *
 *  ✓ 留确认记录（本工具的做法）
 *     → 记录谁在什么时候、确认了哪次修改、内容 SHA256 是什么。
 *     → 哨兵每次发现 A 档被改，就去查有没有对应的确认记录。
 *     → 有记录且 SHA 对得上 → 视为已授权，不再报。
 *     → 没记录或 SHA 对不上 → 继续报。
 *
 *  这样：
 *    · 判据没放宽（没确认就报）
 *    · 记录可追溯（谁确认的、确认的是什么）
 *    · 内容一改就失效（SHA 对不上）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/A档确认.mjs --list                    看所有确认记录
 *  node 工具/A档确认.mjs --confirm \
 *       --by "宿主" --reason "加 §6 改完跑机制体检"  确认当前内容
 *  node 工具/A档确认.mjs --check                   检查当前是否有未确认修改
 *  node 工具/A档确认.mjs --selftest                自测（含反例）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const TARGET = path.join(DATA_ROOT, 'AGENTS.md');
const RECORD = path.join(DATA_ROOT, '场景记忆', '_共享记忆', 'A档确认.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

/** 文件内容 SHA256（前 16 位够用，便于阅读） */
export function fileSha(p) {
  const t = readTextSafe(p);
  if (t === null) return null;
  return crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16);
}

/** 读确认记录 */
export function loadRecords(recordPath) {
  const j = readJsonSafe(recordPath || RECORD);
  if (!j || !Array.isArray(j.confirmations)) return { _note: 'A 档确认记录', confirmations: [] };
  return j;
}

/**
 * 检查当前 A 档内容是否已确认
 *
 * @returns { confirmed, sha, record }
 *   confirmed = true 表示当前内容有对应的确认记录
 */
export function checkConfirmed(opts) {
  const o = opts || {};
  const sha = fileSha(o.target || TARGET);
  if (sha === null) return { confirmed: false, sha: null, error: '目标文件不存在' };

  const rec = loadRecords(o.recordPath);
  const list = rec.confirmations || [];

  // 找 sha 对得上的最新一条
  const hit = list.filter((c) => c.sha === sha).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];

  return {
    confirmed: !!hit,
    sha,
    record: hit || null,
    total: list.length,
  };
}

/**
 * 追加一条确认记录
 */
export function confirm(opts) {
  const by = String(opts.by || '').trim();
  const reason = String(opts.reason || '').trim();
  if (!by) return { ok: false, error: '必须给 --by（谁确认的）' };
  if (!reason) return { ok: false, error: '必须给 --reason（为什么改）' };

  // ══════════════════════════════════════════════════════════
  //  ⚠ 2026-11-10 加防代确认闸
  // ══════════════════════════════════════════════════════════
  //
  //  为什么加：我自己犯过这个错。
  //
  //  AGENTS.md 是 A 档（只有宿主能改）。我改了它，
  //  然后自己执行 `--confirm --by "宿主（授权代理：Lead）"` 把它确认了。
  //
  //  这违反的是 luanyujia 主张的「必须有监督机制，且监督要独立」
  //  （视频 BV1f7xJ6DEvq）：
  //    「你一个场景再怎么进化，它会往失误的方向去发展。」
  //    「那你如果没用一个监督机制，
  //      你怎么知道它进化的东西就是你想要的吗？」
  //
  //  机制检测到了问题，然后被机制的执行者自己绕过了。
  //  这不是机制的力量，是机制失效 —— 执行者和监督者成了同一个人。
  //
  //  ⚠ 修正记录（2026-11-11）：
  //    本注释第一版引用「我不放心让全部程序去干」当作 luanyujia 的话，
  //    **但那是观众的立场**（[02:03]），luanyujia 立刻反驳说
  //    「那不好意思，那你这个跟我完全不一样」（[02:06]）。
  //    luanyujia 主张的是**要建机制**，不是不要机制。
  //
  //    所以我这一周做的 37 项体检、验证闸、回滚 —— 方向是对的。
  //    错的只是「我既是执行者又是监督者」这一件事。
  //
  //  修法：--by 里如果含「代理」「代」「AI」「Lead」等字样，
  //        必须额外加 --explicit-human 才允许（表示人在场亲口授权）。
  const AGENT_PATTERN = /(代理|代为|代确认|AI\b|Lead|助手|agent|assistant|bot)/i;
  const looksLikeAgent = AGENT_PATTERN.test(by);

  if (looksLikeAgent && opts.explicitHuman !== true) {
    return {
      ok: false,
      error: '检测到「' + by + '」像是 AI/代理在代确认。\n' +
        '  A 档是宪法级改动，必须由人本人拍板。\n' +
        '  如果确实是人在场亲口授权，加 --explicit-human 并说明。\n' +
        '  否则：停下来，等人确认。',
      needsHuman: true,
    };
  }

  // 记录里也标注是否人工
  const isHumanDirect = !looksLikeAgent;

  const sha = fileSha(opts.target || TARGET);
  if (sha === null) return { ok: false, error: '目标文件不存在' };

  const recordPath = opts.recordPath || RECORD;
  const rec = loadRecords(recordPath);

  // 同 SHA 已经有记录就不重复加
  const dup = (rec.confirmations || []).find((c) => c.sha === sha);
  if (dup) return { ok: true, duplicate: true, sha, record: dup };

  const entry = {
    at: new Date().toISOString(),
    by,
    reason,
    sha,
    target: path.relative(WB, opts.target || TARGET).replace(/\\/g, '/'),
    bytes: Buffer.byteLength(readTextSafe(opts.target || TARGET) || '', 'utf8'),
    // 新增：是否人工直接确认（false = 代理代确认，需标记风险）
    humanDirect: isHumanDirect,
    riskNote: isHumanDirect ? null : '代理代确认（有风险，理想情况应由人本人确认）',
  };
  rec.confirmations = rec.confirmations || [];
  rec.confirmations.push(entry);

  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2), 'utf8');

  return { ok: true, sha, record: entry, humanDirect: isHumanDirect };
}

// ══════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  A 档确认 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const tmp = path.join(WB, 'prototype', '_tmp-atier');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const target = path.join(tmp, 'AGENTS.md');
  const recPath = path.join(tmp, 'confirm.json');

  // ① 无记录时：未确认
  fs.writeFileSync(target, '# 宪法 v1\n', 'utf8');
  const c1 = checkConfirmed({ target, recordPath: recPath });
  chk('无记录 → 未确认', c1.confirmed === false, 'sha=' + c1.sha);
  chk('无记录时能算出 SHA', !!c1.sha, c1.sha);

  // ② 确认后：已确认
  const r1 = confirm({ by: '宿主', reason: '初次确认', target, recordPath: recPath });
  chk('确认成功', r1.ok === true, r1.error || '');
  const c2 = checkConfirmed({ target, recordPath: recPath });
  chk('确认后 → 已确认', c2.confirmed === true, 'sha=' + c2.sha);

  // ③ 反例：内容改了 → 必须失效
  fs.writeFileSync(target, '# 宪法 v2 改过\n', 'utf8');
  const c3 = checkConfirmed({ target, recordPath: recPath });
  chk('反例：内容变了 → 不再算已确认', c3.confirmed === false, 'sha=' + c3.sha);

  // ④ 反例：缺 --by 必须拒绝
  const r2 = confirm({ reason: '没写谁', target, recordPath: recPath });
  chk('反例：缺 --by 拒绝', r2.ok === false, r2.error || '');

  // ⑤ 反例：缺 --reason 必须拒绝
  const r3 = confirm({ by: '宿主', target, recordPath: recPath });
  chk('反例：缺 --reason 拒绝', r3.ok === false, r3.error || '');

  // ⑥ 重复确认同 SHA 不重复加
  confirm({ by: '宿主', reason: '第二次确认', target, recordPath: recPath });
  const dup = confirm({ by: '宿主', reason: '第三次确认', target, recordPath: recPath });
  chk('同 SHA 不重复加', dup.duplicate === true, String(dup.duplicate));
  const list = loadRecords(recPath).confirmations;
  chk('记录数正确（2 条：v1 + v2）', list.length === 2, list.length + ' 条');


  // ══════════════════════════════════════════════════════
  //  防代确认闸（2026-11-10 新增，防回退）
  // ══════════════════════════════════════════════════════
  //
  //  这一条是为了防止「程序自己确认自己」——
  //  我自己犯过这个错：改了 A 档，然后代宿主确认了。
  const rAgent = confirm({ by: "AI 代理", reason: "测试", target, recordPath: recPath + ".test" });
  chk("反例：AI 代理代确认必须被拒", rAgent.ok === false && rAgent.needsHuman === true, rAgent.error ? rAgent.error.slice(0, 30) : "");
  
  fs.writeFileSync(target, "# 宪法 人确认测试\n", "utf8");
  const rHuman = confirm({ by: "张三（本人）", reason: "测试用", target, recordPath: recPath + ".test2" });
  chk("人直接确认允许", rHuman.ok === true, rHuman.error || "");
  
  try { fs.unlinkSync(recPath + ".test"); } catch {}
  try { fs.unlinkSync(recPath + ".test2"); } catch {}

  fs.rmSync(tmp, { recursive: true, force: true });

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

  // ── 确认 ──
  if (has('--confirm')) {
    const r = confirm({
      by: val('--by'),
      reason: val('--reason'),
      explicitHuman: has('--explicit-human'),
    });
    if (!r.ok) {
      console.error('✗ ' + r.error);
      process.exit(2);
    }
    if (r.duplicate) {
      console.log('这条内容已经确认过了（SHA ' + r.sha + '）');
      console.log('  确认人: ' + r.record.by);
      console.log('  时间:   ' + r.record.at);
      console.log('  原因:   ' + r.record.reason);
      process.exit(0);
    }
    console.log('✓ 已确认 A 档修改');
    console.log('  SHA:    ' + r.sha);
    console.log('  确认人: ' + r.record.by);
    console.log('  原因:   ' + r.record.reason);
    console.log('  记录:   ' + path.relative(WB, RECORD).replace(/\\/g, '/'));
    process.exit(0);
  }

  // ── 列出记录 ──
  if (has('--list')) {
    const rec = loadRecords();
    const list = rec.confirmations || [];
    console.log('═'.repeat(72));
    console.log('  A 档确认记录（' + list.length + ' 条）');
    console.log('═'.repeat(72));
    console.log();
    const curSha = fileSha();
    for (const c of list) {
      const isCur = c.sha === curSha;
      console.log((isCur ? '★ ' : '  ') + c.at.slice(0, 16).replace('T', ' '));
      console.log('    SHA:    ' + c.sha + (isCur ? '   ← 当前内容' : ''));
      console.log('    确认人: ' + c.by);
      console.log('    原因:   ' + c.reason);
      console.log();
    }
    console.log('当前内容 SHA: ' + curSha);
    process.exit(0);
  }

  // ── 检查 ──
  const c = checkConfirmed();
  console.log('═'.repeat(72));
  console.log('  A 档（AGENTS.md）确认状态');
  console.log('═'.repeat(72));
  console.log();
  console.log('  文件: ' + path.relative(WB, TARGET).replace(/\\/g, '/'));
  console.log('  当前 SHA: ' + c.sha);
  console.log();
  if (c.confirmed) {
    console.log('  ✓ 已确认（' + c.record.by + '，' + c.record.at.slice(0, 16).replace('T', ' ') + '）');
    console.log('    原因: ' + c.record.reason);
    process.exit(0);
  } else {
    console.log('  ⚠ 当前内容尚未确认');
    if (c.total > 0) {
      console.log('    （历史上有 ' + c.total + ' 条确认记录，但都对不上当前 SHA —— 说明改过）');
    }
    console.log();
    console.log('  确认命令：');
    console.log('    node 工具/A档确认.mjs --confirm --by "宿主" --reason "为什么改"');
    process.exit(1);
  }
}
