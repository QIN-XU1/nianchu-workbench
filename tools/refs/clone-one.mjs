#!/usr/bin/env node
/** 串行克隆指定仓库：node clone-one.mjs <id> <url> [<id> <url> ...] */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REFS = 'D:\\refs';
const pairs = process.argv.slice(2);
for (let i = 0; i < pairs.length; i += 2) {
  const id = pairs[i], url = pairs[i + 1];
  if (!id || !url) continue;
  const dst = join(REFS, id);
  if (existsSync(dst)) { console.log('  = skip ' + id); continue; }
  console.log('  > ' + id);
  try {
    execFileSync('git', ['-c', 'url.https://github.com/.insteadOf=', 'clone', '--depth', '1', url, dst], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.log('    FAIL ' + String((e.stderr || e.message)).split('\n').slice(-1)[0].slice(0, 140));
    continue;
  }
  let n = 0;
  const walk = (d, dep) => { if (dep > 12) return; let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.name === '.git') continue; if (e.isDirectory()) walk(join(d, e.name), dep + 1); else n++; } };
  if (existsSync(dst)) walk(dst, 0);
  console.log('    OK ' + n);
}
console.log('  batch done');
