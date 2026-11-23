import type { ComponentType } from 'react';
import type { SceneId } from './registry';
import Overview from './Overview';
import Session from './Session';
import Verify from './Verify';
import Capabilities from './Capabilities';
import Tasks from './Tasks';
import Memory from './Memory';
import Net from './Net';
import Settings from './Settings';
import About from './About';

/** 场景 id -> 视图。注册表与视图表必须一一对应（验收会断言）。 */
export const SCENE_VIEWS: Record<SceneId, ComponentType> = {
  overview: Overview,
  session: Session,
  verify: Verify,
  capabilities: Capabilities,
  tasks: Tasks,
  memory: Memory,
  net: Net,
  settings: Settings,
  about: About,
};
