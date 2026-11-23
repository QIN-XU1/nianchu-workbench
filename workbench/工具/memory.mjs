/**
 * L3 记忆层 —— 三层结构 + 注入机制
 *
 * luanyujia 的三层记忆模型：
 *   ① 注入层：每轮注入，必须极短（≤2KB）
 *   ② 私有层：场景开场读，§〇 ≤4KB / 主文件 ≤25KB
 *   ③ 共享层：需时才读，四块板
 *
 * 本脚本做两件事：
 *   --check  验证三层结构与体量红线
 *   --inject 为指定场景生成「注入文本」（每轮该注入的内容）
 *
 * 用法：
 *   node 工具\memory.mjs --check
 *   node 工具\memory.mjs --inject --scene 命令
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SC = path.join(WB, '外壳', 'scenarios');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

// 红线（luanyujia 2.4）
const LIMITS = {
  injectBytes: 2 * 1024,
  handoffBytes: 4 * 1024,
  mainBytes: 25 * 1024,
  projectBytes: 8 * 1024,
};

const isCheck = process.argv.includes('--check');
const isInject = process.argv.includes('--inject');
const sceneArg = (() => { const i = process.argv.indexOf('--scene'); return i >= 0 ? process.argv[i + 1] : ''; })();

// ═══════ 场景清单 ═══════
const scenes = [];
if (fs.existsSync(SC)) {
  for (const f of fs.readdirSync(SC)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
      if (j.id && j.name) scenes.push(j);
    } catch { /* ignore */ }
  }
}

// ═══════ 测量 ═══════
function bytesOf(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function findHandoff(text) {
  const t = text.replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && m[2].includes('当前交接')) { s = i; break; }
  }
  if (s < 0) return null;
  const level = lines[s].match(/^(#{1,6})/)[1].length;
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) { e = i; break; }
  }
  return lines.slice(s, e).join('\n');
}

// ═══════ --check ═══════
if (isCheck) {
  console.log(C.bold + 'L3 记忆层' + C.reset + C.dim + '  三层结构 + 体量红线' + C.reset);
  console.log();

  // 层 1：注入层（全局铁律）
  const injectFile = path.join(WB, '数据', '.dsh', 'AGENTS.md');
  const injectFile2 = path.join(WB, 'AGENTS.md');
  let injectBytes = 0;
  let injectPath = '';
  for (const p of [injectFile, injectFile2]) {
    if (fs.existsSync(p)) { injectBytes = bytesOf(p); injectPath = path.relative(WB, p); break; }
  }
  console.log(C.cyan + '① 注入层' + C.reset);
  if (injectBytes) {
    const ok = injectBytes <= LIMITS.injectBytes;
    console.log('  ' + (ok ? C.green + '✓' : C.yellow + '!') + C.reset + ' ' + injectPath + '  ' +
      (injectBytes / 1024).toFixed(1) + ' KB / ' + (LIMITS.injectBytes / 1024) + ' KB');
  } else {
    console.log('  ' + C.yellow + '!' + C.reset + ' 无 AGENTS.md（注入层未建）');
  }

  // 层 2：私有层
  console.log();
  console.log(C.cyan + '② 私有层' + C.reset + '（每场景 §〇 ≤4KB · 主文件 ≤25KB）');
  console.log('  ' + '场景'.padEnd(18) + '主文件'.padStart(10) + '   §〇'.padStart(10) + '   状态');
  console.log('  ' + '─'.repeat(58));
  let privOk = 0, privBad = 0;
  const privResults = [];
  for (const sc of scenes) {
    const f = path.join(MEM, sc.name, '场景私有记忆.md');
    if (!fs.existsSync(f)) {
      console.log('  ' + C.red + '无' + C.reset + '  ' + sc.name);
      privBad++;
      privResults.push({ scene: sc.id, ok: false, reason: '无记忆文件' });
      continue;
    }
    const total = bytesOf(f);
    const text = fs.readFileSync(f, 'utf8');
    const ho = findHandoff(text);
    const hoBytes = ho ? Buffer.byteLength(ho, 'utf8') : 0;
    const ok = total <= LIMITS.mainBytes && hoBytes <= LIMITS.handoffBytes;
    if (ok) privOk++; else privBad++;
    privResults.push({ scene: sc.id, total, handoff: hoBytes, ok });
    console.log('  ' + (ok ? C.green + '✓' : C.red + 'X') + C.reset + '  ' +
      sc.id.padEnd(18) +
      (total / 1024).toFixed(1).padStart(9) + ' KB' +
      (hoBytes / 1024).toFixed(1).padStart(9) + ' KB' +
      '   ' + (ok ? '' : (total > LIMITS.mainBytes ? '主文件超' : '§〇超')));
  }
  console.log();
  console.log('  私有层：' + (privBad === 0 ? C.green : C.red) + privOk + '/' + scenes.length + ' 通过' + C.reset);

  // 层 3：共享层
  console.log();
  console.log(C.cyan + '③ 共享层' + C.reset + '（四块板，需时才读）');
  const boards = [
    ['通知看板', '_跨场景通知.md'],
    ['待办板', '_待办.md'],
    ['总索引', '索引.md'],
    ['体检结果', '体检结果.json'],
  ];
  let boardOk = 0;
  for (const [name, file] of boards) {
    const p = path.join(SHARED, file);
    const exists = fs.existsSync(p);
    if (exists) boardOk++;
    console.log('  ' + (exists ? C.green + '✓' : C.red + 'X') + C.reset + ' ' + name.padEnd(12) + '  ' +
      (exists ? (bytesOf(p) / 1024).toFixed(1) + ' KB' : C.dim + '缺失' + C.reset));
  }
  console.log('  共享层：' + (boardOk === 4 ? C.green : C.yellow) + boardOk + '/4' + C.reset);

  // 汇总
  console.log();
  const allOk = privBad === 0 && boardOk === 4 && injectBytes > 0;
  console.log(C.bold + 'L3 结论：' + C.reset + (allOk ? C.green + '完整' : C.yellow + '有缺口' + C.reset));

  fs.writeFileSync(path.join(WB, '工具', 'memory-audit.json'), JSON.stringify({
    at: new Date().toISOString(),
    limits: LIMITS,
    inject: { bytes: injectBytes, path: injectPath },
    private: privResults,
    shared: { ok: boardOk, total: 4 },
  }, null, 2), 'utf8');

  process.exit(allOk ? 0 : 2);
}

// ═══════ --inject ═══════
if (isInject) {
  const sc = scenes.find(s => s.id === sceneArg || s.name === sceneArg);
  if (!sc) {
    console.error('找不到场景：' + sceneArg);
    process.exit(1);
  }

  const parts = [];

  // ① 全局铁律（如果有）
  const agentsMd = path.join(WB, '数据', '.dsh', 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    let t = fs.readFileSync(agentsMd, 'utf8');
    // 截断到 2KB
    if (Buffer.byteLength(t, 'utf8') > LIMITS.injectBytes) {
      t = t.slice(0, LIMITS.injectBytes);
    }
    parts.push('# 全局铁律\n\n' + t.trim());
  }

  // ② 定位卡
  const card = path.join(SC, sc.id + '-context.md');
  if (fs.existsSync(card)) {
    parts.push('# 我的身份\n\n' + fs.readFileSync(card, 'utf8').trim());
  }

  // ③ §〇 交接
  const memFile = path.join(MEM, sc.name, '场景私有记忆.md');
  if (fs.existsSync(memFile)) {
    const ho = findHandoff(fs.readFileSync(memFile, 'utf8'));
    if (ho) {
      let hoTrim = ho;
      if (Buffer.byteLength(hoTrim, 'utf8') > LIMITS.handoffBytes) {
        hoTrim = hoTrim.slice(0, LIMITS.handoffBytes) + '\n（已截断，完整内容见记忆文件）';
      }
      parts.push('# 上次交接\n\n' + hoTrim.trim());
    }
  }

  // ④ 共享层摘要（只给指针，不给全文）
  const todo = path.join(SHARED, '_待办.md');
  if (fs.existsSync(todo)) {
    const lines = fs.readFileSync(todo, 'utf8').split('\n').filter(l => l.trim().startsWith('-'));
    if (lines.length) {
      parts.push('# 待办\n\n' + lines.slice(-5).join('\n'));
    }
  }

  const text = parts.join('\n\n---\n\n');
  const bytes = Buffer.byteLength(text, 'utf8');

  console.log(C.bold + 'L3 注入文本' + C.reset + '  场景：' + sc.name);
  console.log();
  console.log(text);
  console.log();
  console.log(C.dim + '─'.repeat(60) + C.reset);
  console.log('总字节：' + bytes + '  (' + (bytes / 1024).toFixed(1) + ' KB)');
  console.log('红线  ：' + LIMITS.injectBytes + '  (' + (LIMITS.injectBytes / 1024).toFixed(1) + ' KB)');
  console.log(bytes <= LIMITS.injectBytes
    ? C.green + '✓ 在预算内' + C.reset
    : C.red + 'X 超出预算，需要精简' + C.reset);

  process.exit(bytes <= LIMITS.injectBytes ? 0 : 2);
}

console.log('用法：');
console.log('  node 工具\\memory.mjs --check');
console.log('  node 工具\\memory.mjs --inject --scene <id或名>');
