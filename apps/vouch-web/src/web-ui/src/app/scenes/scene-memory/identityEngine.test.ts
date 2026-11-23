import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  cardFingerprint,
  extractFingerprint,
  verifyCardFingerprint,
  validateIndexRow,
  buildIdentityCard,
  tableVerdictOf,
} from './identityEngine';

/** 身份机制反例验收：指纹过期 / 缺列 必须被检出。 */
describe('identityEngine · 身份卡指纹 + 身份索引', () => {
  it('sha256 定长 64 hex、可复现', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('卡指纹格式 sha256:16hex', async () => {
    const fp = await cardFingerprint('定位卡内容');
    expect(fp).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('身份卡与当前定位卡一致 ⇒ 通过', async () => {
    const card = '定位卡内容 v1';
    const idCard = await buildIdentityCard({
      sceneId: 'research', panelId: 'p1', sessionId: 'session-abc',
      contextCardPath: 'scenarios/research-context.md', contextCardText: card, skills: 'research', panels: ['p1'],
    });
    const r = await verifyCardFingerprint(idCard, card);
    expect(r.ok).toBe(true);
  });

  it('反例1：定位卡改了却没 stamp ⇒ 指纹过期必须失败', async () => {
    const card = '定位卡内容 v1';
    const idCard = await buildIdentityCard({
      sceneId: 'research', panelId: 'p1', sessionId: 'session-abc',
      contextCardPath: 'scenarios/research-context.md', contextCardText: card, skills: 'research', panels: ['p1'],
    });
    const r = await verifyCardFingerprint(idCard, '定位卡内容 v2 改了'); // 卡变了
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'fingerprint_expired')).toBe(true);
  });

  it('反例2：身份卡没有指纹 ⇒ 失败', async () => {
    const r = await verifyCardFingerprint('一张没有指纹的卡', '任意');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'no_fingerprint')).toBe(true);
  });

  it('extractFingerprint 抽取正确', async () => {
    const card = '定位卡内容 v1';
    const idCard = await buildIdentityCard({
      sceneId: 's', panelId: 'p', sessionId: 'sid', contextCardPath: 'c.md', contextCardText: card, skills: '—', panels: [],
    });
    expect(extractFingerprint(idCard)).toBe(await cardFingerprint(card));
  });

  it('身份索引 7 列齐 ⇒ 通过', () => {
    const r = validateIndexRow({
      sceneId: 'research', panelId: 'p1', panelTitle: '调研', sessionTitle: '调研会话',
      sessionId: 'session-abc', contextCard: 'scenarios/research-context.md', mainSkill: 'research',
    });
    expect(r.ok).toBe(true);
  });

  it('反例3：身份索引缺 sessionId ⇒ 失败', () => {
    const r = validateIndexRow({
      sceneId: 'research', panelId: 'p1', panelTitle: '调研', sessionTitle: '调研会话',
      sessionId: '', contextCard: 'c.md', mainSkill: '—',
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_col')).toBe(true);
  });
});

describe('tableVerdictOf —— 索引表格整体判定', () => {
  it('一行都没有 => UNKNOWN（没数据不等于通过）', () => {
    expect(tableVerdictOf([])).toBe('UNKNOWN');
  });
  it('全 PASS => PASS', () => {
    expect(tableVerdictOf(['PASS', 'PASS'])).toBe('PASS');
  });
  it('反例：任一行 FAIL => FAIL（脏数据不许被平均掉）', () => {
    expect(tableVerdictOf(['PASS', 'FAIL', 'PASS'])).toBe('FAIL');
  });
  it('反例：任一行 WARN => WARN', () => {
    expect(tableVerdictOf(['PASS', 'WARN'])).toBe('WARN');
  });
  it('FAIL 优先于 WARN', () => {
    expect(tableVerdictOf(['WARN', 'FAIL'])).toBe('FAIL');
  });
  it('反例：任一行 UNKNOWN => UNKNOWN（判不了不许并入通过）', () => {
    expect(tableVerdictOf(['PASS', 'UNKNOWN'])).toBe('UNKNOWN');
  });
  it('反例：非数组输入不崩，判 UNKNOWN', () => {
    expect(tableVerdictOf(null as unknown as [])).toBe('UNKNOWN');
  });
  it('可复算：同输入两次一致', () => {
    const v: ('PASS' | 'FAIL')[] = ['PASS', 'FAIL'];
    expect(tableVerdictOf(v)).toBe(tableVerdictOf(v));
  });
});