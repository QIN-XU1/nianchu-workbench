import { snapshot } from '../data';
import { Page, Section, Empty, KV } from '../components/ui';

function NameList({ items, empty }: { items: { name: string; source: string }[]; empty: string }) {
  if (!items.length) return <Empty title="空" detail={empty} />;
  return (
    <div className="vp-table">
      {items.map((it) => (
        <div className="vp-table__row vp-table__row--2" key={it.name}>
          <span className="vp-table__name">{it.name}</span>
          <code className="vp-dim">{it.source}</code>
        </div>
      ))}
    </div>
  );
}

/**
 * 能力 —— 取自仓库真实目录。
 * 技能 / MCP / 模型目前确实为空，就显示空，不拿示例条目凑数。
 */
export default function Capabilities() {
  const c = snapshot.capabilities;
  const total = c.skills.length + c.mcp.length + c.tools.length + c.patches.targets.length + c.models.length;

  return (
    <Page>
      <Section
        title={'清单 · ' + total + ' 项'}
        desc={<>{c.source}。{c.note}</>}
      >
        <KV rows={[
          { k: '技能', v: c.skills.length + ' 个' },
          { k: 'MCP', v: c.mcp.length + ' 个' },
          { k: '工具', v: c.tools.length + ' 个' },
          { k: '补丁集', v: c.patches.targets.length + ' 个' },
          { k: '模型', v: c.models.length + ' 个' },
        ]} />
      </Section>

      <Section title="工具" desc={<>仓库 <code>tools/</code> 下的脚本。</>}>
        <NameList items={c.tools} empty="还没有工具脚本。" />
      </Section>

      <Section title="补丁集" desc={<>仓库 <code>hermes-patches/</code> 下的目标。</>}>
        <NameList items={c.patches.targets.map((n) => ({ name: n, source: 'hermes-patches/' }))} empty="还没有补丁集。" />
      </Section>

      <Section title="技能" desc={<>来自 <code>.claude/skills/</code>。</>}>
        <NameList items={c.skills} empty="本仓还没有技能目录。等技能接入后再列。" />
      </Section>

      <Section title="MCP" desc={<>外部工具服务器。</>}>
        <NameList items={c.mcp} empty="还没配置任何 MCP server —— 空就是空。" />
      </Section>

      <Section title="模型" desc={<>模型网关与供应商。</>}>
        <NameList items={c.models} empty="还没接模型网关 —— 空就是空。" />
      </Section>
    </Page>
  );
}
