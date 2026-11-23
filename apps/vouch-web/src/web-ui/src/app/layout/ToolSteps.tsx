import { classifyToolRisk, TOOL_RISK_LABEL } from './toolRisk';
import { buildSubagentView } from './subagentView';
import { stepsSummaryLabel } from './stepsSummary';
import { stepArgText, stepKey, stepOutputText, type ToolStep } from './stepText';

/**
 * 工具调用竖列（批次 Z.14，对标 dsh-claude-style 的 process-column）。
 *
 * 每条都是 run_task 真实执行过的步骤：序号 + 圆点 + 工具名 + 风险徽标 + 参数 + 耗时，
 * 折叠展开看完整输出；失败如实标红。todo_write 已由上面的计划面板翻译成人话，这里不再重复。
 *
 * key 由内容决定（批次 Z.24）：下标当 key 时，步骤位移会让 `<details>` 的展开态错位，
 * 用户点开的是 bash、列表一变展开框里却成了 read。
 */
export function ToolSteps({ steps }: { steps: ToolStep[] }) {
  const shown = steps.filter((s) => s.tool !== 'todo_write');
  if (shown.length === 0) return null;
  const label = stepsSummaryLabel(shown);
  const seen = new Map<string, number>();
  const rows = shown.map((s, i) => {
    const base = stepKey(s);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { s, i, key: base + '#' + n };
  });
  return (
    <div className="ncc-steps" aria-label="工具调用记录">
      {label ? <div className="ncc-steps__head">{label}</div> : null}
      {rows.map(({ s, i, key }) => (
        <details key={key} className="ncc-step" data-ok={s.ok === false ? '0' : '1'} data-tool={s.tool || ''}>
          <summary className="ncc-step__sum">
            <span className="ncc-step__dot" aria-hidden="true" />
            <span className="ncc-step__idx" aria-hidden="true">{i + 1}</span>
            {/* 子代理单独标出来：它内部是一个完整的小循环，不是普通工具 */}
            <span className="ncc-step__tool">
              {s.tool === 'spawn_subagent' ? '子代理' : (s.tool || 'tool')}
            </span>
            {/*
              命令风险徽标：只在**能判定**时显示（非命令类工具 / 未知命令一律不显示）。
              三重编码（符号 + 文字 + 颜色），title 说明命中的是哪条规则 ——
              只写「高风险」等于让用户自己再猜一遍。
            */}
            {(() => {
              const risk = classifyToolRisk(s.tool, s.input);
              return risk ? (
                <span
                  className={'ncc-step__risk ncc-step__risk--' + risk.level}
                  data-risk={risk.level}
                  data-risk-rule={risk.rule}
                  title={risk.rule + '：' + risk.reason}
                >
                  {TOOL_RISK_LABEL[risk.level]}
                </span>
              ) : null;
            })()}
            <span className="ncc-step__arg">{stepArgText(s.input)}</span>
            <span className="ncc-step__ms">{typeof s.ms === 'number' ? s.ms + 'ms' : ''}</span>
          </summary>
          {/*
            子代理卡片「下钻」：把子代理内部的工具调用摊开（工具名 + 成败 + 耗时）。
            只给清单，不给子代理每一步的完整输出 —— 父上下文不装子代理的中间产物。
            老数据没有 innerSteps 时退回原来的 JSON，不造假。
          */}
          {s.tool === 'spawn_subagent' ? (() => {
            const sv = buildSubagentView(s.output);
            if (!sv) return <pre className="ncc-step__out">{stepOutputText(s.output)}</pre>;
            return (
              <div className="ncc-sub" data-testid="ncc-sub-drill">
                {sv.summary && <p className="ncc-sub__summary">{sv.summary}</p>}
                {sv.steps.length > 0 && (
                  <>
                    <div className="ncc-sub__meta">
                      子代理内部工具 {sv.totalCalls} 次（成功 {sv.okCount} · 失败 {sv.failCount}）
                      {sv.truncated ? '，仅展开前 ' + sv.steps.length + ' 条' : ''}
                    </div>
                    <ol className="ncc-sub__steps">
                      {sv.steps.map((st, j) => (
                        <li key={j} className="ncc-sub__step" data-ok={st.ok ? '1' : '0'}>
                          <span className="ncc-sub__dot" aria-hidden="true" />
                          <span className="ncc-sub__tool">{st.tool}</span>
                          <span className="ncc-sub__ms">{st.ms !== null ? st.ms + 'ms' : ''}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            );
          })() : <pre className="ncc-step__out">{stepOutputText(s.output)}</pre>}
        </details>
      ))}
    </div>
  );
}
