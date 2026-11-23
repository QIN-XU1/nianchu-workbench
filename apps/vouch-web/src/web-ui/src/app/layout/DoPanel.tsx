import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/infrastructure/api';
import { getTransportAdapter } from '@/infrastructure/api/adapters';
import './DoPanel.scss';

/**
 * 「动手」面板 —— 让 agent 真的改文件、跑命令，并**看着它改**。
 *
 * 三块内容，全部来自宿主真实返回：
 *   ① 工具过程：每次调用（工具名、入参摘要、耗时、成功/失败、关键输出）
 *   ② 变更预览：改前改后逐行 diff（绿加红删），标出新增/修改/删除
 *   ③ 回滚：一键把这个变更集整体回滚，并逐文件回显校验结果
 *
 * 设计取向：**默认不信任**。所以 diff 在前、回滚常驻，
 * 而不是先给一个绿勾再让你自己想办法。
 */
type ToolRec = {
  kind: string;
  tool?: string;
  ok?: boolean;
  ms?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

type DiffLine = { type: ' ' | '-' | '+' | '!'; text: string };

type DiffFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'skipped';
  added?: number;
  removed?: number;
  lines?: DiffLine[];
  note?: string;
};

type ChangeSet = {
  setId: string;
  label?: string;
  at?: string;
  files: DiffFile[];
};

type RunResult = {
  state: string;
  finalText?: string;
  reason?: string;
  transcript?: ToolRec[];
  toolCalls?: number;
  failedToolCalls?: number;
  usage?: { calls?: number; input?: number; output?: number };
  changeSetId?: string;
  changeSet?: ChangeSet;
  changedFiles?: number;
  runToken?: string;
  /** D3 状态可见性：停止原因（可判定的"为什么停"） */
  stopReason?: string;
  stopLabel?: string;
  stopDetail?: string;
  /** D3：决策级 trace（可复盘） */
  traceId?: string;
  /** D3：本轮耗时（毫秒） */
  elapsedMs?: number;
  unattributed?: Array<{ path: string; status: 'created' | 'modified' | 'deleted'; restorable?: boolean }>;
  unattributedCount?: number;
};

type RollbackResult = {
  state: string;
  reason?: string;
  files?: Array<{ path: string; ok: boolean; action?: string; reason?: string }>;
};

/**
 * 停止原因 → 中文标签（与 tools/agent/stop.mjs 的 STOP_META 一一对应）。
 * 放前端的理由：界面要能直接读懂"为什么停"，不该只显示英文 reason。
 */
const STOP_LABEL: Record<string, string> = {
  done: '正常完成',
  step_budget: '撞步数上限',
  token_budget: '撞 token 上限',
  time_budget: '撞时间上限',
  tool_error: '工具全部失败',
  model_error: '模型层失败',
  empty_output: '无产出',
  truncated: '输出被截断',
  user_abort: '被取消',
};

const STATE_COLOR: Record<string, string> = {
  PASS: '#22c55e', WARN: '#f59e0b', FAIL: '#ef4444', UNKNOWN: '#94a3b8',
};

/** 工具调用的人话摘要 */
function describeTool(rec: ToolRec): { head: string; detail: string } {
  const inp = rec.input || {};
  const out = rec.output || {};
  const t = rec.tool || '';
  if (t === 'bash') {
    const cmd = String(inp.command || '').replace(/\s+/g, ' ').slice(0, 90);
    const code = (out as { exit_code?: number }).exit_code;
    return { head: 'bash  ' + cmd, detail: 'exit=' + (code ?? '?') };
  }
  if (t === 'read') {
    return {
      head: 'read  ' + String(inp.file_path || '').slice(-60),
      detail: 'lines=' + ((out as { total_lines?: number }).total_lines ?? '?'),
    };
  }
  if (t === 'write') {
    return {
      head: 'write ' + String(inp.file_path || '').slice(-60),
      detail: ((out as { bytes?: number }).bytes ?? '?') + ' 字节',
    };
  }
  if (t === 'edit') {
    return {
      head: 'edit  ' + String(inp.file_path || '').slice(-60),
      detail: rec.ok ? '替换 ' + ((out as { replacements?: number }).replacements ?? '?') + ' 处' : '被拒绝',
    };
  }
  if (t === 'glob') {
    return { head: 'glob  ' + String(inp.pattern || ''), detail: ((out as { count?: number }).count ?? '?') + ' 个' };
  }
  if (t === 'grep') {
    return { head: 'grep  ' + String(inp.pattern || ''), detail: ((out as { count?: number }).count ?? '?') + ' 处' };
  }
  return { head: t, detail: rec.ok ? 'ok' : '失败' };
}

/** 工具输出里最值得看的一小段 */
function outputPeek(rec: ToolRec): string {
  const out = rec.output as Record<string, unknown> | undefined;
  if (!out) return '';
  if (out.error) return '错误: ' + String(out.error).slice(0, 200);
  if (rec.tool === 'bash') {
    const so = String(out.stdout || '').trim();
    const se = String(out.stderr || '').trim();
    const s = (so || se).slice(0, 400);
    return s;
  }
  if (rec.tool === 'read') return String(out.content || '').slice(0, 400);
  if (rec.tool === 'grep') {
    const ms = (out.matches as Array<{ file: string; line: number; text: string }>) || [];
    return ms.slice(0, 8).map((m) => m.file + ':' + m.line + '  ' + m.text).join('\n');
  }
  if (rec.tool === 'glob') {
    const fs = (out.files as string[]) || [];
    return fs.slice(0, 12).join('\n');
  }
  return '';
}

export default function DoPanel() {
  const [task, setTask] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rb, setRb] = useState<RollbackResult | null>(null);
  const [openRec, setOpenRec] = useState<number | null>(null);
  /** 运行过程中实时到达的工具步骤（不是最终结果里的） */
  const [live, setLive] = useState<ToolRec[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tokenRef = useRef<string | null>(null);

  // 默认工作目录取宿主当前目录，省得用户手打
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const st = await api.invoke<{ cwd?: string; path?: string }>('get_current_workspace', {});
        const dir = st?.cwd || st?.path;
        if (!dead && typeof dir === 'string' && dir) setCwd(dir);
      } catch { /* 拿不到就让用户自己填 */ }
    })();
    return () => { dead = true; };
  }, []);

  const go = useCallback(async () => {
    const taskText = task.trim();
    if (!taskText || busy) return;

    /**
     * 流式：先订阅，再发请求。
     * runToken 由前端生成并传给宿主 —— 这样不会漏掉开头几条事件
     * （等宿主返回 token 再订阅，早期步骤已经跑完了）。
     */
    const token = 'ui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    tokenRef.current = token;
    setBusy(true);
    setErr(null);
    setRun(null);
    setRb(null);
    setOpenRec(null);
    setLive([]);

    const adapter = getTransportAdapter() as unknown as {
      listen?: <T>(event: string, cb: (data: T) => void) => () => void;
    };
    const unsubs: Array<() => void> = [];
    if (typeof adapter.listen === 'function') {
      unsubs.push(adapter.listen<{ runToken: string; tool: string; ok: boolean; ms?: number; input?: Record<string, unknown> }>(
        'nianchu://agent-step',
        (p) => {
          if (!p || p.runToken !== token) return;
          setLive((cur) => [...cur, { kind: 'tool', tool: p.tool, ok: p.ok, ms: p.ms, input: p.input }]);
        },
      ));
    }

    try {
      const r = await api.invoke<RunResult>('run_task', {
        request: { task: taskText, cwd: cwd.trim() || undefined, maxSteps: 12, runToken: token },
      });
      setRun(r);
    } catch (e) {
      setErr('执行失败：' + String(e instanceof Error ? e.message : e).slice(0, 240));
    } finally {
      for (const u of unsubs) { try { u(); } catch { /* ignore */ } }
      tokenRef.current = null;
      setBusy(false);
    }
  }, [task, cwd, busy]);

  const rollback = useCallback(async () => {
    const id = run?.changeSetId;
    if (!id || busy) return;
    setBusy(true);
    try {
      const r = await api.invoke<RollbackResult>('rollback_change', { request: { changeSetId: id } });
      setRb(r);
    } catch (e) {
      setErr('回滚失败：' + String(e instanceof Error ? e.message : e).slice(0, 240));
    } finally {
      setBusy(false);
    }
  }, [run, busy]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [run, busy]);

  const recs = (run?.transcript || []).filter((x) => x.kind === 'tool');
  // 运行中用实时事件，跑完用完整 transcript（后者带输出）
  const shown = run ? recs : live;
  const unattributed = run?.unattributed ?? [];
  const unattributedCount = run?.unattributedCount ?? 0;
  const files = run?.changeSet?.files || [];
  const rolledBack = rb?.state === 'PASS';

  return (
    <div className="dp">
      <div className="dp__body" ref={bodyRef}>
        {/* ── 工作目录 ── */}
        <section className="dp__section">
          <div className="dp__label">工作目录</div>
          <input
            className="dp__cwd"
            value={cwd}
            spellCheck={false}
            placeholder="留空 = 宿主的当前目录"
            onChange={(e) => setCwd(e.target.value)}
          />
          <div className="dp__note">
            agent 会在这个目录里读写文件、执行命令。改了什么下面能看到，也能一键回滚。
          </div>
        </section>

        {busy && (
          <section className="dp__section">
            <div className="dp__progress">
              <span className="dp__spin" />
              {run ? '正在执行…' : 'agent 正在思考并调用工具…'}
            </div>
          </section>
        )}

        {/* ── 工具过程 ── */}
        {shown.length > 0 && (
          <section className="dp__section">
            <div className="dp__label">
              工具过程
              <span className="dp__count">{shown.length} 次</span>
              {!run && <span className="dp__live">实时</span>}
              {run?.failedToolCalls ? (
                <span className="dp__bad">{run.failedToolCalls} 次失败</span>
              ) : null}
            </div>
            <ol className="dp__tools">
              {shown.map((r, i) => {
                const { head, detail } = describeTool(r);
                const peek = outputPeek(r);
                const isOpen = openRec === i;
                return (
                  <li key={i} className="dp-tool" data-open={isOpen ? '1' : '0'} data-ok={r.ok ? '1' : '0'}>
                    <button
                      type="button"
                      className="dp-tool__head"
                      onClick={() => setOpenRec(isOpen ? null : i)}
                      title={peek || detail}
                    >
                      <span className="dp-tool__dot" data-ok={r.ok ? '1' : '0'} />
                      <span className="dp-tool__name">{head}</span>
                      <span className="dp-tool__detail">{detail}</span>
                      <span className="dp-tool__ms">{r.ms ?? 0}ms</span>
                    </button>
                    {isOpen && peek && <pre className="dp-tool__out">{peek}</pre>}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {/* ── 变更预览 ── */}
        {/* D3 状态可见性：在做什么 / 花了多少 / 为什么停 —— 空闲时也给占位，不藏起来 */}
        <div className="dp__statusbar" data-testid="dp-statusbar">
          <span className="dp__sb-item" data-testid="dp-sb-state">
            状态：{run ? (run.state || 'UNKNOWN') : '空闲'}
          </span>
          <span className="dp__sb-item" data-testid="dp-sb-stop">
            停止原因：{run ? (STOP_LABEL[run.stopReason || ''] || run.stopReason || run.reason || '—') : '—'}
          </span>
          <span className="dp__sb-item" data-testid="dp-sb-usage">
            用量：{run?.usage
              ? String(run.usage.calls ?? 0) + ' 次 · in ' + String(run.usage.input ?? 0) + ' / out ' + String(run.usage.output ?? 0) + ' tokens'
              : '—'}
          </span>
          <span className="dp__sb-item" data-testid="dp-sb-elapsed">
            耗时：{typeof run?.elapsedMs === 'number' ? (Math.round(run.elapsedMs / 100) / 10) + 's' : '—'}
          </span>
          <span className="dp__sb-item dp__sb-trace" data-testid="dp-sb-trace" title={run?.traceId || ''}>
            trace：{run?.traceId ? String(run.traceId).slice(0, 11) : '—'}
          </span>
        </div>

        {run && (
          <section className="dp__section">
            <div className="dp__label">
              变更预览
              {files.length > 0 ? <span className="dp__count">{files.length} 个文件</span> : null}
              {rolledBack ? <span className="dp__rolled">已回滚</span> : null}
            </div>

            {files.length === 0 && (
              <div className="dp__empty-change">这次没有改动任何文件</div>
            )}

            {files.map((f) => (
              <div key={f.path} className="dp-file" data-status={f.status}>
                <div className="dp-file__head">
                  <span className="dp-file__badge" data-status={f.status}>
                    {f.status === 'added' ? '新增' : f.status === 'deleted' ? '删除'
                      : f.status === 'modified' ? '修改' : '跳过'}
                  </span>
                  <span className="dp-file__path" title={f.path}>{f.path}</span>
                  <span className="dp-file__stat">
                    {typeof f.added === 'number' ? <em className="dp-add">+{f.added}</em> : null}
                    {typeof f.removed === 'number' ? <em className="dp-del">-{f.removed}</em> : null}
                  </span>
                </div>
                {f.note && <div className="dp-file__note">{f.note}</div>}
                {f.lines && (
                  <pre className="dp-file__diff">
                    {f.lines.slice(0, 400).map((l, i) => (
                      <div key={i} className="dp-line" data-type={l.type}>
                        <span className="dp-line__sign">
                          {l.type === ' ' ? ' ' : l.type === '!' ? '!' : l.type}
                        </span>
                        <span className="dp-line__text">{l.text || ' '}</span>
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            ))}

            {files.length > 0 && !rolledBack && (
              <button type="button" className="dp__rollback" onClick={() => void rollback()} disabled={busy}>
                回滚这次全部改动
              </button>
            )}

            {rb && (
              <div className="dp__rb" data-state={rb.state}>
                <div className="dp__rb-head">
                  回滚结果：
                  <b style={{ color: STATE_COLOR[rb.state] || '#94a3b8' }}>{rb.state}</b>
                  {rb.reason ? ' · ' + rb.reason : ''}
                </div>
                {(rb.files || []).map((x) => (
                  <div key={x.path} className="dp__rb-row" data-ok={x.ok ? '1' : '0'}>
                    {x.ok ? '✓' : '✗'} {x.action === 'deleted' ? '已删除' : '已恢复'} {x.path}
                    {x.reason ? ' · ' + x.reason : ''}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── 工具之外的改动（bash 等）：回滚不了，但必须让人看见 ── */}
        {unattributedCount > 0 && (
          <section className="dp__section">
            <div className="dp__label">
              工具之外的改动
              <span className="dp__count">{unattributedCount} 个</span>
            </div>
            <div className="dp__unattr-note">
              这些是 bash / 脚本 / git 等直接改的。标「可恢复」的会自动快照原内容，
              回滚按钮能一并还原；标「不可恢复」的（文件过大或超预算）只能手动处理。
            </div>
            <div className="dp__unattr-list">
              {unattributed.map((x) => (
                <div key={x.path} className="dp__unattr-row" data-status={x.status}>
                  <span className="dp__unattr-badge" data-status={x.status}>
                    {x.status === 'created' ? '新建' : x.status === 'deleted' ? '删除' : '修改'}
                  </span>
                  <span className="dp__unattr-path" title={x.path}>{x.path}</span>
                  <span className="dp__unattr-restore" data-ok={x.restorable ? '1' : '0'}>
                    {x.restorable ? '可恢复' : '不可恢复'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── 结论 ── */}
        {run && (
          <section className="dp__section">
            <div className="dp__label">
              结论
              <span className="dp__state" style={{ color: STATE_COLOR[run.state] || '#94a3b8' }}>
                {run.state}
              </span>
            </div>
            {run.finalText && <div className="dp__final">{run.finalText}</div>}
            {run.reason && <div className="dp__reason">{run.reason}</div>}
            {run.usage && (
              <div className="dp__meta">
                {run.usage.calls ?? 0} 次模型调用 · in {run.usage.input ?? 0} / out {run.usage.output ?? 0} tokens
              </div>
            )}
          </section>
        )}

        {!run && !busy && (
          <section className="dp__section dp__section--empty">
            <div className="dp__empty-title">让 agent 真的动手</div>
            <div className="dp__empty-sub">
              它能读文件、改文件、跑命令。改动会先给你看 diff，不满意一键回滚。
            </div>
          </section>
        )}

        {err && <div className="dp__err">{err}</div>}
      </div>

      {/* ── 输入 ── */}
      <div className="dp__compose">
        <div className="dp__box">
          <textarea
            className="dp__input"
            value={task}
            rows={2}
            spellCheck={false}
            placeholder="要它做什么？例如：把 config.json 里的 timeout 改成 30，然后跑一次测试"
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void go();
              }
            }}
          />
          <button
            type="button"
            className="dp__send"
            onClick={() => void go()}
            disabled={!task.trim() || busy}
            title="执行"
            aria-label="执行"
          >
            {busy ? <span className="dp__spin dp__spin--sm" /> : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}