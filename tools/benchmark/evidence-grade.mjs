#!/usr/bin/env node
/**
 * 矩阵证据分级 —— 把「我们不知道别人强不强」变成「可量化的不知道」
 *
 * ── 为什么需要它（这是 T5 诚实化的关键一步）──────────────────
 * 31 维矩阵里：
 *   · **我们这一列**的证据是**本地路径**，audit-matrix-honesty 能机械核验（0 假绿）
 *   · **其它各列**的证据是**文字描述**（有的带 URL）
 *
 * 于是「我们的覆盖率高于全部参照系统」这个结论里，
 * 一半是**核验过的**（我们），一半是**估计的**（他们）。
 * 两边证据强度根本不对等 —— 这不是「我们更强」，是「只有我们被验过」。
 *
 * 这个脚本不做判断，只**分类**：把每个参照系统每一格的证据归到
 *   path  本地路径（可核验：文件存在？）
 *   url   http(s) 链接（可核验：能访问？）
 *   prose 纯文字（**不可核验** —— 只能信记录者）
 *
 * 输出的意义：如果 90% 的竞品格是 prose，那 T5 的「领先」就不该被当成事实。
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS(0)     竞品格里可核验（path/url）占比 ≥ 50%
 *   WARN(3)     可核验占比 < 50%（大部分只能信记录者）
 *   UNKNOWN(2)  矩阵读不出来
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as relevanceMod from './relevance.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');

const URL_RE = /https?:\/\/[^\s）)]+/i;
// 本地路径：含 / 或 \ 且看起来像文件（有扩展名或已知目录前缀）
// 【2026-11-15 修】前导字符集合必须包含反引号与常见标点 ——
// 我们的证据写的是「① 搜索 `tools/net/search.mjs`」，路径前是反引号。
// 第一版漏了反引号 ⇒ 28/31 维被误判成「纯文字，无法核验」，
// 差一点报出一个假灾难（「我们自己的矩阵证据全是 prose」）。
const PATH_RE = /(?:^|[\s（(：:，,、`\"'「『【\[])((?:[\w.@\-\u4e00-\u9fff]+\/)+[\w.@\-\u4e00-\u9fff]+\.(?:tsx|jsx|mjs|cjs|mts|cts|json|scss|toml|yaml|ps1|ts|js|rs|py|css|md|yml|sh|txt|sql|proto)|(?:[\w.@\-\u4e00-\u9fff]+\\)+[\w.@\-\u4e00-\u9fff]+\.(?:tsx|jsx|mjs|cjs|mts|cts|json|scss|toml|yaml|ps1|ts|js|rs|py|css|md|yml|sh|txt|sql|proto))/g;

/**
 * 给一格证据分级
 * @param ev 证据字符串
 * @param existsFn 路径存在性（自检可注入）
 */
export function gradeEvidence(ev, existsFn) {
  const s = String(ev == null ? '' : ev).trim();
  if (!s) return { kind: 'empty', detail: '没有证据' };

  // 【2026-11-15 加】先判「借力声明」—— 证据里明说靠宿主/未自研/已移除，
  // 那里面出现的路径**不是我们的实现**，不能算可核验证据。
  // 反例：A15 写「【借力·未自研 + 主动移除】…移除的是 `tools/guard/gate.mjs`」，
  // 第一版把这个路径当成我们的实现，判 verified:false 却仍归为 path，造成错误归因。
  // 【2026-11-16 修·根因】原实现用整段文本匹配 BORROWED，导致**自研格被误判**：
  // D3 原文「【自研·可运行】…对比：hermes insights 显示的是它自己的会话统计（借力）…」
  // 只因对比句里出现"借力"两字，整格被判 borrowed ⇒ D2/D3/B4 等自研维度被系统性低估。
  // 新规则：**开头标记优先**（【自研 / 【借力 / 【未自研），无标记才退回全文正则。
  const head = s.slice(0, 12);
  // 【2026-11-17 修·「部分自研」被整格吞掉】A4 标的是「【部分自研 + 部分借力】」，
  // 旧 SELFBUILT 只认「【自研」⇒ isSelfBuilt=false，再被 BORROWED 的「借力」命中
  // ⇒ 整格判 borrowed，把它自研的那一半也吞了。能力等级已由 state=部分 表达，
  // 不该在这里再抹掉「我们有真实实现」这一事实。
  const SELFBUILT = /【\s*(部分)?自研/;
  const BORROWED_HEAD = /【\s*(借力|未自研)/;
  if (BORROWED_HEAD.test(head)) return { kind: 'borrowed', detail: '借力/未自研声明（不算我们的实现）' };
  const isSelfBuilt = SELFBUILT.test(head);

  const BORROWED = /借力|未自研|靠宿主|主动移除|上游|依赖\s*hermes|经\s*hermes/i;
  if (!isSelfBuilt && BORROWED.test(s)) return { kind: 'borrowed', detail: '借力/未自研声明（不算我们的实现）' };

  URL_RE.lastIndex = 0;
  const url = URL_RE.exec(s);
  URL_RE.lastIndex = 0;
  if (url) return { kind: 'url', detail: url[0] };

  // PATH_RE 带 /g，exec 会带着上次的 lastIndex 继续找 —— 必须每次重置，
  // 否则前面的证据匹配过后，后面的证据会从错误位置开始搜索而漏掉。
  PATH_RE.lastIndex = 0;
  const p = PATH_RE.exec(s);
  PATH_RE.lastIndex = 0;
  if (p) {
    const rel = p[1].replace(/\\/g, '/');
    const ok = existsFn ? existsFn(rel) : false;
    return { kind: 'path', detail: rel, resolved: ok };
  }
  return { kind: 'prose', detail: '纯文字，无法核验' };
}

/** 汇总全矩阵 */
const REFS_ROOT_R = process.env.REFS_ROOT || 'D:/refs';
/** 把台账里的相对路径解析成磁盘绝对路径（仓库根 / hermes / D:/refs/<sub>） */
function resolveAbsPath(rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^[./]+/, '');
  const cands = [path.join(REPO, r), path.join(REPO, 'hermes', r), path.join(REFS_ROOT_R, r)];
  try {
    if (fs.existsSync(REFS_ROOT_R)) {
      for (const sub of fs.readdirSync(REFS_ROOT_R)) cands.push(path.join(REFS_ROOT_R, sub, r));
    }
  } catch { /* ignore */ }
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

/** 从 asar 内读取文件文本（供语义校验）；读不到返回 null */
function readAsarText(rel) {
  try {
    const asarMod = createRequire(import.meta.url)('D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳/node_modules/@electron/asar');
    const asarPath = process.env.DSH_ASAR || 'D:/file/software/DeepSeek Harness/resources/app.asar';
    if (!fs.existsSync(asarPath)) return null;
    const norm = String(rel || '').split('\\').join('/').replace(/^\/+/, '');
    const rawList = asarMod.listPackage(asarPath);
    // extractFile 必须传**原始条目名**（asar 内是反斜杠且带前导反斜杠），
    // 传 normalize 后的会报 "was not found in this archive"。
    const hitRaw = rawList.find((s) => {
      const n = s.split('\\').join('/').replace(/^\/+/, '');
      return n === norm || n.endsWith('/' + norm);
    });
    if (!hitRaw) return null;
    // extractFile 要**不带前导反斜杠**的路径（listPackage 给的是 \dsh\...）
    return asarMod.extractFile(asarPath, hitRaw.replace(/^[\\/]+/, '')).toString('utf8');
  } catch { return null; }
}

export function gradeMatrix(matrix, existsFn) {
  const dims = [];
  for (const g of matrix.dimensions || []) for (const it of g.items || []) dims.push(it);
  // 【2026-11-17 修·口径过时】原来写死 12 个参照，其中 6 个(codex/cursor/trae/
  // workbuddy/codebuddy/qoder)矩阵里已不存在，而实际存在的 7 个(ecc/luanyujia/
  // omp-studio/pi-main/open-design/aionui/WeKnora)完全没被统计 —— 等于只拿 12 个
  // 参照做对比却说覆盖全部。改为**从矩阵动态推导**，矩阵是唯一数据源。
  const RESERVED = new Set(['id', 'name', 'us', 'refNote']);
  const subjectSet = new Set();
  for (const g of matrix.dimensions || []) {
    for (const it of g.items || []) {
      for (const k of Object.keys(it)) if (!RESERVED.has(k)) subjectSet.add(k);
    }
  }
  const subjects = [...subjectSet].sort();

  const stats = [];
  for (const sub of subjects) {
    let have = 0, prov = 0, pathN = 0, urlN = 0, proseN = 0;
    for (const d of dims) {
      const cell = d[sub];
      if (!Array.isArray(cell) || cell[0] !== '有') continue;
      have++;
      const g = gradeEvidence(cell[1], existsFn);
      // 【2026-11-15 修】路径类只有在**文件真的存在**时才算可核验 ——
      // 指向一个不存在的文件，那不是证据，是看起来像证据的文字。
      const pathOk = g.kind === 'path' && g.resolved === true;
      if (pathOk || g.kind === 'url') prov++;
      if (g.kind === 'path') { if (g.resolved) pathN++; else proseN++; }   // 不存在 ⇒ 计入不可核验
      else if (g.kind === 'url') urlN++;
      else proseN++;
    }
    if (have) stats.push({ subject: sub, have, provable: prov, path: pathN, url: urlN, prose: proseN });
  }
  const totHave = stats.reduce((a, s) => a + s.have, 0);
  const totProv = stats.reduce((a, s) => a + s.provable, 0);
  // 逐维展开：每一维 × 每一方 ⇒ 状态 + 证据类型。这才是「让人自己判断」的材料。
  // 之前只出总数（88 格/15.9%），读者无法知道**具体哪一维**站得住。
  const rows = [];
  for (const d of dims) {
    const row = { id: d.id, name: d.name, cells: {} };
    for (const sub of ['us', ...subjects]) {
      const cell = d[sub];
      if (!Array.isArray(cell)) continue;
      const st = cell[0];
      if (st === '无') { row.cells[sub] = { state: '无', kind: 'none' }; continue; }
      const g = gradeEvidence(cell[1], existsFn);
      // 【2026-11-17 加】语义相关性校验（修 H-0140 驳回理由③）：
      // 原来「文件存在」就算可核验，实测含 A1 指向记忆类型文件、A3 指向模型供应商测试、
      // 6 个锚在 knip lint 配置等语义错配。现在对**参照方**的 path 格额外读内容做关键词命中，
      // 不相关 ⇒ 降级为 irrelevant（不计入可核验）。我们自己的格保持原判（有验收器背书）。
      let relevance = null;
      if (sub !== 'us' && g.kind === 'path' && g.resolved === true && process.env.SKIP_RELEVANCE !== '1') {
        try {
          const abs = typeof resolveAbsPath === 'function' ? resolveAbsPath(g.detail) : null;
          if (abs) {
            relevance = relevanceMod.checkRelevance({ dimName: d.name, file: abs });
          } else {
            // 【2026-11-17 加】dsh 的证据在 asar 内，磁盘无绝对路径；
            // 之前只判「在 asar 清单里」⇒ 残留 n/a 的假可核验。这里读 asar 文本再判相关性。
            const txt = typeof readAsarText === 'function' ? readAsarText(g.detail) : null;
            // 把 detail 作为 file 传入，让路径 token（如 dsh-bash-sandbox）参与命中，避免假红
            if (txt) relevance = relevanceMod.checkRelevance({ dimName: d.name, text: txt, file: g.detail });
          }
        } catch { relevance = null; }
      }
      const relevanceDowngrade = !!(relevance && relevance.relevant === false);
      row.cells[sub] = {
        state: relevanceDowngrade ? '部分' : st,
        kind: relevanceDowngrade ? 'irrelevant' : g.kind,
        // 我们的格：path 且 resolved ⇒ verified；别人的格：path 且语义相关才 verified
        verified: relevanceDowngrade ? false : ((g.kind === 'path' && g.resolved === true) || g.kind === 'url'),
        detail: relevanceDowngrade ? ('语义不相关：' + g.detail) : g.detail,
        ...(relevance ? { relevanceHits: relevance.hits } : {}),
      };
    }
    rows.push(row);
  }
  return { stats, totHave, totProv, provRate: totHave ? totProv / totHave : 0, rows };
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const existsYes = () => true;
  const existsNo = () => false;

  // ── 反例 1（核心）：纯文字不许被当成可核验 ──
  // ── 正例：验收器必须**能正确分类**，不只是「不误判」──────────────
  // 为什么需要它：7 条断言全标着「反例」，测的其实是分类正确性。
  // 如果 gradeEvidence 永远返回 prose，所有「不许当 X」的反例都会通过 ——
  // 必须显式断言它在正常输入下**确实**给出 path / url 这两个结论。
  const pOk = gradeEvidence('实现见 `tools/memory/store.mjs`', existsYes);
  T('正例 · 真实存在的文件路径 ⇒ 判 path 且 resolved=true',
    pOk?.kind === 'path' && pOk?.resolved === true && /store\.mjs$/.test(pOk?.detail),
    JSON.stringify(pOk));

  const pCjk = gradeEvidence('注入逻辑 `workbench/工具/记忆注入.mjs` 按场景决定', existsYes);
  T('正例 · 含中文目录的路径 ⇒ 也要判 path（不许因为 CJK 就当 prose）',
    pCjk?.kind === 'path' && pCjk?.resolved === true, JSON.stringify(pCjk));

  const uOk = gradeEvidence('官方文档 https://docs.anthropic.com/en/docs/tool-use 说明', existsYes);
  T('正例 · 含 URL ⇒ 判 url 且 detail 里带域名',
    uOk?.kind === 'url' && /anthropic/.test(uOk?.detail), JSON.stringify(uOk));

  const eOk = gradeEvidence('', existsYes);
  T('反例 · 空证据 ⇒ 判 empty（不许当 path 或 url）', eOk?.kind === 'empty', JSON.stringify(eOk));


  const g1 = gradeEvidence('Codex exec 统一代码执行工具，rollout 817 次 apply_patch', existsYes);
  T('反例 · 纯文字必须判 prose（不许当可核验）', g1?.kind === 'prose', JSON.stringify(g1));

  // ── 反例 2：URL 必须判 url ──
  const g2 = gradeEvidence('Edit/Write 工具（官方文档：https://docs.anthropic.com/en/docs/build-with-claude/tool-use）', existsYes);
  T('反例 · 含 URL 必须判 url', g2?.kind === 'url' && /anthropic/.test(g2?.detail), JSON.stringify(g2));

  // ── 反例 3：本地路径必须判 path，且**真的去查存在性** ──
  const g3 = gradeEvidence('源码定位：prototype/hermes-agents/make-patches.mjs 第 3 行', existsNo);
  T('反例 · 本地路径必须判 path 且如实报 resolved=false（不许假装存在）',
    g3?.kind === 'path' && g3?.resolved === false, JSON.stringify(g3));

  // ── 反例 6（2026-11-16 新增）：PATH_RE 带 /g，连续调用必须每次都匹配到 ──
  // 真实事故：不重置 lastIndex 时，前面的证据匹配过后，后面的证据会从错误
  // 位置开始搜索而漏掉 —— 导致「有真实路径的维度」被误判成纯文字。
  // 表现：可核验实现数从 22 掉到 18，且掉的都是路径本来正确的维度。
  const g6a = gradeEvidence('见 `tools/memory/store.mjs` 实现', existsYes);
  const g6b = gradeEvidence('见 `prototype/hermes-agents/verify-goal.mjs` 实现', existsYes);
  T('反例 · 连续两次调用都要匹配到路径（lastIndex 状态不许残留）',
    g6a?.kind === 'path' && g6b?.kind === 'path', JSON.stringify([g6a, g6b]));

  // ── 反例 7：.tsx 不许被截断成 .ts ──
  const g7 = gradeEvidence('见 `apps/x/ModelRouterSettings.tsx`（378 行）', existsYes);
  T('反例 · .tsx 必须完整匹配（不许被 ts 抢先截断）',
    g7?.kind === 'path' && /\.tsx$/.test(g7?.detail), JSON.stringify(g7));

  // ── 反例 5（本轮新增）：借力声明里出现的路径，不许当成我们的实现 ──
  const g5 = gradeEvidence('【借力·未自研 + 主动移除】靠宿主 hermes；移除的是 `tools/guard/gate.mjs`', existsYes);
  T('反例 · 借力声明里的路径必须判 borrowed（不许当我们的可核验实现）',
    g5?.kind === 'borrowed', JSON.stringify(g5));

  // ── 反例 6（本轮新增）：自研标记 + 文中出现"借力"字样，仍须判 path（不许误伤自研） ──
  const g6 = gradeEvidence('【自研·可运行】状态采集：`tools/state/collect.mjs`；对比：hermes 的 insights 是借力', existsYes);
  T('反例 · 【自研】标记优先于文中"借力"字样（自研格不许被误判 borrowed）',
    g6?.kind === 'path' && g6?.resolved === true, JSON.stringify(g6));

  // ── 正例 7（本轮新增）：无标记 + 含"上游"，仍须判 borrowed（不放过真借力） ──
  const g7b = gradeEvidence('这个能力来自上游 `tools/x.mjs`，我们没有自研', existsYes);
  T('反例 · 无自研标记且含"上游"⇒ 仍判 borrowed（不放过真借力）',
    g7b?.kind === 'borrowed', JSON.stringify(g7b));

  // ── 反例 8（2026-11-17 新增）：【部分自研 + 部分借力】不许被整格吞成 borrowed ──
  // 背景：A4 标「【部分自研 + 部分借力】」，旧 SELFBUILT 只认「【自研」，
  // 于是 isSelfBuilt=false，再被 BORROWED 的「借力」命中 ⇒ 整格 borrowed，
  // 把它自研的那一半也吞了（both 被低估）。
  const g8 = gradeEvidence('【部分自研 + 部分借力】像素比对 `tools/vision/diff.mjs`；理解仍靠 hermes', existsYes);
  T('反例 · 【部分自研】不许被整格判 borrowed（自研那半要算数）',
    g8?.kind === 'path' && g8?.resolved === true, JSON.stringify(g8));

  // 但纯借力声明仍必须判 borrowed（不因上面放宽而放过真借力）
  const g9 = gradeEvidence('【借力·未自研】能力来自 hermes `tools/x.mjs`', existsYes);
  T('反例 · 纯【借力】仍判 borrowed（放宽不许放过真借力）',
    g9?.kind === 'borrowed', JSON.stringify(g9));

  // ── 正例 9（2026-11-17 新增）：.mts / .txt 必须能被识别 ──
  // 背景：PATH_RE 的扩展名清单原来缺 .mts/.txt，导致用 .mts 写的源码
  // （openclaw check-max-lines-ratchet.mts）和 .txt 基线文件对度量**完全不可见**，
  // 把 B4「单文件体量控制」系统性低估成"只有我们能核验"。
  const g10 = gradeEvidence('棘轮 `scripts/check-max-lines-ratchet.mts`', existsYes);
  T('正例 · .mts 必须判 path（不许因扩展名缺失当 prose）',
    g10?.kind === 'path' && g10?.resolved === true, JSON.stringify(g10));

  const g11 = gradeEvidence('基线 `config/max-lines-baseline.txt`', existsYes);
  T('正例 · .txt 必须判 path（基线文件也是可核验证据）',
    g11?.kind === 'path' && g11?.resolved === true, JSON.stringify(g11));

  // 但不存在的 .mts 仍须如实报 resolved=false（放宽不许变成假装存在）
  const g12 = gradeEvidence('棘轮 `scripts/not-real.mts`', existsNo);
  T('反例 · 不存在的 .mts 仍须如实报 resolved=false',
    g12?.kind === 'path' && g12?.resolved === false, JSON.stringify(g12));

  // ── 反例 4：空证据不许算可核验 ──
  const g4 = gradeEvidence('', existsYes);
  T('反例 · 空证据判 empty（不算可核验）', g4?.kind === 'empty', JSON.stringify(g4));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  矩阵证据分级 · 自检（4 反例）');
    console.log('  ' + '─'.repeat(70));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  if (!fs.existsSync(MATRIX)) { console.log('  ❔ 矩阵读不出来'); process.exit(2); }
  const m = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
  // 【2026-11-16 修·根因】参照方的代码证据在 D:/refs/<repo>/ 下，原解析只按仓库根
  // ⇒ 44 个参照 path 格全部 resolved=false、verified=false，导致 T5「领先」把对手的
  // 真实代码实现漏算（openclaw 的 16 格实测存在）。这里加 D:/refs 兜底，仅"多解析成功"，
  // 不改任何既有判定；自检用注入 existsFn，不受影响。
  const REFS_ROOT = process.env.REFS_ROOT || 'D:/refs';
  // 【2026-11-17 加】dsh 参照的包在 Electron asar 里（非散文件）。实测 app.asar 内
  // 有 `\dsh\node_modules\@deepseek-ai\dsh-tools\...` 等 41 条真实条目。
  // 这里按 asar 清单核对：路径存在 = 该格可核验（证据仍指向真实发布的代码）。
  const DSH_ASAR = process.env.DSH_ASAR || 'D:/file/software/DeepSeek Harness/resources/app.asar';
  let asarIndex = null;
  const loadAsarIndex = () => {
    if (asarIndex !== null) return asarIndex;
    try {
      const asarMod = createRequire(import.meta.url)('D:/file/AI Temp/DeepSeek/Agent自研/workbench/外壳/node_modules/@electron/asar');
      if (!asarMod || !fs.existsSync(DSH_ASAR)) { asarIndex = []; return asarIndex; }
      asarIndex = asarMod.listPackage(DSH_ASAR).map((s) => s.replace(/\\/g, '/').replace(/^\//, ''));
    } catch { asarIndex = []; }
    return asarIndex;
  };
  const inAsar = (rel) => {
    const norm = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
    // asar 内路径形如 dsh/node_modules/... ；台账里常写作 dsh/node_modules/... 或 node_modules/...
    const idx = loadAsarIndex();
    if (!idx.length) return false;
    return idx.some((p) => p === norm || p.endsWith('/' + norm) || norm.endsWith('/' + p));
  };

  const resolveExists = (rel) => {
    try { if (fs.existsSync(path.join(REPO, rel))) return true; } catch { /* ignore */ }
    // 【2026-11-16 加】hermes 参照仓在仓库根的 hermes/ 下（acp_adapter/... 15 格实测存在）
    try { if (fs.existsSync(path.join(REPO, 'hermes', rel))) return true; } catch { /* ignore */ }
    try { if (inAsar(rel)) return true; } catch { /* ignore */ }
    try {
      if (fs.existsSync(path.join(REFS_ROOT, rel))) return true;
      if (fs.existsSync(REFS_ROOT)) {
        for (const sub of fs.readdirSync(REFS_ROOT)) {
          try { if (fs.existsSync(path.join(REFS_ROOT, sub, rel))) return true; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return false;
  };
  const r = gradeMatrix(m, resolveExists);

  console.log('');
  console.log('  矩阵证据分级 —— 竞品各列的证据有多硬');
  console.log('  ' + '='.repeat(76));
  console.log('  主体        有' + '  可核验' + '  路径' + '  URL' + '  纯文字');
  for (const s of r.stats) {
    console.log('  ' + s.subject.padEnd(10) + String(s.have).padStart(4)
      + String(s.provable).padStart(6) + String(s.path).padStart(6) + String(s.url).padStart(6) + String(s.prose).padStart(7));
  }
  console.log('  ' + '─'.repeat(76));
  console.log('  合计：有 ' + r.totHave + ' 格 · 可核验 ' + r.totProv + ' 格 · 可核验率 ' + (r.provRate * 100).toFixed(1) + '%');
  console.log('');
  const state = r.provRate >= 0.5 ? 'PASS' : 'WARN';
  console.log('  四态: ' + state + ' —— ' + (state === 'PASS'
    ? '过半竞品格可核验'
    : ('**' + ((1 - r.provRate) * 100).toFixed(1) + '% 的竞品格只能信记录者**。T5 的「领先」有一半建立在不可核验的文字上。')));
  console.log('');
  // ── 逐维判定书 ──
  // 每维一行：我们什么状态 · 有几家参照系统声称「有」· 其中几家证据可核验。
  // 不给出「谁更强」的结论 —— 那是判断类事情，交给人。
  console.log('');
  console.log('  逐维判定书（谁更强由读的人判断，工具只给材料）');
  console.log('  ' + '='.repeat(78));
  console.log('  维度                                 我们   对方有  可核验  证据强度');
  for (const row of (r.rows || [])) {
    const others = Object.entries(row.cells).filter(([k, v]) => k !== 'us' && v.state === '有');
    const verified = others.filter(([, v]) => v.verified).length;
    const ours = row.cells.us ? row.cells.us.state : '—';
    const strength = others.length === 0 ? '对方无'
      : verified === 0 ? '**全不可核验**'
        : verified === others.length ? '全部可核验' : (verified + '/' + others.length + ' 可核验');
    console.log('  ' + (row.id + ' ' + row.name).slice(0, 34).padEnd(36)
      + String(ours).padEnd(6) + String(others.length).padStart(5)
      + String(verified).padStart(7) + '  ' + strength);
  }
  console.log('  ' + '─'.repeat(78));
  const dimsWithOthers = (r.rows || []).filter((row) => Object.entries(row.cells).some(([k, v]) => k !== 'us' && v.state === '有')).length;
  const dimsFullyUnverifiable = (r.rows || []).filter((row) => {
    const o = Object.entries(row.cells).filter(([k, v]) => k !== 'us' && v.state === '有');
    return o.length > 0 && o.every(([, v]) => !v.verified);
  }).length;
  console.log('  ' + (r.rows || []).length + ' 维 · 有参照对比的 ' + dimsWithOthers + ' 维 · 其中「对方全不可核验」的 ' + dimsFullyUnverifiable + ' 维');
  console.log('');

  const out = { at: new Date().toISOString(), state, ...r };
  const op = path.join(REPO, 'evidence/evolve/evidence-grade.json');
  fs.mkdirSync(path.dirname(op), { recursive: true });
  fs.writeFileSync(op, JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.exit(state === 'PASS' ? 0 : 3);
}
