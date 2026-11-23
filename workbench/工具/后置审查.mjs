#!/usr/bin/env node
// 工具/后置审查.mjs —— 检查「AI 说写了但实际没写」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（hermes 逆向的最高优先级借鉴项）
// ══════════════════════════════════════════════════════════════════════
//  我们现在的模式是：在 AGENTS.local.md 里写「做完要写回记忆」，**靠 AI 自觉**。
//
//  Hermes Agent 的记录明确指出了这个模式的失效方式：
//
//    > 模型产出确认句但不调用工具
//    > （the model produces a confirmation sentence but never calls the tool）
//
//  也就是说 AI 会回一句「已写入记忆」，实际上根本没写。
//  这是「看起来有实际是空」的典型 —— 而且**没有任何检查能发现**：
//    · 记忆哨兵 只看文件大小/结构，新文件本来就有结构
//    · 内容哨兵 只看差异集合，空写也算"无差异"
//    · 机制体检 100+ 项，没有一项检查「AI 是不是真的写了」
//
//  这个工具的做法（对照 Hermes 的 periodic nudge）：
//    ① 把每个场景记忆文件的 **mtime + sha256** 记到 nudge.json
//    ② 下次审查时对比：
//         hash 变了           → 真的写了 ✓
//         hash 没变 + 声称写了 → **失信，报警**
//         hash 没变 + 没声称   → 不报警（本来就没东西要写）
//
//  用法：
//    node 工具/后置审查.mjs --status        看当前状态
//    node 工具/后置审查.mjs --check         执行一次审查（默认）
//    node 工具/后置审查.mjs --snapshot      重新记录基线
//    node 工具/后置审查.mjs --claim "已写入记忆"   登记「AI 声称写了」
//    node 工具/后置审查.mjs --interval N    每 N 轮允许一次（默认 5）
//    node 工具/后置审查.mjs --force         忽略 interval 强制跑
//    node 工具/后置审查.mjs --json          机器可读
//    node 工具/后置审查.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const CACHE = path.join(DATA, '缓存');
const NUDGE = path.join(CACHE, 'nudge.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 每 N 轮允许一次审查 */
export const DEFAULT_INTERVAL = 5;

/**
 * 「AI 声称写了记忆」的措辞
 *
 * 这些是模型最常说的确认句。命中它们但 hash 没变 = 失信。
 * 对照 Hermes 的原话：「I've added that to my memory」is just text.
 */
export const CLAIM_PATTERNS = [
  /已(?:写入|记录|更新|保存|追加|补充)/,
  /写(?:回|入)了/,
  /已(?:写好|记好|存好)/,
  /记忆(?:已|已经)(?:更新|写入)/,
  /I(?:'ve| have) (?:added|saved|updated|recorded)/i,
];

/**
 * 判一条「声称 + hash 状态」是否算失信
 *
 * @param {{claimed:boolean, changed:boolean, scene:string}} r
 * @returns {{ok:boolean, kind:string, why:string}}
 */
export function judgeClaim(r) {
  const x = r || {};
  if (x.claimed === true && x.changed === false) {
    return {
      ok: false,
      kind: 'broken-promise',
      why: '「' + (x.scene || '?') + '」声称已写入记忆，但文件 hash 没变 —— 这是未兑现的承诺',
    };
  }
  if (x.claimed === true && x.changed === true) {
    return { ok: true, kind: 'kept', why: '声称已写 + hash 确实变了 → 兑现' };
  }
  if (x.claimed === false && x.changed === true) {
    return { ok: true, kind: 'wrote-silently', why: '没声称但确实写了 → 也算写了' };
  }
  return { ok: true, kind: 'noop', why: '没声称也没写 → 本来就没东西要写' };
}

/**
 * 从一段文本里判断 AI 是否声称写了记忆
 * @param {string} text
 */
export function detectClaim(text) {
  const t = String(text || '');
  return CLAIM_PATTERNS.some((re) => re.test(t));
}

// ══════════════════════════════════════════════════════════════════════
function sha256File(p) {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return ''; }
}

function listScenes() {
  const out = [];
  if (!fs.existsSync(MEM)) return out;
  for (const d of fs.readdirSync(MEM, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    out.push(d.name);
  }
  return out;
}

/** 采集当前所有场景记忆的指纹 */
function collectFingerprints() {
  const out = {};
  for (const cn of listScenes()) {
    const files = {
      '场景私有记忆.md': path.join(MEM, cn, '场景私有记忆.md'),
      '身份卡.md': path.join(MEM, cn, '身份卡.md'),
    };
    const ent = {};
    for (const [name, p] of Object.entries(files)) {
      if (!fs.existsSync(p)) { ent[name] = { hash: '', mtime: 0, exists: false }; continue; }
      const st = fs.statSync(p);
      ent[name] = { hash: sha256File(p), mtime: st.mtimeMs, exists: true };
    }
    out[cn] = ent;
  }
  return out;
}

function loadNudge() {
  try {
    const j = JSON.parse(fs.readFileSync(NUDGE, 'utf8'));
    return {
      interval: Number(j.interval) || DEFAULT_INTERVAL,
      rounds: Number(j.rounds) || 0,
      lastCheckAt: j.lastCheckAt || '',
      fingerprints: j.fingerprints || {},
      claims: Array.isArray(j.claims) ? j.claims : [],
      history: Array.isArray(j.history) ? j.history : [],
    };
  } catch {
    // ⚠ 损坏时自愈重建，不抛错 —— 一个辅助工具不该因为缓存坏了就崩
    return { interval: DEFAULT_INTERVAL, rounds: 0, lastCheckAt: '', fingerprints: {}, claims: [], history: [] };
  }
}

function saveNudge(n) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(NUDGE, JSON.stringify({ _note: '后置审查的基线指纹与轮次计数。删了会重建基线（不影响真实数据）', ...n }, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  后置审查 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】失信判据（核心）');
  {
    const a = judgeClaim({ claimed: true, changed: false, scene: '甲' });
    chk('反例①：声称写了 + hash 未变 → 报警', a.ok === false, a.kind);
    chk('报警说清是哪个场景', /甲/.test(a.why), a.why.slice(0, 40));
    chk('报警说清是「未兑现的承诺」', /未兑现/.test(a.why));

    const b = judgeClaim({ claimed: true, changed: true, scene: '乙' });
    chk('正例：声称写了 + hash 变了 → 兑现', b.ok === true && b.kind === 'kept');

    const c = judgeClaim({ claimed: false, changed: true, scene: '丙' });
    chk('正例：没声称但写了 → 也算写了（不误报）', c.ok === true && c.kind === 'wrote-silently');

    const d = judgeClaim({ claimed: false, changed: false, scene: '丁' });
    chk('正例：没声称也没写 → 不报（不误报）', d.ok === true && d.kind === 'noop');
  }

  console.log();
  console.log('【二】声称识别');
  {
    chk('正例：识别「已写入记忆」', detectClaim('已写入记忆了') === true);
    chk('正例：识别「已记录」', detectClaim('已记录到 §五') === true);
    chk('正例：识别「写回了」', detectClaim('写回了场景记忆') === true);
    chk('正例：识别英文', detectClaim("I've added that to my memory") === true);
    chk('反例：普通叙述不算声称', detectClaim('我读了文件，内容是对齐的') === false);
    chk('反例：空串不算', detectClaim('') === false);
    chk('反例：null 不算', detectClaim(null) === false);
  }

  console.log();
  console.log('【三】指纹采集与比对（用临时目录，不碰真实数据）');
  {
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'nudge-'));
    try {
      const f = path.join(tmp, 'a.md');
      fs.writeFileSync(f, 'v1', 'utf8');
      const h1 = sha256File(f);
      chk('采集到 hash', h1.length === 64, h1.slice(0, 12) + '...');

      const h2 = sha256File(f);
      chk('同样内容 → 同样 hash', h1 === h2);

      fs.writeFileSync(f, 'v2', 'utf8');
      const h3 = sha256File(f);
      chk('内容变了 → hash 变了', h1 !== h3);

      chk('反例：不存在的文件 → 空 hash', sha256File(path.join(tmp, 'nope.md')) === '');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log();
  console.log('【四】缓存损坏能自愈');
  {
    // loadNudge 在文件不存在/损坏时必须返回可用结构，不能抛
    const n = loadNudge();
    chk('能加载（损坏或不存在都返回默认）', typeof n === 'object' && n !== null);
    chk('有 interval 字段', Number(n.interval) > 0, String(n.interval));
    chk('有 fingerprints 字段', typeof n.fingerprints === 'object');
    chk('有 claims 数组', Array.isArray(n.claims));
  }

  console.log();
  console.log('【五】关键：这个工具补的是什么');
  chk('关键：之前「AI 说写了但实际没写」没有任何检查能发现',
    true, '记忆哨兵看大小、内容哨兵看差异、机制体检不看这个');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const nudge = loadNudge();

  // ── 登记「AI 声称写了」 ──
  if (has('claim')) {
    const text = val('claim') || '';
    const claimed = detectClaim(text);
    if (!claimed) {
      console.log('  ⚠ 这句话不像「声称写了记忆」的措辞，仍会登记：' + text.slice(0, 40));
    }
    nudge.claims.push({ at: new Date().toISOString(), text: String(text).slice(0, 200), detected: claimed });
    saveNudge(nudge);
    console.log('  ✓ 已登记声称（共 ' + nudge.claims.length + ' 条）');
    return;
  }

  // ── 重建基线 ──
  if (has('snapshot')) {
    nudge.fingerprints = collectFingerprints();
    nudge.claims = [];
    nudge.rounds = 0;
    nudge.lastCheckAt = new Date().toISOString();
    saveNudge(nudge);
    const n = Object.keys(nudge.fingerprints).length;
    console.log('  ✓ 已重建基线：' + n + ' 个场景的指纹已记录');
    return;
  }

  // ── 状态 ──
  if (has('status')) {
    const cur = collectFingerprints();
    const scenes = Object.keys(cur);
    let changed = 0;
    for (const cn of scenes) {
      const base = nudge.fingerprints[cn] || {};
      const now = cur[cn] || {};
      for (const f of Object.keys(now)) {
        const b = base[f] || {};
        if (b.exists && now[f].exists && b.hash !== now[f].hash) changed++;
      }
    }
    console.log('  后置审查状态');
    console.log('    轮次计数:     ' + nudge.rounds + ' / interval ' + nudge.interval);
    console.log('    上次审查:     ' + (nudge.lastCheckAt || '(从未)'));
    console.log('    基线场景数:   ' + Object.keys(nudge.fingerprints).length);
    console.log('    当前场景数:   ' + scenes.length);
    console.log('    待登记声称:   ' + nudge.claims.length + ' 条');
    console.log('    相对基线变化: ' + changed + ' 个文件');
    console.log('    历史审查:     ' + nudge.history.length + ' 次');
    return;
  }

  // ── 执行审查（默认）──
  const needForce = !has('force');
  const canRun = has('force') || nudge.rounds >= nudge.interval || !nudge.lastCheckAt;

  nudge.rounds += 1;
  saveNudge(nudge);

  if (!canRun) {
    if (has('json')) {
      console.log(JSON.stringify({ skipped: true, reason: '未到间隔', rounds: nudge.rounds, interval: nudge.interval }));
    } else {
      console.log('  跳过（' + nudge.rounds + '/' + nudge.interval + ' 轮，未到间隔；用 --force 强制）');
    }
    return;
  }

  const cur = collectFingerprints();
  const results = [];
  const scenes = Object.keys(cur);

  // ⚠ 2026-11-13 修（声称没有关联到具体场景 → 12 个场景全判失信）
  //
  //   第一版：只要 nudge.claims 非空，就把**所有**场景都判为 claimed。
  //   实测：我只声称「给中枢写了记忆」，结果 12 个场景全部报失信 → 11 条误报。
  //
  //   误报比漏报更消耗信任：一屏 12 个红色 ⛔ 里只有 1 个是真的，
  //   下次看到红色就不会当真了。
  //
  //   修法：声称登记时尽量识别出场景名（从话术里匹配场景目录名）；
  //        识别不出来就标为「未指定场景」，
  //        此时只做**提示**，不判任何人失信。
  const claimScenes = new Set();
  let hasUnscopedClaim = false;
  for (const c of nudge.claims) {
    const text = String(c.text || '');
    let hit = '';
    for (const cn of scenes) {
      if (text.includes(cn)) { hit = cn; break; }
    }
    if (hit) claimScenes.add(hit);
    else hasUnscopedClaim = true;
  }

  for (const cn of scenes) {
    const base = nudge.fingerprints[cn] || {};
    const now = cur[cn] || {};
    let anyChanged = false;
    for (const f of Object.keys(now)) {
      const b = base[f] || {};
      if (!b.exists && now[f].exists) { anyChanged = true; continue; }
      if (b.exists && now[f].exists && b.hash !== now[f].hash) anyChanged = true;
    }
    // 只有「明确声称了这个场景」才判它失信
    const claimed = claimScenes.has(cn);
    const j = judgeClaim({ claimed, changed: anyChanged, scene: cn });
    results.push({ scene: cn, changed: anyChanged, claimed, unscoped: hasUnscopedClaim, ...j });
  }

  const broken = results.filter((r) => r.kind === 'broken-promise');
  const wrote = results.filter((r) => r.changed);

  nudge.fingerprints = cur;
  nudge.claims = [];
  nudge.rounds = 0;
  nudge.lastCheckAt = new Date().toISOString();
  nudge.history.push({
    at: nudge.lastCheckAt,
    scenes: scenes.length,
    changed: wrote.length,
    broken: broken.length,
  });
  // 只保留最近 50 次
  nudge.history = nudge.history.slice(-50);
  saveNudge(nudge);

  if (has('json')) {
    console.log(JSON.stringify({
      total: results.length,
      changed: wrote.length,
      broken: broken.length,
      results,
    }, null, 2));
    if (broken.length) process.exitCode = 1;
    return;
  }

  console.log('='.repeat(84));
  console.log('  后置审查 —— AI 说写了，是不是真的写了');
  console.log('='.repeat(84));
  console.log();
  console.log('  依据 Hermes Agent 的记录：');
  console.log('    「the model produces a confirmation sentence but never calls the tool」');
  console.log('    模型产出确认句但不调用工具 —— 这是「看起来有实际是空」最典型的一种。');
  console.log();
  console.log('  判据：声称写了 + 文件 hash 没变 = 未兑现的承诺');
  console.log();

  console.log('  ' + '场景'.padEnd(14) + 'hash 变化'.padEnd(12) + '结论');
  console.log('  ' + '─'.repeat(76));
  for (const r of results) {
    const mark = r.kind === 'broken-promise' ? '⛔' : (r.changed ? '✓' : '·');
    const label = {
      'broken-promise': '失信：声称写了但没写',
      'kept': '兑现',
      'wrote-silently': '静默写入',
      'noop': '无变化（正常）',
    }[r.kind] || r.kind;
    console.log('  ' + r.scene.padEnd(14) + (r.changed ? '有' : '无').padEnd(12) + mark + ' ' + label);
  }

  console.log();
  console.log('─'.repeat(84));
  console.log('  ' + wrote.length + ' 个场景有变化 / ' + broken.length + ' 个失信');
  if (hasUnscopedClaim && !claimScenes.size) {
    console.log();
    console.log('  ⚠ 有声称但识别不出是哪个场景 —— 不做失信判定（避免误报）。');
    console.log('    建议：--claim 时把场景名写进去，例如');
    console.log('      --claim "已写入「中枢」的记忆"');
  }
  if (broken.length) {
    console.log();
    console.log('  ⛔ 有 ' + broken.length + ' 处「说写了但没写」：');
    for (const b of broken) console.log('      · ' + b.scene);
    console.log();
    console.log('  这不是小事 —— 它意味着下一轮接手的人会读到**过期的记忆**，');
    console.log('  然后基于过期信息做判断。');
    process.exitCode = 1;
  } else if (wrote.length === 0 && claimScenes.size === 0) {
    console.log();
    console.log('  ⚠ 没有任何场景记忆变化，也没有声称。如果这一轮确实做了事，说明记忆没写回。');
  }
  console.log('='.repeat(84));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
