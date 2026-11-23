/**
 * 力导向布局 —— 我们自己实现的 Fruchterman-Reingold 变体，不引第三方依赖。
 *
 * 【为什么不用 React Flow 默认布局 / 分层带状】
 * 2026-11-18 用户指出：分层带状看起来像**思维导图**，不像知识图谱/记忆网络。
 * 主流记忆图谱（Obsidian 关系图、Neo4j Bloom、Logseq、Roam）都是**力导向**：
 *   节点互斥（斥力）+ 边拉近（引力）+ 整体向心，自然聚成团簇。
 *
 * 参照实现思路：
 *   · d3-force 的 manyBody（Barnes-Hut 近似斥力）+ link（弹簧）
 *   · 我们规模小（28 节点 / 62 边），直接 O(n²) 精确计算即可，不需要 Barnes-Hut，
 *     少一层近似也少一层"看起来像力导向其实不是"的风险。
 *
 * 纯函数、无副作用：给同样的 nodes/edges 和同样 seeds，跑出同样的坐标（可复算）。
 */

export type GraphNode = { id: string; layer: string };
export type GraphEdge = { from: string; to: string };
export type Pos = { x: number; y: number };

/** 确定性伪随机：同一 seed 永远同一序列，保证布局可复算 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ForceOptions = {
  /** 斥力强度：越大节点越散 */
  charge?: number;
  /** 弹簧强度：越大相连的越紧 */
  link?: number;
  /** 弹簧自然长度 */
  linkDistance?: number;
  /** 向心力：把整体收到中心，防止飘散 */
  center?: number;
  /** 迭代轮数 */
  ticks?: number;
  /** 同层节点额外引力（让同层聚成团；0 = 完全按边聚） */
  layerCluster?: number;
  seed?: number;
};

const DEFAULTS: Required<ForceOptions> = {
  charge: 1400,
  link: 0.055,
  linkDistance: 110,
  center: 0.012,
  ticks: 420,
  layerCluster: 0.004,
  seed: 20260118,
};

/**
 * 计算力导向布局。
 * @returns Map<nodeId, {x,y}>；坐标以 (0,0) 为中心，界面端再平移/缩放。
 */
export function forceLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: ForceOptions = {},
): Map<string, Pos> {
  const o = { ...DEFAULTS, ...opts };
  const n = nodes.length;
  const out = new Map<string, Pos>();
  if (n === 0) return out;
  if (n === 1) {
    out.set(nodes[0].id, { x: 0, y: 0 });
    return out;
  }

  const rnd = mulberry32(o.seed);
  const idx = new Map<string, number>();
  nodes.forEach((nd, i) => idx.set(nd.id, i));

  // 初始位置：黄金角螺旋 + 抖动（比纯圆环更快收敛，也不容易对称卡死）
  const pos = new Float64Array(n * 2);
  const disp = new Float64Array(n * 2);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = 24 * Math.sqrt(i + 0.5);
    const a = i * golden + rnd() * 0.35;
    pos[i * 2] = Math.cos(a) * r;
    pos[i * 2 + 1] = Math.sin(a) * r;
  }

  // 边表（只保留两端都存在的边）
  const links: Array<[number, number]> = [];
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]);
  }

  // 同层分组（用于微弱聚团）
  const layerOf = nodes.map((nd) => nd.layer);

  const k2 = o.linkDistance * o.linkDistance;

  for (let t = 0; t < o.ticks; t++) {
    // 温度从热到冷，末段几乎不动（经典 FR 退火）
    const temp = 28 * (1 - t / o.ticks) + 0.6;
    disp.fill(0);

    // ① 斥力：所有节点两两互斥（精确 O(n²)，28 节点无所谓）
    for (let i = 0; i < n; i++) {
      const ix = pos[i * 2];
      const iy = pos[i * 2 + 1];
      for (let j = i + 1; j < n; j++) {
        let dx = ix - pos[j * 2];
        let dy = iy - pos[j * 2 + 1];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-4) {
          // 完全重合时给一个确定性小扰动，避免除零
          dx = (rnd() - 0.5) * 1.2;
          dy = (rnd() - 0.5) * 1.2;
          d2 = dx * dx + dy * dy + 1e-4;
        }
        const d = Math.sqrt(d2);
        const f = o.charge / d2;
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        disp[i * 2] += ux;
        disp[i * 2 + 1] += uy;
        disp[j * 2] -= ux;
        disp[j * 2 + 1] -= uy;
      }
    }

    // ② 同层微聚：同层节点互相拉近一点点（让「属于哪一层」看得出来）
    if (o.layerCluster > 0) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (layerOf[i] !== layerOf[j]) continue;
          const dx = pos[j * 2] - pos[i * 2];
          const dy = pos[j * 2 + 1] - pos[i * 2 + 1];
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = o.layerCluster * d;
          const ux = (dx / d) * f;
          const uy = (dy / d) * f;
          disp[i * 2] += ux;
          disp[i * 2 + 1] += uy;
          disp[j * 2] -= ux;
          disp[j * 2 + 1] -= uy;
        }
      }
    }

    // ③ 弹簧引力：相连节点拉向理想距离
    for (const [a, b] of links) {
      const dx = pos[b * 2] - pos[a * 2];
      const dy = pos[b * 2 + 1] - pos[a * 2 + 1];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (o.link * (d - o.linkDistance)) / d;
      const fx = dx * f;
      const fy = dy * f;
      disp[a * 2] += fx;
      disp[a * 2 + 1] += fy;
      disp[b * 2] -= fx;
      disp[b * 2 + 1] -= fy;
    }
    // 用 k2 表示理想距离平方，仅为让常量有意义（避免未用变量）
    void k2;

    // ④ 向心：整体收回原点
    for (let i = 0; i < n; i++) {
      disp[i * 2] -= pos[i * 2] * o.center;
      disp[i * 2 + 1] -= pos[i * 2 + 1] * o.center;
    }

    // ⑤ 按温度限幅位移
    for (let i = 0; i < n; i++) {
      const dx = disp[i * 2];
      const dy = disp[i * 2 + 1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) continue;
      const step = Math.min(d, temp) / d;
      pos[i * 2] += dx * step;
      pos[i * 2 + 1] += dy * step;
    }
  }

  for (let i = 0; i < n; i++) {
    out.set(nodes[i].id, {
      x: Math.round(pos[i * 2] * 10) / 10,
      y: Math.round(pos[i * 2 + 1] * 10) / 10,
    });
  }
  return out;
}