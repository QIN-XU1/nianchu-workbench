import { useState } from 'react';
import type { CSSProperties } from 'react';
import SceneMemoryPanel from './SceneMemoryPanel';
import IdentityPanel from './IdentityPanel';
import FourStatePanel from './FourStatePanel';
import HealthPanel from './HealthPanel';

/**
 * 场景工作台外壳 —— 两个面板：记忆（memoryEngine） / 身份（identityEngine）
 *
 * 为什么合在一起：这两块都是「一个场景的自我描述」，分开看会漏掉
 * 「记忆里说的身份」与「身份卡登记的指纹」是否对得上。
 */

const S = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' } as CSSProperties,
  tabs: {
    display: 'flex', gap: 6, padding: '10px 24px 0', alignItems: 'center',
    borderBottom: '1px solid var(--vouch-border, rgba(128,128,128,.18))',
  } as CSSProperties,
  tab: (on: boolean): CSSProperties => ({
    padding: '6px 14px', borderRadius: '8px 8px 0 0', fontSize: 'var(--openbitfun-type-body-md-font-size)', cursor: 'pointer',
    border: '1px solid ' + (on ? 'var(--vouch-border, rgba(128,128,128,.3))' : 'transparent'),
    borderBottomColor: on ? 'transparent' : 'transparent',
    background: on ? 'var(--vouch-surface, rgba(128,128,128,.08))' : 'transparent',
    color: 'inherit', fontWeight: on ? 600 : 400, marginBottom: -1,
  }),
  body: { flex: 1, minHeight: 0, overflow: 'auto' } as CSSProperties,
};

type Tab = 'health' | 'memory' | 'identity' | 'fourstate';

export default function SceneMemoryScene() {
  const [tab, setTab] = useState<Tab>('health');
  return (
    <div style={S.wrap}>
      <div style={S.tabs}>
        <button style={S.tab(tab === 'health')} onClick={() => setTab('health')}>健康检查</button>
        <button style={S.tab(tab === 'memory')} onClick={() => setTab('memory')}>记忆</button>
        <button style={S.tab(tab === 'identity')} onClick={() => setTab('identity')}>身份</button>
        <button style={S.tab(tab === 'fourstate')} onClick={() => setTab('fourstate')}>四态贯通</button>
      </div>
      <div style={S.body}>
        {tab === 'health' ? (
          <HealthPanel />
        ) : tab === 'memory' ? (
          <SceneMemoryPanel />
        ) : tab === 'identity' ? (
          <IdentityPanel />
        ) : (
          <FourStatePanel />
        )}
      </div>
    </div>
  );
}
