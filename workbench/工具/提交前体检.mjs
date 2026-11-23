#!/usr/bin/env node
// 工具/提交前体检.mjs —— 提交前检查暂存区里有没有「意外的删除」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（真实事故）
// ══════════════════════════════════════════════════════════════════════
//  2026-11-12 实测：用 `git add -A` 提交一批改动，其中混进了
//  一个**意外的文件删除**：
//
//    workbench/数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md | 29 --
//
//  那个文件是竞品拆解场景的产物契约（feature-matrix），
//  被删后：
//    · 管线产物体检报「竞品拆解 → 架构梳理 [feature-matrix] 产物不在」
//    · 派单验证生成报「达标 12/13」
//    · 文档体检报「幽灵行：项目功能矩阵.md」
//
//  三个检查同时红，但根因是**一次误删**，不是三个独立问题。
//  而 `git add -A` 不会问「这个删除是你想要的吗」。
//
//  这个工具在提交前扫描暂存区，把「删除」明确列出来要求确认。
//
//  用法：
//    node 工具/提交前体检.mjs          # 看暂存区有没有删除
//    node 工具/提交前体检.mjs --allow  # 允许删除（明确知道自己在删什么）
//    node 工具/提交前体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
// 复用破坏性验证里的基线判据（同一事实只存一处）
import { checkSourceBaseline, autofixSourceBaseline } from './破坏性验证.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 允许删除的路径模式（明确知道在删的）
 * 用正则，匹配相对 ROOT 的路径
 */
export const ALLOWED_DELETE_PATTERNS = [
  /^prototype\//,                    // 临时脚本
  /^workbench\/prototype\//,         // 临时脚本
  /^workbench\/工具\/zz_/,           // 破坏性验证探针
  /^workbench\/备份\//,              // 旧备份（由备份工具管理）
  /^workbench\/数据\/\.dsh\/体检历史\//,  // 历史记录会轮转
  // ⚠ 2026-11-12 加：破坏性验证的跑前快照是**运行产物**，不该入版本控制。
  //   实测误报：把快照目录加进 .gitignore 后，git rm --cached 产生的
  //            「删除」被本工具拦下（115 个文件）。
  //   它们不是数据丢失，是「从版本控制里移除运行产物」。
  /^workbench\/数据\/\.dsh\/破坏性验证快照\//,
  // ⚠ 2026-11-12 加：运行时数据从版本控制里移除
  //
  //   实测：47 个运行时会话文件 + 31 个 storages 缓存被 git 跟踪，
  //   而 .gitignore 只排除了 引擎数据/ 下的（那是源码副本，不是运行时）。
  //
  //   做过 git rm --cached 之后，本工具报「可疑的删除 119 个」——
  //   但它们不是数据丢失，是「把可再生的运行时数据从版本控制里摘出来」。
  //
  //   判据（.gitignore 开头写的）：删掉它能不能 5 分钟内从源头恢复？
  //     · sessions/  —— 能（新会话 5 秒建好）
  //     · storages/  —— 能（引擎重新生成）
  //     · 外壳/data/ —— 能（Electron 重新生成 profile）
  /^workbench\/数据\/\.dsh\/sessions\//,
  /^workbench\/数据\/\.dsh\/storages\//,
  /^workbench\/数据\/\.dsh-temp\//,
  /^workbench\/外壳\/data\//,
  // ⚠ 2026-11-13 加：UI 锁文件是运行产物
  //
  //   `_ui-lock.mjs` 用 .ui-lock.json 做跨进程互斥锁，进程退出就该删掉。
  //   它曾被 git 跟踪（历史遗留），清理时显示成「删除」，被本工具判为可疑。
  //
  //   判据：删掉能不能 5 分钟内恢复？能 —— 它是临时锁，不存在更好。
  /^workbench\/数据\/\.dsh\/\.ui-lock\.json$/,
  // ⚠ 2026-11-13 加：破坏性验证的临时场景目录
  //
  //   破坏性验证跑「场景记忆相关」用例时，会把场景目录复制/改名到
  //     _zz_brk_<用例名>_<pid>/
  //   跑完按理该删。但进程被中断时删除不跑 → 目录留在原地。
  //
  //   实测：一个 03:53 留下的残留进了 git 索引（24 个文件），
  //   下午清理时被本工具判为「可疑的删除 22 个」。
  //
  //   判据（.gitignore 开头写的）：删掉它能不能 5 分钟内从源头恢复？
  //     能 —— 它是真实场景记忆的**副本**，删了不影响任何真实数据。
  //     已核实：清理后 中枢/实施计划 各有 12 个文件，比残留副本还多。
  /^workbench\/数据\/\.dsh\/_zz_brk_[^/]+\//,
];

/**
 * 判一个待删除路径是否属于「明确允许删除」
 * @param {string} relPath 相对仓库根
 * @returns {boolean}
 */
export function isAllowedDelete(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  return ALLOWED_DELETE_PATTERNS.some((re) => re.test(p));
}

// ══════════════════════════════════════════════════════════════════════
//  源文件判据基线（2026-11-12 新增，真实事故驱动）
//
//  事故：破坏性验证的「派单闭环」用例把 派单.mjs 的
//        MIN_EVIDENCE_LEN 从 20 改成 1 制造破坏；
//        那次运行被中断，restore 没跑 → 文件永久停在 1；
//        然后 `git add -A` 把这个损坏状态提交进了 git。
//
//  后果：派单.mjs 接受「好了」这种空话回执，连续几天没人发现。
//
//  教训：`git add -A` 不只提交「我想要的改动」，
//        它提交**工作区的当前状态**——包括被中途打断的临时修改。
//        所以提交前必须校验关键判据常量是否在预期值上。
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  console.log('='.repeat(78));
  console.log('  提交前体检 —— 暂存区里有没有「意外的删除」或「被改坏的判据」');
  console.log('='.repeat(78));
  console.log();

  let ok = true;

  // ① 源文件判据基线
  console.log('  ① 源文件判据基线（防止中断的破坏性验证被提交）');
  let base = checkSourceBaseline();
  if (!base.ok) {
    // ⚠ 2026-11-12 加自动修复：这些值只在被 break() 改成特定值时才会变，
    //   所以「当前值 = 已知损坏值」就足以判定是损坏，不是正常改动。
    //   反复手工修了几次还是会再发生（机制体检 600s 超时被 kill 时 restore 不跑），
    //   所以改成自动修 + 明确打印改了什么。用 --no-autofix 可关闭。
    if (!has('no-autofix')) {
      const fix = autofixSourceBaseline();
      if (fix.fixed.length) {
        console.log('     ⚠ 发现已知损坏值，已自动修复：');
        for (const f of fix.fixed) console.log('        · ' + f);
        base = checkSourceBaseline();
      }
      if (fix.problems.length) {
        for (const p of fix.problems) console.log('     XX ' + p);
      }
    }
  }
  if (base.ok) {
    console.log('     ✓ 关键判据常量都在预期值上');
  } else {
    for (const p of base.problems) console.log('     XX ' + p);
    console.log();
    console.log('     恢复：git diff -- workbench/工具/  然后手动改回');
    ok = false;
  }
  console.log();

  // ② 暂存区删除
  console.log('  ② 暂存区删除');
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-status', '--diff-filter=D'], {
      encoding: 'utf8', cwd: ROOT, timeout: 30000, windowsHide: true,
    });
  } catch (e) {
    console.log('     ✗ git 查询失败: ' + ((e && e.message) || e));
    process.exitCode = 1;
    return;
  }

  const deleted = parseDeleted(out);
  if (!deleted.length) {
    console.log('     ✓ 暂存区里没有删除');
  } else {
    const { allowed, suspicious } = judgeDeletions(deleted);
    if (allowed.length) {
      console.log('     ○ 允许的删除（临时文件/探针/旧备份）: ' + allowed.length);
      for (const a of allowed) console.log('         · ' + a);
    }
    if (suspicious.length) {
      console.log('     ⚠ 可疑的删除: ' + suspicious.length);
      for (const s of suspicious) console.log('         · ' + s);
      console.log();
      console.log('     确认要删就加 --allow：node 工具/提交前体检.mjs --allow');
      console.log('     想恢复：git checkout HEAD -- <路径>');
      if (!has('allow')) ok = false;
      else console.log('     （已用 --allow 确认）');
    }
  }
  console.log();

  console.log('='.repeat(78));
  if (!ok) process.exitCode = 1;
}

/**
 * 从 `git diff --cached --name-status --diff-filter=D` 的输出里解析删除清单
 * @param {string} out
 * @returns {string[]}
 */
export function parseDeleted(out) {
  return String(out || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('D'))
    .map((l) => l.replace(/^D\s+/, ''))
    .filter(Boolean);
}

/**
 * 判删除清单里哪些是「意外的」
 * @param {string[]} deleted
 * @returns {{allowed: string[], suspicious: string[]}}
 */
export function judgeDeletions(deleted) {
  const allowed = [];
  const suspicious = [];
  for (const d of deleted) {
    if (isAllowedDelete(d)) allowed.push(d);
    else suspicious.push(d);
  }
  return { allowed, suspicious };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  提交前体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】解析 git 输出');
  {
    const out = 'D\tworkbench/数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md\n' +
      'M\tworkbench/工具/机制体检.mjs\n' +
      'A\tworkbench/工具/新工具.mjs\n';
    const dels = parseDeleted(out);
    chk('只解析出 D 行', dels.length === 1, JSON.stringify(dels));
    chk('路径正确', dels[0] === 'workbench/数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md', dels[0]);
    chk('空输出返回空数组', parseDeleted('').length === 0);
  }

  console.log();
  console.log('【二】分类：允许 vs 可疑');
  {
    const dels = [
      'prototype/tmp.cjs',                                  // 允许
      'workbench/工具/zz_probe.mjs',                        // 允许
      'workbench/数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md',  // 可疑（真实事故）
      'workbench/工具/机制体检.mjs',                        // 可疑
    ];
    const j = judgeDeletions(dels);
    chk('允许清单 2 条', j.allowed.length === 2, j.allowed.join(', '));
    chk('可疑清单 2 条', j.suspicious.length === 2, j.suspicious.join(', '));
    chk('产物契约被列为可疑',
      j.suspicious.includes('workbench/数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md'),
      '这条守着真实事故');
  }

  console.log();
  console.log('【三】反例：真实事故里的那个路径必须被判可疑');
  {
    // 这条反例直接对应 2026-11-12 误删 项目功能矩阵.md 的事故
    const realCase = 'workbench/数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md';
    chk('反例：产物契约文件被删必须判可疑', isAllowedDelete(realCase) === false,
      isAllowedDelete(realCase) ? '被误判为允许（判据太松）' : '正确判为可疑');
  }

  console.log();
  console.log('【四】反例：判据不能全放行（什么都允许等于没检查）');
  {
    const tricky = [
      'workbench/数据/.dsh/场景记忆/调研/场景私有记忆.md',
      'workbench/外壳/scenarios/research.json',
      'workbench/工具/派单.mjs',
    ];
    const anyAllowed = tricky.filter((x) => isAllowedDelete(x));
    chk('反例：核心数据/配置/工具被删必须都判可疑', anyAllowed.length === 0,
      anyAllowed.length ? '被放行: ' + anyAllowed.join(', ') : '全部判可疑');
  }

  console.log();
  console.log('【五】反例：也不能全拒（临时文件该能删）');
  {
    const shouldAllow = ['prototype/a.cjs', 'workbench/工具/zz_x.mjs'];
    const rejected = shouldAllow.filter((x) => !isAllowedDelete(x));
    chk('反例：临时文件必须允许删除', rejected.length === 0,
      rejected.length ? '被误拒: ' + rejected.join(', ') : '正确允许');
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
main();
