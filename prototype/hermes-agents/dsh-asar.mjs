/**
 * DSH asar 分析器
 *
 * DSH 是 Electron + Cordis 插件架构：app.asar 里塞了上百个 @deepseek-ai/dsh-* 包。
 * 要研究它的架构/执行逻辑，必须先能按需读包清单和包内容。
 *
 * 用法：
 *   node dsh-asar.mjs pkgs                     列出所有包 + 文件数
 *   node dsh-asar.mjs tree <pkg> [depth]       列某个包的目录树
 *   node dsh-asar.mjs cat <pkg> <file>         读某个文件
 *   node dsh-asar.mjs grep <pattern> [pkg]     在包内容里搜
 *   node dsh-asar.mjs top [n]                  按文件数排前 n 个包
 */

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

function nodeAt(arr) {
  let n = header;
  for (const p of arr) {
    const files = n.files;
    if (!files || !files[p]) throw new Error('missing: ' + arr.join('/') + ' at ' + p);
    n = files[p];
  }
  return n;
}
function readFile(arr) {
  const n = nodeAt(arr);
  if (n.files) throw new Error('is dir: ' + arr.join('/'));
  const buf = Buffer.alloc(n.size);
  fs.readSync(fd, buf, 0, n.size, DATA_START + Number(n.offset));
  return buf.toString('utf8');
}
function listDir(arr, depth, prefix, out) {
  const n = nodeAt(arr);
  for (const k of Object.keys(n.files || {}).sort()) {
    const e = n.files[k];
    out.push(prefix + k + (e.files ? '/' : '  ' + e.size + 'B'));
    if (e.files && depth > 1) listDir([...arr, k], depth - 1, prefix + '  ', out);
  }
  return out;
}
function countFiles(arr) {
  const n = nodeAt(arr);
  if (!n.files) return { files: 1, bytes: n.size || 0 };
  let f = 0, b = 0;
  const walk = (node) => {
    for (const k of Object.keys(node.files || {})) {
      const e = node.files[k];
      if (e.files) walk(e);
      else { f++; b += e.size || 0; }
    }
  };
  walk(n);
  return { files: f, bytes: b };
}

const PKGS_ROOT = ['dsh', 'node_modules', '@deepseek-ai'];
const cmd = process.argv[2];

if (cmd === 'pkgs' || cmd === 'top') {
  const ai = nodeAt(PKGS_ROOT);
  const rows = [];
  for (const p of Object.keys(ai.files).sort()) {
    const c = countFiles([...PKGS_ROOT, p]);
    rows.push({ p, ...c });
  }
  if (cmd === 'top') {
    const n = Number(process.argv[3] || 30);
    rows.sort((a, b) => b.files - a.files);
    console.log('  文件数最多的 ' + n + ' 个包：');
    for (const r of rows.slice(0, n)) {
      console.log('    ' + r.p.padEnd(42) + r.files.toString().padStart(5) + ' 文件  ' +
        (r.bytes / 1024).toFixed(0).padStart(6) + ' KB');
    }
  } else {
    console.log('  共 ' + rows.length + ' 个 @deepseek-ai 包');
    for (const r of rows) console.log('  ' + r.p.padEnd(42) + r.files.toString().padStart(5) + ' 文件');
  }
} else if (cmd === 'tree') {
  const pkg = process.argv[3];
  const depth = Number(process.argv[4] || 2);
  console.log(listDir([...PKGS_ROOT, pkg], depth, '', []).join('\n'));
} else if (cmd === 'cat') {
  const pkg = process.argv[3];
  const file = process.argv[4];
  console.log(readFile([...PKGS_ROOT, pkg, ...file.split('/')]));
} else if (cmd === 'grep') {
  const pat = new RegExp(process.argv[3], 'i');
  const only = process.argv[4];
  const ai = nodeAt(PKGS_ROOT);
  const pkgs = only ? [only] : Object.keys(ai.files).sort();
  let hits = 0;
  for (const p of pkgs) {
    const root = [...PKGS_ROOT, p];
    const walk = (arr) => {
      let n;
      try { n = nodeAt(arr); } catch { return; }
      for (const k of Object.keys(n.files || {})) {
        const e = n.files[k];
        const sub = [...arr, k];
        if (e.files) { walk(sub); continue; }
        if (!/\.(js|mjs|cjs|json|md|ts)$/.test(k) || e.size > 400000) continue;
        let t;
        try { t = readFile(sub); } catch { continue; }
        const lines = t.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (pat.test(lines[i])) {
            console.log('  ' + p + '/' + sub.slice(root.length).join('/') + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 140));
            if (++hits > 60) { console.log('  ...(截断)'); return; }
          }
        }
      }
    };
    walk(root);
    if (hits > 60) break;
  }
  if (!hits) console.log('  无匹配');
} else {
  console.log('用法: pkgs | top [n] | tree <pkg> [depth] | cat <pkg> <file> | grep <pattern> [pkg]');
}
