import type { ComponentType } from 'react';
import {
  LayoutDashboard, MessageSquareText, ShieldCheck, Blocks, CalendarClock,
  BrainCircuit, Settings, Info, Globe, Globe,
} from 'lucide-react';

export type SceneId =
  | 'overview' | 'session' | 'verify' | 'capabilities'
  | 'tasks' | 'memory' | 'settings' | 'about';

export interface SceneDef {
  id: SceneId;
  label: string;
  /** 侧栏图标 */
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** 是否常驻在 SceneBar 上（不可关闭） */
  pinned?: boolean;
  /** 是否允许关闭 */
  closable?: boolean;
  /** 打开一次后一直保留，不重复开 */
  singleton?: boolean;
  /** 默认就打开 */
  defaultOpen?: boolean;
}

/**
 * 我们的 8 个场景。
 * 排序即导航顺序：会话与验证是产品立身之本，放前面。
 * 与 OpenBitFun 的场景清单无关 —— 那是它的产品，这是我们的。
 */
export const SCENES: SceneDef[] = [
  { id: 'session',      label: '会话',   icon: MessageSquareText, pinned: true,  closable: false, singleton: true, defaultOpen: true },
  { id: 'verify',       label: '验证',   icon: ShieldCheck,       pinned: true,  closable: false, singleton: true, defaultOpen: true },
  { id: 'capabilities', label: '能力',   icon: Blocks,            singleton: true },
  { id: 'tasks',        label: '任务',   icon: CalendarClock,     singleton: true },
  { id: 'memory',       label: '记忆',   icon: BrainCircuit,      singleton: true },
  { id: 'net',          label: '联网',   icon: Globe,             singleton: true },
  { id: 'overview',     label: '总览',   icon: LayoutDashboard,   singleton: true, defaultOpen: true },
  { id: 'settings',     label: '设置',   icon: Settings,          singleton: true },
  { id: 'about',        label: '关于',   icon: Info,              singleton: true },
];

export const SCENE_MAP = new Map(SCENES.map((s) => [s.id, s]));
export const DEFAULT_OPEN = SCENES.filter((s) => s.defaultOpen).map((s) => s.id);
export const DEFAULT_SCENE: SceneId = 'session';

export function isSceneId(v: string): v is SceneId {
  return SCENE_MAP.has(v as SceneId);
}
