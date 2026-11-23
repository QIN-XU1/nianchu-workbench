#!/usr/bin/env node
/**
 * 场景清单的唯一权威来源 —— 从 scenarios/*.json 动态读
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么需要这个模块（这是第 4 次踩同一个坑）
 * ══════════════════════════════════════════════════════════════════════
 *  新增 3 个工坊场景后，逐个发现以下地方还留着旧的 9 场景硬编码：
 *
 *    ① 管线产物体检.mjs  SCENE_NAME = {...}     → 误判「下游未消费」
 *    ② 管线调度.mjs      SCENE_NAME = {...}     → 同上
 *    ③ 路由表.mjs        SCENE_IDS = [...]      → 自测红「场景数正确」
 *    ④ 技能执行器.mjs    硬编码
 *    ⑤ 进度判定.mjs      硬编码
 *
 *  每一次的表现都不同，每次我都要重新查一遍根因：
 *    · ① 表现是「产物在但未消费」（像是引用格式问题）
 *    · ③ 表现是「自测 20/21」（像是自测写错了）
 *
 *  ⇒ 根因是**同一个事实存了 5 份**。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  唯一权威在哪
 *  ────────────────────────────────────────────────────────────────────
 *  `外壳/scenarios/<id>.json` 里有 `{ id, name }`，那是界面真正在用的配置。
 *  任何「场景有哪些」的判断都应该从那里读。
 *
 *  ────────────────────────────────────────────────────────────────────
 *  怎么用
 *  ────────────────────────────────────────────────────────────────────
 *    import { sceneIds, sceneNames, sceneNameOf, sceneIdOf, loadScenes } from './_场景清单.mjs';
 *
 *    sceneIds()        → ['arch-review', 'backend-craft', ...]   全部 id
 *    sceneNames()      → ['架构梳理', '后端工坊', ...]           全部中文名
 *    sceneNameOf(id)   → '后端工坊'
 *    sceneIdOf(name)   → 'backend-craft'
 *    loadScenes()      → [{ id, name, json }, ...]               完整信息
 *
 *  ⚠ 缓存：默认缓存，避免重复读盘。需要重新读时传 `{ fresh: true }`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

let _cache = null;

/**
 * 读全部场景定义
 * @param {{fresh?:boolean}} [opts]
 * @returns {Array<{id:string, name:string, json:object}>}
 */
export function loadScenes(opts) {
  if (_cache && !(opts && opts.fresh)) return _cache;

  const out = [];
  try {
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8'));
        if (j && j.id && j.name) out.push({ id: String(j.id), name: String(j.name), json: j });
      } catch { /* 单个坏了不影响其他 */ }
    }
  } catch { /* 目录不存在就返回空 */ }

  out.sort((a, b) => a.id.localeCompare(b.id));
  _cache = out;
  return out;
}

/** 全部场景 id */
export function sceneIds(opts) {
  return loadScenes(opts).map((s) => s.id);
}

/** 全部场景中文名 */
export function sceneNames(opts) {
  return loadScenes(opts).map((s) => s.name);
}

/** id → 中文名（找不到返回 ''） */
export function sceneNameOf(id, opts) {
  const s = loadScenes(opts).find((x) => x.id === id);
  return s ? s.name : '';
}

/** 中文名 → id（找不到返回 ''） */
export function sceneIdOf(name, opts) {
  const s = loadScenes(opts).find((x) => x.name === name);
  return s ? s.id : '';
}

/** id → 中文名 的 Map（兼容旧代码里的 SCENE_NAME 用法） */
export function sceneNameMap(opts) {
  const map = {};
  for (const s of loadScenes(opts)) map[s.id] = s.name;
  return map;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(70));
  console.log('  场景清单（唯一权威）· 自测');
  console.log('='.repeat(70));
  console.log();

  const scenes = loadScenes({ fresh: true });
  chk('能读到场景', scenes.length > 0, scenes.length + ' 个');
  chk('每个都有 id 和 name', scenes.every((s) => s.id && s.name), '');

  const ids = sceneIds();
  const names = sceneNames();
  chk('sceneIds 与 loadScenes 一致', ids.length === scenes.length, '');
  chk('sceneNames 与 loadScenes 一致', names.length === scenes.length, '');

  // 关键：这 3 个新场景必须在
  for (const must of ['backend-craft', 'frontend-craft', 'tool-forge']) {
    chk('含新场景 ' + must, ids.includes(must), '');
  }

  // 双向映射
  if (ids.length) {
    const id = ids[0];
    const name = sceneNameOf(id);
    chk('id → name 能回译', sceneIdOf(name) === id, id + ' ↔ ' + name);
  }

  // 反例：不存在的 id 返回空
  chk('反例：不存在的 id 返回空', sceneNameOf('not-exist-xyz') === '', '');
  chk('反例：不存在的 name 返回空', sceneIdOf('不存在的场景') === '', '');

  // sceneNameMap 与 sceneNameOf 一致
  const map = sceneNameMap();
  chk('sceneNameMap 与 sceneNameOf 一致',
    Object.keys(map).every((k) => map[k] === sceneNameOf(k)), '');

  // 缓存：第二次读不应重复扫盘（结果必须一致）
  const again = loadScenes();
  chk('缓存后结果一致', again.length === scenes.length, '');

  console.log();
  const n = R.filter(Boolean).length;
  console.log('─'.repeat(70));
  console.log('  自测结果: ' + n + ' / ' + R.length);
  console.log('─'.repeat(70));
  return n === R.length;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  if (argv.includes('--list')) {
    for (const s of loadScenes({ fresh: true })) console.log(s.id.padEnd(22) + s.name);
    process.exit(0);
  }
  console.log('用法: node 工具/_场景清单.mjs --selftest | --list');
  process.exit(2);
}
