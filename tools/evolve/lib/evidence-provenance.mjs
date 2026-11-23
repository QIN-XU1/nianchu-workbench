/**
 * 证据溯源判定（共用）—— audit 工具与 fair-compare 都用这一份，避免两套标准。
 *
 * 定义（保守）：
 *   REAL —— 证据里至少有一个路径能在 D:/refs/<id>（或其回退目录）下找到真实文件
 *   OWN  —— 只引用我们自己的分析文档，或路径找不到
 *   NONE —— 没有证据文本
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const REFS = 'D:/refs';

export const OWN_DOCS = [
  'three.md', 'new3.md', 'orca.md', 'hermes-ecc.md', 'omp-aion.md', 'dsh-openclaw.md',
  'cl4r1t4s.md', 'pi.md', 'pi-main.md', 'aionui.md', 'weknora.md', 'ecc.md',
];

export const SOURCE_ROOTS = {
  openbitfun: ['openbitfun.git', 'openbitfun-src'],
  dsh: ['dsh.git', 'deepseek-harness'],
  openclaw: ['openclaw.git', 'openclaw'],
  ecc: ['ecc.git', 'ECC'],
  hermes: ['hermes.git'],
  'open-design': ['open-design.git', 'open-design'],
  'omp-studio': ['omp-studio.git', 'omp-studio'],
  orca: ['orca.git', 'orca'],
  pi: ['pi.git', 'pi-main'],
  luanyujia: ['luanyujia.git', 'luanyujia-fresh'],
  'craft-anything': ['craft-anything.git', 'craft-anything'],
  'solo-to-team-skills': ['solo-to-team-skills.git', 'solo-to-team-skills'],
  cl4r1t4s: ['cl4r1t4s.git', 'CL4R1T4S'],
  aionui: ['aionui.git', 'aionui'],
  weknora: ['weknora.git', 'WeKnora'],
  // 第 132 轮补：目标要求 29 个参照项目，此前矩阵只有 22 个
  metagpt: ['metagpt'],
  openhands: ['openhands'],
  dify: ['dify'],
  ragflow: ['ragflow'],
  nocobase: ['nocobase'],
  'career-ops': ['career-ops'],
  cowagent: ['cowagent'],
  'agent-reach': ['agent-reach'],
  'toonflow-app': ['Toonflow-app'],
  yuxi: ['Yuxi'],
};

/**
 * 展开「外层目录 + 实际内容在子目录」的情况。
 *
 * 为什么需要（2026-11-20 实测发现）：
 *   多个参照项目解压后是 `<名字>-main/` 结构，例如
 *     D:/refs/WeKnora/WeKnora-main/cli/cmd/mcp/mcp.go
 *   而 rootsOf 只返回 D:/refs/WeKnora，于是 `cli/cmd/mcp/mcp.go` 拼不出真实路径，
 *   一切证据都被判成 OWN —— 这不是「证据二手」，是**根目录解析错了**。
 *
 * 保守条件（三条全满足才纳入，避免把无关子目录当根）：
 *   ① 目录名以 `-main` / `-master` 结尾，或等于父目录名的变体；或它是唯一子目录
 *   ② 该目录下有仓库标记（.git / package.json / Cargo.toml / pyproject.toml / go.mod / README.md）
 *   ③ 深度只展开一层（不递归）
 */
const MARKERS = ['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'README.md'];

function looksLikeRepo(dir) {
  return MARKERS.some((m) => existsSync(join(dir, m)));
}

function expandNested(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  // 只展开看起来是「同一仓库的内容目录」的那一个
  const candidates = dirs.filter((n) => /-(main|master)$/i.test(n) && looksLikeRepo(join(dir, n)));
  if (candidates.length === 1) return [join(dir, candidates[0])];
  // 唯一子目录且是仓库（处理 `xxx/xxx/` 双层同名）
  if (dirs.length === 1 && looksLikeRepo(join(dir, dirs[0]))) return [join(dir, dirs[0])];
  return [];
}

export function rootsOf(id) {
  const base = (SOURCE_ROOTS[id] || []).map((d) => join(REFS, d)).filter((p) => existsSync(p));
  const out = [];
  for (const b of base) {
    out.push(b);
    out.push(...expandNested(b));
  }
  return out;
}

export function extractPaths(ev) {
  const out = new Set();
  // 路径片段可能含中文/括号（如 luanyujia 的 10-源码/会话与切换/sessions.mjs），必须一并认
  for (const m of String(ev).matchAll(/([\w\u4e00-\u9fff.\-]+(?:\/[\w\u4e00-\u9fff.\-]+)+\.[A-Za-z0-9]+)(?::\d+)?/g)) {
    out.add(m[1]);
  }
  /**
   * 根级文件名（第 125 轮补）。
   *
   * 之前正则要求「至少含一个 /」，于是 `README.md:90`、`AGENTS.md` 这类
   * **根级文件**永远抽不出来 —— 明明是可复算的证据，却被判 OWN。
   * pi 的「无内置权限系统」原文就在 README.md:90，白纸黑字，
   * 但因为路径没有斜杠，审计器一直判它「只引我方文档」。
   *
   * 修法：额外抽取「反引号包裹的裸文件名 + 可选行号」。
   * 只认反引号里的（避免把正文里的普通词当文件名），且必须带扩展名。
   */
  for (const m of String(ev).matchAll(/`([\w\u4e00-\u9fff.\-]+\.(?:md|ts|tsx|js|mjs|jsx|json|css|py|go|rs|toml|yaml|yml))(?::\d+(?:-\d+)?)?`/g)) {
    out.add(m[1]);
  }
  return [...out];
}

export function hasRealPath(id, ev) {
  const roots = rootsOf(id);
  if (roots.length === 0) return { real: false, roots: 0 };
  for (const rel of extractPaths(ev)) {
    for (const r of roots) {
      if (existsSync(join(r, rel))) return { real: true, hit: rel, roots: roots.length };
    }
  }
  return { real: false, roots: roots.length };
}

/**
 * 我方分析文档的命名特征（第 127 轮补）。
 *
 * 这些是我自己写的对标分析，存在 research/ 或 evidence/ 下，
 * **不在对方仓库里**。它们出现在证据里就说明该格至少部分依赖我方转述。
 */
const OUR_DOC_RE = /^(dsh-openclaw|hermes-ecc|openbitfun|omp-aion|three|new3|vs-[\w-]+|luanyujia-[\w-]+|aionui-[\w-]+|orca-[\w-]+|weknora-[\w-]+|craft-[\w-]+|solo-[\w-]+|pi-[\w-]+)[\w.-]*\.md$/;

/** 抽出证据里引用的「我方分析文档」文件名（含行号） */
export function extractOurDocs(ev) {
  const out = new Set();
  const s = String(ev);
  // 带路径的 .md
  for (const m of s.matchAll(/([\w\u4e00-\u9fff.\-/]+\.md)(?::\d+(?:-\d+)?)?/g)) {
    const base = m[1].split('/').pop();
    if (OUR_DOC_RE.test(base)) out.add(m[0]);
  }
  // 裸文件名（反引号里）
  for (const m of s.matchAll(/`([\w\u4e00-\u9fff.\-]+\.md)(?::\d+(?:-\d+)?)?`/g)) {
    const base = m[1].split('/').pop();
    if (OUR_DOC_RE.test(base)) out.add(m[0].replace(/`/g, ''));
  }
  // 无扩展名但明显是我方文档的（如 `three.md:926` 已被上面覆盖；这里兜底 `new3.md:517` 形式）
  for (const m of s.matchAll(/\b((?:three|new3|omp-aion|dsh-openclaw|hermes-ecc|openbitfun)\.md)(?::\d+(?:-\d+)?)?/g)) {
    out.add(m[0]);
  }
  return [...out];
}

/**
 * 返回 'REAL' | 'OWN' | 'NONE' | 'MIXED'
 *
 * ══ 为什么加 MIXED（第 127 轮）══════════════════════════════════════
 * 之前只要**有一个**路径能 join 就判 REAL。于是这种证据被判 REAL：
 *   「`src/a.ts:1`（对方源码）+ `three.md:926`（我方分析）」
 * 实际上它是**部分依赖我方转述**，不该和「纯对方源码」等同。
 *
 * 实测：387 个 REAL 格里 **147 格（38%）** 混着我方文档引用。
 * 这是个系统性高估 —— 把「一半硬一半软」的证据算成了「全硬」。
 *
 * 现在：有对方真实路径 + 也引了我方文档 → MIXED（半硬）
 *       有对方真实路径 + 无我方文档       → REAL（全硬）
 *       无对方真实路径                     → OWN
 */
export function classifyEvidence(id, ev) {
  if (!ev || !String(ev).trim()) return 'NONE';
  const real = hasRealPath(id, ev).real;
  const ourDocs = extractOurDocs(ev);
  if (real) return ourDocs.length > 0 ? 'MIXED' : 'REAL';
  return 'OWN';
}

/** 该对手是否有可用源码（没有就只能 UNKNOWN，不该参与「谁赢」） */
export function hasSource(id) {
  return rootsOf(id).length > 0;
}
