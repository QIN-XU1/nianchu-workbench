import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import BenchmarkScene from '../benchmark/BenchmarkScene';
import { SCENE_CONFIGS, DEFAULT_SCENE_ID } from './scenePanels/configs';
import { takeFocusScene, subscribeFocusScene } from './sceneFocus';
import './WorkbenchScene.scss';

/**
 * 场景页 —— 单场景工作台（批次 Z.28）
 *
 * 【2026-11-23 用户要求（第三次纠正）】
 *   原版把每个场景画成「4 列面板网格」（仪表盘 KPI、图表、列表全平铺），
 *   用户明确：**大部分场景没用、设计太丑、理念形式也不对**。
 *   标杆场景上下滑动还滑不动 —— 根因就是网格把内容塞进
 *   `overflow:hidden` + `grid-auto-rows: minmax(0,1fr)` 的容器里，
 *   面板各自滚、整页不滚，指针一旦落在面板边框/间隙上就没得滚。
 *
 * 所以现在改成：
 *   ① 一屏只有**一个场景**，左边窄栏是场景列表（切场景 = 换工作台）
 *   ② 每个场景有自己的工作台主体（`SCENE_BODIES`），**不套固定版式**
 *      —— 标杆就是它自己的两栏（参照项目 + 详情），未来的场景各写各的
 *   ③ 滚动交给场景主体自己管：整页只有一个滚动容器，
 *      不再有「面板内层滚动 + 外层隐藏」的嵌套陷阱
 *
 * 现在只保留「标杆」：其余 11 个神经记忆元场景等整体界面定稿后再补。
 */

type SceneBodyProps = { id: string; onSelect: (label: string) => void };

/** 每个场景的工作台主体；没有专属主体的场景走兜底（如实说明还没做）。 */
const SCENE_BODIES: Record<string, (p: SceneBodyProps) => React.ReactNode> = {
  benchmark: () => <BenchmarkScene />,
};

function FallbackSceneBody({ id, onSelect }: SceneBodyProps) {
  const cfg = SCENE_CONFIGS.find((s) => s.id === id);
  return (
    <div className="wb-scenes__fallback">
      <h2 className="wb-scenes__fallback-title">{cfg?.name ?? id}</h2>
      <p className="wb-scenes__fallback-sub">{cfg?.description ?? '这个场景还没有专属工作台。'}</p>
      <p className="wb-scenes__fallback-hint">
        场景工作台按场景单独设计 —— 没做出来之前这里不硬塞「看起来像样」的面板。
      </p>
      <button type="button" className="wb-scenes__fallback-btn" onClick={() => onSelect(cfg?.name ?? id)}>
        记下这个场景
      </button>
    </div>
  );
}

export default function WorkbenchScene() {
  const [current, setCurrent] = useState<string>(() => {
    const focus = takeFocusScene();
    if (focus && SCENE_CONFIGS.some((c) => c.id === focus)) return focus;
    if (SCENE_CONFIGS.some((c) => c.id === DEFAULT_SCENE_ID)) return DEFAULT_SCENE_ID;
    return SCENE_CONFIGS[0]?.id ?? 'benchmark';
  });
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  /** 首页双击 → 已挂载时也要切过去（订阅通道） */
  useEffect(() => subscribeFocusScene((id) => {
    if (!SCENE_CONFIGS.some((c) => c.id === id)) return;
    setCurrent(id);
    setFlash('已进入「' + (SCENE_CONFIGS.find((c) => c.id === id)?.name ?? id) + '」');
  }), []);

  useEffect(() => {
    if (!flash) return undefined;
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2400);
    return () => { if (flashTimer.current) window.clearTimeout(flashTimer.current); };
  }, [flash]);

  const onSelect = useCallback((label: string) => setFlash('已选中：' + label), []);

  if (!SCENE_CONFIGS.length) {
    return (
      <div className="wb wb--empty">
        <div className="wb__empty">
          <div className="wb__empty-title">没有可用的场景配置</div>
        </div>
      </div>
    );
  }

  const cfg = SCENE_CONFIGS.find((s) => s.id === current) ?? SCENE_CONFIGS[0];
  const Body = SCENE_BODIES[cfg.id] ?? ((p: SceneBodyProps) => <FallbackSceneBody {...p} />);

  return (
    <div className="wb wb--scenes">
      <div className="wb__body wb-scenes">
        {/* 场景列表：切场景 = 换工作台，不再是「标签堆在顶上」 */}
        <nav className="wb-scenes__rail" aria-label="场景列表">
          {SCENE_CONFIGS.map((s) => {
            const on = s.id === cfg.id;
            return (
              <button
                key={s.id}
                type="button"
                className="wb-scenes__item"
                data-on={on ? '1' : '0'}
                data-scene-tab={s.id}
                aria-current={on ? 'page' : undefined}
                title={s.name}
                onClick={() => setCurrent(s.id)}
              >
                <span className="wb-scenes__item-ico" aria-hidden="true">{s.name.slice(0, 1)}</span>
                <span className="wb-scenes__item-label">{s.name}</span>
              </button>
            );
          })}
        </nav>

        {/* 场景工作台主体：每个场景自己的版式，不套固定网格 */}
        <main className="wb-scenes__workspace" data-scene={cfg.id}>
          <Fragment key={cfg.id}>
            <Body id={cfg.id} onSelect={onSelect} />
          </Fragment>
        </main>
      </div>
      {flash && (
        <div className="wb-scenes__flash" role="status">{flash}</div>
      )}
    </div>
  );
}
