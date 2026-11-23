/**
 * 画布撤销/重做 —— 算法搬自 Toonflow（已接线，2026-11-17）
 *
 * 出处：D:/refs/Toonflow-app/apps/web/src/pages/workspace/panels/canvas/useCanvasHistory.ts
 *
 * 接线过程中抓到并修掉两个真 bug（代码里都留了注释）：
 *   ① 只搬「排除 data」没搬「nodeReferences 保留」→ 还原出无 data 的节点 → 渲染崩 → 画布消失
 *   ② 挂载时预置「首帧基线」，那一刻 edges 还是空 → 撤销一次把边清空
 *
 * ⚠ 验证方法提醒（我在这上面栽过两次）：
 *   数边请用 .react-flow__edge 或 .react-flow__edges svg path，
 *   **不要用 .react-flow__edge path** —— 类名在 path 自身上，这个选择器匹配不到。
 *   另外工作台面板在 content-visibility:auto 的子树里，不可见时 DOM 计数为 0，
 *   以截图为准；或读容器上的 data-wb-edges 自检属性。
 */

/**
 * 画布撤销/重做 —— **算法搬自 Toonflow**
 *
 * 出处：D:/refs/Toonflow-app/apps/web/src/pages/workspace/panels/canvas/useCanvasHistory.ts
 * 逐项对照（Vue → React 适配，算法不变）：
 *   :10  type CanvasSnapshot = { nodes, edges, key }
 *   :16-17  运行时字段黑名单（nodeRuntimeFields / edgeRuntimeFields）
 *   :22-35  capture()：只复制结构，排除运行时字段，用 key 去重
 *   :37-49  commit()：最多 100 步（.slice(-101)），同 key 不重复提交
 *   :51     debounce(commit, 0)
 *   :89-92  undo/redo：先 commit 再跳转
 *   :110-127 拖拽 = 合并成一步（grouping 计数）
 *   :146-160 绑定变化时清空历史
 *
 * 为什么搬：撤销/重做的坑都在细节里 ——
 *   · 运行时字段（position/selected/dimensions）进快照会让「撤销」变成「还原选中态」
 *   · 拖拽每一帧都提交会让撤销一次只退一个像素
 *   · 不按 key 去重会存一堆相同快照
 * 这些是我自己写一定会踩的坑。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type SnapNode = { id: string; [k: string]: unknown };
type SnapEdge = { id: string; [k: string]: unknown };
type Snapshot = { nodes: SnapNode[]; edges: SnapEdge[]; key: string };

/** 搬自 :16-17 —— 这些字段属于运行时，不进快照 */
const NODE_RUNTIME_FIELDS = new Set([
  // 【2026-11-17 偏离 Toonflow，已实测理由】
  // Toonflow 把 'data' 排除在快照外，是因为它另有一份 nodeReferences 保留原始 data，
  // 还原时从那里取回。我只搬了「排除」没搬「保留」，结果还原出的节点没有 data，
  // 渲染直接抛错、整块画布消失（实测 12 节点 → 0）。
  // 我们的 data 很小（只有 label），所以**保留 data**，不引入引用表。
  // 'data',
  'computedPosition', 'handleBounds', 'selected', 'dimensions',
  'dragging', 'resizing', 'positionAbsolute', 'width', 'height', 'measured',
]);
const EDGE_RUNTIME_FIELDS = new Set([
  // 同上：保留 data（我们很小），不引入引用表
  // 'data',
  'selected', 'sourceNode', 'targetNode', 'sourceX', 'sourceY',
  'targetX', 'targetY', 'sourcePosition', 'targetPosition', 'markerEnd',
]);

const MAX_STEPS = 100;

function stripFields(el: SnapNode | SnapEdge, runtime: Set<string>) {
  return Object.fromEntries(Object.entries(el).filter(([k]) => !runtime.has(k)));
}

/**
 * @param getState () => { nodes, edges }   —— 取当前画布
 * @param setState (nodes, edges) => void   —— 应用快照
 * @param bindingKey 绑定的画布 id（切换画布时清空历史）
 */
export function useCanvasHistory(
  getState: () => { nodes: SnapNode[]; edges: SnapEdge[] },
  setState: (nodes: SnapNode[], edges: SnapEdge[]) => void,
  bindingKey: string | null,
) {
  const snaps = useRef<Snapshot[]>([]);
  const cursor = useRef(-1);
  const applying = useRef(false);
  const grouping = useRef(0);
  const revision = useRef(0);
  const [, force] = useState(0);

  /** 搬自 :22-35 —— 只复制结构，排除运行时字段 */
  const capture = useCallback((): Snapshot => {
    const { nodes, edges } = getState();
    const key = JSON.stringify({
      nodes: nodes.map((n) => stripFields(n, NODE_RUNTIME_FIELDS)),
      edges: edges.map((e) => stripFields(e, EDGE_RUNTIME_FIELDS)),
    });
    return { ...JSON.parse(key), key };
  }, [getState]);

  /** 搬自 :37-49 —— 同 key 不重复提交，最多 100 步 */
  const commit = useCallback(() => {
    if (!bindingKey || applying.current || grouping.current > 0) return;
    const snap = capture();
    if (snap.key === snaps.current[cursor.current]?.key) return;
    snaps.current = [...snaps.current.slice(0, cursor.current + 1), snap].slice(-(MAX_STEPS + 1));
    cursor.current = snaps.current.length - 1;
    force((v) => v + 1);
  }, [bindingKey, capture]);

  /** 搬自 :51 —— debounce 0（这里用微任务等价实现） */
  const record = useCallback(() => {
    queueMicrotask(() => commit());
  }, [commit]);

  /** 搬自 :89-92 */
  const restore = useCallback((index: number) => {
    const target = snaps.current[index];
    if (!target || !bindingKey || applying.current || grouping.current > 0) return;
    applying.current = true;
    try {
      setState(target.nodes, target.edges);
      cursor.current = index;
    } finally {
      applying.current = false;
      force((v) => v + 1);
    }
  }, [bindingKey, setState]);

  const undo = useCallback(() => {
    commit();
    if (cursor.current > 0) restore(cursor.current - 1);
  }, [commit, restore]);

  const redo = useCallback(() => {
    commit();
    if (cursor.current < snaps.current.length - 1) restore(cursor.current + 1);
  }, [commit, restore]);

  /** 搬自 :110-127 —— 拖拽合并成一步 */
  const beginGroup = useCallback(() => {
    if (!bindingKey || applying.current) return;
    commit();
    grouping.current += 1;
  }, [bindingKey, commit]);

  const endGroup = useCallback(() => {
    if (grouping.current <= 0) return;
    grouping.current -= 1;
    if (grouping.current === 0) commit();
  }, [commit]);

  /** 搬自 :146-160 —— 换画布清空历史 */
  useEffect(() => {
    revision.current += 1;
    snaps.current = [];
    cursor.current = -1;
    applying.current = false;
    grouping.current = 0;
    // 【2026-11-17 实测修正】原来在这里预置一个「首帧基线」，但挂载那一刻
    // edges 还没算出来（实测快照里 edges=[]），撤销一次就把边全清空（62→0）。
    // 改为**不预置基线**：等第一次真实变更（拖拽/显式 commit）才记第一条。
    // 代价是「刚打开就按 Ctrl+Z」什么都不发生 —— 这是安全的正确行为。
    force((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey]);

  const canUndo = !!bindingKey && !applying.current && grouping.current === 0 && cursor.current > 0;
  const canRedo = !!bindingKey && !applying.current && grouping.current === 0 && cursor.current < snaps.current.length - 1;

  return { canUndo, canRedo, record, commit, undo, redo, beginGroup, endGroup, depth: snaps.current.length, cursor: cursor.current };
}
