#!/usr/bin/env node
/**
 * 给「还没跑过任务」的场景标 pendingSession
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么
 * ══════════════════════════════════════════════════════════════
 *
 *  身份哨兵的判据是对的：
 *    「有 AI 面板但没有 sessionId」= 违规
 *    「有 AI 面板但没有 sessionId，且 meta.pendingSession === true」= 已知待办，不算违规
 *
 *  现在 8 个场景确实还没跑过任务（会话只跑过 arch-review），
 *  所以它们的状态是「合法的待办」，不是「缺陷」。
 *
 *  但前提是场景 JSON 里要有 pendingSession: true 标记 —— 否则哨兵分不清
 *  「已知还没建会话」和「本该有但丢了」。
 *
 * ══════════════════════════════════════════════════════════════
 *  做法
 * ══════════════════════════════════════════════════════════════
 *
 *   ① 读身份索引，找出 sessionId 为空的场景
 *   ② 给这些场景的 JSON 加 meta.pendingSession = true
 *   ③ 已经有 sessionId 的 → 移除 pendingSession 标记
 *
 *  用法：
 *    node 工具/场景待办标记.mjs           预览
 *    node 工具/场景待办标记.mjs --apply   真写
 *    node 工具/场景待办标记.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const INDEX_PATH = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '身份索引.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  const t = readTextSafe(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * 计算每个场景应有的 pendingSession 状态
 *
 * @returns { perScene: Map<sceneId, boolean>, changes: [] }
 */
export function planPending(scenDir, indexPath) {
  const idx = readJsonSafe(indexPath);
  const rows = (idx && Array.isArray(idx.rows)) ? idx.rows : [];
  const hasSession = new Set(
    rows.filter((r) => String(r.sessionId || '').trim() !== '').map((r) => r.scene),
  );

  const perScene = new Map();
  const changes = [];

  if (!fs.existsSync(scenDir)) return { perScene, changes, error: 'scenarios 目录不存在' };

  for (const f of fs.readdirSync(scenDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(scenDir, f);
    const j = readJsonSafe(p);
    if (!j || !j.id) continue;

    // 有 AI 面板的才需要 sessionId
    const hasAiPanel = (j.panels || []).some((x) => x.type === 'harness' || x.type === 'main-agent');
    const shouldPending = hasAiPanel && !hasSession.has(j.id);
    const currentPending = !!(j.meta && j.meta.pendingSession === true);

    perScene.set(j.id, shouldPending);

    if (shouldPending !== currentPending) {
      changes.push({
        scene: j.id,
        name: j.name || j.id,
        file: p,
        from: currentPending,
        to: shouldPending,
        hasAiPanel,
        hasSession: hasSession.has(j.id),
      });
    }
  }
  return { perScene, changes };
}

/** 应用：写回场景 JSON */
export function applyPending(changes) {
  const done = [];
  for (const c of changes) {
    const j = readJsonSafe(c.file);
    if (!j) continue;
    if (!j.meta) j.meta = {};
    if (c.to) {
      j.meta.pendingSession = true;
      j.meta.pendingReason = '还没有跑过任务，引擎里暂无该场景会话。跑一次后会自动绑定。';
    } else {
      delete j.meta.pendingSession;
      delete j.meta.pendingReason;
    }
    fs.writeFileSync(c.file, JSON.stringify(j, null, 2), 'utf8');
    done.push(c);
  }
  return done;
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  场景待办标记 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // 用临时目录造场景，避免动真实的
  const tmp = path.join(WB, 'prototype', '_tmp-pending-test');
  fs.rmSync(tmp, { recursive: true, force: true });
  const scenTmp = path.join(tmp, 'scenarios');
  fs.mkdirSync(scenTmp, { recursive: true });

  // ① 有会话的场景
  fs.writeFileSync(path.join(scenTmp, 'has-session.json'), JSON.stringify({
    id: 'has-session', name: '有会话', panels: [{ type: 'harness', id: 'a' }],
  }), 'utf8');

  // ② 没有会话的场景
  fs.writeFileSync(path.join(scenTmp, 'no-session.json'), JSON.stringify({
    id: 'no-session', name: '无会话', panels: [{ type: 'harness', id: 'b' }],
  }), 'utf8');

  // ③ 没有 AI 面板的场景（不该要求 sessionId）
  fs.writeFileSync(path.join(scenTmp, 'no-ai.json'), JSON.stringify({
    id: 'no-ai', name: '无AI', panels: [{ type: 'grid', id: 'c' }],
  }), 'utf8');

  const idxTmp = path.join(tmp, 'index.json');
  fs.writeFileSync(idxTmp, JSON.stringify({
    rows: [
      { scene: 'has-session', sessionId: 'session-real-123' },
      { scene: 'no-session', sessionId: '' },
      { scene: 'no-ai', sessionId: '' },
    ],
  }), 'utf8');

  const r = planPending(scenTmp, idxTmp);
  const map = r.perScene;

  chk('有会话 → 不标 pending', map.get('has-session') === false, String(map.get('has-session')));
  chk('无会话有AI → 标 pending', map.get('no-session') === true, String(map.get('no-session')));
  chk('无AI面板 → 不标 pending', map.get('no-ai') === false, String(map.get('no-ai')));

  // 反例：如果误把有会话的标成 pending，说明逻辑反了
  chk('反例：有会话的场景不得标 pending', map.get('has-session') !== true);

  // 应用后复查
  const applied = applyPending(r.changes);
  chk('应用了变更', applied.length === 1, applied.length + ' 项');

  const after = readJsonSafe(path.join(scenTmp, 'no-session.json'));
  chk('写入了 meta.pendingSession', after?.meta?.pendingSession === true, String(after?.meta?.pendingSession));

  const after2 = readJsonSafe(path.join(scenTmp, 'has-session.json'));
  chk('有会话的没被标记', !after2?.meta?.pendingSession, String(after2?.meta?.pendingSession));

  // 清理
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  const r = planPending(SCEN_DIR, INDEX_PATH);
  if (r.error) { console.error('✗ ' + r.error); process.exit(2); }

  console.log('═'.repeat(72));
  console.log('  场景待办标记');
  console.log('═'.repeat(72));
  console.log();

  if (r.changes.length === 0) {
    console.log('所有场景的 pendingSession 标记已经正确。');
    process.exit(0);
  }

  const toMark = r.changes.filter((c) => c.to);
  const toClear = r.changes.filter((c) => !c.to);

  if (toMark.length > 0) {
    console.log('需要标记为「待办」（' + toMark.length + '）:');
    for (const c of toMark) {
      console.log('  ○ ' + c.name + '（' + c.scene + '）—— 有 AI 面板，但还没跑过任务');
    }
    console.log();
  }
  if (toClear.length > 0) {
    console.log('需要清除标记（' + toClear.length + '）:');
    for (const c of toClear) {
      console.log('  ✓ ' + c.name + '（' + c.scene + '）—— 已有会话');
    }
    console.log();
  }

  if (has('--apply')) {
    const done = applyPending(r.changes);
    console.log('✓ 已更新 ' + done.length + ' 个场景配置');
  } else {
    console.log('（预览模式，未写入。加 --apply 真写）');
  }
}
