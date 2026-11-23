/**
 * 不变量目录（Invariant Catalog）—— 门禁的变异生成器。
 *
 * 设计要点（第 3 版，修正了前两版"盲目猜变异"的问题）：
 *   门禁不知道业务语义，所以不能猜"删一条算不算错"。
 *   因此：**场景必须显式声明自己保护哪些不变量**（scene.json 的 protects 字段），
 *   门禁只生成**违反这些已声明不变量**的变异，并要求 check 全部捕获。
 *
 * 这样既保证"门禁生成变异"（提案者无法挑选有利反例），
 * 又避免"门禁误杀正确 check"（不会因业务上无害的改动而判 check 不合格）。
 *
 * 声明本身是可审计的：人可以直接看 scene.json 里 protects 是否合理。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REFERENCE_KEYS = /^(assignee|owner|holder|user|person|account|email|url|link|ref|parent|target|source|slot|member|author|reviewer)$/i;
const REQUIRED_KEYS = /^(assignee|owner|holder|user|title|name|status|state|stage)$/i;

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/** 扫描数据目录，识别集合与文本 */
function scan(dataDir) {
  const files = safeReaddir(dataDir);
  const objectArrays = [];   // [{ file, arr }] 数组元素是对象
  const stringArrays = [];   // [{ file, arr }] 数组元素是字符串
  const texts = [];          // [file]
  for (const f of files) {
    if (f.endsWith('.json')) {
      try {
        const v = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
        if (Array.isArray(v)) {
          if (v.length === 0) continue;
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

/** 找出"被引用"的字符串值（出现在别的对象集合某字段里） */
function referencedValues(scan_, excludeFile) {
  const refs = new Map();   // value -> [{file, field}]
  for (const { file, arr } of scan_.objectArrays) {
    if (file === excludeFile) continue;
    for (const obj of arr) {
      if (typeof obj !== 'object' || obj === null) continue;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string' || v === '') continue;
        if (!referencesField(k)) continue;
        if (!refs.has(v)) refs.set(v, []);
        refs.get(v).push({ file, field: k });
      }
    }
  }
  return refs;
}

const referencesField = k => REFERENCE_KEYS.test(k);

/**
 * 不变量 → 变异生成器。
 * 每个生成器接收 scan 结果，返回 [{ name, apply(dir) }]。
 */
export const INVARIANTS = {
  // 完整性：两个集合必须完全一致（数量/成员）
  completeness(scan_) {
    const out = [];
    for (const { file, arr } of scan_.objectArrays) {
      out.push({
        name: `completeness:drop-from-${file}`,
        apply(dir) {
          const p = join(dir, file);
          const v = JSON.parse(readFileSync(p, 'utf8'));
          if (v.length === 0) return false;
          v.pop();
          writeFileSync(p, JSON.stringify(v, null, 2));
          return true;
        },
      });
    }
    for (const { file, arr } of scan_.stringArrays) {
      out.push({
        name: `completeness:drop-from-${file}`,
        apply(dir) {
          const p = join(dir, file);
          const v = JSON.parse(readFileSync(p, 'utf8'));
          if (v.length === 0) return false;
          v.pop();
          writeFileSync(p, JSON.stringify(v, null, 2));
          return true;
        },
      });
    }
    return out;
  },

  // 唯一性：同一集合内 id 不得重复
  uniqueness(scan_) {
    const out = [];
    for (const { file, arr } of scan_.objectArrays) {
      if (!arr.some(o => typeof o === 'object' && o !== null && typeof o.id === 'string')) continue;
      out.push({
        name: `uniqueness:duplicate-id-${file}`,
        apply(dir) {
          const p = join(dir, file);
          const v = JSON.parse(readFileSync(p, 'utf8'));
          if (v.length === 0) return false;
          v.push({ ...v[0] });      // 复制第一项（同 id）
          writeFileSync(p, JSON.stringify(v, null, 2));
          return true;
        },
      });
    }
    return out;
  },

  // 引用完整性：引用字段必须能解析到被引用集合里
  'referential-integrity'(scan_) {
    const out = [];
    // (a) 悬空引用：把引用字段指向不存在的东西
    for (const { file, arr } of scan_.objectArrays) {
      const refKey = arr
        .filter(o => typeof o === 'object' && o !== null)
        .flatMap(o => Object.keys(o))
        .find(k => referencesField(k) && typeof arr.find(o => o[k])?.[k] === 'string');
      if (!refKey) continue;
      out.push({
        name: `referential-integrity:dangling-${file}.${refKey}`,
        apply(dir) {
          const p = join(dir, file);
          const v = JSON.parse(readFileSync(p, 'utf8'));
          const t = v.find(o => typeof o[refKey] === 'string' && o[refKey] !== '');
          if (!t) return false;
          t[refKey] = '__GATE_DANGLING__';
          writeFileSync(p, JSON.stringify(v, null, 2));
          return true;
        },
      });
    }
    // (b) 删掉被引用的目标（制造悬空）
    for (const { file, arr } of scan_.stringArrays) {
      const refs = referencedValues(scan_, file);
      const victim = arr.find(v => refs.has(v));
      if (!victim) continue;
      out.push({
        name: `referential-integrity:drop-referenced-${file}(${victim})`,
        apply(dir) {
          const p = join(dir, file);
          const v = JSON.parse(readFileSync(p, 'utf8'));
          const i = v.indexOf(victim);
          if (i < 0) return false;
          v.splice(i, 1);
          writeFileSync(p, JSON.stringify(v, null, 2));
          return true;
        },
      });
    }
    return out;
  },

  // 必填字段：声明为必填的字段不得为空
  'required-field'(scan_) {
    const out = [];
    for (const { file, arr } of scan_.objectArrays) {
      const key = arr
        .filter(o => typeof o === 'object' && o !== null)
        .flatMap(o => Object.keys(o))
        .find(k => REQUIRED_KEYS.test(k) && arr.some(o => typeof o[k] === 'string' && o[k] !== ''));
      if (!key) continue;
      out.push({
        name: `required-field:blank-${file}.${key}`,
        apply(dir) {
          const p = join(dir, file);
          const v = JSON.parse(readFileSync(p, 'utf8'));
          const t = v.find(o => typeof o[key] === 'string' && o[key] !== '');
          if (!t) return false;
          t[key] = '';
          writeFileSync(p, JSON.stringify(v, null, 2));
          return true;
        },
      });
    }
    return out;
  },

  // 术语出现：登记的词必须在正文里出现
  'term-presence'(scan_) {
    const out = [];
    const terms = scan_.stringArrays[0];
    const text = scan_.texts[0];
    if (!terms || !text) return out;
    const present = terms.arr.find(t => {
      try { return readFileSync(join(scan_.texts.length ? '.' : '.', 'x')) && true; } catch { return true; }
    });
    out.push({
      name: `term-presence:delete-term-from-${text}`,
      apply(dir) {
        const termsPath = join(dir, terms.file);
        const textPath = join(dir, text);
        const list = JSON.parse(readFileSync(termsPath, 'utf8'));
        let body = readFileSync(textPath, 'utf8');
        const victim = list.find(t => body.includes(t));
        if (!victim) return false;
        body = body.split(victim).join('　');     // 用全角空格替换，保留长度感
        writeFileSync(textPath, body);
        return true;
      },
    });
    return out;
  },

  // 禁止未登录 token：正文里不得出现登记表之外的"大写缩写"
  'no-unregistered-token'(scan_) {
    const out = [];
    const terms = scan_.stringArrays[0];
    const text = scan_.texts[0];
    if (!terms || !text) return out;
    out.push({
      name: `no-unregistered-token:append-alien-acronym-${text}`,
      apply(dir) {
        const p = join(dir, text);
        const body = readFileSync(p, 'utf8');
        writeFileSync(p, body + '\nGXZ 也需要关注。\n');
        return true;
      },
    });
    return out;
  },
};

/** 根据场景声明的不变量生成变异 */
export function mutationsFor(dataDir, protects) {
  const scan_ = scan(dataDir);
  const plan = [];
  for (const inv of protects) {
    const gen = INVARIANTS[inv];
    if (!gen) continue;                     // 未知不变量由门禁在 G0 单独报错
    for (const m of gen(scan_)) {
      plan.push({ invariant: inv, ...m });
    }
  }
  return plan;
}

/** 场景声明的不变量里，有哪些是门禁不认识的 */
export function unknownInvariants(protects) {
  return protects.filter(p => !INVARIANTS[p]);
}
