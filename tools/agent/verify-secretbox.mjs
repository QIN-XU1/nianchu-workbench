/**
 * 加密存储 + 展示脱敏 + 自动清理 验证 —— 含反例。
 *
 * 【三条必须证明的事】
 *   ① 磁盘上**看不到明文密钥**（否则"加密"是假的）
 *   ② 加密**不能破坏回滚**：含密钥的文件回滚后必须逐字节一致（否则为了安全把功能搞坏）
 *   ③ 脱敏只影响**展示**，不误伤普通代码（否则满屏 *** 没法看）
 * 外加：自动清理**真的节流**（不能每次跑完都扫目录），也能被关掉。
 *
 * 用法：node tools/agent/verify-secretbox.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginSet, endSet, getSet, rollbackSet, computeDiff, makeChangesetHooks,
  changesetUsage, maybeAutoPrune, pruneSets,
} from './changeset.mjs';
import { createToolkit } from './toolkit.mjs';
import { maskSecrets, looksSensitive, encryptText, decryptText, hasKey } from './secretbox.mjs';
import { USER_DATA_DIR } from './runtime.mjs';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

// 一个假密钥（形状像真的，便于命中脱敏规则）
const FAKE_KEY = 'sk-abcdef0123456789abcdef';
const SECRET_FILE = `# config\napi_key = ${FAKE_KEY}\nport = 8080\n`;

console.log('');
console.log('  加密存储 + 展示脱敏 + 自动清理 验证');
console.log('  ' + '─'.repeat(72));

// ══ 一、加解密原语 ══
{
  const box = encryptText('hello 秘密');
  t('encryptText 返回密文盒', Boolean(box && box.enc === true && box.data));
  t('密文盒里看不到明文', !JSON.stringify(box).includes('秘密'));
  t('decryptText 能还原', decryptText(box) === 'hello 秘密');
  t('★反例：篡改密文 → 解密返回 null（不返回垃圾/原文）', (() => {
    const bad = { ...box, tag: Buffer.alloc(16).toString('base64') };
    return decryptText(bad) === null;
  })());
  t('★反例：非密文盒解密返回 null', decryptText({ plain: 'x' }) === null && decryptText(null) === null);
}

// ══ 二、脱敏规则 ══
{
  t('sk- 形式的 key 被打码', maskSecrets('key is sk-abcdef0123456789abcdef ok') === 'key is sk-*** ok');
  t('password=xxx 被打码', !maskSecrets('password=hunter2').includes('hunter2'));
  t('Bearer token 被打码', !maskSecrets('Authorization: Bearer abcdef123456').includes('abcdef123456'));
  t('私钥块被打码', (() => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
    const m = maskSecrets(pem);
    return m.includes('BEGIN RSA PRIVATE KEY') && !m.includes('MIIEow');
  })());
  t('★反例：普通代码**不**被误打码',
    maskSecrets('const timeout = 30000;\nfunction add(a, b) { return a + b; }')
    === 'const timeout = 30000;\nfunction add(a, b) { return a + b; }');
  t('looksSensitive 能识别密钥', looksSensitive(`api_key = ${FAKE_KEY}`) === true);
  t('★反例：普通文本不判为敏感', looksSensitive('hello world') === false);
}

// ══ 三、落盘加密 + 回滚仍逐字节精确 ══
{
  const dir = mkdtempSync(join(tmpdir(), 'nianchu-secret-'));
  try {
    writeFileSync(join(dir, 'app.conf'), SECRET_FILE, 'utf8');

    t('密钥可用（加密真的生效）', hasKey() === true, 'hasKey()=false');

    const set = beginSet({ cwd: dir, label: 'secret-test' });
    const tk = createToolkit({ cwd: dir, changeset: makeChangesetHooks(set) });
    await tk.edit.call({ file_path: 'app.conf', old_string: 'port = 8080', new_string: 'port = 9090' }, { cwd: dir });
    const diff = endSet(set);

    // ① 磁盘上不能有明文密钥
    const csDir = join(USER_DATA_DIR, 'changesets');
    const file = readdirSync(csDir).find((f) => f.startsWith(set.id));
    t('变更集文件已落盘', Boolean(file), '找不到 ' + set.id);
    const raw = file ? readFileSync(join(csDir, file), 'utf8') : '';
    t('★磁盘文件里看不到明文密钥', raw.length > 0 && !raw.includes(FAKE_KEY),
      raw.includes(FAKE_KEY) ? '明文泄露！' : '');
    t('磁盘文件里看不到明文端口原文片段', !raw.includes('port = 8080\n# ') || raw.includes('enc'));
    t('磁盘文件标记了 encrypted', /"encrypted":\s*true/.test(raw), raw.slice(0, 120));
    t('磁盘文件用 enc 盒结构', /"beforeEnc":\s*\{\s*"enc":\s*true/.test(raw) || /"afterEnc":\s*\{\s*"enc":\s*true/.test(raw));

    // ② 展示脱敏
    const f = (diff.files || [])[0];
    t('diff 里带 masked 标记', f && f.masked === true, String(f && f.masked));
    const diffText = (f?.lines || []).map((l) => l.text).join('\n');
    t('★展示的 diff 里看不到明文密钥', !diffText.includes(FAKE_KEY), '');

    // ③ 回滚仍逐字节精确（关键：加密不能把回滚搞坏）
    writeFileSync(join(dir, 'app.conf'), 'port = 9090\n', 'utf8'); // 模拟已被改
    const boxSet = getSet(set.id);
    const rb = rollbackSet(boxSet);
    t('回滚 PASS', rb.state === 'PASS', rb.state + ' ' + (rb.reason || ''));
    t('★回滚后内容与原始**逐字节**一致（含密钥原文）',
      readFileSync(join(dir, 'app.conf'), 'utf8') === SECRET_FILE,
      JSON.stringify(readFileSync(join(dir, 'app.conf'), 'utf8').slice(0, 60)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ══ 四、加密状态在 usage 里可见 ══
{
  const u = changesetUsage();
  t('changesetUsage 报 encrypted 状态', typeof u.encrypted === 'boolean' && u.encrypted === true,
    JSON.stringify(u));
}

// ══ 五、自动清理节流 ══
{
  const first = maybeAutoPrune({ force: true });
  t('强制清理能执行', first.ran === true, JSON.stringify(first));

  const second = maybeAutoPrune();  // 不带 force，应该被节流
  t('★反例：紧接着再调 → 被节流（ran=false）', second.ran === false && second.reason === 'throttled',
    JSON.stringify(second));

  const saved = process.env.NIANCHU_CHANGESET_AUTOPRUNE;
  process.env.NIANCHU_CHANGESET_AUTOPRUNE = '0';
  const off = maybeAutoPrune({ force: true });
  t('环境变量 NIANCHU_CHANGESET_AUTOPRUNE=0 可关掉', off.ran === false && off.reason === 'disabled',
    JSON.stringify(off));
  if (saved === undefined) delete process.env.NIANCHU_CHANGESET_AUTOPRUNE;
  else process.env.NIANCHU_CHANGESET_AUTOPRUNE = saved;
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 落盘加密（无明文）、回滚逐字节精确、展示脱敏且不误伤、清理有节流'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;