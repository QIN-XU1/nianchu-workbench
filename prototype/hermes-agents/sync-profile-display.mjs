#!/usr/bin/env node
/**
 * 把场景的中文名同步进 hermes profile 的 display_name。
 *
 * 为什么要这个：桌面端空态要显示 12 个场景入口（借鉴 ChatGPT/Claude 的建议卡片），
 * 而 hermes 的 ProfileInfo 只有 display_name 能承载中文名（rename 只接受 ASCII id）。
 *
 * 单一源铁律：**中文名只写在 workbench/外壳/scenarios/<id>.json 的 name 字段**，
 * 这个脚本把它单向同步到 hermes 侧。不许在 UI 代码里硬编码 12 个中文名 ——
 * 那就是 ECC 那种 45% 漂移的起点。
 *
 * 用法：
 *   node sync-profile-display.mjs --check   只校验
 *   node sync-profile-display.mjs           写入
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';
const SCEN = path.join(REPO, 'workbench/外壳/scenarios');
const HOME = 'C:/Users/15282/AppData/Local/hermes/profiles';
const CHECK = process.argv.includes('--check');

let changed = 0, same = 0, missing = 0;

for (const f of fs.readdirSync(SCEN).filter((x) => x.endsWith('.json')).sort()) {
  const s = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
  const id = s.id;
  const label = s.name;
  if (!id || !label) continue;

  const yml = path.join(HOME, id, 'profile.yaml');
  if (!fs.existsSync(yml)) { console.log('  ✗ ' + id + '：profile.yaml 不存在'); missing++; continue; }

  const src = fs.readFileSync(yml, 'utf8');
  const want = 'display_name: ' + label;

  if (new RegExp('^display_name:\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm').test(src)) {
    same++;
    continue;
  }

  if (CHECK) { console.log('  ✗ ' + id + '：display_name 缺失或不符（应为 ' + label + '）'); changed++; continue; }

  // 只改 display_name 这一行，其它键原样保留（description 等不能丢）
  const lines = src.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^display_name:/.test(l));
  if (idx >= 0) lines[idx] = want;
  else lines.unshift(want);
  fs.writeFileSync(yml, lines.join('\n'), 'utf8');
  console.log('  ✓ ' + id.padEnd(20) + '→ ' + label);
  changed++;
}

console.log('');
console.log('  改了 ' + changed + ' · 已一致 ' + same + ' · 缺文件 ' + missing);
process.exit(CHECK && changed ? 1 : 0);
