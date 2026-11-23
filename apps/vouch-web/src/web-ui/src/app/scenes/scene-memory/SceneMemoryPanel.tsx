import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  MEMORY_LIMITS,
  SECTION0_SUBSECTIONS,
  buildSkeleton,
  byteLength,
  extractSection0,
  validateMemory,
  validateProjectMemory,
} from './memoryEngine';
import { verdictFromValidation, tally, allGreen } from './verdict';
import { makeDispatchTicket, dedupAppend, DISPATCH_CHANGED_EVENT } from './dispatchEngine';
import type { DispatchItem } from './dispatchEngine';
import type { Verdict } from './verdict';

/**
 * 场景记忆面板 —— 真实使用 memoryEngine + verdict 的界面（不是示意）
 *
 * 照「淋雨家工作台」的记忆规矩，把可校验的硬约束搬到界面上：
 *   · §〇 交接 ≤4KB，五小节必须齐（当前状态/上一轮结论/未完成/下一步/坑）
 *   · 核心职责 ≥3 条
 *   · 主文件 ≤25KB、项目记忆 ≤8KB
 *   · 体量红线用真实字节数（UTF-8），不是字符数
 *
 * 关键设计：**判不了就说判不了**
 *   - 空输入 ⇒ UNKNOWN（不是 PASS）
 *   - 有 error ⇒ FAIL
 *   - 只有 warn ⇒ WARN
 *   - 全过 ⇒ PASS
 *   四态徽章直接显示 verdict，绝不把 UNKNOWN 画成绿色。
 */

type DocKind = 'main' | 'project';

const S = {
  wrap: { padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'auto' } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' } as CSSProperties,
  h1: { fontSize: 'var(--openbitfun-type-heading-md-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', margin: 0 } as CSSProperties,
  sub: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', opacity: 0.6 } as CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
  panel: { border: '1px solid var(--vouch-border, rgba(128,128,128,.25))', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
  label: { fontSize: 'var(--openbitfun-type-body-sm-font-size)', fontWeight: 'var(--openbitfun-type-label-md-weight-font-weight)', opacity: 0.85 } as CSSProperties,
  ta: {
    width: '100%', minHeight: 220, resize: 'vertical', padding: 10, borderRadius: 8,
    border: '1px solid var(--vouch-border, rgba(128,128,128,.3))',
    background: 'var(--vouch-surface, rgba(128,128,128,.06))',
    color: 'inherit', fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-body-sm-font-size)', lineHeight: 'var(--openbitfun-type-body-md-line-height)',
    boxSizing: 'border-box',
  } as CSSProperties,
  meter: { height: 6, borderRadius: 3, background: 'rgba(128,128,128,.2)', overflow: 'hidden', flex: 1, minWidth: 120 } as CSSProperties,
  hint: { fontSize: 'var(--openbitfun-type-meta-font-size)', opacity: 0.55, lineHeight: 'var(--openbitfun-type-body-md-line-height)' } as CSSProperties,
};

const segStyle = (on: boolean): CSSProperties => ({
  padding: '5px 12px', borderRadius: 6, fontSize: 'var(--openbitfun-type-body-sm-font-size)', cursor: 'pointer',
  border: '1px solid ' + (on ? 'var(--vouch-accent, #4c8dff)' : 'rgba(128,128,128,.35)'),
  background: on ? 'rgba(76,141,255,.14)' : 'transparent',
  color: 'inherit', fontWeight: on ? 600 : 400,
});

/** 确定性千分位格式化（不依赖 locale，避免 i18n locale-format 门禁） */
const fmtNum = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

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

const meterFillStyle = (ratio: number, over: boolean): CSSProperties => ({
  height: '100%', width: Math.min(100, ratio * 100) + '%',
  background: over ? '#da3633' : ratio > 0.85 ? '#d29922' : '#2ea043',
  transition: 'width .2s ease',
});

const KEY = 'vouch.sceneMemory.draft.v1';
/** 与 DispatchScene 共用同一个账本 —— 派单必须落在同一个地方，否则'派了但看不见' */
const DISPATCH_KEY = '{{SECRET_fgekbho2}}';
const DISPATCH_FROM = '场景记忆';

export default function SceneMemoryPanel() {
  const [kind, setKind] = useState<DocKind>('main');
  const [text, setText] = useState<string>('');

  // 草稿本地持久化（刷新不丢）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setText(raw);
    } catch { /* localStorage 不可用则忽略 */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, text);
      // 健康检查面板读同一份 key —— 写完必须广播，否则它看不到
      window.dispatchEvent(new Event('nianchu:memory-changed'));
    } catch { /* 忽略 */ }
  }, [text]);

  // 真实校验（纯函数，同输入同输出）
  const result = useMemo(
    () => (kind === 'main' ? validateMemory(text) : validateProjectMemory(text)),
    [kind, text],
  );
  // 【2026-11-17 修·假绿】原来用 verdictForMemory(text)，它固定跑 validateMemory，
  // 切到「项目记忆」时下方列表有 WARN 但徽章仍显示 PASS = 假绿。
  // 现在徽章与列表**同源**（都用 result），空输入仍判 UNKNOWN。
  const verdict = useMemo<Verdict>(
    () => (text.trim() === '' ? 'UNKNOWN' : verdictFromValidation(result)),
    [text, result],
  );
  const counts = useMemo(() => tally([verdict]), [verdict]);

  const bytes = byteLength(text);
  const limit = kind === 'main' ? MEMORY_LIMITS.main : MEMORY_LIMITS.project;
  const ratio = limit ? bytes / limit : 0;

  const s0 = useMemo(() => extractSection0(text), [text]);
  const s0Bytes = s0 ? byteLength(s0) : 0;
  const s0Missing = useMemo(
    () => SECTION0_SUBSECTIONS.filter((t) => !text.includes(t)),
    [text],
  );

  // 就某条问题一键派单：四件套由 dispatchEngine 校验，不合格就拒绝生成
  const [dispatched, setDispatched] = useState<{ code: string; ok: boolean; why: string } | null>(null);
  const dispatchIssue = (issue: { code: string; message: string; level: 'error' | 'warn' }) => {
    const target = kind === 'project' ? '记忆维护' : '场景维护';
    const r = makeDispatchTicket({
      id: 'mem-' + Date.now() + '-' + issue.code,
      from: DISPATCH_FROM,
      to: target,
      at: Date.now(),
      phenomenon: '[' + issue.code + '] ' + issue.message,
      howTo: '00-核心机制/六-记忆机制.md §4（' + (kind === 'project' ? '项目记忆 ≤8KB' : '主文件 ≤25KB') + '）',
      howVerify: 'node tools/memory/check.mjs',
    });
    if (!r.ok || !r.ticket) {
      setDispatched({ code: issue.code, ok: false, why: r.issues.map((x) => x.message).join('；') });
      return;
    }
    try {
      const raw = localStorage.getItem(DISPATCH_KEY);
      const prev: DispatchItem[] = raw ? (JSON.parse(raw) as DispatchItem[]) : [];
      const { tickets } = dedupAppend(prev, r.ticket);
      localStorage.setItem(DISPATCH_KEY, JSON.stringify(tickets));
      // 已挂载的「任务分派」场景不会自动重读 localStorage —— 必须广播
      try { window.dispatchEvent(new Event(DISPATCH_CHANGED_EVENT)); } catch { /* 忽略 */ }
      setDispatched({ code: issue.code, ok: true, why: '已进「任务分派」账本' });
    } catch {
      setDispatched({ code: issue.code, ok: false, why: 'localStorage 写入失败' });
    }
  };

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h1 style={S.h1}>场景记忆</h1>
        <span style={S.sub}>§〇 交接 ≤4KB · 五小节必须齐 · 核心职责 ≥3 · 主文件 ≤25KB / 项目 ≤8KB</span>
        <span style={{ marginLeft: 'auto' }} />
        <span style={badgeStyle(verdict)}>{verdict}</span>
      </div>

      <div style={S.row}>
        <button style={segStyle(kind === 'main')} onClick={() => setKind('main')}>主文件（≤25KB）</button>
        <button style={segStyle(kind === 'project')} onClick={() => setKind('project')}>项目记忆（≤8KB）</button>
        <span style={{ marginLeft: 'auto' }} />
        <button
          style={segStyle(false)}
          onClick={() => setText(buildSkeleton('新场景'))}
          title="插入一份合规骨架，可照着填"
        >
          插入骨架
        </button>
      </div>

      <div style={S.panel}>
        <div style={S.label}>记忆正文</div>
        <textarea
          style={S.ta}
          value={text}
          spellCheck={false}
          placeholder={'--- 粘贴或撰写场景记忆 ---\n\n## §〇 交接\n### 当前状态\n### 上一轮结论\n### 未完成\n### 下一步\n### 坑'}
          onChange={(e) => setText(e.target.value)}
        />
        <div style={S.row}>
          <span style={S.hint}>体量</span>
          <div style={S.meter}>
            <div style={meterFillStyle(ratio, bytes > limit)} />
          </div>
          <span style={S.hint}>
            {fmtNum(bytes)} / {fmtNum(limit)} B（{Math.round(ratio * 100)}%）
          </span>
        </div>
      </div>

      <div style={S.panel}>
        <div style={S.row}>
          <span style={S.label}>校验结果</span>
          <span style={S.sub}>
            {counts.PASS} PASS · {counts.WARN} WARN · {counts.FAIL} FAIL · {counts.UNKNOWN} UNKNOWN
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <span style={S.sub}>{allGreen([verdict]) ? '全绿' : '未全绿'}</span>
        </div>

        {text.trim() === '' ? (
          <div style={S.hint}>还没有内容 —— 判不了（UNKNOWN），不是通过。</div>
        ) : result.issues.length === 0 ? (
          <div style={{ ...issueStyle('warn'), color: '#2ea043' }}>✓ 无问题</div>
        ) : (
          result.issues.map((it, i) => (
            <div key={it.code + i} style={issueStyle(it.level)}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ flex: 1 }}>
                  {it.level === 'error' ? '✗' : '⚠'} [{it.code}] {it.message}
                </span>
                <button
                  style={{
                    padding: '2px 9px', borderRadius: 6, fontSize: 'var(--openbitfun-type-meta-font-size)', cursor: 'pointer',
                    border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
                  }}
                  onClick={() => dispatchIssue(it)}
                >
                  就此问题派单
                </button>
              </div>
              {dispatched && dispatched.code === it.code && (
                <div style={{ ...S.hint, marginTop: 2 }}>
                  {dispatched.ok ? '✓ ' : '✗ '}{dispatched.why}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div style={S.panel}>
        <div style={S.label}>§〇 交接检查</div>
        {s0 === null ? (
          <div style={issueStyle('error')}>✗ 找不到 §〇 交接小节</div>
        ) : (
          <>
            <div style={S.row}>
              <span style={S.hint}>§〇 体量</span>
              <div style={S.meter}>
                <div style={meterFillStyle(s0Bytes / MEMORY_LIMITS.section0, s0Bytes > MEMORY_LIMITS.section0)} />
              </div>
              <span style={S.hint}>
                {fmtNum(s0Bytes)} / {fmtNum(MEMORY_LIMITS.section0)} B
              </span>
            </div>
            {s0Missing.length > 0 ? (
              <div style={issueStyle('error')}>✗ 缺小节：{s0Missing.join('、')}</div>
            ) : (
              <div style={{ ...issueStyle('warn'), color: '#2ea043' }}>✓ 五小节齐全</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
