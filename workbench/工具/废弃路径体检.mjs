#!/usr/bin/env node
// 工具/废弃路径体检.mjs —— 目录迁移后，代码里还有没有指向旧位置的地方
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（真实事故，出现了三次）
// ══════════════════════════════════════════════════════════════════════
//  第 14 轮做了「场景工作目录迁移（方案 A）」：
//     旧：数据/.dsh/场景注入/<sceneId>/AGENTS.local.md
//     新：数据/.dsh/场景记忆/<场景名>/AGENTS.local.md   （= 会话 cwd）
//
//  但迁移后有三处代码还在指向旧目录：
//
//   ① 中枢调度卡哨兵.mjs   —— 测旧文件 2223B → INV-1 体积永远通过
//                             而真实文件 3212B，超预算 115%
//   ② 破坏性验证.mjs       —— 破坏写旧文件、哨兵读新文件 → 判「装饰」
//   ③ 切换provider.mjs     —— 用旧目录建验证会话，污染废弃目录
//   ④ 场地地图.mjs         —— 归属规则还写着旧路径
//
//  其中 ①+② 互相掩护：哨兵测错文件所以永远绿，
//  破坏性验证改错文件所以判不出它是装饰 —— 一个 43% 超标的 prompt 活了十几轮。
//
//  这个工具全局搜「已知废弃路径」，防止同类问题再发生。
//
//  用法：
//    node 工具/废弃路径体检.mjs
//    node 工具/废弃路径体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 已知的废弃路径模式
 *
 * ⚠ 每次做目录迁移，必须在这里加一条，然后跑一遍。
 *    format: { re, desc, allow? }  allow 是允许出现的文件（工具自己）
 */
export const DEPRECATED = [
  {
    re: /数据[/\\]\.dsh[/\\]场景注入[/\\]/g,
    desc: '旧场景注入目录（第 14 轮迁移到 场景记忆/<场景名>/）',
  },
  {
    re: /['"]场景注入['"]\s*,\s*['"]hub['"]/g,
    desc: '旧 hub 注入目录',
  },
  {
    re: /['"]场景注入['"]\s*,\s*['"]arch-review['"]/g,
    desc: '旧场景注入子目录',
  },
  {
    re: /['"]场景注入['"]\s*,\s*['"]build-plan['"]/g,
    desc: '旧场景注入子目录',
  },
  {
    re: /['"]场景注入['"]\s*,\s*['"]research['"]/g,
    desc: '旧场景注入子目录',
  },
];

/** 免检文件（这个工具自己 + 文档体检里说明性的引用） */
export const EXEMPT_FILES = ['废弃路径体检.mjs'];

/**
 * 检查一段源码里有没有废弃路径
 * @param {string} src
 * @returns {Array<{line:number, text:string, desc:string}>}
 */
export function findDeprecated(src) {
  const out = [];
  const lines = String(src).split('\n');
  for (const dep of DEPRECATED) {
    // 每次重置 lastIndex（re 是 /g）
    const re = new RegExp(dep.re.source, dep.re.flags);
    let m;
    while ((m = re.exec(src)) !== null) {
      const lineNo = src.slice(0, m.index).split('\n').length;
      const lineText = (lines[lineNo - 1] || '').trim();
      // 跳过注释行和字符串里的「说明」——但只跳过以 // 或 * 开头的整行注释
      if (/^(\/\/|\*)/.test(lineText)) continue;
      out.push({ line: lineNo, text: lineText.slice(0, 100), desc: dep.desc });
      if (re.lastIndex === m.index) re.lastIndex++;   // 防死循环
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  废弃路径体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】能抓到旧的 场景注入 路径');
  {
    const bad = "const p = path.join(DATA, '场景注入', 'hub', 'AGENTS.local.md');";
    const hit = findDeprecated(bad);
    chk('抓到 path.join 形式', hit.length > 0, JSON.stringify(hit.map((x) => x.line)));
    chk('行号正确', hit.length > 0 && hit[0].line === 1, String(hit[0] && hit[0].line));
  }

  console.log();
  console.log('【二】能抓到斜杠形式的路径');
  {
    const bad = "const cwd = 'workbench/数据/.dsh/场景注入/arch-review';";
    const hit = findDeprecated(bad);
    chk('抓到斜杠形式', hit.length > 0, String(hit.length));
  }

  console.log();
  console.log('【三】正例：新路径不能误报');
  {
    const good = "const p = path.join(DATA, '场景记忆', '中枢', 'AGENTS.local.md');";
    const hit = findDeprecated(good);
    chk('新路径不误报', hit.length === 0, JSON.stringify(hit));
  }

  console.log();
  console.log('【四】反例：注释行豁免（不能因为说明性文字就报）');
  {
    const comment = "// 原来：path.join(DATA, '场景注入', 'hub', 'AGENTS.local.md')";
    const hit = findDeprecated(comment);
    chk('反例：整行注释豁免', hit.length === 0, JSON.stringify(hit));
  }

  console.log();
  console.log('【五】反例：真代码行必须报（即使同一行有注释）');
  {
    const mixed = "const p = path.join(DATA, '场景注入', 'hub');  // 这是错的";
    const hit = findDeprecated(mixed);
    chk('反例：代码行必须报', hit.length > 0, String(hit.length));
  }

  console.log();
  console.log('【六】反例：判据不能恒真（新代码也要能通过）');
  {
    const realGood = [
      "const p = path.join(WB, '数据', '.dsh', '场景记忆', '中枢', 'AGENTS.local.md');",
      "const q = path.join(MEM, '调研', '场景私有记忆.md');",
    ].join('\n');
    chk('反例：正常代码零报告', findDeprecated(realGood).length === 0);
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

  console.log('='.repeat(78));
  console.log('  废弃路径体检 —— 目录迁移后，代码里还有没有指向旧位置的地方');
  console.log('='.repeat(78));
  console.log();
  console.log('  已知废弃路径: ' + DEPRECATED.length + ' 条规则');
  for (const d of DEPRECATED) console.log('    · ' + d.desc);
  console.log();

  let total = 0;
  const bad = [];

  for (const f of fs.readdirSync(TOOLS).filter((x) => x.endsWith('.mjs'))) {
    if (EXEMPT_FILES.includes(f)) continue;
    const p = path.join(TOOLS, f);
    let src = '';
    try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const hits = findDeprecated(src);
    if (hits.length) {
      total += hits.length;
      bad.push({ file: f, hits });
    }
  }

  if (total === 0) {
    console.log('  ✓ 代码里没有废弃路径引用');
  } else {
    console.log('  XX 发现 ' + total + ' 处废弃路径引用:');
    for (const b of bad) {
      console.log();
      console.log('    ' + b.file);
      for (const h of b.hits) {
        console.log('       L' + h.line + '  [' + h.desc + ']');
        console.log('           ' + h.text);
      }
    }
    console.log();
    console.log('  修法：把这些路径改成迁移后的新位置。');
    console.log('  ⚠ 这类问题的危害：**会让检查本身失效** ——');
    console.log('     哨兵测旧文件永远通过、破坏性验证改旧文件判不出装饰。');
    process.exitCode = 1;
  }

  // 附带信息：旧目录是否还存在
  const OLD_DIR = path.join(WB, '数据', '.dsh', '场景注入');
  console.log();
  if (fs.existsSync(OLD_DIR)) {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else n++;
      }
    };
    try { walk(OLD_DIR); } catch { /* ignore */ }
    console.log('  ○ 旧目录 数据/.dsh/场景注入/ 仍存在（' + n + ' 个文件，历史遗留）');
    console.log('    代码里已无引用；可以人工确认后删除，或保留作历史快照。');
  } else {
    console.log('  ✓ 旧目录 数据/.dsh/场景注入/ 已不存在');
  }
  console.log('='.repeat(78));
}

main();
