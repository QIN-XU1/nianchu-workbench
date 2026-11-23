import netRaw from '../data/net.json';
import { hostOf, STATE_LABEL, type FourState, type NetProbe } from '../data/net';
import { Page, Section, StateChip, StatGrid } from '../components/ui';

const net = netRaw as unknown as NetProbe;

/**
 * 联网 —— A3 的产品界面
 *
 * 这一页显示的是**真实发生过的**搜索与抓取结果（由 tools/net/gen-ui-data.mjs 生成），
 * 不是示例数据。四态纪律照旧：连不上就显示「判不了」，不显示假结果。
 */
export default function Net() {
  const s = net.search;
  const f = net.fetch;
  const reachable = net.backends.filter((b) => b.state === 'PASS').length;

  return (
    <Page>
      <Section
        title="联网能力"
        desc={<>{net.rule}</>}
        aside={<>采集于 {new Date(net.at).toLocaleString('zh-CN')}</>}
      >
        <StatGrid items={[
          { label: '搜索结果', value: s.results.length, state: s.state === 'PASS' ? 'pass' : s.state === 'FAIL' ? 'fail' : 'unknown' },
          { label: '抓取正文', value: f.chars, hint: '字' },
          { label: '可达后端', value: reachable + '/' + net.backends.length },
        ]} />
      </Section>

      <Section
        title="搜索"
        desc={<>查询「{s.query}」· 后端 {s.endpoint.replace(/^https?:\/\//, '').split('/')[0]}</>}
        aside={<><StateChip state={s.state as FourState} /> {STATE_LABEL[s.state as FourState]}</>}
      >
        <div className="vp-notice">
          <strong>{s.why}</strong>
        </div>
        {s.results.length === 0 ? (
          <div className="vp-notice vp-notice--warn">
            <strong>没有结果</strong>
            <span className="vp-dim">
              {s.state === 'UNKNOWN'
                ? '本机连不上搜索后端 —— 这是判不了，不是「搜不到」。'
                : '后端通了但解析出 0 条，可能是页面结构变化。'}
            </span>
          </div>
        ) : (
          <ul className="vp-net-list">
            {s.results.map((r) => (
              <li className="vp-net-item" key={r.url}>
                <a className="vp-net-item__title" href={r.url} target="_blank" rel="noreferrer noopener">
                  {r.title}
                </a>
                <div className="vp-net-item__host">{hostOf(r.url)}</div>
                {r.snippet && <p className="vp-net-item__snippet">{r.snippet}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="抓取与正文提取"
        desc={<>从 HTML 里剥出可读正文（去 script/style/标签，解实体，块级换行），不是丢一整坨 HTML 给上游。</>}
        aside={<><StateChip state={f.state as FourState} /> {STATE_LABEL[f.state as FourState]}</>}
      >
        <div className="vp-notice">
          <strong>{f.title || f.url}</strong>
          <span className="vp-dim">{f.why} · {f.url}</span>
        </div>
        {f.excerpt ? (
          <pre className="vp-net-excerpt">{f.excerpt}</pre>
        ) : (
          <div className="vp-notice vp-notice--warn"><strong>没有提到正文</strong><span className="vp-dim">{f.why}</span></div>
        )}
      </Section>

      <Section
        title="后端可达性"
        desc={<>默认后端是测出来的，不是拍的：DuckDuckGo / searx 在本机不可达，Bing 与两个 JSON API 可达。</>}
      >
        <div className="vp-rt">
          {net.backends.map((b) => (
            <div className="vp-rt__row" data-state={b.state} key={b.name}>
              <span className="vp-rt__dot" aria-hidden="true" />
              <span className="vp-rt__name">{b.name}</span>
              <span className="vp-rt__val">{b.note}</span>
              <span className="vp-rt__tag">{STATE_LABEL[b.state as FourState]}</span>
            </div>
          ))}
        </div>
      </Section>
    </Page>
  );
}