import { describe, it, expect } from 'vitest';
import {
  validateMemory,
  validateProjectMemory,
  buildSkeleton,
  extractSection0,
  countBullets,
  byteLength,
  MEMORY_LIMITS,
} from './memoryEngine';

/** 反例验收：校验器必须「该失败时真的失败」，不能永远通过。 */
describe('memoryEngine · 场景记忆校验（含反例）', () => {
  it('生成的骨架应当通过校验', () => {
    const r = validateMemory(buildSkeleton('调研'));
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('反例1：缺 §〇 必须失败', () => {
    const t = buildSkeleton('X').replace(/## §〇[\s\S]*?(?=## §一)/, '');
    const r = validateMemory(t);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_section0')).toBe(true);
  });

  it('反例2：核心职责 <3 条必须失败', () => {
    const t = buildSkeleton('X').replace(
      /## 核心职责（≥3 条）\n(- .*\n)+/,
      '## 核心职责（≥3 条）\n- 只负责一件\n',
    );
    const r = validateMemory(t);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'core_duty_lt3')).toBe(true);
  });

  it('反例3：§〇 超 4KB 必须失败', () => {
    const t = buildSkeleton('X').replace('### 1) 上次交接\n', '### 1) 上次交接\n' + 'x'.repeat(5000) + '\n');
    const r = validateMemory(t);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'section0_too_large')).toBe(true);
  });

  it('反例4：§〇 缺五小节之一必须失败', () => {
    const t = buildSkeleton('X').replace('### 3) 私有记忆变更\n', '');
    const r = validateMemory(t);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'section0_missing_sub')).toBe(true);
  });

  it('主文件超 25KB 只告警不阻断', () => {
    const t = buildSkeleton('X') + 'y'.repeat(MEMORY_LIMITS.main + 10);
    const r = validateMemory(t);
    expect(r.ok).toBe(true); // 无 error
    expect(r.issues.some((i) => i.code === 'main_too_large' && i.level === 'warn')).toBe(true);
  });

  it('extractSection0 能取到且不越到下一个 ##', () => {
    const s0 = extractSection0(buildSkeleton('X'))!;
    expect(s0).toContain('### 1) 上次交接');
    expect(s0).not.toContain('## §一');
  });

  it('countBullets 正确计数', () => {
    expect(countBullets('- a\n- b\n- c\n  缩进\n')).toBe(3);
  });

  it('项目记忆超 8KB 必须失败', () => {
    const r = validateProjectMemory('状态：进行中\n一句话：x\n下一步：y\n'.repeat(1000));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'project_too_large')).toBe(true);
  });

  it('byteLength 按 UTF-8 计（中文 3 字节）', () => {
    expect(byteLength('中')).toBe(3);
  });
});
