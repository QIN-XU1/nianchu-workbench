import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useSkillsSceneStore } from '@/app/scenes/skills/skillsSceneStore';
import { getActiveSurfaceScope, isLocalSurface, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { isVisibleSidebarPin, sidebarPreferences } from './sidebarPreferences';
import { sidebarRegistry } from './sidebarContributions';
import { selectedSidebarEntry, type SidebarContext } from './sidebarRegistry';

export function useSidebarNavigation() {
  const entries = useSyncExternalStore(sidebarRegistry.subscribe, sidebarRegistry.getSnapshot, sidebarRegistry.getSnapshot);
  const pinnedIds = useStore(sidebarPreferences, state => state.pinnedIds);
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const activeSceneId = useSceneStore(state => state.activeTabId);
  const skillsTab = useSkillsSceneStore(state => state.activeTab);
  const context: SidebarContext = {
    activeSceneId, skillsTab, isDesktop: isTauriRuntime(),
    isPeer: !isLocalSurface(scope.surfaceId), surfaceId: scope.surfaceId,
  };
  // Retain old preferences on disk while retiring the former standalone page pin.
  // 【2026-11-18 用户要求】只强制保留「场景」入口（工作台改名而来）；
  // 任务分派 / 场景记忆 已删除，不再强制并进固定项。
  // 同时把「磁盘里还留着、但注册表里已经没有」的旧 id 过滤掉 ——
  // 否则界面会渲染出「暂不可用的入口 (builtin.dispatch)」这种占位行。
  const known = new Set(entries.map(e => e.id));
  const visiblePinnedIds = Array.from(new Set([...pinnedIds.filter(isVisibleSidebarPin), 'builtin.workbench']))
    .filter(id => known.has(id));
  return { entries, pinnedIds: visiblePinnedIds, context, scope, selectedId: selectedSidebarEntry(entries, visiblePinnedIds, context) };
}
