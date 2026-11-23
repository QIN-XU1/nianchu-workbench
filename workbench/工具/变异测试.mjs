#!/usr/bin/env node
/**
 * 变异测试框架 —— 证明"检查真的会失败"
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要它（本项目最核心的方法论）
 * ══════════════════════════════════════════════════════════════
 *
 *  原项目判据：
 *    "没有'会失败的检查'的规矩 = 一句口号。"
 *    "如果一个检查永远通过，它就不是检查，是装饰。"
 *
 *  但更大的问题：**你怎么知道检查真的会失败？**
 *    检查通过 ≠ 检查有效
 *    可能检查的判据写错了，永远不会报
 *
 *  唯一可靠的证明：
 *    造一个**必然违规**的样本 → 检查**必须报** → 才算数
 *
 *  这就是 challenges/ 已经证明有效的方法。
 *
 * ══════════════════════════════════════════════════════════════
 *  设计（借鉴 challenges/c3 的做法）
 * ══════════════════════════════════════════════════════════════
 *
 *  每个用例：
 *    ① 复制基线到临时目录（mkdtemp）
 *    ② 注入一个具体错误
 *    ③ 跑检查脚本，指向临时目录
 *    ④ 断言：exit 非 0 且输出包含期望文本
 *    ⑤ 清理临时目录
 *    ⑥ 元测试：原始数据 SHA256 未变（证明没污染）
 *
 *  用法：
 *    node 工具/变异测试.mjs <检查脚本> <用例目录>
 *    node 工具/变异测试.mjs --list
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');

// ══════════════════════════════════════════════════════════════
//  核心：单个用例的执行器
// ══════════════════════════════════════════════════════════════

/**
 * 跑一个变异用例
 *
 * @param {object} c
 *   c.name       用例名
 *   c.baseline   基线数据目录（会被复制到临时目录）
 *   c.mutate     函数 (tmpDir) => void  在临时目录里注入错误
 *   c.check      {file, args, env}      检查脚本
 *   c.expect     {exitNonZero, includes[], notIncludes[]}
 * @returns {object} 结果
 */
export function runCase(c) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-'));

  // 记录基线哈希（元测试用）
  const beforeHash = hashDir(c.baseline);

  try {
    // ① 复制基线
    copyDir(c.baseline, tmp);

    // ② 注入错误
    if (c.mutate) c.mutate(tmp);

    // ③ 跑检查
    //   ★ 自检修复：env 值支持 {{DIR}} 占位符 → 替换成临时目录
    //     不这样做的话，检查脚本会读原始目录，永远 PASS（变异测试形同虚设）
    const env = Object.assign({}, process.env);
    for (const [k, v] of Object.entries(c.check.env || {})) {
      env[k] = String(v).replace(/\{\{DIR\}\}/g, tmp);
    }
    if (c.check.dataEnv) env[c.check.dataEnv] = tmp;

    const args = (c.check.args || []).map(a => a.replace('{{DATA}}', tmp));
    const r = spawnSync(process.execPath, [c.check.file, ...args], {
      env,
      encoding: 'utf8',
      timeout: c.timeoutMs || 30000,
    });

    const stdout = r.stdout || '';
    const stderr = r.stderr || '';
    const out = stdout + stderr;
    const exitCode = r.status;

    // ④ 断言
    const reasons = [];
    const expect = c.expect || {};

    if (expect.exitNonZero !== undefined) {
      const wantFail = expect.exitNonZero;
      const isFail = exitCode !== 0;
      if (wantFail && !isFail) reasons.push('期望失败但 exit=' + exitCode);
      if (!wantFail && isFail) reasons.push('期望通过但 exit=' + exitCode);
    }

    for (const s of (expect.includes || [])) {
      if (!out.includes(s)) reasons.push('输出缺少 "' + s + '"');
    }

    for (const s of (expect.notIncludes || [])) {
      if (out.includes(s)) reasons.push('输出不应包含 "' + s + '"');
    }

    return {
      name: c.name,
      ok: reasons.length === 0,
      exitCode,
      head: stdout.split('\n').filter(Boolean)[0] || '(无输出)',
      reasons,
      ms: r.status === null ? 'TIMEOUT' : undefined,
    };
  } finally {
    // ⑤ 清理
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

    // ⑥ 元测试：原始数据未被污染
    const afterHash = hashDir(c.baseline);
    if (beforeHash !== afterHash) {
      console.error('  ⛔ 元测试失败：基线数据被污染！');
      console.error('     前: ' + beforeHash);
      console.error('     后: ' + afterHash);
      process.exitCode = 2;
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════════════════════

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const it of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, it.name);
    const d = path.join(dst, it.name);
    if (it.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function hashDir(dir) {
  const h = crypto.createHash('sha256');
  const files = [];
  (function walk(d) {
    for (const it of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else files.push(p);
    }
  })(dir);
  for (const f of files) {
    h.update(path.relative(dir, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 16);
}

// ══════════════════════════════════════════════════════════════
//  运行一组用例
// ══════════════════════════════════════════════════════════════

export function runSuite(title, cases) {
  console.log('═'.repeat(66));
  console.log('  ' + title);
  console.log('═'.repeat(66));
  console.log();

  let pass = 0, fail = 0;
  const t0 = Date.now();

  for (const c of cases) {
    const r = runCase(c);
    if (r.ok) {
      pass++;
      console.log('  OK   ' + r.name);
      console.log('       exit=' + r.exitCode + '  ' + r.head.slice(0, 80));
    } else {
      fail++;
      console.log('  XX   ' + r.name);
      console.log('       exit=' + r.exitCode + '  ' + r.head.slice(0, 80));
      for (const reason of r.reasons) console.log('       → ' + reason);
    }
  }

  const ms = Date.now() - t0;
  console.log();
  console.log('─'.repeat(66));
  console.log('  结果: ' + pass + ' / ' + (pass + fail) + ' 通过   （' + ms + 'ms）');
  console.log('─'.repeat(66));
  console.log();

  if (fail > 0) process.exitCode = 1;
  return { pass, fail, total: pass + fail };
}

// ══════════════════════════════════════════════════════════════
//  自测：证明这个框架本身有效
//  这是元元测试 —— 用变异测试验证变异测试框架
// ══════════════════════════════════════════════════════════════

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);

  if (args.includes('--selftest')) {
    // 造一个极简的检查脚本：要求某文件里的 count 字段存在且 > 0
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-selftest-'));
    try {
      const dataDir = path.join(work, 'data');
      fs.mkdirSync(dataDir);
      fs.writeFileSync(path.join(dataDir, 'x.json'), JSON.stringify({ count: 5 }), 'utf8');

      const checkFile = path.join(work, 'check.mjs');
      fs.writeFileSync(checkFile, `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.DATA_DIR || '.';
const f = path.join(dir, 'x.json');
let j;
try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
catch (e) { console.log('FAIL result: 差异集合 = 1 项'); console.log('  - 读不到 x.json'); process.exit(1); }
if (typeof j.count !== 'number' || j.count <= 0) {
  console.log('FAIL result: 差异集合 = 1 项');
  console.log('  - count 缺失或非正数：' + JSON.stringify(j.count));
  process.exit(1);
}
console.log('PASS result: 差异集合 = 0');
process.exit(0);
`, 'utf8');

      const cases = [
        {
          name: '原始数据应 PASS',
          baseline: dataDir,
          check: { file: checkFile, dataEnv: 'DATA_DIR' },
          expect: { exitNonZero: false, includes: ['PASS result: 差异集合 = 0'] },
        },
        {
          name: '变异1: count 改成 0 → 必须 FAIL',
          baseline: dataDir,
          mutate: (d) => fs.writeFileSync(path.join(d, 'x.json'), JSON.stringify({ count: 0 }), 'utf8'),
          check: { file: checkFile, dataEnv: 'DATA_DIR' },
          expect: { exitNonZero: true, includes: ['FAIL result: 差异集合 = 1 项'] },
        },
        {
          name: '变异2: 删掉 count 字段 → 必须 FAIL',
          baseline: dataDir,
          mutate: (d) => fs.writeFileSync(path.join(d, 'x.json'), JSON.stringify({ other: 1 }), 'utf8'),
          check: { file: checkFile, dataEnv: 'DATA_DIR' },
          expect: { exitNonZero: true, includes: ['count'] },
        },
        {
          name: '变异3: 文件损坏 → 必须 FAIL',
          baseline: dataDir,
          mutate: (d) => fs.writeFileSync(path.join(d, 'x.json'), '{ 这不是json', 'utf8'),
          check: { file: checkFile, dataEnv: 'DATA_DIR' },
          expect: { exitNonZero: true, includes: ['FAIL'] },
        },
        {
          name: '变异4: 期望通过但检查会失败 → 框架必须报错（反例验证）',
          baseline: dataDir,
          mutate: (d) => fs.writeFileSync(path.join(d, 'x.json'), JSON.stringify({ count: 0 }), 'utf8'),
          check: { file: checkFile, dataEnv: 'DATA_DIR' },
          // 故意写错期望：这应该让框架报 XX
          expect: { exitNonZero: false },
        },
      ];

      console.log('═'.repeat(66));
      console.log('  变异测试框架自测（元元测试）');
      console.log('═'.repeat(66));
      console.log('  检查 4 个变异必须全被捕获；第 5 个故意写错期望，框架必须报 XX');
      console.log();

      let pass = 0, fail = 0;
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const r = runCase(c);
        // 前 4 个期望 ok=true；第 5 个期望 ok=false
        const expectOk = i < 4;
        const good = (r.ok === expectOk);
        if (good) {
          pass++;
          console.log('  OK   ' + c.name);
        } else {
          fail++;
          console.log('  XX   ' + c.name + '  (got ok=' + r.ok + ', want ok=' + expectOk + ')');
        }
      }

      console.log();
      console.log('─'.repeat(66));
      console.log('  自测结果: ' + pass + ' / ' + (pass + fail) + ' 通过');
      console.log('─'.repeat(66));
      console.log();
      console.log('  说明：');
      console.log('    前 4 个证明：框架能正确捕获变异（检查真的会失败）');
      console.log('    第 5 个证明：框架能识别"期望写错"（不会盲信自己的断言）');
      console.log('    元测试证明：基线数据 SHA256 未变（测试不污染原数据）');
      console.log();

      if (fail > 0) process.exitCode = 1;
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
    process.exit(process.exitCode || 0);
  }

  console.log('变异测试框架');
  console.log();
  console.log('用法:');
  console.log('  node 工具/变异测试.mjs --selftest     # 框架自测（证明框架有效）');
  console.log();
  console.log('在代码里使用:');
  console.log("  import { runSuite } from './工具/变异测试.mjs';");
  console.log('  runSuite("身份哨兵", [ {name, baseline, mutate, check, expect}, ... ]);');
}
