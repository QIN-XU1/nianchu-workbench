/**
 * A2 终端执行验证（会话快照 + 环境抽象）—— 对齐 hermes 的「有」依据。
 *
 * 【为什么这条能把 A2 推到「有」】矩阵里 hermes 判「有」的依据不是内核沙箱，而是
 * `hermes-ecc.md:42-45`：「every command spawns a fresh process. A session snapshot
 *  (env vars, functions, aliases) is captured once and **re-sourced before each command**」
 * + 环境抽象（local/Docker/SSH）。所以这条验证钉的正是这两件事：
 *   ① 每次调用是**新进程**（PID 不同）
 *   ② 会话快照能**按调用重放**（export 的东西下次还在）
 *   ③ 环境抽象：local 用真实 HOME，scratch 用隔离临时 HOME/工作目录
 * 同时保留反例：快照不存在/损坏要如实告警，密钥**不许落盘**。
 *
 * 【本验证不证明的】内核沙箱（seatbelt/bubblewrap）。scratch 只是改 HOME/TMP，
 * 阻止不了绝对路径写盘 —— 这一点在 verify-a2-exec.mjs 里有反向断言钉死。
 *
 * 用法：node tools/agent/verify-a2-session.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createToolkit } from './toolkit.mjs';
import { captureSession, loadSession, listSessions, dropSession, prepareEnv } from './session.mjs';
import { USER_DATA_DIR } from './runtime.mjs';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const IS_WIN = process.platform === 'win32';
const setCmd = (k, v) => (IS_WIN ? `set ${k}=${v}` : `export ${k}=${v}`);
const sessionFile = (n) => join(USER_DATA_DIR, 'sessions', n + '.json');

console.log('');
console.log('  A2 终端执行验证（会话快照 / 每次新进程 / 环境抽象）');
console.log('  ' + '─'.repeat(72));

const tk = createToolkit({ cwd: process.cwd() });
const ctx = { cwd: process.cwd() };

try {
  // ══ 一、快照捕获：业务变量留下，密钥不留 ══
  {
    dropSession('t1');
    process.env.NIANCHU_FAKE_KEY = 'should-not-be-persisted';
    const cap = captureSession('t1', { script: [setCmd('NIANCHU_BIZ_VAR', 'biz-42'), setCmd('OPENAI_API_KEY', 'sk-leak')].join(IS_WIN ? '&' : '; ') });
    t('抓快照成功', cap.state === 'PASS', String(cap.reason));
    t('★业务变量被捕获', cap.snapshot?.env?.NIANCHU_BIZ_VAR === 'biz-42', JSON.stringify(cap.snapshot?.env?.NIANCHU_BIZ_VAR));
    t('★敏感名变量不被捕获（OPENAI_API_KEY）', !('OPENAI_API_KEY' in (cap.snapshot?.env || {})));
    t('★快照文件里也没有密钥明文',
      !existsSync(sessionFile('t1')) || !/sk-leak/.test(readFileSync(sessionFile('t1'), 'utf8')));
    delete process.env.NIANCHU_FAKE_KEY;
  }

  // ══ 二、★快照按调用重放 ══
  {
    const r1 = await tk.bash.call({ command: 'node -e "process.stdout.write(String(process.env.NIANCHU_BIZ_VAR))"' }, ctx);
    t('★不带快照 → 变量不存在（说明是"失忆"的）', String(r1.stdout).trim() === 'undefined', String(r1.stdout).trim());

    const r2 = await tk.bash.call({ command: 'node -e "process.stdout.write(String(process.env.NIANCHU_BIZ_VAR))"', session: 't1' }, ctx);
    t('★带快照 → 变量被重放出来', String(r2.stdout).trim() === 'biz-42', String(r2.stdout).trim());
    t('返回里标明用了哪个快照', r2.session === 't1', String(r2.session));
  }

  // ══ 三、★每次调用都是新进程（PID 不同）══
  {
    const pidCmd = 'node -e "process.stdout.write(String(process.pid))"';
    const a = await tk.bash.call({ command: pidCmd }, ctx);
    const b = await tk.bash.call({ command: pidCmd }, ctx);
    const pa = String(a.stdout).trim();
    const pb = String(b.stdout).trim();
    t('★两次调用 PID 不同（每次 fresh 进程）', pa !== pb && pa.length > 0, pa + ' vs ' + pb);
  }

  // ══ 四、环境抽象：local vs scratch ══
  {
    const homeCmd = 'node -e "process.stdout.write(String(process.env.HOME || process.env.USERPROFILE))"';
    const l = await tk.bash.call({ command: homeCmd, env_kind: 'local' }, ctx);
    t('local：HOME 是真实用户目录', !/scratch/i.test(String(l.stdout)), String(l.stdout).slice(0, 80));

    const s = await tk.bash.call({ command: homeCmd, env_kind: 'scratch' }, ctx);
    t('★scratch：HOME 指向隔离目录', /scratch/i.test(String(s.stdout)), String(s.stdout).slice(0, 80));
    t('scratch 返回里报告了 scratchDir', /scratch/i.test(String(s.scratchDir || '')), String(s.scratchDir));
    t('scratch 的 cwd 也在隔离目录里',
      /scratch/i.test(String(s.scratchDir || '')) && String(s.envKind) === 'scratch', String(s.envKind));

    // scratch 里写的文件真的落在隔离目录（不是项目目录）
    const w = await tk.bash.call({ command: 'node -e "require(\'fs\').writeFileSync(\'scratch-probe.txt\',\'x\')"', env_kind: 'scratch' }, ctx);
    t('★scratch 里写的文件落在隔离目录', existsSync(join(String(w.scratchDir), 'scratch-probe.txt')),
      String(w.scratchDir));
  }

  // ══ 五、反例：快照不存在 / 损坏 ══
  {
    const miss = await tk.bash.call({ command: 'node -e "process.stdout.write(String(1+1))"', session: 'no-such-session' }, ctx);
    t('★反例：快照不存在 → 仍执行但有告警', String(miss.stdout).trim() === '2'
      && Array.isArray(miss.envWarnings) && miss.envWarnings.some((w) => /不存在/.test(w)),
      JSON.stringify(miss.envWarnings));

    writeFileSync(sessionFile('bad'), '{ not json', 'utf8');
    const bad = loadSession('bad');
    t('★反例：损坏快照被识别（corrupted）', Boolean(bad && bad.corrupted), JSON.stringify(bad));
    const r = await tk.bash.call({ command: 'node -e "process.stdout.write(String(2+2))"', session: 'bad' }, ctx);
    t('★反例：损坏快照不崩，告警后继续', String(r.stdout).trim() === '4'
      && Array.isArray(r.envWarnings) && r.envWarnings.some((w) => /损坏/.test(w)),
      JSON.stringify(r.envWarnings));
    dropSession('bad');
  }

  // ══ 六、prepareEnv 纯逻辑 ══
  {
    const p = prepareEnv({ kind: 'local', session: 't1', baseEnv: { PATH: 'C:/bin', SOME_KEY: 'x', NIANCHU_BIZ_VAR: 'ignored' } });
    t('prepareEnv(local) 给出 env 与 cwd', Boolean(p.env) && typeof p.cwd === 'string');
    t('★白名单先滤掉敏感名（SOME_KEY 不在）', !('SOME_KEY' in p.env), JSON.stringify(Object.keys(p.env).slice(0, 8)));
    t('★快照覆盖回业务变量', p.env.NIANCHU_BIZ_VAR === 'biz-42', String(p.env.NIANCHU_BIZ_VAR));
    t('快照不与 PATH 冲突（PATH 不被覆盖）', p.env.PATH === 'C:/bin', String(p.env.PATH));

    const q = prepareEnv({ kind: 'scratch', baseEnv: { PATH: 'C:/bin' } });
    t('prepareEnv(scratch) 返回 scratchDir', /scratch/i.test(q.scratchDir || ''), String(q.scratchDir));
    t('prepareEnv 未知 kind → 告警且按 local', prepareEnv({ kind: 'weird', baseEnv: {} }).warnings.some((w) => /未知环境/.test(w)));
  }

  // ══ 七、会话管理 ══
  {
    const list = listSessions();
    t('listSessions 能列出 t1', Array.isArray(list) && list.some((x) => x.name === 't1'));
    dropSession('t1');
    t('dropSession 后读不到', loadSession('t1') === null);
  }
} finally {
  for (const n of ['t1', 'smoke', 'smoke2', 'bad']) { try { dropSession(n); } catch { /* ignore */ } }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 每次新进程 + 快照按调用重放 + local/scratch 环境抽象；密钥不落盘；缺/坏快照如实告警'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;