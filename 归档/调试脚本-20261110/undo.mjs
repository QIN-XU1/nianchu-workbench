/**
 * 撤回能力（U5）：让任何改动都可以一键退回。
 *
 * 设计：
 *   - 快照 = 把整个「场景数据根」完整复制到 .snapshots/snap-NNN/
 *   - undo = 用最近的快照整体覆盖回去（一次 undo 消费一份快照）
 *   - 默认根是 scenes/（场景数据都在这里）；可用 SEA_SNAPSHOT_ROOT 覆盖
 *
 * 为什么是"整体"而不是"逐文件"：
 *   新增/删除的文件也要能回退。逐文件复制会漏掉"删除"这一种改动。
 */

import {
  existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { cpSync } from 'node:fs';

const HERE = import.meta.dirname;
const SNAPS = join(HERE, '.snapshots');
const ROOT = process.env.SEA_SNAPSHOT_ROOT || join(HERE, 'scenes');

function ensure() { if (!existsSync(SNAPS)) mkdirSync(SNAPS, { recursive: true }); }

function list() {
  ensure();
  const names = readdirSync(SNAPS).filter(n => n.startsWith('snap-')).sort().reverse();
  return names.map(n => {
    const id = Number(n.split('-')[1]);
    let label = '';
    try { label = readFileSync(join(SNAPS, n, 'label.txt'), 'utf8'); } catch { /* none */ }
    return { id, name: n, label };
  });
}

/** 打一个快照，返回 { id, dir } */
export function snapshot(label = 'auto') {
  ensure();
  if (!existsSync(ROOT)) throw new Error(`快照根不存在：${ROOT}`);
  const existing = readdirSync(SNAPS).filter(n => n.startsWith('snap-'));
  const seq = existing.length === 0 ? 1
    : Math.max(...existing.map(n => Number(n.split('-')[1]) || 0)) + 1;
  const dir = join(SNAPS, `snap-${String(seq).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  cpSync(ROOT, join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'label.txt'), label, 'utf8');
  return { id: seq, dir };
}

/** 列出快照（新的在前） */
export function listSnapshots() { return list(); }

/** 恢复最近一次快照；返回恢复的快照 id（没有可恢复的则 null） */
export function undo() {
  const snaps = list();
  if (snaps.length === 0) return null;
  const target = snaps[0];
  const src = join(SNAPS, target.name, 'data');
  if (!existsSync(src)) return null;
  // 整体替换：先删后拷，保证"删除的文件"也回退
  rmSync(ROOT, { recursive: true, force: true });
  cpSync(src, ROOT, { recursive: true });
  rmSync(join(SNAPS, target.name), { recursive: true, force: true });
  return target.id;
}

/** 当前有几个可撤销点 */
export function count() { return list().length; }
