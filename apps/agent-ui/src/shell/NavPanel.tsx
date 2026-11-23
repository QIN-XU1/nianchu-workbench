import { Search, PanelLeft, Laptop } from 'lucide-react';
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
