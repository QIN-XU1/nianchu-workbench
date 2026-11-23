#!/usr/bin/env node
/**
 * 闭源产品取证 —— 从已安装的 Electron 分发物里提取**可验证的结构证据**
 *
 * 纪律（这是本项目最容易自欺的地方）：
 *   · 只读结构、元数据、包清单、字符串常量
 *   · **不引用任何用户会话内容或凭据**
 *   · 不猜测实现细节；推断必须标「推测」并说明依据
 *   · 每条结论附「文件路径」或「asar 内路径」
 *
 * 用法：node tools/benchmark/forensics.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(REPO, 'research/拆解/closed-forensics.json');

const TARGETS = [
  { name: 'Qoder', dir: 'D:/file/software/Qoder', vendor: '阿里（推测：Qoder 为阿里产品）' },
  { name: 'WorkBuddy', dir: 'D:/file/software/WorkBuddy', vendor: '腾讯（asar 内有 tencent-docs 目录）' },
];

/** 读 asar 的 header，不解析内容 */
function readAsarHeader(asarPath) {
  const b = fs.readFileSync(asarPath);
  const jsonLen = b.readUInt32LE(12);
  const header = JSON.parse(b.toString('utf8', 16, 16 + jsonLen));
  return { header, base: 8 + b.readUInt32LE(4), size: b.length };
}

/** 递归列出 asar 内所有文件路径（不读内容） */
function listAsarFiles(node, prefix = '', out = [], limit = 50000) {
  if (out.length >= limit) return out;
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (v.files) listAsarFiles(v, p, out, limit);
    else out.push({ path: p, size: v.size || 0 });
  }
  return out;
}

/** 从 asar 里读单个文件的内容（用于 package.json） */
function readAsarFile(asarPath, base, relPath) {
  const b = fs.readFileSync(asarPath);
  const jsonLen = b.readUInt32LE(12);
  const header = JSON.parse(b.toString('utf8', 16, 16 + jsonLen));
  let cur = header;
  for (const seg of relPath.split('/').filter(Boolean)) {
    if (!cur.files || !cur.files[seg]) return null;
    cur = cur.files[seg];
  }
  if (cur.files || cur.size === undefined) return null;
  return b.subarray(base + Number(cur.offset), base + Number(cur.offset) + cur.size);
}

const results = [];

for (const t of TARGETS) {
  const rec = { name: t.name, dir: t.dir, vendor: t.vendor, found: false };
  if (!fs.existsSync(t.dir)) { results.push(rec); continue; }

  // 1. Electron 目录结构
  rec.electron = {
    hasLocales: fs.existsSync(path.join(t.dir, 'locales')),
    hasResources: fs.existsSync(path.join(t.dir, 'resources')),
    topEntries: fs.readdirSync(t.dir).slice(0, 20),
  };

  // 2. asar
  const asarPath = path.join(t.dir, 'resources', 'app.asar');
  if (fs.existsSync(asarPath)) {
    rec.found = true;
    const { header, base, size } = readAsarHeader(asarPath);
    rec.asar = {
      mb: Math.round((size / 1024 / 1024) * 10) / 10,
      topEntries: Object.keys(header.files || {}),
      nodeModuleCount: header.files?.node_modules?.files ? Object.keys(header.files.node_modules.files).length : 0,
    };

    // 3. package.json（版本/依赖/入口）
    const pkgBuf = readAsarFile(asarPath, base, 'package.json');
    if (pkgBuf) {
      try {
        const pkg = JSON.parse(pkgBuf.toString('utf8'));
        rec.package = {
          name: pkg.name, version: pkg.version, main: pkg.main,
          deps: Object.keys(pkg.dependencies || {}).length,
          depNames: Object.keys(pkg.dependencies || {}).slice(0, 25),
          devDeps: Object.keys(pkg.devDependencies || {}).length,
        };
      } catch { rec.package = { error: 'parse failed' }; }
    }

    // 4. 文件清单统计（判断它的分层）
    const files = listAsarFiles(header);
    rec.files = {
      total: files.length,
      byTopDir: {},
      byExt: {},
      jsMB: 0,
    };
    for (const f of files) {
      const top = f.path.split('/')[1] || '(root)';
      rec.files.byTopDir[top] = (rec.files.byTopDir[top] || 0) + 1;
      const ext = path.extname(f.path).toLowerCase() || '(none)';
      rec.files.byExt[ext] = (rec.files.byExt[ext] || 0) + 1;
      if (/\.(js|mjs|cjs)$/.test(ext)) rec.files.jsMB += f.size;
    }
    rec.files.jsMB = Math.round((rec.files.jsMB / 1024 / 1024) * 10) / 10;
    // 只留前 12 个目录
    rec.files.byTopDir = Object.fromEntries(
      Object.entries(rec.files.byTopDir).sort((a, b) => b[1] - a[1]).slice(0, 12),
    );

    // 5. 关键目录（判断能力域）
    const KEY = {
      '内置 agent/对话': /(^|\/)(agent|chat|conversation|assistant)(\/|\.js$|\.ts$)/i,
      'MCP': /mcp/i,
      '插件/扩展': /(plugin|extension|marketplace)/i,
      '终端': /(terminal|shell|pty)/i,
      '编辑器': /(editor|monaco|codemirror)/i,
      '知识库/文档': /(knowledge|rag|embedding|vector|tencent-docs)/i,
      '模型/供应商': /(provider|model|llm|openai|anthropic|qwen|hunyuan)/i,
      '账户/遥测': /(account|auth|telemetry|analytics)/i,
    };
    rec.capabilityDirs = {};
    for (const f of files) {
      for (const [k, re] of Object.entries(KEY)) {
        if (re.test(f.path)) rec.capabilityDirs[k] = (rec.capabilityDirs[k] || 0) + 1;
      }
    }

    // 6. 浅层取样：前 30 个路径（便于人判断结构）
    rec.fileSample = files
      .filter((f) => !f.path.includes('node_modules'))
      .slice(0, 30)
      .map((f) => f.path);
  }

  results.push(rec);
  console.log('');
  console.log('  ' + t.name + '  ' + (rec.found ? '✓ 取证成功' : '✗ 未找到 asar'));
  if (rec.package) {
    console.log('    版本 ' + (rec.package.version || '?') + ' · 依赖 ' + (rec.package.deps || 0) + ' 个 · 入口 ' + (rec.package.main || '?'));
  }
  if (rec.files) {
    console.log('    文件 ' + rec.files.total + ' 个 · JS ' + rec.files.jsMB + 'MB');
    console.log('    顶层: ' + Object.entries(rec.files.byTopDir).slice(0, 8).map(([k, v]) => k + '(' + v + ')').join(' '));
  }
  if (rec.capabilityDirs && Object.keys(rec.capabilityDirs).length) {
    console.log('    能力域命中: ' + Object.entries(rec.capabilityDirs).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '(' + v + ')').join(' '));
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  what: '闭源产品取证（只读结构，未引用任何用户内容或凭据）',
  rule: '每条都是可复核的结构证据；推断标「推测」',
  at: new Date().toISOString(),
  generator: 'tools/benchmark/forensics.mjs',
  targets: results,
}, null, 2) + '\n', 'utf8');

console.log('');
console.log('  → ' + path.relative(REPO, OUT));
console.log('');