#!/usr/bin/env node
/**
 * 场景清单一致性 —— 第 106 个检查（2026-11-14 新增）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么需要这个检查
 * ══════════════════════════════════════════════════════════════════════
 *  「系统里有哪些场景」这个事实，被硬编码在 **16 个文件、42 处**里。
 *
 *  新增 3 个工坊场景后，我逐个撞上这些过时的清单，每一次表现都不同：
 *
 *    ① 管线产物体检 / 管线调度   SCENE_NAME = {...}
 *       → 表现：「产物在但未消费」（看起来像引用格式问题）
 *    ② 路由表                    SCENE_IDS = [...]
 *       → 表现：「自测 20/21」（看起来像自测写错了）
 *    ③ 进度判定                  ids/names 各写死
 *       → 表现：新场景被当成未知场景
 *
 *  ⇒ 三次我都花了半轮去查「为什么这个检查坏了」，
 *    而真正原因都是**同一件事**：某处清单没更新。
 *
 *  ──────────────────────────────────────────────────────────────────────
 *  这个检查做什么
 *  ──────────────────────────────────────────────────────────────────────
 *  1. 从 `外壳/scenarios/*.json` 读权威场景清单（12 个）
 *  2. 扫所有工具文件里的硬编码清单
 *  3. 对每一处硬编码，判断它是否**包含了全部权威场景**
 *     缺任何一个 → 报「这处清单已过期，缺 X」
 *
 *  判据：**硬编码本身不算错**（有些地方只需列 2 个专门的场景），
 *        错的是「看起来是全集但实际上缺了几个」。
 *
 *  所以只报「声称是全集的清单」：
 *    · 数组里出现 ≥5 个场景名 → 视为全集清单
 *    · 映射表里有 ≥5 个 id → 视为全集清单
 *
 *  这样 `['research','competitor-analyze']`（故意的两场景对比）不会误报。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = HERE;
const SCEN = path.join(WB, '外壳', 'scenarios');

/** 视为「全集清单」的阈值：出现这么多个场景名/id 就算 */
const FULLSET_THRESHOLD = 5;

function loadTruth() {
  const names = [];
  const ids = [];
  try {
    for (const f of fs.readdirSync(SCEN)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
        if (j && j.id && j.name) { ids.push(String(j.id)); names.push(String(j.name)); }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { names, ids };
}

/**
 * 扫描硬编码清单并判断完整性
 * @returns {Array<{file:string, line:number, kind:string, found:number, missing:string[]}>}
 */
export function scan(opts) {
  const truth = loadTruth();
  const allowlist = (opts && opts.allowlist) || new Set();
  const problems = [];

  let files = [];
  try { files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')); } catch { return []; }

  for (const file of files) {
    if (allowlist.has(file)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(TOOLS, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const t = l.trim();
      // 跳过注释
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;

      // 这一行里出现了多少个权威场景名 / id
      const hitNames = truth.names.filter((n) => l.includes("'" + n + "'") || l.includes('"' + n + '"'));
      const hitIds = truth.ids.filter((x) => l.includes("'" + x + "'") || l.includes('"' + x + '"'));

      // 只有「像全集」的才判
      const isFullsetNames = hitNames.length >= FULLSET_THRESHOLD;
      const isFullsetIds = hitIds.length >= FULLSET_THRESHOLD;
      if (!isFullsetNames && !isFullsetIds) continue;

      // 缺哪些？注意：清单可能分多行写，所以要看「整个连续块」
      // 取当前行 + 前后各 6 行作为块
      const block = lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 7)).join('\n');
      const blockNames = truth.names.filter((n) => block.includes("'" + n + "'") || block.includes('"' + n + '"'));
      const blockIds = truth.ids.filter((x) => block.includes("'" + x + "'") || block.includes('"' + x + '"'));

      if (isFullsetNames && blockNames.length < truth.names.length) {
        const missing = truth.names.filter((n) => !block.includes("'" + n + "'") && !block.includes('"' + n + '"'));
        problems.push({ file, line: i + 1, kind: 'names', found: blockNames.length, missing });
      } else if (isFullsetIds && blockIds.length < truth.ids.length) {
        const missing = truth.ids.filter((x) => !block.includes("'" + x + "'") && !block.includes('"' + x + '"'));
        problems.push({ file, line: i + 1, kind: 'ids', found: blockIds.length, missing });
      }
    }
  }
  return problems;
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  const truth = loadTruth();
  const problems = scan();

  console.log('='.repeat(76));
  console.log('  场景清单一致性');
  console.log('='.repeat(76));
  console.log();
  console.log('  权威来源: 外壳/scenarios/*.json');
  console.log('  场景数:   ' + truth.ids.length + ' 个');
  console.log('  判据:     出现 ≥' + FULLSET_THRESHOLD + ' 个场景名/id 的地方视为「全集清单」，');
  console.log('            缺任何一个就报（< ' + FULLSET_THRESHOLD + ' 个的故意小清单不报）');
  console.log();

  if (!problems.length) {
    console.log('  ✓ 所有「全集清单」都与权威来源一致');
    console.log();
    return 0;
  }

  console.log('  ✗ ' + problems.length + ' 处清单已过期：');
  console.log();
  for (const p of problems) {
    console.log('    · ' + p.file + ' L' + p.line + '  (' + p.kind + ', 有 ' + p.found + '/' + truth.ids.length + ')');
    console.log('      缺: ' + p.missing.join(', '));
  }
  console.log();
  console.log('  ⚠ 这些地方的后果是「报错完全不指向真正原因」：');
  console.log('    典型症状：产物在但未消费 / 自测少 1 条 / 新场景被当未知场景');
  console.log();
  console.log('  修法：改从 `工具/_场景清单.mjs` 读（sceneIds() / sceneNames() / sceneNameMap()）');
  console.log();
  return 1;
}

function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(76));
  console.log('  场景清单一致性 · 自测');
  console.log('='.repeat(76));
  console.log();

  const truth = loadTruth();
  chk('能读到权威清单', truth.ids.length > 0, truth.ids.length + ' 个');
  chk('新场景在权威清单里', truth.ids.includes('backend-craft'), '');

  // 关键：scan() 能跑
  let probs = null;
  chk('scan() 不抛异常', (() => { try { probs = scan(); return true; } catch { return false; } })());

  // 反例：不完整的清单必须被判出来
  {
    // ⚠ 第一版这里漏报了，原因是：我造了 6 个 id 的清单，
    //   但 FULLSET_THRESHOLD = 5，6 >= 5 应该被判为「全集清单」；
    //   判据逻辑却要求 block 里 hitIds >= 阈值才进入检查 ——
    //   6 个确实进去了，但**缺的 6 个里恰好包含**…
    //   实际是我误把「取前 6 个」当成了「缺 6 个」，措辞错了。
    //   修正：明确造一个「只列一半」的清单，断言它被判出缺失。
    const tmpFile = 'tmp-test-incomplete.mjs';
    const tmpPath = path.join(TOOLS, tmpFile);
    const half = Math.max(FULLSET_THRESHOLD, Math.floor(truth.ids.length / 2));
    const partial = truth.ids.slice(0, half).map((x) => "'" + x + "'").join(', ');
    fs.writeFileSync(tmpPath, 'const list = [' + partial + '];\n', 'utf8');
    let found = [];
    try { found = scan(); } catch { /* ignore */ }
    const hit = found.some((p) => p.file === tmpFile);
    const missingCount = found.find((p) => p.file === tmpFile)?.missing.length || 0;
    chk('反例：只列 ' + half + ' 个的清单被判过期', hit === true,
      hit ? ('缺 ' + missingCount + ' 个') : '漏报');
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  // 反例：小清单（<5）不该误报
  {
    const tmpFile = 'tmp-test-small.mjs';
    const tmpPath = path.join(TOOLS, tmpFile);
    fs.writeFileSync(tmpPath, "const pair = ['research', 'competitor-analyze'];\n", 'utf8');
    let found = [];
    try { found = scan(); } catch { /* ignore */ }
    const hit = found.some((p) => p.file === tmpFile);
    chk('反例：2 个的小清单不误报', hit === false, hit ? '误报了' : '正确放过');
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  // 完整清单不该报
  {
    const tmpFile = 'tmp-test-full.mjs';
    const tmpPath = path.join(TOOLS, tmpFile);
    const all = truth.ids.map((x) => "'" + x + "'").join(', ');
    fs.writeFileSync(tmpPath, 'const all = [' + all + '];\n', 'utf8');
    let found = [];
    try { found = scan(); } catch { /* ignore */ }
    const hit = found.some((p) => p.file === tmpFile);
    chk('完整清单不误报', hit === false, hit ? '误报了' : '正确放过');
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  console.log();
  const n = R.filter(Boolean).length;
  console.log('─'.repeat(76));
  console.log('  自测结果: ' + n + ' / ' + R.length);
  console.log('─'.repeat(76));
  return n === R.length;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  process.exit(main());
}
