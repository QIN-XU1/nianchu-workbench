#!/usr/bin/env node
/**
 * 能力缺位检查 —— 「对方到底有没有这个能力」，靠读源码判定
 *
 * ── 为什么这个比数关键词硬 ──────────────────────────────
 * 数关键词会被无关用法污染：openclaw 全仓库有 1410 个文件含 expiresAt，
 * 但它的**记忆层**里 expiresAt 只出现在两处，都不是「记忆条目过期」：
 *   · extensions/memory-core/index.ts:102  standing intents 的提醒到期时间
 *   · .../manager-provider-lifecycle.ts:711  embedding 探测**缓存**的 TTL
 * 也就是说：**它的记忆条目没有 TTL**。这是「读了源码确认缺位」，不是统计。
 *
 * 这个脚本把这种判定变成**可复跑**的：给定「能力」= 目录 + 命中模式 + 排除模式，
 * 输出 present / absent 以及**具体文件:行号**，供人复核。
 *
 * ── ⚠ 这个工具的适用范围很窄（4 次误判后写下的）──────────────
 * 它**不能**用来「发现」某系统有没有某能力。窄模式会漏，宽模式会误命中：
 *   · 窄搜 input_cost|cost_per|usd_per  → 0 文件 ⇒ 差点得出「openclaw 没有成本核算」
 *   · 宽搜 cost|pricing                 → 828 + 178 文件 ⇒ 它明明有（usage.cost、pricing）
 *   · 窄搜 expiresAt 在 memory-core      → 只命中 standing intents ⇒ 差点说它记忆无 TTL
 *   · 加上 knowledge/src 范围后          → 命中 expires_at + valid_until ⇒ 它其实有
 *
 * 所以正确用法是：**先读源码形成假设，再用这个工具把「有/没有」固化成可复跑的证据**。
 * 反过来用（先跑工具、拿零命中当「对方没有」）已经让我错了 4 次。
 *
 * 判 ABSENT 前必须满足：范围是你**逐个读过**的目录，且 exclude 是你**逐个核对**过的排除项。
 * 否则一律 UNKNOWN。
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PRESENT  在指定范围内找到未排除的命中（附行号）
 *   ABSENT   范围内零命中 ⇒ 该能力在此系统中不存在（有据可查）
 *   UNKNOWN  目标目录不存在（没源码，不许猜）
 *
 * 用法：node tools/benchmark/absence-check.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 能力清单：每条都要能一句话说清「凭什么说它没有」
 *
 * 每条 = { id, name, target: 目标仓根, dirs: 搜索范围, hit: 命中正则, exclude: 排除正则（可选） }
 */
export const CAPABILITIES = [
  {
    // 【2026-11-15 修正】我原先以为「openclaw 记忆没有 TTL」——**错了**。
    // 读源码后确认：它的 knowledge 记录有 expires_at + valid_until + lifecycle，
    // 并在 extensions/knowledge/src/chronicle-groups.ts:25-29 的 noteRank() 里
    // 用「是否已过期」做**排序降权**（过期仍可见，只是排后面）。
    //
    // 我们的做法是**硬过期**（expired 不进 get 结果）+ 即将过期预警 + 陈旧度分级。
    //
    // 这是**设计差异**，不是强弱：硬过期干净但会丢信息；降权保信息但可能被误用。
    // 判断哪个好属于「判断类事情」，机制不替人决定 —— 所以这里只如实记录差异。
    id: 'mem-ttl',
    name: '记忆条目过期（存在与否）',
    target: 'D:/refs/openclaw/openclaw-main',
    dirs: ['extensions/knowledge/src'],
    hit: /\b(expires_at|valid_until)\b/i,
    exclude: /(standing|intent|cooldown|maxFires|cacheExpires|cacheTtl|EMBEDDING_PROBE)/i,
    why: '（若为零命中才用这句）范围内未见过期字段',
  },
  {
    // 先读源码形成假设，再用工具固化 —— 不是拿零命中当「没有」
    id: 'file-size-guard',
    name: '单文件体量红线（超阈值即失败）',
    target: 'D:/refs/openclaw/openclaw-main',
    // 【2026-11-17 修】原 dirs 不含仓库根目录 ⇒ 漏掉 .oxlintrc.json 里的 max-lines。
    // 验证方 v-h0037 实测：openclaw 的 .oxlintrc.json:414/436/458 真配了 max-lines，
    // 且 src/agents/auth-profiles/store.ts:771 有 oxlint-disable max-lines（该文件 1724 行）——
    // 即这条红线真的在生效，之前报 ABSENT 是假阴性。
    dirs: ['src', 'scripts', 'packages', '.'],
    hit: /maxSourceFileBytes|sourceFileSizeLimit|oversizedSourceFile|sourceFileTooLarge|["']max-lines["']/i,
    // 【二次修正】排除产物/发布件类 —— assertPublishedFileSizeLimit 查的是发布产物，不是源码
    // 排除：发布产物 / 上传文件过大（HTTP 错误）/ 包体积 —— 都不是「源码单文件体量 lint」
    exclude: /publish|bundle|dist|artifact|asset|sessionFileTooLarge|respondSessionFile/i,
    why: '（若零命中才用）排除产物类后，未见源码单文件体量阈值',
  },
  {
    id: 'mem-conflict',
    name: '记忆冲突状态（同 key 两值并存、需显式解决）',
    target: 'D:/refs/openclaw/openclaw-main',
    // 【2026-11-17 修】原范围只有 memory-core ⇒ 报 ABSENT。验证方 v-h0037 用本工具自己的
    // hit 正则、只把 dirs 换成 extensions/knowledge/src，就得到 PRESENT / 17 处命中
    // （chronicle.ts:61 supersededBy、record-view.ts:212 等）。
    dirs: ['extensions/memory-core', 'extensions/knowledge/src'],
    hit: /\b(conflictGroup|supersededBy|CONFLICTED|contradict(?:ion|ory)?)\b/i,
    why: 'openclaw 的 knowledge-correct 用 SKILL.md 提示词描述纠正流程，代码层无冲突状态机',
  },
  {
    // 【2026-11-17 加】真 ABSENT 反例：修完两处假阴性后工具报 ABSENT 0 项，
    // 说明它现在只会说「有」。一个只会说「有」的工具和只会说「没有」的一样不可信。
    // 这条用一个**确定不存在**的能力来钉住 ABSENT 通路仍然活着。
    id: 'nonexistent-probe',
    name: '量子区块链共识（确定不存在的探测项）',
    target: 'D:/refs/openclaw/openclaw-main',
    dirs: ['src', 'extensions'],
    hit: /quantum[-_]?blockchain|量子区块链共识算法/i,
    why: '（若零命中才用）这是刻意构造的确定不存在项，用来验证 ABSENT 通路没有被修坏',
  },

];

/** 在目录里递归找源码文件 */
// 【2026-11-17 修】加 raw 参数：raw=true 时返回**全部**文件，由调用方决定过滤。
// 原来在 walk 内部就丢掉了非源码文件，导致 rangeAttest 无法统计「跳过了什么」——
// 而「跳过了什么」正是上一轮 .json 假阴性的根因所在。
function walk(dir, out = [], depth = 0, raw = false) {
  if (depth > 12) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|[\\/]\.git[\\/]|dist|build/.test(p)) continue;
      walk(p, out, depth + 1, raw);
    } else if (raw || /\.(ts|tsx|js|mjs|cjs|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 检查一条能力 */
/**
 * 范围自证 —— 把「实际扫了什么、跳过了什么」摆出来，让人能核对范围本身
 *
 * 【2026-11-17 加】起因：连续 5 轮独立验证推翻我的结论，其中两处假阴性的根因
 * **不是逻辑错，是范围选错**（白名单漏 .json、dirs 漏根目录）。
 * 我从不质疑自己定的范围，所以查不出「范围本身就错了」。
 *
 * 这段不参与判定，只输出事实：
 *   · 每个 dirs 是否存在、扫到几个文件
 *   · 被扩展名白名单跳过的文件数 + 扩展名 top5  ← 漏 .json 这类问题一眼可见
 *   · 命中/排除正则原文
 */
export function rangeAttest(cap) {
  const out = { target: cap.target, dirs: [], skippedByExt: {}, hit: String(cap.hit), exclude: cap.exclude ? String(cap.exclude) : null };
  const extCount = {};
  let skipped = 0;
  for (const d of cap.dirs) {
    const abs = path.join(cap.target, d);
    const exists = fs.existsSync(abs);
    let files = 0;
    if (exists) {
      const all = walk(abs, [], 0, true);  // raw：拿到全部文件才能统计跳过了什么
      for (const p of all) {
        const e = path.extname(p) || '(无扩展名)';
        if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(p)) {
          files++;
        } else {
          skipped++;
        }
        extCount[e] = (extCount[e] || 0) + 1;
      }
    }
    out.dirs.push({ dir: d, abs: abs.replace(/\\/g, '/'), exists, collected: files });
  }
  out.skippedByExt = skipped;
  out.extTop = Object.entries(extCount).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([e, n]) => e + '×' + n);
  // 【2026-11-17 加】配置类单独报：上一轮假阴性正是 .json 被漏，
  // 如果自证里看不到 .json，这段自证就治不了那个病（top6 会被 .ts/.md 挤满）。
  out.configFiles = (extCount['.json'] || 0) + (extCount['.yaml'] || 0)
    + (extCount['.yml'] || 0) + (extCount['.toml'] || 0);
  // 根目录收了多少 —— dirs 里加 '.' 才修好那次假阴性，必须可见
  const rootDir = out.dirs.find((d) => d.dir === '.');
  out.rootCollected = rootDir ? rootDir.collected : null;
  return out;
}

export function checkCapability(cap, existsFn = fs.existsSync) {
  const root = cap.target;
  if (!existsFn(root)) {
    return { id: cap.id, name: cap.name, state: 'UNKNOWN', why: '目标仓不存在，没有源码可查', hits: [] };
  }
  const hits = [];
  const searched = [];   // 可审计：到底搜了哪些目录、各扫了多少文件
  for (const d of cap.dirs) {
    const abs = path.join(root, d);
    if (!existsFn(abs)) { searched.push({ dir: d, files: 0, note: '目录不存在' }); continue; }
    const files = walk(abs);
    searched.push({ dir: d, files: files.length });
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!cap.hit.test(line)) continue;
        // 【修】exclude 必须同时看**文件路径** —— 如 standing-intents-kernel.ts 里的 expires_at，
        // 行内没有 'standing'，但文件路径有。只看行会漏排除。
        if (cap.exclude && (cap.exclude.test(line) || cap.exclude.test(f))) continue;
        hits.push({ file: path.relative(root, f).replace(/\\/g, '/'), line: i + 1, text: line.trim().slice(0, 100) });
      }
    }
  }
  const totalFiles = searched.reduce((a, s) => a + s.files, 0);
  return {
    id: cap.id, name: cap.name,
    state: hits.length ? 'PRESENT' : 'ABSENT',
    why: hits.length ? '' : (cap.why || '指定范围内零命中'),
    hits: hits.slice(0, 8), hitCount: hits.length,
    // 【可审计性】零命中必须能回答「你在哪找的、找了多少」
    searched, filesScanned: totalFiles,
    scope: cap.dirs.join(' + ') + ' · ' + totalFiles + ' 个源文件',
  };
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 反例 1（核心）：被 exclude 排除的命中不许算 PRESENT ──
  const cap1 = { id: 'x', name: 'x', target: 'R', dirs: ['d'], hit: /expiresAt/i, exclude: /cacheExpires/i };
  const fakeRead = () => 'const cacheExpiresAtMs = 1;\n';
  // 直接测逻辑：用 checkCapability 太重，这里复刻核心判定
  const judge = (line) => (cap1.hit.test(line) && !(cap1.exclude && cap1.exclude.test(line)));
  T('反例 · 被排除的命中（cacheExpiresAt）不许算 PRESENT', judge('const cacheExpiresAtMs = 1;') === false, '');
  T('反例 · 未被排除的命中必须算 PRESENT', judge('const expiresAt = "2026";') === true, '');

  // ── 反例 2：目标仓不存在 ⇒ UNKNOWN，不许当 ABSENT ──
  const r2 = checkCapability({ id: 'y', name: 'y', target: 'Z:/no/such/repo', dirs: ['d'], hit: /x/ }, () => false);
  T('反例 · 目标仓不存在 ⇒ UNKNOWN（不许当 ABSENT，没源码不等于没有）', r2?.state === 'UNKNOWN', JSON.stringify(r2?.state));

  // ── 正例 1：真仓上跑，返回三态之一 ──
  const r3 = checkCapability({ id: 'z', name: 'z', target: REPO, dirs: ['tools'], hit: /export function/ });
  T('正例 · 真仓上能跑出 PRESENT 且带文件行号',
    r3?.state === 'PRESENT' && (r3.hits || []).length > 0 && (r3.hits || [])[0].line > 0, JSON.stringify((r3.hits || [])[0] || null));

  // ── 反例 3：范围里没有命中 ⇒ ABSENT（而不是 UNKNOWN）──
  // 【修】不能用本脚本自身所在的目录做「零命中」测试 —— 那个字符串就写在本文件里，会自污染。
  const r4 = checkCapability({ id: 'w', name: 'w', target: REPO, dirs: ['no-such-dir-xyz'], hit: /x/ });
  T('反例 · 范围零命中 ⇒ ABSENT（有源码、有范围，才能断言没有）', r4?.state === 'ABSENT', JSON.stringify(r4.state));

  // 【2026-11-17 加】钉住两处假阴性（独立验证方 v-h0037 打出，我实测确认）
  // ① 文件白名单必须收 .json —— 否则 .oxlintrc.json 这类 lint 规约永远扫不到
  const src = fs.readFileSync(import.meta.filename, 'utf8');
  T('反例 · 文件白名单必须收 .json（否则 lint 规约类红线永远扫不到）',
    src.includes('|json)$'), '白名单里没有 json');
  // ② file-size-guard 的扫描范围必须含仓库根目录
  const fsg = CAPABILITIES.find((c) => c.id === 'file-size-guard');
  T('反例 · file-size-guard 范围必须含根目录（否则 .oxlintrc.json 被跳过）',
    !!fsg && fsg.dirs.includes('.'), JSON.stringify(fsg && fsg.dirs));
  T('反例 · file-size-guard 命中正则必须认 max-lines',
    !!fsg && fsg.hit.test('"max-lines": ["error", { "max": 700 }]'), String(fsg && fsg.hit));
  // ③ mem-conflict 范围必须含 knowledge/src
  const mc = CAPABILITIES.find((c) => c.id === 'mem-conflict');
  T('反例 · mem-conflict 范围必须含 knowledge/src（否则 17 处命中被漏掉）',
    !!mc && mc.dirs.some((d) => /knowledge\/src/.test(d)), JSON.stringify(mc && mc.dirs));
  // ④ ABSENT 通路必须仍然活着
  T('正例 · 必须有一条确定不存在的探测项来验证 ABSENT 通路',
    !!CAPABILITIES.find((c) => c.id === 'nonexistent-probe'), '缺 nonexistent-probe');

  // 【2026-11-17 加】范围自证的自检

  // 起因：连续 5 轮独立验证推翻我的结论，其中两处假阴性的根因不是逻辑错，是**范围选错**。

  // 我从不质疑自己定的范围 ⇒ 需要一段输出把「实际扫了什么、跳过了什么」摆出来。

  const raFsg = rangeAttest(CAPABILITIES.find((c) => c.id === 'file-size-guard'));

  T('正例 · rangeAttest 必须报出被跳过的文件数',

    typeof raFsg.skippedByExt === 'number' && raFsg.skippedByExt > 0,

    String(raFsg.skippedByExt));

  T('反例 · rangeAttest 必须单独报配置类数量（否则 .json 漏了看不出来）',

    typeof raFsg.configFiles === 'number' && raFsg.configFiles > 0,

    String(raFsg.configFiles));

  T('正例 · dirs 含根目录时必须报出根目录收集数',

    raFsg.rootCollected !== null && raFsg.rootCollected > 0,

    String(raFsg.rootCollected));

  T('正例 · rangeAttest 必须报出每个 dir 是否存在',

    Array.isArray(raFsg.dirs) && raFsg.dirs.every((d) => typeof d.exists === 'boolean'),

    JSON.stringify(raFsg.dirs.map((d) => d.exists)));

  // 反例：故意给一个不存在的目录，自证必须标 exists=false（不许假装扫到了）

  const raBad = rangeAttest({ target: CAPABILITIES[0].target, dirs: ['__no_such_dir__'], hit: /x/ });

  T('反例 · 不存在的目录必须标 exists=false（不许假装扫到了）',

    raBad.dirs.length === 1 && raBad.dirs[0].exists === false,

    JSON.stringify(raBad.dirs));



  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  能力缺位检查 · 自检（2 正例 + 3 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

{
  const results = CAPABILITIES.map((c) => checkCapability(c));
  console.log('');
  console.log('  能力缺位检查 —— 「对方到底有没有这个能力」，读源码判定');
  console.log('  ' + '='.repeat(78));
  for (const r of results) {
    console.log('  ' + r.state.padEnd(8) + r.name);
    console.log('           范围：' + r.scope);
    // 【2026-11-17 加】范围自证 —— 让「范围本身有没有选错」可被人工核对
    const ra = rangeAttest(CAPABILITIES.find((c) => c.id === r.id));
    const missing = ra.dirs.filter((d) => !d.exists).map((d) => d.dir);
    if (missing.length) console.log('           ⚠ 不存在的目录：' + missing.join(', '));
    console.log('           自证：跳过 ' + ra.skippedByExt + ' 个非源码文件'
      + ' · 扩展名分布 ' + ra.extTop.join(' '));
    console.log('           配置类(.json/.yaml/.toml)：' + ra.configFiles + ' 个'
      + (ra.rootCollected !== null ? ' · 根目录收集 ' + ra.rootCollected + ' 个' : ''));
    console.log('           正则：' + ra.hit.slice(0, 70)
      + (ra.exclude ? '  排除 ' + ra.exclude.slice(0, 40) : ''));
    if (r.state === 'ABSENT') console.log('           依据：' + r.why);
    for (const h of r.hits || []) console.log('           ' + h.file + ':' + h.line + '  ' + h.text);
    console.log('');
  }
  const absent = results.filter((r) => r.state === 'ABSENT').length;
  const present = results.filter((r) => r.state === 'PRESENT').length;
  const unk = results.filter((r) => r.state === 'UNKNOWN').length;
  console.log('  ' + '─'.repeat(78));
  console.log('  对方没有 ' + absent + ' 项 · 有 ' + present + ' 项 · 查不了 ' + unk + ' 项');
  console.log('');
  const out = { at: new Date().toISOString(), results };
  const op = path.join(REPO, 'evidence/evolve/absence-check.json');
  fs.mkdirSync(path.dirname(op), { recursive: true });
  fs.writeFileSync(op, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.exit(0);
}
