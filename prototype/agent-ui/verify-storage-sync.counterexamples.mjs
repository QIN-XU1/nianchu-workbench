#!/usr/bin/env node
/**
 * 跨组件存储同步检查 · 反例自检
 * 证明 judgeKey / hasSyncMarker 的判定会红，不是恒真。
 */
import { judgeKey, keysOf, hasSyncMarker } from './verify-storage-sync.mjs';

let pass = 0, total = 0;
const lines = [];
const T = (n, ok, w) => { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)); };

// ── 反例：两个文件共用同一 key 且都无同步 ⇒ RISK（这就是本轮修的 bug）──
const r1 = judgeKey('ledger', [
  { file: 'A.tsx', hasSync: false },
  { file: 'B.tsx', hasSync: false },
]);
T('反例 · 两文件共用同一 key 且无同步 ⇒ RISK', r1.state === 'RISK', r1.state);

// ── 正例：有一个文件带同步 ⇒ SYNCED ──
const r2 = judgeKey('ledger', [
  { file: 'A.tsx', hasSync: true },
  { file: 'B.tsx', hasSync: false },
]);
T('正例 · 至少一处有同步 ⇒ SYNCED', r2.state === 'SYNCED', r2.state);

// ── 正例：只有一个文件用 ⇒ OK（不误伤组件内自洽）──
const r3 = judgeKey('solo', [{ file: 'A.tsx', hasSync: false }]);
T('正例 · 仅 1 个文件使用 ⇒ OK（不误伤）', r3.state === 'OK', r3.state);

// ── 反例：空文件列表不崩 ──
T('反例 · 空列表不崩 ⇒ OK', judgeKey('x', []).state === 'OK', 'wrong');

// ── hasSyncMarker 收紧验证：只监听键盘不算同步 ──
T('反例 · 只监听键盘（keydown）不算同步',
  hasSyncMarker("window.addEventListener('keydown', f)") === false, 'should be false');
T('反例 · 只监听点击不算同步',
  hasSyncMarker("el.addEventListener('click', f)") === false, 'should be false');

// ── 正例：三种真同步都能被认出 ──
T('正例 · storage 监听算同步',
  hasSyncMarker("window.addEventListener('storage', f)") === true, 'should be true');
T('正例 · dispatchEvent 广播算同步',
  hasSyncMarker("window.dispatchEvent(new Event(EV))") === true, 'should be true');
T('正例 · 监听 *_CHANGED 常量算同步',
  hasSyncMarker('window.addEventListener(DISPATCH_CHANGED_EVENT, f)') === true, 'should be true');
T('正例 · 监听 -changed 字面量算同步',
  hasSyncMarker("window.addEventListener('nianchu-changed', f)") === true, 'should be true');

// ── keysOf：字面量 / 常量间接引用都要抽出来 ──
const src = `
const KEY_A = 'k-a';
const KEY_B = 'k-b';
localStorage.getItem(KEY_A);
localStorage.setItem('k-lit', 'x');
localStorage.removeItem(KEY_B);
`;
const ks = keysOf(src);
T('正例 · keysOf 抽字面量', ks.includes('k-lit'), JSON.stringify(ks));
T('正例 · keysOf 抽常量间接引用', ks.includes('k-a') && ks.includes('k-b'), JSON.stringify(ks));

// ── 反例：没用到 localStorage 的源码抽不出 key ──
T('反例 · 无 localStorage 调用 ⇒ 空', keysOf('const a = 1;').length === 0, 'wrong');

const ok = pass === total;
console.log('  跨组件存储同步检查 · 反例自检');
console.log(lines.join('\n'));
console.log('\n  自检 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
