# 77 · 界面美化：参考 3d-force-graph 重做星域

> 用户：「我并不能理解你的审美了，**这还不如之前的**，
>       请你着重美化整体界面与交互，**先去网络查找是否有相关项目参考**」

---

## 一、先查资料（这次做对了）

### 1.1 网络诊断

```
代理 7897  → 已关闭
百度直连   → HTTP 200 ✓
DNS        → 正常
```

**我之前所有抓取失败，是因为误用了已停止的代理。**
**教训：抓取失败先测网络，不要盲目重试。**

### 1.2 抓到的核心参考

| 项目 | Stars 量级 | 价值 |
|---|---|---|
**3d-force-graph** | 数千 | ★★★ 最直接参考（ThreeJS + d3-force-3d） |
**three-forcegraph** | 数百 | ★★★ ThreeJS 图渲染类 |
**cosmos.gl** | 数百 | ★★ GPU 大规模图引擎 |
**sigma.js** | 数千 | ★★ 专业图可视化（WebGL） |

存于 `research/design-refs/`

---

## 二、从参考里学到的关键参数

### 2.1 3d-force-graph 的默认视觉参数

```
backgroundColor     #000011     ← 深蓝黑，不是纯黑，也不是灰
nodeRelSize         4
nodeOpacity         0.75        ← 不是 1.0
linkOpacity         0.2         ← 连线 20%（对齐我的 18%）
linkCurvature                   ← 曲线
linkDirectionalParticles        ← 沿边流动的粒子
```

### 2.2 ★ Bloom 泛光（我完全缺失的核心技术）

**这是「科技感」的核心。**

3d-force-graph 有专门的 Bloom 示例。
真实的高科技画面（星域、科幻 UI）都有 Bloom：
- 亮的东西会向周围"溢出"光
- 让画面有"发光感"而不是"平涂感"

**我之前只是画一个圆 + 一层径向渐变，没有真正的发光溢出。**

---

## 三、我犯的审美错误（用户说"不如之前的"）

### 3.1 错误的方向

| 我做的 | 问题 |
|---|---|
星尘 520 颗 | **太密**，像噪点，不是星空 |
星云透明度 0.34~0.52 | **太亮太明显**，像脏污渍 |
背景 #1B2836 | **太亮**，失去深空感 |
目标"76% 可见像素" | **方向错了** —— 追求"填满"而非"质感" |

**我为了提升"可见像素"（0.5% → 76%），把画面做满了，反而失去了深邃感。**

### 3.2 正确的方向

```
之前（错）：为了可见而填满 → 像噪点
现在（对）：大量深空 + 少量高亮 + Bloom → 像真实星域
```

**关键洞察：不是"更多可见像素"，而是"正确的明暗对比"。**

真实星空的亮度分布：
```
90% 深色 + 5% 微光星尘 + 1% 节点 + 强 Bloom
```

---

## 四、具体修复清单

| # | 项目 | 修复前 | 修复后 |
|---|---|---|---|
1 | 星尘数量 | 520 颗 | **220 颗**（稀疏） |
2 | 星云透明度 | 0.34~0.52 | **0.16~0.20**（柔） |
3 | 背景色 | #1B2836（灰） | **#060A16 → #010205**（深空） |
4 | 星尘光晕 | 手动径向渐变 | **去掉，交给 Bloom** |
5 | **Bloom 泛光** | **无** | **✅ 两轮降采样 + lighter 混合** |
6 | 连线透明度 | 18% | **20%**（对齐参考） |
7 | 垂直分布 | 28% | **72%** |
8 | 水平分布 | 54% | 61% |

---

## 五、Bloom 实现（Canvas 2D，无需 ThreeJS）

```js
function applyBloom(W, H) {
  // ⚠ 必须用画布**物理像素尺寸**（不是 CSS 尺寸）
  const PW = cv.width, PH = cv.height;

  // ① 降采样到 1/4（天然模糊）
  S.bloomCtx.drawImage(cv, 0, 0, PW, PH, 0, 0, w4, h4);

  // ② 再降到 1/8（更宽的光晕）
  S.bloomCtx2.drawImage(S.bloomCanvas, 0, 0, w4, h4, 0, 0, w8, h8);

  // ③ lighter 混合叠加回主画布
  c2d.globalCompositeOperation = 'lighter';
  c2d.globalAlpha = 0.42;
  c2d.drawImage(S.bloomCanvas, 0, 0, w4, h4, 0, 0, PW, PH);

  c2d.globalAlpha = 0.26;
  c2d.drawImage(S.bloomCanvas2, 0, 0, w8, h8, 0, 0, PW, PH);
}
```

**踩过的坑：** 第一次用 `drawImage(canvas, 0, 0, W, H)` 传了 CSS 尺寸，
而主画布是 `W*DPR × H*DPR` 物理像素 → 只覆盖了左上角 1/DPR 区域，
**画面上出现一个矩形色块边界**。改用物理像素后正常。

---

## 六、空间分布修复

### 6.1 问题

```
画布占用：水平 54%  垂直 28%
→ 节点挤在中上部，两侧大片空白
```

### 6.2 根因

```js
// 之前：球坐标 + 纬度随机
lat = (rnd()-0.5) * 1.8        // ±0.9 弧度
n.sy = sin(lat) * distF * RY   // sin(±0.9) = ±0.78
distF = 0.22 + pow(rand,0.35)*0.78   // 平均 0.5
→ 实际 y 只占 RY 的 0.78 × 0.5 ≈ 39%
```

### 6.3 修法：立方体内均匀采样

```js
// ① 立方体内随机点
let vx = rnd()*2-1, vy = rnd()*2-1, vz = rnd()*2-1;

// ② 拒绝采样：确保在单位球内（体积分布均匀）
while (len2 > 1 && guard++ < 12) { 重新采样 }

// ③ 让半径偏外围
const rScale = 0.30 + pow(len, 0.45) * 0.70;

// ④ 归一化 + 乘椭球半径
n.sx = nx * rScale * RX;
n.sy = ny * rScale * RY;
n.sz = nz * rScale * RX;
```

**结果：垂直占用 28% → 72%**

---

## 七、当前实测数据

```
画布 1534×989
最大亮度       255 / 255     ← Bloom 生效
纯黑 (<10)      5.3%
极暗 (10-30)   83.1%         ← 深空感保留
暗   (30-60)   11%
中   (60-120)   0.3%
亮   (120-200)  0.1%
很亮 (>200)     0.1%

节点屏幕范围: x 138~878, y 131~696
画布占用: 水平 61%, 垂直 72%
```

**这个分布是正确的**：真实星空就是大量深色 + 少量亮光。

---

## 八、参考来源

| 项目 | URL |
|---|---|
3d-force-graph | https://github.com/vasturiano/3d-force-graph |
three-forcegraph | https://github.com/vasturiano/three-forcegraph |
cosmos.gl | https://github.com/cosmograph-org/cosmos |
sigma.js | https://github.com/jacomyal/sigma.js |
Bloom 示例 | https://vasturiano.github.io/3d-force-graph/example/bloom-effect/ |
粒子示例 | https://vasturiano.github.io/3d-force-graph/example/directional-links-particles/ |

---

## 九、一句话

> **这次做对了两件事：**
> **① 先查资料（找到了 3d-force-graph 等 4 个核心参考）**
> **② 从参考里学到了自己缺的核心技术：Bloom 泛光**
>
> **我之前的审美错误：为了"可见"而把画面填满，反而失去了深空感。**
> **正确方向是：大量深空 + 少量高亮 + Bloom 发光。**
>
> **现在画面：最大亮度 255（Bloom 生效），83% 深空，节点真的在发光。**
>
> **还剩：连线粒子流动（3d-force-graph 的核心特性之二）未做。**
