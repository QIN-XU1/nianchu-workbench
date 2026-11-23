/**
 * 身份认领（Identity Claim）
 *
 * 对应 luanyujia 的四步认领 + 用户的明确要求：
 *   "引擎不会因为你把会话命名成场景名就自动按场景注入东西。
 *    会话开场的第一件事是先认领身份，拿自己的会话ID去对场景表对号入座。
 *    然后读定位卡和记忆文件，这不是什么神奇的自动，是一条写进每轮必读宪法里的规矩。"
 *
 * 本模块做两件事：
 *   1. claim(sessionId) —— 四步认领：拿 id → 对号 → 返回该读的文件清单
 *   2. verify()        —— 校验认领表完整性（哪些场景缺身份索引 / sessionId 未回写）
 *
 * 关键设计：
 *   - **不猜**：sessionId 对不上就是"普通会话"，不是"默认第一个场景"
 *   - **以配置为准**：索引表与 scene.json 不一致时，表过期了
 *   - **一次读够**：返回的是"必读清单"，不是每轮重读
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const DEFAULT_SCENES = join(HERE, 'scenes');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

/** 读取所有场景的身份索引 */
export function identityTable(scenesRoot = DEFAULT_SCENES) {
  const rows = [];
  let dirs;
  try { dirs = readdirSync(scenesRoot); } catch { return rows; }

  for (const name of dirs) {
    const dir = join(scenesRoot, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }

    const scenePath = join(dir, 'scene.json');
    const idPath = join(dir, '.identity.json');
    if (!existsSync(scenePath)) continue;

    let scene = null;
    try { scene = JSON.parse(readFileSync(scenePath, 'utf8')); } catch { continue; }

    let identity = null;
    if (existsSync(idPath)) {
      try { identity = JSON.parse(readFileSync(idPath, 'utf8')); } catch { identity = null; }
    }

    rows.push({
      id: scene.id || name,
      name: scene.name || name,
      dir,
      hasIdentity: identity !== null,
      sessionId: identity?.sessionId ?? null,
      sessionTitle: identity?.sessionTitle ?? null,
      panelId: identity?.panelId ?? null,
      contextCard: identity?.contextCard ?? 'CONTEXT.md',
      memory: identity?.memory ?? 'MEMORY.md',
      skill: identity?.skill ?? 'SKILL.md',
      check: identity?.check ?? 'check.mjs',
    });
  }
  return rows;
}

/**
 * 四步认领。
 * 返回 { claimed, scene?, mustRead[], reason }
 */
export function claim(sessionId, scenesRoot = DEFAULT_SCENES) {
  const table = identityTable(scenesRoot);

  // 第 ② 步：对号
  if (!sessionId) {
    return {
      claimed: false,
      reason: '没有提供 sessionId —— 无法认领（不猜，按普通会话处理）',
      mustRead: [],
    };
  }

  const hit = table.find(r => r.sessionId === sessionId);
  if (!hit) {
    // 关键：不在表里 = 普通会话，不是"默认第一个"
    return {
      claimed: false,
      reason: `会话 ${sessionId} 不在身份索引表里 —— 按普通会话处理（没有场景、没有卡）`,
      mustRead: [],
      tableSize: table.length,
      sessionsBound: table.filter(r => r.sessionId).length,
    };
  }

  // 第 ③④ 步：返回必读清单
  const mustRead = [];
  const cardPath = join(hit.dir, hit.contextCard);
  const memPath = join(hit.dir, hit.memory);
  const skillPath = join(hit.dir, hit.skill);

  if (existsSync(cardPath)) mustRead.push({ order: 1, kind: '定位卡', path: cardPath });
  if (existsSync(memPath)) mustRead.push({ order: 2, kind: '场景记忆', path: memPath });
  if (existsSync(skillPath)) mustRead.push({ order: 3, kind: '技能目录', path: skillPath, note: '技能正文按需加载，不要开场全读' });

  return {
    claimed: true,
    scene: {
      id: hit.id,
      name: hit.name,
      panelId: hit.panelId,
      sessionId: hit.sessionId,
      sessionTitle: hit.sessionTitle,
    },
    mustRead,
    reason: `已认领：${hit.name}（${hit.id}）`,
  };
}

/** 校验身份索引表完整性（用于体检） */
export function verify(scenesRoot = DEFAULT_SCENES) {
  const table = identityTable(scenesRoot);
  const problems = [];

  for (const r of table) {
    if (!r.hasIdentity) {
      problems.push({ scene: r.id, kind: 'NO_IDENTITY', detail: '缺 .identity.json（无法认领身份）' });
      continue;
    }
    if (!r.sessionId) {
      problems.push({ scene: r.id, kind: 'NO_SESSION', detail: 'sessionId 未回写（该场景的常驻会话还没绑定）' });
    }
  }

  return {
    ok: problems.filter(p => p.kind !== 'NO_SESSION').length === 0,  // 未绑定会话不算错误（只是还没建）
    scenes: table.length,
    bound: table.filter(r => r.sessionId).length,
    problems,
    table,
  };
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/identity.mjs');
if (isDirect) {
  const sub = process.argv[2];

  if (sub === 'claim') {
    // claim <sessionId> [scenesRoot] —— 第 3 个参数是会话 id，不是 root
    const sid = process.argv[3];
    const root = process.argv[4] || DEFAULT_SCENES;
    const r = claim(sid, root);
    if (!r.claimed) {
      console.log(`${C.yellow}未认领${C.reset} ${r.reason}`);
      if (r.tableSize !== undefined) {
        console.log(`${C.dim}  表里有 ${r.tableSize} 个场景，已绑定会话 ${r.sessionsBound} 个${C.reset}`);
      }
      process.exit(1);
    }
    console.log(`${C.green}${C.bold}已认领${C.reset} ${r.scene.name} ${C.dim}(${r.scene.id})${C.reset}`);
    console.log(`${C.dim}  面板：${r.scene.panelId} · 会话：${r.scene.sessionTitle}${C.reset}`);
    console.log(`\n${C.bold}开场必读（一次读够，不要每轮重读）：${C.reset}`);
    for (const m of r.mustRead) {
      console.log(`  ${m.order}. [${m.kind}] ${m.path}`);
      if (m.note) console.log(`     ${C.dim}${m.note}${C.reset}`);
    }
    process.exit(0);
  }

  if (sub === 'verify') {
    const root = process.argv[3] || DEFAULT_SCENES;
    const r = verify(root);
    console.log(`${C.bold}身份索引体检${C.reset}\n`);
    for (const row of r.table) {
      const bound = row.sessionId ? `${C.green}已绑定${C.reset}` : `${C.yellow}未绑定${C.reset}`;
      console.log(`  ${row.id.padEnd(22)} ${row.hasIdentity ? '✓' : '✗'} identity  ${bound}`);
    }
    console.log(`\n场景 ${r.scenes} 个 · 已绑定会话 ${r.bound} 个`);

    const fatal = r.problems.filter(p => p.kind === 'NO_IDENTITY');
    if (fatal.length > 0) {
      console.log(`\n${C.red}✗ ${fatal.length} 个场景缺身份索引：${C.reset}`);
      for (const p of fatal) console.log(`  · ${p.scene}: ${p.detail}`);
      process.exit(1);
    }
    console.log(`\n${C.green}✓ 身份索引结构完整${C.reset}`);
    const unbound = r.problems.filter(p => p.kind === 'NO_SESSION');
    if (unbound.length > 0) {
      console.log(`${C.dim}  提示：${unbound.map(p => p.scene).join(', ')} 还没绑定常驻会话（不算错，只是还没建）${C.reset}`);
    }
    process.exit(0);
  }

  console.log('用法：');
  console.log('  node identity.mjs claim <sessionId> [scenesRoot]');
  console.log('  node identity.mjs verify [scenesRoot]');
  process.exit(2);
}
