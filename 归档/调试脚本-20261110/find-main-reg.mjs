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

// 直接按节点引用导航（避开字符串路径里的特殊字符）
const dsh = header.files.dsh;
const nm = dsh.files.node_modules;
const ai = nm.files['@deepseek-ai'];

function read(node) {
  if (!node || typeof node.size !== 'number') return null;
  const b = Buffer.alloc(node.size);
  fs.readSync(fd, b, 0, node.size, DATA_START + Number(node.offset));
  return b.toString('utf8');
}

const pkgs = Object.keys(ai.files || {});
console.log('@deepseek-ai 包数: ' + pkgs.length);
console.log();

let found = 0;
const results = [];

for (const pkg of pkgs) {
  if (!pkg.startsWith('dsh-client-ui-')) continue;
  const pkgNode = ai.files[pkg];
  if (!pkgNode || !pkgNode.files) continue;
  const pkgJsonText = read(pkgNode.files['package.json']);
  if (!pkgJsonText) continue;
  let j;
  try { j = JSON.parse(pkgJsonText); } catch { continue; }
  const exp = j.exports || {};
  let clientRel = exp['./client'];
  if (!clientRel) continue;
  if (typeof clientRel === 'object') clientRel = clientRel.default || clientRel.import;
  if (typeof clientRel !== 'string') continue;

  // 导航到 client 文件节点
  const parts = clientRel.replace(/^\.\//, '').split('/');
  let cur = pkgNode;
  for (const p of parts) {
    if (!cur || !cur.files || !cur.files[p]) { cur = null; break; }
    cur = cur.files[p];
  }
  if (!cur) continue;
  const src = read(cur);
  if (!src) continue;

  if (src.includes('"main"') || src.includes("'main'")) {
    results.push({ pkg, clientRel, src });
  }
}

console.log('注册 main 的 client 包: ' + results.length);
console.log();

for (const r of results.slice(0, 3)) {
  console.log('=== ' + r.pkg + ' ===');
  console.log('  ' + r.clientRel + '  (' + r.src.length + ' B)');

  // 提取 main 附近的代码
  const hits = [];
  for (const q of ['"main"', "'main'"]) {
    let pos = 0;
    while ((pos = r.src.indexOf(q, pos)) >= 0 && hits.length < 2) {
      hits.push(pos);
      pos += q.length;
    }
  }
  hits.sort((a, b) => a - b);

  for (const h of hits.slice(0, 2)) {
    console.log('  --- offset ' + h + ' ---');
    console.log('  ' + r.src.slice(Math.max(0, h - 300), h + 300).replace(/\s+/g, ' '));
  }
  console.log();
}

fs.closeSync(fd);
