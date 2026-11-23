# 场景知识星图 · 落地结论

> 全部数字来自对本项目真实数据的实测：9 个场景、11 条 flow 边
> （`workbench/sceneboard/scenes/*.json` 的 `outputs.to`）。
> 组件位于 `research/star-map-lab/src/scene-star-map.js`（1052 行，零依赖）。
> 截图与自检脚本同目录，可复跑。

---

## 1. 布局算法：分层为主 + 一维力松弛

### 结论

**用分层，不要用力导向，也不要用黄金角螺线。**

### 为什么

实测三种布局在同一份数据上的表现：

| 布局 | 边长 min/中位/max | 交叉数 | 问题 |
|---|---|---|---|
| **分层（推荐）** | 235 / 238 / 705 | **0** | 无 |
| 二维力导向 | 108 / 122 / 142 | 无法避免 | 缩成一个团，方向信息全丢 |
| 黄金角螺线 | — | 随机 | 位置与数据无关，等于没排版 |

力导向把 9 个节点收成边长 122px 的团，在 1000×340 的扁盒子里，
`research → arch-review` 和 `arch-review → build-plan` 两条边会互相缠住，
读者看不出"调研 → 竞品 → 架构 → 实施"这条主干。

黄金角螺线更糟：它只保证**不重叠**，不保证**位置有意义**。
同一个场景换个排序就换位置，用户每次刷新看到不同的图 —— 这是"看起来在乱动"的根源。

### 分层怎么做的

**x 轴 = Kahn 最长路径分层**（只按 `flow` 边，即契约的 `outputs.to`）：

```
layer 0: research, incident-analysis, pc-cleanup, self-review
layer 1: competitor-analyze, reverse-eng, hub
layer 2: arch-review
layer 3: build-plan
```

4 列，横向间距 `clamp(usableW / maxLayer, 150, 235)` —— **不要铺满**。
铺满会让跨 2 层的长边拉成横跨全屏的斜线（实测 705px），
固定 150~235px 再把整组居中，长边长度就与节点数解耦。

**y 轴 = 一维力松弛**，三个力，240 次迭代，线性退火：

```js
// ① 同列排斥：把同列节点推开到 ROW_GAP(62px)
if (dist < ROW_GAP) {
  const push = (ROW_GAP - dist) * 0.5 * alpha * (d > 0 ? 1 : -1);
  y.set(a, y.get(a) - push);
  y.set(b, y.get(b) + push);
}

// ② flow 边吸引：把前后置场景拉到同一水平线，读出"流程"
const pull = (b - a) * 0.09 * alpha;
y.set(e.from, a + pull);
y.set(e.to, b - pull);

// ③ 向中线收拢：防止被挤到画布边缘
y.set(id, clamp(v + (mid - v) * 0.012 * alpha, top, bottom));
```

`alpha = (1 - it/ITER) ** 1.35` —— 退火保证**必然收敛**，
不像力导向需要 `alphaDecay` 调参，也不会因为数据变化而震荡。

**列内排序用重心法**（Sugiyama 第 2 步），这是交叉数从 3 降到 0 的关键：

```js
// 正向扫：用上一层邻居的平均序号重排本层
// 反向扫：用下一层邻居的平均序号重排本层
// 重复 8 轮，只保留交叉数更少的顺序
const bary = sum(邻居在参考层的序号) / 邻居数;
col.sort((a, b) => bary(a) - bary(b));
```

交叉数是**真数出来的**（两两测 `(a1-a2)*(b1-b2) < 0`），
所以"排得更好"可验证，不是感觉。实测最终交叉数 = **0**。

### 如果坚持用力导向

`layoutForce2D()` 是完整可用的实现（第 560 行），速度 Verlet + 四个力：

```js
// ① 电荷斥力 F = charge * alpha / d²
const f = (charge * alpha) / d2;     // charge = -260, distanceMax = 340
// ② 弹簧 F = strength * alpha * (d - L)
const k = ((d - linkDistance) / d) * alpha * linkStrength;  // L=128, s=0.55
// ③ 碰撞：沿圆心连线硬推开（比软弹簧稳，不会抖）
if (d < a.r + b.r + collidePad) { ... }
// ④ 向心 + 边界
```

实测：300 tick 收敛，最小圆间距 16.8px，**确定性**（固定 seed 的 mulberry32）。
**什么时候该用它**：节点数 > 20，或者关系本身没有方向（纯关联，非 pipeline）。
9 个有向场景节点不属于这种情况。

---

## 2. 边的绘制

### 直线 vs 贝塞尔

**默认直线，只在需要绕行时加弧度。**

一开始我给所有长边加了 `longBow = 14`，结果每条边都轻微弯曲，
整张图看起来"抖"。违反原则：**装饰性弧度是噪音**。

现在只有跨 ≥2 层、且直线会穿过中间节点时才加弧度：

| 边 | 跨层 | 弧度 |
|---|---|---|
| 其余 10 条 | 1 | 0 |
| `incident-analysis → build-plan` | 3 | 22 |

弧度按 `[22, 30, 40, 52, 66, 82]` 从小到大试，**第一个零碰撞解就停**。
弧度越大越像弓，越丑。

### 多重边不重叠

同一对节点间的多条边（含**反向边**）按序号对称错位到法线两侧：

```js
const key = [e.from, e.to].sort().join('\u0000');   // A→B 和 B→A 同组
list.sort((p, q) => (p.kind + p.from + p.to).localeCompare(...));  // 稳定，否则每帧跳
const slot = (k - (n - 1) / 2) * 20;                // 每条 20px
const sign = e.from === first ? 1 : -1;             // 反向边落另一侧
```

`bow` 是**曲线顶点**的偏移量，控制点要偏移 `2*bow`（二次贝塞尔中点性质）：

```js
const cx = mx + nx * bow * 2;   // 顶点偏移正好 = bow
```

本项目 11 条边无重边，但机制留着 —— 加 `domain`/`similar` 边后马上会用到。

### 方向性：用箭头，但要小

用 SVG `<marker>`，`markerUnits="userSpaceOnUse"`（**不要用默认的 strokeWidth**，
否则线宽变化时箭头大小跟着跳）：

```jsx
<marker id={id} viewBox="0 0 7 7" refX="5.6" refY="3.5"
        markerWidth="7" markerHeight="7"
        markerUnits="userSpaceOnUse" orient="auto">
  <path d="M1.5 1.5 L5.6 3.5 L1.5 5.5" fill="none"
        stroke="currentColor" strokeWidth={1.15}
        strokeLinecap="round" strokeLinejoin="round" />
</marker>
```

7×7 的**开口 V 形**，不是实心三角 —— 实心三角在高 DPI 下会糊成一个黑点。
`currentColor` 让它继承边的描边色，深浅色自动跟随。

**箭头堆积是真问题**：4 条边射向 `hub` 时，箭头会在这一个点叠成 `>>>`。
解法是按"到达角"把落点沿圆周扇开：

```js
const ang = Math.atan2(cy - b.y, cx - b.x) + angleOffset;  // 控制点→圆心的方向
const end = { x: b.x + cos(ang) * (b.r + 7), y: b.y + sin(ang) * (b.r + 7) };
// angleOffset = (slot - (total-1)/2) * min(0.30, (PI*0.62)/total)
```

每条边 17° 左右，最多摊开 112°。

### 裁剪到圆边界

**必须裁**，否则线头从圆下方穿出来，像没对准的箭头。

```js
// 起点：沿"圆心→控制点"方向退到圆周外 4px
const start = trimToCircle(a.x, a.y, cx, cy, a.r + 4);
// 终点：留 8px 给箭头
const end = trimToCircle(b.x, b.y, cx, cy, b.r + 8);
```

另外给节点圆加一圈**底色描边**（`stroke: var(--dsw-alias-bg-layer-1); stroke-width: 1.5`），
这样贴在圆边上的线不会紧贴视觉边缘：

```css
.ssm-dot {
  fill: var(--dsw-alias-brand-primary);
  stroke: var(--dsw-alias-bg-layer-1);   /* 挖空环 */
  stroke-width: 1.5;
}
```

---

## 3. 视觉层次（重点）

用户说"丑"，我实测抓到三个具体原因，全部可修。

### 3.1 渲染层次：三层，不是五层

```
① halo  柔光   r = r+11，opacity 0 → 0.14（仅 hover）
② ring  强调环 r = r+4.5，opacity 0 → 0.45（仅 hover）/ 0.8（选中）
③ dot   实心圆 r = 5.5 ~ 13.5，fill-opacity 0.92
```

**关键修正**：`ring` 一开始是**常驻** `opacity: 0.28`。

这是最大的丑源 —— 每个节点都套一个环，导致：
- 所有节点看起来一样大，把"按度数分大小"的信息**全吃掉**
- 9 个环叠在 1000×340 里，视觉噪音极大

改法：`ring` 默认 **opacity: 0**，只在 hover/选中出现。放大 4 倍截图前后对比，
节点立刻从"一堆套环的圆"变成"大小分明的主次"。

**光晕不要用环形线**。用 `fill` + `opacity` 的实心圆，靠透明度做柔光；
环形 `stroke` 会显出硬边。如果一定要渐变，用 `<radialGradient>` 从 `0.14` 衰减到 `0`。

### 3.2 颜色映射：**不要按类型分色**

需求里有 4 种边类型，容易诱使人给每种配一个颜色。**不要**。

理由：
- 9 个节点 × 4 种边 = 最多 13 个色相，图会变成调色盘
- 主题 token 只有 5 个强调色（brand/success/warn/error/idle），不够分
- 颜色承载 4 个维度，读者无法解码

**我的方案：单色 + 线型编码。**

```js
const EDGE_KINDS = {
  flow:     { dash: null,    width: 1.25, opacity: 0.58, arrow: true  },  // 实线+箭头
  indirect: { dash: '5 3.5', width: 1.0,  opacity: 0.44, arrow: false },  // 长虚线
  domain:   { dash: '1 3',   width: 1.15, opacity: 0.40, arrow: false },  // 点线
  similar:  { dash: '2 3.5', width: 1.0,  opacity: 0.38, arrow: false },  // 短虚线
};
```

节点颜色**只用一个** `brand-primary`。区分靠**大小（度数）**，不靠色相。

这是"专业、克制"的核心：**一个色相 + 一条编码通道**。

如果一定要区分"有契约/无契约"，用**描边**而不是填充：
- 有契约：实心 + `brand-primary`
- 无契约：`fill-opacity: 0.35` + `stroke-dasharray: 2 2`

### 3.3 节点尺寸：√ 归一化，但区间要够宽

```js
const t = Math.sqrt(deg / maxDeg);      // √ 归一化：面积随度数线性
const r = 5.5 + 8 * t;                  // 区间 5.5 ~ 13.5，比值 2.45×
```

**踩过的坑**：一开始用 `6 + 5*t`（区间 6~11，比值 1.8×），
实测 1 度节点 r=9.5、4 度节点 r=13.5，**肉眼几乎看不出差别**。
改成 `5.5 + 8*t` 后：

| 场景 | 度数 | 半径 |
|---|---|---|
| 架构梳理 | 4 | 13.5 |
| 调研 / 逆向 / 中枢 / 实施 | 3 | 12.4 |
| 竞品拆解 / 故障分析 | 2 | 11.2 |
| 本地电脑 / 自我复盘 | 1 | 9.5 |

用 √ 而不是线性：度数是"边数"，视觉**面积**应对应度数，
半径就要按 √ 走。线性会让 4 度节点比 1 度大一倍不止，变成气泡图。

### 3.4 标签摆放：贪心 + 三级惩罚

9 个标签，每个试 6 个候选位（下 / 上 / 右 / 左 / 右下 / 左下），
按惩罚分取最优，**度数高的先挑**：

```js
let penalty = 0;
if (hitsCircle(box)) penalty += 1000;   // 压节点，最严重
if (hitsLabel(box))  penalty += 600;    // 压别的标签
if (hitsEdge(box))   penalty += 120;    // 压边
const score = -penalty - ci;            // ci 是候选序号，靠前的轻微偏好
```

**两个真 bug（都实测抓到）**：

1. **`hitsEdge` 排除了与自身相连的边** → `reverse-eng` 的出边正好朝下，
   标签默认"正下方"骑在线上。修法：自己的边也躲，但只躲 `d > 14` 以外的段
   （贴着圆的 14px 本来就该经过）。
2. **`routes` 在 `placeLabels` 之后才算** → 标签按直线采样、边却画成曲线，
   窄容器下有弧度时漏判。修法：**先算 routes，再摆标签**，
   并且采样必须沿真实二次贝塞尔：

```js
const x = u*u*a.x + 2*u*t*cxp + t*t*b.x;   // 不能写 a.x + (b.x-a.x)*t
```

修完后 4 种宽度（960/800/720/680）**全部 0 处标签被边穿过**。

**文字外描边**保证压在边上也读得清：

```css
.ssm-label {
  paint-order: stroke fill;        /* 先描边后填充 */
  stroke: var(--dsw-alias-bg-layer-1);
  stroke-width: 3;                 /* 2 太细（边从字缝透出），4 会啃掉笔画 */
  stroke-linejoin: round;
}
```

### 3.5 深浅色对比度

边的不透明度取"两套主题都能用"的中间值，**不写死两种颜色**：

| 类型 | opacity | 深色底 | 浅色底 |
|---|---|---|---|
| flow | 0.58 | 可见 | 略淡 |
| indirect | 0.44 | ok | 偏淡 |
| similar | 0.38 | 偏淡 | 偏淡 |

浅色主题额外提一档，但**仍然只引用 token**：

```css
@media (prefers-color-scheme: light) {
  .ssm-edge:not([data-hot="1"]) {
    stroke: color-mix(in srgb,
      var(--dsw-alias-label-secondary) 88%,
      var(--dsw-alias-label-primary));
  }
}
```

`color-mix` 是关键 —— 它让"提亮"也走 token，主题换了依然跟得住，
不会出现"深色模式好看、浅色模式一坨灰"。

**校验过的 token 清单**（DSH 真实存在的 14 个，写错会静默 fallback）：

```
--dsw-alias-bg-base / bg-layer-1 / bg-layer-2 / bg-overlay
--dsw-alias-border-l1 / border-l2
--dsw-alias-brand-primary
--dsw-alias-label-primary / label-secondary
--dsw-alias-state-error-primary / idle / success / warn
--dsw-specific-sidebar-fill
```

---

## 4. 动画与微交互

### 该做的

**只做过两种过渡，全部 120~160ms。**

| 属性 | 时长 | 缓动 | 理由 |
|---|---|---|---|
| halo / ring `opacity` | 160ms | `cubic-bezier(0.4, 0, 0.2, 1)` | 强调出现要"确认感"，稍慢 |
| edge `stroke` / `stroke-opacity` | 140ms | linear | 颜色过渡，linear 够 |
| dot `fill-opacity` | 120ms | linear | 淡化，快一点更利落 |

**不要给 `r`（半径）加过渡**。悬停时放大节点会让整张图的平衡被破坏 ——
邻居被迫挤开，或者重叠。用 halo/ring 表示焦点，节点本身**尺寸不动**。

**入场动画：只做 `opacity` 淡入，260ms，逐节点延迟 30ms，逐边延迟 14ms。**

```css
@keyframes ssm-in { from { opacity: 0; } to { opacity: 1; } }
.ssm-node, .ssm-edge { animation: ssm-in 260ms cubic-bezier(0.2,0,0,1) both; }
```

```jsx
style={{ animationDelay: `${i * 30}ms` }}
```

纯 CSS 关键帧 + 内联 `animationDelay`，**不碰 React state**，
所以不会触发 re-render，也不会和布局计算打架。

### 该砍的

| 砍掉 | 为什么 |
|---|---|
| 节点从中心飞出 / scale 弹入 | 9 个节点同时飞会晕；`scale` 还会让 `stroke-width` 跟着缩放，圆看起来变粗 |
| 沿边流动的粒子 | 4 种边的方向语义不同，粒子会让"间接依赖"看起来也是数据流；且 `stroke-dashoffset` 动画在长边上要跑 10s 才一圈 |
| 节点呼吸脉冲 | 常驻动画 = 常驻 CPU；在面板里跑着就是耗电 |
| 悬停时画布缩放/平移 | 鼠标一动整张图跳，用户会以为点错了 |
| 连线渐变色 | 深色背景上两端淡中间亮，会显出"断断续续"（本项目 `方案/82` 已踩过） |

### 无障碍

```css
@media (prefers-reduced-motion: reduce) {
  .ssm-node, .ssm-edge { animation: none; }
  .ssm-halo, .ssm-ring, .ssm-dot, .ssm-label, .ssm-edge { transition: none; }
}
```

键盘可达：`tabIndex={0}` + `role="button"` + `aria-pressed` + Enter/Space 触发。

命中区放大到 `max(16, r+8)` —— 9.5px 的小圆直接鼠标点会很烦：

```jsx
<circle cx={p.x} cy={p.y} r={Math.max(16, p.r + 8)} fill="transparent" />
```

---

## 5. 参考实现（可查证）

### Obsidian Graph View —— 布局参数与交互模型

官方文档：<https://help.obsidian.md/plugins/graph>

**具体做法**（文档原文要点）：
- 节点大小 = **被引用次数**（`The more nodes that reference a given node, the bigger it gets`），
  即按度数映射尺寸 —— 和本文 §3.3 同源
- Forces 面板暴露 4 个参数：**Center force**（紧凑度）、**Repel force**（斥力）、
  **Link force**（橡皮筋松紧）、**Link distance**（边长）
- Display 面板有 **Arrows** 开关（方向性可关，默认关）、
  **Text fade threshold**（按缩放级别淡出文字，解决标签拥挤）、
  **Node size** / **Link thickness** 独立可调
- 交互：hover 高亮该节点连接、click 打开笔记、右键上下文菜单

**可以抄的**：把"斥力/边长"暴露成可调参数而不是写死；
**不要抄的**：Time-lapse 入场动画 —— 那是为"笔记随时间增长"这个叙事服务的，
场景图没有这个语义。

### Yuxi（xerrors/Yuxi）图谱画布 —— d3-force 参数基线

本地已存档：`research/ui-refs/yuxi-frontend_src_modules_knowledge_ui_GraphCanvas.vue`
（GitHub: <https://github.com/xerrors/Yuxi>）

**具体参数**（源码第 108~117 行，逐行核对过）：

```js
alphaDecay: 0.1,  alphaMin: 0.01,  velocityDecay: 0.6,  iterations: 150,
force: {
  center: { x: 0.5, y: 0.5, strength: 0.1 },
  charge: { strength: -400, distanceMax: 600 },
  link:   { distance: 100, strength: 0.8 },
},
collide: { radius: 40, strength: 0.8, iterations: 3 }
```

视觉（第 313~339 行）：
`labelMaxWidth: '300%'`、`size: min(15 + degree*5, 50)`、
`lineWidth: 1.5`、`shadowBlur: 4`、
边 `type: 'quadratic'` + `endArrow: true` + `lineWidth: 1.2`。

**可查证的教训**：它的 `size` 是 `15 + degree*5`（**线性**），
31 个节点时最大 50，1 度节点 20 —— 比值 2.5×。
但那是 31 个节点、画布更大的场景。9 个节点用线性会失衡，所以本文用 √。
**参数不能跨规模照抄，要按节点数重标定。**

### d3-force 的 simulation 语义 —— 正确性基线

官方文档：<https://d3js.org/d3-force/simulation>

三个可查证的事实，直接决定了零依赖实现的写法：

1. **力只改速度，不改位置**
   > "Forces typically read the node's current position ⟨x, y⟩ and then mutate the node's velocity ⟨vx, vy⟩."
   所以 `vx += F` 而不是 `x += F`，两者差别在于阻尼是否生效。

2. **每 tick 的顺序是固定的**
   > "increments the current alpha ... invokes each registered force ... decrements each node's velocity by velocity × velocityDecay ... lastly increments each node's position by velocity."
   顺序错了（比如先移位置再衰减）会得到抖动/不收敛。

3. **`alpha` 是模拟退火温度**
   > "alpha is roughly analogous to temperature in simulated annealing."
   默认 `alphaMin = 0.001`、`alphaDecay ≈ 0.0228` → 300 次迭代自然停止。
   本文 `relaxY` 用的是**线性退火** `(1 - it/ITER) ** 1.35`，
   比指数衰减更可控（迭代次数已知，不依赖收敛判定）。

---

## 6. 可直接粘贴的用法

### DSH 插件里（`window.__ModuleLoader__`）

把 `import React from 'react'` 换成 `const React = require('react')`，其余不动。

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-memory-neuron',
  factory(require) {
    const React = require('react');
    // ... 把 scene-star-map.js 的内容贴进来 ...

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: 'memory-neuron' }, NeuronPanel);
        });
      },
    };
  },
});
```

样式用 `h('style', {}, CSS)` 渲染在组件内（卸载自动移除），
**不要用 `document.head.appendChild`** —— 规范禁止，且实测会让整包 client 注册失败。

### 宿主数据对接

```jsx
<SceneStarMap
  nodes={scenes}        // [{ id, name, role, panels, hasContract, memBytes }]
  edges={edges}         // [{ from, to, kind, label }]
  height={340}
  hoverId={hoveredId}   // 和下方场景卡片双向联动
  onHover={setHoveredId}
  onSelect={setSelectedId}
/>
<SceneStarMapLegend kinds={['flow', 'indirect', 'domain', 'similar']} />
```

`hoverId` 是受控的：外部（卡片列表）悬停时传进来，图内悬停时通过 `onHover` 传出去 ——
两边共用一个 state 就实现了双向联动。

---

## 7. 实测验收

复跑命令（在 `research/star-map-lab/`）：

```bash
node verify.mjs          # 确定性、6 种尺寸、5 种边界输入
node verify-labels.mjs   # 标签被边穿过的次数
node audit-edges2.mjs    # 边穿过节点的次数
node verify-force.mjs    # 力导向收敛性与确定性
```

结果：

```
确定性 x3: PASS
1000x400 / 900x340 / 800x320 / 700x340 / 680x320 / 1200x400:
  圆不重叠 ok  标签重叠 0
空 / 单节点 / 两节点无边 / 环 / 自环: 全部 ok（无 NaN、无异常）
标签被边穿过: 960=0  800=0  720=0  680=0
边穿过节点: PASS (11/11 clear)
相邻层交叉数: 0
力导向: 无重叠 PASS, minGap=16.8, 确定性 PASS
```

**验收方式本身也是结论的一部分**：这三个 bug（常驻环吃掉了尺寸信息、
标签压自己的出边、标签按直线躲曲线）都是**放大截图 + 数值自检**抓到的，
肉眼在 1× 缩略图上完全看不出来。
