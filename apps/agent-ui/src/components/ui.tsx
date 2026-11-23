import type { ReactNode } from 'react';
import type { FourState } from '../data';

export function Page({ children }: { children: ReactNode }) {
  return <div className="vp-page">{children}</div>;
}

export function Section({
  title, desc, aside, children,
}: { title: string; desc?: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <section className="vp-sec">
      <div className="vp-sec__head">
        <h2 className="vp-sec__h">{title}</h2>
        {aside ? <div className="vp-sec__aside">{aside}</div> : null}
      </div>
      {desc ? <p className="vp-sec__p">{desc}</p> : null}
      {children}
    </section>
  );
}

const STATE_LABEL: Record<FourState, string> = {
  pass: '通过', warn: '待补', fail: '失败', unknown: '判不了',
};

export function StateChip({ state, n }: { state: FourState; n?: number }) {
  return (
    <span className="vp-chip" data-state={state}>
      <span className="vp-chip__dot" aria-hidden="true" />
      {typeof n === 'number' ? <b>{n}</b> : null}
      {STATE_LABEL[state]}
    </span>
  );
}

export function StatGrid({ items }: { items: { label: string; value: ReactNode; hint?: string; state?: FourState }[] }) {
  return (
    <div className="vp-stats">
      {items.map((it) => (
        <div className="vp-stat" key={it.label}>
          <div className="vp-stat__value" data-state={it.state}>{it.value}</div>
          <div className="vp-stat__label">{it.label}</div>
          {it.hint ? <div className="vp-stat__hint">{it.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** 未接后端 / 无数据的诚实空态 */
export function Empty({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="vp-emptybox">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function KV({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <div className="vp-kv">
      {rows.map((r) => (
        <div className="vp-kv__row" key={r.k}>
          <span>{r.k}</span>
          <code>{r.v}</code>
        </div>
      ))}
    </div>
  );
}
