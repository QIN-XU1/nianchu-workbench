#!/usr/bin/env node
/**
 * 念初 · 变更集加密与脱敏
 *
 * ══ 两件不同的事，不能混为一谈 ═══════════════════════════════
 * ① **加密存储**：变更集里存的是源码原文（可能含密钥、token、内网地址）。
 *    落盘时必须加密，否则硬盘上就是一堆明文。
 *    关键约束：加密**不能破坏回滚** —— 所以是加密而不是"脱敏后存"。
 * ② **展示脱敏**：界面/日志里显示 diff 时，把形如 sk-xxx、password=xxx、
 *    -----BEGIN PRIVATE KEY----- 的内容打码，避免顺手截图/贴群里就泄露。
 *    脱敏只影响**展示文本**，不影响磁盘上的密文，也不影响回滚的字节精确性。
 *
 * ══ 密钥放哪 ═════════════════════════════════════════════════
 * <USER_DATA_DIR>/keys/changeset.key，32 字节随机数，首次使用时生成（0600）。
 * 诚实边界：这是**本机本地密钥**，不是硬件安全模块；拿到这台机器的文件系统，
 * 就能拿到密钥。它防的是"文件被单独拷走/误传"，不防"整机被控"。
 * Windows 上 chmod 语义有限，权限靠 OS 账户，这里如实标注。
 */
import {
  randomBytes, createCipheriv, createDecipheriv, randomUUID,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { USER_DATA_DIR } from './runtime.mjs';

const ALGO = 'aes-256-gcm';

let cachedKey = null;

function keyPath() {
  return join(USER_DATA_DIR, 'keys', 'changeset.key');
}

/** 取（或首次生成）本机密钥 */
export function getKey() {
  if (cachedKey) return cachedKey;
  const p = keyPath();
  try {
    if (existsSync(p)) {
      const buf = readFileSync(p);
      if (buf.length === 32) { cachedKey = buf; return cachedKey; }
    }
    mkdirSync(dirname(p), { recursive: true });
    const k = randomBytes(32);
    writeFileSync(p, k, { mode: 0o600 });
    try { chmodSync(p, 0o600); } catch { /* Windows 上可能无效，如实接受 */ }
    cachedKey = k;
    return cachedKey;
  } catch {
    // 密钥不可用 → 不加密，但要能被调用方感知（返回 null）
    return null;
  }
}

/** 密钥是否可用（加密是否生效） */
export function hasKey() {
  return getKey() !== null;
}

/** 加密一段文本 → {enc:true, iv, tag, data}（base64）；密钥不可用则返回 null */
export function encryptText(plain) {
  if (plain === null || plain === undefined) return null;
  const key = getKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: true,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

/** 解密 encryptText 的结果；失败返回 null（不把坏数据当原文） */
export function decryptText(box) {
  if (!box || box.enc !== true) return null;
  const key = getKey();
  if (!key) return null;
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
    return out.toString('utf8');
  } catch {
    return null;
  }
}

/** 加密一段二进制（base64 入）→ 同结构；密钥不可用返回 null */
export function encryptBase64(b64) {
  if (!b64) return null;
  const key = getKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(String(b64), 'base64')), cipher.final()]);
  return { enc: true, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** 解密回 base64（与 encryptBase64 对应） */
export function decryptBase64(box) {
  if (!box || box.enc !== true) return null;
  const key = getKey();
  if (!key) return null;
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
    return out.toString('base64');
  } catch {
    return null;
  }
}

// ── 展示脱敏 ─────────────────────────────────────────────────
/**
 * 常见敏感形态。宁可多打一点码，也不要把 key 贴到截图里。
 * 注意：这里只处理**展示**，不改磁盘内容。
 */
const PATTERNS = [
  // OpenAI / 常见 sk- key
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***'],
  // Bearer token
  [/\b(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***'],
  // 键值对：password / passwd / secret / token / api_key / apikey / access_key
  [/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b(\s*[:=]\s*)(["']?)([^\s"',;]{4,})\3/gi, '$1$2$3***$3'],
  // 私钥块
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1\n***\n$2'],
  // AWS AKIA
  [/\b(AKIA[0-9A-Z]{12,})/g, 'AKIA***'],
  // 长 base64/hex 且像密钥的（保守：>=32 位）
  [/\b([A-Fa-f0-9]{32,})\b/g, '***'],
];

export function maskSecrets(text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

/** 是否包含看起来像密钥的内容（用于给用户一个提示，不阻断） */
export function looksSensitive(text) {
  if (!text) return false;
  return maskSecrets(String(text)) !== String(text);
}
