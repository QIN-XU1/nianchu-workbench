#!/usr/bin/env node
/**
 * 界面 IA 审计 —— 「像两份产品硬拼」这件事的可测量版本
 *
 * ── 背景（用户 2026-11-15 的原话）──────────────────────────
 * 「我看到你新搭的场景包括界面与原项目看起来并不一致，像是两份产品硬拼凑」
 *
 * 我先排查了皮肤层：token 用量 / 裸 px / 裸 hex —— 两边都是 0 裸 hex、都走
 * var(--openbitfun-*)。**所以不是配色问题。**
 *
 * 病根在信息架构。方案/91-场景构建设计.md:220 写着：
 *   「**神经元不是场景，是场景的导航层**」
 * 方案/66:176 更明确：「去掉场景标签栏 —— 场景不再是标签，是神经元里的节点」
 *
 * 而我做的事是：在原生场景旁边**又加了 4 个平行 tab**（vouch-verify / overview /
 * memory / net），配自己的类名前缀和自己的 data JSON。
 * **这正好是那条已定架构的反向操作** —— 所以看起来像两份产品：因为它就是两套 IA。
 *
 * ── 这个脚本量什么 ──────────────────────────────────────
 *   · 顶层 tab 场景数（越多 = 越依赖标签栏导航）
 *   · 带独立前缀的「第二套」场景数（vouch-* = 硬拼的痕迹）
 *   · 有没有导航层（神经元 / 星图 / 关系图）承接「场景之间怎么走」
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS     有导航层，且第二套前缀场景 ≤ 1
 *   WARN     有导航层但第二套场景多；或没导航层但只有一套场景
 *   FAIL     没导航层 且 存在第二套前缀场景（= 两份产品硬拼）
 *   UNKNOWN  读不到场景注册表
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const APP = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app');
const REGISTRY = path.join(APP, 'scenes/registry.ts');

/** 从注册表源码里抽出所有顶层场景 id */
export function parseSceneIds(src) {
  const ids = [];
  const re = /id:\s*'([a-z0-9-]+)'(?:\s+as\s+SceneTabId)?/g;
  let m;
  while ((m = re.exec(src)) !== null) ids.push(m[1]);
  return [...new Set(ids)];
}

/** 判定某一组场景 id 里有多少属于「第二套产品」（带独立前缀） */
export function countSecondProduct(ids, prefixes) {
  return ids.filter((id) => prefixes.some((p) => id.startsWith(p)));
}

/**
 * 审计
 *
 * @param src        注册表源码
 * @param hasNav     是否存在导航层（神经元/星图/关系图）
 * @param prefixes   被视为「第二套产品」的 id 前缀
 */
export function auditIA(src, hasNav, prefixes = ['vouch-']) {
  const ids = parseSceneIds(src);
  const second = countSecondProduct(ids, prefixes);

  let state, why;
  if (!ids.length) {
    state = 'UNKNOWN'; why = '读不到任何场景 id —— 注册表格式可能变了';
  } else if (!hasNav && second.length > 0) {
    state = 'FAIL';
    why = '没有导航层，且有 ' + second.length + ' 个「第二套前缀」场景（' + second.join(', ') + '）'
      + ' ⇒ **两份产品硬拼**：' + ids.length + ' 个顶层 tab 里，' + second.length + ' 个来自另一套 IA';
  } else if (!hasNav) {
    state = 'WARN';
    why = '没有导航层，但只有一套场景（' + ids.length + ' 个 tab）—— 单靠标签栏导航，场景一多就退化';
  } else if (second.length > 1) {
    state = 'WARN';
    why = '有导航层，但仍有 ' + second.length + ' 个第二套前缀场景（' + second.join(', ') + '）需要收进导航';
  } else {
    state = 'PASS';
    why = '有导航层，第二套前缀场景 ' + second.length + ' 个（' + ids.length + ' 个 tab 共处一套 IA）';
  }
  return { state, why, sceneCount: ids.length, secondCount: second.length, second, ids, hasNav };
}


/**
 * 统计「并行类名空间」—— astryx 的教训
 *
 * Astryx README L35：**"Customize without wrapping. A theme is a set of CSS custom
 * property overrides."**
 *
 * 我们做的正是反面：另起一套 `.vouch-*` 类名，等于在宿主设计系统旁边再搭一层。
 * 那不是「定制」，那是「包一层」—— 也正是用户说的「两份产品硬拼」。
 */
export function countParallelClasses(scssTexts, hostPrefix = 'openbitnum') {
  const out = [];
  for (const [file, text] of Object.entries(scssTexts || {})) {
    const classes = [...String(text).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    const custom = classes.filter((c) => !c.startsWith('openbitfun') && /^[a-z][\w]*-/.test(c));
    if (custom.length) {
      const byPrefix = {};
      for (const c of custom) {
        const pre = c.split('-')[0];
        byPrefix[pre] = (byPrefix[pre] || 0) + 1;
      }
      out.push({ file, total: classes.length, foreign: custom.length, byPrefix });
    }
  }
  return out;
}

/** 在 app 目录里找导航层痕迹 */
export function detectNavLayer(root, readDirFn, readFileFn) {
  const NEEDLES = ['neuron', 'Neuron', '神经元', 'constellation', '星图'];
  let found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let ents;
    try { ents = readDirFn(dir); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/node_modules|[\\/]\.git/.test(p)) continue;
        walk(p, depth + 1);
      } else if (/\.(tsx?|scss)$/.test(e.name)) {
        let t = '';
        try { t = readFileFn(p); } catch { continue; }
        if (NEEDLES.some((n) => t.includes(n))) found.push(path.relative(root, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  return found;
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const SRC_OK = "id: 'session' as SceneTabId,\nid: 'terminal' as SceneTabId,\nid: 'git' as SceneTabId,";
  const SRC_STAPLED = SRC_OK + "\nid: 'vouch-verify' as SceneTabId,\nid: 'vouch-overview' as SceneTabId,";

  // ── 反例 1（核心）：无导航层 + 第二套前缀 ⇒ 必须判 FAIL ──
  const r1 = auditIA(SRC_STAPLED, false);
  T('反例 · 无导航层 + 有 vouch-* 场景 ⇒ FAIL（两份产品硬拼）', r1.state === 'FAIL', JSON.stringify(r1.state));
  T('反例 · FAIL 时必须报出第二套场景的数量', r1.secondCount === 2, 'second=' + r1.secondCount);

  // ── 反例 2：无导航层但只有一套 ⇒ WARN（不是 FAIL，也不许 PASS）──
  const r2 = auditIA(SRC_OK, false);
  T('反例 · 无导航层但只有一套 ⇒ WARN（不许 PASS）', r2.state === 'WARN', JSON.stringify(r2.state));

  // ── 反例 3：有导航层 + 第二套 ≤1 ⇒ PASS ──
  const r3 = auditIA(SRC_OK, true);
  T('正例 · 有导航层 + 无第二套 ⇒ PASS', r3.state === 'PASS', JSON.stringify(r3.state));

  // ── 反例 4：读不到场景 ⇒ UNKNOWN，不许当 PASS ──
  const r4 = auditIA('', true);
  T('反例 · 读不到场景 ⇒ UNKNOWN（不许当 PASS）', r4.state === 'UNKNOWN', JSON.stringify(r4.state));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  界面 IA 审计 · 自检（1 正例 + 4 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (!fs.existsSync(REGISTRY)) {
  console.log('  ❔ 读不到场景注册表：' + path.relative(REPO, REGISTRY));
  process.exit(2);
}
const src = fs.readFileSync(REGISTRY, 'utf8');
const nav = detectNavLayer(APP, (d) => fs.readdirSync(d, { withFileTypes: true }), (p) => fs.readFileSync(p, 'utf8'));
const r = auditIA(src, nav.length > 0);

console.log('');
console.log('  界面 IA 审计 —— 「像两份产品硬拼」的可测量版本');
console.log('  ' + '='.repeat(76));
console.log('  顶层 tab 场景        ' + r.sceneCount);
console.log('  其中第二套前缀(vouch-) ' + r.secondCount + (r.second.length ? '  → ' + r.second.join(', ') : ''));
console.log('  导航层痕迹文件        ' + nav.length + (nav.length ? '  → ' + nav.slice(0, 5).join(', ') : ''));
console.log('  ' + '─'.repeat(76));
console.log('  四态: ' + r.state + ' —— ' + r.why);
console.log('');
// ── 并行类名空间（astryx：定制靠 token 覆盖，不是另起一层类名）──
{
  const scss = {};
  const base = path.join(APP, 'scenes/vouch');
  if (fs.existsSync(base)) {
    for (const f of fs.readdirSync(base)) {
      if (f.endsWith('.scss')) scss['scenes/vouch/' + f] = fs.readFileSync(path.join(base, f), 'utf8');
    }
  }
  const par = countParallelClasses(scss);
  console.log('  并行类名空间（非宿主前缀的自定义类名）');
  if (!par.length) console.log('    （无）');
  for (const p of par) {
    const detail = Object.entries(p.byPrefix).map(([k, v]) => k + '×' + v).join(' ');
    console.log('    ' + p.file + '  外来 ' + p.foreign + '/' + p.total + '  ' + detail);
  }
  console.log('');
}

console.log('  参照：方案/91-场景构建设计.md:220 「神经元不是场景，是场景的导航层」');
console.log('        方案/66-自我进化机制与中枢化.md:176 「去掉场景标签栏」');
console.log('');
process.exit(r.state === 'PASS' ? 0 : r.state === 'WARN' ? 3 : r.state === 'FAIL' ? 1 : 2);
