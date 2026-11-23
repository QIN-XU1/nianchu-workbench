/**
 * neuron-math.js —— 3D 数学（从 neuron.js 拆出）
 *
 * 纯函数，零依赖。可单独测试。
 *
 * 拆分理由：neuron.js 2788 行，单文件过大。
 * 这些函数不依赖 canvas / 状态 / 闭包，可以安全抽出。
 */

const TAU = Math.PI * 2;

// ═══════════════════════════════════════════════════════════════
//  3D 数学
// ═══════════════════════════════════════════════════════════════
export function rotate3d(x, y, z, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y1 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  return { x: x1, y: y1, z: z2 };
}

/**
 * rotate3d 的**正确逆运算**
 *
 * 正变换顺序：先绕 Y 轴转 yaw，再绕 X 轴转 pitch
 *   → 逆变换必须按相反顺序：先绕 X 轴转 -pitch，再绕 Y 轴转 -yaw
 *
 * 自检：之前直接调 rotate3d(v, -yaw, -pitch) 顺序是错的
 *       导致拖拽偏差随距离累积（实测 2px → 21px）
 */
export function inverseRotate3d(x, y, z, yaw, pitch) {
  // ① 撤销 pitch（绕 X 轴）
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y0 = y * cp + z * sp;
  const z1 = -y * sp + z * cp;

  // ② 撤销 yaw（绕 Y 轴）
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x0 = x * cy - z1 * sy;
  const z0 = x * sy + z1 * cy;

  return { x: x0, y: y0, z: z0 };
}

export function project3d(p, cx, cy, fov) {
  const denom = fov / (fov + p.z);
  return { sx: cx + p.x * denom, sy: cy + p.y * denom, scale: denom, depth: p.z };
}

/** 归一化到单位球 */
export function normalize3(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
