// 工具/_ui锁.mjs —— 场景切换互斥锁
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要
// ══════════════════════════════════════════════════════════════════════
//  实测：4 个体检工具都会「切场景 → 连 webview → 读内容」：
//    · 界面功能体检.mjs
//    · 面板内容体检.mjs
//    · 会话绑定验证.mjs
//    · 整体体检.mjs
//
//  并发跑时它们会互相干扰：
//    A 切到场景1 → B 切到场景2 → A 去读，读到的是场景2 的内容
//    → A 报「找不到输入框」「消息没到达」
//
//  实测症状：
//    第 1 次跑：8/8 通过
//    与面板内容体检并发跑：6/8，报「架构梳理/故障分析 找不到输入框」
//    单独再跑：8/8
//    → 同一份代码，并发时结论不同 = 不是产品缺陷，是测试互斥问题
//
//  这个模块提供一个基于文件锁的互斥机制。
//
// ══════════════════════════════════════════════════════════════════════
//  用法
// ══════════════════════════════════════════════════════════════════════
//    import { withUiLock } from './_ui锁.mjs';
//
//    const r = await withUiLock('界面功能体检', async () => {
//      // 这里可以安全地切场景、读 webview
//      return result;
//    });
//
//  行为：
//    · 拿到锁就执行
//    · 拿不到锁就等（默认最多等 10 分钟）
//    · 超过等待时间 → 抛错，不静默继续（否则又变成互相干扰）
//    · 持有者崩溃 → 锁文件里有 pid，检测进程是否还活着，死了就接管
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const LOCK_FILE = path.join(WB, '数据', '.dsh', '.ui-lock.json');

/** 默认最长等待（ms）：10 分钟 —— 比任何单个体检工具都长 */
export const DEFAULT_WAIT_MS = 600000;
/** 轮询间隔 */
export const POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(holder, pid) {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      holder, pid, at: new Date().toISOString(),
    }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function clearLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/** 持有锁的进程还活着吗 */
function holderAlive(lock) {
  if (!lock || !lock.pid) return false;
  try {
    process.kill(lock.pid, 0);   // 信号 0 = 只检查存在性
    return true;
  } catch (e) {
    // ESRCH = 进程不存在；EPERM = 存在但无权限（也算活着）
    return e && e.code === 'EPERM';
  }
}

/**
 * 拿锁执行（互斥）
 * @param {string} name 谁要拿锁（用于日志与诊断）
 * @param {Function} fn 要执行的 async 函数
 * @param {{waitMs?: number, log?: boolean}} opts
 */
export async function withUiLock(name, fn, opts) {
  const o = opts || {};
  const waitMs = o.waitMs === undefined ? DEFAULT_WAIT_MS : o.waitMs;
  const log = o.log !== false;

  // ⚠ 2026-11-12 加：父进程已持锁时，子进程直接跳过
  //
  //   问题：整体体检.mjs 拿锁后，用 execFileSync **起子进程** 调 界面功能体检.mjs。
  //        子进程是独立 PID，`cur.pid === process.pid` 不成立
  //        → 判为「别人持有」→ 等自己父进程 → 死锁 → 超时报
  //          「UI 锁被「整体体检」占用（pid=6056...）」
  //
  //   修法：父进程把「我持锁了」通过环境变量传给子进程。
  //        子进程看到这个变量就跳过锁（父进程已经保证互斥了）。
  //        这比「同 PID 重入」覆盖面更全，因为子进程 PID 必然不同。
  if (process.env.DSH_UI_LOCK_HELD === '1') {
    if (log) console.log('  （父进程已持 UI 锁，子进程直接执行：' + name + '）');
    return await fn();
  }

  const started = Date.now();
  let warned = false;

  for (;;) {
    const cur = readLock();

    if (!cur) {
      if (writeLock(name, process.pid)) {
        if (log && Date.now() - started > 2000) {
          console.log('  （等了 ' + Math.round((Date.now() - started) / 1000) + ' 秒拿到 UI 锁）');
        }
        // ⚠ 持锁期间设置环境变量，让 execFileSync/spawn 起的子进程能跳过拿锁
        const prevFlag = process.env.DSH_UI_LOCK_HELD;
        process.env.DSH_UI_LOCK_HELD = '1';
        try {
          return await fn();
        } finally {
          if (prevFlag === undefined) delete process.env.DSH_UI_LOCK_HELD;
          else process.env.DSH_UI_LOCK_HELD = prevFlag;
          clearLock();
        }
      }
      // 写锁失败（极小概率竞态），重试
      await sleep(POLL_MS);
      continue;
    }

    // 锁已被自己拿到？（同进程重入保护）
    //
    // ⚠ 2026-11-12 修（死锁：同进程不同 holder 名时不能重入）
    //
    //   原来：if (cur.pid === process.pid && cur.holder === name)
    //         —— 要求 holder 名字也相同才重入。
    //
    //   问题：整体体检.mjs 会：
    //           ① withUiLock('整体体检', main)  ← 拿到锁
    //           ② 内部委托调用 界面功能体检.mjs
    //           ③ 后者 withUiLock('界面功能体检', ...) ← holder 名不同
    //         → 判为「别人持有」→ 等自己 → 死锁，等到超时后报
    //           「UI 锁被「整体体检」占用（pid=14180...）」
    //
    //   实测：整体体检 12/13，唯一失败的就是这一项。
    //
    //   修法：**同 PID 即允许重入**（不管 holder 名字）。
    //        锁保护的是「浏览器场景切换」这个物理资源，
    //        同进程内部本来就不会并发切场景，重入是安全的。
    //        持有者 name 记到嵌套链里，便于诊断。
    if (cur.pid === process.pid) {
      if (log && cur.holder !== name) {
        console.log('  （同进程重入 UI 锁：' + cur.holder + ' → ' + name + '）');
      }
      return await fn();
    }

    // 持锁进程死了 → 接管
    if (!holderAlive(cur)) {
      if (log) {
        console.log('  （接管失效的 UI 锁：持有者 ' + cur.holder +
          ' pid=' + cur.pid + ' 已退出）');
      }
      clearLock();
      continue;
    }

    // 等
    if (!warned) {
      warned = true;
      if (log) {
        console.log('  ⏳ UI 锁被「' + cur.holder + '」占用（pid=' + cur.pid +
          '，起于 ' + cur.at + '），等待中…');
      }
    }

    if (Date.now() - started > waitMs) {
      throw new Error('等 UI 锁超时（' + Math.round(waitMs / 1000) + ' 秒）—— ' +
        '持有者「' + cur.holder + '」pid=' + cur.pid +
        '。多个体检工具会切场景，必须串行跑，不能并发。');
    }

    await sleep(POLL_MS);
  }
}

/** 只查锁状态（诊断用） */
export function uiLockStatus() {
  const cur = readLock();
  if (!cur) return { locked: false };
  return { locked: true, ...cur, alive: holderAlive(cur) };
}

// ── 自测 ──────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) {
    const R = [];
    const chk = (n, ok, d) => { R.push(ok); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

    console.log('='.repeat(72));
    console.log('  UI 锁 · 自测');
    console.log('='.repeat(72));
    console.log();

    clearLock();

    // ① 能拿到锁并执行
    const r1 = await withUiLock('测试A', async () => 'done', { log: false });
    chk('能拿到锁并执行', r1 === 'done');
    chk('执行完自动释放', readLock() === null);

    // ② 执行中锁存在
    let lockDuring = null;
    await withUiLock('测试B', async () => {
      lockDuring = readLock();
    }, { log: false });
    chk('执行期间锁文件存在', !!lockDuring && lockDuring.holder === '测试B',
      lockDuring ? lockDuring.holder : 'null');

    // ③ 异常时也释放
    try {
      await withUiLock('测试C', async () => { throw new Error('故意抛错'); }, { log: false });
    } catch { /* 预期 */ }
    chk('异常时锁也释放', readLock() === null);

    // ④ 反例：超时必须抛错（不是静默继续）
    //   手工造一个「活着的别人」持有锁
    // 造一个「活着的别人」：起一个真实子进程，用它的 pid
    //   （不能用不存在的 pid —— 那会被判死进程接管，反例就失效了）
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 400));
    writeLock('别人', child.pid);
    let threw = false;
    try {
      await withUiLock('测试D', async () => '不该执行', { waitMs: 800, log: false });
    } catch (e) {
      threw = /超时/.test(String(e.message));
    }
    chk('反例：超时必须抛错不能静默继续', threw);
    clearLock();
    try { child.kill(); } catch { /* ignore */ }

    // ⑤ 死亡持有者的锁能被接管
    writeLock('死进程', 999999);
    const r5 = await withUiLock('测试E', async () => 'took-over', { log: false });
    chk('死亡持有者的锁能被接管', r5 === 'took-over');
    clearLock();

    // ⑥ 同进程重入（不同 holder 名）必须不死锁
    //
    //   ⚠ 2026-11-12 加：这条守着实际踩到的死锁。
    //     整体体检.mjs 拿锁后内部委托调用 界面功能体检.mjs，
    //     后者 holder 名不同。原来判为「别人持有」→ 等自己 → 超时报
    //     「UI 锁被「整体体检」占用（pid=...）」。
    let inner = 'not-run';
    const outer = await withUiLock('外层体检', async () => {
      // 模拟内部调用另一个工具（holder 名不同、同进程）
      inner = await withUiLock('内层体检', async () => 'inner-ok', { waitMs: 3000, log: false });
      return 'outer-ok';
    }, { log: false });
    chk('同进程不同名的重入不死锁（这是实际踩到的死锁）',
        outer === 'outer-ok' && inner === 'inner-ok', outer + ' / ' + inner);
    chk('重入后外层退出时锁被释放', readLock() === null);

    // ⑦ 子进程继承持锁标记（这是真实死锁的最终修法）
    //
    //   ⚠ 2026-11-12 加：
    //     上一个用例验的是「同进程重入」，但那不够 ——
    //     整体体检 是用 execFileSync **起子进程** 调 界面功能体检，
    //     子进程是独立 PID，重入判断不成立 → 仍死锁。
    //
    //     修法是持锁期间设置 DSH_UI_LOCK_HELD=1，
    //     子进程（继承 process.env）看到就跳过拿锁。
    {
      let flagDuring = '';
      let flagAfter = '';
      await withUiLock('外层', async () => {
        flagDuring = process.env.DSH_UI_LOCK_HELD || '';
      }, { log: false });
      flagAfter = process.env.DSH_UI_LOCK_HELD || '';
      chk('持锁期间设置了子进程继承标记', flagDuring === '1', 'DSH_UI_LOCK_HELD=' + JSON.stringify(flagDuring));
      chk('释放后清除该标记', flagAfter === '', 'DSH_UI_LOCK_HELD=' + JSON.stringify(flagAfter));

      // 模拟子进程：设标记 + 调 withUiLock → 应立即执行不等待
      process.env.DSH_UI_LOCK_HELD = '1';
      writeLock('假父进程', 999999);   // 造一个「别人持有」的锁
      const t0 = Date.now();
      let childRan = false;
      try {
        await withUiLock('子进程', async () => { childRan = true; }, { waitMs: 1500, log: false });
      } catch { childRan = false; }
      const elapsed = Date.now() - t0;
      delete process.env.DSH_UI_LOCK_HELD;
      clearLock();
      chk('反例：子进程看到继承标记时跳过等待（不超时）',
          childRan === true && elapsed < 1000, '耗时 ' + elapsed + 'ms');

      // 反例：清掉标记后必须真的等待（证明标记是必要的）
      //
      //   注意：这里必须用「活着的别人」持有锁，
      //   用不存在的 pid 会被判死进程接管，反例就失效了。
      const { spawn: spawn2 } = await import('node:child_process');
      const child2 = spawn2(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 400));
      writeLock('假父进程2', child2.pid);
      let threwWithoutFlag = false;
      try {
        await withUiLock('子进程2', async () => { /* 不该执行 */ }, { waitMs: 800, log: false });
      } catch { threwWithoutFlag = true; }
      clearLock();
      try { child2.kill(); } catch { /* ignore */ }
      chk('反例：没有继承标记时必须等待并超时（证明标记必要）',
          threwWithoutFlag === true);
    }

    console.log();
    console.log('='.repeat(72));
    const passed = R.filter(Boolean).length;
    console.log('  自测结果: ' + passed + ' / ' + R.length);
    console.log('='.repeat(72));
    process.exit(passed === R.length ? 0 : 1);
  }
}
