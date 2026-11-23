#!/usr/bin/env node
/**
 * 导出工作台画布要摆的「真实产出」。
 *
 * 为什么重写：上一版摆的是四态贯通 / 31 维矩阵 / 改进台账 / verify-goal ——
 * 那是**我们自证的审计指标**，不是用户要干的活。用户明确说这些没必要。
 * 现在摆 agent 真正写出来的文档（research/*.md），点开就是那个文件。
 *
 * 全部数据来自真实文件系统：读文件、取第一个 `# ` 标题、取首段做摘要、
 * 取 mtime 算新旧。不编造、不填充。
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'apps/vouch-web/src/web-ui/src/app/scenes/workbench/data/deliverables.json');

/** 只扫这些目录（都是 agent 真的会写东西的地方） */
const SOURCES = [
  { dir: 'research', kind: 'doc' },
  { dir: 'evidence/verify', kind: 'report' },
];

const firstHeading = (text, fallback) => {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
};

/** 第一个不是标题、不是引用块、不是分隔线的段落 */
const firstPara = (text) => {
  const lines = text.split(/\r?\n/);
  let buf = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('#')) { if (buf.length) break; continue; }
    if (l.startsWith('>')) { if (buf.length) break; continue; }
    if (l === '---' || l === '') { if (buf.length) break; continue; }
    if (l.startsWith('|') || l.startsWith('```')) { if (buf.length) break; continue; }
    buf.push(l);
    if (buf.join('').length > 160) break;
  }
  return buf.join(' ').replace(/\s+/g, ' ').slice(0, 180);
};

const docs = [];
for (const src of SOURCES) {
  const abs = join(ROOT, src.dir);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.md')) continue;
    const full = join(abs, name);
    const st = statSync(full);
    if (!st.isFile()) continue;
    const text = readFileSync(full, 'utf8');
    const rel = relative(ROOT, full).split('\\').join('/');
    docs.push({
      id: rel.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').toLowerCase(),
      title: firstHeading(text, name.replace(/\.md$/, '')),
      path: rel,
      kind: src.kind,
      sizeKB: Math.round((st.size / 1024) * 10) / 10,
      mtime: st.mtime.toISOString(),
      summary: firstPara(text),
      headings: (text.match(/^##\s+/gm) || []).length,
    });
  }
}

docs.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

const payload = {
  at: new Date().toISOString(),
  count: docs.length,
  docs,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('  产出 ' + docs.length + ' 份文档 → ' + relative(ROOT, OUT).split('\\').join('/'));
for (const d of docs.slice(0, 6)) {
  console.log('    · ' + d.title + '  (' + d.sizeKB + 'KB, ' + d.path + ')');
}
