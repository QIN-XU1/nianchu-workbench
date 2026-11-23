#!/usr/bin/env node
/**
 * 场景判定的测试 —— 证明判据真的会拒绝
 *
 * 判据如果没有"拒绝"能力，就只是"点确定"按钮。
 */

import { judge } from './场景判定.mjs';

const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log((ok ? '  OK   ' : '  XX   ') + name + (detail ? '  ' + detail : ''));
}

console.log('═'.repeat(66));
console.log('  场景判定 · 测试');
console.log('═'.repeat(66));
console.log();

// ═══ 应该开的 ═══
console.log('【应该开的】');
{
  const r = judge({ repeat: 'yes', assets: 'yes', process: 'yes', boundary: '只碰A不碰B', halfYear: 'yes' });
  chk('全条件满足 → 该开', r.should === true && r.verdict === '该开', r.verdict);
}
{
  const r = judge({ repeat: 'yes', assets: 'no', process: 'no', boundary: '只碰A不碰B' });
  chk('核心通过但缺资产/流程 → 可以开（轻量）', r.should === true && r.verdict === '可以开（轻量）', r.verdict);
}

// ═══ 不该开的（这些才是真测试）═══
console.log();
console.log('【不该开的 —— 证明判据会拒绝】');

{
  const r = judge({ repeat: 'no', assets: 'yes', process: 'yes', boundary: '只碰A不碰B' });
  chk('一次性的活 → 拒绝', r.should === false && r.verdict === '一次性', r.verdict);
}
{
  const r = judge({ repeat: 'yes', assets: 'yes', process: 'yes', boundary: '不' });
  chk('边界说不清（<5字）→ 拒绝', r.should === false && r.verdict === '边界不清', r.verdict);
}
{
  const r = judge({ repeat: 'yes', assets: 'yes', process: 'yes', boundary: '' });
  chk('边界为空 → 拒绝', r.should === false, r.verdict);
}
{
  const r = judge({ repeat: 'yes', assets: 'yes', process: 'yes', boundary: '只碰A不碰B', halfYear: 'no' });
  chk('半年后不会单独开窗 → 拒绝', r.should === false && r.verdict === '不值得单独开窗', r.verdict);
}

// ═══ 边界测试 ═══
console.log();
console.log('【边界】');
{
  // 自检修复：'四个字符的' 实际是 5 个字，测试用例算错了
  // 用明确的长度验证
  const exactly5 = '一二三四五';   // 恰好 5 个汉字
  const r = judge({ repeat: 'yes', assets: 'yes', process: 'yes', boundary: exactly5 });
  chk('边界恰好 5 字（' + exactly5.length + '）→ 通过', r.should === true, r.verdict);
}
{
  const only4 = '一二三四';   // 4 个汉字
  const r = judge({ repeat: 'yes', assets: 'yes', process: 'yes', boundary: only4 });
  chk('边界 4 字（' + only4.length + '）→ 拒绝', r.should === false, r.verdict);
}
{
  // 不提供 halfYear 时不该因为"没答"而拒绝
  const r = judge({ repeat: 'yes', assets: 'yes', process: 'yes', boundary: '只碰A不碰B' });
  chk('未回答 halfYear → 不因此拒绝', r.should === true, r.verdict);
}

// ═══ 反例验证 ═══
console.log();
console.log('【反例验证】');
{
  // 如果判据永远返回 true，这个会失败
  const r = judge({ repeat: 'no', assets: 'no', process: 'no', boundary: 'x' });
  if (r.should === false) {
    console.log('  OK   判据确实会拒绝（不是"永远同意"的橡皮章）');
  } else {
    console.log('  XX   判据永远同意 —— 是橡皮章不是判据！');
    R.push({ name: '反例验证', ok: false });
  }
}

console.log();
console.log('─'.repeat(66));
const passed = R.filter(x => x.ok).length;
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
console.log('─'.repeat(66));
console.log();

process.exit(R.every(x => x.ok) ? 0 : 1);
