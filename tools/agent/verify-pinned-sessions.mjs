/**
 * 会话置顶（批次 Z.23）· 契约 + 接线验证
 *
 * 【要证明什么】
 *  ① 置顶是**本机视图偏好**：存 localStorage，刷新仍在；宿主没有置顶字段，不假装跨设备
 *  ② 归一化：只收非空字符串、去重、上限 50；存储损坏 → 空数组而不是崩
 *  ③ 排序：置顶项按置顶顺序在前，其余保持原顺序；置顶里已被删掉的会话自然跳过
 *  ④ 组件接线：行渲染共用一份（置顶区不会少按钮）、按钮有 aria-pressed、
 *     脚注分页统计的是「未置顶」列表
 *
 * 用法：node tools/agent/verify-pinned-sessions.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_PINNED_TSX';
const WEB_UI_DIR = path.resolve(import.meta.dirname, '..', '..', 'apps', 'vouch-web', 'src', 'web-ui');
const PNPM_STORE = path.resolve(WEB_UI_DIR, '..', '..', 'node_modules', '.pnpm');

function findTsxCli() {
  let versions;
  try {
    versions = readdirSync(PNPM_STORE).filter((n) => /^tsx@\d/.test(n));
  } catch {
    return null;
  }
  versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const dir of versions.reverse()) {
    const cli = path.join(PNPM_STORE, dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (existsSync(cli)) return cli;
  }
  return null;
}

if (process.env[RE_EXEC_ENV] !== '1') {
  const tsxCli = findTsxCli();
  if (!tsxCli) {
    console.error('');
    console.error('  四态: UNKNOWN —— 环境缺 tsx（本脚本要 import 界面实现，需 tsx 解析 `@/` 别名）');
    console.error('  修复: cd apps/vouch-web && pnpm install');
    console.error('');
    process.exit(2);
  }
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url)], {
    cwd: WEB_UI_DIR,
    stdio: 'inherit',
    env: { ...process.env, [RE_EXEC_ENV]: '1' },
  });
  process.exit(typeof child.status === 'number' ? child.status : 2);
}

const {
  PINNED_LIMIT,
  PINNED_STORAGE_KEY,
  isPinned,
  normalizePinned,
  orderSessionsWithPinned,
  readPinned,
  togglePinned,
  writePinned,
} = await import('@/app/layout/pinnedSessions');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  会话置顶 · 契约 + 接线');
console.log('  ' + '─'.repeat(72));

// ══ 一、归一化 ══
{
  t('★过滤非字符串/空串、去重并保持首次顺序',
    JSON.stringify(normalizePinned(['a', 'b', 'a', '', '  ', 1, null, 'c'])) === JSON.stringify(['a', 'b', 'c']));
  t('★不是数组 → 空数组（不抛）',
    normalizePinned(null).length === 0 && normalizePinned('a,b').length === 0 && normalizePinned({ 0: 'a' }).length === 0);
  t('★超过上限截断', normalizePinned(Array.from({ length: 80 }, (_, i) => 's' + i)).length === PINNED_LIMIT);
}

// ══ 二、存取 ══
{
  const mem = () => {
    const map = new Map();
    return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, v) };
  };
  t('未写过 → 空数组', readPinned(mem()).length === 0);
  t('★写入后能读回（真的落盘）',
    (() => {
      const s = mem();
      writePinned(['x', 'y'], s);
      return s.getItem(PINNED_STORAGE_KEY) === '["x","y"]' && readPinned(s).join() === 'x,y';
    })());
  t('★存储损坏 → 空数组，不抛',
    (() => {
      const s = mem();
      s.setItem(PINNED_STORAGE_KEY, '{oops');
      return readPinned(s).length === 0;
    })());
  t('★存储抛错（隐私模式）→ 读空、写不抛且返回归一化结果',
    (() => {
      const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
      return readPinned(boom).length === 0 && writePinned(['a', 'a', 2], boom).join() === 'a';
    })());
}

// ══ 三、切换 ══
{
  t('★未置顶 → 插到最前面', togglePinned(['b'], 'a').join() === 'a,b');
  t('★已置顶 → 移除', togglePinned(['a', 'b'], 'a').join() === 'b');
  t('空 id 不改动', togglePinned(['a'], '   ').join() === 'a');
  t('重复 id 不会写进去', togglePinned(['a', 'a'], 'b').join() === 'b,a');
  t('isPinned 只认完全相同的 id', isPinned(['a'], 'a') && !isPinned(['a'], 'A') && !isPinned(['a'], ''));
}

// ══ 四、排序 ══
{
  const sessions = [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }];
  const r = orderSessionsWithPinned(sessions, ['s3', 's1']);
  t('★置顶项按置顶顺序在前，其余保持原顺序',
    r.pinned.map((s) => s.sessionId).join() === 's3,s1' && r.rest.map((s) => s.sessionId).join() === 's2');
  const ghost = orderSessionsWithPinned(sessions, ['ghost', 's2']);
  t('★置顶里已删除的会话自然跳过（不产出空行）',
    ghost.pinned.map((s) => s.sessionId).join() === 's2' && ghost.rest.map((s) => s.sessionId).join() === 's1,s3');
  t('没有置顶 → 全部落在 rest 且顺序不变',
    orderSessionsWithPinned(sessions, []).rest.map((s) => s.sessionId).join() === 's1,s2,s3');
  t('★重复 id 的会话只出现一次',
    (() => {
      const dup = [{ sessionId: 's1' }, { sessionId: 's1' }, { sessionId: 's2' }];
      const x = orderSessionsWithPinned(dup, ['s1']);
      return x.pinned.length === 1 && x.rest.map((s) => s.sessionId).join() === 's2';
    })());
}

// ══ 五、组件接线 ══
{
  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('ncc__history-row'));
  t('找到渲染历史会话行的面板组件', !!tsxName, tsxName || '(未找到)');
  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★排序走 orderSessionsWithPinned（不在 JSX 里手写置顶优先）',
      /orderSessionsWithPinned\(historyItems, pinned\)/.test(tsx));
    t('★置顶状态从 localStorage 初始化、切换时落盘',
      /useState<string\[\]>\(\(\) => readPinned\(\)\)/.test(tsx) && /writePinned\(togglePinned\(cur, id\)\)/.test(tsx));
    t('★置顶区与普通区共用同一份行渲染（不会少按钮）',
      // 批次 Z.27 起行渲染多了可选参数 opts（置顶区传 { draggable: true }），
      // 仍是同一个函数，两处调用点都走它。
      /const historyRowJsx = \(s: SessionRow(?:, opts\?: \{[^}]*\})?\) => \(/.test(tsx)
        && (tsx.match(/historyRowJsx\(s/g) || []).length >= 2);
    t('★置顶按钮有 aria-pressed（可被读屏识别为开关）',
      /aria-pressed=\{pinnedSet\.has\(s\.sessionId\)\}/.test(tsx));
    t('置顶区有独立标题与可测试标记', /data-testid="ncc-history-pinned-title"/.test(tsx));
    t('★翻页脚注统计的是「未置顶」列表（置顶不参与分页）',
      /orderedHistory\.rest\.length > HISTORY_LIMIT/.test(tsx)
        && /historyCountLabel\(historyVisibleItems\.length, orderedHistory\.rest\.length\)/.test(tsx));
    t('置顶行有视觉标记（data-pinned）', /data-pinned=\{pinnedSet\.has\(s\.sessionId\) \? '1' : '0'\}/.test(tsx));
    t('★拖动排序：只有置顶区可拖（普通区是最近消息顺序，拖它没有语义）',
      /draggable=\{opts\?\.draggable === true\}/.test(tsx)
        && /historyRowJsx\(s, \{ draggable: true \}\)/.test(tsx));
    t('★拖动排序：drop 走 movePinned 并落盘（不是只改内存）',
      /writePinned\(movePinned\(cur, fromId, toId\)\)/.test(tsx));
    t('★拖动排序：拖动中读 ref 而不是 state（否则 drop 拿到上一帧旧值）',
      /draggingPinRef\.current = s\.sessionId/.test(tsx)
        && /const fromId = draggingPinRef\.current/.test(tsx));
    t('★键盘可达：Alt+↑/↓ 也能排序（拖动之外的第二条路径）',
      /movePinBy\(s\.sessionId, -1\)/.test(tsx) && /movePinBy\(s\.sessionId, 1\)/.test(tsx));
    t('抓手只在置顶行渲染（普通行没有可拖的语义）',
      /data-testid="ncc-pinned-grip"/.test(tsx) && /opts\?\.draggable && \(/.test(tsx));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 置顶是本机偏好，归一化/排序/接线都对得上'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;