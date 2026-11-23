/**
 * 记忆交接 CLI —— 把 memory-guard 的库能力包成可执行命令
 *
 * 为什么需要：
 *   原项目的记忆机制核心动作是「交接」：收工/换会话前，先把进度覆盖写进 §〇。
 *   我们实现了 memory-guard.mjs（量体量、归档），但没有「交接」这个入口，
 *   所以 §〇 里的"上次交接"永远是"（新场景，还没有交接记录）"。
 *
 * 本 CLI 提供：
 *   handoff  --scene <中文场景名> --done "上次做了什么" --next "下一步" [--block "卡点"]
 *   measure  --scene <名>               量体量并显示与红线的差
 *   archive  --scene <名>               把旧分节搬进 归档/（先快照再搬，可验证）
 *   check    --scene <名>               校验是否超红线
 *   checkall                            全部场景体检
 *
 * 存储：workbench/引擎数据/.dsh/场景记忆/<场景>/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, check, archive, verifyArchive, splitSections, LIMITS } from './memory-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', 'workbench');
const MEM = path.join(WB, '引擎数据', '.dsh', '场景记忆');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const today = () => now().slice(0, 10);

/** 找场景目录（支持中文名与 id 两种写法） */
function resolveSceneDir(name) {
  if (!name) throw new Error('需要 --scene');
  const direct = path.join(MEM, name);
  if (fs.existsSync(direct)) return direct;
  // 按场景 json 的 id 反查中文名
  const scDir = path.join(WB, '外壳', 'scenarios');
  if (fs.existsSync(scDir)) {
    for (const f of fs.readdirSync(scDir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(scDir, f), 'utf8'));
        if (j.id === name && fs.existsSync(path.join(MEM, j.name))) {
          return path.join(MEM, j.name);
        }
      } catch { /* ignore */ }
    }
  }
  throw new Error('找不到场景目录：' + name);
}

function memFile(dir) {
  return path.join(dir, '场景私有记忆.md');
}

/**
 * 交接：覆盖写 §〇 五小节。
 * 这是记忆机制里最核心的动作 —— 收工/换会话前必须做。
 */
function handoff(dir, opts) {
  const f = memFile(dir);
  if (!fs.existsSync(f)) throw new Error('场景私有记忆.md 不存在：' + f);

  const raw = fs.readFileSync(f, 'utf8');
  const normalized = raw.replace(/\r\n?/g, '\n');

  // 找到 §〇 段的起止
  const sections = splitSections(normalized);
  const hoIdx = sections.findIndex(s => s.title.includes('当前交接'));
  if (hoIdx < 0) throw new Error('找不到「当前交接」段，请先 init');

  const newHandoffBody = [
    '## §〇 当前交接',
    '',
    '### 1) 上次交接',
    '- ' + (opts.done || '（未填）') + '  ·  ' + now(),
    '',
    '### 2) 当前项目',
    '| 项目 | 记忆文件 | 状态 | 下一步 |',
    '|---|---|---|---|',
    '| ' + (opts.project || '无') + ' | ' + (opts.projectFile || '—') + ' | ' + (opts.projectStatus || '—') + ' | ' + (opts.next || '—') + ' |',
    '',
    '### 3) 私有记忆变更',
    '- ' + today() + '：' + (opts.changed || '交接更新（无结构变更）'),
    '',
    '### 4) 下一步 / 卡点',
    '- 下一步：' + (opts.next || '（未填）'),
    '- 卡点：' + (opts.block || '（无）'),
    '',
    '### 5) 全貌',
    '- 项目记忆 ' + (countProjects(dir) + 0) + ' 个 · 归档 ' + (countArchives(dir) + 1) + ' 份',
    '',
  ].join('\n');

  // 先备份（原项目的规矩：先快照，再动手）
  const bakDir = path.join(dir, '归档');
  fs.mkdirSync(bakDir, { recursive: true });
  const bak = path.join(bakDir, '场景私有记忆-' + now().replace(/[: ]/g, '-') + '.md');
  fs.copyFileSync(f, bak);

  // 替换 §〇 段（它之后到下一个 ## 之前的内容都替换掉）
  const lines = normalized.split('\n');
  const startLine = (() => {
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+.*当前交接/.test(lines[i])) return i;
    }
    return -1;
  })();
  if (startLine < 0) throw new Error('找不到 §〇 标题行');

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { endLine = i; break; }
  }

  const out = [
    ...lines.slice(0, startLine),
    ...newHandoffBody.split('\n'),
    ...lines.slice(endLine),
  ].join('\n');

  fs.writeFileSync(f, out, 'utf8');
  return { file: f, backup: bak, size: Buffer.byteLength(out) };
}

function countProjects(dir) {
  const p = path.join(dir, '项目记忆');
  if (!fs.existsSync(p)) return 0;
  return fs.readdirSync(p).filter(f => f.endsWith('.md')).length;
}

function countArchives(dir) {
  const p = path.join(dir, '归档');
  if (!fs.existsSync(p)) return 0;
  return fs.readdirSync(p).filter(f => f.endsWith('.md')).length;
}

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : ''; };

try {
  if (cmd === 'handoff') {
    const dir = resolveSceneDir(val('--scene'));
    const r = handoff(dir, {
      done: val('--done'),
      next: val('--next'),
      block: val('--block'),
      changed: val('--changed'),
      project: val('--project'),
      projectFile: val('--project-file'),
      projectStatus: val('--project-status'),
    });
    console.log(C.green + 'OK' + C.reset + ' 已交接：' + path.basename(dir));
    console.log('   ' + (Buffer.byteLength(r.file) ? (r.size / 1024).toFixed(1) : 0) + ' KB');
    console.log('   ' + C.dim + '快照：' + path.relative(WB, r.backup) + C.reset);

    const m = measure(r.file);
    const over = (m.bytes || 0) > LIMITS.mainBytes;
    const ho = ((m.handoff && m.handoff.bytes) || 0) > LIMITS.handoffBytes;
    console.log('   主文件 ' + ((m.bytes || 0) / 1024).toFixed(1) + ' KB' + (over ? C.red + ' ⚠ 超 25KB' + C.reset : C.green + ' ✓' + C.reset));
    console.log('   §〇  ' + (((m.handoff && m.handoff.bytes) || 0) / 1024).toFixed(1) + ' KB' + (ho ? C.red + ' ⚠ 超 4KB' + C.reset : C.green + ' ✓' + C.reset));
    process.exit(0);
  }

  if (cmd === 'measure') {
    const dir = resolveSceneDir(val('--scene'));
    const m = measure(memFile(dir));
    console.log(C.bold + path.basename(dir) + C.reset);
    console.log('  主文件  ' + ((m.bytes || 0) / 1024).toFixed(1) + ' KB / ' + (LIMITS.mainBytes / 1024) + ' KB');
    console.log('  §〇     ' + (((m.handoff && m.handoff.bytes) || 0) / 1024).toFixed(1) + ' KB / ' + (LIMITS.handoffBytes / 1024) + ' KB');
    if (m.sections) {
      console.log('  分节：');
      for (const s of m.sections) {
        console.log('    ' + (s.title || '(无题)').padEnd(24) + (s.bytes / 1024).toFixed(1) + ' KB');
      }
    }
    process.exit(0);
  }

  if (cmd === 'check') {
    const dir = resolveSceneDir(val('--scene'));
    const r = check(memFile(dir));
    if (r.ok) {
      console.log(C.green + 'OK' + C.reset + ' ' + path.basename(dir) + ' 通过');
    } else {
      console.log(C.red + 'X ' + C.reset + path.basename(dir));
      for (const p of r.problems || []) console.log('   · ' + p);
      process.exit(2);
    }
    process.exit(0);
  }

  if (cmd === 'checkall') {
    if (!fs.existsSync(MEM)) { console.log('记忆目录不存在'); process.exit(1); }
    const dirs = fs.readdirSync(MEM)
      .filter(d => d !== '_共享记忆' && fs.statSync(path.join(MEM, d)).isDirectory());
    let bad = 0;
    console.log(C.bold + '全部场景记忆体检' + C.reset);
    for (const d of dirs) {
      const f = memFile(path.join(MEM, d));
      if (!fs.existsSync(f)) { console.log('  ' + C.red + 'X' + C.reset + ' ' + d + '  无记忆文件'); bad++; continue; }
      const r = check(f);
      if (r.ok) {
        const m = measure(f);
        console.log('  ' + C.green + 'OK' + C.reset + ' ' + d.padEnd(10) +
          ((m.bytes || 0) / 1024).toFixed(1).padStart(5) + ' KB   §〇 ' +
          (((m.handoff && m.handoff.bytes) || 0) / 1024).toFixed(1) + ' KB');
      } else {
        bad++;
        console.log('  ' + C.red + 'X ' + C.reset + d);
        for (const p of r.problems || []) console.log('      · ' + p);
      }
    }
    process.exit(bad > 0 ? 2 : 0);
  }

  if (cmd === 'archive') {
    const dir = resolveSceneDir(val('--scene'));
    // 先快照（memory-guard 的 archive 内部已做）
    const r = archive(memFile(dir), { keepLatest: 1 });
    console.log(C.green + 'OK' + C.reset + ' 已归档 ' + path.basename(dir));
    console.log('   ' + JSON.stringify(r).slice(0, 300));
    // 归档后必须能证明没丢
    if (typeof verifyArchive === 'function') {
      const v = verifyArchive(memFile(dir), r);
      console.log('   ' + (v.ok ? C.green + '✓ 核对通过（未丢内容）' + C.reset : C.red + '✗ 核对失败：' + JSON.stringify(v) + C.reset));
    }
    process.exit(0);
  }

  console.log('记忆交接 CLI');
  console.log('');
  console.log('  handoff --scene <名或id> --done "..." --next "..." [--block "..."] [--project "..."]');
  console.log('  measure --scene <名或id>    量体量');
  console.log('  check   --scene <名或id>    校验红线');
  console.log('  checkall                    全部体检');
  console.log('  archive --scene <名或id>    归档旧分节');
  process.exit(0);

} catch (e) {
  console.error(C.red + 'ERROR ' + C.reset + (e && e.message));
  process.exit(1);
}
