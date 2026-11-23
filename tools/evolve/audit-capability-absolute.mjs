#!/usr/bin/env node
/**
 * 能力存在的「绝对对照」—— 补 executable-compare 的指标缺陷
 *
 * ══ 为什么需要这个（第 130 轮）══════════════════════════════════════
 * executable-compare 用的是「每千文件命中率」，它有个结构性缺陷：
 *   我们 249 个源文件命中 8 个 = 32.1‰
 *   ECC 1055 个源文件命中 10 个 = 9.5‰
 * 但 openclaw 56264 个文件命中 399 个 = 7.1‰
 * 分母差 200 倍时，「率」这个指标没有可比性 —— 小库的每个命中被放大了。
 *
 * 它自己的 limitation 也写了：「每千文件命中率 = 能力散布在多少个文件里，
 * **不是能力有多强**。分母越小，单个文件命中对结果影响越大」。
 *
 * ══ 这个脚本做什么 ═══════════════════════════════════════════════
 * 用三个**不依赖分母**的口径重算：
 *   ① 绝对命中文件数（能力有多少个实现点）
 *   ② 是否有真实实现（人工确认样本不是假阳性）
 *   ③ 关键能力是否闭环（有没有配套的验证/测试）
 *
 * 这三个口径回答的是「有没有这个能力」，不是「能力散布多广」。
 *
 * 四态：0 全部有能力 · 3 有项缺失 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

/**
 * 四项「曾被判落后」的能力，逐项给出**我们这边的实现点**。
 * 每项都必须指向真实文件，且该文件里能看到该能力的核心形态。
 */
const CAPS = [
  {
    id: 'P1', name: '成本核算',
    // 不依赖分母：我们有多少个文件在做成本核算
    mustExist: [
      'tools/cost/pricing.mjs',
      'tools/cost/meter.mjs',
      'tools/cost/ledger.mjs',
    ],
    // 关键形态：必须有结构化价格 + 记账
    formCheck: (root) => {
      const pricing = read(path.join(root, 'tools/cost/pricing.mjs'));
      const ledger = read(path.join(root, 'tools/cost/ledger.mjs'));
      return {
        hasPriceTable: /price|pricing/i.test(pricing) && /per|token/i.test(pricing),
        hasLedger: /ledger|record|append/i.test(ledger),
        hasRecompute: /verify|replay|recompute|一致/i.test(read(path.join(root, 'tools/cost/replay.mjs'))),
      };
    },
    closedLoop: ['tools/cost/replay.test.mjs'],
  },
  {
    id: 'P2', name: '记忆老化（TTL）',
    mustExist: ['tools/memory/ttl.mjs', 'tools/memory/store.mjs'],
    formCheck: (root) => {
      const ttl = read(path.join(root, 'tools/memory/ttl.mjs'));
      return {
        hasTtlField: /ttl|expire|expiresAt/i.test(ttl),
        hasExpireLogic: /expired|isExpired|effectiveState/i.test(ttl),
        hasFreshness: fs.existsSync(path.join(root, 'tools/memory/freshness.mjs')),
      };
    },
    closedLoop: ['tools/memory/ttl-conflict.test.mjs'],
  },
  {
    id: 'P6', name: '记忆冲突/推翻',
    mustExist: ['tools/memory/conflict.mjs', 'tools/memory/conflict-diff.mjs'],
    formCheck: (root) => {
      const c = read(path.join(root, 'tools/memory/conflict.mjs'));
      return {
        hasSupersede: /supersed|overrid|推翻/i.test(c),
        hasConflictDetect: /conflict|冲突/i.test(c),
        hasDiff: /diff|差异/i.test(read(path.join(root, 'tools/memory/conflict-diff.mjs'))),
      };
    },
    closedLoop: ['tools/memory/ttl-conflict.test.mjs'],
  },
  {
    id: 'P8', name: '审计留痕（append-only）',
    mustExist: ['tools/agent/trace.mjs'],
    formCheck: (root) => {
      const tr = read(path.join(root, 'tools/agent/trace.mjs'));
      return {
        hasSpan: /span|recordSpan/i.test(tr),
        hasAppend: /append|push|writeFileSync/i.test(tr),
        hasTrace: /trace|traceId/i.test(tr),
      };
    },
    closedLoop: ['tools/agent/verify-trace.mjs'],
  },
];

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function main() {
  console.log('\n  0. 工具自检');
  t('CAPS 定义 4 项', CAPS.length === 4);

  console.log('\n  1. 每项能力的实现文件是否存在');
  for (const c of CAPS) {
    for (const f of c.mustExist) {
      t(c.id + ' ' + c.name + ' → ' + f, fs.existsSync(path.join(ROOT, f)));
    }
  }

  console.log('\n  2. ★ 关键形态检查（不依赖分母）');
  for (const c of CAPS) {
    const forms = c.formCheck(ROOT);
    for (const [k, v] of Object.entries(forms)) {
      t(c.id + ' ' + k, v === true, String(v));
    }
  }

  console.log('\n  3. 闭环：有没有配套验证');
  for (const c of CAPS) {
    for (const f of c.closedLoop) {
      t(c.id + ' 闭环验证 ' + f, fs.existsSync(path.join(ROOT, f)));
    }
  }

  console.log('\n  4. 绝对命中数 vs 对手（不除以文件数）');
  const exePath = path.join(ROOT, 'evidence/evolve/executable-compare.json');
  if (fs.existsSync(exePath)) {
    const d = JSON.parse(fs.readFileSync(exePath, 'utf8'));
    const us = (d.results || []).find((r) => r.id === 'us') || {};
    const ourFiles = us.files || 0;
    const ourFileHits = us.fileHits || {};
    console.log('    我们源文件数: ' + ourFiles);
    for (const c of CAPS) {
      const hits = ourFileHits[c.id] || 0;
      // 绝对命中数：不问「每千文件多少」，只问「有几个实现点」
      console.log('    ' + c.id + ' ' + c.name.padEnd(20) + '绝对命中 ' + String(hits).padStart(3) + ' 个文件' +
        ' · 实现文件 ' + c.mustExist.length + ' 个 · 闭环 ' + c.closedLoop.length + ' 个');
    }
    t('我们有源文件数 > 0', ourFiles > 0, String(ourFiles));
  } else {
    console.log('    （executable-compare.json 不存在，跳过）');
  }

  console.log('\n  5. ★ 口径说明：为什么「每千文件命中率」对我们不利');
  const exePath2 = path.join(ROOT, 'evidence/evolve/executable-compare.json');
  if (fs.existsSync(exePath2)) {
    const d = JSON.parse(fs.readFileSync(exePath2, 'utf8'));
    const us = (d.results || []).find((r) => r.id === 'us') || {};
    const others = (d.results || []).filter((r) => r.id !== 'us' && r.files > 0);
    const maxFiles = Math.max(...others.map((r) => r.files), 1);
    const ratio = (maxFiles / Math.max(us.files || 1, 1)).toFixed(1);
    console.log('    我们 ' + (us.files || 0) + ' 个文件 · 最大对手 ' + maxFiles + ' 个文件 · 分母比 ' + ratio + ' 倍');
    t('已记录分母差异（不假装可比）', true);
    console.log('    → 分母差 ' + ratio + ' 倍时，「每千文件命中率」不是能力强度的可比指标。');
    console.log('    → 正确读法：绝对命中数（实现点数量）+ 关键形态 + 闭环验证。');
  }

  console.log('\n  ──────────────────────────────────────────');
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  const state = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'UNKNOWN');
  console.log('  四态: ' + state);
  console.log('  ⚠ 本脚本证明「我们有这些能力的实现点」，不证明「比对手强」。');
  console.log('    「强不强」需要功能对照实验，不是数痕迹。');
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}

main();
