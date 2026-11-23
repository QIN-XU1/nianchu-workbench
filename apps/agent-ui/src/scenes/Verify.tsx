import { snapshot, fourStateTotals, suiteTotals } from '../data';
import { Page, Section, StateChip, StatGrid, Empty, KV } from '../components/ui';

/**
 * 验证中心 —— 数据全部来自 tools/gen-snapshot.mjs 跑出来的真实结果。
 * 四态严格分开：判不了（unknown）绝不计入通过。
 */
export default function Verify() {
  const t = fourStateTotals();
  const st = suiteTotals();
  const suites = snapshot.verify.suites;

  return (
    <Page>
      <Section
        title="总览"
        desc={<>数据来自 <code>tools/gen-snapshot.mjs</code> 跑我们自己的验收器，不是演示数据。判不了单列，不并入通过。</>}
      >
        <StatGrid items={[
          { label: '通过', value: t.pass, state: 'pass' },
          { label: '待补', value: t.warn, state: 'warn' },
          { label: '失败', value: t.fail, state: 'fail' },
          { label: '判不了', value: t.unknown, state: 'unknown' },
        ]} />
        <div className="vp-notice">
          <strong>套件级：{st.total} 个验收器 · 通过 {st.pass} · 待补 {st.warn} · 失败 {st.fail} · 判不了 {st.unknown}</strong>
          <span className="vp-dim">断言数与套件数是两个口径：断言全绿不等于每个套件都能判定。</span>
        </div>
      </Section>

      <Section title="套件" desc={<>共 {suites.length} 个可执行验收器。</>}>
        <div className="vp-table">
          <div className="vp-table__head">
            <span>套件</span><span>状态</span><span>通过</span><span>失败</span><span>判不了</span><span>耗时</span>
          </div>
          {suites.map((s) => (
            <div className="vp-table__row" key={s.id}>
              <span className="vp-table__name">{s.name}<code>{s.file.replace('prototype/', '')}</code></span>
              <span><StateChip state={s.state} /></span>
              <span className="vp-num">{s.pass}</span>
              <span className="vp-num">{s.fail}</span>
              <span className="vp-num">{s.unknown}</span>
              <span className="vp-num vp-dim">{s.ms}ms</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="断言明细" desc={<>只显示脚本自己逐行输出的断言，最多 200 条。</>}>
        {suites.every((s) => s.checks.length === 0) ? (
          <Empty title="脚本没有逐行输出断言" detail="部分验收器只打印汇总；要看到逐条，需要脚本统一输出格式。" />
        ) : (
          <div className="vp-checks">
            {suites.flatMap((s) => s.checks.map((c, i) => (
              <div className="vp-check" key={s.id + i} data-state={c.ok}>
                <span className="vp-check__dot" aria-hidden="true" />
                <span className="vp-check__text">{c.text}</span>
                <code className="vp-check__suite">{s.name}</code>
              </div>
            )))}
          </div>
        )}
      </Section>

      <Section title="怎么更新这些数字">
        <KV rows={[
          { k: '生成命令', v: 'node tools/gen-snapshot.mjs' },
          { k: '快照文件', v: 'apps/agent-ui/src/data/snapshot.json' },
          { k: '生成时间', v: snapshot.generatedAt },
          { k: '数据来源', v: snapshot.source.label },
        ]} />
      </Section>
    </Page>
  );
}
