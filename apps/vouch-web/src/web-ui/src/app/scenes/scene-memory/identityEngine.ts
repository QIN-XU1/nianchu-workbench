/**
 * 身份引擎 —— 照「淋雨家工作台」身份索引 + 身份卡指纹机制
 *
 * 依据 05-协作与规矩/四-身份索引-怎么建.md + 场景记忆.mjs：
 *  - 身份索引 7 列缺一不可：场景id / 面板id / 面板标题 / 会话名(pinTarget首项) / 会话id / 定位卡 / 主技能
 *  - 身份卡指纹 = 定位卡文件的 sha256 前 16 hex；check 时从身份卡抽出指纹，重算定位卡 sha256 前缀比对
 *    不一致 ⇒「卡指纹过期（卡已改，跑 stamp）」⇒ 身份卡只读，要补充写进场景私有记忆
 */

import type { Verdict } from './verdict';

export type IdentityIndexRow = {
  sceneId: string;
  panelId: string;
  panelTitle: string;
  sessionTitle: string; // pinTarget 首项（会话名）
  sessionId: string;
  contextCard: string;  // scenarios/<场景>-context.md
  mainSkill: string;    // 主技能名，或 "—"
};

export type Issue = { level: 'error' | 'warn'; code: string; message: string };

const FINGERPRINT_RE = /sha256:([0-9a-f]{16})/;

/** UTF-8 编码 */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** sha256 hex（用 Web Crypto；Node 18+/浏览器均有 globalThis.crypto.subtle） */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 定位卡指纹 = `sha256:` + sha256 前 16 hex */
export async function cardFingerprint(contextCardText: string): Promise<string> {
  const hex = await sha256Hex(contextCardText);
  return 'sha256:' + hex.slice(0, 16);
}

/** 从身份卡正文抽出登记过的指纹（没有返回 null） */
export function extractFingerprint(identityCardText: string): string | null {
  const m = FINGERPRINT_RE.exec(identityCardText);
  return m ? 'sha256:' + m[1] : null;
}

/**
 * 校验身份卡指纹是否与当前定位卡一致。
 * 不一致（定位卡改了却没 stamp / 手改了身份卡）⇒ error「卡指纹过期」。
 */
export async function verifyCardFingerprint(
  identityCardText: string,
  currentContextCardText: string,
): Promise<{ ok: boolean; issues: Issue[] }> {
  const issues: Issue[] = [];
  const registered = extractFingerprint(identityCardText);
  if (!registered) {
    issues.push({ level: 'error', code: 'no_fingerprint', message: '身份卡里没有 sha256 指纹（未 stamp）' });
    return { ok: false, issues };
  }
  const actual = await cardFingerprint(currentContextCardText);
  if (registered !== actual) {
    issues.push({
      level: 'error',
      code: 'fingerprint_expired',
      message: `卡指纹过期：登记 ${registered} ≠ 当前定位卡 ${actual}（卡已改，跑 stamp）`,
    });
  }
  return { ok: issues.length === 0, issues };
}

/** 校验身份索引一行（7 列齐全 + 基本形态）。 */
export function validateIndexRow(row: Partial<IdentityIndexRow>): { ok: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const cols: (keyof IdentityIndexRow)[] = ['sceneId', 'panelId', 'panelTitle', 'sessionTitle', 'sessionId', 'contextCard'];
  for (const c of cols) {
    if (!row[c] || !String(row[c]).trim()) {
      issues.push({ level: 'error', code: 'missing_col', message: `身份索引缺列：${c}` });
    }
  }
  // 主技能允许 "—" 表示无，但字段必须存在
  if (row.mainSkill === undefined) {
    issues.push({ level: 'error', code: 'missing_col', message: '身份索引缺列：mainSkill' });
  }
  return { ok: issues.length === 0, issues };
}

/** 生成一张身份卡的 bindingBlock（工具 stamp 时写入；手改会被下次 stamp 覆盖）。 */
/**
 * 索引表格整体判定 —— 从每行判定汇总
 *
 * 规则（先立标准）：
 *   · 一行都没有 ⇒ UNKNOWN（没数据不等于通过）
 *   · 任一行 FAIL ⇒ FAIL（脏数据不许被平均掉）
 *   · 任一行 WARN ⇒ WARN
 *   · 任一行 UNKNOWN ⇒ UNKNOWN（判不了不许并入通过）
 *   · 全部 PASS ⇒ PASS
 *
 * 为什么单独抽出来：这段规则原先内联在 IdentityPanel 里，无测试。
 * 「一行都没有 ⇒ UNKNOWN」是最容易被写成 PASS 的地方，必须有反例盯着。
 */
export function tableVerdictOf(verdicts: readonly Verdict[]): Verdict {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return 'UNKNOWN';
  if (verdicts.some((v) => v === 'FAIL')) return 'FAIL';
  if (verdicts.some((v) => v === 'WARN')) return 'WARN';
  if (verdicts.some((v) => v === 'UNKNOWN')) return 'UNKNOWN';
  return 'PASS';
}

export async function buildIdentityCard(args: {
  sceneId: string; panelId: string; sessionId: string; contextCardPath: string;
  contextCardText: string; skills: string; panels: string[];
}): Promise<string> {
  const fp = await cardFingerprint(args.contextCardText);
  return [
    '<!-- 场景绑定 BEGIN -->',
    `场景 id：${args.sceneId}`,
    `面板 id：${args.panelId}`,
    `会话 sessionId：${args.sessionId}`,
    `定位卡：${args.contextCardPath}`,
    `卡指纹：${fp}`,
    `盖章时间：${new Date().toISOString()}`,
    `专属技能：${args.skills}`,
    `面板清单：${args.panels.join(' / ')}`,
    '<!-- 场景绑定 END -->',
    '',
    '> 本卡由工具生成，⛔ 手改即校验失败；要补充请写进 场景私有记忆.md。',
  ].join('\n');
}
