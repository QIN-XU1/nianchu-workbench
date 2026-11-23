// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { RADIO_NAV_KEYS, isRadioNavKey, nextRadioIndex } from './rovingRadio';

describe('nextRadioIndex（原生 radio 的方向键约定）', () => {
  it('★向下/向右 → 后一项，到末尾回饶到第一项', () => {
    expect(nextRadioIndex(0, 5, 'ArrowDown')).toBe(1);
    expect(nextRadioIndex(0, 5, 'ArrowRight')).toBe(1);
    expect(nextRadioIndex(4, 5, 'ArrowDown')).toBe(0);
    expect(nextRadioIndex(4, 5, 'ArrowRight')).toBe(0);
  });

  it('★向上/向左 → 前一项，到第一项回饶到末项', () => {
    expect(nextRadioIndex(2, 5, 'ArrowUp')).toBe(1);
    expect(nextRadioIndex(2, 5, 'ArrowLeft')).toBe(1);
    expect(nextRadioIndex(0, 5, 'ArrowUp')).toBe(4);
    expect(nextRadioIndex(0, 5, 'ArrowLeft')).toBe(4);
  });

  it('Home / End 跳到首尾', () => {
    expect(nextRadioIndex(3, 5, 'Home')).toBe(0);
    expect(nextRadioIndex(1, 5, 'End')).toBe(4);
  });

  it('★没聚焦任何一项（-1）→ 向下从第一项开始、向上从末项开始', () => {
    expect(nextRadioIndex(-1, 5, 'ArrowDown')).toBe(0);
    expect(nextRadioIndex(-1, 5, 'ArrowUp')).toBe(4);
  });

  it('★越界下标按「没聚焦」处理（列表变短后不崩）', () => {
    expect(nextRadioIndex(9, 5, 'ArrowDown')).toBe(0);
    expect(nextRadioIndex(9, 5, 'ArrowUp')).toBe(4);
    expect(nextRadioIndex(-3, 5, 'End')).toBe(4);
  });

  it('只有一项时方向键停在原地（不越界）', () => {
    expect(nextRadioIndex(0, 1, 'ArrowDown')).toBe(0);
    expect(nextRadioIndex(0, 1, 'ArrowUp')).toBe(0);
    expect(nextRadioIndex(0, 1, 'Home')).toBe(0);
    expect(nextRadioIndex(0, 1, 'End')).toBe(0);
  });

  it('★不归本模块管的键 → null（Tab / Esc / Enter 必须原样放行）', () => {
    for (const key of ['Tab', 'Escape', 'Enter', ' ', 'a', 'PageDown']) {
      expect(nextRadioIndex(1, 5, key)).toBeNull();
    }
  });

  it('★total 为 0 / 负数 / 非数字 → null（没有档位可切，不编下标）', () => {
    expect(nextRadioIndex(0, 0, 'ArrowDown')).toBeNull();
    expect(nextRadioIndex(0, -3, 'ArrowDown')).toBeNull();
    expect(nextRadioIndex(0, Number.NaN, 'ArrowDown')).toBeNull();
    expect(nextRadioIndex(0, Number.POSITIVE_INFINITY, 'ArrowDown')).toBeNull();
  });

  it('小数 total 向下取整（不会算出半个下标）', () => {
    expect(nextRadioIndex(0, 4.9, 'End')).toBe(3);
  });

  it('★宿主键 1/2/3/4 直选不算导航键（不抢数字输入）', () => {
    expect(nextRadioIndex(0, 5, '1')).toBeNull();
    expect(isRadioNavKey('2')).toBe(false);
  });

  it('isRadioNavKey 只认六个导航键', () => {
    expect(RADIO_NAV_KEYS.every((k) => isRadioNavKey(k))).toBe(true);
    expect(isRadioNavKey('Tab')).toBe(false);
    expect(isRadioNavKey('Esc')).toBe(false);
  });
});
