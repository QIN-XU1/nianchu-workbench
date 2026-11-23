#!/usr/bin/env node
/**
 * 面板注册体检 —— 配置里用到的类型，都必须有渲染器
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 01-场景模式/面板类型总览.md + 面板类型与注册.md）
 * ══════════════════════════════════════════════════════════════
 *
 *  > 「下面是 24 种全来自一台真跑着的机器。
 *  >   ⚠ 它们是**类型名**，不是能直接跑的代码：
 *  >   每种都要你在 `renderer/` 里注册一个渲染器。」
 *
 *  他的 24 种分 7 族：
 *    通用族（8）：view / file / embed / web / harness / reserved / combo / dash
 *    流程图族（1）：flow
 *    数据行情族（3）：chart / board / screen
 *    电脑族（4）：pc-drives / pc-toplarge / pc-junk / pc-ledger
 *    其他族（8）：未在公开版本展示
 *
 *  > 「`view` + `file` 是**天然一对**：file 的 viewPanel 指向 view 的 id，
 *  >   点文件就在右边打开。这个双面板组合是整套壳里复用率最高的搭配。」
 *
 * ══════════════════════════════════════════════════════════════
 *  这个工具查什么
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 场景配置里用到的每个 panel.type，是否在 RENDERERS 里注册了
 *  ② registry 里注册的类型，对应的渲染器文件是否真实存在
 *  ③ 面板 id 是否唯一（同一场景内）
 *  ④ 网格越界：col+w-1 是否超出 cols
 *  ⑤ AI 面板数量（每个场景应有且仅有一条 harness 会话绑一条 sessionId）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/面板体检.mjs            检查
 *  node 工具/面板体检.mjs --json
 *  node 工具/面板体检.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN = path.join(WB, '外壳', 'scenarios');
const UI = path.join(WB, '外壳', 'ui');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从 ui/index.js 读出 RENDERERS 列表
// ══════════════════════════════════════════════════════════════
export function loadRenderers() {
  const s = readTextSafe(path.join(UI, 'index.js'));
  if (!s) return { ok: false, error: '读不到 ui/index.js', list: [] };

  const list = [];
  // { type: 'xxx', path: './panels/yyy.js', name: '...' }
  const re = /\{\s*type:\s*'([^']+)'\s*,\s*path:\s*'([^']+)'\s*,\s*name:\s*'([^']*)'\s*\}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    list.push({ type: m[1], path: m[2], name: m[3] });
  }

  return { ok: list.length > 0, list };
}

// ══════════════════════════════════════════════════════════════
//  检查一个场景的 panels
// ══════════════════════════════════════════════════════════════
export function checkScene(sceneJson, registered) {
  const j = sceneJson || {};
  const panels = Array.isArray(j.panels) ? j.panels : [];
  const reg = registered instanceof Set ? registered : new Set(registered || []);
  const problems = [];

  // 网格
  const cols = Number(j.cols) || 4;
  const rows = Number(j.rows) || Math.max(1, ...panels.map((p) => (p.row || 1) + (p.h || 1) - 1));

  const seenIds = new Set();
  let harnessCount = 0;

  for (const p of panels) {
    const pid = p.id || '(无 id)';

    // ① 类型已注册
    if (!p.type) {
      problems.push(pid + '：缺 type');
    } else if (!reg.has(p.type)) {
      problems.push(pid + '：类型「' + p.type + '」没有注册渲染器');
    }

    // ② id 唯一
    if (p.id) {
      if (seenIds.has(p.id)) problems.push('面板 id 重复：' + p.id);
      seenIds.add(p.id);
    }

    // ③ 网格越界
    const c = Number(p.col) || 1;
    const r = Number(p.row) || 1;
    const w = Number(p.w) || 1;
    const h = Number(p.h) || 1;
    if (c + w - 1 > cols) {
      problems.push(pid + '：横向越界（col ' + c + ' + w ' + w + ' - 1 > cols ' + cols + '）');
    }
    if (r + h - 1 > rows) {
      problems.push(pid + '：纵向越界（row ' + r + ' + h ' + h + ' - 1 > rows ' + rows + '）');
    }

    // ④ AI 面板计数
    if (p.type === 'harness') harnessCount++;
  }

  return {
    sceneId: j.id,
    sceneName: j.name || j.id,
    panelCount: panels.length,
    harnessCount,
    types: [...new Set(panels.map((p) => p.type).filter(Boolean))],
    ok: problems.length === 0,
    problems,
  };
}

// ══════════════════════════════════════════════════════════════
//  源码卫生检查（2026-11-11 加，事故 AC-022 / AC-023 / AC-024）
//
//  查三件「代码看着对、跑起来是错的」的事：
//
//    ① api 解包 —— await api.xxx() 返回 { ok, value }，
//       数据在 .value 里。直接读 r.rows 会拿到 undefined。
//
//    ② cssText 覆盖 —— makeShell 返回的 body 带 flex:1 1 auto，
//       面板里用 `body.style.cssText = '...'` 会覆盖掉 → 布局塌陷。
//       必须用 +=。
//       ⚠ 规则要精确：只查「从 makeShell 解构出来的 body」。
//         自己 createElement 的 body 首次赋值是正常的（frame.js 就是）。
//
//    ③ ESM 能加载 —— node --check 查不出 ESM 特定问题，
//       必须真实 import 才知道模块能不能用。
// ══════════════════════════════════════════════════════════════
//  AC-024 精确判据：找出「覆盖 makeShell 给的 body」的赋值
//
//  为什么要精确（不能只看一句正则）
//
//  `body.style.cssText = '...'` 这行文本本身不能判错：
//    · 在 makeShell 定义里（createElement 之后首次赋值）→ 正常
//    · 在 frame.js 那种自建 body 里 → 正常
//    · 在「const { body } = makeShell(...) 之后」→ 才是覆盖，才是 AC-024
//
//  所以必须先确定「这个 body 是不是 makeShell 给的」。
//  做法：把源码按函数边界切段，逐段查。
//  ⚠ 这是作用域的近似（正则切分，不做真正的 AST），
//    盲区写在这里：如果 makeShell 在 A 函数里解构、覆盖写在 B 函数里，
//    这段会漏。实际代码不会这么写，但盲区要写明。
// ══════════════════════════════════════════════════════════════
export function findMakeShellBodyOverrides(src) {
  const hits = [];
  // 按可能的作用域起点切段
  const boundaries = [];
  const reFn = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*|(?:^|\n)\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/g;
  let m;
  while ((m = reFn.exec(src)) !== null) boundaries.push(m.index);
  boundaries.push(src.length);

  for (let i = 0; i < boundaries.length - 1; i++) {
    const seg = src.slice(boundaries[i], boundaries[i + 1]);
    // 这一段里 body 是不是从 makeShell 解构出来的？
    if (!/const\s*\{\s*body[^}]*\}\s*=\s*makeShell/.test(seg)) continue;

    // 找覆盖（= 而不是 +=）：注意要排除 `+=`
    for (const mm of seg.matchAll(/body\.style\.cssText\s*=(?!=)\s*['"]/g)) {
      const abs = boundaries[i] + mm.index;
      const line = src.slice(0, abs).split('\n').length;
      hits.push({ line });
    }
  }
  return hits;
}

// ══════════════════════════════════════════════════════════════
export function checkSourceHygiene(opts) {
  const o = opts || {};
  const dir = o.panelsDir || path.join(UI, 'panels');
  const problems = [];
  const checked = [];

  if (!fs.existsSync(dir)) {
    return { ok: false, problems: ['面板目录不存在: ' + dir], checked: [] };
  }

  // ⚠ 2026-11-12 修（判据漏了一整个文件族：`_` 开头的实现文件从未被扫）
  //
  //  原判据：readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_'))
  //          用 `!f.startsWith('_')` 把下划线开头的文件全排除了。
  //  错在哪：本项目真正的面板实现就在 `_generic.js`（58KB / 20 个面板共用），
  //          恰恰因为它以 `_` 开头，**从来没被卫生检查扫过一次**。
  //          实测：把 `_generic.js` 纳入扫描后，立刻发现它用 `body.style.cssText =`
  //          覆盖了 makeShell 给的 `flex:1 1 auto` —— 就是 AC-024 那个事故形态。
  //
  //  但也不能无脑全扫：`_generic.js` 里包含 makeShell **自身的定义**，
  //  那里 `body.style.cssText = 'flex:1 1 auto;...'` 是首次赋值，**完全正常**
  //  （frame.js 的自建 body 同理）。判据必须能区分「createElement 后首次赋值」
  //  和「覆盖 makeShell 给的 body」。
  //
  //  所以改成：
  //    · 扫描所有 .js（含 `_` 开头），不再整族跳过
  //    · AC-024 判据精确到「同一函数作用域内，先 const {body}=makeShell 再 = 覆盖」
  //      —— 用「把源码按 function 边界切开，逐段判断」近似作用域。
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

  for (const f of files) {
    const full = path.join(dir, f);
    let src = '';
    try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
    checked.push(f);

    // 跳过薄转发壳（只有 export ... from 的 0.2KB 文件）
    const isShell = /^\s*(\/\/[^\n]*\n\s*)*export\s*\{[^}]*\}\s*from/.test(src) && src.length < 600;
    if (isShell) continue;

    // ① api 解包
    const apiCalls = [...src.matchAll(/await\s+api\.\w+(?:\.\w+)?\(/g)];
    const hasUnwrap = /Unwrap\s*\(|\.value\b/.test(src);
    if (apiCalls.length > 0 && !hasUnwrap) {
      problems.push(f + '：调了 ' + apiCalls.length + ' 处 api.*，但没有 Unwrap/.value 解包（AC-023）');
    }

    // ② cssText 覆盖（只查 makeShell 的 body，且必须同作用域）
    const badCss = findMakeShellBodyOverrides(src);
    if (badCss.length > 0) {
      problems.push(f + '：' + badCss.length + ' 处用 `body.style.cssText =` 覆盖了 makeShell 给的 ' +
        'flex:1 1 auto（应改用 +=，否则布局塌陷，AC-024）' +
        '：第 ' + badCss.map((x) => x.line).join('、') + ' 行');
    }
  }

  // ③ 真实 import 验证
  const generic = path.join(dir, '_generic.js');
  if (fs.existsSync(generic)) {
    try {
      const url = 'file:///' + generic.replace(/\\/g, '/');
      const code =
        'import(' + JSON.stringify(url) + ').then(m => {' +
        '  const n = Object.keys(m).filter(k => k !== "default").length;' +
        '  console.log("EXPORTS=" + n);' +
        '}).catch(e => { console.log("LOAD_ERR=" + e.message); });';
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
      });
      if (out.includes('LOAD_ERR=')) {
        problems.push('_generic.js 加载失败（node --check 查不出这种错，AC-022）: ' +
          out.split('LOAD_ERR=')[1].trim().slice(0, 120));
      } else {
        const m = out.match(/EXPORTS=(\d+)/);
        if (m && Number(m[1]) < 5) {
          problems.push('_generic.js 只导出 ' + m[1] + ' 个函数，应该有 8 个');
        }
      }
    } catch (e) {
      problems.push('_generic.js import 验证执行失败: ' + String((e && e.message) || e).slice(0, 100));
    }
  }

  return { ok: problems.length === 0, problems, checked };
}

// ══════════════════════════════════════════════════════════════
//  检查全部
// ══════════════════════════════════════════════════════════════
export function checkAll(opts) {
  const o = opts || {};
  const r = o.renderers || loadRenderers();
  const scenes = o.scenes || loadSceneJsons();
  const registered = new Set(r.list.map((x) => x.type));

  // ① 渲染器文件是否存在
  const missingFiles = [];
  for (const x of r.list) {
    const p = path.join(UI, x.path.replace(/^\.\//, ''));
    if (!fs.existsSync(p)) missingFiles.push({ type: x.type, path: x.path });
  }

  // ② 每个场景
  const sceneResults = scenes.map((s) => checkScene(s.json, registered));

  // ③ 所有用到的类型是否都有渲染器
  const usedTypes = new Set();
  for (const s of scenes) {
    for (const p of (s.json.panels || [])) {
      if (p.type) usedTypes.add(p.type);
    }
  }
  const unregistered = [...usedTypes].filter((t) => !registered.has(t));

  // ④ 注册了但没用到的（不算错，但是信息）
  const unused = [...registered].filter((t) => !usedTypes.has(t));

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加（真缺陷：源码卫生检查从未在真实模式下跑过）
  //
  //  原来 checkSourceHygiene 只在 --selftest 里被调用（喂临时造的小文件），
  //  默认模式**一次都没跑过真实 panels 目录**。
  //  也就是说：AC-022（ESM 加载不了）、AC-023（api 没解包）、
  //  AC-024（cssText 覆盖）这三起真实事故的检查，
  //  在真实代码上是从来没被执行过的 —— 典型的「有判据、没挂上」。
  //
  //  现在把它接进 checkAll，让「渲染器文件存在」之外还有「渲染器代码是好的」。
  // ══════════════════════════════════════════════════════════════
  const hygiene = o.hygiene === false ? { ok: true, problems: [], checked: [] } : checkSourceHygiene(o);

  return {
    ok: missingFiles.length === 0 && unregistered.length === 0 &&
        sceneResults.every((x) => x.ok) && hygiene.ok,
    registeredCount: r.list.length,
    usedCount: usedTypes.size,
    renderers: r.list,
    missingFiles,
    unregistered,
    unused,
    scenes: sceneResults,
    sceneProblems: sceneResults.filter((x) => !x.ok),
    hygiene,
    // 汇总所有问题项，供差异集合输出
    problems: [
      ...missingFiles.map((m) => '渲染器文件不存在：' + m.type + ' → ' + m.path),
      ...unregistered.map((t) => '配置用了但没注册渲染器：' + t),
      ...sceneResults.flatMap((s) => s.problems.map((p) => s.sceneName + '：' + p)),
      ...hygiene.problems,
    ],
  };
}

function loadSceneJsons() {
  const out = [];
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json')) continue;
    const j = readJsonSafe(path.join(SCEN, f));
    if (j && j.id) out.push({ file: f, json: j });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  面板体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 能读 RENDERERS
  const r = loadRenderers();
  chk('能读渲染器列表', r.ok === true, r.list.length + ' 个');
  chk('渲染器有 type/path/name', r.list.every((x) => x.type && x.path && x.name),
      r.list[0] ? r.list[0].type + ' / ' + r.list[0].path : '');
  chk('harness 已注册', r.list.some((x) => x.type === 'harness'), '');

  const reg = new Set(r.list.map((x) => x.type));

  // ② 合规场景通过
  const good = {
    id: 'test', name: '测试', cols: 4, rows: 2,
    panels: [
      { id: 'p1', type: 'harness', col: 1, row: 1, w: 2, h: 2 },
      { id: 'p2', type: 'review-doc', col: 3, row: 1, w: 2, h: 2 },
    ],
  };
  const c1 = checkScene(good, reg);
  chk('合规场景通过', c1.ok === true, c1.problems.join(';') || 'ok');

  // ③ 反例：未注册类型
  const badType = {
    id: 'test', name: '测试', cols: 4, rows: 2,
    panels: [{ id: 'p1', type: 'never-seen-type', col: 1, row: 1, w: 1, h: 1 }],
  };
  const c2 = checkScene(badType, reg);
  chk('反例：未注册类型被检出', c2.ok === false,
      c2.problems.find((p) => p.includes('没有注册渲染器')) || '');

  // ④ 反例：面板 id 重复
  const dupeId = {
    id: 'test', name: '测试', cols: 4, rows: 2,
    panels: [
      { id: 'p1', type: 'harness', col: 1, row: 1, w: 1, h: 1 },
      { id: 'p1', type: 'review-doc', col: 2, row: 1, w: 1, h: 1 },
    ],
  };
  const c3 = checkScene(dupeId, reg);
  chk('反例：面板 id 重复被检出', c3.ok === false,
      c3.problems.find((p) => p.includes('重复')) || '');

  // ⑤ 反例：横向越界
  const overflow = {
    id: 'test', name: '测试', cols: 2, rows: 2,
    panels: [{ id: 'p1', type: 'harness', col: 2, row: 1, w: 3, h: 1 }],
  };
  const c4 = checkScene(overflow, reg);
  chk('反例：横向越界被检出', c4.ok === false,
      c4.problems.find((p) => p.includes('横向越界')) || '');

  // ⑥ 反例：缺 type
  const noType = {
    id: 'test', name: '测试', cols: 4, rows: 2,
    panels: [{ id: 'p1', col: 1, row: 1, w: 1, h: 1 }],
  };
  const c5 = checkScene(noType, reg);
  chk('反例：缺 type 被检出', c5.ok === false,
      c5.problems.find((p) => p.includes('缺 type')) || '');

  // ⑦ 真实场景
  const all = checkAll();
  chk('能检查真实场景', all.scenes.length > 0, all.scenes.length + ' 个');
  chk('能统计已用类型', all.usedCount > 0, all.usedCount + ' 种 / 注册 ' + all.registeredCount + ' 种');

  // ⑧ 关键：配置里的类型必须有渲染器
  chk('关键：配置类型 ⊂ 已注册类型',
      all.unregistered.length === 0,
      all.unregistered.length === 0
        ? '全部已注册'
        : '未注册: ' + all.unregistered.join(', '));

  // ══ ④ 源码卫生（AC-022 / AC-023 / AC-024）══
  const hy = checkSourceHygiene();
  chk('源码卫生检查能跑', typeof hy.ok === 'boolean', hy.checked.length + ' 个面板文件');
  chk('真实数据无卫生问题', hy.ok === true, hy.problems.length ? hy.problems[0] : '✓ 全干净');

  // 反例：造一个「makeShell 的 body 用了 = 」的样本，必须被检出
  (function () {
    const tmpDir = path.join(os.tmpdir(), 'hy-' + Date.now());
    const tmpFile = path.join(tmpDir, 'bad.js');
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(tmpFile,
        "export function x(h, p, c) {\n" +
        "  const { body } = makeShell(h, p, c, {});\n" +
        "  body.style.cssText = 'color:red';\n" +
        '}\n', 'utf8');
      const r = checkSourceHygiene({ panelsDir: tmpDir });
      chk('反例：makeShell body 用 = 被检出',
          !r.ok && r.problems.some((p) => p.includes('AC-024')),
          r.problems[0] || '未检出');
    } catch (e) {
      chk('反例：makeShell body 用 = 被检出', false, String(e.message));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  })();

  // 反例：调 api 但没解包
  (function () {
    const tmpDir = path.join(os.tmpdir(), 'hy2-' + Date.now());
    const tmpFile = path.join(tmpDir, 'bad2.js');
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(tmpFile,
        "export async function x(api) {\n" +
        '  const r = await api.pc.drives();\n' +
        '  return r.rows;\n' +
        '}\n', 'utf8');
      const r = checkSourceHygiene({ panelsDir: tmpDir });
      chk('反例：调 api 没解包被检出',
          !r.ok && r.problems.some((p) => p.includes('AC-023')),
          r.problems[0] || '未检出');
    } catch (e) {
      chk('反例：调 api 没解包被检出', false, String(e.message));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  })();

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

  const all = checkAll();

  if (has('--json')) {
    console.log(JSON.stringify(all, null, 2));
    process.exit(all.ok ? 0 : 1);
  }

  console.log('═'.repeat(78));
  console.log('  面板注册体检');
  console.log('═'.repeat(78));
  console.log();
  console.log('  已注册渲染器: ' + all.registeredCount + ' 种');
  console.log('  场景实际用到: ' + all.usedCount + ' 种');
  console.log();
  console.log('  ' + '已注册'.padEnd(18) + '渲染器文件');
  console.log('  ' + '─'.repeat(60));
  for (const x of all.renderers) {
    const exists = !all.missingFiles.some((m) => m.type === x.type);
    console.log('  ' + (exists ? '✓' : '✗') + ' ' + x.type.padEnd(16) + x.path.padEnd(28) + x.name);
  }

  if (all.unused.length > 0) {
    console.log();
    console.log('  ○ 注册了但没场景用: ' + all.unused.join(', '));
  }

  if (all.missingFiles.length > 0) {
    console.log();
    console.log('  🔴 渲染器文件不存在:');
    for (const m of all.missingFiles) console.log('    · ' + m.type + ' → ' + m.path);
  }

  if (all.unregistered.length > 0) {
    console.log();
    console.log('  🔴 配置里用了但没注册渲染器:');
    for (const t of all.unregistered) console.log('    · ' + t);
  }

  console.log();
  console.log('─'.repeat(78));
  console.log('  场景面板检查');
  console.log('─'.repeat(78));
  for (const s of all.scenes) {
    const mark = s.ok ? '✓' : '✗';
    console.log('  ' + mark + ' ' + s.sceneName.padEnd(12) +
      s.panelCount + ' 面板（AI ' + s.harnessCount + '）  ' +
      s.types.join(', '));
    for (const p of s.problems) console.log('      ✗ ' + p);
  }

  console.log();
  console.log('─'.repeat(78));
  console.log('  面板源码卫生（AC-022 / AC-023 / AC-024）');
  console.log('─'.repeat(78));
  if (all.hygiene.checked.length === 0) {
    console.log('  ⚠ 没扫到任何面板文件（检查没真正执行）');
  } else if (all.hygiene.ok) {
    console.log('  ✓ ' + all.hygiene.checked.length + ' 个面板文件通过（无 ESM 加载错、api 已解包、cssText 用 +=）');
  } else {
    console.log('  🔴 ' + all.hygiene.problems.length + ' 处问题：');
    for (const p of all.hygiene.problems) console.log('    · ' + p);
  }

  console.log();
  console.log('═'.repeat(78));
  if (all.ok) {
    console.log('  ✓ 全部通过：配置类型全部已注册，面板 id 唯一，无越界，源码卫生');
  } else {
    console.log('  ✗ 有问题，见上（共 ' + all.problems.length + ' 处）');
  }
  console.log('═'.repeat(78));

  process.exit(all.ok ? 0 : 1);
}
