// 解包 Electron app.asar（复用本机 @electron/asar，不联网）
//
// 用法：node research/frontend-benchmark/tools/extract-asar.mjs <app.asar> <outDir>
//
// 依赖解析：本机 @electron/asar 在 npx 缓存里，路径不固定。
// 依次尝试 ① 仓库内 node_modules ② workbench/外壳/node_modules ③ 环境变量 ASAR_MODULE_DIR
// ④ npx 缓存里任意一份（含 @electron/asar 的 _npx 目录）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const REPO = path.resolve(import.meta.dirname, '../../../..');

function findAsar() {
  const tries = [];
  if (process.env.ASAR_MODULE_DIR) tries.push(path.join(process.env.ASAR_MODULE_DIR, 'noop.js'));
  tries.push(path.join(REPO, 'node_modules', 'noop.js'));
  tries.push(path.join(REPO, 'workbench', '外壳', 'node_modules', 'noop.js'));

  // 兜底：扫 npx 缓存
  const npx = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  if (fs.existsSync(npx)) {
    for (const d of fs.readdirSync(npx)) {
      tries.push(path.join(npx, d, 'node_modules', 'noop.js'));
    }
  }
  for (const t of tries) {
    try {
      return createRequire(t)('@electron/asar');
    } catch {
      /* 继续找 */
    }
  }
  throw new Error('找不到 @electron/asar：请 `npx @electron/asar --version` 预热，或设置 ASAR_MODULE_DIR');
}

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node extract-asar.mjs <app.asar> <outDir>');
  process.exit(2);
}
const asar = findAsar();
const t0 = Date.now();
asar.extractAll(src, path.resolve(out));
const entries = asar.listPackage(src).length;
console.log(JSON.stringify({ src, out: path.resolve(out), entries, ms: Date.now() - t0 }));
