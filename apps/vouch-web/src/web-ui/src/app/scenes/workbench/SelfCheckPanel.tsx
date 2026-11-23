/**
 * 后端能力自检面板 —— 把已做的 5 个 API 真的接到界面上。
 *
 * 【为什么加】查 T5 时发现：我做了 /api/cost、/api/memory、/api/ledger、/api/context、/api/collab，
 * 后端能跑、有反例测试，但**界面层一次都没调用**（grep `apps/vouch-web/src` 零命中）。
 * 那正是「看起来有实际是空」—— 用户看不到，等于没做。
 *
 * 这个面板逐项真的发请求，并把**四态**显示出来：
 *   PASS    接口返回 ok 且有真实数据
 *   WARN    接口通但数据为空 / 有告警
 *   FAIL    接口返回错误或四态非 PASS
 *   UNKNOWN 请求超时 / 网络不可达（**不当作通过**）
 */
import { useCallback, useEffect, useState } from 'react';

type Probe = {
  key: string;
  name: string;
  path: string;
  body: unknown;
  /** 从返回里取四态；返回 null 表示「接口通但判不了」 */
  judge: (json: any) => { state: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'; note: string };
};

const PROBES: Probe[] = [
  {
    key: 'cost', name: '成本核算（P1）', path: '/api/cost', body: { action: 'prices' },
    judge: (j) => {
      if (!j?.ok) return { state: 'FAIL', note: j?.error ?? '接口返回失败' };
      const priced = j.priced ?? 0;
      const unpriced = j.unpriced ?? 0;
      return {
        state: priced > 0 ? 'PASS' : 'WARN',
        note: '有价 ' + priced + ' / 无价 ' + unpriced + '（无价不当 0）',
      };
    },
  },
  {
    key: 'memory', name: '记忆老化（P2）', path: '/api/memory', body: { action: 'aging' },
    judge: (j) => {
      if (!j?.ok) return { state: 'FAIL', note: j?.error ?? '接口返回失败' };
      const c = j.counts ?? {};
      return {
        state: j.state === 'FAIL' ? 'FAIL' : j.state === 'WARN' ? 'WARN' : 'PASS',
        note: 'fresh ' + (c.fresh ?? 0) + ' / expired ' + (c.expired ?? 0) + ' / conflicted ' + (c.conflicted ?? 0),
      };
    },
  },
  {
    key: 'ledger', name: 'append-only 台账（P8）', path: '/api/ledger', body: { action: 'verify' },
    judge: (j) => {
      if (!j?.ok) return { state: 'FAIL', note: '链校验失败：' + (j?.verify?.why ?? '未知') };
      const n = j.verify?.count ?? 0;
      return { state: n > 0 ? 'PASS' : 'WARN', note: '链完整，' + n + ' 条' };
    },
  },
  {
    key: 'context', name: '上下文压缩（A5）', path: '/api/context', body: { action: 'estimate', text: 'hello 念初' },
    judge: (j) => {
      if (!j?.ok) return { state: 'FAIL', note: j?.error ?? '接口返回失败' };
      return { state: typeof j.tokens === 'number' ? 'PASS' : 'WARN', note: '估算 ' + j.tokens + ' tokens' };
    },
  },
  {
    key: 'collab', name: '多代理协作（A9）', path: '/api/collab',
    body: { action: 'run', roles: [{ name: 'a', task: 'ping' }, { name: 'b', task: 'pong' }] },
    judge: (j) => {
      if (!j?.ok) return { state: 'FAIL', note: j?.error ?? '接口返回失败' };
      const causes = (j.journal ?? []).map((m: { causeBy?: string }) => m.causeBy);
      const hasAck = causes.includes('ack');
      return {
        state: hasAck ? 'PASS' : 'WARN',
        note: 'state=' + j.state + ' · 流水 ' + causes.join(',') + (hasAck ? '' : '（缺 ack，订阅可能没生效）'),
      };
    },
  },
  {
    key: 'skills', name: '技能装载（A12）', path: '/api/skills', body: { action: 'catalog' },
    judge: (j) => {
      if (!j?.ok) return { state: 'FAIL', note: j?.error ?? '接口返回失败' };
      const n = (j.skills ?? j.catalog ?? []).length ?? 0;
      return { state: n > 0 ? 'PASS' : 'WARN', note: '装载 ' + n + ' 个技能' };
    },
  },
];

type Row = { key: string; name: string; state: string; note: string; ms: number };

export function SelfCheckPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    const out: Row[] = [];
    for (const p of PROBES) {
      const t0 = performance.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(p.path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(p.body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const ms = Math.round(performance.now() - t0);
        let json: any = null;
        try { json = await r.json(); } catch { json = null; }
        if (!json) {
          out.push({ key: p.key, name: p.name, state: 'UNKNOWN', note: 'HTTP ' + r.status + ' 但响应不是 JSON', ms });
          continue;
        }
        const v = p.judge(json);
        out.push({ key: p.key, name: p.name, state: v.state, note: v.note, ms });
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        out.push({
          key: p.key, name: p.name, state: 'UNKNOWN',
          note: '请求失败：' + String((e as Error)?.message ?? e).slice(0, 60) + '（判不了，不算通过）',
          ms,
        });
      }
    }
    setRows(out);
    setAt(new Date().toLocaleTimeString());
    setBusy(false);
  }, []);

  useEffect(() => { void run(); }, [run]);

  const tally = rows.reduce<Record<string, number>>((a, r) => {
    a[r.state] = (a[r.state] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div className="wb__selfcheck">
      <div className="wb__selfcheck-head">
        <b>后端能力自检</b>
        <span className="wb__selfcheck-sub">
          逐项真发请求（不是读静态文件）
          {at && ' · 上次 ' + at}
        </span>
        <button className="wb__float-btn" onClick={() => void run()} disabled={busy}>
          {busy ? '检测中…' : '重跑'}
        </button>
      </div>
      <div className="wb__selfcheck-tally">
        {['PASS', 'WARN', 'FAIL', 'UNKNOWN'].map((s) => (
          <span key={s} className="wb-pill" data-v={s}>{s} {tally[s] ?? 0}</span>
        ))}
      </div>
      <div className="wb__selfcheck-list">
        {rows.map((r) => (
          <div key={r.key} className="wb__selfcheck-row">
            <span className="wb-pill" data-v={r.state}>{r.state}</span>
            <span className="wb__selfcheck-name">{r.name}</span>
            <span className="wb__selfcheck-note">{r.note}</span>
            <span className="wb__selfcheck-ms">{r.ms}ms</span>
          </div>
        ))}
        {!rows.length && !busy && <div className="wb__empty-sub">还没有结果，点「重跑」</div>}
      </div>
    </div>
  );
}

export default SelfCheckPanel;
