import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(process.cwd(), 'apps/agent-ui');
const w = (rel, content) => {
  const p = path.join(APP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  console.log('  ✓ ' + rel);
};

// ══════════════════════════════════════════════════════════════════════
// 往 OpenBitFun 的真实布局靠：去掉它没有的东西
//
// 实测真实布局（1550×926 截图 + 真实 DOM）：
//   [侧栏 216px] 搜索框 / 首页·任务看板 / 会话段 + 助理 / 底部设备名
//   [主区]      场景顶栏（左：场景标签胶囊；右：面板开关 + 窗口控件）
//               内容（欢迎 / 场景内容）
// 它**没有**：顶部品牌条、主区大标题行、堆在顶上的外观开关。
// 这三样是我自己加的，也是"看着不像个成熟产品"的主要来源。
// ══════════════════════════════════════════════════════════════════════

w('src/shell/Shell.tsx', `import { NavPanel } from './NavPanel';
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
`);

w('src/shell/SceneBar.tsx', `import { PanelRight, Minus, Square, X } from 'lucide-react';
import { SCENE_MAP, type SceneId } from '../scenes/registry';

/**
 * 场景顶栏：左边是场景标签胶囊，右边是面板开关 + 窗口控件。
 * 结构与 OpenBitFun 的 scene-top-bar 同构（左 leading / 右 trailing），
 * 但类名是我们自己的 —— 不混用它的 CSS module hash（那需要它的 JS 才有意义）。
 */
export function SceneBar({
  open, active, onOpen, onClose, title,
}: {
  open: SceneId[];
  active: SceneId;
  onOpen: (id: SceneId) => void;
  onClose: (id: SceneId) => void;
  title: string;
}) {
  return (
    <div className="vp-topbar">
      <div className="vp-tabs" role="tablist" aria-label={'场景标签页 · ' + title}>
        {open.map((id) => {
          const def = SCENE_MAP.get(id)!;
          const Icon = def.icon;
          return (
            <span key={id} className="vp-tab" role="tab" aria-selected={active === id}>
              <button type="button" className="vp-tab__hit" onClick={() => onOpen(id)}>
                <Icon size={13} strokeWidth={2} />
                <span>{def.label}</span>
              </button>
              {def.closable === false ? null : (
                <button
                  type="button"
                  className="vp-tab__close"
                  aria-label={'关闭 ' + def.label}
                  onClick={() => onClose(id)}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>

      <span className="vp-topbar__spacer" />

      <button type="button" className="vp-iconbtn" aria-label="展开右侧面板" title="展开右侧面板">
        <PanelRight size={15} strokeWidth={2} />
      </button>
      <span className="vp-topbar__sep" aria-hidden="true" />
      <div className="vp-wctl" aria-label="窗口控件">
        <button type="button" className="vp-wctl__btn" aria-label="最小化"><Minus size={11} strokeWidth={2} /></button>
        <button type="button" className="vp-wctl__btn" aria-label="最大化"><Square size={10} strokeWidth={2} /></button>
        <button type="button" className="vp-wctl__btn vp-wctl__btn--close" aria-label="关闭"><X size={11} strokeWidth={2} /></button>
      </div>
    </div>
  );
}
`);

w('src/shell/NavPanel.tsx', `import { Search, PanelLeft, Laptop } from 'lucide-react';
import { SCENES, type SceneId } from '../scenes/registry';

/**
 * 侧栏：搜索 → 导航项 → （留空给会话列表） → 底部状态。
 * 尺寸取自 OpenBitFun 的真实令牌：
 *   宽度 216px（layout.navigation-panel.inline-size）
 *   条高 30px（layout.navigation-panel.item-height）
 *   段头 24px、底栏 40px
 */
export function NavPanel({ active, onOpen }: { active: SceneId; onOpen: (id: SceneId) => void }) {
  return (
    <aside className="vp-nav">
      <div className="vp-nav__search">
        <Search size={13} strokeWidth={2} />
        <span className="vp-nav__ph">搜索</span>
        <kbd className="vp-nav__kbd">Ctrl K</kbd>
      </div>

      <nav className="vp-nav__list" aria-label="场景">
        {SCENES.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              className="vp-nav__item"
              aria-current={active === s.id ? 'page' : undefined}
              onClick={() => onOpen(s.id)}
            >
              <Icon size={15} strokeWidth={1.9} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="vp-nav__foot">
        <Laptop size={13} strokeWidth={1.8} />
        <span>这台 Windows</span>
        <span className="vp-nav__dot" data-state="unknown" aria-hidden="true" />
      </div>
    </aside>
  );
}
`);

// ── App：去掉顶部品牌条与外观开关；外观改由 URL 参数 + 后续 settings 场景控制 ──
w('src/App.tsx', `import { useEffect, useState } from 'react';
import { Shell } from './shell/Shell';

type Scheme = 'light' | 'dark';
type Density = 'compact' | 'cozy';

const LS_SCHEME = 'vouch.appearance.scheme';
const LS_DENSITY = 'vouch.appearance.density';

function fromUrl(key: string): string | null {
  try { return new URLSearchParams(location.search).get(key); } catch { return null; }
}

/**
 * 外观不再占用界面空间（真实产品也不在顶上加一排开关）。
 * 来源优先级：URL 参数 > localStorage > 默认。
 * 将来的「设置」场景会接管这两个值。
 */
export default function App() {
  const [scheme] = useState<Scheme>(() => {
    const u = fromUrl('scheme');
    if (u === 'light' || u === 'dark') return u;
    return (localStorage.getItem(LS_SCHEME) as Scheme) || 'light';
  });
  const [density] = useState<Density>(() => {
    const u = fromUrl('density');
    if (u === 'compact' || u === 'cozy') return u;
    return (localStorage.getItem(LS_DENSITY) as Density) || 'compact';
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-color-scheme', scheme);
    root.setAttribute('data-density', density);
    localStorage.setItem(LS_SCHEME, scheme);
    localStorage.setItem(LS_DENSITY, density);
  }, [scheme, density]);

  return <Shell />;
}
`);

console.log('\n  外壳已按 OpenBitFun 真实布局对齐');
