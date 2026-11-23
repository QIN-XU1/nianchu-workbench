/**
 * 单选组（radio group）键盘导航（批次 Z.18）。
 *
 * 【为什么要单独一层】弹层里的五个档位是 `role="radio"` 的按钮，不是原生 `<input type=radio>`：
 * 浏览器不会自动给它们方向键行为，于是「键盘用户进了弹层只能 Tab 一个个挪」。
 * 原生 radio 的约定是：**方向键换选中并移动焦点**，Home/End 跳到首/尾，到边界回绕。
 * 这里把这套约定写成纯函数，组件只负责把返回值落到 DOM 上（focus + 选中）。
 *
 * 边界（写死，不猜）：
 *  - 未知键返回 `null`（调用方原样放行，不要吞掉 Tab / Esc / Enter）
 *  - `total <= 0` 返回 `null`（没有档位可切）
 *  - 当前下标越界（没聚焦任何一项、或列表刚变短）按「从第一项开始」处理：
 *    向下取 0，向上取 `total - 1` —— 与原生 radio 在未选中时的行为一致
 */

/** 会被本模块接管的键；其余键返回 null 由调用方处理。 */
export const RADIO_NAV_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const;

export type RadioNavKey = (typeof RADIO_NAV_KEYS)[number];

/**
 * 计算按键后应该聚焦/选中的下标。
 * @param current 当前聚焦项下标（可能为 -1：没有任何一项被聚焦）
 * @param total 档位总数
 * @param key 键盘事件里的 `event.key`
 * @returns 目标下标；不归本模块管的键返回 null
 */
export function nextRadioIndex(current: number, total: number, key: string): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const size = Math.floor(total);
  const hasCurrent = Number.isInteger(current) && current >= 0 && current < size;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return hasCurrent ? (current + 1) % size : 0;
    case 'ArrowUp':
    case 'ArrowLeft':
      return hasCurrent ? (current - 1 + size) % size : size - 1;
    case 'Home':
      return 0;
    case 'End':
      return size - 1;
    default:
      return null;
  }
}

/** 该键是否属于单选组导航（调用方据此决定是否 preventDefault）。 */
export function isRadioNavKey(key: string): key is RadioNavKey {
  return (RADIO_NAV_KEYS as readonly string[]).includes(key);
}
