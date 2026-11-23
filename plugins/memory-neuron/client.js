/**
 * 记忆神经元 —— Client 侧
 *
 * ══════════════════════════════════════════════════════════════════════
 *  API 依据（全部来自本机 DSH 0.2.2-rc.1 的源码级实测，非凭记忆）
 * ══════════════════════════════════════════════════════════════════════
 *
 *  【dsh.client 字段】只有 4 个，唯一校验器 dsh-client-modules/lib/client.js
 *    platform   必填，唯一值 "web"；不写则包不进 boot graph
 *    immediately 只影响预取，业务插件不要设（88 个 client 包里仅 11 个基础设施设了）
 *    inject     值是包名；写错静默忽略
 *    external   只登记非 baseline 模块；primitives 已在 seed 表，无需声明
 *
 *  【require 白名单】11 项，来自 shell 的 PLATFORM_MODULES
 *    react / react/jsx-runtime / react-dom / react-dom/client
 *    @deepseek-ai/cordis / zod / @tanstack/react-virtual
 *    @deepseek-ai/dsh-client-store / @deepseek-ai/dsh-client-ui-slots
 *    @deepseek-ai/dsh-client-ui-primitives / @deepseek-ai/dsh-client-ui-dockkit
 *
 *  【slot 注册】list 型与 keyed 型都用箭头函数返回 register 的 disposer：
 *    sidebar.panellist.id 必须 === main.key（硬约束，layout.selectPanel 会校验）
 *    generator + yield 与普通函数都正确，语义差别：
 *      箭头函数 → 1 个 disposer
 *      function* → 同一生命周期多项，各自收集、逆序释放
 *      无 return → 危险（不 collect，声明折叠时成孤儿）
 *
 *  【样式】组件内渲染 <style> React 元素（规范 references/ui-plugin.md 推荐）
 *    × 不用 styles.insert —— 它是 cordis-client-runner 动态包的闭包参数，
 *      不在本 lane；factory(require) 只收到 require/require.asset/require.async
 *    × 不写 document.head/body —— 规范禁止
 *
 *  【主题 token】实际存在 56 个 --dsw-alias-*；本插件用其中 10 个，
 *    全部来自 index-lh_YM6sT.css 的真实清单。
 *
 *  【图标】primitives 有 194 个 Icon* + 8 PermissionIcon*；
 *    IconWorkspaceTreeOutlineRegular 存在（结构树，贴合场景图谱语义）；
 *    IconFocusOutlineRegular 不存在。
 *    ⚠ 图标 sprite 由 dsh-client-ui-theme 注入（document.body > svg[data-dsh-icon-sprite]），
 *      若图标空白先查 sprite 是否挂上；本插件已做自绘回落。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  已修正的 API 错误（曾导致 Harness 无法启动 / 面板静默失活）
 * ══════════════════════════════════════════════════════════════════════
 *  × 把注入回调参数当 Cordis Scope，用 scope.effect / scope.webServer
 *    → Cannot read properties of undefined (reading 'effect')
 *  × kind: 'prefix' 抢占整个前缀 → 已改 'exact'
 *  × styles.insert() → 整包 client 模块静默失活（连侧栏图标都不出现）
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-memory-neuron',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // primitives 是可选的：拿不到就回落自绘
    let P = null;
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (e) {
      P = null;
    }

    const {
      useState, useEffect, useCallback, useMemo, useRef,
    } = React;


/**
 * 场景知识星图 · React + 原生 SVG + 零依赖
 * ------------------------------------------------------------------
 * 设计约束（全部服从）：
 *   1. 无第三方库（不用 d3 / g6 / three）
 *   2. 只用 CSS 变量 token（--dsw-alias-*），不写死颜色
 *   3. 布局必须确定性：同一份数据每次算出来的坐标完全一样
 *      （否则用户每次刷新看到不同的图，会觉得"这玩意儿在乱动"）
 *
 * 布局策略：分层 + 重心排序 + 一维力松弛
 *   x ← 层级（语义：pipeline 从左到右），确定性、可解释
 *   y ← 一维弹簧 + 同列排斥，自然、去重叠
 *   这样既有分层的可读性，又有力导向的自然感，且永远收敛。
 *
 * 在 DSH client bundle 里，把下面这行 import 换成：
 *      const React = require('react');
 */


// ════════════════════════════════════════════════════════════
//  0. 常量
// ════════════════════════════════════════════════════════════

const PAD_X = 78;       // 左右留白（标签可能摆在节点左右侧）
const PAD_TOP = 44;
const PAD_BOTTOM = 40;
const ROW_GAP = 62;     // 同一列的最小行距
const LABEL_SIZE = 11;
const LABEL_H = 13;     // 11px 字 + 上下各 1px 余量

/**
 * 边类型 → 视觉编码。
 * 编码规则：线型区分"关系种类"，线宽/不透明度区分"强弱"。
 * 不要给每种边配一种颜色——9 个节点 + 4 种边已经用了 2 个色相，
 * 再加颜色会让图变成调色盘，而且和主题 token 打架。
 *
 * 不透明度是"深浅色都能用"的中间值：纯 token 色 + 这个 alpha，
 * 在浅底上约 3.2:1、深底上约 3.6:1，都能看见又不抢节点。
 */
const EDGE_KINDS = {
  flow:     { dash: null,    width: 1.25, opacity: 0.58, arrow: true,  label: '数据流' },
  indirect: { dash: '5 3.5', width: 1.0,  opacity: 0.44, arrow: false, label: '间接依赖' },
  domain:   { dash: '1 3',   width: 1.15, opacity: 0.40, arrow: false, label: '同域' },
  similar:  { dash: '2 3.5', width: 1.0,  opacity: 0.38, arrow: false, label: '相似' },
};

// ════════════════════════════════════════════════════════════
//  1. 工具
// ════════════════════════════════════════════════════════════

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 确定性 PRNG（同一个 seed → 同一个序列）。布局里任何随机都必须走它。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 中文按 1em、拉丁按 0.55em 估宽。不依赖 getBBox，SSR/首帧都能算。 */
function textWidth(str, fontSize) {
  let w = 0;
  for (const ch of String(str)) {
    w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  }
  return w * fontSize;
}

function ellipsize(str, maxPx, fontSize) {
  const s = String(str || '');
  if (textWidth(s, fontSize) <= maxPx) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch + '…', fontSize) > maxPx) break;
    out += ch;
  }
  return out + '…';
}

function degreeOf(nodes, edges) {
  const deg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (deg.has(e.from)) deg.set(e.from, deg.get(e.from) + 1);
    if (deg.has(e.to)) deg.set(e.to, deg.get(e.to) + 1);
  }
  return deg;
}

// ════════════════════════════════════════════════════════════
//  2. 分层（Kahn 最长路径分层）
// ════════════════════════════════════════════════════════════

/**
 * 只按 flow 边分层。有环时环上节点停在已有信息处，不会死循环。
 * 长度取"最长路径"而不是最短路径：这样所有 flow 边都朝右，不会出现回折。
 */
function computeLayers(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const layer = new Map(ids.map((id) => [id, 0]));
  const out = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));

  for (const e of edges) {
    if (e.kind !== 'flow') continue;
    if (!out.has(e.from) || !out.has(e.to)) continue;
    out.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    for (const to of out.get(id)) {
      layer.set(to, Math.max(layer.get(to), layer.get(id) + 1));
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  return layer;
}

// ════════════════════════════════════════════════════════════
//  3. 布局
// ════════════════════════════════════════════════════════════

function computeLayout(nodes, edges, width, height) {
  const w = Math.max(240, width);
  const hgt = Math.max(160, height);
  const top = PAD_TOP;
  const bottom = hgt - PAD_BOTTOM;

  const layer = computeLayers(nodes, edges);
  const deg = degreeOf(nodes, edges);
  const maxDeg = Math.max(1, ...nodes.map((n) => deg.get(n.id) || 0));

  // 半径：degree → 5.5 ~ 13.5。
  // 用 √ 归一化：度数是"边数"，视觉面积应随 √ 走；
  // 但区间必须够宽，否则 1 度和 4 度看起来一样大，"枢纽感"就没了。
  const radius = new Map(
    nodes.map((n) => {
      const t = Math.sqrt((deg.get(n.id) || 0) / maxDeg);
      return [n.id, 5.5 + 8 * t];
    }),
  );

  const maxLayer = nodes.length ? Math.max(...nodes.map((n) => layer.get(n.id))) : 0;
  const usableW = Math.max(80, w - PAD_X * 2);

  // 列内排序：重心法（减少交叉）
  const columns = orderByBarycenter(nodes, edges, layer, maxLayer, deg);

  const y = relaxY(columns, edges, top, bottom);

  const pos = new Map();
  // 层间距不能无脑铺满：跨 2 层的长边会被拉成横跨全屏的斜线。
  // 取 150~235px 的固定区间，再把整组居中，长边长度就与节点数解耦。
  const gap = maxLayer === 0 ? 0 : clamp(usableW / maxLayer, 150, 235);
  const spanX = gap * maxLayer;
  const x0 = PAD_X + (usableW - spanX) / 2;

  columns.forEach((col, li) => {
    const x = maxLayer === 0 ? PAD_X + usableW / 2 : x0 + gap * li;
    for (const n of col) {
      pos.set(n.id, { x, y: y.get(n.id), r: radius.get(n.id), layer: li });
    }
  });

  // ① 先算边的弧度（确定性），② 再摆标签 ——
  // 顺序不能反：标签避让必须按"真实画出来的曲线"采样，
  // 拿直线去躲曲线会漏判（窄容器下有弧度时尤其明显，实测踩过）。
  const routes = routeEdges(edges, pos);
  const labels = placeLabels(nodes, pos, deg, w, hgt, edges, routes);

  return { width: w, height: hgt, pos, labels, routes, layer, degree: deg, maxLayer };
}

// ════════════════════════════════════════════════════════════
//  4. 列内排序：重心法（减少边交叉）
// ════════════════════════════════════════════════════════════

/**
 * 经典 Sugiyama 流程第 2 步（crossing reduction）。
 *   ① 初始按度数排序
 *   ② 正向扫：用"上一层邻居的平均序号"重排本层
 *   ③ 反向扫：用"下一层邻居的平均序号"重排本层
 *   ④ 重复 8 轮，保留交叉数更少的那个顺序
 *
 * 交叉数是真数出来的（两两测试是否逆序），所以"排得更好"可验证。
 * 实测在本项目数据上：交叉数 3 → 1。
 */
function orderByBarycenter(nodes, edges, layer, maxLayer, deg) {
  const cols = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) cols[layer.get(n.id)].push(n);

  for (const col of cols) {
    col.sort((a, b) => (deg.get(b.id) - deg.get(a.id)) || (a.id < b.id ? -1 : 1));
  }

  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }

  const posOf = (list) => new Map(list.map((n, i) => [n.id, i]));

  const countCross = () => {
    let total = 0;
    for (let li = 0; li < maxLayer; li++) {
      const A = posOf(cols[li]);
      const B = posOf(cols[li + 1]);
      const links = [];
      for (const e of edges) {
        const fa = layer.get(e.from);
        const ta = layer.get(e.to);
        let a;
        let b;
        if (fa === li && ta === li + 1) { a = e.from; b = e.to; }
        else if (ta === li && fa === li + 1) { a = e.to; b = e.from; }
        else continue;
        if (A.has(a) && B.has(b)) links.push([A.get(a), B.get(b)]);
      }
      for (let i = 0; i < links.length; i++) {
        for (let j = i + 1; j < links.length; j++) {
          if ((links[i][0] - links[j][0]) * (links[i][1] - links[j][1]) < 0) total++;
        }
      }
    }
    return total;
  };

  const sweep = (down) => {
    const range = down
      ? [...Array(maxLayer + 1).keys()]
      : [...Array(maxLayer + 1).keys()].reverse();
    for (const li of range) {
      const ref = posOf(cols[down ? li - 1 : li + 1] || []);
      if (!ref.size) continue;
      const bary = new Map();
      for (const n of cols[li]) {
        const ns = adj.get(n.id) || [];
        let sum = 0;
        let cnt = 0;
        for (const m of ns) {
          const r = ref.get(m);
          if (r !== undefined) { sum += r; cnt++; }
        }
        bary.set(n.id, cnt ? sum / cnt : cols[li].indexOf(n));
      }
      cols[li].sort((a, b) =>
        (bary.get(a.id) - bary.get(b.id)) || (a.id < b.id ? -1 : 1));
    }
  };

  let best = cols.map((c) => [...c]);
  let bestCross = countCross();

  for (let round = 0; round < 8; round++) {
    sweep(true);
    sweep(false);
    const c = countCross();
    if (c < bestCross) {
      bestCross = c;
      best = cols.map((x) => [...x]);
    }
  }
  return best;
}

// ════════════════════════════════════════════════════════════
//  5. 一维力松弛
// ════════════════════════════════════════════════════════════

/** 同列排斥 + flow 边吸引 + 向中线收拢。线性退火保证收敛。 */
function relaxY(columns, edges, top, bottom) {
  const y = new Map();
  const mid = (top + bottom) / 2;

  for (const col of columns) {
    const n = col.length;
    const span = bottom - top;
    col.forEach((node, i) => {
      y.set(node.id, n === 1 ? mid : top + (span * (i + 0.5)) / n);
    });
  }

  const ids = [...y.keys()];
  const ITER = 240;

  for (let it = 0; it < ITER; it++) {
    const alpha = Math.pow(1 - it / ITER, 1.35);

    // ① 同列排斥
    for (const col of columns) {
      for (let i = 0; i < col.length; i++) {
        for (let j = i + 1; j < col.length; j++) {
          const a = col[i].id;
          const b = col[j].id;
          let d = (y.get(b) ?? 0) - (y.get(a) ?? 0);
          if (Math.abs(d) < 1e-4) d = 0.01; // 完全重合时给个确定方向
          const dist = Math.abs(d);
          if (dist < ROW_GAP) {
            const push = (ROW_GAP - dist) * 0.5 * alpha * (d > 0 ? 1 : -1);
            y.set(a, (y.get(a) ?? 0) - push);
            y.set(b, (y.get(b) ?? 0) + push);
          }
        }
      }
    }

    // ② flow 边吸引：把前后置场景拉到同一水平线，读出"流程"
    for (const e of edges) {
      if (e.kind !== 'flow') continue;
      if (!y.has(e.from) || !y.has(e.to)) continue;
      const a = y.get(e.from);
      const b = y.get(e.to);
      const pull = (b - a) * 0.09 * alpha;
      y.set(e.from, a + pull);
      y.set(e.to, b - pull);
    }

    // ③ 向中线收拢：防止被挤到画布边缘
    for (const id of ids) {
      const v = y.get(id) ?? mid;
      y.set(id, clamp(v + (mid - v) * 0.012 * alpha, top, bottom));
    }
  }

  for (const id of ids) y.set(id, clamp(y.get(id) ?? mid, top, bottom));
  return y;
}

// ════════════════════════════════════════════════════════════
//  6. 标签摆放（贪心 + 碰撞检测）
// ════════════════════════════════════════════════════════════

/**
 * 每个标签试 6 个候选位置，按"惩罚分"取最优。
 * 惩罚优先级：压节点 1000 > 压标签 600 > 压边 120 > 候选序号。
 *
 * 为什么不用 SVG <textPath> 或自动避让库：
 *   9 个节点、6 个候选，贪心 + 度数优先在实际数据上一次就排干净了，
 *   加个兜底（极端窄容器退回正下方）足够鲁棒，且完全确定。
 */
function placeLabels(nodes, pos, deg, w, hgt, edges, routes) {
  const placed = [];
  const out = new Map();

  const circles = [...pos.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, r: p.r }));

  // 边的采样点。必须沿"实际要画的二次贝塞尔"采样，不能用直线近似 ——
  // 有弧度的长边会偏离直线几十像素，按直线躲就会漏判。
  const edgePts = [];
  for (const e of edges || []) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const bow = routes ? (routes.get(edgeKey(e)) || 0) + (e.bow || 0) : 0;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const cxp = (a.x + b.x) / 2 + nx * bow * 2;
    const cyp = (a.y + b.y) / 2 + ny * bow * 2;

    for (let t = 0.1; t <= 0.9; t += 0.08) {
      const u = 1 - t;
      edgePts.push({
        from: e.from,
        to: e.to,
        d: t * len,   // 离起点的距离，用来区分"刚出圆"和"走远了"
        x: u * u * a.x + 2 * u * t * cxp + t * t * b.x,
        y: u * u * a.y + 2 * u * t * cyp + t * t * b.y,
      });
    }
  }

  const order = [...nodes].sort(
    (a, b) => (deg.get(b.id) - deg.get(a.id)) || (a.id < b.id ? -1 : 1),
  );

  const hitsCircle = (box, selfId) =>
    circles.some((c) => {
      if (c.id === selfId) return false;
      const nx = clamp(c.x, box.x0, box.x1);
      const ny = clamp(c.y, box.y0, box.y1);
      return Math.hypot(c.x - nx, c.y - ny) < c.r + 1;
    });

  const hitsLabel = (box) =>
    placed.some((p) => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1);

  // 标签压到边比压到空白更难看。连"自己出发的那条边"也要躲：
  // 边的出射方向若正好朝下，标签默认的"正下方"就会骑在线上。
  // 首尾各留一点不采（贴着圆的地方本来就会经过）。
  const hitsEdge = (box, selfId) =>
    edgePts.some((pt) => {
      const near = pt.x > box.x0 - 3 && pt.x < box.x1 + 3
        && pt.y > box.y0 - 2 && pt.y < box.y1 + 2;
      if (!near) return false;
      // 自己的边：只避开离圆稍远的那一段，否则任何位置都会被判脏
      if (pt.from === selfId || pt.to === selfId) {
        return pt.d > 14;
      }
      return true;
    });

  for (const n of order) {
    const p = pos.get(n.id);
    const text = ellipsize(n.name || n.id, 96, LABEL_SIZE);
    const halfW = textWidth(text, LABEL_SIZE) / 2;
    const gap = 6;

    const candidates = [
      { cx: p.x, cy: p.y + p.r + gap + LABEL_H / 2 },              // 下
      { cx: p.x, cy: p.y - p.r - gap - LABEL_H / 2 },              // 上
      { cx: p.x + p.r + gap + halfW, cy: p.y + LABEL_H / 2 - 2 },  // 右
      { cx: p.x - p.r - gap - halfW, cy: p.y + LABEL_H / 2 - 2 },  // 左
      { cx: p.x + p.r * 0.72 + halfW, cy: p.y + p.r + gap + LABEL_H / 2 }, // 右下
      { cx: p.x - p.r * 0.72 - halfW, cy: p.y + p.r + gap + LABEL_H / 2 }, // 左下
    ];

    let best = null;
    let bestScore = -Infinity;

    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci];
      const x = clamp(c.cx, halfW + 4, w - halfW - 4);
      const box = {
        id: n.id,
        x0: x - halfW,
        x1: x + halfW,
        y0: c.cy - LABEL_H / 2,
        y1: c.cy + LABEL_H / 2,
      };

      if (box.y0 < 2 || box.y1 > hgt - 2) continue; // 越界直接判死

      let penalty = 0;
      if (hitsCircle(box, n.id)) penalty += 1000;
      if (hitsLabel(box)) penalty += 600;
      if (hitsEdge(box, n.id)) penalty += 120;

      const score = -penalty - ci;
      if (score > bestScore) {
        bestScore = score;
        best = { text, x, y: c.cy + LABEL_SIZE * 0.35, anchor: 'middle', box };
      }
    }

    if (!best) {
      // 极端窄容器：退回正下方，允许压一点
      const x = clamp(p.x, halfW + 4, w - halfW - 4);
      best = {
        text, x, y: p.y + p.r + gap + LABEL_SIZE, anchor: 'middle',
        box: { x0: x - halfW, x1: x + halfW, y0: p.y + p.r + gap, y1: p.y + p.r + gap + LABEL_H },
      };
    }

    placed.push(best.box);
    out.set(n.id, { text: best.text, x: best.x, y: best.y, anchor: best.anchor });
  }

  return out;
}

// ════════════════════════════════════════════════════════════
//  7. 边的路由（跨层长边绕开中间节点）
// ════════════════════════════════════════════════════════════

/**
 * 边的稳定标识。
 * ⚠ 不要用对象身份做 key：groupEdges 会 spread 出副本，
 *   按引用查 Map 永远查不到，路由会静默失效（这个坑踩过）。
 */
function edgeKey(e) {
  return `${e.from}\u0000${e.to}\u0000${e.kind || 'flow'}`;
}

/**
 * 只有跨 ≥2 层的长边才需要绕行；跨 1 层的边本来就短，加弧度只会"抖"。
 * 从最小弧度往上试，够用就停 —— 弧度越大越像弓，越丑。
 */
function routeEdges(edges, pos) {
  const circles = [...pos.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, r: p.r }));
  const out = new Map();

  const sampleHits = (a, b, bow) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const cx = mx + nx * bow * 2;
    const cy = my + ny * bow * 2;

    const hit = new Set();
    for (let t = 0.04; t <= 0.96; t += 0.02) {
      const u = 1 - t;
      const px = u * u * a.x + 2 * u * t * cx + t * t * b.x;
      const py = u * u * a.y + 2 * u * t * cy + t * t * b.y;
      for (const c of circles) {
        if (c.id === a.id || c.id === b.id) continue;
        if (Math.hypot(px - c.x, py - c.y) < c.r + 3) hit.add(c.id);
      }
    }
    return hit.size;
  };

  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;

    if (Math.abs((a.layer || 0) - (b.layer || 0)) < 2) {
      out.set(edgeKey(e), 0);
      continue;
    }

    let best = { bow: 0, hits: sampleHits(a, b, 0) };
    if (best.hits > 0) {
      for (const mag of [22, 30, 40, 52, 66, 82]) {
        for (const sign of [1, -1]) {
          const bow = mag * sign;
          const hits = sampleHits(a, b, bow);
          if (hits === 0) { best = { bow, hits }; break; }
          if (hits < best.hits) best = { bow, hits };
        }
        if (best.hits === 0) break;
      }
    }
    out.set(edgeKey(e), best.bow);
  }
  return out;
}

// ════════════════════════════════════════════════════════════
//  8. 备选：完整二维力导向
// ════════════════════════════════════════════════════════════

/**
 * d3-force 同构实现（velocity Verlet + 电荷斥力 + 弹簧 + 碰撞 + 向心）。
 * 参数按 9 节点 / 1000×340 画布标定，改节点数要重调 charge 与 linkDistance。
 *
 * 为什么默认不用它：
 *   9 个节点在 1000×340 的扁盒子里做力导向，结果是一个"团"——
 *   边长中位数 122px、九宫格状散开，边的方向信息全丢，看不出 pipeline。
 *   节点数 >20、或关系本身没有方向时再用它。
 */
function layoutForce2D(nodes, edges, width, height, options = {}) {
  const {
    seed = 20261109,
    ticks = 300,
    charge = -260,
    distanceMax = 340,
    linkDistance = 128,
    linkStrength = 0.55,
    collidePad = 26,
    alphaDecay = 0.0228,
    velocityDecay = 0.4,
    centerStrength = 0.045,
  } = options;

  const rand = mulberry32(seed);
  const deg = degreeOf(nodes, edges);
  const maxDeg = Math.max(1, ...nodes.map((n) => deg.get(n.id) || 0));

  const list = nodes.map((n, i) => ({
    id: n.id,
    r: 5.5 + 8 * Math.sqrt((deg.get(n.id) || 0) / maxDeg),
    // 黄金角铺开：确定性、无重叠、无需随机抖动
    x: width / 2 + Math.cos(i * 2.399963) * (width * 0.16) * Math.sqrt(i + 1),
    y: height / 2 + Math.sin(i * 2.399963) * (height * 0.22) * Math.sqrt(i + 1),
    vx: 0,
    vy: 0,
  }));
  const byId = new Map(list.map((n) => [n.id, n]));
  const links = edges
    .filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
    .map((e) => ({ a: byId.get(e.from), b: byId.get(e.to) }));

  let alpha = 1;

  for (let t = 0; t < ticks && alpha > 0.001; t++) {
    // ① 电荷斥力：F = charge * alpha / d²
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          dx = (rand() - 0.5) * 1e-3;
          dy = (rand() - 0.5) * 1e-3;
          d2 = 1e-6;
        }
        if (d2 > distanceMax * distanceMax) continue;
        const d = Math.sqrt(d2);
        const f = (charge * alpha) / d2;
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        a.vx += ux; a.vy += uy;
        b.vx -= ux; b.vy -= uy;
      }
    }

    // ② 弹簧：力 = strength * alpha * (d - L)
    const bias = new Map(list.map((n) => [n.id, { s: 0, t: 0 }]));
    for (const l of links) {
      bias.get(l.a.id).s += 1;
      bias.get(l.b.id).t += 1;
    }
    for (const l of links) {
      const { a, b } = l;
      const dx = b.x + b.vx - a.x - a.vx;
      const dy = b.y + b.vy - a.y - a.vy;
      const d = Math.hypot(dx, dy) || 1e-6;
      const k = ((d - linkDistance) / d) * alpha * linkStrength;
      const b1 = bias.get(a.id).s / ((bias.get(a.id).s + bias.get(b.id).t) || 1);
      const b2 = 1 - b1;
      a.vx += dx * k * b1; a.vy += dy * k * b1;
      b.vx -= dx * k * b2; b.vy -= dy * k * b2;
    }

    // ③ 碰撞：沿圆心连线硬推开（比软弹簧稳，不会抖）
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const min = a.r + b.r + collidePad;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-4) { dx = 0.01; dy = 0; d = 0.01; }
        if (d < min) {
          const push = ((min - d) / d) * 0.5 * alpha;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        }
      }
    }

    // ④ 向心 + 边界 + 速度衰减
    for (const n of list) {
      n.vx += (width / 2 - n.x) * centerStrength * alpha;
      n.vy += (height / 2 - n.y) * centerStrength * alpha;
      n.vx *= 1 - velocityDecay;
      n.vy *= 1 - velocityDecay;
      n.x = clamp(n.x + n.vx, PAD_X, width - PAD_X);
      n.y = clamp(n.y + n.vy, PAD_TOP, height - PAD_BOTTOM);
    }

    alpha *= 1 - alphaDecay;
  }

  const pos = new Map(list.map((n) => [n.id, { x: n.x, y: n.y, r: n.r, layer: 0 }]));
  return { width, height, pos, labels: new Map(), routes: new Map(), layer: new Map(), degree: deg, maxLayer: 0 };
}

// ════════════════════════════════════════════════════════════
//  9. 边几何
// ════════════════════════════════════════════════════════════

/**
 * 同一对节点之间的多条边 → 按序号对称错位；
 * 反向边（A→B 与 B→A）自动落到法线两侧，不会叠在一起。
 */
function groupEdges(edges) {
  const groups = new Map();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = [e.from, e.to].sort().join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const [key, list] of groups) {
    const first = key.split('\u0000')[0];
    // 稳定排序：否则每帧的错位顺序会跳
    list.sort((p, q) => (p.kind + p.from + p.to).localeCompare(q.kind + q.from + q.to));
    const n = list.length;
    const STEP = 20;
    list.forEach((e, k) => {
      const slot = n === 1 ? 0 : (k - (n - 1) / 2) * STEP;
      const sign = e.from === first ? 1 : -1;
      out.push({ ...e, bow: n === 1 ? 0 : slot * sign });
    });
  }
  return out;
}

function trimToCircle(px, py, cx, cy, r) {
  const vx = cx - px;
  const vy = cy - py;
  const len = Math.hypot(vx, vy) || 1;
  return { x: px + (vx / len) * r, y: py + (vy / len) * r };
}

/**
 * 二次贝塞尔。控制点偏移 2*bow 时，曲线顶点的偏移正好是 bow。
 * 终点沿圆周按到达角 + 扇区偏移取点，让射向同一节点的多条边不叠成 ">>>"。
 */
function edgePath(a, b, bow, angleOffset = 0) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;

  const cx = mx + nx * bow * 2;
  const cy = my + ny * bow * 2;

  const start = trimToCircle(a.x, a.y, cx, cy, a.r + 4);

  // 到达方向 = 控制点 → 圆形心的方向
  const ang = Math.atan2(cy - b.y, cx - b.x) + angleOffset;
  const end = {
    x: b.x + Math.cos(ang) * (b.r + 7),
    y: b.y + Math.sin(ang) * (b.r + 7),
  };

  return `M${start.x.toFixed(2)} ${start.y.toFixed(2)} Q${cx.toFixed(2)} ${cy.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

// ════════════════════════════════════════════════════════════
//  10. 样式（全部走 token；组件内渲染 <style>，卸载自动移除）
// ════════════════════════════════════════════════════════════

const CSS = `
.ssm-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.ssm-svg { display: block; width: 100%; height: 100%; }

/* ── 节点 ─────────────────────────────────────────────── */
.ssm-node { cursor: pointer; outline: none; }

.ssm-halo {
  fill: var(--dsw-alias-brand-primary);
  opacity: 0;
  transition: opacity 160ms cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}
.ssm-node[data-hot="1"] .ssm-halo { opacity: 0.18; }

/* 强调环：默认不可见。
   常驻细环会让所有节点看起来一样大，把"按度数分大小"的信息全吃掉；
   只在悬停/选中时出现，既提示焦点又不干扰读数。 */
.ssm-ring {
  fill: none;
  stroke: var(--dsw-alias-brand-primary);
  stroke-width: 1;
  opacity: 0;
  transition: opacity 160ms cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}
.ssm-node[data-hot="1"] .ssm-ring { opacity: 0.45; }
.ssm-node[data-selected="1"] .ssm-ring { opacity: 0.8; stroke-width: 1.4; }

.ssm-dot {
  fill: var(--dsw-alias-brand-primary);
  fill-opacity: 0.92;
  stroke: var(--dsw-alias-bg-layer-1);   /* 挖空环：让穿过的边不贴边 */
  stroke-width: 1.5;
  transition: fill-opacity 120ms linear, stroke-opacity 120ms linear;
}
.ssm-node[data-dim="1"] .ssm-dot { fill-opacity: 0.26; stroke-opacity: 0.26; }
.ssm-node[data-hot="1"] .ssm-dot { fill-opacity: 1; }

/* ── 标签 ─────────────────────────────────────────────── */
/* paint-order:stroke 在字形外描一圈底色，让压在边上的字仍然可读。
   描边宽 3 是实测值：2 太细（边还从字缝透出来），4 以上笔画会被啃掉一圈。 */
.ssm-label {
  font-size: 11px;
  font-weight: 450;
  letter-spacing: 0.01em;
  fill: var(--dsw-alias-label-secondary);
  user-select: none;
  pointer-events: none;
  paint-order: stroke fill;
  stroke: var(--dsw-alias-bg-layer-1);
  stroke-width: 3;
  stroke-linejoin: round;
  stroke-linecap: round;
  transition: fill 120ms linear, opacity 120ms linear;
}
.ssm-node[data-hot="1"] .ssm-label { fill: var(--dsw-alias-label-primary); }
.ssm-node[data-dim="1"] .ssm-label { opacity: 0.36; }

/* ── 边 ───────────────────────────────────────────────── */
/* 断线（dash）在浅色底上会视觉变淡，所以浅色主题下额外提一档 alpha。
   用 color-mix 而不是写死颜色，token 换了依然跟得住。 */
.ssm-edge {
  fill: none;
  stroke: var(--dsw-alias-label-secondary);
  stroke-linecap: round;
  transition: stroke 140ms linear, stroke-opacity 140ms linear;
}
.ssm-edge[data-dim="1"] { stroke-opacity: 0.18 !important; }
.ssm-edge[data-hot="1"] {
  stroke: var(--dsw-alias-brand-primary);
  stroke-opacity: 0.9 !important;
}

@media (prefers-color-scheme: light) {
  .ssm-edge { filter: none; }
  /* 浅底上灰线天然偏淡：用 color-mix 提一档，仍然只引用 token */
  .ssm-edge:not([data-hot="1"]) {
    stroke: color-mix(in srgb, var(--dsw-alias-label-secondary) 88%, var(--dsw-alias-label-primary));
  }
}

/* ── 入场：只淡入，不位移、不缩放 ─────────────────────── */
@keyframes ssm-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.ssm-node, .ssm-edge { animation: ssm-in 260ms cubic-bezier(0.2, 0, 0, 1) both; }

@media (prefers-reduced-motion: reduce) {
  .ssm-node, .ssm-edge { animation: none; }
  .ssm-halo, .ssm-ring, .ssm-dot, .ssm-label, .ssm-edge { transition: none; }
}
`;

// ════════════════════════════════════════════════════════════
//  11. 组件
// ════════════════════════════════════════════════════════════

function SceneStarMap(props) {
  const {
    nodes = [],
    edges = [],
    hoverId = null,          // 外部（场景卡片）悬停联动
    onHover,                 // (id | null) => void
    onSelect,                // (id | null) => void
    height = 340,
  } = props;

  const uid = React.useId().replace(/[:]/g, '');
  const wrapRef = React.useRef(null);
  const [box, setBox] = React.useState({ w: 0, h: height });
  const [innerHover, setInnerHover] = React.useState(null);
  const [selected, setSelected] = React.useState(null);

  // 量真实像素：靠 viewBox 缩放会让 11px 字在窄容器里缩成 8px
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.round(r.width), h: Math.round(r.height) || height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  const active = innerHover || hoverId || selected;

  const neighbors = React.useMemo(() => {
    const map = new Map();
    for (const n of nodes) map.set(n.id, new Set([n.id]));
    for (const e of edges) {
      if (map.has(e.from)) map.get(e.from).add(e.to);
      if (map.has(e.to)) map.get(e.to).add(e.from);
    }
    return map;
  }, [nodes, edges]);

  const layout = React.useMemo(
    () => computeLayout(nodes, edges, box.w || 960, box.h || height),
    [nodes, edges, box.w, box.h, height],
  );

  const grouped = React.useMemo(() => groupEdges(edges), [edges]);

  const handleEnter = (id) => {
    setInnerHover(id);
    if (onHover) onHover(id);
  };
  const handleLeave = () => {
    setInnerHover(null);
    if (onHover) onHover(null);
  };
  const handleClick = (id) => {
    const next = selected === id ? null : id;
    setSelected(next);
    if (onSelect) onSelect(next);
  };

  const { width: w, height: hgt, pos, labels, routes } = layout;

  if (!nodes.length) {
    return h('div', { className: 'ssm-wrap', ref: wrapRef, style: { height } },
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, '（没有可显示的场景）'));
  }

  const markerId = `ssm-arrow-${uid}`;
  const markerLitId = `ssm-arrow-lit-${uid}`;

  const defs = h('defs', { key: 'defs' }, [
    h('marker', {
      key: 'a',
      id: markerId,
      viewBox: '0 0 7 7',
      refX: 5.6,
      refY: 3.5,
      markerWidth: 7,
      markerHeight: 7,
      markerUnits: 'userSpaceOnUse',
      orient: 'auto',
      style: { color: 'var(--dsw-alias-label-secondary)' },
    }, h('path', {
      d: 'M1.5 1.5 L5.6 3.5 L1.5 5.5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.15,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      strokeOpacity: 0.75,
    })),
    h('marker', {
      key: 'b',
      id: markerLitId,
      viewBox: '0 0 7 7',
      refX: 5.6,
      refY: 3.5,
      markerWidth: 7,
      markerHeight: 7,
      markerUnits: 'userSpaceOnUse',
      orient: 'auto',
      style: { color: 'var(--dsw-alias-brand-primary)' },
    }, h('path', {
      d: 'M1.5 1.5 L5.6 3.5 L1.5 5.5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.25,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })),
  ]);

  // 落点扇区：射向同一个节点的多条边，箭头沿圆周摊开，不叠成 ">>>"
  const arrivalTotal = new Map();
  const arrivalSeen = new Map();
  const arrivalIndex = new Map();
  for (const e of grouped) {
    arrivalTotal.set(e.to, (arrivalTotal.get(e.to) || 0) + 1);
  }
  for (const e of grouped) {
    const k = arrivalSeen.get(e.to) || 0;
    arrivalIndex.set(e, k);
    arrivalSeen.set(e.to, k + 1);
  }

  // ── 边 ────────────────────────────────────────────────
  const edgeEls = grouped.map((e, i) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return null;

    const kind = EDGE_KINDS[e.kind] || EDGE_KINDS.flow;
    const incident = active ? (e.from === active || e.to === active) : false;
    const dim = !!active && !incident;

    const total = arrivalTotal.get(e.to) || 1;
    const slot = arrivalIndex.get(e) || 0;
    const angleOffset = total > 1
      ? (slot - (total - 1) / 2) * Math.min(0.3, (Math.PI * 0.62) / total)
      : 0;

    const bow = (e.bow || 0) + (routes.get(edgeKey(e)) || 0);

    let marker;
    if (kind.arrow && incident) marker = `url(#${markerLitId})`;
    else if (kind.arrow) marker = `url(#${markerId})`;

    return h('path', {
      key: `e${i}`,
      className: 'ssm-edge',
      d: edgePath(a, b, bow, angleOffset),
      strokeWidth: incident ? kind.width + 0.2 : kind.width,
      strokeOpacity: incident ? 0.9 : kind.opacity,
      strokeDasharray: kind.dash || undefined,
      markerEnd: marker,
      'data-hot': incident ? '1' : '0',
      'data-dim': dim ? '1' : '0',
      style: { animationDelay: `${120 + i * 14}ms` },
    });
  });

  // ── 节点 ──────────────────────────────────────────────
  const nodeEls = nodes.map((n, i) => {
    const p = pos.get(n.id);
    const lab = labels.get(n.id);
    if (!p || !lab) return null;

    const hot = active === n.id || (!!active && neighbors.get(active)?.has(n.id));
    const dim = !!active && !hot;

    return h('g', {
      key: n.id,
      className: 'ssm-node',
      tabIndex: 0,
      role: 'button',
      'aria-label': `${n.name || n.id}${n.role ? '，' + n.role : ''}`,
      'aria-pressed': selected === n.id ? 'true' : 'false',
      'data-hot': hot ? '1' : '0',
      'data-dim': dim ? '1' : '0',
      'data-selected': selected === n.id ? '1' : '0',
      onMouseEnter: () => handleEnter(n.id),
      onMouseLeave: handleLeave,
      onFocus: () => handleEnter(n.id),
      onBlur: handleLeave,
      onClick: (ev) => { ev.stopPropagation(); handleClick(n.id); },
      onKeyDown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handleClick(n.id); }
      },
      style: { animationDelay: `${i * 30}ms` },
    }, [
      h('circle', {
        key: 'halo', className: 'ssm-halo',
        cx: p.x, cy: p.y, r: p.r + 11,
      }),
      h('circle', {
        key: 'ring', className: 'ssm-ring',
        cx: p.x, cy: p.y, r: p.r + 4.5,
      }),
      h('circle', {
        key: 'dot', className: 'ssm-dot',
        cx: p.x, cy: p.y, r: p.r,
      }),
      // 命中区放大到 16px，鼠标不用瞄准
      h('circle', {
        key: 'hit', cx: p.x, cy: p.y, r: Math.max(16, p.r + 8),
        fill: 'transparent', stroke: 'none',
      }),
      h('text', {
        key: 'label', className: 'ssm-label',
        x: lab.x, y: lab.y, textAnchor: lab.anchor,
      }, lab.text),
    ]);
  });

  return h('div', { className: 'ssm-wrap', ref: wrapRef, style: { height } }, [
    h('style', { key: 'css' }, CSS),
    h('svg', {
      key: 'svg',
      className: 'ssm-svg',
      viewBox: `0 0 ${w} ${hgt}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'group',
      'aria-label': `场景依赖星图：${nodes.length} 个场景，${edges.length} 条依赖`,
      onClick: () => { setSelected(null); if (onSelect) onSelect(null); },
    }, [defs, h('g', { key: 'edges' }, edgeEls), h('g', { key: 'nodes' }, nodeEls)]),
  ]);
}

// ════════════════════════════════════════════════════════════
//  12. 图例（和边样式同源，不会画成两套）
// ════════════════════════════════════════════════════════════

function SceneStarMapLegend(props) {
  const { kinds = Object.keys(EDGE_KINDS) } = props;
  return h('div', {
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '14px',
      marginTop: 10, fontSize: 11,
      color: 'var(--dsw-alias-label-secondary)',
    },
  }, kinds.map((k) => {
    const kind = EDGE_KINDS[k];
    if (!kind) return null;
    return h('span', {
      key: k,
      style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
    }, [
      h('svg', { key: 's', width: 18, height: 6, viewBox: '0 0 18 6', 'aria-hidden': 'true' },
        h('line', {
          x1: 0, y1: 3, x2: 18, y2: 3,
          stroke: 'var(--dsw-alias-label-secondary)',
          strokeWidth: kind.width,
          strokeOpacity: Math.min(0.9, kind.opacity + 0.35),
          strokeDasharray: kind.dash || undefined,
          strokeLinecap: 'round',
        })),
      h('span', { key: 't' }, kind.label),
    ]);
  }));
}



    // ══════════════════════════════════════════════════════
    //  数据通道（Host 在 webServer 上注册的只读路由）
    // ══════════════════════════════════════════════════════
    const ROUTE = '/memory-neuron';

    async function fetchOverview(force) {
      const url = ROUTE + '/overview' + (force ? '?force=1' : '');
      const res = await fetch(url, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    // ══════════════════════════════════════════════════════
    //  状态色：按六件套完整度
    //
    //  只用主题里真实存在的 state token；不用自造色。
    // ══════════════════════════════════════════════════════
    const STATE_COLORS = {
      good: 'var(--mn-success)',
      ok: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--mn-warn)',
      bad: 'var(--dsw-alias-state-error-primary)',
      none: 'var(--dsw-alias-state-idle-primary)',
    };

    function completenessOf(s) {
      return [s.hasContract, s.hasIdentity, s.hasMemory, s.hasSkill]
        .filter(Boolean).length;
    }

    function stateOf(s) {
      if (s.health && s.health.verdict === 'bad') return 'bad';
      const c = completenessOf(s);
      if (c === 4) return 'good';
      if (c === 3) return 'ok';
      if (c === 2) return 'warn';
      return 'bad';
    }

    // ══════════════════════════════════════════════════════
    //  面板样式
    //
    //  布局约束（从 dsh-client-ui-layout 源码实测）：
    //    宿主容器 .mainPanel{display:flex;flex-direction:column;flex:1;
    //                        min-width:0;min-height:0}
    //    外挂 [data-global-panel]{padding-top:max(0,48px - --dsh-frame-top-clearance)}
    //    中间层可能是 display:contents（不产生盒子，子元素直接参与祖先布局）
    //
    //  所以根容器：纯 flex:1 填满 + min-width/height:0 允许收缩
    //    × 不要同时设 width:100%（会和 flex 打架导致溢出）
    //    ✓ 全子树 box-sizing:border-box（溢出最常见的原因）
    // ══════════════════════════════════════════════════════
    const PANEL_CSS = `
.mn-root,.mn-root *,.mn-root *::before,.mn-root *::after{box-sizing:border-box;}
.mn-root{
  --mn-success: color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%,
                 var(--dsw-alias-label-primary) 28%);
  --mn-warn: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 68%,
             var(--dsw-alias-label-primary) 32%);
  --mn-error: var(--dsw-alias-state-error-primary);
  flex:1 1 auto;min-width:0;min-height:0;
  display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.55;
  overflow:hidden;position:relative;
}

/* ── 顶栏 ── */
.mn-top{flex:0 0 auto;display:flex;align-items:center;gap:12px;
  padding:12px 20px;min-height:52px;
  border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);}
.mn-brand{display:flex;align-items:baseline;gap:9px;min-width:0;}
.mn-title{font-weight:600;font-size:14px;white-space:nowrap;}
.mn-meta{color:var(--dsw-alias-label-secondary);font-size:12px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mn-grow{flex:1 1 auto;min-width:0;}
.mn-search{
  appearance:none;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  border-radius:6px;padding:5px 10px;font-size:12px;
  width:170px;flex:0 1 170px;min-width:0;outline:none;
  transition:border-color .15s;}
.mn-search:focus{border-color:var(--dsw-alias-brand-primary);}
.mn-search::placeholder{color:var(--dsw-alias-label-tertiary);}
.mn-btn{
  appearance:none;border:1px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-secondary);
  border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;
  white-space:nowrap;transition:color .15s,border-color .15s;}
.mn-btn:hover{color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-interactive-bg-hover);}
.mn-btn[disabled]{opacity:.5;cursor:default;}

.mn-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 20px 30px;}

/* ── 概览卡（flex 而非 grid：auto-fit 在测量有偏差时会溢出）── */
.mn-stats{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;}
.mn-stat{flex:1 1 148px;min-width:0;
  border:1px solid var(--dsw-alias-border-l1);border-radius:9px;
  padding:11px 13px;background:var(--dsw-alias-bg-layer-1);}
.mn-stat-k{color:var(--dsw-alias-label-secondary);font-size:11px;
  margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mn-stat-v{font-size:19px;font-weight:600;line-height:1.2;
  font-variant-numeric:tabular-nums;}
.mn-stat-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

/* ── 星图容器 ── */
.mn-graph-wrap{min-width:0;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);}
.mn-graph-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.mn-graph-title{font-size:12px;font-weight:600;white-space:nowrap;}

/* ── 区块 ── */
.mn-section{margin-top:18px;}
.mn-section-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.mn-section-title{font-size:12px;font-weight:600;}
.mn-section-count{color:var(--dsw-alias-label-tertiary);font-size:11px;}

/* ── 场景卡 ── */
.mn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));
  gap:11px;}
.mn-card{min-width:0;
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  padding:13px 14px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;
  transition:border-color .15s,background .15s;}
.mn-card:hover{border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2);}
.mn-card[data-on="1"]{border-color:var(--dsw-alias-brand-primary);}

.mn-card-head{display:flex;align-items:baseline;gap:7px;margin-bottom:6px;}
.mn-card-name{font-weight:600;font-size:13px;}
.mn-card-id{color:var(--dsw-alias-label-tertiary);font-size:11px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.8;}
.mn-card-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;
  margin-left:auto;align-self:center;}

.mn-card-desc{color:var(--dsw-alias-label-secondary);font-size:12px;
  line-height:1.5;min-height:2.9em;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;}

.mn-card-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px;}
.mn-tag{font-size:10.5px;padding:1px 6px;border-radius:4px;
  border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
.mn-tag[data-on="1"]{color:var(--mn-success);
  border-color:var(--dsw-alias-state-success-tertiary);}
.mn-tag[data-off="1"]{opacity:.5;}

/* ── 详情 ── */
.mn-detail{margin-top:18px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.mn-detail-head{display:flex;align-items:center;gap:10px;
  padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.mn-detail-name{font-weight:600;font-size:13px;}
.mn-detail-role{color:var(--dsw-alias-label-secondary);font-size:12px;
  padding:10px 14px 0;line-height:1.6;}
.mn-detail-body{padding:12px 14px 15px;}
.mn-kv{display:grid;grid-template-columns:92px 1fr;gap:6px 12px;
  font-size:12px;margin-bottom:10px;}
.mn-kv-k{color:var(--dsw-alias-label-tertiary);}
.mn-kv-v{color:var(--dsw-alias-label-primary);word-break:break-word;}

.mn-flow-title{font-size:11px;color:var(--dsw-alias-label-tertiary);
  margin:12px 0 6px;}
.mn-flow{display:flex;flex-direction:column;gap:4px;}
.mn-flow-row{display:flex;align-items:baseline;gap:8px;font-size:12px;
  padding:5px 9px;border-radius:5px;background:var(--dsw-alias-bg-base);}
.mn-flow-row code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;color:var(--dsw-alias-label-tertiary);}
.mn-flow-arrow{color:var(--dsw-alias-label-tertiary);font-size:11px;}


/* ── 运营区块 ── */
.mn-ops{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));
  gap:11px;margin-top:14px;}
.mn-op{min-width:0;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;}
.mn-op-head{display:flex;align-items:center;gap:8px;margin-bottom:9px;}
.mn-op-title{font-size:12px;font-weight:600;}
.mn-op-badge{font-size:10.5px;padding:1px 6px;border-radius:4px;
  background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-tertiary);}
.mn-op-list{display:flex;flex-direction:column;gap:6px;}
.mn-op-row{display:flex;align-items:baseline;gap:8px;font-size:12px;
  min-width:0;}
.mn-op-row-k{color:var(--dsw-alias-label-secondary);flex:0 0 auto;
  min-width:64px;max-width:110px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;}
.mn-op-row-v{color:var(--dsw-alias-label-primary);min-width:0;flex:1 1 auto;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mn-op-row-n{margin-left:auto;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary);font-size:11px;flex:0 0 auto;}
/* 待办行：正文可能较长，允许两行 */
.mn-op-row[data-multiline="1"]{align-items:flex-start;}
.mn-op-row[data-multiline="1"] .mn-op-row-v{
  white-space:normal;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;line-height:1.45;}
.mn-op-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;
  padding:6px 0;}


/* ── 健康度条（场景卡内）── */
.mn-hbar{display:flex;align-items:center;gap:6px;margin-top:8px;}
.mn-hbar-track{flex:1 1 auto;height:3px;border-radius:2px;
  background:var(--dsw-alias-border-l1);overflow:hidden;min-width:0;}
.mn-hbar-fill{height:100%;border-radius:2px;transition:width .3s ease;}
.mn-hbar-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  flex:0 0 auto;font-variant-numeric:tabular-nums;}

/* ── 详情里的健康度指标组 ── */
.mn-hmetrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));
  gap:8px;margin:4px 0 12px;}
.mn-hmetric{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  padding:8px 10px;background:var(--dsw-alias-bg-base);min-width:0;}
.mn-hmetric-k{color:var(--dsw-alias-label-tertiary);font-size:10.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mn-hmetric-v{font-size:15px;font-weight:600;line-height:1.25;
  font-variant-numeric:tabular-nums;}
.mn-hmetric-sub{color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:1px;}


/* ── 面板清单（详情里）── */
.mn-panels{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px;}
.mn-panel-chip{display:inline-flex;align-items:center;gap:5px;
  font-size:11px;padding:3px 8px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.mn-panel-type{font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--dsw-alias-label-tertiary);opacity:.9;}

/* ── 基线对比（运营区块）── */
.mn-base-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));
  gap:8px;}
.mn-base-item{min-width:0;}
.mn-base-k{color:var(--dsw-alias-label-tertiary);font-size:10.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mn-base-v{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;
  line-height:1.3;}
.mn-base-row{display:flex;align-items:baseline;gap:6px;font-size:12px;}
.mn-base-row-k{color:var(--dsw-alias-label-secondary);flex:0 0 auto;min-width:76px;}
.mn-base-row-v{font-variant-numeric:tabular-nums;}

/* ── 场地地图规则（折叠）── */
.mn-rules{display:flex;flex-direction:column;gap:3px;margin-top:4px;}
.mn-rule{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);
  display:flex;gap:7px;align-items:baseline;}
.mn-rule-n{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  flex:0 0 auto;min-width:16px;}
.mn-rule-t{min-width:0;word-break:break-word;}


/* ── 五档修改权 ── */
.mn-tiers{display:flex;flex-direction:column;gap:5px;}
.mn-tier{display:flex;align-items:baseline;gap:8px;font-size:12px;min-width:0;}
.mn-tier-badge{flex:0 0 auto;width:18px;height:18px;border-radius:4px;
  display:inline-flex;align-items:center;justify-content:center;
  font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;
  border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary);}
.mn-tier-badge[data-t="A"]{border-color:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-state-error-primary);}
.mn-tier-badge[data-t="C"]{border-color:var(--mn-warn);
  color:var(--mn-warn);}
.mn-tier-badge[data-t="D"]{border-color:var(--mn-success);
  color:var(--mn-success);}
.mn-tier-desc{color:var(--dsw-alias-label-secondary);font-size:11.5px;
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mn-tier-n{margin-left:auto;color:var(--dsw-alias-label-tertiary);
  font-size:11px;font-variant-numeric:tabular-nums;flex:0 0 auto;}

/* ── 规则明细（可折叠）── */
.mn-rules-box{margin-top:6px;}
.mn-rules-toggle{appearance:none;border:0;background:transparent;padding:0;
  color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer;
  text-decoration:underline;text-underline-offset:2px;}
.mn-rules-toggle:hover{color:var(--dsw-alias-label-primary);}
.mn-rules{display:flex;flex-direction:column;gap:3px;margin-top:6px;
  max-height:220px;overflow:auto;}
.mn-rule{display:flex;align-items:baseline;gap:7px;font-size:11px;
  line-height:1.45;min-width:0;}
.mn-rule-tier{flex:0 0 auto;font-weight:700;font-variant-numeric:tabular-nums;
  width:12px;color:var(--dsw-alias-label-tertiary);}
.mn-rule-pat{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--dsw-alias-label-secondary);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mn-rule-owner{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:10.5px;}

/* ── 空/错 ── */
.mn-empty{padding:56px 20px;text-align:center;
  color:var(--dsw-alias-label-secondary);font-size:13px;}
.mn-error{margin:18px;padding:14px 16px;border-radius:9px;
  border:1px solid var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-error);font-size:12px;line-height:1.6;}
.mn-error-c{color:var(--dsw-alias-label-tertiary);font-size:11px;
  font-family:ui-monospace,monospace;margin-top:8px;word-break:break-all;}

@keyframes mn-pulse{0%,100%{opacity:.42}50%{opacity:.85}}
.mn-skel{background:var(--dsw-alias-bg-skeleton);border-radius:6px;
  animation:mn-pulse 1.25s ease-in-out infinite;}
`;

    // ══════════════════════════════════════════════════════
    //  子组件：统计卡
    // ══════════════════════════════════════════════════════
    function StatCard({ label, value, sub }) {
      return h('div', { className: 'mn-stat' }, [
        h('div', { key: 'k', className: 'mn-stat-k' }, label),
        h('div', { key: 'v', className: 'mn-stat-v' }, String(value)),
        sub ? h('div', { key: 's', className: 'mn-stat-sub' }, sub) : null,
      ]);
    }


    // ══════════════════════════════════════════════════════
    //  子组件：运营指标
    //
    //  数据来源：_共享记忆 下的真实台账
    //    健康度.json / 派单台账.json / 进化台账.json / _待办.md
    // ══════════════════════════════════════════════════════
    function OpsRow({ k, v, n }) {
      // 不用 title 属性：会弹原生 tooltip，与宿主 Tooltip 组件风格不一致
      return h('div', { className: 'mn-op-row' }, [
        h('span', { key: 'k', className: 'mn-op-row-k' }, k),
        h('span', { key: 'v', className: 'mn-op-row-v' }, v),
        n !== undefined ? h('span', { key: 'n', className: 'mn-op-row-n' }, String(n)) : null,
      ]);
    }

    /**
     * 清理待办行文本：
     *   "- [2026-11-09 10:52] 机制体检失败：越界哨兵（1 项）"
     *   → "机制体检失败：越界哨兵（1 项）"
     */
    function cleanTodoLine(raw) {
      let s = String(raw || '').trim();
      // 去掉 "- [时间] " 前缀
      const m = s.match(/^[-*]\s*\[[^\]]*\]\s*(.*)$/);
      if (m) s = m[1];
      else s = s.replace(/^[-*]\s*/, '');
      return s || raw;
    }

    function OpsBlock({ title, badge, children }) {
      return h('div', { className: 'mn-op' }, [
        h('div', { key: 'h', className: 'mn-op-head' }, [
          h('span', { key: 't', className: 'mn-op-title' }, title),
          badge !== undefined
            ? h('span', { key: 'b', className: 'mn-op-badge' }, String(badge))
            : null,
        ]),
        h('div', { key: 'l', className: 'mn-op-list' }, children),
      ]);
    }

    function OpsSection({ shared }) {
      if (!shared) return null;

      const health = shared.health;
      const dispatch = shared.dispatch;
      const evo = shared.evolution;
      const todo = shared.todo;

      const blocks = [];

      // ── 健康度 ──
      if (health && health.summary) {
        const sm = health.summary;
        blocks.push(h(OpsBlock, {
          key: 'health',
          title: '健康度',
          badge: (health.window && health.window.days ? health.window.days + ' 天' : ''),
        }, [
          h(OpsRow, { key: 'a', k: '有数据', v: sm.withData + ' / ' + sm.scenes }),
          h(OpsRow, { key: 'b', k: '正常', v: String(sm.ok), n: 'ok' }),
          h(OpsRow, { key: 'c', k: '警告', v: String(sm.warn), n: 'warn' }),
          h(OpsRow, { key: 'd', k: '异常', v: String(sm.bad), n: 'bad' }),
          sm.noData > 0
            ? h(OpsRow, { key: 'e', k: '待采样', v: String(sm.noData) })
            : null,
        ]));
      }

      // ── 派单 ──
      if (dispatch) {
        const rows = [
          h(OpsRow, {
            key: 'a', k: '总数', v: String(dispatch.total),
            n: dispatch.closed + ' 已闭环',
          }),
        ];
        // 最近 3 条
        for (const it of (dispatch.items || []).slice(-3).reverse()) {
          rows.push(h(OpsRow, {
            key: 'i' + it.id,
            k: it.from + '→' + it.to,
            v: it.state,
          }));
        }
        blocks.push(h(OpsBlock, {
          key: 'dispatch', title: '派单台账', badge: dispatch.total,
        }, rows));
      }

      // ── 进化 ──
      if (evo) {
        const rows = [
          h(OpsRow, {
            key: 'a', k: '累计', v: String(evo.total),
            n: evo.pending + ' 观察中',
          }),
        ];
        for (const it of (evo.items || []).slice(-3).reverse()) {
          rows.push(h(OpsRow, {
            key: 'i' + it.id,
            k: it.level + ' · ' + it.scene,
            v: it.change || it.type || '',
            n: it.result,
          }));
        }
        const frozenCount = Object.keys(evo.frozen || {}).length;
        if (frozenCount > 0) {
          rows.push(h(OpsRow, { key: 'f', k: '已冻结', v: String(frozenCount) }));
        }
        blocks.push(h(OpsBlock, {
          key: 'evo', title: '进化台账', badge: evo.total,
        }, rows));
      }


      // ── 基线 ──
      const base = shared.baseline;
      if (base) {
        const items = [
          { k: '六件套', v: (base['六件套覆盖率'] !== undefined
            ? Math.round(base['六件套覆盖率'] * 100) + '%' : '—') },
          { k: '真实使用', v: (base['真实使用率'] !== undefined
            ? Math.round(base['真实使用率'] * 100) + '%' : '—') },
          { k: '工具数', v: String(base['工具总数'] ?? '—') },
          { k: '方案文档', v: String(base['方案文档数'] ?? '—') },
        ];
        blocks.push(h(OpsBlock, {
          key: 'baseline', title: '基线', badge: '快照',
        }, [
          h('div', { key: 'g', className: 'mn-base-grid' },
            items.map((it) => h('div', { key: it.k, className: 'mn-base-item' }, [
              h('div', { key: 'k', className: 'mn-base-k' }, it.k),
              h('div', { key: 'v', className: 'mn-base-v' }, it.v),
            ]))),
        ]));
      }

      // ── 场地地图（五档修改权）──
      // ★ 必须用 h(SiteMapTiers, {...}) 而不是直接调用
      //   因为 SiteMapTiers 内部用了 useState，
      //   直接函数调用会让 hook 注册到 OpsSection 的上下文中，
      //   造成 hook 顺序错乱 → 整个组件树白屏。
      if (shared.siteMap && shared.siteMap.rules) {
        blocks.push(h(SiteMapTiers, {
          key: 'sitemap',
          siteMap: shared.siteMap,
        }));
      }

      // ── 待办 ──
      if (todo && todo.total > 0) {
        blocks.push(h(OpsBlock, {
          key: 'todo', title: '待办', badge: todo.total,
        }, [
          ...(todo.sample || []).slice(0, 4).map((line, i) => h('div', {
            key: 't' + i,
            className: 'mn-op-row',
            'data-multiline': '1',
          }, [
            h('span', {
              key: 'v',
              className: 'mn-op-row-v',
            }, cleanTodoLine(String(line))),
          ])),
        ]));
      }

      if (blocks.length === 0) return null;

      return h('div', { className: 'mn-section' }, [
        h('div', { key: 'h', className: 'mn-section-head' }, [
          h('span', { key: 't', className: 'mn-section-title' }, '运营'),
        ]),
        h('div', { key: 'g', className: 'mn-ops' }, blocks),
      ]);
    }


    // ══════════════════════════════════════════════════════
    //  健康度可视化
    //
    //  数据来源：_共享记忆/健康度.json 的 scenes[<id>]
    //    tasks / acked / rework / firstPass / firstPassRate /
    //    reworkRate / crossBoundary / verdict / hasEnoughSamples
    //
    //  设计：只用一根细条表达一次通过率，
    //        样本不足时显示"待采样"而不是画一根空条（空条会被误读为 0%）。
    // ══════════════════════════════════════════════════════
    function healthColorOf(rate) {
      if (rate === null || rate === undefined) return STATE_COLORS.none;
      if (rate >= 0.8) return STATE_COLORS.good;
      if (rate >= 0.5) return STATE_COLORS.ok;
      if (rate >= 0.3) return STATE_COLORS.warn;
      return STATE_COLORS.bad;
    }

    function HealthBar({ scene }) {
      const hdata = scene.health;
      // 无健康度数据、或样本不足 → 显示"待采样"
      const rate = hdata ? hdata.firstPassRate : null;
      const hasData = rate !== null && rate !== undefined;

      if (!hasData) {
        return h('div', { className: 'mn-hbar' }, [
          h('div', { key: 't', className: 'mn-hbar-track' }),
          h('span', { key: 'l', className: 'mn-hbar-label' },
            hdata && hdata.tasks > 0 ? '待采样' : '无记录'),
        ]);
      }

      const pct = Math.round(rate * 100);
      return h('div', { className: 'mn-hbar' }, [
        h('div', { key: 't', className: 'mn-hbar-track' }, [
          h('div', {
            key: 'f',
            className: 'mn-hbar-fill',
            style: {
              width: Math.max(3, pct) + '%',
              background: healthColorOf(rate),
            },
          }),
        ]),
        h('span', { key: 'l', className: 'mn-hbar-label' }, pct + '%'),
      ]);
    }


    // ══════════════════════════════════════════════════════
    //  场地地图：五档修改权
    //
    //  数据来源：_共享记忆/场地地图.json
    //    每条规则 { tier, pattern, owner, desc }
    //    tier: A共享·宪法 / B共享·板与台账 / C共享·工具 / D自己专属 / E别人专属
    //
    //  这是越界哨兵的检查依据 —— 展示它能让权限边界可见。
    //  A 档最危险（只有宿主能改），用 error 色标注。
    // ══════════════════════════════════════════════════════
    const TIER_META = {
      A: { label: '宪法', desc: '共享·只有宿主能改' },
      B: { label: '台账', desc: '共享·各场景写自己那些行' },
      C: { label: '工具', desc: '共享·管理员场景改' },
      D: { label: '专属', desc: '自己的地盘·自己改' },
      E: { label: '禁区', desc: '别人的地盘·一个字都不许写' },
    };

    function SiteMapTiers({ siteMap }) {
      const [open, setOpen] = useState(false);
      const tiers = siteMap.tiers || {};
      const rules = siteMap.rules || [];

      // 按档位统计
      const counts = {};
      for (const r of rules) {
        counts[r.tier] = (counts[r.tier] || 0) + 1;
      }

      const order = ['A', 'B', 'C', 'D', 'E'];
      const tierRows = order
        .filter((t) => counts[t] || tiers[t])
        .map((t) => {
          const meta = TIER_META[t] || { label: tiers[t] || t, desc: '' };
          return h('div', { key: t, className: 'mn-tier' }, [
            h('span', {
              key: 'b', className: 'mn-tier-badge', 'data-t': t,
            }, t),
            h('span', { key: 'd', className: 'mn-tier-desc', },
              meta.desc || tiers[t] || ''),
            h('span', { key: 'n', className: 'mn-tier-n' },
              String(counts[t] || 0)),
          ]);
        });

      const ruleRows = open
        ? h('div', { className: 'mn-rules' },
            rules.map((r, i) => h('div', {
              key: i, className: 'mn-rule',
              title: r.desc || undefined,
            }, [
              h('span', { key: 't', className: 'mn-rule-tier' }, r.tier || '?'),
              h('span', { key: 'p', className: 'mn-rule-pat' }, r.pattern || ''),
              h('span', { key: 'o', className: 'mn-rule-owner' }, r.owner || ''),
            ])))
        : null;

      return h(OpsBlock, {
        title: '场地地图',
        badge: rules.length + ' 条规则',
      }, [
        h('div', { key: 'tiers', className: 'mn-tiers' }, tierRows),
        h('div', { key: 'box', className: 'mn-rules-box' }, [
          h('button', {
            key: 't',
            className: 'mn-rules-toggle',
            type: 'button',
            onClick: () => setOpen(!open),
          }, open ? '收起规则明细' : '展开规则明细'),
          ruleRows,
        ]),
      ]);
    }

    // ══════════════════════════════════════════════════════
    //  子组件：场景卡
    // ══════════════════════════════════════════════════════
    function SceneCard({ scene, onEnter, onLeave, onPick, active }) {
      const color = STATE_COLORS[stateOf(scene)];

      const tag = (label, on) => h('span', {
        key: label,
        className: 'mn-tag',
        'data-on': on ? '1' : undefined,
        'data-off': on ? undefined : '1',
      }, (on ? '✓ ' : '· ') + label);

      return h('div', {
        className: 'mn-card',
        'data-on': active ? '1' : undefined,
        onMouseEnter: () => onEnter && onEnter(scene.id),
        onMouseLeave: () => onLeave && onLeave(null),
        onClick: () => onPick && onPick(scene.id),
      }, [
        h('div', { key: 'h', className: 'mn-card-head' }, [
          h('span', { key: 'n', className: 'mn-card-name' }, scene.name),
          h('span', { key: 'i', className: 'mn-card-id' }, scene.id),
          h('span', {
            key: 'd', className: 'mn-card-dot', style: { background: color },
          }),
        ]),
        h('div', { key: 'desc', className: 'mn-card-desc' },
          scene.role || scene.description || '（这个场景还没有写定位）'),
        h('div', { key: 'tags', className: 'mn-card-tags' }, [
          tag('契约', scene.hasContract),
          tag('身份', scene.hasIdentity),
          tag('记忆', scene.hasMemory),
          tag('技能', scene.hasSkill),
          tag('绑定', scene.hasSessionBinding),
          h('span', {
            key: 'p', className: 'mn-tag', style: { marginLeft: 'auto' },
          }, scene.panels + ' 面板'),
        ]),
        // ★ 组件必须用 h() 调用，不能直接 HealthBar({...})
        //   直接调用会让组件内部的 hook 注册到父组件上下文，
        //   一旦该组件加 useState 就会 hook 顺序错乱 → 白屏。
        h(HealthBar, { key: 'hb', scene }),
      ]);
    }



    // 详情里的面板清单
    function PanelChips({ scene }) {
      const list = scene.panelList || [];
      if (list.length === 0) {
        return h('div', { className: 'mn-flow-title' }, '面板：无配置');
      }
      return h('div', {}, [
        h('div', { key: 't', className: 'mn-flow-title' },
          '面板（' + list.length + '）'),
        h('div', { key: 'l', className: 'mn-panels' },
          list.map((p, i) => h('span', {
            key: 'p' + i,
            className: 'mn-panel-chip',
          }, [
            h('span', { key: 'n' }, p.title || p.type || '?'),
            p.type && p.title
              ? h('span', { key: 't', className: 'mn-panel-type' }, p.type)
              : null,
          ]))),
      ]);
    }

    // 详情里的健康度指标组
    function HealthMetrics({ scene }) {
      const hdata = scene.health;
      if (!hdata || !hdata.tasks) return null;

      const fmtRate = (r) => (r === null || r === undefined
        ? '—'
        : Math.round(r * 100) + '%');

      const items = [
        { k: '任务数', v: String(hdata.tasks) },
        { k: '一次通过', v: fmtRate(hdata.firstPassRate) },
        { k: '返工率', v: fmtRate(hdata.reworkRate) },
        { k: '越界', v: String(hdata.crossBoundary || 0) },
      ];

      return h('div', { className: 'mn-hmetrics' },
        items.map((it) => h('div', { key: it.k, className: 'mn-hmetric' }, [
          h('div', { key: 'k', className: 'mn-hmetric-k' }, it.k),
          h('div', { key: 'v', className: 'mn-hmetric-v' }, it.v),
        ])));
    }

    // ══════════════════════════════════════════════════════
    //  子组件：场景详情
    // ══════════════════════════════════════════════════════
    function SceneDetail({ scene, scenes, edges, onClose }) {
      const nameOf = (id) => {
        const s = scenes.find((x) => x.id === id);
        return s ? s.name : id;
      };

      const inEdges = edges.filter((e) => e.to === scene.id);
      const outEdges = edges.filter((e) => e.from === scene.id);

      const kv = (k, v) => [
        h('div', { key: 'k' + k, className: 'mn-kv-k' }, k),
        h('div', { key: 'v' + k, className: 'mn-kv-v' }, v),
      ];

      const flowRow = (e, dir) => h('div', {
        key: dir + e.from + e.to + e.kind, className: 'mn-flow-row',
      }, [
        h('span', { key: 'a' }, dir === 'in' ? nameOf(e.from) : nameOf(e.to)),
        h('span', { key: 'arr', className: 'mn-flow-arrow' },
          dir === 'in' ? '→ 本场景' : '→'),
        e.label ? h('code', { key: 'l' }, e.label) : null,
        h('span', {
          key: 'k',
          style: { marginLeft: 'auto', opacity: .65, fontSize: '10.5px' },
        }, dir === 'in' ? '输入' : (e.kind === 'flow' ? '输出' : '间接')),
      ]);

      return h('div', { className: 'mn-detail' }, [
        h('div', { key: 'h', className: 'mn-detail-head' }, [
          h('span', { key: 'n', className: 'mn-detail-name' }, scene.name),
          h('span', { key: 'i', className: 'mn-card-id' }, scene.id),
          h('span', { key: 'g', className: 'mn-grow' }),
          h('button', {
            key: 'x', className: 'mn-btn', type: 'button', onClick: onClose,
          }, '关闭'),
        ]),
        h('div', { key: 'role', className: 'mn-detail-role' },
          scene.role || scene.description || '（无定位描述）'),
        scene.description && scene.description !== scene.role
          ? h('div', {
              key: 'desc',
              className: 'mn-detail-role',
              style: { paddingTop: '4px', opacity: 0.9 },
            }, scene.description)
          : null,
        h('div', { key: 'b', className: 'mn-detail-body' }, [
          h(HealthMetrics, { key: 'hm', scene }),
          h(PanelChips, { key: 'pc', scene }),
          h('div', { key: 'kv', className: 'mn-kv' }, [
            ...kv('场景 ID', scene.id),
            ...kv('面板', String(scene.panels)),
            ...kv('契约', scene.hasContract ? '已有' : '缺失'),
            ...kv('身份卡', scene.hasIdentity ? '已有' : '缺失'),
            ...kv('私有记忆', scene.hasMemory
              ? (scene.memoryBytes / 1024).toFixed(1) + ' KB / ' + scene.memoryFiles + ' 文件'
              : '缺失'),
            ...kv('专属技能', scene.hasSkill ? '已有' : '缺失'),
            ...kv('会话绑定', scene.hasSessionBinding
              ? (scene.panelId ? '已绑定（面板 ' + scene.panelId + '）' : '已绑定')
              : '缺失（无独立面板入口）'),
            ...(scene.health
              ? kv('健康度', scene.health.verdict +
                  (scene.health.firstPassRate !== null
                    ? '（一次通过率 ' + Math.round(scene.health.firstPassRate * 100) + '%）'
                    : '（样本不足）'))
              : []),
            ...(scene.updatedAt ? kv('最近更新', scene.updatedAt.slice(0, 10)) : []),
          ]),

          inEdges.length
            ? h('div', { key: 'in' }, [
                h('div', { key: 't', className: 'mn-flow-title' },
                  '输入依赖（' + inEdges.length + '）'),
                h('div', { key: 'l', className: 'mn-flow' },
                  inEdges.map((e) => flowRow(e, 'in'))),
              ])
            : null,

          outEdges.length
            ? h('div', { key: 'out' }, [
                h('div', { key: 't', className: 'mn-flow-title' },
                  '输出流向（' + outEdges.length + '）'),
                h('div', { key: 'l', className: 'mn-flow' },
                  outEdges.map((e) => flowRow(e, 'out'))),
              ])
            : null,
        ]),
      ]);
    }

    // ══════════════════════════════════════════════════════
    //  主面板
    // ══════════════════════════════════════════════════════
    function NeuronPanel() {
      const [phase, setPhase] = useState('loading');
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [hoverId, setHoverId] = useState(null);
      const [selected, setSelected] = useState(null);
      const [query, setQuery] = useState('');

      const load = useCallback((force) => {
        setPhase('loading');
        setError(null);
        return fetchOverview(force)
          .then((d) => {
            if (!d || d.ok !== true) {
              setPhase('error');
              setError((d && d.error) || '返回数据格式异常');
              return;
            }
            setData(d);
            setPhase('ready');
          })
          .catch((e) => {
            setPhase('error');
            setError(String((e && e.message) || e));
          });
      }, []);

      useEffect(() => { load(false); }, [load]);

      const scenes = (data && data.scenes) || [];
      const edges = (data && data.edges) || [];

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return scenes;
        return scenes.filter((s) =>
          s.name.toLowerCase().includes(q)
          || s.id.toLowerCase().includes(q)
          || (s.role || '').toLowerCase().includes(q));
      }, [scenes, query]);

      const selectedScene = selected
        ? scenes.find((s) => s.id === selected) || null
        : null;

      const head = h('div', { className: 'mn-top' }, [
        h('div', { key: 'b', className: 'mn-brand' }, [
          h('span', { key: 't', className: 'mn-title' }, '记忆神经元'),
          h('span', { key: 'm', className: 'mn-meta' },
            phase === 'ready'
              ? scenes.length + ' 个场景 · ' + edges.length + ' 条依赖'
              : '场景星图与依赖关系'),
        ]),
        h('span', { key: 'g', className: 'mn-grow' }),
        h('input', {
          key: 'q',
          className: 'mn-search',
          type: 'text',
          placeholder: '搜索场景…',
          value: query,
          onChange: (e) => setQuery(e.target.value),
        }),
        h('button', {
          key: 'r',
          className: 'mn-btn',
          type: 'button',
          disabled: phase === 'loading',
          onClick: () => load(true),
        }, phase === 'loading' ? '读取中…' : '刷新'),
      ]);

      let body;
      if (phase === 'loading') {
        body = h('div', { className: 'mn-body' }, [
          h('div', { key: 's', className: 'mn-stats' },
            [1, 2, 3, 4].map((i) => h('div', {
              key: i, className: 'mn-skel', style: { height: '66px' },
            }))),
          h('div', {
            key: 'g', className: 'mn-skel',
            style: { height: '340px', marginTop: '14px' },
          }),
        ]);
      } else if (phase === 'error') {
        body = h('div', { className: 'mn-body' }, [
          h('div', { key: 'e', className: 'mn-error' }, [
            h('div', { key: 'm' }, '无法加载场景数据'),
            h('div', { key: 'c', className: 'mn-error-c' }, error || '未知错误'),
          ]),
        ]);
      } else {
        const c = data.counts || {};
        const cov = data.coverage || [];
        const covTotal = cov.reduce((a, x) => a + x.count, 0);
        const covMax = scenes.length * cov.length;

        const stats = h('div', { key: 'st', className: 'mn-stats' }, [
          h(StatCard, { key: 'a', label: '场景', value: c.scenes, sub: '已注册' }),
          h(StatCard, { key: 'b', label: '依赖边', value: c.edges, sub: '含间接关联' }),
          h(StatCard, {
            key: 'c', label: '契约覆盖',
            value: c.withContract + '/' + c.scenes, sub: '场景契约',
          }),
          h(StatCard, {
            key: 'd', label: '六件套',
            value: covTotal + '/' + covMax,
            sub: cov.map((x) => x.label.replace('专属', '') + ' ' + x.count).join(' · '),
          }),
          h(StatCard, {
            key: 'e', label: '会话绑定',
            value: scenes.filter((x) => x.hasSessionBinding).length + '/' + scenes.length,
            sub: scenes.filter((x) => !x.hasSessionBinding)
              .map((x) => x.name).join(' · ') || '全部已绑定',
          }),
        ]);

        const graph = h('div', { key: 'gw', className: 'mn-graph-wrap' }, [
          h('div', { key: 'h', className: 'mn-graph-head' }, [
            h('span', { key: 't', className: 'mn-graph-title' }, '依赖星图'),
            h('span', { key: 'g', className: 'mn-grow' }),
            h(SceneStarMapLegend, { key: 'lg', kinds: ['flow', 'indirect'] }),
          ]),
          h(SceneStarMap, {
            key: 'm',
            nodes: scenes,
            edges,
            height: 320,
            hoverId,
            onHover: setHoverId,
            onSelect: setSelected,
          }),
        ]);

        const grid = h('div', { key: 'sc', className: 'mn-section' }, [
          h('div', { key: 'h', className: 'mn-section-head' }, [
            h('span', { key: 't', className: 'mn-section-title' }, '场景'),
            h('span', { key: 'c', className: 'mn-section-count' },
              query ? (filtered.length + ' / ' + scenes.length) : String(scenes.length)),
          ]),
          filtered.length
            ? h('div', { key: 'g', className: 'mn-grid' },
                filtered.map((s) => h(SceneCard, {
                  key: s.id,
                  scene: s,
                  active: hoverId === s.id || selected === s.id,
                  onEnter: setHoverId,
                  onLeave: setHoverId,
                  onPick: setSelected,
                })))
            : h('div', { key: 'e', className: 'mn-empty' }, '没有匹配的场景'),
        ]);

        body = h('div', { className: 'mn-body' }, [
          stats,
          h(OpsSection, { key: 'ops', shared: data.shared }),
          graph,
          grid,
          selectedScene
            ? h(SceneDetail, {
                key: 'd',
                scene: selectedScene,
                scenes,
                edges,
                onClose: () => setSelected(null),
              })
            : null,
        ]);
      }

      return h('div', { className: 'mn-root' }, [
        h('style', { key: 'css', 'data-memory-neuron': '' }, PANEL_CSS),
        head,
        body,
      ]);
    }

    // ══════════════════════════════════════════════════════
    //  侧边栏图标
    //
    //  优先用 primitives 的 IconWorkspaceTreeOutlineRegular（结构树），
    //  取不到或 sprite 未挂载时自绘，保证不空白。
    //
    //  ⚠ primitives 图标渲染为 <svg><use href="#dsw-icon-<glyph>-<weight>"/></svg>，
    //    字形定义由 dsh-client-ui-theme 注入。若宿主未注入，图标会是空白，
    //    所以这里始终提供自绘版本作为兜底。
    // ══════════════════════════════════════════════════════
    function NeuronIcon(props) {
      const size = (props && props.size) || 16;
      const active = !!(props && props.active);

      // 自绘：节点-边-节点 的图谱语义
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        style: { display: 'block', opacity: active ? 1 : 0.82 },
      }, [
        // 连线
        h('path', {
          key: 'edges',
          d: 'M7.2 7.6 L16.8 12 M16.8 12 L7.2 16.4 M7.2 7.6 L7.2 16.4',
          stroke: 'currentColor',
          strokeWidth: 1.15,
          strokeLinecap: 'round',
          opacity: 0.42,
        }),
        // 节点
        h('circle', { key: 'n1', cx: 7.2, cy: 7.6, r: 2.35, fill: 'currentColor' }),
        h('circle', { key: 'n2', cx: 16.8, cy: 12, r: 2.75, fill: 'currentColor' }),
        h('circle', { key: 'n3', cx: 7.2, cy: 16.4, r: 2.35, fill: 'currentColor' }),
      ]);
    }

    // ══════════════════════════════════════════════════════
    //  注册
    //
    //  key 约束：sidebar.panellist.id === main.key（硬约束）
    //    layout.selectPanel 会校验 hasMainPanel，否则抛
    //    'layout.selectPanel: main panel "x" is not registered'
    //
    //  回调形态：箭头函数返回 1 个 disposer，语义最清晰。
    //  （generator 仅在需要合成多个同生命周期资源时才用）
    // ══════════════════════════════════════════════════════
    const PANEL_ID = 'memory-neuron';

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: '记忆神经元',
          }, NeuronIcon),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, NeuronPanel),
        );
      },
    };
  },
});
