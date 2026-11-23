import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  MAX_CHARS,
  MAX_MESSAGES,
  THRESHOLDS,
  buildMessage,
  canSendMore,
  computeStatus,
  dedupAppend,
  isDispatch,
  ledger,
  DISPATCH_CHANGED_EVENT,
  validateFour,
} from '../scene-memory/dispatchEngine';
import type { Kind, Ticket } from '../scene-memory/dispatchEngine';
import { verdictFromValidation } from '../scene-memory/verdict';
import type { Verdict } from '../scene-memory/verdict';

/**
 * 命令台 · 派单调度 —— **全部逻辑走 dispatchEngine**（不再自带一套）
 *
 * 之前这个场景自己实现了状态机 + 5 分钟超时，与 dispatchEngine 的
 * THRESHOLDS.overdueMs(2h) / ledger() / validateFour() 各说各话 ——
 * 同一个概念两套判定 = 迟早不一致。现在单一数据源：
 *   · 状态：computeStatus(ticket, now)  ⇒ dispatched / received / overdue
 *   · 三栏：ledger(tickets, me, now)    ⇒ pending / blackHole / received
 *   · 四件套：validateFour(body)        ⇒ 缺一件就 FAIL，不给投递
 *   · 消息体：buildMessage()            ⇒ 首行标记 + 末行【结束】，>200 字告警
 *   · 去重：dedupAppend()               ⇒ 同 hash 只进一次（恰好一次）
 *   · 条数上限：canSendMore()           ⇒ ≤3 条，防客套烧 token
 *
 * ⛔ 不做越界拦截：本场景只记录台账、给提示，不阻止任何真实操作。
 */

type Receipt = { conclusion: string; evidence: string; path: string };

/** UI 侧条目：引擎 Ticket + 人看的字段 */
type Item = Ticket & {
  id: string;
  instruction: string;
  owner: string;
  phenomenon: string;
  howTo: string;
  howVerify: string;
  receipt?: Receipt;
};

const OWNERS = ['命令台', '调研', '竞品拆解', '逆向分析', '架构梳理', '实施计划', '前端工坊', '后端工坊', '自我复盘', '故障分析', '本地电脑', '技能锻造'];

const S = {
  wrap: { padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'auto' } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' } as CSSProperties,
  h1: { fontSize: 'var(--openbitfun-type-heading-md-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', margin: 0 } as CSSProperties,
  sub: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', opacity: 0.6 } as CSSProperties,
  card: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
  label: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', opacity: 0.85 } as CSSProperties,
  input: {
    width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 'var(--openbitfun-type-body-md-font-size)',
    border: '1px solid rgba(128,128,128,.3)', background: 'rgba(128,128,128,.06)',
    color: 'inherit', boxSizing: 'border-box',
  } as CSSProperties,
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 } as CSSProperties,
  btn: (primary: boolean): CSSProperties => ({
    padding: '8px 16px', borderRadius: 8, fontSize: 'var(--openbitfun-type-body-md-font-size)', cursor: 'pointer', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)',
    border: '1px solid ' + (primary ? 'transparent' : 'rgba(128,128,128,.35)'),
    background: primary ? 'var(--vouch-accent, #2f6fed)' : 'transparent',
    color: primary ? '#fff' : 'inherit',
  }),
  lanes: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 } as CSSProperties,
  lane: (color: string): CSSProperties => ({
    border: '1px solid rgba(128,128,128,.22)', borderRadius: 10, padding: 12,
    display: 'flex', flexDirection: 'column', gap: 10, minHeight: 180,
    background: color === 'red' ? 'rgba(185,28,28,.04)' : 'transparent',
  }),
  laneHead: (color: string): CSSProperties => ({
    fontSize: 'var(--openbitfun-type-body-md-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)',
    color: color === 'red' ? '#b91c1c' : color === 'green' ? '#2ea043' : '#2f6fed',
  }),
  item: { border: '1px solid rgba(128,128,128,.2)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
  kv: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-md-line-height)' } as CSSProperties,
  k: { opacity: 0.6 } as CSSProperties,
  mini: { padding: '3px 10px', borderRadius: 6, fontSize: 'var(--openbitfun-type-meta-font-size)', cursor: 'pointer', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' } as CSSProperties,
  hint: { fontSize: 'var(--openbitfun-type-meta-font-size)', opacity: 0.55, lineHeight: 'var(--openbitfun-type-body-md-line-height)' } as CSSProperties,
  err: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-lg-line-height)', color: '#da3633' } as CSSProperties,
  warn: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-lg-line-height)', color: '#d29922' } as CSSProperties,
  mono: { fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-meta-font-size)', whiteSpace: 'pre-wrap', lineHeight: 'var(--openbitfun-type-body-md-line-height)', opacity: 0.85 } as CSSProperties,
};

const VERDICT_COLORS: Record<Verdict, [string, string]> = {
  PASS: ['rgba(46,160,67,.16)', '#2ea043'],
  WARN: ['rgba(210,153,34,.16)', '#d29922'],
  FAIL: ['rgba(218,54,51,.16)', '#da3633'],
  UNKNOWN: ['rgba(128,128,128,.16)', '#8b949e'],
};
const badgeStyle = (v: Verdict): CSSProperties => {
  const [bg, fg] = VERDICT_COLORS[v];
  return { padding: '3px 10px', borderRadius: 999, background: bg, color: fg, fontSize: 'var(--openbitfun-type-body-sm-font-size)', fontWeight: 'var(--openbitfun-type-heading-panel-weight-font-weight)', border: '1px solid ' + fg };
};

const KEY = '{{SECRET_fgekbho2}}';
const ME = '命令台';

/** 简易 hash（同内容同 hash，用于 dedupAppend 的「恰好一次」） */
function hashOf(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return 'h' + (h >>> 0).toString(16);
}

const seed = (now: number): Item[] => [
  {
    id: 's1', hash: hashOf('梳理多 Agent 协作协议'), from: ME, to: '调研', at: now - 120000,
    kind: 'dispatch', route: 'RPC-200', delivered: true, ack: false,
    instruction: '梳理多 Agent 协作协议，列出待定项', owner: '调研',
    phenomenon: '协作协议未成文', howTo: '00-核心机制/一-协作机制.md', howVerify: '产出协议草案，含派单/公告判据',
  },
  {
    id: 's2', hash: hashOf('复盘上一轮派单执行率'), from: ME, to: '自我复盘', at: now - THRESHOLDS.overdueMs - 60000,
    kind: 'dispatch', route: 'RPC-200', delivered: true, ack: false,
    instruction: '复盘上一轮派单执行率', owner: '自我复盘',
    phenomenon: '上轮 36 条通知只有 8 条真投递', howTo: '00-核心机制/七-消息与交付.md', howVerify: '给出执行率与卡点清单',
  },
  {
    id: 's3', hash: hashOf('拆解 OpenBitFun 的任务调度机制'), from: ME, to: '竞品拆解', at: now - 400000,
    kind: 'dispatch', route: 'RPC-200', delivered: true, ack: true,
    instruction: '拆解 OpenBitFun 的任务调度机制，产出对比文档', owner: '竞品拆解',
    phenomenon: '我们尚无竞品调度对比', howTo: '00-核心机制/四-派单机制.md', howVerify: '产出 对比.md 且覆盖派单/回执字段',
    receipt: { conclusion: '已产出对比，主差异在「未回执」状态的处理', evidence: '对比.md §3', path: 'research/openbitfun-对比.md' },
  },
];

export default function DispatchScene(_props: { isActive?: boolean }) {
  const [items, setItems] = useState<Item[]>(() => seed(Date.now()));
  const [now, setNow] = useState(Date.now());
  const [instruction, setInstruction] = useState('');
  const [phenomenon, setPhenomenon] = useState('');
  const [howTo, setHowTo] = useState('');
  const [howVerify, setHowVerify] = useState('');
  const [owner, setOwner] = useState(OWNERS[1]);
  const [wantReceipt, setWantReceipt] = useState(true);
  const [openReceipt, setOpenReceipt] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt>({ conclusion: '', evidence: '', path: '' });
  const [submitIssues, setSubmitIssues] = useState<{ level: 'error' | 'warn'; code: string; message: string }[]>([]);

  // 时钟：每 30s 刷新，让 overdue 自动浮现
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // 台账持久化
  // 从 localStorage 重读（挂载时 + 别处写完广播时）
  const reloadFromStorage = useCallback(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Item[];
      if (Array.isArray(parsed)) setItems(parsed);
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => {
    reloadFromStorage();
    // 别处（如场景记忆面板）写账本后会广播，这里必须重读，
    // 否则已挂载的场景永远看不到新派单 —— 「派了但看不见」。
    const onChanged = () => reloadFromStorage();
    window.addEventListener(DISPATCH_CHANGED_EVENT, onChanged);
    window.addEventListener('storage', onChanged);
    return () => {
      window.removeEventListener(DISPATCH_CHANGED_EVENT, onChanged);
      window.removeEventListener('storage', onChanged);
    };
  }, [reloadFromStorage]);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* 忽略 */ }
  }, [items]);

  // 引擎：三栏
  const lanes = useMemo(() => ledger(items, ME, now), [items, now]);
  const pending = useMemo(
    () => items.filter((t) => computeStatus(t, now) === 'dispatched' && t.kind === 'dispatch' && !t.ack),
    [items, now],
  );
  const notices = useMemo(() => items.filter((t) => t.kind === 'notice'), [items]);

  // 引擎：四件套校验（实时）
  const four = useMemo(() => validateFour({ phenomenon, howTo, howVerify, wantReceipt }), [phenomenon, howTo, howVerify, wantReceipt]);

  // 引擎：消息体预览
  const preview = useMemo(
    () => buildMessage({ wantReceipt, body: instruction || '（正文）' }),
    [wantReceipt, instruction],
  );

  // 引擎：同 thread 条数
  const threadCount = items.filter((t) => t.instruction === instruction && instruction.trim() !== '').length;
  const more = useMemo(() => canSendMore(threadCount), [threadCount]);

  // 引擎：判据（派单 vs 公告）
  const looksDispatch = useMemo(() => isDispatch(instruction), [instruction]);

  const verdict: Verdict = useMemo(() => {
    if (instruction.trim() === '' && phenomenon.trim() === '' && howTo.trim() === '' && howVerify.trim() === '') return 'UNKNOWN';
    if (!four.ok) return verdictFromValidation({ ok: false, issues: four.issues });
    if (!more.ok) return verdictFromValidation({ ok: false, issues: more.issues });
    return 'PASS';
  }, [instruction, phenomenon, howTo, howVerify, four, more]);

  const submit = () => {
    const issues = [...four.issues, ...more.issues];
    if (issues.length) { setSubmitIssues(issues); return; }
    setSubmitIssues([]);
    const kind: Kind = wantReceipt ? 'dispatch' : 'notice';
    const hash = hashOf(instruction + '|' + owner + '|' + (wantReceipt ? '1' : '0'));
    const t: Item = {
      id: 'i' + Date.now(), hash, from: ME, to: owner, at: Date.now(), kind,
      route: '本地台账', delivered: true, ack: false,
      instruction, owner, phenomenon, howTo, howVerify,
    };
    const r = dedupAppend(items, t);
    if (!r.added) { setSubmitIssues([{ level: 'warn', code: 'duplicate', message: '同样内容已经在台账里（按 hash 去重，不会重复记账）' }]); return; }
    setItems(r.tickets as Item[]);
    setInstruction(''); setPhenomenon(''); setHowTo(''); setHowVerify('');
  };

  const writeReceipt = (id: string) => {
    if (!receipt.conclusion.trim() || !receipt.evidence.trim() || !receipt.path.trim()) {
      setSubmitIssues([{ level: 'error', code: 'receipt_incomplete', message: '回执三件必须齐：结论 / 证据 / 落盘路径' }]);
      return;
    }
    setItems((l) => l.map((x) => (x.id === id ? { ...x, ack: true, receipt } : x)));
    setReceipt({ conclusion: '', evidence: '', path: '' });
    setOpenReceipt(null);
    setSubmitIssues([]);
  };

  const renderItem = (t: Item, tone: 'blue' | 'red' | 'green') => {
    const st = computeStatus(t, now);
    const ageMin = Math.max(0, Math.round((now - t.at) / 60000));
    return (
      <div key={t.id} style={S.item}>
        <div style={{ ...S.kv, fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)' }}>{t.instruction}</div>
        <div style={S.kv}><span style={S.k}>现象：</span>{t.phenomenon}</div>
        <div style={S.kv}><span style={S.k}>照哪做：</span>{t.howTo}</div>
        <div style={S.kv}><span style={S.k}>怎么验：</span>{t.howVerify}</div>
        <div style={S.row}>
          <span style={S.hint}>@{t.owner} · {t.kind === 'notice' ? '公告' : '派单'} · {ageMin} 分钟前 · {st}</span>
          <span style={{ marginLeft: 'auto' }} />
          {tone === 'blue' && <button style={S.mini} onClick={() => setOpenReceipt(openReceipt === t.id ? null : t.id)}>写回执</button>}
          {tone === 'green' && t.receipt && (
            <div style={{ ...S.kv, color: '#2ea043' }}>
              回执·结论：{t.receipt.conclusion}<br />证据：{t.receipt.evidence}<br />落盘：{t.receipt.path}
            </div>
          )}
        </div>
        {openReceipt === t.id && tone === 'blue' && (
          <div style={{ ...S.card, gap: 6 }}>
            <input style={S.input} placeholder="结论（一句话）" value={receipt.conclusion} onChange={(e) => setReceipt({ ...receipt, conclusion: e.target.value })} />
            <input style={S.input} placeholder="证据（跑什么/看到什么）" value={receipt.evidence} onChange={(e) => setReceipt({ ...receipt, evidence: e.target.value })} />
            <input style={S.input} placeholder="落盘路径" value={receipt.path} onChange={(e) => setReceipt({ ...receipt, path: e.target.value })} />
            <div style={S.row}>
              <button style={S.btn(true)} onClick={() => writeReceipt(t.id)}>提交回执</button>
              <button style={S.mini} onClick={() => setOpenReceipt(null)}>取消</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h1 style={S.h1}>命令台 · 派单调度</h1>
        <span style={S.sub}>
          四件套（现象·照哪做·怎么验·回一句）→ 投递 → 回执（结论·证据·落盘）｜超 {Math.round(THRESHOLDS.overdueMs / 3600000)}h 未回 ⇒ 未回执黑洞｜≤{MAX_MESSAGES} 条/≤{MAX_CHARS} 字
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <span style={badgeStyle(verdict)}>{verdict}</span>
      </div>

      <div style={S.card}>
        <div style={S.label}>宿主指令（一句话）</div>
        <input
          style={S.input}
          value={instruction}
          placeholder="例：索引体检报 3 条未登记，照 §6.4 补行，补完跑 索引体检.mjs 应 0，我在等你的回执"
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div style={S.hint}>
          判据（引擎）：{looksDispatch ? '看句子像「派单」（含请你/派单/做完回一句…）' : '看句子像「公告」（只落盘，不欠回执）'}
          {' '}· 本 thread 已有 {threadCount} 条（上限 {MAX_MESSAGES}）
        </div>

        <div style={S.grid3}>
          <div>
            <div style={S.label}>现象（可观察，不要形容词）</div>
            <input style={S.input} value={phenomenon} placeholder="现在是什么样子" onChange={(e) => setPhenomenon(e.target.value)} />
          </div>
          <div>
            <div style={S.label}>照哪做（唯一出处）</div>
            <input style={S.input} value={howTo} placeholder="文档·节 / 工具" onChange={(e) => setHowTo(e.target.value)} />
          </div>
          <div>
            <div style={S.label}>怎么验（通过判据）</div>
            <input style={S.input} value={howVerify} placeholder="跑什么·看到什么算过" onChange={(e) => setHowVerify(e.target.value)} />
          </div>
        </div>

        <div style={S.row}>
          <span style={S.label}>投给</span>
          <select style={{ ...S.input, width: 160 }} value={owner} onChange={(e) => setOwner(e.target.value)}>
            {OWNERS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <label style={{ ...S.hint, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={wantReceipt} onChange={(e) => setWantReceipt(e.target.checked)} />
            要回执（不勾 = 公告，不欠账）
          </label>
          <span style={{ marginLeft: 'auto' }} />
          <button style={S.btn(true)} onClick={submit}>{wantReceipt ? '投递派单（要回执）' : '仅公告（不唤醒·不要求回执）'}</button>
        </div>

        <div style={S.hint}>消息体会长这样（引擎 buildMessage）：</div>
        <div style={S.mono}>{preview.text}</div>
        {preview.issues.map((i, k) => <div key={k} style={S.warn}>⚠ [{i.code}] {i.message}</div>)}
        {submitIssues.map((i, k) => (
          <div key={'s' + k} style={i.level === 'error' ? S.err : S.warn}>
            {i.level === 'error' ? '✗' : '⚠'} [{i.code}] {i.message}
          </div>
        ))}
        {verdict === 'UNKNOWN' && <div style={S.hint}>还没填 —— 判不了（UNKNOWN），不是通过。</div>}
      </div>

      <div style={S.lanes}>
        <div style={S.lane('blue')}>
          <div style={S.laneHead('blue')}>待回执 <span style={{ float: 'right' }}>{pending.length}</span></div>
          {pending.length === 0 ? <div style={S.hint}>暂无</div> : pending.map((t) => renderItem(t, 'blue'))}
        </div>
        <div style={S.lane('red')}>
          <div style={S.laneHead('red')}>未回执 · 黑洞（超 {Math.round(THRESHOLDS.overdueMs / 3600000)} 小时没回）<span style={{ float: 'right' }}>{lanes.blackHole.length}</span></div>
          {lanes.blackHole.length === 0 ? <div style={S.hint}>暂无</div> : (lanes.blackHole as Item[]).map((t) => renderItem(t, 'red'))}
        </div>
        <div style={S.lane('green')}>
          <div style={S.laneHead('green')}>已回执 · 已销账 <span style={{ float: 'right' }}>{lanes.received.length}</span></div>
          {lanes.received.length === 0 ? <div style={S.hint}>暂无</div> : (lanes.received as Item[]).map((t) => renderItem(t, 'green'))}
        </div>
      </div>

      {notices.length > 0 && (
        <div style={S.card}>
          <div style={S.label}>公告（不欠回执，收到也不许回）· {notices.length} 条</div>
          {notices.map((t) => <div key={t.id} style={S.kv}>{t.instruction} <span style={S.hint}>→ @{t.owner}</span></div>)}
        </div>
      )}
    </div>
  );
}
