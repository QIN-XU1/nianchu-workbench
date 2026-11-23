import { PanelRight, Minus, Square, X } from 'lucide-react';
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
