import { describe, expect, it } from 'vitest';
import {
  buildContextUsageView,
  CTX_CELLS,
  CTX_DANGER_RATIO,
  CTX_WARN_RATIO,
  formatDropped,
  formatPercent,
  formatTokens,
  MEMORY_VIEW_MAX,
  resolveContextUsage,
  resolveMemoryView,
} from './contextUsageView';

describe('resolveContextUsage', () => {
  it('取最近一条带 context 的消息（而不是最早的一条）', () => {
    const usage = resolveContextUsage([
      { context: { historyTokens: 999, historyBudget: 1000 } },
      { context: null },
      { context: { historyTokens: 200, historyBudget: 1000, historyDropped: 3 } },
    ]);
    expect(usage).toEqual({ tokens: 200, budget: 1000, dropped: 3 });
  });

  it('没有有效 context 时返回 null（宁可不渲染，也不显示 0/6000 的假监控）', () => {
    expect(resolveContextUsage([])).toBeNull();
    expect(resolveContextUsage([{}, { context: null }])).toBeNull();
    expect(
      resolveContextUsage([{ context: { historyTokens: 100 } }]),
    ).toBeNull();
  });

  it('跳过脏数据：NaN / 非数字 / 预算 <= 0', () => {
    const dirty = [
      { context: { historyTokens: Number.NaN, historyBudget: 1000 } },
      { context: { historyTokens: 100, historyBudget: 0 } },
      { context: { historyTokens: 100, historyBudget: -5 } },
      // 前面全是脏的，只能回退到这条干净的
      { context: { historyTokens: 50, historyBudget: 1000 } },
    ];
    expect(resolveContextUsage(dirty)).toEqual({ tokens: 50, budget: 1000, dropped: 0 });
  });

  it('把负数/小数 drop 值规整成非负整数', () => {
    expect(
      resolveContextUsage([{ context: { historyTokens: 10, historyBudget: 100, historyDropped: -4 } }])
        ?.dropped,
    ).toBe(0);
    expect(
      resolveContextUsage([{ context: { historyTokens: 10, historyBudget: 100, historyDropped: 2.9 } }])
        ?.dropped,
    ).toBe(2);
  });
});

describe('buildContextUsageView', () => {
  const view = (tokens: number, budget = 1000, dropped = 0) =>
    buildContextUsageView({ tokens, budget, dropped });

  it('null 进 null 出', () => {
    expect(buildContextUsageView(null)).toBeNull();
  });

  it('ratio 被 clamp 在 0..1（超预算不会点亮超过 20 格）', () => {
    expect(view(0)!.ratio).toBe(0);
    expect(view(500)!.ratio).toBeCloseTo(0.5);
    expect(view(9999)!.ratio).toBe(1);
  });

  it('用了就至少亮 1 格（刚过 1% 不能看起来像 0）', () => {
    expect(view(1)!.lit).toBe(1);
    expect(view(0)!.lit).toBe(0);
  });

  it('满值恰好点亮全部格子', () => {
    expect(view(1000)!.lit).toBe(CTX_CELLS);
    expect(view(9999)!.lit).toBe(CTX_CELLS);
  });

  it('lit 与 ratio 单调不减（不会出现「用得多反而亮得少」）', () => {
    let prev = 0;
    for (let pct = 0; pct <= 100; pct++) {
      const lit = view(pct * 10)!.lit;
      expect(lit).toBeGreaterThanOrEqual(prev);
      prev = lit;
    }
  });

  it('三档阈值：ok < 70% <= warn < 90% <= danger', () => {
    expect(view(0)!.level).toBe('ok');
    expect(view(699)!.level).toBe('ok');
    expect(view(700)!.level).toBe('warn');
    expect(view(899)!.level).toBe('warn');
    expect(view(900)!.level).toBe('danger');
    expect(view(1000)!.level).toBe('danger');
    expect(CTX_WARN_RATIO).toBe(0.7);
    expect(CTX_DANGER_RATIO).toBe(0.9);
  });
});

describe('文案格式化', () => {
  it('token 数按千分位', () => {
    expect(formatTokens(2529)).toBe('2,529');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1234567)).toBe('1,234,567');
  });

  it('百分比取整', () => {
    expect(formatPercent(0.4217)).toBe(42);
    expect(formatPercent(1)).toBe(100);
  });

  it('没有省略时不产出文案（避免末尾挂一个空分隔符）', () => {
    expect(formatDropped(0)).toBe('');
    expect(formatDropped(7)).toBe(' · 省略 7 条');
  });
});

describe('resolveMemoryView · 记忆命中看板', () => {
  it('没有任何带 memoryHits 的 context → null（界面不渲染假面板）', () => {
    expect(resolveMemoryView([{ context: null }])).toBeNull();
    expect(resolveMemoryView([{ context: { historyTokens: 1, historyBudget: 10 } }])).toBeNull();
  });

  it('命中 0 条 → count=0（界面据此隐藏，不显示「命中 0 条」）', () => {
    const v = resolveMemoryView([{ context: { memoryHits: 0, memoryHitItems: [] } }]);
    expect(v?.count).toBe(0);
    expect(v?.items).toEqual([]);
  });

  it('命中数与明细都落盘 → 完整展开', () => {
    const v = resolveMemoryView([{
      context: { memoryHits: 2, memoryHitItems: [{ key: 'db.host', preview: '127.0.0.1' }, { key: 'build.cmd', preview: 'vite build' }] },
    }]);
    expect(v).toEqual({ count: 2, items: [{ key: 'db.host', preview: '127.0.0.1' }, { key: 'build.cmd', preview: 'vite build' }], truncated: false });
  });

  it('★取最近一条（新消息覆盖旧消息）', () => {
    const v = resolveMemoryView([
      { context: { memoryHits: 5, memoryHitItems: [{ key: 'old', preview: '' }] } },
      { context: { memoryHits: 1, memoryHitItems: [{ key: 'new', preview: '' }] } },
    ]);
    expect(v?.count).toBe(1);
    expect(v?.items[0].key).toBe('new');
  });

  it('★count 大于已落盘明细 → truncated=true（如实说还有没展开的）', () => {
    const v = resolveMemoryView([{ context: { memoryHits: 9, memoryHitItems: [{ key: 'a', preview: '' }] } }]);
    expect(v?.truncated).toBe(true);
    expect(v?.count).toBe(9);
    expect(v?.items).toHaveLength(1);
  });

  it('明细超过上限只取 MEMORY_VIEW_MAX 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ key: 'k' + i, preview: 'v' + i }));
    const v = resolveMemoryView([{ context: { memoryHits: 10, memoryHitItems: many } }]);
    expect(v?.items).toHaveLength(MEMORY_VIEW_MAX);
    expect(v?.truncated).toBe(true);
  });

  it('脏明细（缺 key / 非字符串）跳过，不当成一条', () => {
    const v = resolveMemoryView([{
      context: { memoryHits: 2, memoryHitItems: [{ key: '', preview: 'x' }, { preview: 'y' }, null, { key: 'ok', preview: 'z' }] },
    }]);
    expect(v?.items).toEqual([{ key: 'ok', preview: 'z' }]);
  });

  it('预览超过 80 字截断', () => {
    const v = resolveMemoryView([{ context: { memoryHits: 1, memoryHitItems: [{ key: 'k', preview: 'x'.repeat(200) }] } }]);
    expect(v?.items[0].preview).toHaveLength(80);
  });

  it('memoryHits 是负数 → 钳到 0', () => {
    const v = resolveMemoryView([{ context: { memoryHits: -3, memoryHitItems: [] } }]);
    expect(v?.count).toBe(0);
  });

  it('★memoryHits 非数字（脏数据）→ 跳过该条，继续往前找', () => {
    const v = resolveMemoryView([
      { context: { memoryHits: 1, memoryHitItems: [{ key: 'good', preview: '' }] } },
      { context: { memoryHits: '3' as unknown as number, memoryHitItems: [] } },
    ]);
    expect(v?.items[0].key).toBe('good');
  });
});