import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

/**
 * 主题模式面板对外暴露的样式面。
 *
 * `group` 是三档单选组本身，`segment` / `icon` / `label` 是每个模式按钮的组成
 * 部分，外观包可以只调其中一层（例如给选中段加边框）而不用整块覆盖。
 */
export const themePreferenceAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'theme-preference',
  parts: [
    { id: 'root' },
    { id: 'controls' },
    { id: 'group' },
    { id: 'segment' },
    { id: 'icon' },
    { id: 'label' },
    { id: 'resolvedHint' },
  ],
};
