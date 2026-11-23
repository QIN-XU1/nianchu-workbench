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

export { header, fd, DATA_START };

export function nodeAt(pathArr) {
  let n = header;
  for (const p of pathArr) {
    const files = n.files;
    if (!files || !files[p]) throw new Error('missing: ' + pathArr.join('/') + ' at ' + p);
    n = files[p];
  }
  return n;
}

export function readBuf(pathArr) {
  const node = nodeAt(pathArr);
  if (node.files) throw new Error('is dir: ' + pathArr.join('/'));
  const buf = Buffer.alloc(node.size);
  let got = 0;
  while (got < node.size) {
    const r = fs.readSync(fd, buf, got, node.size - got, DATA_START + Number(node.offset) + got);
    if (r === 0) break;
    got += r;
  }
  return buf.subarray(0, got);
}

export function readText(pathArr) {
  return readBuf(pathArr).toString('utf8');
}

// walk everything, callback(relPathArray, node)
export function walk(cb, base = []) {
  const n = base.length === 0 ? header : nodeAt(base);
  if (!n.files) throw new Error('not a dir: ' + base.join('/'));
  for (const [k, v] of Object.entries(n.files || {})) {
    const p = [...base, k];
    if (v.files) walk(cb, p);
    else cb(p, v);
  }
}
