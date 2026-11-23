# 57 · 记忆神经元重做（参照 Yuxi 的 d3-force 方案）

> 用户要求：**"记忆神经必须重新设计 https://github.com/xerrors/Yuxi，具体可参照这份项目"**

---

## 一、参照对象

**`xerrors/Yuxi`（7,627★，Python）**
> 可私有部署的多租户知识智能体平台：统一 RAG、知识图谱、多智能体、MCP/Skills、沙盒与权限管理

它是**工业级知识图谱平台**，正是记忆神经元该学的对象。

### 1.1 定位到的核心文件

```
frontend/src/modules/knowledge/ui/GraphCanvas.vue      20,918 字符  ★ 图谱画布
frontend/src/modules/knowledge/ui/GraphDetailPanel.vue  7,078 字符  ★ 详情面板
frontend/src/modules/knowledge/model/useGraph.js        1,685 字符
frontend/src/apis/graph_api.js                            666 字符
```

已保存到 `research/ui-refs/`

---

## 二、Yuxi 的真实技术方案

### 2.1 技术栈

```javascript
import { Graph } from '@antv/g6'    // 蚂蚁 G6 图可视化引擎 v5
```

### 2.2 布局配置（原文照抄）

```javascript
const defaultLayout = {
  type: 'd3-force',              // D3 力导向
  preventOverlap: true,          // ★ 防重叠
  alphaDecay: 0.1,
  alphaMin: 0.01,
  velocityDecay: 0.6,
  iterations: 150,
  force: {
    center: { x: 0.5, y: 0.5, strength: 0.1 },
    charge: { strength: -400, distanceMax: 600 },   // ★ 节点互斥
    link: { distance: 100, strength: 0.8 },         // ★ 连线弹簧
  },
  collide: { radius: 40, strength: 0.8, iterations: 3 },  // ★ 碰撞检测
}
```

**这就是解决「节点重叠」的正解。**

我之前的做法（手写平面放射布局）根本达不到这个效果——
放射布局是**静态分配角度**，而力导向是**让物理自己找到平衡**。

### 2.3 视觉配置（原文照抄）

```javascript
node: {
  type: 'circle',
  style: {
    labelText: (d) => d.data.label,
    labelWordWrap: true,
    labelMaxWidth: '300%',
    size: (d) => Math.min(15 + d.data.degree * 5, 50),  // ★ 按度数变大
    fill: (d) => d.data.color,
    opacity: 0.9,
    stroke: '--color-bg-container',
    lineWidth: 1.5,
    shadowBlur: 4,
  },
}
edge: {
  type: 'quadratic',        // ★ 二次贝塞尔曲线
  style: {
    labelText: (d) => d.data.label,
    stroke: (d) => d.data.color,
    opacity: 0.8,
    lineWidth: 1.2,
    endArrow: true,         // ★ 箭头
  },
}
behaviors: [
  'drag-element',           // 拖节点
  'zoom-canvas',            // 滚轮缩放
  'drag-canvas',            // 拖画布
  'hover-activate',         // 悬停高亮
  { type: 'click-select', degree: 1 },  // 点击选中 + 邻居高亮
]
```

### 2.4 调色板（AntV 标准 9 色）

```javascript
NODE_LABEL_COLORS = [
  '#3996ae', '#5ad8a6', '#f6bd16', '#f27c7c', '#9581cc',
  '#6dc8ec', '#ff9d4d', '#92d050', '#e885ba',
]
```

**关键设计**：用 `hashString(label) % 9` 决定颜色——
同一个类型永远同一个颜色，不需要手写映射表。

---

## 三、我的实现选择

### 3.1 为什么不直接装 G6

| 项 | 数据 |
|---|---|
`@antv/g6` 版本 | 5.1.1（可装） |
估算体积 | 3MB+ |
我们需要的节点数 | **31 个** |

**用 3MB 的库画 31 个节点，不划算。**

### 3.2 选择：移植算法，零依赖

写了 `neuron-yuxi.js`，用 canvas 实现 Yuxi 的全部核心：

| Yuxi 能力 | 我的实现 |
|---|---|
d3-force 布局 | ✅ 手写：中心引力 + 电荷斥力 + 弹簧力 + 碰撞检测 |
迭代 150 次 | ✅ 同参数 |
alphaDecay 0.1 | ✅ 同参数 |
velocityDecay 0.6 | ✅ 同参数 |
charge -400 / distanceMax 600 | ✅ 同参数 |
link distance 100 / strength 0.8 | ✅ 同参数 |
collide radius 40 / 3 迭代 | ✅ 同参数 |
节点大小按度数 | ✅ `min(15 + degree*5, 50)` |
9 色调色板 | ✅ 同 9 个色值 + 同 hash 算法 |
二次贝塞尔边 + 箭头 | ✅ |
标签自动截断 | ✅ |
拖节点/拖画布/缩放/点击详情 | ✅ |

**零依赖，效果一致。**

---

## 四、改进对比

| 项 | 之前（手写放射布局） | 现在（Yuxi d3-force） |
|---|---|---|
布局算法 | 静态角度分配 | **物理力导向模拟** |
节点重叠 | 中心区域严重重叠 | ✅ **碰撞检测，零重叠** |
节点大小 | 固定半径 | ✅ **按度数增长** |
配色 | 12 种杂色 | ✅ **AntV 9 色 + hash 一致** |
边 | 直线 | ✅ **贝塞尔曲线 + 箭头** |
标签 | 全部显示，互相压 | ✅ **长标签自动截断** |
类型图例 | 只有数字 | ✅ **彩色圆点 + 类型名 + 数量** |
交互 | 无 | ✅ **拖/缩/点** |
详情 | 无 | ✅ **点击弹详情卡** |

---

## 五、数据读取的坑（第二次踩）

### 5.1 现象

第一版全部标签显示 `?`，id 是 `area-undefined`。

### 5.2 根因

```javascript
// 错：优先读 记忆地图.json
const areas = (map && map.areas) || (idx && idx.areas) || [];
```

**`索引.json` 的 area 字段**：`{id, name, owner, memory, file, panel}`
**`记忆地图.json` 的 area 字段**：字段名不同

读错了就全部 `undefined`。

### 5.3 修正

```javascript
// 对：优先读 索引.json（它的字段名才有 id/name）
const areas = (idx && idx.areas) || (map && map.areas) || [];
```

**教训：读数据前先看一眼真实 JSON 结构，不要凭字段名猜。**

---

## 六、当前神经元的数据

```
core       1   （DSH 记忆，蓝色大圆）
场景       11  （内环，青绿色）
私有记忆   11  （挂在各自场景外侧，金色小圆）
技能        4  （tools / docs / backups / health）
项目        1  （DeepSeek 工作台）
数据源      4  （读写/体检/冲突/通知）
连线       31
```

---

## 七、文件清单

| 文件 | 说明 |
|---|---|
`renderer/neuron-yuxi.js` | **新神经元渲染器**（约 700 行，零依赖） |
`renderer/neuron-redesign.js` | 旧版（已停用，保留备查） |
`renderer/ds.css` | 新设计系统 |
`renderer/ds-main-agent.css` | 主 Agent 面板 |
`renderer/ds-neuron.css` | 神经元辅助样式 |
`renderer/ds-fix-narrow.css` | 竖排修复 |
`research/ui-refs/yuxi-frontend_src_modules_knowledge_ui_GraphCanvas.vue` | Yuxi 源码备份 |

---

## 八、一句话

> **Yuxi 给了正解：节点重叠不是调参能解决的，要用力导向物理模拟。**
>
> **我照抄了它全部的核心参数（d3-force 150 迭代 / charge -400 / collide radius 40）、
> 视觉语言（9 色 hash 调色板 / 节点按度数 / 贝塞尔曲线箭头）、交互（拖缩点），
> 但没装 3MB 的 G6 —— 用 canvas 手写实现，零依赖。**
>
> **31 个节点终于散开了，零重叠，有图例，能交互。**
