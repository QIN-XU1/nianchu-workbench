// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolSteps } from './ToolSteps';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(steps: React.ComponentProps<typeof ToolSteps>['steps']) {
  act(() => root.render(<ToolSteps steps={steps} />));
}

describe('ToolSteps 竖列', () => {
  it('★步骤位移后，展开态跟着那一条走（不是跟着下标）', () => {
    render([
      { tool: 'read', ok: true, ms: 10, input: { path: 'a.ts' } },
      { tool: 'bash', ok: true, ms: 20, input: { command: 'ls' } },
    ]);
    // 展开第 2 条（bash）
    const before = [...host.querySelectorAll('.ncc-step')];
    act(() => { (before[1] as HTMLDetailsElement).open = true; });
    // 前面插入一条新步骤：下标整体后移
    render([
      { tool: 'glob', ok: true, ms: 5, input: { pattern: '*.ts' } },
      { tool: 'read', ok: true, ms: 10, input: { path: 'a.ts' } },
      { tool: 'bash', ok: true, ms: 20, input: { command: 'ls' } },
    ]);
    const open = [...host.querySelectorAll('.ncc-step')].filter((d) => (d as HTMLDetailsElement).open);
    expect(open).toHaveLength(1);
    expect(open[0].getAttribute('data-tool')).toBe('bash');
  });

  it('★表头摘要 + 序号 + 失败标红', () => {
    render([
      { tool: 'read', ok: true, ms: 120, input: { path: 'a.ts' } },
      { tool: 'bash', ok: false, ms: 80, input: { command: 'rm -rf /' } },
      { tool: 'todo_write', ok: true, ms: 1, input: {} },
    ]);
    expect(host.querySelector('.ncc-steps__head')?.textContent).toBe('工具调用 · 2 步 · 1 失败 · 共 200ms');
    const idx = [...host.querySelectorAll('.ncc-step__idx')].map((x) => x.textContent);
    expect(idx).toEqual(['1', '2']);
    const rows = [...host.querySelectorAll('.ncc-step')];
    expect(rows.map((r) => r.getAttribute('data-ok'))).toEqual(['1', '0']);
  });

  it('★todo_write 被过滤，不占序号', () => {
    render([
      { tool: 'todo_write', ok: true, input: {} },
      { tool: 'read', ok: true, input: { path: 'b.ts' } },
    ]);
    expect([...host.querySelectorAll('.ncc-step__tool')].map((x) => x.textContent)).toEqual(['read']);
  });

  it('参数按 path/command 优先展示', () => {
    render([{ tool: 'read', ok: true, input: { path: 'src/index.ts' } }]);
    expect(host.querySelector('.ncc-step__arg')?.textContent).toBe('src/index.ts');
  });

  it('★命令风险徽标只在能判定时出现（rm -rf 高危）', () => {
    render([{ tool: 'bash', ok: true, input: { command: 'rm -rf /' } }]);
    const risk = host.querySelector('.ncc-step__risk');
    expect(risk).not.toBeNull();
    expect(risk?.getAttribute('data-risk')).toBeTruthy();
    expect(risk?.getAttribute('title')).toContain('：');
  });

  it('普通读文件不出现风险徽标', () => {
    render([{ tool: 'read', ok: true, input: { path: 'a.ts' } }]);
    expect(host.querySelector('.ncc-step__risk')).toBeNull();
  });

  it('★空步骤 / 全是 todo_write → 不渲染任何东西', () => {
    render([]);
    expect(host.querySelector('.ncc-steps')).toBeNull();
    render([{ tool: 'todo_write', ok: true, input: {} }]);
    expect(host.querySelector('.ncc-steps')).toBeNull();
  });

  it('子代理卡片下钻：展开内部工具清单', () => {
    render([{
      tool: 'spawn_subagent',
      ok: true,
      input: { task: '检查一下' },
      output: {
        summary: '子代理完成',
        innerSteps: [
          { tool: 'read', ok: true, ms: 30 },
          { tool: 'grep', ok: false, ms: 12 },
        ],
      },
    }]);
    expect(host.querySelector('[data-testid="ncc-sub-drill"]')).not.toBeNull();
    expect(host.textContent).toContain('子代理内部工具 2 次');
    expect(host.querySelectorAll('.ncc-sub__step')).toHaveLength(2);
  });
});
