/**
 * 我们的场景配置 —— 格式照搬 luanyujia-workbench，**内容全部由真实数据生成**
 *
 * 数据源（都不是编的）：
 *   · 12 个场景与依赖     ← app/scenes/vouch/data/neuron.json（12 节点 / 31 边）
 *   · 面板与指标          ← ./panels.generated.json（由 tools/gen-scene-panels.py 从
 *                           research/改进台账.json、evidence/evolve/*.json、
 *                           tools/ 与 prototype/ 的真实文件清单生成）
 *
 * 版式照搬原文那条实践建议：
 *   「把最大的那块留给 AI 面板（通常是 w3 h2）—— 它是停留时间最长的地方」
 *
 * 面板族也照搬 01-场景模式/面板类型总览.md：
 *   dash / chart / table / file / flow / harness / list / view / reserved
 * 其中 view + file 是原文说的「复用率最高的搭配」——file.viewPanel 指向 view 的 id。
 */
import neuronJson from '../../vouch/data/neuron.json';
import panelsJson from './panels.generated.json';
import type { PanelConfig, SceneConfig } from './config';

type Neuron = {
  nodes: Array<{ id: string; name?: string; hub?: boolean }>;
  edges: Array<{ from: string; to: string; how?: string }>;
};
const DATA = neuronJson as unknown as Neuron;
const PANELS = panelsJson as unknown as Record<string, PanelConfig[]>;

const nameOf = (id: string) => DATA.nodes.find((n) => n.id === id)?.name ?? id;

/**
 * 不属于「神经记忆元 12 节点」的额外场景。
 * 【2026-11-18 用户要求】标杆从独立标签移进「场景」里 —— 它是一个场景，
 * 但不在 12 个神经记忆元里，所以这里显式登记名字，避免显示成英文 id。
 */
const EXTRA_SCENES: Record<string, string> = { benchmark: '标杆' };
const neighbors = (id: string) =>
  DATA.edges
    .filter((e) => e.from === id || e.to === id)
    .map((e) => ({
      id: e.from === id ? e.to : e.from,
      label: nameOf(e.from === id ? e.to : e.from),
      right: e.from === id ? '下游' : '上游',
    }));

/**
 * 每个场景一份配置。
 *
 * 面板顺序（照搬原文「最大那块留给 AI」的实践）：
 *   ① 该场景的真实面板（来自 panels.generated.json，含 dash/chart/file/flow/table）
 *   ② 相邻场景列表（来自 neuron.json 的真边）
 *   ③ AI 会话面板（查身份索引，六件套第 ⑥ 件）
 *
 * 没有专属数据的场景**不硬塞假面板** —— 只用「相关文件 + 相关改进 + AI」三件套，
 * 且每块都标了 src（数据来自哪个真实文件）。
 */
function sceneOf(id: string): SceneConfig {
  const name = EXTRA_SCENES[id] ?? nameOf(id);
  const ups = DATA.edges.filter((e) => e.to === id).length;
  const downs = DATA.edges.filter((e) => e.from === id).length;
  const nb = neighbors(id);
  const mine = PANELS[id] ?? [];

  // 真实面板按顺序排；坐标由版式统一分配（见 layout）
  const real: PanelConfig[] = mine.map((p) => ({ ...p }));

  // 相邻场景放在右侧窄列
  const nbPanel: PanelConfig = {
    id: id + '-nb',
    title: '相邻场景',
    type: 'list',
    sub: ups + ' 上游 · ' + downs + ' 下游',
    col: 4,
    row: 1,
    w: 1,
    // 邻居面板**不撑满整列** —— 撑满会把所有内容行压扁（实测：flow 图被压成一条）
    h: Math.max(3, Math.min(7, real.reduce((a, p) => Math.max(a, (p.row ?? 1) + (p.h ?? 1)), 1) - 1)),
    src: 'neuron.json',
    items: nb.length ? nb : [{ id, label: '（无相邻场景）', right: '' }],
  };

  return {
    id,
    name,
    description: name + '：上游 ' + ups + ' 条、下游 ' + downs + ' 条',
    cols: 4,
    panels: [...real, nbPanel],
  };
}

/**
 * 兼容旧调用方（WorkbenchScene 用这两个名字）
 *
 * 【2026-11-23 用户要求】先只保留「标杆」一个场景：
 *   其余 11 个神经记忆元场景「大部分没用」，等整体界面完全定稿后再逐个补。
 *   所以这里不再从 neuron.json 批量生成场景 —— 数据源仍在，只是不往 UI 里塞。
 */
export const SCENE_CONFIGS: SceneConfig[] = [sceneOf('benchmark')];
export const sceneConfigOf = (id: string): SceneConfig | undefined =>
  SCENE_CONFIGS.find((s) => s.id === id);

export const SCENES: SceneConfig[] = SCENE_CONFIGS;
export const SCENE_BY_ID: Record<string, SceneConfig> = Object.fromEntries(
  SCENES.map((s) => [s.id, s]),
);

/**
 * 默认展示的场景。
 * 2026-11-23 起「场景」页只保留标杆，所以默认值必须落在 SCENE_CONFIGS 里，
 * 否则会算出一个根本不存在的 id（之前是 neuron 的 hub 节点）。
 */
export const DEFAULT_SCENE_ID = SCENE_CONFIGS[0]?.id ?? 'benchmark';

export const NEURON_STATS = {
  nodes: DATA.nodes.length,
  edges: DATA.edges.length,
  panels: Object.values(PANELS).reduce((a, v) => a + v.length, 0),
};

export default SCENES;
