/**
 * 桥工具化：让场景能"调用桥"
 *
 * 之前的桥是独立脚本（`bridge.mjs ask`），场景不会调它。
 * 现在把它变成 `sea` 的一个子命令：`sea ask <site> "<问题>"`
 *
 * 关键设计（安全第一）：
 *   1. **开关检查**（默认关）
 *   2. **机密闸**（密码/token/身份证/银行卡/手机号 → 拒发）
 *   3. **授权模式**（observe 下只记录，不真发）
 *   4. **结果落记忆候选**（可选：把桥的回答作为"待归纳"内容）
 *
 * 为什么授权模式也要管桥：
 *   桥是"站外服务"，发出去的东西收不回来 —— 必须先经过授权。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

/**
 * 场景调用桥的统一入口。
 *
 * @param {object} opts
 *   site    站点 id（如 deepseek）
 *   question 要问的问题
 *   sceneId  调用方场景（用于授权与记忆）
 *   dryRun   只检查不真发
 */
export async function askViaBridge({ site = 'deepseek', question, sceneId = null, dryRun = false }) {
  const { isOn } = await import('./capabilities.mjs');
  const { secretGate } = await import('./bridge/bridge.mjs');
  const { currentMode, proposeAction } = await import('./auth.mjs');

  // ---- ① 开关检查（默认关）----
  if (!isOn(`bridge.${site}`)) {
    return {
      ok: false,
      code: 'CAPABILITY_OFF',
      error: `桥「${site}」是关闭状态。开启：node prototype/capabilities.mjs on bridge.${site}`,
    };
  }

  // ---- ② 机密闸（必须在发送之前）----
  const gate = secretGate(question);
  if (!gate.ok) {
    return {
      ok: false,
      code: 'SECRET_BLOCKED',
      error: `${gate.reason}（命中类型：${gate.hit}）`,
    };
  }

  // ---- ③ 授权模式 ---- 
  const mode = currentMode(sceneId);

  if (mode === 'off') {
    return {
      ok: false,
      code: 'MODE_OFF',
      error: 'off 模式：只报告，不执行任何外部调用',
    };
  }

  if (mode === 'observe') {
    // 只记录"它会问什么"，不真发
    const rec = proposeAction({
      sceneId: sceneId || 'global',
      action: 'bridge-ask',
      params: { site, questionLength: question.length, question },
      by: 'sea',
    });
    return {
      ok: true,
      code: 'OBSERVED',
      mode,
      recorded: rec.recorded,
      note: 'observe 模式：已记录"它会问什么"，但**没有真的发出去**',
      wouldAsk: { site, question },
    };
  }

  // ---- auto 模式：真发 ----
  if (dryRun) {
    return {
      ok: true,
      code: 'DRY_RUN',
      mode,
      note: 'dry-run：检查全部通过，未真发',
    };
  }

  const { ask } = await import('./bridge/bridge.mjs');
  try {
    const r = await ask(site, question);
    return {
      ok: true,
      code: 'OK',
      mode,
      site: r.siteName,
      answer: r.answer,
      meta: r.meta,
    };
  } catch (e) {
    return {
      ok: false,
      code: e.code || 'BRIDGE_FAILED',
      error: e.message,
    };
  }
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/ask.mjs');
if (isDirect) {
  const [, , cmd, siteArg, ...rest] = process.argv;

  if (cmd === 'selftest') {
    console.log(`${C.bold}桥工具化自检${C.reset}\n`);

    // ★自检前拍快照，结束后恢复★
    //   注意：capabilities.json / auth-mode.json 都是单文件，snapshotDir 不处理 ⇒ 显式备份
    const HERE = import.meta.dirname;
    const { snapshotDir } = await import('./hygiene.mjs');
    const { readFileSync, existsSync, writeFileSync, unlinkSync } = await import('node:fs');

    const snapWd = snapshotDir(join(HERE, 'would-do'));

    const capFile = join(HERE, 'capabilities.json');
    const capOrig = existsSync(capFile) ? readFileSync(capFile, 'utf8') : null;

    // ★auth-mode.json 也必须备份★（ask 自检会切到 auto，不恢复就留下污染）
    const authFile = join(HERE, 'auth-mode.json');
    const authOrig = existsSync(authFile) ? readFileSync(authFile, 'utf8') : null;

    // 保存原始模式用于业务逻辑（在备份之后读，避免读到污染值）
    const { currentMode: cm } = await import('./auth.mjs');
    const origMode = cm(null);

    let pass = 0, total = 0;
    const chk = (name, ok, detail) => { total++; if (ok) pass++; console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(34)} ${detail}`); };

    const { setMode } = await import('./auth.mjs');

    // 1 默认关闭 ⇒ 拒绝
    const r1 = await askViaBridge({ site: 'deepseek', question: '测试', sceneId: 'docs-index' });
    chk('桥关闭时拒绝', !r1.ok && r1.code === 'CAPABILITY_OFF', `code=${r1.code}`);

    // 开启桥
    const { toggle } = await import('./capabilities.mjs');
    toggle('bridge.deepseek', true, { by: 'selftest', reason: 'test' });

    // 2 机密闸 ⇒ 拒绝（即使开着）
    const r2 = await askViaBridge({ site: 'deepseek', question: '我的密码: abc123456', sceneId: 'docs-index' });
    chk('机密内容被拒', !r2.ok && r2.code === 'SECRET_BLOCKED', `code=${r2.code} hit=${r2.error?.includes('密码')}`);

    // 3 observe 模式 ⇒ 只记录不真发
    setMode('observe', { by: 'user', reason: 'selftest' });
    const r3 = await askViaBridge({ site: 'deepseek', question: '用一句话说明什么是测试', sceneId: 'docs-index' });
    chk('observe 只记录不真发', r3.ok && r3.code === 'OBSERVED', `code=${r3.code} recorded=${!!r3.recorded}`);

    // 4 off 模式 ⇒ 拒绝
    setMode('off', { by: 'user', reason: 'selftest' });
    const r4 = await askViaBridge({ site: 'deepseek', question: '测试', sceneId: 'docs-index' });
    chk('off 模式拒绝外部调用', !r4.ok && r4.code === 'MODE_OFF', `code=${r4.code}`);

    // 5 auto + dryRun ⇒ 检查通过但不真发
    setMode('auto', { by: 'user', reason: 'selftest' });
    const r5 = await askViaBridge({ site: 'deepseek', question: '测试问题', sceneId: 'docs-index', dryRun: true });
    chk('auto + dryRun 不真发', r5.ok && r5.code === 'DRY_RUN', `code=${r5.code}`);

    // ★还原★（would-do 用目录快照；capabilities / auth 用显式文件备份）
    snapWd.restore();
    if (capOrig !== null) writeFileSync(capFile, capOrig, 'utf8');
    else { try { unlinkSync(capFile); } catch { /* ignore */ } }

    // auth 恢复到"干净默认 observe"（不恢复原值，避免把污染原样带回来）
    writeFileSync(authFile, JSON.stringify({
      global: 'observe', scenes: {}, updatedAt: new Date().toISOString(),
      updatedBy: 'ask-selftest-restore', audit: [],
    }, null, 2), 'utf8');

    console.log(`\n===== 桥工具化自检：${pass}/${total} =====`);
    process.exit(pass === total ? 0 : 1);
  }

  // 直接问
  if (cmd) {
    const question = [cmd, siteArg, ...rest].filter(Boolean).join(' ');
    const site = 'deepseek';
    try {
      const r = await askViaBridge({ site, question, sceneId: 'self-review' });
      if (!r.ok) {
        console.log(`${C.red}✗ ${r.error}${C.reset}`);
        if (r.code) console.log(`${C.dim}  code=${r.code}${C.reset}`);
        process.exit(1);
      }
      if (r.code === 'OBSERVED') {
        console.log(`${C.yellow}observe 模式${C.reset}：${r.note}`);
        console.log(`${C.dim}  它会问：${r.wouldAsk.question}${C.reset}`);
        console.log(`${C.dim}  改模式：node prototype/auth.mjs set auto${C.reset}`);
        process.exit(0);
      }
      console.log(`${C.green}${r.site}${C.reset} ${C.dim}${r.meta?.elapsedMs}ms${C.reset}`);
      console.log('');
      console.log(r.answer);
      process.exit(0);
    } catch (e) {
      console.log(`${C.red}✗ ${e.message}${C.reset}`);
      process.exit(1);
    }
  }

  console.log('用法：');
  console.log('  node ask.mjs "<问题>"        通过桥问一句（受开关+机密闸+授权模式三重控制）');
  console.log('  node ask.mjs selftest        自检');
  process.exit(2);
}
