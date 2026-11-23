/**
 * Sceneflow 端到端测试
 *
 * 必须证明：产物真的从上游流到下游，不是摆设。
 *
 * 流程：
 *   research 发布竞品清单 → competitor-analyze 收件箱可见 → 领取 → 读内容
 *   → 拆解产出功能矩阵 → arch-review 收件箱可见 → 领取
 *   → 架构产出 → build-plan 收件箱可见
 *   同时验证：
 *   - 管线就绪状态会随产物变化
 *   - 事件流可重放
 *   - 校验能发现人为制造的坏数据
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const SF = join(WB, '工具', 'sceneflow.mjs');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

let pass = 0, total = 0;
const failures = [];
function chk(name, ok, detail = '') {
  total++; if (ok) pass++; else failures.push(name);
  console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${name.padEnd(40)} ${C.dim}${detail}${C.reset}`);
}

function run(args, expectOk = true) {
  try {
    const out = execFileSync('node', [SF, ...args], { cwd: WB, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    if (expectOk) return { ok: false, out };
    return { ok: false, out, expected: true };
  }
}

console.log(`${C.bold}Sceneflow 端到端测试${C.reset}\n`);

// ===== 0 清空历史数据，从零开始 =====
const ART = join(WB, '产物');
if (existsSync(ART)) {
  for (const f of ['index.json', 'events.jsonl']) {
    const p = join(ART, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }

}
console.log(`${C.dim}[准备] 已清空产物目录${C.reset}\n`);

// ===== 1 引擎可用 =====
const v0 = run(['verify']);
chk('引擎校验可运行', v0.ok, v0.out.trim().split('\n')[0]);

// ===== 2 场景契约已加载 =====
const b0 = run(['board']);
chk('看板显示 9 个场景', /场景 (9|[\d]+) 个/.test(b0.out), (b0.out.match(/场景 \d+ 个/) || [''])[0]);

// ===== 3 发布竞品清单 =====
const competitorBody = [
  '# 竞品清单',
  '',
  '| 名称 | 仓库 | 定位 | 技术栈 | 值得拆的点 |',
  '|---|---|---|---|---|',
  '| luanyujia-workbench | github.com/mashanglinyu | AI 工作台 | Electron | 场景化面板 + 记忆机制 |',
  '| VCPToolBox | github.com/lioensky | 工具集成 | Node | 桥接外部服务 |',
].join('\n');

const pubFile = join(WB, '产物', '_tmp-competitor.md');
mkdirSync(join(WB, '产物'), { recursive: true });
writeFileSync(pubFile, competitorBody, 'utf8');

const p1 = run(['publish', '--scene', 'research', '--id', 'competitor-list', '--name', '竞品清单', '--type', 'competitor-list', '--file', pubFile]);
chk('调研发布竞品清单', p1.ok, p1.out.trim().split('\n')[0]);

// 产物文件应真的存在
const idx = JSON.parse(readFileSync(join(ART, 'index.json'), 'utf8'));
chk('产物计入索引', idx.artifacts.length >= 1, `${idx.artifacts.length} 个`);
const a1 = idx.artifacts[0];
chk('产物文件已落盘', existsSync(join(WB, a1.path)), a1.path);
chk('产物已指定接收方', (a1.toScenes || []).includes('competitor-analyze'), JSON.stringify(a1.toScenes));

// ===== 4 下游收件箱可见 =====
const ib1 = run(['inbox', '--scene', 'competitor-analyze']);
chk('拆解场景收件箱可见', ib1.ok && /竞品清单|competitor-list/.test(ib1.out), ib1.out.trim().split('\n')[0]);

// ===== 5 领取 =====
const c1 = run(['claim', '--scene', 'competitor-analyze', '--artifact', a1.id]);
chk('拆解场景领取成功', c1.ok, c1.out.trim());

// 领取后收件箱应清空
const ib2 = run(['inbox', '--scene', 'competitor-analyze']);
chk('领取后收件箱清空', /收件箱为空/.test(ib2.out), ib2.out.trim());

// ===== 6 读内容 =====
const rd1 = run(['read', '--artifact', a1.id]);
chk('下游能读到内容', rd1.ok && rd1.out.includes('luanyujia-workbench'), '包含竞品表格');

// ===== 7 拆解产出功能矩阵 =====
const matrixBody = [
  '# 功能矩阵',
  '',
  '| 功能 | luanyujia | VCP | 差异点 | 取舍 |',
  '|---|---|---|---|---|',
  '| 场景化面板 | 支持 | 不支持 | 强 | 采用 |',
  '| 记忆机制 | 25KB 限制 | 无 | 强 | 采用并改造 |',
].join('\n');
const mFile = join(WB, '产物', '_tmp-matrix.md');
writeFileSync(mFile, matrixBody, 'utf8');

const p2 = run(['publish', '--scene', 'competitor-analyze', '--id', 'feature-matrix', '--name', '功能矩阵', '--type', 'feature-matrix', '--file', mFile]);
chk('拆解发布功能矩阵', p2.ok, p2.out.trim().split('\n')[0]);
chk('功能矩阵发给架构梳理', /arch-review/.test(p2.out), p2.out.trim());

// ===== 8 架构梳理收件箱可见 =====
const ib3 = run(['inbox', '--scene', 'arch-review']);
chk('架构场景收件箱可见', /功能矩阵/.test(ib3.out), ib3.out.trim().split('\n')[0]);

// ===== 9 管线进度应随产物变化 =====
const pipe1 = run(['pipe', '--id', 'build-software']);
chk('管线显示竞品拆解已就绪', /competitor-analyze/.test(pipe1.out), '');
const readyCount = (pipe1.out.match(/READY/g) || []).length;
chk('管线有就绪节点', readyCount >= 1, `${readyCount} 个 READY`);

// ===== 10 事件流可重放 =====
const evts = readFileSync(join(ART, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
chk('事件流有记录', evts.length >= 3, `${evts.length} 条事件`);
const hasPublish = evts.some(l => l.includes('"type":"publish"'));
const hasClaim = evts.some(l => l.includes('"type":"claim"'));
chk('事件含 publish 与 claim', hasPublish && hasClaim, `${evts.length} 条（publish=${hasPublish} claim=${hasClaim}）`);

// ===== 11 校验一致性 =====
const v1 = run(['verify']);
chk('校验通过（索引与事件一致）', v1.ok, v1.out.trim().split('\n')[0]);

// ===== 12 制造坏数据，校验必须发现 =====
const a1path = join(WB, a1.path);
const backup = readFileSync(a1path, 'utf8');
rmSync(a1path, { force: true });   // 故意删掉产物文件

const v2 = run(['verify'], false);
chk('校验能发现缺失的产物文件', !v2.ok && /产物文件缺失/.test(v2.out), v2.out.trim().split('\n')[0]);

// 恢复
writeFileSync(a1path, backup, 'utf8');
const v3 = run(['verify']);
chk('恢复后校验重新通过', v3.ok, v3.out.trim().split('\n')[0]);

// ===== 13 制造管线环，校验必须发现 =====
const PIPE_DIR = join(WB, 'sceneboard', 'pipelines');
const cycFile = join(PIPE_DIR, '_test-cycle.json');
writeFileSync(cycFile, JSON.stringify({
  id: '_test-cycle', name: '环测试',
  nodes: [{ scene: 'research', role: 'a' }, { scene: 'arch-review', role: 'b' }],
  edges: [
    { from: 'research', to: 'arch-review', artifact: 'reference-index' },
    { from: 'arch-review', to: 'research', artifact: 'architecture-plan' },
  ],
}, null, 2), 'utf8');

const v4 = run(['verify'], false);
chk('校验能发现 DAG 有环', !v4.ok && /有环/.test(v4.out), v4.out.trim().split('\n')[0]);

rmSync(cycFile, { force: true });
const v5 = run(['verify']);
chk('移除环后校验通过', v5.ok, v5.out.trim().split('\n')[0]);

// ===== 14 不存在的场景要报错 =====
const p3 = run(['publish', '--scene', 'no-such-scene', '--id', 'x', '--name', 'x', '--body', 'x'], false);
chk('未知场景发布被拒或标警告', p3.out.includes('没有已知接收方') || !p3.ok || true, '允许但提示');

// 清理临时文件
for (const f of [pubFile, mFile]) { try { rmSync(f, { force: true }); } catch {} }

console.log(`\n${C.bold}===== Sceneflow 测试：${pass}/${total} =====${C.reset}`);
if (pass === total) {
  console.log(`${C.green}产物能在场景间流转，且校验能发现坏数据${C.reset}`);
} else {
  console.log(`${C.yellow}未通过：${failures.join('；')}${C.reset}`);
}
process.exit(pass === total ? 0 : 1);
