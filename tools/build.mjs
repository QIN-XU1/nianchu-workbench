/**
 * 念初 · 统一构建入口（第 171 轮新增）
 *
 * 为什么需要：
 *   `.nianchu-hosts/`（canonical 技能 → 12 宿主原生格式 + agents.json 清单）是**派生产物**，
 *   每次改技能都应重建。但此前没有统一构建命令，导致技能从 30 涨到 140 时该产物仍是旧 count=30，
 *   verify-release-pipeline 因此 FAIL（产物过期）。本文件提供单一构建入口，改技能后跑：
 *       node tools/build.mjs
 *   即可把派生产物重建到最新，避免漂移。
 *
 * 当前派生产物：
 *   - .nianchu-hosts/   （多宿主投影，tools/portable/project.mjs 生成）
 *
 * 用法：node tools/build.mjs
 * 四态：0 成功 / 1 失败
 */
import path from 'node:path';
import { projectAll, verify, HOSTS } from './portable/project.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const OUT = path.join(REPO, '.nianchu-hosts');

// 先用 verify 做一次幂等自检（固定时间戳），FAIL 就不产出
const res = verify(REPO, OUT);
if (res.state === 'FAIL') {
  console.error('✗ 构建失败：投影 verify = FAIL');
  for (const c of res.checks) if (!c.ok) console.error('    ✗ ' + c.name + (c.info ? '  ← ' + c.info : ''));
  process.exit(1);
}

// 正式产出一律用真实时间戳重写
projectAll(REPO, OUT, { at: new Date().toISOString() });

console.log('✓ 重建 .nianchu-hosts');
console.log('  canonical 技能 ' + res.canonCount + ' 个 × 宿主 ' + HOSTS.length + ' + agents.json');
console.log('  提示：改技能后跑 `node tools/build.mjs`，再做发布校验即不会过期。');
process.exit(0);