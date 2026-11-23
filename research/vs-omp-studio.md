# 对标：omp-studio（2026-11-19 代码级核验）

> 源码：**`D:/refs/omp-studio.git` HEAD 64170f9a（2026-11-18，可复算）**；早期引用的是 zip 快照，行号已漂移，本文件已按 HEAD 校正。
> 规模：2787 文件 / 61.1MB（`evidence/references/omp-studio.json`）
> 目的：矩阵里 omp-studio 的 D2/D4 证据此前引用的是**我们自己的分析文档**（`omp-aion.md`），
> 不是它的源码。本轮把这两条**换成真实 path:line**，并如实写清谁强在哪一面。

---

## 一、D2 信息密度 —— **它确实做到了，而且覆盖面比我们宽**

`apps/renderer/src/styles/tokens.css`：

```
L58-62  /* Spacing scale — --sp-14 was referenced ~30 times as var(--sp-14, 14px)
           without ever being declared…
           信息密度（设置 → 常规）经 --density-scale 等比缩放整条间距阶梯，
           不动字号与布局度量（--sidebar-w / --panel-w 等由 JS 按像素写入）。 */
L67     --density-scale: 1;
L68-78  --sp-2 … --sp-32  全部 calc(Npx * var(--density-scale))
L80-84  /* Minimum pointer target (WCAG 2.2 SC 2.5.8 Target Size Minimum = 24px)…
           the hit area is padded out to --tap-min so the visual size and the target size can differ. */
        --tap-min: 24px;
L196    :root[data-density="cozy"] { --density-scale: 1.15; }  ← 档位在 CSS 里声明化
```

按用途缩放：`apps/renderer/src/layout/useReadingColumn.ts:30,33` 用 `densityScale` 缩放 gutter。

**它的强项**：缩的是**整条 11 档间距阶梯**（`--sp-2`…`--sp-32`），全应用生效。
**我们的现状**：`apps/vouch-web/src/web-ui/src/app/layout/density.scss` 是 `--nb-dens` 乘 5 档
`--ncc-gap-1..5`，只作用于 `.ncc/.dp/.tp`（agent 面板 3 个组件）。
**结论**：机制类型相同（都做「只缩间距不动字号 + 24px 命中区」），**但覆盖面我们更窄**。
这一条**不判我们赢**，判「同档，范围更小」，并在矩阵证据里写明。

---

## 二、D4 多场景 / 多工作区 —— **它的 UI 组合能力明显强于我们**

```
apps/renderer/src/panels/registry.ts:21   export const WORKBENCH_PANELS: readonly PanelDefinition[] = [
                                           …23 个面板（Explorer/Changes/Git/Browser/Computer/
                                           Background tasks/Agents/子 Agent/Environment/Context/
                                           上下文查看器/标注/Token 计数/Terminal …）
apps/renderer/src/dock/                   57 个文件（实测）：DockContext / DockRegions / DockDragPreview /
                                          DockLauncher / DockMenus / SurfaceContext / NativeFloat /
                                          WindowFrame / MinimizedCapsule / windowOrder / dragPreview …
apps/renderer/src/conversationWorkspace/  Workspace.tsx / store.ts / hosts.ts
```

**它的强项**：完整**停靠 + 浮动窗口**系统（拖拽、最小化胶囊、窗口层级、跨窗口 Surface），
21 个可组合面板。这是「多工作区」在 **UI 组合**这一面上的高水位。
**我们的现状**：`apps/vouch-web/src/web-ui/src/app/scenes/registry.ts` 18 个场景 +
agent 面板 3 个 tab + **场景隔离记忆**（`tools/agent/scene-memory.mjs`，别的场景搜不到本场景记忆）。
**结论**：判「都 有」但强的**不是同一面**：
- 它强在 **面板可组合性**（我们只有固定 3 tab）；
- 我们强在 **场景数据隔离**（它有 workspace store，但报告未描述"场景间记忆不串"的隔离模型）。

→ **这是一条真实、未解决的差距**：面板组合能力我们不如它。不拿"场景隔离"去抵。

---

## 三、逐维结论（只列有变化的）

| 维度 | 原判 | 复核后 | 依据 |
|---|---|---|---|
| D2 信息密度 | 有/有（平） | **它有、我们同档但范围更小** | `tokens.css:66-84,196`(HEAD 64170f9a) 全应用 11 档 vs 我们 `.ncc/.dp/.tp` 5 档 |
| D4 多场景 | 有/有（平） | **它 UI 组合更强；我们数据隔离更强** | 23 面板 + 57 dock 文件 vs 18 场景 + 场景隔离记忆 |

> 维护口径：不因为「总分领先」就假装这两条我们赢。它们都是**平**，且各有一面强。

---

## 四、它还有什么值得我们抄的

1. **面板注册表 + 可停靠窗口**：把"面板"做成 `PanelDefinition[]` 注册、由 dock 引擎统一拖拽/最小化/层级。
   我们只有固定 3 tab。若要做，最小可行动作是让 `RemotePanels` 支持"可拖动的一块"（已有插件通道，缺 dock 引擎）。
2. **密度阶梯声明化**：它 30 处引用 `var(--sp-14, 14px)` 的教训（L58-60）——**没声明的 fallback 会变成隐形真源**。
   我们 `--ncc-gap-*` 已全部声明，没有这个坑。

---

## 五、诚实的边界

- 本地快照**无 HEAD**，以上结论只能算"某次快照"，不可复算到具体提交。要可复算需真 clone（已在后台跑）。
- 只核了 D2/D4 两条；其余维度仍沿用旧分析，未做代码级复核 —— 未复核的标 UNKNOWN，不当已验证。
- 「它 21 个面板」不等于「每个面板都好用」；这里只证明**注册表存在且有 21 条定义**。
