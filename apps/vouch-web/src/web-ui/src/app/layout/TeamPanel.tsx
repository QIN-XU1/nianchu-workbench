import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/infrastructure/api';
import './TeamPanel.scss';

/**
 * 多智能体协同面板。
 *
 * 显示三件事（都是宿主真实返回，不编）：
 *   ① 花名册：有哪几个 agent、各自负责什么
 *   ② 逐阶段过程：规划 → 执行（可并行）→ 审阅 →（不合格则）修复 → 复审
 *   ③ 结果：四态 + 审阅判定 + 修复轮数 + 真实 token 用量
 *
 * 设计取向：过程比结论重要。用户要能看出「谁做的、谁审的、审出了什么」，
 * 而不是只得到一个绿勾。
 */
type AgentRow = { id: string; name: string; role: string; promptHint?: string };

type Step = {
  stage: 'plan' | 'work' | 'review' | 'fix';
  agentId?: string;
  assignee?: string;
  title?: string;
  state: string;
  content?: string;
  reason?: string;
  truncated?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  toolCalls?: number;
  failedToolCalls?: number;
  toolTranscript?: Array<{
    kind: string; tool?: string; ok?: boolean; ms?: number;
    input?: Record<string, unknown>; output?: Record<string, unknown>;
  }>;
};

type RunResult = {
  state: string;
  runId?: string;
  verdict?: string;
  roundsUsed?: number;
  reason?: string;
  steps?: Step[];
  authors?: string[];
  reviewRequested?: boolean;
  usage?: { calls?: number; input?: number; output?: number };
};

const STAGE_LABEL: Record<string, string> = {
  plan: '规划', work: '执行', review: '审阅', fix: '修复',
};

const STATE_COLOR: Record<string, string> = {
  PASS: '#22c55e', WARN: '#f59e0b', FAIL: '#ef4444', UNKNOWN: '#94a3b8',
};

export default function TeamPanel() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const rows = await api.invoke<AgentRow[]>('list_agents', {});
        if (!dead && Array.isArray(rows)) setAgents(rows);
      } catch (e) {
        if (!dead) setErr('拿不到花名册：' + String(e instanceof Error ? e.message : e).slice(0, 160));
      }
    })();
    return () => { dead = true; };
  }, []);

  const go = useCallback(async () => {
    const objectiveText = objective.trim();
    if (!objectiveText || busy) return;
    setBusy(true);
    setErr(null);
    setRun(null);
    setOpenStep(null);
    try {
      const r = await api.invoke<RunResult>('run_team', {
        request: {
          objective: objectiveText,
          maxRounds: 2,
          // 给执行类 agent 真工具：协同产出不再只是文字方案，实现者会真的改文件
          tools: ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'remember', 'recall'],
        },
      });
      setRun(r);
    } catch (e) {
      setErr('协同失败：' + String(e instanceof Error ? e.message : e).slice(0, 220));
    } finally {
      setBusy(false);
    }
  }, [objective, busy]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [run, busy]);

  const steps = run?.steps ?? [];

  return (
    <div className="tm">
      <div className="tm__body" ref={bodyRef}>
        {/* ── 花名册 ── */}
        <section className="tm__section">
          <div className="tm__label">团队 · {agents.length} 个智能体</div>
          <div className="tm__roster">
            {agents.map((a) => (
              <div key={a.id} className="tm-agent" data-agent={a.id} title={a.promptHint}>
                <span className="tm-agent__dot" />
                <span className="tm-agent__name">{a.name}</span>
                <span className="tm-agent__role">{a.role}</span>
              </div>
            ))}
            {agents.length === 0 && !err && <div className="tm__hint">正在读取花名册…</div>}
          </div>
          <div className="tm__note">
            审阅者不是实现者 —— 独立性是硬约束，代码里强制。
          </div>
        </section>

        {/* ── 过程 ── */}
        {busy && (
          <section className="tm__section">
            <div className="tm__label">进行中</div>
            <div className="tm__progress">
              <span className="tm__spin" />
              规划者正在拆解，随后调研/实现并行执行，再由审阅者独立复审…
            </div>
          </section>
        )}

        {run && (
          <section className="tm__section">
            <div className="tm__label">
              过程
              <span className="tm__verdict" style={{ color: STATE_COLOR[run.state] || '#94a3b8' }}>
                {run.state}
              </span>
              {run.roundsUsed ? <span className="tm__rounds">{run.roundsUsed} 轮</span> : null}
            </div>

            <ol className="tm__steps">
              {steps.map((s, i) => {
                const who = s.agentId || s.assignee || '';
                const label = STAGE_LABEL[s.stage] || s.stage;
                const isOpen = openStep === i;
                return (
                  <li key={i} className="tm-step" data-stage={s.stage} data-open={isOpen ? '1' : '0'}>
                    <button
                      type="button"
                      className="tm-step__head"
                      onClick={() => setOpenStep(isOpen ? null : i)}
                      title={s.content ? '点击查看产出' : '没有产出内容'}
                    >
                      <span className="tm-step__badge" data-stage={s.stage}>{label}</span>
                      <span className="tm-step__who">{who}</span>
                      {s.title && <span className="tm-step__title">{s.title}</span>}
                      {s.truncated && <span className="tm-step__warn" title="输出被 token 上限截断">截断</span>}
                      {s.toolCalls ? (
                        <span className="tm-step__tools" title={'工具调用 ' + s.toolCalls + ' 次'
                          + (s.failedToolCalls ? '，失败 ' + s.failedToolCalls + ' 次' : '')}>
                          {s.toolCalls} 工具{s.failedToolCalls ? ' / ' + s.failedToolCalls + ' 失败' : ''}
                        </span>
                      ) : null}
                      <span className="tm-step__state" style={{ color: STATE_COLOR[s.state] || '#94a3b8' }}>
                        {s.state}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="tm-step__content">
                        {s.content
                          ? s.content.slice(0, 4000)
                          : (s.reason || '（这一步没有文本产出）')}
                        {/* 工具执行证据：审阅者看到的就是这些，人也该看到 */}
                        {Array.isArray(s.toolTranscript) && s.toolTranscript.filter((x) => x.kind === 'tool').length > 0 && (
                          <div className="tm-step__tools-list">
                            {s.toolTranscript.filter((x) => x.kind === 'tool').slice(0, 20).map((x, k) => (
                              <div key={k} className="tm-tool" data-ok={x.ok ? '1' : '0'}>
                                <span className="tm-tool__mark">{x.ok ? '✓' : '✗'}</span>
                                <span className="tm-tool__name">{x.tool}</span>
                                <span className="tm-tool__inp">
                                  {JSON.stringify(x.input || {}).slice(0, 80)}
                                </span>
                                <span className="tm-tool__ms">{x.ms ?? 0}ms</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {s.usage && (
                          <div className="tm-step__usage">
                            in {s.usage.prompt_tokens ?? '?'} / out {s.usage.completion_tokens ?? '?'}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>

            {run.reason && <div className="tm__reason">{run.reason}</div>}

            {run.usage && (
              <div className="tm__meta">
                {run.usage.calls ?? 0} 次模型调用 · in {run.usage.input ?? 0} / out {run.usage.output ?? 0} tokens
                {run.verdict ? ' · 审阅 ' + run.verdict : ''}
              </div>
            )}
          </section>
        )}

        {!run && !busy && (
          <section className="tm__section tm__section--empty">
            <div className="tm__empty-title">让一群 agent 一起做一件事</div>
            <div className="tm__empty-sub">
              规划者拆解 → 调研员与实现者执行 → 审阅者独立挑错 → 不合格就返工重审
            </div>
          </section>
        )}

        {err && <div className="tm__err">{err}</div>}
      </div>

      {/* ── 输入 ── */}
      <div className="tm__compose">
        <div className="tm__box">
          <textarea
            className="tm__input"
            value={objective}
            rows={2}
            spellCheck={false}
            placeholder="写一个目标，交给团队去做"
            onChange={(e) => setObjective(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void go();
              }
            }}
          />
          <button
            type="button"
            className="tm__send"
            onClick={() => void go()}
            disabled={!objective.trim() || busy}
            title="开始协同"
            aria-label="开始协同"
          >
            {busy ? <span className="tm__spin tm__spin--sm" /> : (
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