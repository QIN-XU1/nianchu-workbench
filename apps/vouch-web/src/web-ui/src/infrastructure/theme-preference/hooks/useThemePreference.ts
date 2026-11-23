import { useCallback, useSyncExternalStore } from 'react';
import { themePreferenceService, type ThemePreferenceState } from '../core/ThemePreferenceService';
import type { ThemeMode } from '../types';

export interface ThemePreferenceControls extends ThemePreferenceState {
  setMode: (mode: ThemeMode) => Promise<void>;
}

// 引用稳定：`useSyncExternalStore` 在每次渲染后都会重新取快照，返回新对象会
// 让 React 认为状态一直在变并无限重渲染。服务内部已按值缓存，这里再固定一次
// 绑定，保证 `setMode` 的引用也不变。
const setMode = (mode: ThemeMode): Promise<void> => themePreferenceService.setMode(mode);

function subscribe(onStoreChange: () => void): () => void {
  return themePreferenceService.subscribe(() => onStoreChange());
}

function getSnapshot(): ThemePreferenceState {
  return themePreferenceService.getState();
}

/**
 * 订阅主题模式。
 *
 * 快照来自 appearance 系统本身，所以设置页在别处（例如「内置主题」下拉）切换
 * 外观包后，这里会立即跟着变，不需要额外的同步逻辑。
 */
export function useThemePreference(): ThemePreferenceControls {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const handleSetMode = useCallback(setMode, []);
  return { ...state, setMode: handleSetMode };
}
