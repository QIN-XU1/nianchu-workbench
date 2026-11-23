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

// returns the node object; for dirs returns {files:{...}}, for files {size, offset}
export function nodeAt(pathArr) {
  let n = header;
  for (const p of pathArr) {
    const files = n.files;
    if (!files || !files[p]) throw new Error('missing: ' + pathArr.join('/') + ' at ' + p);
    n = files[p];
  }
  return n;
}

export function readFileByArr(pathArr) {
  const node = nodeAt(pathArr);
  if (node.files) throw new Error('is dir: ' + pathArr.join('/'));
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, DATA_START + Number(node.offset));
  return buf.toString('utf8');
}

function listDir(pathArr, depth, prefix) {
  const node = nodeAt(pathArr);
  const entries = node.files;
  for (const k of Object.keys(entries).sort()) {
    const e = entries[k];
    console.log(prefix + k + (e.files ? '/' : '  [' + e.size + ']'));
    if (e.files && depth > 1) listDir([...pathArr, k], depth - 1, prefix + '  ');
  }
}

const target = process.argv.slice(2);
if (target.length === 0) {
  const ai = nodeAt(['dsh', 'node_modules', '@deepseek-ai']);
  console.log(Object.keys(ai.files).sort().join('\n'));
} else {
  listDir(['dsh', 'node_modules', '@deepseek-ai', ...target], 2, '');
}
