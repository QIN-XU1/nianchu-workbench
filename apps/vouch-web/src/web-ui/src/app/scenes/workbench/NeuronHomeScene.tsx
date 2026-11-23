import { useEffect, useMemo, useRef, useState } from 'react';
import { Graph } from '@antv/g6';
import type { IElementEvent } from '@antv/g6';
import topologyJson from '../vouch/data/topology.json';
import { useSceneManager } from '@/app/hooks/useSceneManager';
import { setFocusScene } from './sceneFocus';
import './NeuronHomeScene.scss';

/**
 * 首页 —— 神经记忆元（知识图谱）
 *
 * ══ 为什么换成 AntV G6 ════════════════════════════════════════
 * 前一版用 React Flow + 自己写的 forceLayout，问题：
 *   · 节点是 HTML 卡片，靠 CSS 画圆 —— 丑，且缩放时文字跟着糊
 *   · 防重叠要自己实现，实测拖动后节点会叠在一起
 *   · 高亮/变暗靠 className 切换，React Flow 对边重渲染有丢失（本项目踩过两次）
 * G6 是专业图可视化引擎，canvas 渲染、自带 collide 防重叠、
 * `click-select` 三态（selected/active/inactive）、`hover-activate` 悬停激活。
 *
 * ══ 配置照抄 Yuxi（不是凭感觉调）══════════════════════════════
 * 来源：D:/refs/Yuxi/frontend/src/modules/knowledge/ui/GraphCanvas.vue
 *   L106-119  layout: d3-force + preventOverlap + collide
 *   L308-328  node: circle, size 按 degree, opacity .9, stroke 1.5, shadowBlur 4
 *   L330-343  edge: quadratic, endArrow
 *   L345-360  behaviors: drag-element / zoom-canvas / drag-canvas /
 *             hover-activate / click-select(degree:1, neighborState:active,
 *             unselectedState:inactive)
 *
 * 唯一改动：size 公式。Yuxi 用 min(15+deg*5, 50)，我们的度数上限是 15 不是 7，
 * 直套会让 7 个节点全顶到 50px 一样大（实测）。改成按 0..15 校准的绝对刻度。
 *
 * ══ 这一页不画 agent ═════════════════════════════════════════
 * 主 agent 是全局 FloatingMiniChat，已停靠右侧。
 */

type TNode = {
  id: string; label: string; layer: string; kind: string;
  path: string | null; sub: string; sceneId?: string;
  items?: number; closed?: number; independent?: number;
};
type TEdge = { id: string; from: string; to: string; how: string; label: string };
type Topo = {
  at: string; state: string;
  layers: Array<{ id: string; name: string; desc: string }>;
  nodes: TNode[]; edges: TEdge[];
  stats: { nodes: number; edges: number; layers: number; byLayer: Record<string, number> };
};

const DATA = topologyJson as unknown as Topo;
const BY_ID = new Map(DATA.nodes.map((n) => [n.id, n]));

/** 层 → 颜色（节点填充；取值接近 Yuxi 的 NODE_LABEL_COLORS 明度带） */
const LAYER_COLOR: Record<string, string> = {
  L0: '#e0716f',   // 宪法：红
  L1: '#f6bd16',   // 共享层：黄
  L2: '#9581cc',   // 场景：紫
  L3: '#3996ae',   // 运行时：蓝
  L4: '#8c8c8c',   // 归档：灰
};

/**
 * 连线语义 → 颜色 + 中文名。
 * 之前图例直接显示 guards / reads / writes 这些英文 key，中英混排很难看，
 * 也没人知道 "injects" 是什么意思。这里给每条关系一个人话名。
 */
const HOW_COLOR: Record<string, { color: string; label: string }> = {
  guards: { color: '#f27c7c', label: '守护' },
  reads: { color: '#6dc8ec', label: '读取' },
  writes: { color: '#9581cc', label: '写入' },
  injects: { color: '#faad14', label: '注入' },
  serves: { color: '#13c2c2', label: '供给' },
  archives: { color: '#99add1', label: '归档' },
  flow: { color: '#c9cfd8', label: '流转' },
};

/**
 * 读当前主题的颜色（G6 画在 canvas 上，拿不到 CSS 继承，只能主动读令牌）。
 * 之前这些值全是硬编码浅色：暗色主题下画布仍是白底、标签是深色字。
 */
function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const surface = v('--openbitfun-color-surface-panel', '#ffffff');
  return {
    label: v('--openbitfun-color-content-primary', '#3b4252'),
    halo: surface,
    nodeStroke: surface,
    shadow: v('--openbitfun-color-border-subtle', '#c9cfd8'),
    edge: v('--openbitfun-color-border-base', '#c9cfd8'),
    accent: v('--openbitfun-color-accent-default', '#945eff'),
  };
}

/** 尺寸：绝对刻度，按我们实测的度数上限 15 校准（不是 Yuxi 的 7） */const DOT_MIN = 14;
const DOT_MAX = 52;
const DOT_DEG_MAX = 15;
const dotSize = (deg: number) => {
  const d = Math.max(0, Math.min(deg, DOT_DEG_MAX));
  return DOT_MIN + (d / DOT_DEG_MAX) * (DOT_MAX - DOT_MIN);
};

/**
 * 力导向参数 —— 直接照搬 Yuxi GraphCanvas.vue:106-119。
 * 一个数都没改：charge -400 / link distance 100 strength .8 /
 * center strength .1 / collide radius 40。
 */
const LAYOUT = {
  type: 'd3-force',
  preventOverlap: true,
  alphaDecay: 0.1,
  alphaMin: 0.01,
  velocityDecay: 0.6,
  iterations: 150,
  force: {
    center: { x: 0.5, y: 0.5, strength: 0.1 },
    charge: { strength: -400, distanceMax: 600 },
    link: { distance: 100, strength: 0.8 },
  },
  /**
   * 防重叠半径从 40 提到 56：
   * 实测 40 时节点标签会互相压住（「实施计划」压「改进台账」）。
   * 56 是圆半径上限(26) + 标签高度余量，够用且不至于散得看不出结构。
   */
  collide: { radius: 56, strength: 0.85, iterations: 4 },
};

export default function NeuronHomeScene() {
  const { openScene } = useSceneManager();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const [sel, setSel] = useState<TNode | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** 每个节点的度 —— 决定圆的直径 */
  const degreeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of DATA.edges) {
      m.set(e.from, (m.get(e.from) ?? 0) + 1);
      m.set(e.to, (m.get(e.to) ?? 0) + 1);
    }
    return m;
  }, []);

  /** G6 的图数据格式 */
  const graphData = useMemo(() => ({
    nodes: DATA.nodes.map((n) => ({
      id: n.id,
      data: {
        label: n.label,
        degree: degreeMap.get(n.id) ?? 0,
        color: LAYER_COLOR[n.layer] ?? '#8c8c8c',
        layer: n.layer,
        kind: n.kind,
      },
    })),
    edges: DATA.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      data: { label: e.label || e.how, color: (HOW_COLOR[e.how] ?? HOW_COLOR.flow).color, how: e.how },
    })),
  }), [degreeMap]);

  const [themeRev, setThemeRev] = useState(0);

  /**
   * 主题切换后要重建图：G6 的颜色是初始化时写进 canvas 的，
   * 光换 CSS 变量不会让已经画好的节点/标签改色。
   */
  useEffect(() => {
    const html = document.documentElement;
    const obs = new MutationObserver(() => setThemeRev((n) => n + 1));
    obs.observe(html, {
      attributes: true,
      attributeFilter: ['data-color-scheme', 'data-openbitfun-appearance', 'data-openbitfun-appearance-mode'],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    let disposed = false;
    let graph: Graph | null = null;
    let ro: ResizeObserver | null = null;
    /** render() 的完成信号 —— 销毁要等它，见 cleanup 里的长注释 */
    let renderPromise: Promise<void> | null = null;

    /**
     * fitView 是**异步动画**：await 期间组件可能已经卸载并 destroy 掉 graph，
     * 此时 G6 的 viewport 拿到的是空 context，`camera` getter 会抛
     * `Cannot read properties of undefined (reading 'getCamera')`。
     * 同步 try/catch 拦不住 Promise 拒绝，必须显式接住。
     */
    const safeFitView = (g: Graph | null): void => {
      if (!g || g.destroyed) return;
      try {
        void Promise.resolve(g.fitView({ when: 'always' })).catch(() => {});
      } catch { /* 版本差异，忽略 */ }
    };

    /**
     * 【2026-11-22 用户实测】进入首页时神经图「先放大、再缩回」闪烁。
     * 根因：ResizeObserver 的首次回调 与 graph.render() 完成 几乎同帧各调一次 fitView，
     * 两次适配之间容器宽度还在变（右侧主 agent 停靠让位），于是看起来像放大又拉回。
     * 这里把同一帧内的多次 fit 合并成一次（rAF 去抖），并且全图关掉动画（见下面 animation:false），
     * 让适配是「直接到位」而不是「动画到位」。
     */
    let fitFrame = 0;
    const scheduleFitView = (): void => {
      if (fitFrame) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = 0;
        if (!disposed) safeFitView(graph);
      });
    };

    // 容器尺寸为 0 时不要初始化（Yuxi 同样有 MAX_RETRIES 重试逻辑）
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (w === 0 || h === 0) {
      setErr('画布尺寸为 0，无法初始化');
      return;
    }

    try {
      const theme = readThemeColors();
      graph = new Graph({
        container: box,
        width: w,
        height: h,
        autoResize: true,
        /** 全图关闭动画：适配/布局直接到位，避免进入首页时「放大又拉回」的闪烁 */
        animation: false,
        /** 图与画布边缘留 56px，标签不贴边被裁 */
        autoFit: { type: 'view', options: { when: 'always' }, animation: false },
        data: graphData,
        layout: LAYOUT,
        node: {
          type: 'circle',
          style: {
            labelText: (d: { data?: { label?: string } }) => d.data?.label ?? '',
            labelFill: theme.label,
            labelFontSize: 11,
            labelFontWeight: 500,
            labelPlacement: 'bottom',
            labelMaxWidth: '300%',
            /**
             * 标签加白色描边：图上连线密集时，纯文字会压在线上看不清。
             * G6 支持 labelBackground（真底色块）；这里用更轻的方式 ——
             * 描边 + 光晕，视觉上更干净，也不遮挡节点。
             */
            labelStroke: theme.halo,
            labelLineWidth: 3,
            labelBackground: false,
            size: (d: { data?: { degree?: number } }) => dotSize(d.data?.degree ?? 0),
            fill: (d: { data?: { color?: string } }) => d.data?.color ?? '#8c8c8c',
            opacity: 0.9,
            stroke: theme.nodeStroke,
            lineWidth: 1.5,
            shadowColor: theme.shadow,
            shadowBlur: 4,
            cursor: 'pointer',
          },
          /**
           * 三态样式（G6 v5 是 node.state，不是顶层 nodeState —— 见
           * node_modules/@antv/g6/lib/spec/element/node.d.ts:32）。
           * 对应 behaviors.click-select 的 state/neighborState/unselectedState。
           */
          state: {
            selected: { lineWidth: 3, stroke: theme.accent, opacity: 1 },
            active: { opacity: 1, lineWidth: 2, stroke: theme.halo },
            inactive: { opacity: 0.2 },
          },
        },
        edge: {
          type: 'quadratic',
          style: {
            stroke: (d: { data?: { color?: string } }) => d.data?.color ?? theme.edge,
            opacity: 0.75,
            lineWidth: 1.2,
            endArrow: true,
            endArrowSize: 6,
          },
          state: {
            active: { opacity: 1, lineWidth: 2 },
            inactive: { opacity: 0.12 },
          },
        },
        behaviors: [
          'drag-element',
          'zoom-canvas',
          'drag-canvas',
          'hover-activate',
          {
            type: 'click-select',
            degree: 1,
            state: 'selected',
            neighborState: 'active',
            unselectedState: 'inactive',
            multiple: false,
          },
        ],
      });

      graphRef.current = graph;

      // 【2026-11-21 用户实测】首帧容器可能还是全宽（右侧主 agent 停靠尚未让位），
      // G6 按当时的 clientWidth 建画布后不会随容器变窄再缩 → 首页图右移且被面板裁、左侧大片空白。
      // 这里监听容器尺寸：一变（含首次回调）就 resize + fitView，使首页与设置等页面一样填满可用宽度。
      ro = new ResizeObserver(() => {
        const nw = box.clientWidth;
        const nh = box.clientHeight;
        if (!nw || !nh || !graph || disposed) return;
        const g = graph as unknown as { resize?: (w: number, h: number) => void; setSize?: (w: number, h: number) => void };
        try { if (g.resize) g.resize(nw, nh); else g.setSize?.(nw, nh); } catch { /* 版本差异，忽略 */ }
        scheduleFitView();
      });
      ro.observe(box);

      // 写法同 Yuxi GraphCanvas.vue:365-367 —— evt.target.id
      graph.on('node:click', (evt: IElementEvent) => {
        const id = evt.target?.id;
        if (!id) return;
        const n = BY_ID.get(id);
        if (n) setSel(n);
      });

      graph.on('node:dblclick', (evt: IElementEvent) => {
        const id = evt.target?.id;
        if (!id) return;
        const n = BY_ID.get(id);
        if (n && n.kind === 'scene' && n.sceneId) {
          setFocusScene(n.sceneId);
          openScene('workbench');
        }
      });

      graph.on('canvas:click', () => setSel(null));

      // v5 必须显式 render
      renderPromise = graph.render()
        .then(() => {
          if (disposed) return;
          /**
           * 渲染完再 fitView：不加这一步时图层只占画布中间一小块，
           * 上下大片留白（实测截图）。padding 60 让标签也不会贴边被裁。
           */
          // FitViewOptions 只有 when/direction，没有 padding（查过 G6 5.1.1 的 d.ts），
          // 边距走 viewport.padding，自适应走 autoFit。
          scheduleFitView();
        })
        .catch((e: unknown) => {
          if (!disposed) setErr('渲染失败：' + String((e as Error)?.message ?? e).slice(0, 120));
        });
    } catch (e) {
      setErr('初始化失败：' + String((e as Error)?.message ?? e).slice(0, 160));
    }

    return () => {
      disposed = true;
      if (fitFrame) { window.cancelAnimationFrame(fitFrame); fitFrame = 0; }
      try { ro?.disconnect(); } catch { /* 忽略 */ }
      graphRef.current = null;
      const g = graph;
      graph = null;
      /**
       * 【2026-11-22 用户实测】主题切换 / 卸载时曾抛
       * `TypeError: Cannot read properties of undefined (reading 'getCamera')`
       * （NeuronHomeScene-*.js 里 ViewportController 构造 → transform → cancelAnimation）。
       *
       * 根因：G6 5.1.1 的 `prepare()` 是
       *   await initCanvas()（内部 `yield canvas.ready`）→ initRuntime()
       * 中间**没有**再判一次 `destroyed`。若 destroy() 恰好落在 `canvas.ready`
       * 的等待窗口里，`this.context` 已被换成 `{}`，紧接着的
       * `new ViewportController(context)` 读 `context.canvas.getCamera()` 就是 undefined。
       *
       * 所以销毁必须**等 render 落定**（resolve 或 reject 都算），
       * 不能同步 destroy 一个还在 prepare 的实例。
       */
      void (renderPromise ?? Promise.resolve()).finally(() => {
        try { g?.destroy(); } catch { /* 忽略清理错误 */ }
      });
    };
  }, [graphData, openScene, themeRev]);

  /** 与选中节点相关的连线（底栏显示） */
  const rel = useMemo(() => {
    if (!sel) return { out: [], in: [] };
    return {
      out: DATA.edges.filter((e) => e.from === sel.id).map((e) => ({ ...e, other: BY_ID.get(e.to)?.label ?? e.to })),
      in: DATA.edges.filter((e) => e.to === sel.id).map((e) => ({ ...e, other: BY_ID.get(e.from)?.label ?? e.from })),
    };
  }, [sel]);

  return (
    <div className="nhn">
      <div className="nhn__body">
        <section className="nhn__canvas">
          <div className="nhn__bar">
            <span className="nhn__bar-title">神经记忆元 · 记忆网络</span>
            <span className="nhn__bar-meta">
              {DATA.stats.nodes} 个记忆元 · {DATA.stats.edges} 条关系
            </span>
            <span className="nhn__bar-state" data-state={DATA.state}>{DATA.state}</span>
          </div>

          <div className="nhn__legend">
            {DATA.layers.map((l) => (
              <span key={l.id} className="nhn__legend-item" data-tone={l.id}>
                <i style={{ background: LAYER_COLOR[l.id] }} /> {l.id} {l.name}
              </span>
            ))}
            <span className="nhn__legend-sep" />
            {Object.entries(HOW_COLOR).map(([k, v]) => (
              <span key={k} className="nhn__legend-how" title={k}>
                <b style={{ background: v.color }} /> {v.label}
              </span>
            ))}
          </div>

          <div className="nhn__flow" ref={boxRef}>
            {err && <div className="nhn__err">{err}</div>}
          </div>

          <div className="nhn__foot">
            <span className="nhn__foot-hint">
              {sel
                ? sel.label + ' · ' + sel.layer + ' · ' + sel.kind
                  + (sel.path ? ' · ' + sel.path : '')
                  + ' —— 写 ' + rel.out.length + ' / 被写 ' + rel.in.length
                : '悬停或点击任意节点看它的邻域（其余变暗）· 双击场景节点进入场景 · 可拖动/缩放'}
            </span>
            {sel && (
              <button type="button" className="nhn__chip" onClick={() => setSel(null)}>取消选中</button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
