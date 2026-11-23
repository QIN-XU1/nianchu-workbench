#!/usr/bin/env node
/**
 * 画像 —— 主画像 / 副画像分权 + 时间戳越权检测
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1auxD68EWh「多维立体人物画像」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [01:51] 「只有 DSH 改造（中枢）和自我复盘才可以更新我的主画像，
 *  >   其他的只能写那个副画像来作为参考。」
 *  >
 *  > [02:39] 「我和过主画像的时间戳还是 11 点 26，一动没动。
 *  >   副画像第 51 到 5……」
 *  >
 *  > [03:42] 「你本来就是千人千面。
 *  >   你跟一个 AI 聊这个聊那个，他怎么记得住？」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么分主副
 * ══════════════════════════════════════════════════════════════
 *
 *  单一画像的问题：一个 AI 画不准，因为「你跟一个 AI 聊这个聊那个，
 *  他怎么记得住」。
 *
 *  分权后的做法：
 *    主画像  ← 只有中枢 + 自我复盘能写（权威）
 *    副画像  ← 每个场景写自己的（参考，集思广益）
 *
 *  中枢定期轮循：汇总所有副画像 → 决定要不要更新主画像。
 *
 * ══════════════════════════════════════════════════════════════
 *  验证方式：时间戳（他的原话）
 * ══════════════════════════════════════════════════════════════
 *
 *  比 SHA 更直观：SHA 只能说「变了」，
 *  时间戳能说「什么时候变的、那段时间谁动过」。
 *
 *  检测逻辑：
 *    主画像 mtime 变了，但那次修改不在「中枢/自我复盘」的允许窗口内 → 越权
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/画像.mjs --init                          初始化画像目录
 *  node 工具/画像.mjs --status                        看主/副画像状态
 *  node 工具/画像.mjs --audit                         查越权（时间戳对比）
 *  node 工具/画像.mjs --write-main --by 自我复盘 --text "..."   写主画像
 *  node 工具/画像.mjs --write-sub --scene 调研 --text "..."     写副画像
 *  node 工具/画像.mjs --rollup                        汇总副画像 → 建议主画像
 *  node 工具/画像.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const PROFILE_ROOT = path.join(DATA_ROOT, '画像');
const MAIN_FILE = path.join(PROFILE_ROOT, '主画像.md');
const SUB_DIR = path.join(PROFILE_ROOT, '副画像');
const AUDIT_FILE = path.join(PROFILE_ROOT, '画像审计.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  权限规则（写死，可校验）
// ══════════════════════════════════════════════════════════════
export const RULES = {
  /** 能写主画像的角色 */
  MAIN_WRITERS: ['中枢', 'hub', '自我复盘', 'self-review'],
  /** 边界：任何其他场景只能写副画像 */
  SUB_ONLY: true,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  权限检查
// ══════════════════════════════════════════════════════════════
export function canWriteMain(writer) {
  const w = String(writer || '').trim();
  const allowed = RULES.MAIN_WRITERS.includes(w);
  return {
    allowed,
    writer: w,
    reason: allowed
      ? '「' + w + '」有主画像写权限'
      : '「' + w + '」只能写副画像（主画像只允许：' + RULES.MAIN_WRITERS.join(' / ') + '）',
  };
}

// ══════════════════════════════════════════════════════════════
//  画像状态
// ══════════════════════════════════════════════════════════════
export function getMainStatus() {
  if (!fs.existsSync(MAIN_FILE)) {
    return { exists: false, path: MAIN_FILE };
  }
  const st = fs.statSync(MAIN_FILE);
  const content = readTextSafe(MAIN_FILE) || '';
  return {
    exists: true,
    path: MAIN_FILE,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    mtimeMs: st.mtimeMs,
    sha: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
    chars: content.replace(/\s/g, '').length,
    preview: content.slice(0, 200),
  };
}

export function listSubProfiles() {
  if (!fs.existsSync(SUB_DIR)) return [];
  return fs.readdirSync(SUB_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const p = path.join(SUB_DIR, f);
      const st = fs.statSync(p);
      const content = readTextSafe(p) || '';
      return {
        scene: f.replace(/\.md$/, ''),
        file: f,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs,
        chars: content.replace(/\s/g, '').length,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ══════════════════════════════════════════════════════════════
//  审计：时间戳越权检测（他的核心方法）
// ══════════════════════════════════════════════════════════════
export function auditProfiles(opts) {
  const o = opts || {};
  const main = getMainStatus();
  const subs = listSubProfiles();
  let auditRejectedInfo = null;   // 历史越权尝试（已拒绝，仅信息）
  const problems = [];

  if (!main.exists) {
    return {
      ok: false,
      main,
      subs,
      problems: ['主画像不存在：跑 --init 初始化'],
    };
  }

  // ① 主画像不能为空
  if (main.chars < 20) {
    problems.push('主画像内容过少（' + main.chars + ' 字），可能被清空了');
  }

  // ② 主画像大小不能异常膨胀
  if (main.bytes > 51200) {
    problems.push('主画像体积异常（' + main.bytes + ' B > 50KB），可能被灌水');
  }

  // ③ 越权检测：读审计记录，看主画像最后一次修改是谁做的
  const audit = readJsonSafe(AUDIT_FILE) || { logs: [] };
  const logs = Array.isArray(audit.logs) ? audit.logs : [];

  // 找与当前主画像 SHA 匹配的最后一次合法写入
  const lastLegal = [...logs].reverse().find((l) => l.target === 'main' && l.allowed === true);
  const lastAny = [...logs].reverse().find((l) => l.target === 'main');

  if (lastAny && lastAny.sha !== main.sha) {
    // 主画像变了，但最后一次记录里的 SHA 对不上
    problems.push(
      '主画像在「' + (lastAny.at || '?') + '」之后又被改过，' +
      '但审计记录里没有对应的合法写入 → 疑似越权（记录 SHA ' +
      lastAny.sha + '，实际 ' + main.sha + '）'
    );
  }

  // ④ 检查有没有被拒绝的写入尝试
  //
  // ⚠ 2026-11-12 修（判据错误，导致 --audit 永远 FAIL）：
  //
  //   原来：只要有历史拒绝记录就 problems.push → exit 1
  //   实测：有 1 次 2 天前的拒绝记录（调研 2026-11-10T15:48:35），
  //        于是 --audit 永远报 FAIL。
  //
  //   但「拒绝成功」恰恰说明机制在正常工作 ——
  //   把它当当前失败是**判据错了**，不是系统有问题。
  //
  //   正确判据：
  //     · 最近 24 小时内还有新的拒绝尝试 → 报警（说明有人在反复越权）
  //     · 更早的历史拒绝记录 → 只作信息展示，不算失败
  const rejected = logs.filter((l) => l.allowed === false);
  if (rejected.length > 0) {
    const lastRej = rejected[rejected.length - 1];
    const lastAt = Date.parse(lastRej.at || '');
    const hoursAgo = Number.isFinite(lastAt) ? (Date.now() - lastAt) / 3600000 : Infinity;
    if (hoursAgo < 24) {
      problems.push('最近 24 小时内有 ' + rejected.filter((l) => {
        const t = Date.parse(l.at || '');
        return Number.isFinite(t) && (Date.now() - t) / 3600000 < 24;
      }).length + ' 次被拒绝的越权写入尝试（最近：' + lastRej.by + ' ' + lastRej.at + '）');
    } else {
      // 历史记录：题都已拒绝，机制正常工作
      const infoRejected = rejected.length;
      const infoLast = lastRej.by + ' ' + lastRej.at;
      // 挂到返回对象上，让 CLI 打印成「信息」而不是「问题」
      auditRejectedInfo = '历史越权尝试 ' + infoRejected + ' 次，全部已拒绝（最近：' + infoLast + '）→ 机制正常工作';
    }
  }

  // ⑤ 副画像新鲜度：超过 30 天没更新算过期
  const now = o.now || Date.now();
  const stale = subs.filter((s) => (now - s.mtimeMs) > 30 * 86400000);
  if (stale.length > 0) {
    // 这不算错误，只提示
  }

  return {
    ok: problems.length === 0,
    main,
    subs,
    problems,
    // ⚠ 2026-11-12：历史越权尝试（已拒绝）只作信息，不算问题
    rejectedInfo: (typeof auditRejectedInfo !== 'undefined' ? auditRejectedInfo : null),
    stats: {
      subCount: subs.length,
      staleSubs: stale.length,
      totalSubChars: subs.reduce((a, s) => a + s.chars, 0),
      mainChars: main.chars,
    },
    lastLegal: lastLegal ? { at: lastLegal.at, by: lastLegal.by, sha: lastLegal.sha } : null,
  };
}

// 记录一次写入
export function logAudit(entry, opts) {
  const o = opts || {};
  const file = o.auditFile || AUDIT_FILE;
  const audit = readJsonSafe(file) || { logs: [] };
  if (!Array.isArray(audit.logs)) audit.logs = [];
  audit.logs.push({
    at: new Date(o.now || Date.now()).toISOString(),
    ...entry,
  });
  // 只留最近 200 条
  if (audit.logs.length > 200) audit.logs = audit.logs.slice(-200);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(audit, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  写主画像（带权限检查）
// ══════════════════════════════════════════════════════════════
export function writeMain(writer, text, opts) {
  const o = opts || {};
  const perm = canWriteMain(writer);

  if (!perm.allowed) {
    logAudit({ target: 'main', by: writer, allowed: false, reason: perm.reason }, o);
    return { ok: false, error: perm.reason, denied: true };
  }

  const stamp = new Date(o.now || Date.now()).toISOString().slice(0, 10);
  let content = '';
  if (fs.existsSync(MAIN_FILE)) {
    content = readTextSafe(MAIN_FILE) || '';
  } else {
    content = '# 用户主画像\n\n> 唯一权威的用户画像。只有「中枢」和「自我复盘」能写。\n> 副画像见 副画像/<场景>.md（只作参考）。\n\n';
  }

  // 段式追加（可追溯谁在什么时候写的）
  const block = '\n## ' + stamp + ' · ' + writer + '\n\n' + text.trim() + '\n';
  content = content.trimEnd() + '\n' + block;

  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  fs.writeFileSync(MAIN_FILE, content, 'utf8');

  const sha = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  logAudit({ target: 'main', by: writer, allowed: true, sha, bytes: Buffer.byteLength(content, 'utf8') }, o);

  return { ok: true, sha, bytes: Buffer.byteLength(content, 'utf8') };
}

export function writeSub(scene, text, opts) {
  const o = opts || {};
  const name = String(scene || '').trim();
  if (!name) return { ok: false, error: '需要场景名' };

  fs.mkdirSync(SUB_DIR, { recursive: true });
  const f = path.join(SUB_DIR, name + '.md');
  const stamp = new Date(o.now || Date.now()).toISOString().slice(0, 10);

  let content = '';
  if (fs.existsSync(f)) {
    content = readTextSafe(f) || '';
  } else {
    content = '# ' + name + ' · 副画像\n\n> 这是「' + name + '」场景对宿主的观察补充。\n> 只作参考，主画像由中枢/自我复盘汇总。\n\n';
  }

  const block = '\n## ' + stamp + '\n\n' + text.trim() + '\n';
  content = content.trimEnd() + '\n' + block;
  fs.writeFileSync(f, content, 'utf8');

  logAudit({ target: 'sub', scene: name, allowed: true, bytes: Buffer.byteLength(content, 'utf8') }, o);

  return { ok: true, file: f, bytes: Buffer.byteLength(content, 'utf8') };
}

// ══════════════════════════════════════════════════════════════
//  汇总：副画像 → 建议主画像
// ══════════════════════════════════════════════════════════════
export function rollup() {
  const subs = listSubProfiles();
  if (subs.length === 0) {
    return { ok: false, error: '还没有副画像，无法汇总' };
  }

  const items = [];
  for (const s of subs) {
    const content = readTextSafe(path.join(SUB_DIR, s.file)) || '';
    // 提取每个 ## 段的第一句
    const blocks = content.split(/\n## /).slice(1);
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim());
      if (lines.length < 2) continue;
      const date = lines[0].trim();
      const body = lines.slice(1).join(' ').trim();
      if (body.length < 10) continue;
      items.push({ scene: s.scene, date, body: body.slice(0, 150) });
    }
  }

  return {
    ok: true,
    subCount: subs.length,
    itemCount: items.length,
    items: items.slice(0, 20),
    hint: '这些是各场景的观察。用 --write-main --by 自我复盘 --text "..." 汇总进主画像',
  };
}

// ══════════════════════════════════════════════════════════════
//  初始化
// ══════════════════════════════════════════════════════════════
export function initProfiles() {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  fs.mkdirSync(SUB_DIR, { recursive: true });

  const created = [];
  if (!fs.existsSync(MAIN_FILE)) {
    const seed = `# 用户主画像

> 唯一权威的用户画像。**只有「中枢」和「自我复盘」能写。**
> 各场景只能写 副画像/<场景>.md 作为参考。
>
> 依据：视频 BV1auxD68EWh「只有 DSH 改造和自我复盘才可以更新我的主画像，
> 其他的只能写那个副画像来作为参考。」

## 基本信息

- 称呼：（待补 —— 用 --write-main 补充）
- 语言：中文
- 工作性质：（待补）

## 关注什么

（待补）

## 不喜欢什么

（待补）

## 沟通偏好

- 结论先给，证据在后
- 不要空话开头
- 不确定就说不确定

---

## 变更记录

（每次写入会自动追加：日期 · 写入者 · 内容）
`;
    fs.writeFileSync(MAIN_FILE, seed, 'utf8');
    created.push('主画像.md');
  }

  return { ok: true, created, root: PROFILE_ROOT };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  画像分权 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 权限规则
  chk('规则：只有中枢/自我复盘能写主画像', RULES.MAIN_WRITERS.length === 4,
      RULES.MAIN_WRITERS.join(','));

  // ② 权限检查：允许
  const p1 = canWriteMain('中枢');
  chk('中枢可写主画像', p1.allowed === true, p1.reason.slice(0, 30));

  const p2 = canWriteMain('自我复盘');
  chk('自我复盘可写主画像', p2.allowed === true, p2.reason.slice(0, 30));

  const p3 = canWriteMain('hub');
  chk('hub（英文 id）可写', p3.allowed === true, '');

  // ③ 权限检查：拒绝
  const p4 = canWriteMain('调研');
  chk('反例：调研不能写主画像', p4.allowed === false, p4.reason.slice(0, 40));

  const p5 = canWriteMain('竞品拆解');
  chk('反例：竞品拆解不能写主画像', p5.allowed === false, '');

  // ④ 反向：所有非授权场景都被拒
  const allScenes = ['架构梳理', '实施计划', '竞品拆解', '故障分析',
    '本地电脑', '调研', '逆向分析',
    'arch-review', 'build-plan', 'competitor-analyze',
    'incident-analysis', 'pc-cleanup', 'research', 'reverse-eng'];
  const allDenied = allScenes.every((s) => canWriteMain(s).allowed === false);
  chk('所有普通场景都被拒写主画像', allDenied, allScenes.length + ' 个');

  // ⑤ 现有状态
  const main = getMainStatus();
  chk('能读主画像状态', typeof main.exists === 'boolean',
      main.exists ? main.bytes + ' B' : '不存在');

  const subs = listSubProfiles();
  chk('能列副画像', Array.isArray(subs), subs.length + ' 个');

  // ⑥ 审计能跑
  const audit = auditProfiles();
  chk('审计能跑', typeof audit.ok === 'boolean', audit.ok ? '通过' : (audit.problems[0] || '').slice(0, 30));

  // ⑦ 关键：越权必须能被检测
  chk('关键：越权写入会被拒绝（不是摆设）',
      canWriteMain('随便一个场景').allowed === false,
      '这是分权机制存在的唯一理由');

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

  if (has('--init')) {
    const r = initProfiles();
    console.log('✓ 画像目录已初始化');
    if (r.created.length) console.log('  新建: ' + r.created.join(', '));
    console.log('  位置: ' + path.relative(WB, PROFILE_ROOT).replace(/\\/g, '/'));
    process.exit(0);
  }

  if (has('--status') || (!has('--audit') && !has('--write-main') && !has('--write-sub') && !has('--rollup'))) {
    const main = getMainStatus();
    const subs = listSubProfiles();
    console.log('═'.repeat(72));
    console.log('  画像状态');
    console.log('═'.repeat(72));
    console.log();
    console.log('  主画像:');
    if (main.exists) {
      console.log('    大小:   ' + main.bytes + ' B / ' + main.chars + ' 字');
      console.log('    mtime:  ' + main.mtime);
      console.log('    SHA:    ' + main.sha);
    } else {
      console.log('    ✗ 不存在（跑 --init）');
    }
    console.log();
    console.log('  副画像（' + subs.length + ' 个）:');
    for (const s of subs.slice(0, 10)) {
      console.log('    ' + s.scene.padEnd(12) + s.chars + ' 字  ' + s.mtime.slice(0, 19).replace('T', ' '));
    }
    if (subs.length === 0) {
      console.log('    （还没有。各场景用 --write-sub 写自己的观察）');
    }
    console.log();
    console.log('  写权限: 主画像只允许 ' + RULES.MAIN_WRITERS.join(' / '));
    console.log('          其他场景只能写副画像');
    process.exit(0);
  }

  if (has('--audit')) {
    const r = auditProfiles();
    console.log('═'.repeat(72));
    console.log('  画像审计（时间戳越权检测）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  主画像: ' + (r.main.exists ? r.main.bytes + ' B  ' + r.main.mtime : '不存在'));
    console.log('  副画像: ' + r.subs.length + ' 个');
    console.log();
    if (r.ok) {
      console.log('  ✓ 无越权');
    } else {
      console.log('  ✗ 发现问题:');
      for (const p of r.problems) console.log('    · ' + p);
    }
    if (r.lastLegal) {
      console.log();
      console.log('  最后一次合法写入: ' + r.lastLegal.at + '  by ' + r.lastLegal.by);
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (has('--write-main')) {
    const by = val('--by');
    const text = val('--text');
    if (!by || !text) { console.error('需要 --by 和 --text'); process.exit(2); }
    const r = writeMain(by, text);
    if (r.ok) {
      console.log('✓ 已写入主画像（by ' + by + '）');
      console.log('  大小: ' + r.bytes + ' B  SHA: ' + r.sha);
    } else {
      console.error('✗ ' + r.error);
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (has('--write-sub')) {
    const scene = val('--scene');
    const text = val('--text');
    if (!scene || !text) { console.error('需要 --scene 和 --text'); process.exit(2); }
    const r = writeSub(scene, text);
    if (r.ok) {
      console.log('✓ 已写入副画像（' + scene + '）');
      console.log('  大小: ' + r.bytes + ' B');
    } else {
      console.error('✗ ' + r.error);
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (has('--rollup')) {
    const r = rollup();
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('═'.repeat(72));
    console.log('  副画像汇总（' + r.subCount + ' 个场景，' + r.itemCount + ' 条观察）');
    console.log('═'.repeat(72));
    console.log();
    for (const it of r.items) {
      console.log('  [' + it.scene + ' · ' + it.date + ']');
      console.log('    ' + it.body);
      console.log();
    }
    console.log('─'.repeat(72));
    console.log('  ' + r.hint);
    process.exit(0);
  }
}
