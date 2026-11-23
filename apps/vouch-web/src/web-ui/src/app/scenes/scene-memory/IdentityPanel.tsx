import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  cardFingerprint,
  extractFingerprint,
  validateIndexRow,
  tableVerdictOf,
  verifyCardFingerprint,
} from './identityEngine';
import type { IdentityIndexRow } from './identityEngine';
import { verdictFromValidation, tally, allGreen } from './verdict';
import type { Verdict } from './verdict';

/**
 * 身份面板 —— 真实使用 identityEngine 的界面
 *
 * 照「淋雨家工作台」的身份规矩，把可校验的部分搬到界面上：
 *   · 定位卡（contextCard）改了就换指纹；身份卡里登记的指纹必须与当前定位卡一致
 *   · 不一致 ⇒ 指纹过期（error），提示去跑 stamp —— **不自动修**，判断权在人
 *   · 身份索引 7 列齐全
 *
 * 关键：判不了就说判不了
 *   · 两个输入都空 ⇒ UNKNOWN
 *   · 身份卡没有指纹 ⇒ FAIL（no_fingerprint）
 *   · 指纹不一致 ⇒ FAIL（fingerprint_expired）
 *   · 一致 ⇒ PASS
 *
 * ⛔ 不做越界拦截：本面板只算指纹、只报差异，不改任何文件、不阻止任何操作。
 */

const S = {
  wrap: { padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'auto' } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' } as CSSProperties,
  h1: { fontSize: 'var(--openbitfun-type-heading-md-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', margin: 0 } as CSSProperties,
  sub: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', opacity: 0.6 } as CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
  panel: { border: '1px solid var(--vouch-border, rgba(128,128,128,.25))', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
  label: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', opacity: 0.85 } as CSSProperties,
  ta: {
    width: '100%', minHeight: 140, resize: 'vertical', padding: 10, borderRadius: 8,
    border: '1px solid var(--vouch-border, rgba(128,128,128,.3))',
    background: 'var(--vouch-surface, rgba(128,128,128,.06))',
    color: 'inherit', fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-md-line-height)',
    boxSizing: 'border-box',
  } as CSSProperties,
  hint: { fontSize: 'var(--openbitfun-type-meta-font-size)', opacity: 0.55, lineHeight: 'var(--openbitfun-type-body-md-line-height)' } as CSSProperties,
  mono: { fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-body-sm-font-size)' } as CSSProperties,
  mini: { padding: '3px 10px', borderRadius: 6, fontSize: 'var(--openbitfun-type-meta-font-size)', cursor: 'pointer', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' } as CSSProperties,
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

const issueStyle = (lv: 'error' | 'warn'): CSSProperties => ({
  fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-lg-line-height)',
  color: lv === 'error' ? '#da3633' : '#d29922',
});

const segStyle = (on: boolean): CSSProperties => ({
  padding: '5px 12px', borderRadius: 6, fontSize: 'var(--openbitfun-type-body-sm-font-size)', cursor: 'pointer',
  border: '1px solid ' + (on ? 'var(--vouch-accent, #4c8dff)' : 'rgba(128,128,128,.35)'),
  background: on ? 'rgba(76,141,255,.14)' : 'transparent',
  color: 'inherit', fontWeight: on ? 600 : 400,
});

const KEY_CTX = '{{SECRET_vqzcqz7a}}';
const KEY_ID = '{{SECRET_llk3jkyd}}';
const KEY_ROWS = '{{SECRET_rkzq4b7l}}';

const INDEX_COLS: (keyof IdentityIndexRow)[] = [
  'sceneId', 'panelId', 'panelTitle', 'sessionTitle', 'sessionId', 'contextCard', 'mainSkill',
];

export default function IdentityPanel() {
  const [ctxCard, setCtxCard] = useState('');
  const [idCard, setIdCard] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [fpCheck, setFpCheck] = useState<{ ok: boolean; issues: { level: 'error' | 'warn'; code: string; message: string }[] } | null>(null);
  const [curFp, setCurFp] = useState<string>('');

  // 草稿持久化
  useEffect(() => {
    try {
      const a = localStorage.getItem(KEY_CTX); if (a) setCtxCard(a);
      const b = localStorage.getItem(KEY_ID); if (b) setIdCard(b);
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(KEY_CTX, ctxCard);
      window.dispatchEvent(new Event('nianchu:identity-changed'));
    } catch { /* 忽略 */ }
  }, [ctxCard]);
  useEffect(() => {
    try {
      localStorage.setItem(KEY_ID, idCard);
      window.dispatchEvent(new Event('nianchu:identity-changed'));
    } catch { /* 忽略 */ }
  }, [idCard]);

  // 定位卡指纹（异步，随内容变化重算）
  useEffect(() => {
    let alive = true;
    if (ctxCard.trim() === '') { setCurFp(''); return; }
    cardFingerprint(ctxCard).then((fp) => { if (alive) setCurFp(fp); }).catch(() => { if (alive) setCurFp(''); });
    return () => { alive = false; };
  }, [ctxCard]);

  const registeredFp = useMemo(() => extractFingerprint(idCard), [idCard]);

  // 真实校验（异步）
  const runVerify = async () => {
    setVerifying(true);
    try {
      const r = await verifyCardFingerprint(idCard, ctxCard);
      setFpCheck(r);
    } catch {
      setFpCheck(null);
    } finally {
      setVerifying(false);
    }
  };

  // 自动随输入重跑（防抖 250ms）
  useEffect(() => {
    if (ctxCard.trim() === '' && idCard.trim() === '') { setFpCheck(null); return; }
    const t = setTimeout(() => { void runVerify(); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxCard, idCard]);

  const verdict: Verdict = useMemo(() => {
    if (ctxCard.trim() === '' && idCard.trim() === '') return 'UNKNOWN';
    if (!fpCheck) return 'UNKNOWN';
    return verdictFromValidation({ ok: fpCheck.ok, issues: fpCheck.issues });
  }, [ctxCard, idCard, fpCheck]);


  // 索引表格（7 列 × N 行，落 localStorage）
  const [idxMode, setIdxMode] = useState(false);
  const emptyRow = useMemo<IdentityIndexRow>(
    () => ({ sceneId: '', panelId: '', panelTitle: '', sessionTitle: '', sessionId: '', mainSkill: '', contextCard: '' }),
    [],
  );
  const [rows, setRows] = useState<IdentityIndexRow[]>([]);
  const [draft, setDraft] = useState<IdentityIndexRow>(emptyRow);

  // 载入 / 保存
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY_ROWS);
      if (raw) {
        const p = JSON.parse(raw) as IdentityIndexRow[];
        if (Array.isArray(p)) setRows(p);
      }
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(KEY_ROWS, JSON.stringify(rows));
      window.dispatchEvent(new Event('nianchu:identity-changed'));
    } catch { /* 忽略 */ }
  }, [rows]);

  const draftCheck = useMemo(() => validateIndexRow(draft), [draft]);
  const draftFilled = useMemo(
    () => INDEX_COLS.some((c) => String(draft[c] ?? '').trim() !== ''),
    [draft],
  );
  const draftVerdict: Verdict = useMemo(() => {
    if (!draftFilled) return 'UNKNOWN';
    return verdictFromValidation(draftCheck);
  }, [draftFilled, draftCheck]);

  // 每一行独立判定（落盘的脏数据也要如实标红）
  const rowVerdicts = useMemo(
    () => rows.map((r) => verdictFromValidation(validateIndexRow(r))),
    [rows],
  );
  const rowsTally = useMemo(() => tally(rowVerdicts), [rowVerdicts]);

  // 表格整体：有行 ⇒ 按行判定汇总；无行 ⇒ UNKNOWN（没数据不等于通过）
  const tableVerdict: Verdict = useMemo(() => tableVerdictOf(rowVerdicts), [rowVerdicts]);

  const shownVerdict = idxMode ? tableVerdict : verdict;
  // 【2026-11-17 修·崩溃】原写法 `idxMode ? rowsTally : useMemo(...)` 把 hook 放进
  // 三元表达式 ⇒ hook 顺序随 idxMode 变化 ⇒ React error #300（Rendered more hooks
  // than during the previous render），点「身份索引 7 列」直接白屏。
  // type-check 与 build 都发现不了，只有真跑才炸。hook 必须无条件调用。
  const fpCounts = useMemo(() => tally([verdict]), [verdict]);
  const shownCounts = idxMode ? rowsTally : fpCounts;

  const addRow = () => {
    if (!draftCheck.ok) return;
    setRows((prev) => [...prev, { ...draft }]);
    setDraft(emptyRow);
  };
  const delRow = (i: number) => setRows((prev) => prev.filter((_, k) => k !== i));

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h1 style={S.h1}>场景身份</h1>
        <span style={S.sub}>定位卡指纹 = sha256 前 16 hex · 卡改了指纹就变 · 不一致要跑 stamp（我们不自动改）</span>
        <span style={{ marginLeft: 'auto' }} />
        <span style={badgeStyle(shownVerdict)}>{shownVerdict}</span>
      </div>

      <div style={S.row}>
        <button style={segStyle(!idxMode)} onClick={() => setIdxMode(false)}>指纹校验</button>
        <button style={segStyle(idxMode)} onClick={() => setIdxMode(true)}>身份索引 7 列</button>
      </div>

      {!idxMode ? (
        <>
          <div style={S.panel}>
            <div style={S.label}>定位卡（contextCard）</div>
            <textarea
              style={S.ta}
              value={ctxCard}
              spellCheck={false}
              placeholder={'粘贴定位卡正文 —— 它决定指纹'}
              onChange={(e) => setCtxCard(e.target.value)}
            />
            <div style={S.row}>
              <span style={S.hint}>当前指纹</span>
              <span style={S.mono}>{curFp || '—'}</span>
            </div>
          </div>

          <div style={S.panel}>
            <div style={S.label}>身份卡（identityCard）</div>
            <textarea
              style={S.ta}
              value={idCard}
              spellCheck={false}
              placeholder={'粘贴身份卡正文 —— 里面应含登记过的 sha256:xxxxxxxxxxxxxxxx'}
              onChange={(e) => setIdCard(e.target.value)}
            />
            <div style={S.row}>
              <span style={S.hint}>登记指纹</span>
              <span style={S.mono}>{registeredFp || '—（未 stamp）'}</span>
            </div>
          </div>

          <div style={S.panel}>
            <div style={S.row}>
              <span style={S.label}>校验结果</span>
              <span style={S.sub}>
                {shownCounts.PASS} PASS · {shownCounts.WARN} WARN · {shownCounts.FAIL} FAIL · {shownCounts.UNKNOWN} UNKNOWN
              </span>
              <span style={{ marginLeft: 'auto' }} />
              <span style={S.sub}>{allGreen([shownVerdict]) ? '全绿' : '未全绿'}</span>
            </div>
            {verifying ? (
              <div style={S.hint}>计算中…</div>
            ) : ctxCard.trim() === '' && idCard.trim() === '' ? (
              <div style={S.hint}>还没有内容 —— 判不了（UNKNOWN），不是通过。</div>
            ) : !fpCheck ? (
              <div style={S.hint}>还没算出来 —— 判不了（UNKNOWN）。</div>
            ) : fpCheck.issues.length === 0 ? (
              <div style={{ ...issueStyle('warn'), color: '#2ea043' }}>✓ 指纹一致</div>
            ) : (
              fpCheck.issues.map((it, i) => (
                <div key={it.code + i} style={issueStyle(it.level)}>
                  {it.level === 'error' ? '✗' : '⚠'} [{it.code}] {it.message}
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div style={S.panel}>
            <div style={S.row}>
              <span style={S.label}>身份索引（7 列 × {rows.length} 行）</span>
              <span style={S.sub}>
                {rowsTally.PASS} PASS · {rowsTally.WARN} WARN · {rowsTally.FAIL} FAIL · {rowsTally.UNKNOWN} UNKNOWN
              </span>
              <span style={{ marginLeft: 'auto' }} />
              {rows.length > 0 && (
                <button style={S.mini} onClick={() => setRows([])}>清空全部</button>
              )}
            </div>
            {rows.length === 0 ? (
              <div style={S.hint}>还没有行 —— 判不了（UNKNOWN），不是通过。在下面填一行后点「加入表格」。</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.map((r, i) => {
                  const v = rowVerdicts[i];
                  const bad = validateIndexRow(r);
                  return (
                    <div key={i} style={{ ...S.panel, padding: 8, gap: 4 }}>
                      <div style={S.row}>
                        <span style={badgeStyle(v)}>{v}</span>
                        <span style={{ ...S.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.sceneId} / {r.panelId} / {r.panelTitle} / {r.sessionTitle} / {r.sessionId} / {r.mainSkill} / {r.contextCard}
                        </span>
                        <button style={S.mini} onClick={() => delRow(i)}>删除</button>
                      </div>
                      {bad.issues.map((it, k) => (
                        <div key={k} style={issueStyle(it.level)}>
                          {it.level === 'error' ? '✗' : '⚠'} [{it.code}] {it.message}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={S.panel}>
            <div style={S.label}>新增一行（7 列必须齐才允许加入）</div>
            {INDEX_COLS.map((c) => (
              <div key={c} style={S.row}>
                <span style={{ ...S.hint, width: 130 }}>{c}{c === 'mainSkill' ? '（可填 —）' : ''}</span>
                <input
                  style={{ ...S.ta, minHeight: 0, height: 30, flex: 1 }}
                  value={String(draft[c] ?? '')}
                  spellCheck={false}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [c]: e.target.value }))}
                />
              </div>
            ))}
            <div style={S.row}>
              <button
                style={{
                  padding: '6px 14px', borderRadius: 8, fontSize: 'var(--openbitfun-type-body-sm-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', cursor: draftCheck.ok ? 'pointer' : 'not-allowed',
                  border: '1px solid transparent', background: draftCheck.ok ? 'var(--vouch-accent, #2f6fed)' : 'rgba(128,128,128,.3)',
                  color: draftCheck.ok ? '#fff' : 'inherit',
                }}
                onClick={addRow}
                disabled={!draftCheck.ok}
              >
                加入表格
              </button>
              <button style={S.mini} onClick={() => setDraft(emptyRow)}>清空草稿</button>
            </div>
          </div>

          <div style={S.panel}>
            <div style={S.row}>
              <span style={S.label}>校验结果</span>
              <span style={S.sub}>本行草稿：{draftVerdict}</span>
              <span style={{ marginLeft: 'auto' }} />
              <span style={S.sub}>{allGreen([draftVerdict]) ? '可加入' : '未通过'}</span>
            </div>
            {draftVerdict === 'UNKNOWN' ? (
              <div style={S.hint}>还没填任何列 —— 判不了（UNKNOWN），不是通过。</div>
            ) : draftCheck.issues.length === 0 ? (
              <div style={{ ...issueStyle('warn'), color: '#2ea043' }}>✓ 7 列齐全，可以加入表格</div>
            ) : (
              draftCheck.issues.map((it, i) => (
                <div key={it.code + i} style={issueStyle(it.level)}>
                  {it.level === 'error' ? '✗' : '⚠'} [{it.code}] {it.message}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
