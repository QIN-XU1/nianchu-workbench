/**
 * 上下文注入层（引力注入 / Context Injection）
 *
 * 这是 VCP 的核心思想，但**我们只做规则化、可解释的版本**：
 *   "信息不是被 AI 拉取的，而是根据当前语境自然流向 AI。"
 *
 * 与 VCP 的区别（必须说清）：
 *   VCP：用向量算法（RiverMemo/AGS/TagMemo/残差金字塔）计算"该注入什么"
 *   我们：用**明文规则**判断"该注入什么"
 *         —— 因为我们要的是"可解释、可审计、能被门禁验证"，不是"看起来智能"
 *
 * 注入的五类东西（照 VCP 的五类 user 数组思想简化）：
 *   1. identity   —— 我是谁（场景定位卡摘要）
 *   2. memory     —— 我干到哪了（§〇 交接摘要）
 *   3. board      —— 全机状态（待办/协作请求）
 *   4. capability —— 现在能用什么（开着的工具）
 *   5. warning    —— 该注意什么（红线/异常）
 *
 * 关键设计：
 *   - **每类都有明确判据**（不是"看情况"）
 *   - **每类都可关闭**（省 token）
 *   - **总预算有上限**（防止注入层自己膨胀 —— 这正是 luanyujia 警告的"注入 60KB ≈ 每轮多付 20k token"）
 *   - **产出的是一段文本 + 一个账本**（谁注入了什么、多少字节）
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const SCENES = join(HERE, 'scenes');

/** 注入预算（照 luanyujia：注入层越短越好） */
export const BUDGET = {
  total: 8192,        // 总注入 ≤8KB（约 2~3k token）
  identity: 1200,     // 身份 ≤1.2KB
  memory: 3200,       // 记忆 ≤3.2KB（§〇 本身 ≤4KB，这里再压缩）
  board: 1200,        // 板 ≤1.2KB
  capability: 800,    // 能力 ≤0.8KB
  warning: 1200,      // 告警 ≤1.2KB
};

const bytes = s => Buffer.byteLength(String(s || ''), 'utf8');

/**
 * 规则 1：身份注入 —— 取场景定位卡的"职责/不碰"两行
 * 判据：认领了身份才注入（未认领 = 普通会话，什么都不注入）
 */
export function injectIdentity(sceneId) {
  if (!sceneId) return { text: '', bytes: 0, reason: '未认领身份（按普通会话处理，不注入）' };

  const dir = join(SCENES, sceneId);
  if (!existsSync(dir)) return { text: '', bytes: 0, reason: `场景不存在：${sceneId}` };

  const cardPath = join(dir, 'CONTEXT.md');
  if (!existsSync(cardPath)) return { text: '', bytes: 0, reason: '没有定位卡' };

  const text = readFileSync(cardPath, 'utf8');
  // 抽"负责"和"不碰"两行
  const lines = text.split(/\r?\n/);
  const duty = lines.find(l => /^\s*-\s*\*\*负责\*\*/.test(l)) || '';
  const notDo = lines.find(l => /^\s*-\s*\*\*不碰\*\*/.test(l)) || '';
  const scene = lines.find(l => /^\s*-\s*\*\*场景\*\*/.test(l)) || '';

  const body = [scene, duty, notDo].filter(Boolean).join('\n');
  if (!body) return { text: '', bytes: 0, reason: '定位卡里没有职责/不碰' };

  const out = `【身份】\n${body}`;
  if (bytes(out) > BUDGET.identity) {
    return { text: out.slice(0, BUDGET.identity), bytes: BUDGET.identity, truncated: true };
  }
  return { text: out, bytes: bytes(out), reason: '来自定位卡' };
}

/**
 * 规则 2：记忆注入 —— 取 §〇 交接的"下一步/卡点"两节
 * 判据：有交接段才注入；超预算则截断（并明确标注被截断）
 */
export function injectMemory(sceneId) {
  if (!sceneId) return { text: '', bytes: 0, reason: '未认领身份' };

  const memPath = join(SCENES, sceneId, 'MEMORY.md');
  if (!existsSync(memPath)) return { text: '', bytes: 0, reason: '没有场景记忆' };

  const text = readFileSync(memPath, 'utf8').replace(/\r\n?/g, '\n');

  // 找 §〇 段
  let section = '';
  const lines = text.split('\n');
  let inSec = false;
  for (const l of lines) {
    if (/^##+\s*[§]?[〇0]?\s*当前交接/.test(l) || /^##+\s*当前交接/.test(l)) { inSec = true; continue; }
    if (inSec && /^##+\s/.test(l)) break;
    if (inSec) section += l + '\n';
  }

  if (!section.trim()) return { text: '', bytes: 0, reason: '交接段为空' };

  // 只保留"下一步/卡点"和"上次交接"的关键行
  const keep = section.split('\n').filter(l => {
    if (/^###\s*[\d)]*\s*(下一步|卡点|上次交接)/.test(l)) return true;
    if (/^\s*[-*]\s*(下一步|卡点)/.test(l)) return true;
    if (/^\s*[-*]\s/.test(l) && l.length < 200) return true;
    return false;
  }).join('\n').trim();

  if (!keep) return { text: '', bytes: 0, reason: '交接段里没有进度/卡点' };

  const out = `【我干到哪了】\n${keep}`;
  if (bytes(out) > BUDGET.memory) {
    return {
      text: out.slice(0, BUDGET.memory) + '\n…（已截断，完整见 MEMORY.md）',
      bytes: BUDGET.memory,
      truncated: true,
      reason: '超预算截断',
    };
  }
  return { text: out, bytes: bytes(out), reason: '来自 §〇 交接' };
}

/**
 * 规则 3：板注入 —— 待办与协作请求
 * 判据：有待办或有未处理请求才注入
 */
export function injectBoard() {
  const parts = [];

  // 待办
  let todos = [];
  try {
    const f = join(HERE, 'boards', '待办板.md');
    if (existsSync(f)) {
      const t = readFileSync(f, 'utf8');
      for (const l of t.split('\n')) {
        const m = l.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
        if (m && m[1] !== '事项' && !m[1].includes('---')) todos.push(m[1]);
      }
    }
  } catch { /* ignore */ }

  if (todos.length > 0) {
    parts.push(`待办：${todos.slice(0, 5).join('；')}${todos.length > 5 ? `（还有 ${todos.length - 5} 条）` : ''}`);
  }

  // 协作请求
  let reqs = 0;
  try {
    const collabDir = join(HERE, 'collab');
    if (existsSync(collabDir)) {
      for (const d of readdirSync(collabDir)) {
        const inbox = join(collabDir, d, 'inbox');
        if (!existsSync(inbox)) continue;
        for (const f of readdirSync(inbox)) {
          if (!f.endsWith('.json')) continue;
          try {
            const j = JSON.parse(readFileSync(join(inbox, f), 'utf8'));
            if (j.kind === 'request') reqs++;
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }

  if (reqs > 0) parts.push(`协作请求待处理：${reqs} 个`);

  if (parts.length === 0) return { text: '', bytes: 0, reason: '无待办、无协作请求' };

  const out = `【全机状态】\n${parts.join('\n')}`;
  if (bytes(out) > BUDGET.board) return { text: out.slice(0, BUDGET.board), bytes: BUDGET.board, truncated: true };
  return { text: out, bytes: bytes(out), reason: '来自板与协作' };
}

/**
 * 规则 4：能力注入 —— 现在开着什么
 * 判据：有开着的才注入（全关 = 不注入，省 token）
 */
export function injectCapability() {
  let caps = { groups: [], active: [] };
  try {
    const f = join(HERE, 'capabilities.json');
    if (existsSync(f)) {
      const s = JSON.parse(readFileSync(f, 'utf8'));
      const active = [];
      for (const g of ['bridge', 'mcp', 'plugins']) {
        const grp = s[g];
        if (!grp) continue;
        const container = g === 'bridge' ? 'sites' : g === 'mcp' ? 'servers' : 'items';
        if (!grp[container]) continue;
        for (const [k, v] of Object.entries(grp[container])) {
          if (v.on) active.push(v.label || k);
        }
      }
      caps.active = active;
    }
  } catch { /* ignore */ }

  if (caps.active.length === 0) return { text: '', bytes: 0, reason: '外挂全关（不注入，省 token）' };

  const out = `【现在能用】\n${caps.active.join('、')}`;
  return { text: out, bytes: bytes(out), reason: '来自能力开关' };
}

/**
 * 规则 5：告警注入 —— 该注意什么
 * 判据：只在真的有问题时注入（没问题 = 不注入，保持安静）
 */
export function injectWarning(sceneId) {
  const warns = [];

  // 记忆红线
  if (sceneId) {
    const memPath = join(SCENES, sceneId, 'MEMORY.md');
    if (existsSync(memPath)) {
      const st = statSync(memPath);
      if (st.size > 25 * 1024) warns.push(`场景记忆超红线（${(st.size / 1024).toFixed(1)}KB > 25KB），需归档`);

      // 交接段
      const text = readFileSync(memPath, 'utf8').replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      const start = lines.findIndex(l => l.includes('当前交接'));
      if (start >= 0) {
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i++) {
          const m = lines[i].match(/^(#{1,6})\s+/);
          if (m && m[1].length <= lines[start].match(/^(#{1,6})/)[1].length) { end = i; break; }
        }
        const seg = lines.slice(start, end).join('\n');
        if (bytes(seg) > 4 * 1024) warns.push(`交接段超红线（${(bytes(seg) / 1024).toFixed(1)}KB > 4KB）`);
      }
    }
  }

  // 缺身份索引
  if (sceneId && !existsSync(join(SCENES, sceneId, '.identity.json'))) {
    warns.push('场景缺身份索引（无法认领）');
  }

  if (warns.length === 0) return { text: '', bytes: 0, reason: '无告警（保持安静）' };

  const out = `【注意】\n${warns.map(w => '· ' + w).join('\n')}`;
  if (bytes(out) > BUDGET.warning) return { text: out.slice(0, BUDGET.warning), bytes: BUDGET.warning, truncated: true };
  return { text: out, bytes: bytes(out), reason: '来自红线检查' };
}

/**
 * 组装一次注入。
 * 返回 { text, parts[], totalBytes, budget, withinBudget, ledger[] }
 */
export function compose({ sceneId = null, channels = null } = {}) {
  const all = ['identity', 'memory', 'board', 'capability', 'warning'];
  const want = channels || all;

  const parts = [];
  const ledger = [];

  const runners = {
    identity: () => injectIdentity(sceneId),
    memory: () => injectMemory(sceneId),
    board: () => injectBoard(),
    capability: () => injectCapability(),
    warning: () => injectWarning(sceneId),
  };

  // ★账本必须覆盖全部 5 类★：被关闭的也要记一条（标 skipped），
  //   否则调用方查不到"某通道是否被关"（这是自检暴露的真实缺陷）
  for (const name of all) {
    if (!want.includes(name)) {
      ledger.push({ channel: name, bytes: 0, skipped: true, reason: '被关闭' });
      continue;
    }
    const r = runners[name]();
    if (r.text) {
      parts.push(r.text);
      ledger.push({ channel: name, bytes: r.bytes, truncated: !!r.truncated, reason: r.reason });
    } else {
      ledger.push({ channel: name, bytes: 0, skipped: true, reason: r.reason });
    }
  }

  let text = parts.join('\n\n');
  let totalBytes = bytes(text);
  let overBudget = false;

  if (totalBytes > BUDGET.total) {
    text = text.slice(0, BUDGET.total) + '\n…（注入超预算，已截断）';
    totalBytes = bytes(text);
    overBudget = true;
  }

  return {
    sceneId,
    text,
    parts: parts.length,
    totalBytes,
    budget: BUDGET.total,
    withinBudget: !overBudget,
    ledger,
  };
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/inject.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const [, , cmd, sceneArg, ...rest] = process.argv;

  if (cmd === 'show') {
    const r = compose({ sceneId: sceneArg || null });
    console.log(`${C.bold}上下文注入预览${C.reset} · ${C.dim}场景=${sceneArg || '(未认领)'}${C.reset}\n`);
    console.log(`${C.dim}预算 ${r.budget} 字节 · 实际 ${r.totalBytes} 字节 · ${r.withinBudget ? C.green + '在预算内' : C.red + '超预算'}${C.reset}\n`);
    console.log(`${C.bold}=== 注入内容 ===${C.reset}`);
    console.log(r.text || '（空 —— 什么都不注入，这是正确行为）');
    console.log(`\n${C.bold}=== 账本 ===${C.reset}`);
    for (const l of r.ledger) {
      const tag = l.skipped ? `${C.dim}跳过${C.reset}` : `${C.green}注入${C.reset}`;
      console.log(`  ${tag} ${l.channel.padEnd(12)} ${String(l.bytes).padStart(5)} 字节  ${C.dim}${l.reason}${l.truncated ? ' [截断]' : ''}${C.reset}`);
    }
    process.exit(0);
  }

  if (cmd === 'channels') {
    const r = compose({ sceneId: sceneArg || null });
    console.log(JSON.stringify(r.ledger, null, 2));
    process.exit(0);
  }

  if (cmd === 'selftest') {
    console.log(`${C.bold}上下文注入自检${C.reset}\n`);
    let pass = 0, total = 0;
    const chk = (name, ok, detail) => { total++; if (ok) pass++; console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(30)} ${detail}`); };

    // 1 未认领身份 → 什么都不注入（关键：不猜）
    const r1 = compose({ sceneId: null });
    chk('未认领身份不注入身份', !r1.text.includes('【身份】'), `注入 ${r1.totalBytes} 字节`);

    // 2 有场景 → 注入身份与记忆
    const ids = readdirSync(SCENES).filter(d => existsSync(join(SCENES, d, 'scene.json')));
    const sid = ids[0];
    const r2 = compose({ sceneId: sid });
    chk('已认领场景注入身份', r2.text.includes('【身份】'), `场景=${sid} 注入 ${r2.totalBytes} 字节`);

    // 3 总预算
    chk('注入不超总预算', r2.totalBytes <= BUDGET.total, `${r2.totalBytes} ≤ ${BUDGET.total}`);

    // 4 每类都守自己的预算
    const overs = r2.ledger.filter(l => !l.skipped && l.bytes > BUDGET[l.channel]);
    chk('每类守自己的预算', overs.length === 0, overs.length ? `超: ${overs.map(o => o.channel).join(',')}` : '全部在限内');

    // 5 关闭一类 → 该类字节归零
    const r3 = compose({ sceneId: sid, channels: ['identity'] });
    const memLedger = r3.ledger.find(l => l.channel === 'memory');
    chk('关闭的通道不注入', memLedger.skipped && memLedger.bytes === 0, `memory skipped=${memLedger.skipped}`);

    // 6 全关 → 空
    const r4 = compose({ sceneId: sid, channels: [] });
    chk('全关时注入为空', r4.text === '' && r4.totalBytes === 0, `${r4.totalBytes} 字节`);

    // 7 无外挂时不注入能力
    const r5 = compose({ sceneId: sid, channels: ['capability'] });
    chk('外挂全关不注入能力', !r5.text.includes('【现在能用】'), `注入 ${r5.totalBytes} 字节`);

    // 8 无告警时不注入告警（保持安静）
    const r6 = compose({ sceneId: sid, channels: ['warning'] });
    const warnInjected = r6.text.includes('【注意】');
    chk('无告警时保持安静', !warnInjected, `注入 ${r6.totalBytes} 字节`);

    console.log(`\n===== 上下文注入自检：${pass}/${total} =====`);
    process.exit(pass === total ? 0 : 1);
  }

  console.log('用法：');
  console.log('  node inject.mjs show [sceneId]       预览注入内容');
  console.log('  node inject.mjs channels [sceneId]   只看账本');
  console.log('  node inject.mjs selftest             自检');
  process.exit(2);
}
