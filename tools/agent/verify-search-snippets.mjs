/**
 * 会话搜索命中片段（批次 Z.15 / 坐标修正 Z.19）· 数据契约验证
 *
 * 【要证明什么】
 *  ① 片段抽取：大小写不敏感、每条只取**第一处**、前后各 24 字、超长补「…」、
 *     空查询/无命中返回空数组（界面不会渲染「假空面板」）
 *  ② ★两套坐标不能混：`searchMatches` 是 msgs 下标，`searchIdx` 是命中列表序号，
 *     当前项必须经 `activeResultMsgIndex` 换算；换算错时界面「看起来正常但选错了那条」
 *  ③ 换算的边界：越界收敛、非数字当第 0 条、空命中返回 -1（不是 0）
 *  ④ 组件真的用了这个换算，且不再直接比 `activeMatch === sn.msgIndex`
 *
 * 关键：**直接 import 界面那一份实现**（`app/layout/searchSnippets.ts`），不重写等价逻辑。
 *
 * 用法：node tools/agent/verify-search-snippets.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN（环境缺 tsx）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RE_EXEC_ENV = 'DSH_VERIFY_SEARCH_SNIPPETS_TSX';
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

const { activeResultMsgIndex, extractSnippets } = await import('@/app/layout/searchSnippets');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  会话搜索命中片段 · 数据契约 + 坐标换算');
console.log('  ' + '─'.repeat(72));

// ══ 一、片段抽取 ══
{
  const msgs = [
    { role: 'user', content: '帮我看看这个报错' },
    { role: 'assistant', content: '这个报错通常是因为端口被占用，先检查 3002 端口。' },
    { role: 'user', content: '端口检查过了没问题' },
    { role: 'assistant', content: '那就再检查一下防火墙规则。' },
  ];

  const hit = extractSnippets(msgs, '端口');
  t('★命中按消息顺序返回（msgIndex 指向原消息）',
    JSON.stringify(hit.map((x) => x.msgIndex)) === JSON.stringify([1, 2]),
    hit.map((x) => x.msgIndex).join(','));
  t('★大小写不敏感，且匹配词原样保留',
    (() => { const r = extractSnippets([{ role: 'user', content: 'Hello World' }], 'hello'); return r[0]?.match === 'Hello'; })());
  t('★每条消息只取第一处（不重复出条目）',
    extractSnippets([{ role: 'user', content: '端口 端口 端口' }], '端口').length === 1);
  t('超长两侧补省略号',
    (() => {
      const r = extractSnippets([{ role: 'assistant', content: 'a'.repeat(60) + '命中词' + 'b'.repeat(60) }], '命中词', { radius: 10 });
      return r[0].before === '…' + 'a'.repeat(10) && r[0].after === 'b'.repeat(10) + '…';
    })());
  t('命中在开头/结尾时不补多余省略号',
    (() => {
      const r = extractSnippets([{ role: 'user', content: '端口被占用' }], '端口', { radius: 4 });
      return r[0].before === '' && r[0].after === '被占用';
    })());
  t('★limit 截断（默认 5，可下调）',
    (() => {
      const many = Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: '关键词' + i }));
      return extractSnippets(many, '关键词').length === 5 && extractSnippets(many, '关键词', { limit: 2 }).length === 2;
    })());
  t('★空查询 / 无命中 / null 输入 → 空数组（不渲染假面板）',
    extractSnippets(msgs, '   ').length === 0
      && extractSnippets(msgs, '不存在的词').length === 0
      && extractSnippets(null, 'x').length === 0);
}

// ══ 二、坐标换算（本批的修复点）══
{
  t('★第 0 条命中 → msgs 下标（不是命中序号 0）', activeResultMsgIndex([5, 7, 9], 0) === 5);
  t('★第 1 条命中 → msgs 下标 7（两套坐标直接比会指错）', activeResultMsgIndex([5, 7, 9], 1) === 7);
  t('★下标越界收敛到最后一条（界面不会给非法下标）',
    activeResultMsgIndex([5, 7, 9], 99) === 9 && activeResultMsgIndex([5, 7, 9], -3) === 5);
  t('★非数字 / null / undefined 当作第 0 条（不把 NaN 当坐标）',
    activeResultMsgIndex([5, 7], Number.NaN) === 5
      && activeResultMsgIndex([5, 7], null) === 5
      && activeResultMsgIndex([5, 7], undefined) === 5);
  t('★没有命中 → -1（0 会误指第一条消息）',
    activeResultMsgIndex([], 0) === -1 && activeResultMsgIndex(null, 0) === -1);
  t('单条命中时任意序号都指向它', activeResultMsgIndex([4], 7) === 4);
  t('★两套坐标混比会立刻暴露：错写法 activeMatch===msgIndex 在 [5,7]+idx1 上判错',
    // 正确的「当前项」是 msgs[7]；而旧写法拿 searchIdx(1) 去比 msgIndex，得到 1===7 假
    activeResultMsgIndex([5, 7], 1) === 7 && [5, 7][1] === 7 && 1 !== 7);
}

// ══ 三、组件绑定（防有人再把坐标直接比回去）══
{
  const layoutDir = path.join(WEB_UI_DIR, 'src', 'app', 'layout');
  const files = readdirSync(layoutDir);
  const tsxName = files.find((f) => f.endsWith('.tsx') && !f.includes('.test.') && readFileSync(path.join(layoutDir, f), 'utf8').includes('ncc__searchlist'));
  t('找到渲染搜索命中列表的面板组件', !!tsxName, tsxName || '(未找到)');
  if (tsxName) {
    const tsx = readFileSync(path.join(layoutDir, tsxName), 'utf8');
    t('★组件从 searchSnippets 导入 activeResultMsgIndex（换算只有一份）',
      /import \{[^}]*activeResultMsgIndex[^}]*\} from '\.\/searchSnippets'/.test(tsx));
    t('★组件不再直接比 activeMatch === sn.msgIndex（这正是 Z.15 的错）',
      !/aria-selected=\{activeMatch === sn\.msgIndex\}/.test(tsx));
    t('★命中项用 msgs 坐标标注（data-result-msg），不再借用消息的 data-mid',
      /data-result-msg=\{sn\.msgIndex\}/.test(tsx) && !/data-mid=\{sn\.msgIndex\}/.test(tsx));
    t('当前命中项有独立标记（data-result-active），便于复算与测试',
      /data-result-active=\{activeMsg === sn\.msgIndex \? '1' : '0'\}/.test(tsx));
    t('消息列表仍按 msgs 下标标 data-hit（与命中项同坐标）',
      /data-hit=\{activeMatch === mi \? '1' : '0'\}/.test(tsx));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 片段抽取与坐标换算一致，组件只走一份换算、不再混坐标'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;