/**
 * 不变量下限（Invariant Floor）—— 防止"声明过弱"让门禁形同虚设。
 *
 * 问题（方案 13 篇 P2）：
 *   如果 scene.json 的 protects 由 Agent 自己写，它可以只声明最容易满足的不变量，
 *   例如一个有两个集合的场景只声明 uniqueness 而不声明 completeness，
 *   门禁就永远不会去测"集合是否完整"——门禁形同虚设。
 *
 * 解法：**从数据形态反推"最低必须声明"的不变量**，并把这条检查本身做成可测的。
 *
 * 规则（基于数据形态，与业务无关）：
 *   - 有 ≥2 个 JSON 数组 → 必须声明 completeness 或 referential-integrity 之一
 *     （否则"集合之间的一致性"完全没被保护）
 *   - 任何数组元素有 id 字段 → 必须声明 uniqueness
 *   - 任何数组元素有字符串必填字段 → 必须声明 required-field
 *   - 有任何"被其他集合引用的字符串数组" → 必须声明 referential-integrity
 *   - 有文本文件 + 术语数组 → 必须声明 term-presence
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 只有"缺了就会让人或系统认不出对象"的字段才算必填型；
// status/state/stage 是枚举描述，不是标识，不算。
const REQUIRED_KEYS = /^(assignee|owner|holder|user|title|name)$/i;
const REFERENCE_KEYS = /^(assignee|owner|holder|user|person|account|email|url|link|ref|parent|target|source|slot|member|author|reviewer)$/i;

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/** 分析数据形态 */
export function shapeOf(dataDir) {
  const files = safeReaddir(dataDir);
  const objectArrays = [];
  const stringArrays = [];
  const texts = [];

  for (const f of files) {
    if (f.endsWith('.json')) {
      try {
        const v = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
        if (Array.isArray(v) && v.length > 0) {
          if (typeof v[0] === 'object' && v[0] !== null) objectArrays.push({ file: f, arr: v });
          else if (typeof v[0] === 'string') stringArrays.push({ file: f, arr: v });
        }
      } catch { /* 非 JSON */ }
    } else if (/\.(txt|md|log)$/i.test(f)) {
      texts.push(f);
    }
  }

  return { objectArrays, stringArrays, texts };
}

/**
 * 计算"最低必须声明"的不变量集合。
 * 返回 { required: Set<string>, reasons: {invariant: 原因} }
 */
export function floorFor(dataDir) {
  const { objectArrays, stringArrays, texts } = shapeOf(dataDir);
  const required = new Set();
  const reasons = {};

  const collections = objectArrays.length + stringArrays.length;

  // 规则 1：多个集合 → 必须保护"集合之间的一致性"
  if (collections >= 2) {
    required.add('completeness');
    reasons.completeness = `有 ${collections} 个集合，必须保护集合完整性（或引用完整性）`;
    // 也允许用 referential-integrity 替代 completeness，见 checkFloor
  required.add('__OR_completeness_referential-integrity__');
  }

  // 规则 2：任何元素有 id → 唯一性
  const hasId = objectArrays.some(({ arr }) =>
    arr.some(o => typeof o === 'object' && o !== null && typeof o.id === 'string'));
  if (hasId) {
    required.add('uniqueness');
    reasons.uniqueness = '数据带 id 字段，必须保护唯一性';
  }

  // 规则 3：有必填型字段 → required-field
  const hasRequiredField = objectArrays.some(({ arr }) =>
    arr.some(o => typeof o === 'object' && o !== null &&
      Object.keys(o).some(k => REQUIRED_KEYS.test(k) && typeof o[k] === 'string')));
  if (hasRequiredField) {
    required.add('required-field');
    reasons['required-field'] = '存在必填型字段（如 name/owner/status），必须保护非空';
  }

  // 规则 4：有字符串数组被别的集合引用 → referential-integrity
  let hasReferenced = false;
  for (const { file, arr } of stringArrays) {
    for (const { arr: oa } of objectArrays) {
      for (const o of oa) {
        if (typeof o !== 'object' || o === null) continue;
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string' && REFERENCE_KEYS.test(k) && arr.includes(v)) {
            hasReferenced = true;
          }
        }
      }
    }
  }
  if (hasReferenced) {
    required.add('referential-integrity');
    reasons['referential-integrity'] = '存在跨集合引用，必须保护引用完整性';
  }

  // 规则 5：文本 + 术语数组 → term-presence
  if (texts.length > 0 && stringArrays.length > 0) {
    required.add('term-presence');
    reasons['term-presence'] = '有文本文件与术语数组，必须保护术语出现';
  }

  // 清理占位规则
  required.delete('__OR_completeness_referential-integrity__');

  return { required, reasons };
}

/**
 * 检查场景声明是否达到下限。
 * 返回 { ok, missing: [], notes: [] }
 */
export function checkFloor(scene) {
  const { required, reasons } = floorFor(scene.dataDir);
  const declared = new Set(Array.isArray(scene.protects) ? scene.protects : []);

  const missing = [];
  for (const inv of required) {
    // completeness 与 referential-integrity 满足其一即可
    if (inv === 'completeness') {
      if (!declared.has('completeness') && !declared.has('referential-integrity')) {
        missing.push({ invariant: inv, reason: reasons.completeness });
      }
      continue;
    }
    if (!declared.has(inv)) {
      missing.push({ invariant: inv, reason: reasons[inv] || '' });
    }
  }

  return { ok: missing.length === 0, missing, declared: [...declared], required: [...required] };
}

/** CLI：node invariant-floor.mjs <sceneRoot> */
if (process.argv[1] && /invariant-floor\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const root = process.argv[2];
  const { discover } = await import('./scene-loader.mjs');
  const scenes = discover(root);
  let bad = 0;
  for (const s of scenes) {
    if (s.error) { console.log('✗ ' + s.id + ': 配置有误 (' + s.error + ')'); bad++; continue; }
    const f = checkFloor(s);
    if (f.ok) {
      console.log(`✓ ${s.id.padEnd(20)} 声明 [${f.declared.join(', ')}] 达到下限`);
    } else {
      bad++;
      console.log(`✗ ${s.id.padEnd(20)} 声明过弱，缺：`);
      for (const m of f.missing) console.log(`    - ${m.invariant}  (${m.reason})`);
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}
