import { Page, Section, KV, StateChip } from '../components/ui';
import { snapshot, generatedAtLabel } from '../data';

export default function About() {
  const a = snapshot.about;
  return (
    <Page>
      <Section title="四鉴 Vouch" desc="agent 工作台 · 四态验证优先">
        <KV rows={[
          { k: '版本', v: a.version },
          { k: '阶段', v: a.stage },
          { k: '产品', v: a.product },
          { k: '运行环境', v: 'Node ' + a.node },
        ]} />
      </Section>

      <Section title="数据来源" desc="界面上每个数字都要能追到这里。">
        <KV rows={[
          { k: '来源类型', v: snapshot.source.kind },
          { k: '来源', v: snapshot.source.label },
          { k: '生成器', v: snapshot.generator },
          { k: '生成时间', v: generatedAtLabel() },
          { k: '快照版本', v: 'schema v' + snapshot.schemaVersion },
        ]} />
        <p className="vp-sec__p">{snapshot.source.detail}。</p>
      </Section>

      <Section title="套件状态" desc="与「验证」场景同源。">
        <div className="vp-table">
          {snapshot.verify.suites.map((s) => (
            <div className="vp-table__row vp-table__row--2" key={s.id}>
              <span className="vp-table__name">{s.name}</span>
              <StateChip state={s.state} />
            </div>
          ))}
        </div>
      </Section>
    </Page>
  );
}
