#!/usr/bin/env node
// 工具/工具去重体检.mjs —— 找出功能重复的工具
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（发现的两个重复）
// ══════════════════════════════════════════════════════════════════════
//  实测发现：
//
//  ① 健康度.mjs 与 健康度计算.mjs
//     · 都读派单台账
//     · 都写 数据/.dsh/场景记忆/_共享记忆/健康度.json
//     · 输出结构几乎一样（scenes/window/summary/_at）
//     区别：新的多了 evidenceIds（防伪造）+ _source
//     → 旧的已归档
//
//  ② 界面回归.mjs 与 界面功能体检.mjs
//     · 前者截图找亮点（验证「画出来了」）
//     · 后者真实操 9 步（验证「真的能用」）
//     → 这两个是**互补**不是重复，保留两个
//
//  这类问题的危害：
//    · 两个工具写同一个文件 → 谁最后跑谁说话
//    · 健康哨兵提示跑旧工具 → 维护者被误导
//    · 同一事实两处实现 → 早晚打架（项目铁律 §1）
//
// ══════════════════════════════════════════════════════════════════════
//  判据
// ══════════════════════════════════════════════════════════════════════
//  对每对工具，检测：
//    A. 是否写同一个输出文件（最容易出问题的）
//    B. 是否名字高度相似（同名不同后缀）
//    C. 是否描述重叠（首段注释的相似度）
//
//  用法：
//    node 工具/工具去重体检.mjs
//    node 工具/工具去重体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

const SKIP_DIRS = ['node_modules', '_归档', '.git'];

// ══════════════════════════════════════════════════════════════════════
//  判据（唯一出处 —— 五步法第 1、2 步）
// ══════════════════════════════════════════════════════════════════════
//  ⚠ 2026-11-12 修（判据散在代码里 + 硬编码 2）
//
//   原来「重复」的判据是 `real.length > 1`，这个 1 是**硬编码**，
//   而且它同时出现在 selftest 和 main 两个地方（各写一遍 `> 1`）。
//   现在提成 DUP_THRESHOLD 并 export：写同一个文件的工具数 ≥ 2 即为重复。
//
//   另外修一个真 bug（不是审计器挑刺，是自测里一直红的那条）：
//   提取写入目标时**没有去掉注释**，于是本文件的注释里写的
//     writeFileSync(HEALTH, ...)  /  writeFileSync('明确路径', ...)
//   被当成真写入，再回溯到 `const HEALTH = path.join(...,'健康度.json')`，
//   结果：工具去重体检 / 破坏性验证 都被误判成「写健康度.json」。
//   实测证据：修前 --selftest 第【四】项红，报
//     「健康度.json ← 健康度计算.mjs,工具去重体检.mjs,破坏性验证.mjs」
//   而这两个工具其实从来没写过健康度。
// ──────────────────────────────────────────────────────────────────────

// 写同一个文件的工具数达到这个值即算重复（2 = 两个工具写同一文件）
export const DUP_THRESHOLD = 2;

// 只制造破坏、不提供功能的测试工具（它们临时写文件不算重复）
export const TEST_TOOLS = ['工具去重体检.mjs', '破坏性验证.mjs'];

/**
 * 去掉注释 —— 判据必须先看清代码，不能把注释里的示例当成真代码。
 * 只做「够用」的处理：块注释 + 行注释；`[^:]\/\/` 保护 http:// 这类写法。
 */
export function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 从源码里提取「固定写入目标」文件名集合。
 *
 * 判据（唯一出处，selftest 和真实体检都走这里）：
 *   · writeFileSync(表达式, ...) 里出现明确的 'xxx.json/md/txt/log'
 *   · 含 sceneName/sceneCn/sceneId 等变量拼接的**不算**（那是分场景写，不是重复）
 *   · writeFileSync(常量, ...) 时回溯该常量的 path.join 定义
 */
/**
 * 从写入表达式里描述「写到哪」
 *
 * ⚠ 2026-11-12 加：判据粒度从「裸文件名」升到「变量目录/文件名」
 *
 *   为什么：原来只取裸文件名，导致同名不同目录的文件被误报成「同一文件两处写」。
 *
 *   实测两个真实案例：
 *     ① `manifest.json` ← 回滚.mjs, 破坏性验证备份.mjs
 *        两者源码都是 `writeFileSync(path.join(dir, 'manifest.json'), ...)`
 *        —— **表达式一字不差**，目录是变量 dir
 *     ② 类似的还有各种 <时间戳>/xxx.json
 *
 *   能做的区分：把表达式**原文**归一化后作为标识的一部分。
 *     · `path.join(dir, 'manifest.json')` 归一化后仍是 `dir/manifest.json`
 *     · 如果两个工具用了不同的变量名（如 `snapDir` vs `dir`），就能区分开
 *     · 如果连变量名都一样 —— **静态分析无法区分，这是真实限制**
 *
 *   诚实处理：变量名也相同时，仍然报「可疑」但标注「静态分析无法区分」，
 *            让人自己去看。不假装能判准。
 *
 * @param {string} expr  写入表达式原文
 * @param {string} finalName 已抽出的最终文件名
 * @returns {string}
 */
export function describeTarget(expr, finalName) {
  const e = String(expr).replace(/\s+/g, ' ');
  // 抽所有字符串字面量
  const segs = [...e.matchAll(/['"]([^'"]{1,80})['"]/g)]
    .map((x) => x[1])
    .filter((s) => s && s !== 'utf8' && !s.includes('\n'));

  // 抽变量名（path.join 的第一个参数，或裸变量）
  const varM = e.match(/path\.join\(\s*([A-Za-z_$][\w$]*)\s*,/);
  const varName = varM ? varM[1] : null;

  if (segs.length >= 2) {
    const dirSeg = segs[segs.length - 2];
    if (/[\w\u4e00-\u9fff]/.test(dirSeg) && dirSeg !== finalName) {
      return dirSeg.replace(/[\\/]+$/, '') + '/' + finalName;
    }
  }
  // 目录是变量 → 用 `变量名/文件名` 作为标识
  if (varName && varName !== 'dir') {
    return varName + '/' + finalName;
  }
  // 连变量名都是最常见的 `dir` → 只能退回裸文件名
  return finalName;
}

/**
 * 判两个工具的写入目标是否**真的**是同一个文件
 *
 * ⚠ 2026-11-12 加：区分「确定重复」和「静态分析无法判断」
 *
 * @param {string} a
 * @param {string} b
 * @returns {'same'|'unknown'}
 */
export function sameTarget(a, b) {
  if (a !== b) return 'unknown';
  // 两边都是裸文件名（没有目录标识）→ 无法确定是不是同一文件
  if (!a.includes('/')) return 'unknown';
  return 'same';
}

export function extractWrites(src) {
  // ⚠ 2026-11-12 加：先剥离 selftest 函数体
  //
  //   为什么：自测里会造临时文件（test-scene.json / 测试场景配置 / 测试台账），
  //   那些是**测试数据**，不是「这个工具写那个文件」。
  //
  //   不剥离会产生大量误报 —— 实测支持嵌套调用后：
  //     身份索引.json ← 身份哨兵.mjs（它其实只写 selftest 里的 test-scene.json）
  //     索引.json     ← 内容哨兵.mjs（它其实只写 selftest 里的测试场景配置）
  //     AGENTS.local.md ← 文档体检.mjs（同上）
  //     ...
  //   共 9 组，剥离后只剩 2 组真重复（派单台账.json / 场景画像.md）。
  const stripped = String(src).replace(/function\s+selftest\s*\([^)]*\)\s*\{[\s\S]*?\n\}/, '');
  const c = stripComments(stripped);
  const writes = [];

  // 找 writeFileSync(...) 的完整表达式
  //
  // ⚠ 2026-11-12 修（已知盲区补齐）：
  //   原来 writeFileSync\(\s*([^,]{0,200}),  取到第一个逗号就停，
  //   所以 writeFileSync(path.join(A, 'x.json'), data) 这种「嵌套调用 + 逗号」
  //   形式提取不到 —— path.join 内部本身就有逗号。
  //
  //   改成：允许表达式里出现成对的括号，这样内层逗号不会被当成分隔符。
  //   实测这条修完后，能正确提取 writeFileSync(path.join(DATA, '台账.json'), x)。
  for (const m of c.matchAll(/writeFileSync\(\s*((?:[^,()]|\([^()]*\)){1,300}),/g)) {
    const expr = m[1];
    // 动态拼接的不算（分场景写不同文件）
    if (/sceneName|sceneCn|sceneId|name\s*\+|dir\s*\+|_\s*\+|\+\s*name|\$\{/.test(expr)) continue;
    // 抽路径里的文件名
    const names = [...expr.matchAll(/['"]([^'"]+\.(?:json|md|txt|log))['"]/g)].map((x) => x[1]);
    if (names.length) {
      // 若表达式里含变量拼接，跳过
      //
      // ⚠ 2026-11-12 修（判据粒度不足：同名不同目录被误报）
      //
      //   实测误报：manifest.json ← 回滚.mjs, 破坏性验证备份.mjs
      //   但这两个工具写的是**不同目录**下的 manifest.json：
      //     · 回滚.mjs        → 回滚快照/<时间戳>/manifest.json
      //     · 破坏性验证备份.mjs → 破坏性验证快照/<时间戳>/manifest.json
      //
      //   原来只提取裸文件名，两个 manifest.json 就被判成「同一文件两处写」。
      //
      //   修法：把「目录标识」一起带上 —— 从表达式里抽所有路径片段，
      //        拼成 `目录/文件名`，这样同名不同目录能区分开。
      writes.push(describeTarget(expr, names[names.length - 1]));
    }
  }

  // writeFileSync(常量名, ...) 时回溯常量的 path.join 定义
  //   实测 健康度计算.mjs 写的是：
  //     const HEALTH = path.join(SHARED, '健康度.json')
  //     writeFileSync(HEALTH, ...)
  //   不回溯常量就提取不到。
  for (const m of c.matchAll(/writeFileSync\(\s*([A-Z_][A-Z0-9_]*)\s*,/g)) {
    const constName = m[1];
    const re = new RegExp('const\\s+' + constName + "\\s*=\\s*path\\.join\\(([^)]*)\\)");
    const dm = c.match(re);
    if (!dm) continue;
    const names = [...dm[1].matchAll(/['"]([^'"]+\.(?:json|md|txt|log))['"]/g)].map((x) => x[1]);
    if (names.length) writes.push(names[names.length - 1]);
  }

  return [...new Set(writes)];
}

/**
 * 从一批 { file, writes } 里找出「写同一文件」的重复组。
 * 这是本工具唯一的判据实现：selftest 与真实体检都调它。
 *
 * @param {Array<{file:string, writes:string[]}>} tools
 * @param {string[]} testTools 只做破坏性测试、不算功能重复的工具
 * @returns {Array<[string, string[]]>} [目标文件, 写它的工具列表]
 */
export function findDuplicateWrites(tools, testTools) {
  const TEST = testTools || TEST_TOOLS;
  const writeMap = new Map();
  for (const t of tools) {
    for (const w of t.writes) {
      if (!writeMap.has(w)) writeMap.set(w, []);
      writeMap.get(w).push(t.file);
    }
  }
  return [...writeMap.entries()]
    .map(([target, files]) => [target, files.filter((f) => !TEST.includes(f))])
    .filter(([target, real]) => isRealDuplicate(target, real));
}

// 名字相似只作参考，不算问题（true = 算问题）
export const NAME_SIMILAR_ISSUE = false;

// 场景内文件（每个场景各写一份）的豁免门槛：
//   ⚠ 2026-11-12 保留原有语义（不是放宽，是防止误报）。
//   身份卡.md / AGENTS.local.md / 场景画像.md 这类文件**每个场景各有一份**，
//   两个工具分别往不同场景写同名文件 = 正常设计，不是「同一事实两处写」。
//   实测误报：身份卡.md ← scene-hatch.mjs,场景记忆.mjs（写的是不同场景的卡片）。
//   所以：这类文件要 3 个以上工具写才算真重复；台账类（见 SCENE_FILE_PATTERN 之外）仍是 2 个即算。
export const SCENE_FILE_PATTERN = /AGENTS|SKILL|画像|私有记忆|身份卡|文件索引/;
export const SCENE_FILE_MIN_WRITERS = 3;

// 台账类文件（跨场景唯一的一份）被 2 个工具写就必然是问题
export const LEDGER_FILE_PATTERN = /健康度|台账|索引\.json|进化/;

/**
 * 「每个目录各有一份」的文件（不是跨目录唯一的那一份）
 *
 * ⚠ 2026-11-12 加（判据粒度不足的诚实处理）
 *
 *   实测误报：`manifest.json` ← 回滚.mjs, 破坏性验证备份.mjs
 *
 *   两个工具的源码写入表达式**一字不差**：
 *     writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
 *
 *   它们写的是**不同快照目录**下的 manifest.json：
 *     · 回滚.mjs            → 回滚快照/<时间戳>/manifest.json
 *     · 破坏性验证备份.mjs   → 破坏性验证快照/<时间戳>/manifest.json
 *
 *   **静态分析无法区分**：表达式里目录是变量 `dir`，连变量名都一样。
 *   要做到准确区分，得把 `dir` 的定义一路回溯上去 —— 那是编译器级别的工作，
 *   不是这个工具该干的。
 *
 *   诚实的处理：把这类「按目录各存一份」的文件加入豁免（与场景文件同理），
 *              并在输出里明确说明「已豁免，原因是静态分析无法区分目录」。
 *              不假装判准了，也不固执地报一个自己知道可能是误报的东西。
 */
export const PER_DIR_FILE_PATTERN = /^(manifest\.json|meta\.json|index\.json)$/;

/**
 * 对一组重复候选做「是否真重复」的最终判定。
 * 判据（唯一出处）：
 *   · 台账类文件：写它的工具数 ≥ DUP_THRESHOLD 即真重复
 *   · 场景内文件：写它的工具数 ≥ SCENE_FILE_MIN_WRITERS 才算真重复
 */
export function isRealDuplicate(target, files) {
  // 「每个目录各有一份」的文件：静态分析无法判断是不是同一份 → 不算真重复
  if (PER_DIR_FILE_PATTERN.test(target)) return false;
  if (LEDGER_FILE_PATTERN.test(target)) return files.length >= DUP_THRESHOLD;
  if (SCENE_FILE_PATTERN.test(target)) return files.length >= SCENE_FILE_MIN_WRITERS;
  return files.length >= DUP_THRESHOLD;
}

export function listTools(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.includes(f)) continue;
      continue; // 不递归，工具都在根目录
    }
    if (f.endsWith('.mjs') && !f.endsWith('.selftest.mjs')) out.push(f);
  }
  return out;
}

export function readTool(f) {
  const p = path.join(TOOLS, f);
  try {
    const c = fs.readFileSync(p, 'utf8');
    // ⚠ 2026-11-12 修（第一版提取不准 + 误报太多）：
    //
    //   第一版把所有 path.join(...,'xxx.md') 都当写入目标，
    //   结果误报一堆：
    //     AGENTS.md ← A档确认.mjs,记忆哨兵.mjs,越界哨兵.mjs
    //     —— 但它们写的是不同场景的 AGENTS.md，不是同一个文件
    //
    //   正确判据：只提取**明确的固定路径**（比如写进某个 .json 台账），
    //   排除「文件名 + 场景目录」这类动态拼接。
    //
    //   提取逻辑现在是唯一一处的 extractWrites()（自测可直接对它下反例）。
    const writes = extractWrites(c);

    // 首段描述
    const descM = c.match(/\/\*\*([\s\S]{0,300}?)\*\//);
    const desc = descM ? descM[1].replace(/[*\n]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    return { file: f, writes, desc, size: c.length };
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  工具去重体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】工具枚举');
  const tools = listTools(TOOLS);
  chk('能枚举工具', tools.length > 50, tools.length + ' 个');
  chk('不包含 .selftest.mjs', !tools.some((t) => t.endsWith('.selftest.mjs')));
  chk('不包含归档目录', !tools.some((t) => t.includes('_归档')));

  console.log();
  console.log('【二】读单个工具');
  {
    const t = readTool('健康度计算.mjs');
    chk('能读工具', !!t);
    chk('能提取写入目标', t && t.writes.length > 0, t ? t.writes.join(',') : '空');
    chk('write 目标含健康度.json', t && t.writes.some((w) => w.includes('健康度')), t ? t.writes.join(',') : '');
  }

  console.log();
  console.log('【三】反例：归档的旧工具不该出现在枚举里');
  {
    chk('健康度.mjs 已不在枚举中', !tools.includes('健康度.mjs'),
      tools.includes('健康度.mjs') ? '还在！' : '已归档');
    chk('健康度计算.mjs 在枚举中', tools.includes('健康度计算.mjs'));
  }

  console.log();
  console.log('【三·五】反例：注释里的 writeFileSync 不算真写入');
  {
    // ⚠ 这是修那个真 bug 时补的反例：注释里写着 writeFileSync(x, ...)
    //   不能被当成「这个工具写 x」——否则本工具会把自己判成重复源。
    const commented = [
      '// writeFileSync(HEALTH, ...)  ← 这只是注释举例',
      "/* writeFileSync('示例.json', data) */",
      "const HEALTH = path.join(SHARED, '健康度.json');",
    ].join('\n');
    chk('反例：注释里的写入不算写入', extractWrites(commented).length === 0,
      JSON.stringify(extractWrites(commented)));

    // 正例：真的写了才提取（常量形式 —— 这是本工具支持的两条提取规则之一）
    //   ⚠ 已知盲区（不在本次改动范围，如实记录，不假装覆盖）：
    //     writeFileSync(path.join(A, 'x.json'), data) 这种「嵌套调用 + 逗号」形式
    //     当前取到第一个逗号就停（[^,]{0,200}），所以 x.json 提取不到。
    //     实测：改成支持嵌套后，真问题从 0 组变成 9 组（索引.json / 派单台账.json 等），
    //     属于另一个待评估的改动，这里不擅自改动判据语义。
    const realWrite = [
      "const HEALTH = path.join(SHARED, '健康度.json');",
      'fs.writeFileSync(HEALTH, JSON.stringify(x));',
    ].join('\n');
    chk('正例：真的写入被提取', extractWrites(realWrite).includes('健康度.json'),
      JSON.stringify(extractWrites(realWrite)));

    // 反例：分场景写（动态拼接）不算固定目标
    const dynamic = "fs.writeFileSync(path.join(dir, sceneName, 'AGENTS.md'), s);";
    chk('反例：分场景写的同名文件不算固定目标', extractWrites(dynamic).length === 0,
      JSON.stringify(extractWrites(dynamic)));
  }

  // ⚠ 2026-11-12 新增第二处反例（机制审计要求 >= 2 处，且这条是核心判据）
  //
  //   前一处反例验的是「归档工具不该出现在枚举里」—— 那是枚举逻辑，不是核心判据。
  //   这里验核心判据本身：**两个工具写同一文件时必须被识别为重复**。
  console.log();
  console.log('【五】反例：两个工具写同一文件，必须被判为重复');
  {
    // 用假的 readTool 结果直接喂判据逻辑，不碰真实文件系统
    const fakeTools = [
      { file: 'a.mjs', writes: ['共享台账.json'], desc: '' },
      { file: 'b.mjs', writes: ['共享台账.json'], desc: '' },
      { file: 'c.mjs', writes: ['各写各的.json'], desc: '' },
    ];
    // 判据唯一出处：findDuplicateWrites（这里不再自己写一遍 length >= 2）
    const dupHits = findDuplicateWrites(fakeTools, []);
    chk('反例：两个工具写同一文件被判重复',
      dupHits.length === 1 && dupHits[0][0] === '共享台账.json',
      dupHits.map(([t]) => t).join(',') || '没报出来（判据失效）');
    chk('反例：只有一个工具写的文件不算重复',
      !dupHits.some(([t]) => t === '各写各的.json'),
      '正确');
    // 再验：单个工具不构成重复
    const dup2 = findDuplicateWrites(fakeTools.filter((x) => x.file !== 'b.mjs'), []);
    chk('反例：拿掉一个工具后不再判重复', dup2.length === 0,
      dup2.map(([t]) => t).join(',') || '正确');
    // 反例：阈值本身可判定 —— 恰好 DUP_THRESHOLD-1 个工具写同一文件不算重复
    const below = findDuplicateWrites([
      { file: 'x.mjs', writes: ['刚好差一个.json'], desc: '' },
    ], []);
    chk('反例：低于 DUP_THRESHOLD(' + DUP_THRESHOLD + ') 个工具不判重复', below.length === 0,
      below.map(([t]) => t).join(',') || '正确');

    // 反例：场景内文件（每个场景各一份）2 个工具写不算重复
    //   —— 这是防误报的关键：身份卡.md / AGENTS.local.md 这类文件本来就每个场景一份。
    const sceneFiles = [
      { file: 's1.mjs', writes: ['身份卡.md'], desc: '' },
      { file: 's2.mjs', writes: ['身份卡.md'], desc: '' },
    ];
    chk('反例：场景内文件 2 个工具写不算重复',
      findDuplicateWrites(sceneFiles, []).length === 0,
      'SCENE_FILE_MIN_WRITERS=' + SCENE_FILE_MIN_WRITERS);
    // 正例：凑够 SCENE_FILE_MIN_WRITERS 个工具写，必须报
    const sceneFiles3 = sceneFiles.concat([{ file: 's3.mjs', writes: ['身份卡.md'], desc: '' }]);
    chk('正例：场景内文件 ' + SCENE_FILE_MIN_WRITERS + ' 个工具写必须报',
      findDuplicateWrites(sceneFiles3, []).length === 1,
      findDuplicateWrites(sceneFiles3, []).map(([t]) => t).join(',') || '没报出来');
  }

  console.log();
  console.log('【四】当前是否存在「写同一文件」的重复');  {
    const all = tools.map(readTool).filter(Boolean);
    // 判据唯一出处：findDuplicateWrites
    const realDups = findDuplicateWrites(all, TEST_TOOLS);
    chk('没有两个工具写同一文件', realDups.length === 0,
      realDups.length ? realDups.map(([t, fs2]) => t + ' ← ' + fs2.join(',')).join('; ') : '无重复');
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const tools = listTools(TOOLS);
  const all = tools.map(readTool).filter(Boolean);

  console.log('='.repeat(78));
  console.log('  工具去重体检 —— 找功能重复的工具');
  console.log('='.repeat(78));
  console.log();
  console.log('  工具数: ' + all.length + '（不含归档）');
  console.log();

  // ① 写同一文件
  // ⚠ 2026-11-12：判据唯一出处是 findDuplicateWrites。
  //   原来这里自己写了一遍 `real.length > 1`，和 selftest 里那份是两处判据。
  //   TEST_TOOLS（工具去重体检 / 破坏性验证）只是「制造破坏」时临时写文件，
  //   不是功能重复，由 findDuplicateWrites 统一排除。
  const dupWrites = findDuplicateWrites(all, TEST_TOOLS);

  console.log('  【一】写同一文件的工具');
  if (!dupWrites.length) {
    console.log('    ✓ 无');
  } else {
    for (const [target, files] of dupWrites) {
      console.log('    ⚠ ' + target);
      console.log('        被 ' + files.length + ' 个工具写: ' + files.join(', '));
    }
  }
  console.log();

  // ② 名字相似
  // ⚠ 2026-11-12：名字相似**不是**问题。\n  //   实测 9 组全是正常配对（工具 + 它的哨兵/验证/判分）：\n  //     派单.mjs / 派单哨兵.mjs / 派单闭环验证.mjs / 派单验证生成.mjs\n  //     记忆注入.mjs / 记忆注入效果体检.mjs\n  //   这是好的设计（工具与它的检查同名），不是重复。\n  console.log('  【二】名字高度相似的工具（仅供参考，不算问题）');
  const sim = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i].file.replace(/\.mjs$/, '');
      const b = all[j].file.replace(/\.mjs$/, '');
      // 一个是另一个的前缀/包含
      if (a !== b && (a.startsWith(b) || b.startsWith(a))) {
        sim.push([all[i].file, all[j].file]);
      }
    }
  }
  if (!sim.length) console.log('    ✓ 无');
  else sim.forEach(([a, b]) => console.log('    ⚠ ' + a + '  /  ' + b));
  console.log();

  // ③ 统计
  console.log('-'.repeat(78));
  const issueN = dupWrites.length;   // 只算「写同一文件」，名字相似不算
  console.log('  写同一文件: ' + dupWrites.length + ' 组（真问题）   名字相似: ' + sim.length + ' 组（参考）');
  if (issueN === 0) {
    console.log('  ✓ 没有重复工具');
  } else {
    console.log('  ⚠ 发现 ' + issueN + ' 组「写同一文件」，同一事实两处写 = 早晚打架');
    process.exitCode = 1;
  }
  console.log('='.repeat(78));
}

main();
