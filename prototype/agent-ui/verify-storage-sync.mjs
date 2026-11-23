#!/usr/bin/env node
/**
 * 跨组件存储同步检查 —— 防「A 写了 B 看不见」
 *
 * 背景（2026-11-17）：场景记忆面板写派单账本，DispatchScene 已挂载却永不重读
 * localStorage ⇒ 派单真的进了账本，界面上什么都没有。这类 bug 只有真跑才暴露。
 *
 * 判据（先立标准）：
 *   · 同一个 key 在 **≥2 个不同文件**里被读写 ⇒ 必须用事件/storage 监听同步
 *   · 只在 1 个文件里用 ⇒ 不要求（组件内自洽）
 *   · 有同步标记（addEventListener('storage') / 自定义事件广播+监听）⇒ 合规
 *
 * 四态：PASS 无隐患 / WARN 有跨文件共享但未发现同步 / UNKNOWN 找不到源码目录
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app');

/**
 * 同步机制标记 —— 必须真的能通知到别人，不能是任意监听
 *
 * 【2026-11-17 收紧】首版把裸 `addEventListener(` 也算「有同步」，太宽：
 * 一个只监听键盘的组件会被误判成已同步。现在只认三种：
 *   ① 跨标签 storage 事件监听
 *   ② 自定义事件广播（dispatchEvent(new Event(...))）
 *   ③ 监听某个 *_CHANGED / *-changed 事件
 */
export const SYNC_MARKERS = [
  "addEventListener('storage'",
  'addEventListener("storage"',
  'dispatchEvent(new Event(',
  'addEventListener(DISPATCH_CHANGED_EVENT',
  /addEventListener\(\s*[A-Z][A-Z0-9_]*_CHANGED\b/,
  /addEventListener\(\s*'[a-z][a-z0-9-]*-changed'/,
];

/** 判断一个文件是否有同步机制（支持字符串与正则两类标记） */
export function hasSyncMarker(src) {
  return SYNC_MARKERS.some((m) => (typeof m === 'string' ? src.includes(m) : m.test(src)));
}

/** 纯函数：给「key → 使用它的文件列表」判定 */
export function judgeKey(key, files) {
  if (!files || files.length < 2) return { key, state: 'OK', files };
  const synced = files.filter((f) => f.hasSync);
  if (synced.length >= 1) return { key, state: 'SYNCED', files };
  return { key, state: 'RISK', files };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 从源码里抽 localStorage key
 *
 * 【2026-11-17 修·盲区】首版只解析**同一文件内**的 const KEY = '...'。
 * 但 HealthPanel 用的是 `import { K_MEMORY_TEXT } from './storageKeys'` ——
 * 导入的常量完全看不见，于是「三个面板 + 健康检查共用同一 key」这件事
 * 没被检查出来（差点又漏一个「A 改了 B 看不见」）。
 *
 * 现在接受一个全局常量表（exported const 名 → 值），导入的常量也能解析。
 *
 * @param src 源文件内容
 * @param globalConsts 跨文件收集到的常量表（可选）
 */
export function keysOf(src, globalConsts = new Map(), confirmedKeys = new Set()) {
  const out = new Set();
  // 直接字面量
  for (const m of src.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*'([^']+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*"([^"]+)"/g)) out.add(m[1]);
  // 同文件常量：const KEY = 'xxx'
  const consts = new Map(globalConsts);
  for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) consts.set(m[1], m[2]);
  // localStorage.xxx(KEY) 形式（KEY 可能来自同文件或导入）
  for (const m of src.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*([A-Z][A-Z0-9_]*)/g)) {
    const v = consts.get(m[1]);
    if (v) out.add(v);
  }
  // 【2026-11-17 再补】可能通过 helper 间接调用，如 `g(K_MEMORY_TEXT)`，
  // 此时 localStorage.getItem(k) 的实参是变量 k —— 正则看不到。
  // 兜底：文件里引用了某个「**确实被 localStorage 用过**的导出常量名」就算使用。
  //
  // 【必须收紧】首版把「所有导出字符串常量」都当 key，结果事件名
  // （openbitfun:miniapp-agent-ready）和枚举值（Standard/Claw）全被算成 storage key，
  // 报出 18 个**假隐患**。现在只认 confirmedKeys（有人真的把它传给 localStorage）。
  for (const name of confirmedKeys) {
    if (!globalConsts.has(name)) continue;
    if (new RegExp('\\b' + name + '\\b').test(src)) out.add(globalConsts.get(name));
  }
  return [...out];
}

/** 收集一个文件里导出的常量（用于跨文件解析） */
export function exportedConsts(src) {
  const m = new Map();
  for (const x of src.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) m.set(x[1], x[2]);
  return m;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.log('  ✗ 源码目录不存在：' + SRC);
    console.log('\n  四态: UNKNOWN');
    return 2;
  }
  const files = walk(SRC);
  // 第一遍：收集所有导出的 key 常量（供导入方解析）
  const globalConsts = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const [k, v] of exportedConsts(src)) globalConsts.set(k, v);
  }
  // 第二遍：找出「确实算 storage key 的常量名」
  //   ① 有人把它直接传给 localStorage
  //   ② 或名字符合存储键约定 K_* / KEY*（集中定义在 storageKeys.ts 的常量
  //      永远是通过 helper 间接用的，不会出现在 ① 里）
  const confirmedKeys = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*([A-Z][A-Z0-9_]*)/g)) {
      confirmedKeys.add(m[1]);
    }
  }
  for (const name of globalConsts.keys()) {
    if (/^(K_|KEY_?)/.test(name)) confirmedKeys.add(name);
  }

  const byKey = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const hasSync = hasSyncMarker(src);
    // 只声明常量、完全不碰 localStorage 的文件不算「使用者」
    // （否则 storageKeys.ts 会让每个 key 都虚增一个共享方）
    const touchesStorage = /localStorage\s*\./.test(src);
    if (!touchesStorage) continue;
    for (const k of keysOf(src, globalConsts, confirmedKeys)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ file: path.relative(REPO, f).replace(/\\/g, '/'), hasSync });
    }
  }

  const rows = [...byKey.entries()].map(([k, fs_]) => judgeKey(k, fs_));
  const shared = rows.filter((r) => r.files.length >= 2);
  const risks = shared.filter((r) => r.state === 'RISK');

  console.log('  跨组件存储同步检查 · 扫描 ' + files.length + ' 个源文件 · ' + rows.length + ' 个 key');
  console.log('  被 ≥2 个文件共用：' + shared.length + ' 个');
  for (const r of shared) {
    console.log('    ' + (r.state === 'RISK' ? '✗' : '✓') + ' ' + r.key + '  [' + r.files.map((x) => x.file.split('/').pop() + (x.hasSync ? '*' : '')).join(', ') + ']');
  }
  const state = risks.length === 0 ? 'PASS' : 'WARN';
  console.log('\n  隐患 ' + risks.length + ' · 四态: ' + state);
  if (risks.length) {
    console.log('  说明：* 表示该文件里有同步机制；无 * 的文件读写后不会通知别人。');
  }
  return state === 'PASS' ? 0 : 3;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) process.exit(main());
