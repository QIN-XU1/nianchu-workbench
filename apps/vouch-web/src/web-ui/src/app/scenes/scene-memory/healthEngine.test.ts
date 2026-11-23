import { describe, it, expect } from 'vitest';
import {
  combineHealth,
  memoryPart,
  projectMemoryPart,
  fingerprintPart,
  indexPart,
  sceneHealth,
} from './healthEngine';
import { buildSkeleton } from './memoryEngine';
import type { HealthPart } from './healthEngine';

/**
 * 场景健康检查反例验收。
 * 重点盯：**判不了绝不许被平均成通过**、**最坏的一项决定整体**。
 */

const P = (v: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN', id: HealthPart['id'] = 'memory'): HealthPart => ({
  id, label: id, verdict: v, detail: '',
});

describe('combineHealth —— 合成规则', () => {
  it('全部 PASS => PASS', () => {
    expect(combineHealth([P('PASS', 'memory'), P('PASS', 'fingerprint'), P('PASS', 'index')]).verdict).toBe('PASS');
  });

  it('反例：任一项 FAIL => FAIL（最坏的决定整体）', () => {
    expect(combineHealth([P('PASS'), P('FAIL', 'index')]).verdict).toBe('FAIL');
  });

  it('反例：任一项 UNKNOWN => UNKNOWN（判不了不许平均成通过）', () => {
    expect(combineHealth([P('PASS'), P('UNKNOWN', 'index')]).verdict).toBe('UNKNOWN');
  });

  it('反例：UNKNOWN 优先于 WARN（判不了比待补更该被看见）', () => {
    expect(combineHealth([P('WARN'), P('UNKNOWN', 'index')]).verdict).toBe('UNKNOWN');
  });

  it('FAIL 优先于 UNKNOWN', () => {
    expect(combineHealth([P('UNKNOWN'), P('FAIL', 'index')]).verdict).toBe('FAIL');
  });

  it('反例：一项都没有 => UNKNOWN（不是 PASS）', () => {
    expect(combineHealth([]).verdict).toBe('UNKNOWN');
  });

  it('blockers 按严重度排序（FAIL 在 UNKNOWN 前）', () => {
    const r = combineHealth([P('UNKNOWN', 'memory'), P('FAIL', 'index'), P('PASS', 'fingerprint')]);
    expect(r.blockers.map((b) => b.verdict)).toEqual(['FAIL', 'UNKNOWN']);
  });

  it('可复算：同输入两次一致', () => {
    const parts = [P('PASS'), P('WARN', 'index')];
    expect(JSON.stringify(combineHealth(parts))).toBe(JSON.stringify(combineHealth(parts)));
  });
});

describe('memoryPart', () => {
  it('反例：空文本 => UNKNOWN（不是 PASS）', () => {
    expect(memoryPart('').verdict).toBe('UNKNOWN');
  });

  it('反例：只有空白 => UNKNOWN', () => {
    expect(memoryPart('   \n\t ').verdict).toBe('UNKNOWN');
  });

  it('正例：引擎自己的骨架 => PASS', () => {
    // 用手写骨架容易漏项（我第一版就漏了）—— 直接用引擎的权威骨架
    const ok = buildSkeleton('健康检查');
    expect(memoryPart(ok).verdict).toBe('PASS');
  });

  it('反例：缺 §〇 交接 => 不是 PASS', () => {
    expect(memoryPart('# 场景\n## 核心职责\n- 负责：a\n- 负责：b\n- 不碰：c').verdict).not.toBe('PASS');
  });
});

describe('projectMemoryPart', () => {
  it('反例：空文本 => UNKNOWN', () => {
    expect(projectMemoryPart('').verdict).toBe('UNKNOWN');
  });
});

describe('fingerprintPart', () => {
  it('反例：定位卡为空 => UNKNOWN（判不了）', () => {
    expect(fingerprintPart({ ctxCard: '', idCard: 'sha256:0123456789abcdef', computed: 'sha256:0123456789abcdef' }).verdict).toBe('UNKNOWN');
  });

  it('反例：身份卡为空 => UNKNOWN', () => {
    expect(fingerprintPart({ ctxCard: 'x', idCard: '', computed: 'sha256:0123456789abcdef' }).verdict).toBe('UNKNOWN');
  });

  it('反例：身份卡里没有登记指纹 => FAIL', () => {
    expect(fingerprintPart({ ctxCard: 'x', idCard: '无指纹', computed: 'sha256:0123456789abcdef' }).verdict).toBe('FAIL');
  });

  it('反例：还没算出指纹 => UNKNOWN（不是 PASS）', () => {
    expect(fingerprintPart({ ctxCard: 'x', idCard: 'sha256:0123456789abcdef', computed: null }).verdict).toBe('UNKNOWN');
  });

  it('反例：登记 ≠ 当前 => FAIL（卡改过要跑 stamp）', () => {
    expect(fingerprintPart({ ctxCard: 'x', idCard: 'sha256:aaaaaaaaaaaaaaaa', computed: 'sha256:bbbbbbbbbbbbbbbb' }).verdict).toBe('FAIL');
  });

  it('正例：登记 = 当前 => PASS', () => {
    expect(fingerprintPart({ ctxCard: 'x', idCard: 'sha256:0123456789abcdef', computed: 'sha256:0123456789abcdef' }).verdict).toBe('PASS');
  });
});

describe('indexPart', () => {
  const good = {
    sceneId: 'a', panelId: 'b', panelTitle: 'c', sessionTitle: 'd',
    sessionId: 'e', contextCard: 'f', mainSkill: '—',
  };

  it('反例：零行 => UNKNOWN（不是 PASS）', () => {
    expect(indexPart([]).verdict).toBe('UNKNOWN');
  });

  it('正例：一行齐全 => PASS', () => {
    expect(indexPart([good]).verdict).toBe('PASS');
  });

  it('反例：任一行缺列 => FAIL', () => {
    expect(indexPart([good, { ...good, sessionId: '' }]).verdict).toBe('FAIL');
  });

  it('可复算', () => {
    expect(indexPart([good]).verdict).toBe(indexPart([good]).verdict);
  });
});

describe('sceneHealth —— 端到端合成', () => {
  const good = {
    sceneId: 'a', panelId: 'b', panelTitle: 'c', sessionTitle: 'd',
    sessionId: 'e', contextCard: 'f', mainSkill: '—',
  };
  const okMemory = buildSkeleton('健康检查');

  it('反例：三项都空 => UNKNOWN（绝不 PASS）', () => {
    const r = sceneHealth({
      memoryText: '', ctxCard: '', idCard: '', computedFingerprint: null, indexRows: [],
    });
    expect(r.verdict).toBe('UNKNOWN');
  });

  it('反例：记忆 PASS 但索引空 => UNKNOWN（不许被记忆的 PASS 掩盖）', () => {
    const r = sceneHealth({
      memoryText: okMemory, ctxCard: 'x', idCard: 'sha256:0123456789abcdef',
      computedFingerprint: 'sha256:0123456789abcdef', indexRows: [],
    });
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.blockers.some((b) => b.id === 'index')).toBe(true);
  });

  it('正例：三项都过 => PASS', () => {
    const r = sceneHealth({
      memoryText: okMemory, ctxCard: 'x', idCard: 'sha256:0123456789abcdef',
      computedFingerprint: 'sha256:0123456789abcdef', indexRows: [good],
    });
    expect(r.verdict).toBe('PASS');
    expect(r.blockers.length).toBe(0);
  });

  it('反例：指纹不一致 => FAIL（即使其他都过）', () => {
    const r = sceneHealth({
      memoryText: okMemory, ctxCard: 'x', idCard: 'sha256:aaaaaaaaaaaaaaaa',
      computedFingerprint: 'sha256:bbbbbbbbbbbbbbbb', indexRows: [good],
    });
    expect(r.verdict).toBe('FAIL');
  });
});
