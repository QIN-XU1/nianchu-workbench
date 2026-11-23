import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { notificationService } from '@/shared/notification-system';
import { useThemePreference } from '../hooks/useThemePreference';
import { THEME_MODES, type ThemeMode } from '../types';
import './ThemePreferencePanel.scss';

const MODE_ICONS: Record<ThemeMode, ReactNode> = {
  system: <Monitor aria-hidden="true" size={14} />,
  light: <Sun aria-hidden="true" size={14} />,
  dark: <Moon aria-hidden="true" size={14} />,
};

/**
 * 浅色 / 深色 / 跟随系统三档切换。
 *
 * 为什么不用 `@openbitfun/ui` 的 `SegmentedControl`：它的 `SegmentedControlOption`
 * 只接受 `value`，无法给每个选项带上外观契约所需的 `data-openbitfun-component` /
 * `data-openbitfun-part`；而这里的三档是外观包可以直接改样式的独立面。于是用同一
 * 套 token 复刻了它的分段样式（见同名 scss），每个分段同时挂 surface + part 与
 * `data-openbitfun-value`，外观包既能按 part 也能按值选择。
 *
 * 三档是 appearance 系统的视图，不是第二套主题状态：切换即 `appearanceService
 * .select(...)`，持久化与 `data-color-scheme` 都由 appearance 负责。
 */
export function ThemePreferencePanel() {
  const { t } = useTranslation('settings/appearance');
  const { mode, resolved, busy, setMode } = useThemePreference();

  const options = useMemo(
    () => THEME_MODES.map(value => ({
      value,
      label: t(`themeMode.${value}`),
      icon: MODE_ICONS[value],
    })),
    [t],
  );

  const handleChange = useCallback((value: ThemeMode) => {
    void setMode(value).catch(() => {
      // appearance 已自行回滚到上一个选择；这里只负责告诉用户「没切过去」，
      // 而不是让按钮亮着却毫无解释。
      notificationService.error(t('themeMode.saveFailed'));
    });
  }, [setMode, t]);

  /** WAI-ARIA 单选组：方向键在组内移动并立即生效，Home/End 跳到两端。 */
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = options.findIndex(option => option.value === mode);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + options.length) % options.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = options.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = options[nextIndex];
    if (!next || next.value === mode) return;
    handleChange(next.value);
    const group = event.currentTarget;
    const target = group.querySelector<HTMLButtonElement>(
      `[data-openbitfun-value="${next.value}"]`,
    );
    target?.focus();
  }, [handleChange, mode, options]);

  const resolvedLabel = resolved === 'dark' ? t('themeMode.dark') : t('themeMode.light');

  return (
    <div
      aria-busy={busy || undefined}
      data-openbitfun-component="theme-preference"
      data-openbitfun-part="root"
      data-testid="appearance-theme-mode"
    >
      <ConfigPageSection
        className="theme-pref-panel__section"
        description={t('themeMode.description')}
        title={t('themeMode.title')}
      >
        <ConfigPageRow align="center" balanced label={t('themeMode.modeLabel')}>
          <div
            className="theme-pref-panel__controls"
            data-openbitfun-component="theme-preference"
            data-openbitfun-part="controls"
          >
            <div
              aria-disabled={busy || undefined}
              aria-label={t('themeMode.modeLabel')}
              className="theme-pref-panel__group"
              data-disabled={busy ? 'true' : 'false'}
              data-openbitfun-component="theme-preference"
              data-openbitfun-part="group"
              data-testid="appearance-theme-mode-group"
              onKeyDown={handleKeyDown}
              role="radiogroup"
            >
              {options.map((option) => {
                const selected = option.value === mode;
                return (
                  <button
                    aria-checked={selected}
                    className="theme-pref-panel__segment"
                    data-openbitfun-component="theme-preference"
                    data-openbitfun-part="segment"
                    data-openbitfun-value={option.value}
                    disabled={busy}
                    key={option.value}
                    onClick={() => handleChange(option.value)}
                    role="radio"
                    tabIndex={selected ? 0 : -1}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="theme-pref-panel__icon"
                      data-openbitfun-component="theme-preference"
                      data-openbitfun-part="icon"
                    >
                      {option.icon}
                    </span>
                    <span
                      className="theme-pref-panel__label"
                      data-openbitfun-component="theme-preference"
                      data-openbitfun-part="label"
                    >
                      {option.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <span
              className="theme-pref-panel__resolved"
              data-openbitfun-component="theme-preference"
              data-openbitfun-part="resolvedHint"
              data-testid="appearance-theme-mode-resolved"
            >
              {t('themeMode.resolvedHint', { scheme: resolvedLabel })}
            </span>
          </div>
        </ConfigPageRow>
      </ConfigPageSection>
    </div>
  );
}
