#!/usr/bin/env node
/**
 * 记忆哨兵 —— 检查记忆体量红线
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量（BRIEF 风格，可判定）
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  bound(注入层)         AGENTS.md ≤ 2048 字节
 *  INV-2  bound(§〇交接)        每个场景 §〇 段 ≤ 4096 字节
 *  INV-3  bound(私有记忆主文件)  每个场景私有记忆 ≤ 25600 字节
 *  INV-4  no-duplicate          §〇 里只能有 1 个"上次交接"（多份 = 没覆盖写）
 *  INV-5  required-field        §〇 四问必须齐全（我是谁/干到哪/下一步/卡在哪）
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么这些红线是硬指标（原项目真实数据）
 * ══════════════════════════════════════════════════════════════
 *
 *  · §〇 涨到 40 KB → 没人读 → 交接形同虚设
 *  · 注入层 60 KB → 每轮多付 20k token → 一天几十轮 = 灾难
 *
 * ══════════════════════════════════════════════════════════════
 *  契约
 * ══════════════════════════════════════════════════════════════
 *
 *  运行：node 工具/记忆哨兵.mjs [<sceneId>]
 *  数据：环境变量 SEA_DATA_DIR（默认 数据/.dsh）
 *  退出：0 = 通过；1 = 有违规
 *  输出：
 *    PASS <id>: 差异集合 = 0
 *    FAIL <id>: 差异集合 = N 项
 *      - <具体项>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

// ══════════════════════════════════════════════════════════════
//  红线常量（唯一出处）
// ══════════════════════════════════════════════════════════════
export const LIMITS = {
  INJECT: 2048,        // 注入层
  HANDOFF: 4096,       // §〇 交接
  PRIVATE: 25600,      // 私有记忆主文件
};

// ══════════════════════════════════════════════════════════════
//  核心：检查函数（纯函数，可被变异测试直接调用）
// ══════════════════════════════════════════════════════════════

/**
 * @param {string} dataRoot  .dsh 目录（或测试用的临时目录）
 * @returns {{id:string, diffs:string[]}}
 */
export function check(dataRoot) {
  const diffs = [];
  const ID = 'memory-guard';

  const agentsFile = path.join(dataRoot, 'AGENTS.md');
  const memRoot = path.join(dataRoot, '场景记忆');

  // ── INV-1 注入层 ──
  if (fs.existsSync(agentsFile)) {
    const t = fs.readFileSync(agentsFile, 'utf8');
    const b = Buffer.byteLength(t, 'utf8');
    if (b > LIMITS.INJECT) {
      diffs.push(
        'AGENTS.md 注入层超限：' + b + ' 字节 > ' + LIMITS.INJECT +
        '（超出 ' + (b - LIMITS.INJECT) + ' 字节）'
      );
    }
  }

  // ── 逐场景检查 ──
  if (!fs.existsSync(memRoot)) {
    // 没有场景记忆目录不算违规（可能是空项目）
    return { id: ID, diffs };
  }

  const dirs = fs.readdirSync(memRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort();

  for (const name of dirs) {
    const file = path.join(memRoot, name, '场景私有记忆.md');
    if (!fs.existsSync(file)) continue;

    const text = fs.readFileSync(file, 'utf8');
    const totalBytes = Buffer.byteLength(text, 'utf8');

    // ── INV-3 主文件 ──
    if (totalBytes > LIMITS.PRIVATE) {
      diffs.push(
        '场景「' + name + '」私有记忆超限：' + totalBytes + ' 字节 > ' + LIMITS.PRIVATE +
        '（超出 ' + (totalBytes - LIMITS.PRIVATE) + ' 字节）'
      );
    }

    // ── 提取 §〇 段 ──
    const handoff = extractSection(text, '## §〇', '## ');
    if (handoff === null) {
      diffs.push('场景「' + name + '」缺少 §〇 当前交接段');
      continue;
    }

    const handoffBytes = Buffer.byteLength(handoff, 'utf8');

    // ── INV-2 §〇 体量 ──
    if (handoffBytes > LIMITS.HANDOFF) {
      diffs.push(
        '场景「' + name + '」§〇 超限：' + handoffBytes + ' 字节 > ' + LIMITS.HANDOFF +
        '（超出 ' + (handoffBytes - LIMITS.HANDOFF) + ' 字节）'
      );
    }

    // ── INV-4 不能有多份"上次交接"（多份 = 没覆盖写）──
    const dupCount = (handoff.match(/###\s*1\)\s*上次交接/g) || []).length;
    if (dupCount > 1) {
      diffs.push(
        '场景「' + name + '」§〇 里有 ' + dupCount + ' 份"上次交接"（应只有 1 份，覆盖写不追加）'
      );
    }

    // ── INV-5 四问齐全 ──
    const required = ['上次交接', '当前项目', '下一步', '全貌'];
    const missing = required.filter(k => !handoff.includes(k));
    if (missing.length > 0) {
      diffs.push(
        '场景「' + name + '」§〇 缺小节：' + missing.join('、')
      );
    }
  }

  return { id: ID, diffs };
}

/**
 * 提取某个 ## 标题下的内容（到下一个同级标题为止）
 */
function extractSection(text, startMarker, endMarker) {
  const i = text.indexOf(startMarker);
  if (i < 0) return null;
  const rest = text.slice(i + startMarker.length);
  // 找下一个 "## " 开头（不是 ###）
  const re = /\n## (?!#)/;
  const m = rest.match(re);
  return m ? rest.slice(0, m.index) : rest;
}

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
//
//  ⚠ 2026-11-11 补：原来没有 selftest、没有反例。
//    按参考项目判据「如果一个检查永远通过，它就不是检查，是装饰」，
//    没有反例的检查证明不了它会失败。
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  记忆哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  chk('注入层 ≤2048', LIMITS.INJECT === 2048, String(LIMITS.INJECT));
  chk('§〇 ≤4096', LIMITS.HANDOFF === 4096, String(LIMITS.HANDOFF));
  chk('主文件 ≤25600', LIMITS.PRIVATE === 25600, String(LIMITS.PRIVATE));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memguard-'));
  const memDir = path.join(tmp, '场景记忆', '测试场景');
  fs.mkdirSync(memDir, { recursive: true });

  const writeMem = (c) => fs.writeFileSync(path.join(memDir, '场景私有记忆.md'), c, 'utf8');
  const writeAgents = (c) => fs.writeFileSync(path.join(tmp, 'AGENTS.md'), c, 'utf8');
  const GOOD_MEM = "# 记忆\\n\\n## 核心职责\\n\\n- 负责：做某事\\n- 不碰：别的事\\n\\n## §〇 当前交接\\n\\n### 上次交接\\n\\n- 做完了 A\\n\\n### 当前项目\\n\\n| 项目 | 状态 |\\n|---|---|\\n| P1 | 进行中 |\\n\\n### 下一步\\n\\n- 做 B\\n\\n### 全貌\\n\\n- 3 个项目\\n\\n## 五、坑与决策\\n\\n- 2026-11-11：**某经验**\\n";

  writeAgents('# 全局须知\n\n' + 'x'.repeat(500));
  writeMem(GOOD_MEM);
  const r1 = check(tmp);
  chk('合规时通过', r1.diffs.length === 0, r1.ok ? '' : (r1.diffs || []).slice(0, 2).join(';'));

  writeAgents('# 全局\n' + 'x'.repeat(3000));
  const r2 = check(tmp);
  chk('反例：AGENTS.md 超限必须报', r2.diffs.length > 0,
      r2.ok ? '没报（检查是假的）' : ((r2.diffs || [])[0] || '').slice(0, 40));
  writeAgents('# 全局须知\n\n' + 'x'.repeat(500));

  writeMem('# 记忆\n' + 'x'.repeat(30000));
  const r3 = check(tmp);
  chk('反例：主文件超 25600 必须报', r3.diffs.length > 0,
      r3.ok ? '没报' : ((r3.diffs || [])[0] || '').slice(0, 40));

  writeMem('# 记忆\n\n## §〇 当前交接\n' + 'x'.repeat(5000) + '\n\n## 五、坑与决策\n\n- 2026-11-11：**x**\n');
  const r4 = check(tmp);
  chk('反例：§〇 超 4096 必须报', r4.diffs.length > 0,
      r4.ok ? '没报' : ((r4.diffs || [])[0] || '').slice(0, 40));

  writeMem(GOOD_MEM);
  const r5 = check(tmp);
  chk('恢复后重新通过', r5.diffs.length === 0, '');

  chk('关键：3 个反例全部被检出',
      r2.diffs.length > 0 && r3.diffs.length > 0 && r4.diffs.length > 0,
      '这是哨兵存在的唯一理由');

  fs.rmSync(tmp, { recursive: true, force: true });

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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  // 需要从 _共享记忆/索引.json 拿场景 id，但检查本身只依赖目录
  const r = check(dataRoot);
  const n = r.diffs.length;

  if (n === 0) {
    console.log('PASS ' + r.id + ': 差异集合 = 0');




    process.exit(0);
  } else {
    console.log('FAIL ' + r.id + ': 差异集合 = ' + n + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
