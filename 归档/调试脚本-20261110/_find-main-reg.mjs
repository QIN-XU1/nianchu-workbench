import fs from 'node:fs';

const ASAR = 'D:/file/software/DeepSeek Harness/resources/app.asar';
const fd = fs.openSync(ASAR, 'r');
const hbuf = Buffer.alloc(16);
fs.readSync(fd, hbuf, 0, 16, 0);
const jsonSize = hbuf.readUInt32LE(12);
const hb = Buffer.alloc(jsonSize);
fs.readSync(fd, hb, 0, jsonSize, 16);
const header = JSON.parse(hb.toString('utf8'));
const DATA_START = 16 + jsonSize;

function findNode(p) {
  const parts = p.split('/').filter(Boolean);
  let cur = header.files;
  for (const part of parts) {
    if (!cur || !cur[part]) return null;
    cur = cur[part];
  }
  return cur;
}
function readFile(p) {
  const n = findNode(p);
  if (!n || typeof n.size !== 'number') return null;
  const b = Buffer.alloc(n.size);
  fs.readSync(fd, b, 0, n.size, DATA_START + Number(n.offset));
  return b.toString('utf8');
}

const BASE = 'dsh/node_modules/@deepseek-ai';

// ── 找所有注册 main slot 的 client bundle ──
const ai = findNode(BASE);
const pkgs = Object.keys(ai.files || {});
console.log('扫描 ' + pkgs.length + ' 个包里带 ./client 的…');
console.log();

let found = 0;
for (const pkg of pkgs) {
  if (!pkg.startsWith('dsh-client-ui-')) continue;
  const pkgJson = readFile(BASE + '/' + pkg + '/package.json');
  if (!pkgJson) continue;
  let j;
  try { j = JSON.parse(pkgJson); } catch { continue; }
  const exp = j.exports || {};
  let clientRel = exp['./client'];
  if (!clientRel) continue;
  if (typeof clientRel === 'object') clientRel = clientRel.default || clientRel.import;
  if (typeof clientRel !== 'string') continue;

  const clientPath = BASE + '/' + pkg + '/' + clientRel.replace(/^\.\//, '');
  const src = readFile(clientPath);
  if (!src) continue;

  // 找 main 的 keyed 注册
  const patterns = [
    /name:\s*["']main["'][^}]{0,300}/g,
    /key:\s*["'][^"']+["'][^}]{0,200}/g,
  ];
  let hit = null;
  for (const re of patterns) {
    const m = src.match(re);
    if (m) { hit = m; break; }
  }

  if (hit && src.includes('"main"') || src.includes("'main'")) {
    console.log('=== ' + pkg + ' ===');
    console.log('  client: ' + clientRel + '  (' + src.length + ' B)');

    // 提取 main 注册附近
    const idx = src.indexOf('main');
    const contexts = [];
    let pos = 0;
    while ((pos = src.indexOf('"main"', pos)) >= 0 && contexts.length < 2) {
      contexts.push(src.slice(Math.max(0, pos - 250), pos + 250));
      pos += 6;
    }
    pos = 0;
    while ((pos = src.indexOf("'main'", pos)) >= 0 && contexts.length < 4) {
      contexts.push(src.slice(Math.max(0, pos - 250), pos + 250));
      pos += 6;
    }
    for (const c of contexts) {
      console.log('  ---');
      console.log('  ' + c.replace(/\s+/g, ' '));
    }
    console.log();
    found++;
    if (found >= 3) break;
  }
}

if (!found) console.log('没有找到注册 main 的 client 包');
fs.closeSync(fd);
