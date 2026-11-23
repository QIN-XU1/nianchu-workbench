/**
 * NeuronScene — 神经元导航（纯列表，不做可视化）
 *
 * ── 用户 2026-11-15 拍板 ──────────────────────────────
 * 「神经记忆元就按你推荐的来，先把能用做好，后面再谈好看」
 *
 * 所以这一版**刻意不做**：3D、星盘、canvas、力导向图、动画。
 * 只做一件事：**让 12 个场景的上下游关系看得见**。
 *
 * ── 为什么之前做的界面「像两份产品硬拼」──────────────────
 * 方案/91-场景构建设计.md:220：「神经元不是场景，是场景的导航层」
 * 而我之前是在 21 个 tab 旁边又加了 4 个 vouch-* tab —— 反向操作。
 *
 * ── 这次的约束（来自 astryx README L35）──────────────
 * 「Customize without wrapping. A theme is a set of CSS custom property overrides.」
 * ⇒ **不新增任何 `vouch-*` 类名**，全部用宿主 CSS 变量写内联样式。
 *   上一轮实测我们已有 100 个平行类名（vouch×23 + vouch×77），不能再加。
 *
 * ── 数据来源 ─────────────────────────────────────────
 * ./data/neuron.json ← tools/ui/build-neuron.mjs 从真实契约算出
 *   （workbench/外壳/scenarios + workbench/sceneboard/scenes）
 *   12 场景 · 31 条边 · 孤立 0
 */
import { useMemo } from 'react';
import { ScrollArea } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import neuronJson from './data/neuron.json';

/** 该场景数据的产生时间（供 FreshnessNotice 判定新旧） */
const DATA_AT: string | undefined = (neuronJson as unknown as Record<string, unknown>)?.['at'] as string | undefined;
import FreshnessNotice from './FreshnessNotice';

interface NeuronNode {
  id: string;
  name: string;
  upstream: string[];
  downstream: string[];
  deg: number;
  isolated: boolean;
}

interface NeuronData {
  state: string;
  nodes: NeuronNode[];
  edges: { from: string; to: string; how: string }[];
  stats: { scenes: number; edges: number; isolated: number; maxDeg: number };
}

const DATA = neuronJson as unknown as NeuronData;

/** 宿主 token 组成的内联样式（不新增类名） */
const S = {
  page: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    background: 'var(--openbitfun-color-surface-base)',
    color: 'var(--openbitfun-color-content-primary)',
  },
  head: {
    padding: '16px 20px 12px',
    borderBottom: '1px solid var(--openbitfun-color-border-subtle)',
  },
  title: { fontSize: 'var(--openbitfun-type-body-md-font-size)', fontWeight: 'var(--openbitfun-type-label-selected-font-weight)', margin: 0 },
  meta: {
    marginTop: 6,
    fontSize: 'var(--openbitfun-type-label-sm-font-size)',
    color: 'var(--openbitfun-color-content-secondary)',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 1fr) 1fr 1fr 56px',
    gap: 12,
    alignItems: 'start',
    padding: '10px 20px',
    borderBottom: '1px solid var(--openbitfun-color-border-subtle)',
  },
  name: {
    fontSize: 'var(--openbitfun-type-body-sm-font-size)',
    fontWeight: 'var(--openbitfun-type-label-selected-font-weight)',
  },
  id: {
    fontSize: 'var(--openbitfun-type-label-sm-font-size)',
    color: 'var(--openbitfun-color-content-tertiary)',
    fontFamily: 'var(--openbitfun-type-code-sm-font-family)',
  },
  edge: {
    fontSize: 'var(--openbitfun-type-label-sm-font-size)',
    color: 'var(--openbitfun-color-content-secondary)',
    lineHeight: 'var(--openbitfun-type-body-sm-line-height)',
  },
  deg: {
    fontSize: 'var(--openbitfun-type-label-sm-font-size)',
    textAlign: 'right' as const,
    color: 'var(--openbitfun-color-content-secondary)',
  },
  th: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 1fr) 1fr 1fr 56px',
    gap: 12,
    padding: '8px 20px',
    fontSize: 'var(--openbitfun-type-label-sm-font-size)',
    color: 'var(--openbitfun-color-content-tertiary)',
    background: 'var(--openbitfun-color-surface-sunken)',
    borderBottom: '1px solid var(--openbitfun-color-border-subtle)',
  },
};

function nameOf(id: string): string {
  return DATA.nodes.find((n) => n.id === id)?.name ?? id;
}

export default function NeuronScene() {
  const { t } = useI18n('vouch');
  const nodes = useMemo(() => [...(DATA.nodes || [])].sort((a, b) => b.deg - a.deg), []);

  return (
    <div style={S.page}>
      <div style={S.head}>
        <h2 style={S.title}>{t('title')}</h2>
        <div style={S.meta}>
          {t('meta', {
            scenes: DATA.stats.scenes,
            edges: DATA.stats.edges,
            isolated: DATA.stats.isolated,
            maxDeg: DATA.stats.maxDeg,
          })}
          <span style={{ marginLeft: 8 }}>{t('metaSource')}</span>
        </div>
        <div style={{ ...S.meta, marginTop: 4 }}>{t('readOnlyNote')}
        </div>
      </div>

      {/* 数据新鲜度：头部之外独占一行，不挤压标题 */}
      <FreshnessNotice
        at={DATA_AT}
        source="data/neuron.json"
        rerunCommand="node tools/ui/build-neuron.mjs"
      />

      <div style={S.th}>
        <span>{t('colScene')}</span>
        <span>{t('colUpstream')}</span>
        <span>{t('colDownstream')}</span>
        <span style={{ textAlign: 'right' }}>{t('colDegree')}</span>
      </div>

      <ScrollArea>
        {nodes.map((n) => (
          <div key={n.id} style={S.row}>
            <div>
              <div style={S.name}>{n.name}</div>
              <div style={S.id}>{n.id}</div>
            </div>
            <div style={S.edge}>
              {n.upstream.length ? n.upstream.map(nameOf).join(', ') : t('empty')}
            </div>
            <div style={S.edge}>
              {n.downstream.length ? n.downstream.map(nameOf).join(', ') : t('empty')}
            </div>
            <div style={S.deg}>{n.deg}</div>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
