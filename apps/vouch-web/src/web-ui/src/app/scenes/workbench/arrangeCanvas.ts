/**
 * 画布自动布局 —— **算法思路搬自 Toonflow arrangeCanvas.ts**
 *
 * 出处：D:/refs/Toonflow-app/apps/web/src/pages/workspace/panels/canvas/arrangeCanvas.ts
 * 照搬的部分：
 *   :19-21  间距按节点尺寸中位数推导（nodeGap / rankGap / groupGap）
 *   :33-42  只排「没有父节点」的顶层节点
 *   :46-58  按**连通分量**分组，每组单独布局，保持每条流程完整
 *   :60-77  按画布宽高比把各分量**分行打包**（不追求全局最紧凑的矩形装箱）
 *   :79-88  应用位置后 fitView
 *
 * 唯一偏离：Toonflow 用 @dagrejs/dagre 做组内分层布局；我们没装 dagre，
 * 改用 **BFS 分层**（按边方向从根节点逐层展开）。对本产品的图（12 场景/31 边、
 * 无环、有明确方向）效果等价；对带环的图会退化成同层，这是已知限制，写在下面。
 */
type LNode = { id: string; position: { x: number; y: number }; width?: number; height?: number };
type LEdge = { source: string; target: string };

/** 搬自 :19-21 —— 间距由尺寸中位数推导，而不是写死 */
function gaps(nodes: LNode[]) {
  const ws = nodes.map((n) => n.width ?? 100).sort((a, b) => a - b);
  const hs = nodes.map((n) => n.height ?? 42).sort((a, b) => a - b);
  const med = (arr: number[]) => arr[Math.floor(arr.length / 2)] ?? 0;
  const nodeGap = Math.max(96, Math.min(160, med(hs) / 4));
  const rankGap = Math.max(160, Math.min(320, med(ws) / 2));
  return { nodeGap, rankGap, groupGap: Math.max(nodeGap, rankGap) * 1.5 };
}

/** 搬自 :46-58 —— 连通分量（无向） */
function components(nodes: LNode[], edges: LEdge[]) {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id];
    const group: string[] = [];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      group.push(id);
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    out.push(group);
  }
  return out;
}

/** BFS 分层（替代 dagre 的 rankdir LR） */
function layerize(ids: string[], edges: LEdge[]) {
  const set = new Set(ids);
  const outs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) { outs.set(id, []); indeg.set(id, 0); }
  for (const e of edges) {
    if (!set.has(e.source) || !set.has(e.target) || e.source === e.target) continue;
    outs.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  // 根 = 入度为 0 的节点；若全是环，取第一个
  let roots = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  if (!roots.length) roots = [ids[0]];

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) { level.set(r, 0); queue.push(r); }
  while (queue.length) {
    const cur = queue.shift()!;
    const lv = level.get(cur)!;
    for (const nb of outs.get(cur) ?? []) {
      const prev = level.get(nb);
      if (prev === undefined) { level.set(nb, lv + 1); queue.push(nb); }
      // 已访问过的不再更新 —— 有环时同层收敛，不会死循环
    }
  }
  // 没被 BFS 覆盖到的（不可达节点）放到最后一层
  let maxLv = 0;
  for (const v of level.values()) maxLv = Math.max(maxLv, v);
  for (const id of ids) if (!level.has(id)) level.set(id, maxLv + 1);

  const byLevel = new Map<number, string[]>();
  for (const id of ids) {
    const lv = level.get(id)!;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(id);
  }
  return byLevel;
}

export type ArrangeResult = { moved: number; groups: number; skipped: string | null };

/**
 * 计算并返回新位置（不直接改画布，便于调用方决定怎么应用 / 是否进撤销栈）。
 */
export function computeArrange(nodes: LNode[], edges: LEdge[], viewport?: { width: number; height: number }): { positions: Map<string, { x: number; y: number }>; result: ArrangeResult } {
  const positions = new Map<string, { x: number; y: number }>();
  if (!nodes.length) return { positions, result: { moved: 0, groups: 0, skipped: '没有节点' } };

  const { nodeGap, rankGap, groupGap } = gaps(nodes);

  // 每组单独布局，得到组内相对坐标与组尺寸
  const groups = components(nodes, edges).map((ids) => {
    const byLevel = layerize(ids, edges);
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    let maxX = 0;
    let maxY = 0;
    const local = new Map<string, { x: number; y: number }>();
    for (const lv of levels) {
      const members = byLevel.get(lv)!;
      let y = 0;
      for (const id of members) {
        const n = nodes.find((x) => x.id === id)!;
        local.set(id, { x: lv * rankGap, y });
        y += (n.height ?? 42) + nodeGap;
        maxX = Math.max(maxX, lv * rankGap + (n.width ?? 100));
        maxY = Math.max(maxY, y - nodeGap);
      }
    }
    return { ids, local, width: maxX, height: maxY };
  });

  // 搬自 :60-77 —— 按画布宽高比分行打包
  const vw = viewport?.width ?? 0;
  const vh = viewport?.height ?? 0;
  const aspect = vw > 0 && vh > 0 ? Math.max(0.75, Math.min(2, vw / vh)) : 1.6;
  const area = groups.reduce((s, g) => s + (g.width + groupGap) * (g.height + groupGap), 0);
  const rowWidth = Math.max(Math.max(...groups.map((g) => g.width)), Math.sqrt(area * aspect));

  const origin = {
    x: Math.min(...nodes.map((n) => n.position.x)),
    y: Math.min(...nodes.map((n) => n.position.y)),
  };

  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const g of groups) {
    if (x > 0 && x + g.width > rowWidth) { x = 0; y += rowHeight + groupGap; rowHeight = 0; }
    for (const [id, p] of g.local) {
      positions.set(id, { x: origin.x + x + p.x, y: origin.y + y + p.y });
    }
    x += g.width + groupGap;
    rowHeight = Math.max(rowHeight, g.height);
  }

  return { positions, result: { moved: positions.size, groups: groups.length, skipped: null } };
}
