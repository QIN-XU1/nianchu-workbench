/**
 * A2 终端执行与沙箱验证 —— 诚实版。
 *
 * 【本轮做到什么】只做**执行环境隔离**：环境变量白名单（密钥不外泄）。
 * 【本轮没做到什么】**不是 OS 级沙箱** —— 文件系统边界、网络隔离、系统调用过滤都没有。
 * 所以这条验证里有一半是「**证明它不是沙箱**」的反向断言：
 * 越界写文件**会成功**，我们如实承认，而不是假装拦住了。
 *
 * 用法：node tools/agent/verify-a2-exec.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createToolkit, buildSandboxEnv } from './toolkit.mjs';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  A2 终端执行与沙箱验证（诚实版：隔离做到了，沙箱没做）');
console.log('  ' + '─'.repeat(72));

// ══ 一、环境白名单（纯逻辑）══
{
  const env = buildSandboxEnv({
    PATH: 'C:/bin', HOME: 'C:/home', SystemRoot: 'C:/Windows',
    MY_SECRET: 's', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't', DB_PASSWORD: 'p',
    AWS_CREDENTIAL: 'c', SESSION_ID: 'x', RANDOM_UNRELATED: 'u',
  });
  t('保留 PATH / HOME / SystemRoot',
    env.PATH === 'C:/bin' && env.HOME === 'C:/home' && env.SystemRoot === 'C:/Windows',
    JSON.stringify(Object.keys(env)));
  t('★剥掉 *_SECRET / *API_KEY / *TOKEN / *PASSWORD / *CREDENTIAL / SESSION',
    !('MY_SECRET' in env) && !('OPENAI_API_KEY' in env) && !('GITHUB_TOKEN' in env)
    && !('DB_PASSWORD' in env) && !('AWS_CREDENTIAL' in env) && !('SESSION_ID' in env),
    JSON.stringify(Object.keys(env)));
  t('★无关变量也不放行（白名单而非黑名单）', !('RANDOM_UNRELATED' in env));
  t('兜底：没有 PATH 时补一个', Boolean(buildSandboxEnv({}).PATH));
}

const dir = mkdtempSync(join(tmpdir(), 'a2-'));
const OUTSIDE = join(tmpdir(), 'a2-outside-' + Date.now() + '.txt');
try {
  const tk = createToolkit({ cwd: dir });
  const ctx = { cwd: dir };

  // ══ 二、★密钥真的不会漏到子进程 ══
  {
    process.env.NIANCHU_TEST_SECRET = '{{SECRET_ilr6za9b}}';

    // 对照：不用隔离，直接继承全部 env → 密钥可见（证明"泄漏"是真实存在的风险）
    const leak = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.NIANCHU_TEST_SECRET))'],
      { env: process.env, encoding: 'utf8' });
    t('★对照：继承全 env 时密钥可见（说明风险不是假设）',
      String(leak.stdout).indexOf('{{SECRET_ilr6za9b}}') >= 0, JSON.stringify(String(leak.stdout).slice(0, 40)));

    // 本工具：隔离后子进程看不到
    const r = await tk.bash.call({ command: 'node -e "process.stdout.write(String(process.env.NIANCHU_TEST_SECRET))"' }, ctx);
    t('★隔离后子进程看不到密钥', String(r.stdout).trim() === 'undefined',
      JSON.stringify(String(r.stdout).trim()));
    delete process.env.NIANCHU_TEST_SECRET;
  }

  // ══ 三、执行仍然可用（隔离不能把工具搞坏）══
  {
    const r = await tk.bash.call({ command: 'node -e "process.stdout.write(String(1+1))"' }, ctx);
    t('隔离后 node 仍能跑（PATH 有效）', String(r.stdout).trim() === '2', JSON.stringify(String(r.stdout).trim()));
    t('返回退出码字段存在', r.exit_code === 0 || r.exitCode === 0 || r.code === 0,
      JSON.stringify({ exit_code: r.exit_code, exitCode: r.exitCode }));
  }

  // ══ 四、cwd 生效 ══
  {
    writeFileSync(join(dir, 'marker.a2'), 'x');
    const r = await tk.bash.call({ command: 'node -e "process.stdout.write(process.cwd())"' }, ctx);
    const got = String(r.stdout).trim().replace(/\\/g, '/').toLowerCase();
    const want = dir.replace(/\\/g, '/').toLowerCase();
    t('★子进程 cwd 就是传入的 cwd（不是宿主 cwd）', got === want, got + ' vs ' + want);
    const ls = await tk.bash.call({ command: 'node -e "process.stdout.write(String(require(\'fs\').existsSync(\'marker.a2\')))"' }, ctx);
    t('能在 cwd 里看到本目录文件', String(ls.stdout).trim() === 'true', String(ls.stdout).trim());
  }

  // ══ 五、超时杀整棵进程树 ══
  {
    const t0 = Date.now();
    const r = await tk.bash.call({ command: 'node -e "setTimeout(()=>{},5000)"', timeout_ms: 1200 }, ctx);
    const ms = Date.now() - t0;
    t('★超时会真的杀掉（1.2s 上限，5s 命令）', ms < 4000, ms + 'ms');
    t('超时如实标记', r.timed_out === true || r.timedOut === true || r.timeout === true,
      JSON.stringify(r).slice(0, 120));
  }

  // ══ 六、★反向断言：这不是沙箱 ══
  {
    // 越界写：往 cwd 之外写文件 —— 应当**成功**（我们没做文件系统边界）
    const cmd = process.platform === 'win32'
      ? 'node -e "require(\'fs\').writeFileSync(String.raw`' + OUTSIDE + '`,\'escaped\')"'
      : 'node -e "require(\'fs\').writeFileSync(\'' + OUTSIDE + '\',\'escaped\')"';
    const r = await tk.bash.call({ command: cmd }, ctx);
    const wrote = existsSync(OUTSIDE);
    t('★如实承认：能写出 cwd 之外（我们没做文件系统沙箱）', wrote,
      'exit=' + JSON.stringify(r.exitCode) + ' 写入=' + wrote);
    if (wrote) {
      t('★越界文件内容正确（不是假写）', readFileSync(OUTSIDE, 'utf8') === 'escaped');
    } else {
      t('★越界文件内容正确（不是假写）', true, '（未写入，跳过内容判据）');
    }
    // 这条的意义：如果有人把 A2 吹成"有沙箱"，这里就会露馅
  }
} finally {
  try { rmSync(OUTSIDE, { force: true }); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 执行隔离做实（密钥不外泄/PATH 仍可用/cwd 生效/超时杀树），且如实承认不是文件系统沙箱'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;