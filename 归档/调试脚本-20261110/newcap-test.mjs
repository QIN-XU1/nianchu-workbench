/**
 * 新能力的统一度量（可回归）
 *
 * 覆盖本轮新增的 5 个模块：
 *   1. capabilities  能力开关（默认全关 + 成本提醒）
 *   2. induct        自动归纳（判据 + 去重 + 不自动写）
 *   3. boards        共享层四块板
 *   4. collab        场景间协作（四件套强制）
 *   5. bridge        桥（开关 + 机密闸 + 未就绪报错）
 *
 * 每一项都必须"能失败"——否则不可信。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

function run(script, args = []) {
  try {
    const out = execFileSync('node', [join(HERE, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: join(HERE, '..'),
    });
    return { code: 0, out: out.replace(/\x1b\[[0-9;]*m/g, '') };
  } catch (e) {
    return { code: e.status ?? 1, out: ((e.stdout || '') + (e.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '') };
  }
}

const results = [];
function rec(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${id.padEnd(4)} ${name}`);
  console.log(`       ${C.dim}${detail}${C.reset}`);
}

// ---------- N1 能力开关 ----------
{
  const r = run('capabilities.mjs', ['list']);
  const allOff = /当前没有开着的额外能力/.test(r.out);
  const hasDefault = /○ 关/.test(r.out);
  rec('N1', '能力开关默认全关', r.code === 0 && allOff && hasDefault,
    `默认全关=${allOff} 有开关项=${hasDefault}`);
}

// ---------- N2 能力开关成本提醒 ----------
{
  // 开一个高成本项，看是否显示 token
  run('capabilities.mjs', ['on', 'mcp.cua-driver']);
  const r = run('capabilities.mjs', ['list']);
  const showsCost = /每轮固定 token 约 26800/.test(r.out);
  run('capabilities.mjs', ['off', 'mcp']);
  rec('N2', '高成本能力有 token 提醒', showsCost, `显示 26800=${showsCost}`);
}

// ---------- N3 自动归纳判据 ----------
{
  const r = run('induct.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N3', '自动归纳判据有效', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N4 自动归纳不自动写记忆 ----------
{
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { propose } = await import('./induct.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'induct-'));
  mkdirSync(dir, { recursive: true });
  const memPath = join(dir, 'MEMORY.md');
  const before = '# 记忆\n\n## 核心职责\n\n- 测试\n';
  writeFileSync(memPath, before, 'utf8');

  const r = propose(dir, '修好了某个 bug\n新增了某模块', { source: 'selftest' });
  const memUnchanged = readFileSync(memPath, 'utf8') === before;
  const hasReview = r.file && existsSync(r.file);

  rec('N4', '自动归纳只提候选不改记忆', memUnchanged && hasReview,
    `记忆未变=${memUnchanged} 有候选文件=${hasReview}`);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- N5 四块板 ----------
{
  const r = run('boards.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N5', '共享层四块板纪律', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N6 协作四件套强制 ----------
{
  const r = run('collab.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N6', '协作请求四件套强制', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N7 桥：关闭时必须拒绝 ----------
{
  run('capabilities.mjs', ['off', 'bridge']);
  const r = run('bridge/bridge.mjs', ['ask', 'deepseek', '测试']);
  const blocked = /CAPABILITY_OFF/.test(r.out) && /关闭状态/.test(r.out);
  rec('N7', '桥默认关闭时拒绝调用', blocked, `拒绝=${blocked} code=CAPABILITY_OFF`);
}

// ---------- N8 桥：机密闸 ----------
{
  const r = run('bridge/bridge.mjs', ['selftest', 'deepseek']);
  const gate = /机密闸拦截密码/.test(r.out);
  const noEmpty = /未就绪时明确报错（不返回空串）/.test(r.out);
  rec('N8', '桥机密闸 + 未就绪报错', gate && noEmpty, `机密闸=${gate} 不返回空串=${noEmpty}`);
}

// ---------- N10 上下文注入 ----------
{
  const r = run('inject.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N10', '上下文注入规则有效', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N11 注入预算 ----------
{
  const r = run('inject.mjs', ['show', 'docs-index']);
  const m = r.out.match(/实际 (\d+) 字节/);
  const inBudget = /在预算内/.test(r.out);
  rec('N11', '注入在预算内且安静', inBudget && m && Number(m[1]) < 1024,
    m ? `${m[1]} 字节（预算 8192）` : '无法解析');
}

// ---------- N12 授权模式（observe 默认） ----------
{
  const r = run('auth.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N12', '授权模式 observe 默认且只记不干', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N13 AI 不能改授权 ----------
{
  // 直接调 auth.setMode(by='ai') 验证被拒
  const { setMode } = await import('./auth.mjs');
  const r = setMode('auto', { by: 'ai', reason: 'selftest' });
  rec('N13', 'AI 不能改变授权', !r.ok && /只有人/.test(r.error),
    r.ok ? 'AI 竟然能改（严重）' : '被拒绝');
}

// ---------- N14 外壳哨兵 ----------
{
  const r = run('shell-guard.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N14', '外壳哨兵（根目录/临时文件）', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N15 桥工具化三重门控 ----------
{
  const r = run('ask.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N15', '桥工具化三重门控', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N16 MCP 客户端协议 ----------
{
  const r = run('mcp.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N16', 'MCP 客户端协议实现', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N17 MCP 端到端（开关→真实调用） ----------
{
  const r = run('mcp-e2e.mjs', []);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N17', 'MCP 端到端可用', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N18 会话绑定与防串台 ----------
{
  const r = run('sessions.mjs', ['selftest']);
  const m = r.out.match(/：(\d+)\/(\d+)/);
  rec('N18', '会话绑定防串台', r.code === 0 && m && Number(m[1]) === Number(m[2]),
    m ? `${m[1]}/${m[2]}` : '无法解析');
}

// ---------- N9 身份认领不猜 ----------
{
  const r = run('identity.mjs', ['claim', 'not-a-real-session']);
  const refuse = /不在身份索引表里/.test(r.out) && /按普通会话处理/.test(r.out);
  rec('N9', '身份认领不猜', refuse && r.code === 1, `拒绝=${refuse} exit=${r.code}`);
}

const passed = results.filter(x => x.ok).length;
console.log(`\n${C.bold}===== 新能力度量：${passed}/${results.length} =====${C.reset}`);
const allOk = passed === results.length;
console.log(allOk
  ? `${C.green}新能力全部可用${C.reset}`
  : `${C.yellow}有项未通过——见上面逐项${C.reset}`);

const { writeFileSync } = await import('node:fs');
writeFileSync(join(HERE, 'capabilities-report.json'),
  JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2), 'utf8');

process.exit(allOk ? 0 : 1);
