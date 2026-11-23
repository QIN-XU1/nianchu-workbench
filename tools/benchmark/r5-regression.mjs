#!/usr/bin/env node
/**
 * R5 复现 —— 整个项目从 projects.json + analysis.json 同时消失
 *
 * 独立验证方的攻击（research/独立验证-H0001.md R5）：
 *   「整个项目从 projects.json + analysis.json 同时消失 → audit-coverage
 *     打印『PASS —— 全部 21 个项目达标』exit 0」
 *
 * 修复前的预期：exit 0（漏报）
 * 修复后的预期：exit 1（对账不齐）
 *
 * 这个脚本是**回归测试**，防止将来又把对账去掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const A = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/analysis.json');
const P = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/projects.json');
const SCRIPT = path.join(REPO, 'tools/benchmark/audit-coverage.mjs');

const victims = ['trae', 'workbuddy', 'qoder'];

console.log('');
console.log('  R5 回归测试：整个项目消失时审计必须 FAIL');
console.log('  ' + '─'.repeat(76));

const rp = fs.readFileSync(P);
const ra = fs.readFileSync(A);
let fail = 0;

try {
  for (const victim of victims) {
    // 从两个文件里**同时**删掉
    const pj = JSON.parse(rp.toString('utf8'));
    const aj = JSON.parse(ra.toString('utf8'));
    const beforeP = pj.projects.length;
    const beforeA = Object.keys(aj.byId).length;
    pj.projects = pj.projects.filter((x) => x.id !== victim);
    delete aj.byId[victim];
    fs.writeFileSync(P, JSON.stringify(pj, null, 2) + '\n', 'utf8');
    fs.writeFileSync(A, JSON.stringify(aj, null, 2) + '\n', 'utf8');

    let code = 0, out = '';
    try {
      out = execFileSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
      code = 0;
    } catch (e) {
      code = e.status ?? 1;
      out = (e.stdout || '') + (e.stderr || '');
    }

    const caught = code !== 0;
    const mentions = out.includes(victim);
    if (!caught) fail++;

    console.log('  ' + (caught ? '✓' : '✗') + ' 删掉 ' + victim.padEnd(12)
      + 'p ' + beforeP + '→' + pj.projects.length + ' · a ' + beforeA + '→' + Object.keys(aj.byId).length
      + '  exit=' + String(code).padEnd(3)
      + (caught ? (mentions ? '（报告里点名了 ' + victim + '）' : '（报了但对账信息里没点名）') : '（漏报！）'));

    // 恢复
    fs.writeFileSync(P, rp);
    fs.writeFileSync(A, ra);
  }

  // 反向：清单外多出一个项目
  const pj = JSON.parse(rp.toString('utf8'));
  const aj = JSON.parse(ra.toString('utf8'));
  pj.projects.push({ ...pj.projects[0], id: 'ghost-project', name: 'Ghost' });
  aj.byId['ghost-project'] = JSON.parse(JSON.stringify(aj.byId[pj.projects[0].id] || {}));
  fs.writeFileSync(P, JSON.stringify(pj, null, 2) + '\n', 'utf8');
  fs.writeFileSync(A, JSON.stringify(aj, null, 2) + '\n', 'utf8');

  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    code = 0;
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const caught2 = code !== 0;
  if (!caught2) fail++;
  console.log('  ' + (caught2 ? '✓' : '✗') + ' 多出清单外项目     exit=' + String(code).padEnd(3)
    + (caught2 ? '' : '（漏报！）'));
  fs.writeFileSync(P, rp);
  fs.writeFileSync(A, ra);

} finally {
  fs.writeFileSync(P, rp);
  fs.writeFileSync(A, ra);
}

console.log('  ' + '─'.repeat(76));
console.log('  ' + (fail ? '✗ ' + fail + ' 项漏报' : '✓ 全部抓到'));
console.log('');
process.exit(fail ? 1 : 0);