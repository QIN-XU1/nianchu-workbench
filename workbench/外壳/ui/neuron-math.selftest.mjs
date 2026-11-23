#!/usr/bin/env node
/**
 * neuron-math.js / neuron-color.js 单元测试
 *
 * 这两个模块是纯函数，可以脱离浏览器直接测。
 * 这正是拆分的好处：以前它们藏在 2788 行的闭包里，无法单测。
 */

import {
  rotate3d, inverseRotate3d, project3d, normalize3,
} from './panels/neuron-math.js';
import { hexA, esc } from './panels/neuron-color.js';

const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok: !!ok });
  console.log((ok ? '  OK   ' : '  XX   ') + name + (detail ? '  ' + String(detail).slice(0, 50) : ''));
}

function close(a, b, eps) {
  return Math.abs(a - b) < (eps || 1e-9);
}

console.log('═'.repeat(66));
console.log('  neuron-math / neuron-color 单元测试');
console.log('═'.repeat(66));
console.log();

// ═══ rotate3d ═══
console.log('【rotate3d】');
{
  // 零旋转：原样返回
  const p = rotate3d(1, 2, 3, 0, 0);
  chk('零旋转不变', close(p.x, 1) && close(p.y, 2) && close(p.z, 3),
      `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`);
}
{
  // 绕 Y 轴 90°：(1,0,0) → (0,0,-1)
  const p = rotate3d(1, 0, 0, Math.PI / 2, 0);
  chk('Y轴90°: (1,0,0)→(0,0,-1)', close(p.x, 0) && close(p.z, -1),
      `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`);
}
{
  // 长度不变（旋转不改变模长）
  const p = rotate3d(3, 4, 5, 1.234, 0.567);
  const len0 = Math.sqrt(3 * 3 + 4 * 4 + 5 * 5);
  const len1 = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  chk('旋转保持模长', close(len0, len1, 1e-9), `${len0.toFixed(4)} vs ${len1.toFixed(4)}`);
}

// ═══ inverseRotate3d ═══
console.log();
console.log('【inverseRotate3d】');
{
  // 正旋转后逆旋转应还原
  const yaw = 0.7, pitch = -0.4;
  const orig = { x: 1.5, y: -2.3, z: 3.7 };
  const fwd = rotate3d(orig.x, orig.y, orig.z, yaw, pitch);
  const back = inverseRotate3d(fwd.x, fwd.y, fwd.z, yaw, pitch);
  const err = Math.sqrt(
    (back.x - orig.x) ** 2 + (back.y - orig.y) ** 2 + (back.z - orig.z) ** 2
  );
  chk('正逆旋转往返误差 < 1e-9', err < 1e-9, `误差 ${err.toExponential(2)}`);
}

// ═══ project3d ═══
console.log();
console.log('【project3d】');
{
  // z=0 时 scale=1
  const p = project3d({ x: 10, y: 20, z: 0 }, 100, 100, 500);
  chk('z=0 时 scale=1', close(p.scale, 1), `scale=${p.scale}`);
  chk('z=0 时坐标平移', close(p.sx, 110) && close(p.sy, 120), `(${p.sx},${p.sy})`);
}
{
  // z>0（更远）时 scale<1，坐标更靠近中心
  const p = project3d({ x: 100, y: 0, z: 500 }, 100, 100, 500);
  chk('z>0 时 scale<1', p.scale < 1, `scale=${p.scale.toFixed(3)}`);
  chk('z>0 时向中心收缩', Math.abs(p.sx - 100) < 100, `sx=${p.sx.toFixed(1)}`);
}

// ═══ normalize3 ═══
console.log();
console.log('【normalize3】');
{
  const p = normalize3({ x: 3, y: 4, z: 0 });
  const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  chk('归一化后模长=1', close(len, 1, 1e-9), `len=${len}`);
  chk('方向不变（3:4）', close(p.x, 0.6) && close(p.y, 0.8), `(${p.x},${p.y})`);
}
{
  // 零向量不崩
  const p = normalize3({ x: 0, y: 0, z: 0 });
  chk('零向量不崩溃', Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
      `(${p.x},${p.y},${p.z})`);
}

// ═══ hexA ═══
console.log();
console.log('【hexA】');
{
  const c = hexA('#FF0000', 0.5);
  chk('#RRGGBB 解析', c === 'rgba(255,0,0,0.5)', c);
}
{
  const c = hexA('#F00', 0.3);
  chk('#RGB 短格式解析', c === 'rgba(255,0,0,0.3)', c);
}
{
  // 这个 bug 之前修过：hexA 只认 #RRGGBB，rgb() 会 NaN
  const c = hexA('rgb(111,176,220)', 0.4);
  chk('rgb() 格式解析（曾 NaN）', c === 'rgba(111,176,220,0.4)', c);
}
{
  const c = hexA('#000000', 1);
  chk('alpha=1', c === 'rgba(0,0,0,1)', c);
}

// ═══ esc ═══
console.log();
console.log('【esc】');
{
  chk('转义 <script>', esc('<script>') === '&lt;script&gt;', esc('<script>'));
  chk('转义引号', esc('"a"') === '&quot;a&quot;', esc('"a"'));
  chk('转义 &', esc('a&b') === 'a&amp;b', esc('a&b'));
  chk('null → 空串', esc(null) === '', JSON.stringify(esc(null)));
}

// ═══ 反例验证 ═══
console.log();
console.log('【反例验证】');
{
  // 如果 rotate3d 是个空壳（永远返回原值），这个测试会失败
  const p = rotate3d(1, 0, 0, Math.PI / 2, 0);
  if (!close(p.x, 1)) {
    console.log('  OK   rotate3d 确实做了旋转（不是空壳）');
  } else {
    console.log('  XX   rotate3d 没做旋转 —— 是空壳！');
    R.push({ name: '反例', ok: false });
  }
}

console.log();
console.log('─'.repeat(66));
const passed = R.filter(x => x.ok).length;
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
console.log('─'.repeat(66));
console.log();

process.exit(R.every(x => x.ok) ? 0 : 1);
