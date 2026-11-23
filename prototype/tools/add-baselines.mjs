/**
 * 给 3 个 demo 场景补 baseline/ 目录。
 *
 * 为什么必须补（本轮实测发现的真实缺陷）：
 *   如果 data/ 同时当 baseline，那么「改业务数据」会让门禁的 G1 失败
 *   → 首屏误报"我的检查本身不可信"
 *   → 这是信任链与业务数据的耦合错误。
 *
 * 正确做法：任何被门禁认证的场景，必须有独立的 baseline/。
 */
import { mkdirSync, copyFileSync, readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PROTOTYPE = join(HERE, '..');
const SCENES = join(PROTOTYPE, 'scenes');

const targets = ['data-reconcile', 'doc-consistency', 'inventory-ledger', 'support-assign'];

for (const id of targets) {
  const dir = join(SCENES, id);
  const data = join(dir, 'data');
  const base = join(dir, 'baseline');
  if (!existsSync(data)) { console.log(`skip ${id}: no data/`); continue; }

  mkdirSync(base, { recursive: true });
  for (const f of readdirSync(data)) {
    copyFileSync(join(data, f), join(base, f));
  }

  // scene.json 加 baselineDir
  const mpath = join(dir, 'scene.json');
  const m = JSON.parse(readFileSync(mpath, 'utf8'));
  if (!m.baselineDir) {
    m.baselineDir = 'baseline';
    writeFileSync(mpath, JSON.stringify(m, null, 2), 'utf8');
  }
  console.log(`${id}: baseline/ created (${readdirSync(base).length} files)`);
}
