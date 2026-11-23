import { NavPanel } from './NavPanel';
import { SceneBar } from './SceneBar';
import { useSceneRoute } from './useSceneRoute';
import { SCENE_MAP } from '../scenes/registry';
import { SCENE_VIEWS } from '../scenes';

/**
 * 外壳（按 OpenBitFun 真实布局对齐后）：
 *
 *   ┌────────────┬──────────────────────────────────────────┐
 *   │ 侧栏 216px │ 场景顶栏：标签胶囊 ····· 面板开关 窗口控件 │
 *   │            ├──────────────────────────────────────────┤
 *   │ 搜索        │                                          │
 *   │ 导航项      │ 内容（场景视图）                          │
 *   │ 底部状态    │                                          │
 *   └────────────┴──────────────────────────────────────────┘
 *
 * 刻意去掉了三样它没有的东西：顶部品牌条、主区大标题行、堆在顶上的外观开关。
 */
export function Shell() {
  const { open, active, openScene, closeScene } = useSceneRoute();
  const def = SCENE_MAP.get(active)!;
  const View = SCENE_VIEWS[active];

  return (
    <div className="vp-root">
      <NavPanel active={active} onOpen={openScene} />
      <main className="vp-main">
        <SceneBar
          open={open}
          active={active}
          onOpen={openScene}
          onClose={closeScene}
          title={def.label}
        />
        <div className="vp-content">
          <View />
        </div>
      </main>
    </div>
  );
}
