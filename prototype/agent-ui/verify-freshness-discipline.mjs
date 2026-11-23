#!/usr/bin/env node
/**
 * 新鲜度纪律验收器 —— 防止「旧快照冒充此刻」再犯
 *
 * 规则（先立标准）：
 *   任何场景只要 import 了 `./data/*.json`，且该 JSON **含时间戳字段**
 *   （at / generatedAt / asOf / collectedAt / updatedAt / time），
 *   就必须在源码里使用新鲜度机制（FreshnessNotice 组件 或 applyFreshness 函数）。
 *
 * 为什么需要它：2026-11-17 发现四态面板、验证场景、总览/记忆/联网/神经元
 * 各自把 32~55 小时前的数据当此刻展示。人肉检查会漏，必须机器查。
 *
 * 反例（必须能红）：
 *   · 有 timestamp 但没用新鲜度机制 ⇒ FAIL
 *   · 没有 timestamp 的文件 ⇒ 不要求（不算违规）
 *   · 用了 FreshnessNotice ⇒ 通过
 *
 * 四态：PASS 全部合规 / FAIL 有违规 / UNKNOWN 找不到场景目录
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCENES_ROOT = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes');

const TIME_KEYS = ['at', 'generatedAt', 'asOf', 'collectedAt', 'updatedAt', 'time'];
const FRESHNESS_MARKERS = ['FreshnessNotice', 'applyFreshness', 'canClaimCurrent'];

/** 纯函数：给定场景源码 + 数据 JSON 内容，判定是否合规 */
export function checkScene(fileName, sourceText, dataJson) {
  const imports = [...sourceText.matchAll(/import\s+\w+\s+from\s+'\.\/data\/([^']+)'/g)].map((m) => m[1]);
  if (imports.length === 0) return { scene: fileName, status: 'no_data', violations: [] };

  const hasTime = dataJson && typeof dataJson === 'object'
    && TIME_KEYS.some((k) => Object.prototype.hasOwnProperty.call(dataJson, k));
  if (!hasTime) return { scene: fileName, status: 'no_timestamp', violations: [] };

  const usesFreshness = FRESHNESS_MARKERS.some((mk) => sourceText.includes(mk));
  if (usesFreshness) return { scene: fileName, status: 'compliant', violations: [] };

  const presentKeys = TIME_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(dataJson, k));
  return {
    scene: fileName,
    status: 'violation',
    violations: [{
      scene: fileName,
      data: imports[0],
      timeKeys: presentKeys,
      message: `导入了含时间戳(${presentKeys.join('/')})的数据，但没有使用新鲜度机制（FreshnessNotice / applyFreshness）`,
    }],
  };
}

function main() {
  if (!fs.existsSync(SCENES_ROOT)) {
    console.log('  ✗ 场景目录不存在：' + SCENES_ROOT);
    console.log('\n  四态: UNKNOWN');
    return 2;
  }

  const results = [];
  for (const sceneDir of fs.readdirSync(SCENES_ROOT)) {
    const dirPath = path.join(SCENES_ROOT, sceneDir);
    let st;
    try { st = fs.statSync(dirPath); } catch { continue; }
    if (!st.isDirectory()) continue;

    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith('.tsx') || f.endsWith('.test.tsx')) continue;
      const srcPath = path.join(dirPath, f);
      const src = fs.readFileSync(srcPath, 'utf8');
      // 该场景引用的第一个 data json 内容（用于判断是否含时间戳）
      const m = /import\s+\w+\s+from\s+'\.\/data\/([^']+)'/.exec(src);
      let dataJson = null;
      if (m) {
        const jPath = path.join(dirPath, 'data', m[1]);
        try { dataJson = JSON.parse(fs.readFileSync(jPath, 'utf8')); } catch { dataJson = null; }
      }
      const r = checkScene(f, src, dataJson);
      if (r.status === 'violation' || r.status === 'compliant') results.push({ ...r, dir: sceneDir });
    }
  }

  const violations = results.flatMap((r) => r.violations);
  const compliant = results.filter((r) => r.status === 'compliant');

  console.log('  新鲜度纪律验收 · 扫描 ' + results.length + ' 个读数据的场景');
  for (const r of compliant) console.log('    ✓ ' + r.dir + '/' + r.scene + ' 已用新鲜度机制');
  for (const v of violations) console.log('    ✗ ' + v.scene + '  [' + v.data + ']  ' + v.message);

  const state = violations.length === 0 ? 'PASS' : 'FAIL';
  console.log('\n  合规 ' + compliant.length + ' · 违规 ' + violations.length);
  console.log('  四态: ' + state);
  return state === 'PASS' ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) process.exit(main());
