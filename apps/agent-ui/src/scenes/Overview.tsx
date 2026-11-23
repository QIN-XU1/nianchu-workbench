import { snapshot, fourStateTotals, suiteTotals, generatedAtLabel } from '../data';
import runtimeRaw from '../data/runtime-state.json';
import {
  stateLabel, headline, ageLabel,
  type RuntimeState, type FourState,
} from '../data/runtime';
import { Page, Section, StateChip, StatGrid, KV } from '../components/ui';

const rt = runtimeRaw as unknown as RuntimeState;

/**
 * 总览 —— 一屏看清：验收四态、运行时状态、能力规模。
 * 数据全部来自本地采集脚本，没有编造数字。
 */
export default function Overview() {
  const t = fourStateTotals();
  const st = suiteTotals();
  const bad = snapshot.verify.suites.filter((s) => s.state === 'fail' || s.state === 'unknown');

  return (
    <Page>
      <Section
        title="产品"
        desc={<>念初 · {snapshot.about.version} · {snapshot.about.stage}</>}
      >
        <KV rows={[
          { k: '运行时采集', v: rt.collector + '（' + ageLabel(rt.at) + '）' },
          { k: '验收快照', v: snapshot.generator + '（' + generatedAtLabel() + '）' },
          { k: '后端', v: '网关 ' + rt.gateway.state + ' · ' + (rt.gateway.why || rt.gateway.modelCount + ' 个模型') },
        ]} />
      </Section>

      <Section
        title="运行时状态"
        desc={<>{rt.rule}</>}
        aside={<>采集于 {ageLabel(rt.at)}</>}
      >
        <div className="vp-rt">
          <div className="vp-rt__row" data-state={rt.proc.state}>
            <span className="vp-rt__dot" aria-hidden="true" />
            <span className="vp-rt__name">进程</span>
            <span className="vp-rt__val">
              {rt.proc.totalProcesses ?? '—'} 个
              {rt.proc.node ? <> · node {rt.proc.node.count} 个 / {rt.proc.node.memMB}MB</> : null}
              {rt.proc.python ? <> · python {rt.proc.python.count} 个</> : null}
            </span>
            <span className="vp-rt__tag">{stateLabel(rt.proc.state)}</span>
          </div>

          <div className="vp-rt__row" data-state={rt.gateway.state}>
            <span className="vp-rt__dot" aria-hidden="true" />
            <span className="vp-rt__name">模型网关</span>
            <span className="vp-rt__val">{rt.gateway.why || (rt.gateway.modelCount + ' 个可用模型')}</span>
            <span className="vp-rt__tag">{stateLabel(rt.gateway.state)}</span>
          </div>

          <div className="vp-rt__row" data-state={rt.ports.state}>
            <span className="vp-rt__dot" aria-hidden="true" />
            <span className="vp-rt__name">端口</span>
            <span className="vp-rt__val">
              {rt.ports.ports.map((p) => p.port + (p.open ? '✓' : '·')).join('  ')}
            </span>
            <span className="vp-rt__tag">{rt.summary.portsOpen} 在听</span>
          </div>

          <div className="vp-rt__row" data-state={rt.repo.state}>
            <span className="vp-rt__dot" aria-hidden="true" />
            <span className="vp-rt__name">仓库</span>
            <span className="vp-rt__val">
              {rt.repo.branch}@{rt.repo.head} · 未提交 {rt.repo.dirtyFiles}
            </span>
            <span className="vp-rt__tag">{stateLabel(rt.repo.state)}</span>
          </div>

          <div className="vp-rt__row" data-state={rt.resources.state}>
            <span className="vp-rt__dot" aria-hidden="true" />
            <span className="vp-rt__name">资源</span>
            <span className="vp-rt__val">
              {rt.resources.cpuCores} 核 · {rt.resources.freeMemGB}/{rt.resources.totalMemGB}GB 可用
              · 负载 {rt.resources.load1}
            </span>
            <span className="vp-rt__tag">{rt.resources.node}</span>
          </div>
        </div>
      </Section>

      <Section
        title="验收四态"
        desc={<>合计 {t.pass + t.warn + t.fail + t.unknown} 条断言，来自 {snapshot.verify.suites.length} 个真实验收器。</>}
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
        {bad.length ? (
          <div className="vp-notice">
            <strong>不是全绿的套件：</strong>
            {bad.map((s) => (
              <span className="vp-notice__item" key={s.id}>
                <StateChip state={s.state as FourState} /> {s.name}
              </span>
            ))}
          </div>
        ) : (
          <div className="vp-notice vp-notice--ok"><strong>全部套件通过</strong></div>
        )}
      </Section>

      <Section title="能力规模" desc={snapshot.capabilities.note}>
        <StatGrid items={[
          { label: '工具', value: snapshot.capabilities.tools.length },
          { label: '补丁集', value: snapshot.capabilities.patches.targets.length },
          { label: '技能', value: snapshot.capabilities.skills.length, hint: '未接入' },
          { label: 'MCP', value: snapshot.capabilities.mcp.length, hint: '未配置' },
          { label: '模型', value: rt.gateway.modelCount ?? 0, hint: rt.gateway.state === 'PASS' ? '网关可用' : '判不了' },
        ]} />
      </Section>
    </Page>
  );
}