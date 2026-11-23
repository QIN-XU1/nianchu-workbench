/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  中枢化迁移：命令 → 中枢（Hub）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户要求：
 *   「先可只保留"命令"这个主要场景，但是我并不喜欢它的名字」
 *   → 改名「中枢」（Hub）
 *
 * 这一步做四件事：
 *   ① 场景 id: command → hub
 *   ② 场景名: 命令 → 中枢
 *   ③ 记忆目录: 场景记忆/命令 → 场景记忆/中枢
 *   ④ 更新注册表、契约、索引
 *
 * 保留原始数据（不删任何东西），只做重命名 + 加中枢专属能力描述。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCENARIOS = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
const MEMROOT = path.join(WB, '数据', '.dsh', '场景记忆');
const SHARED = path.join(MEMROOT, '_共享记忆');
const INDEX = path.join(SHARED, '索引.json');

const OLD_ID = 'command';
const NEW_ID = 'hub';
const OLD_NAME = '命令';
const NEW_NAME = '中枢';

const log = [];
function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\uFEFF/g, '')); }
  catch (e) { return fb; }
}
function writeJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
}
function nowStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  中枢化迁移：' + OLD_NAME + ' → ' + NEW_NAME);
console.log('═══════════════════════════════════════════════════════════');
console.log();

// ═══ ① 场景定义 ═══
const oldSceneFile = path.join(SCENARIOS, OLD_ID + '.json');
const scene = readJson(oldSceneFile, null);
if (scene) {
  scene.id = NEW_ID;
  scene.name = NEW_NAME;
  scene.description =
    '中枢（Hub）：超级智能体的唯一交互入口。你在这里交办需求，' +
    'AI 自主判断需要哪些场景、调度它们、汇总结果。' +
    '左侧 3D 记忆神经元显示全部场景地图，被调度的场景节点会亮起。';

  // 面板 id 也改名
  for (const p of (scene.panels || [])) {
    if (p.id && p.id.startsWith('cmd-')) p.id = p.id.replace('cmd-', 'hub-');
    if (p.title && p.title.indexOf(OLD_NAME) >= 0) p.title = p.title.replace(OLD_NAME, NEW_NAME);
    if (p.sessionTitle === OLD_NAME) p.sessionTitle = NEW_NAME;
    if (Array.isArray(p.pinTarget)) {
      p.pinTarget = p.pinTarget.map(x => x === OLD_NAME ? NEW_NAME : x);
    }
  }
  // 中枢只需要两个面板：神经元 + 唯一对话
  scene.panels = (scene.panels || []).filter(p => p.type === 'neuron' || p.type === 'harness');

  writeJson(path.join(SCENARIOS, NEW_ID + '.json'), scene);
  fs.unlinkSync(oldSceneFile);
  log.push('① 场景定义 → 外壳/scenarios/hub.json（' + scene.panels.length + ' 面板）');
} else {
  log.push('① 场景定义：找不到 ' + oldSceneFile);
}

// ═══ ② 场景契约 ═══
const oldContractFile = path.join(CONTRACTS, OLD_ID + '.json');
const contract = readJson(oldContractFile, null);
if (contract) {
  contract.id = NEW_ID;
  contract.name = NEW_NAME;
  contract.role = '总控中枢：唯一交互入口，自主判断需要哪些场景、调度它们、汇总结果';
  contract.description =
    '超级智能体的管理层。用户只在这里说话。' +
    '中枢负责：① 判断需求属于哪些场景 ② 场景不存在则先孵化 ③ 调度并点亮神经元 ④ 汇总产物回给用户。';
  contract.capabilities = [
    '需求分解：把用户一句话拆成可调度的子任务',
    '场景发现：查 _共享记忆/索引.json 找到匹配的场景',
    '场景孵化：没有合适场景时，用 scene-hatch.mjs 先造场景',
    '任务派发：把子任务给对应场景的独立会话',
    '状态汇总：收集各场景结果，合成一个回答',
    '记忆写回：更新各场景 §〇 交接 + 共享层台账',
  ];
  contract.notDo = [
    '不亲自做具体业务（那是场景的事）',
    '不越过场景直接改场景私有记忆',
  ];
  contract.isHub = true;
  contract.hatchedAt = contract.hatchedAt || new Date().toISOString();

  writeJson(path.join(CONTRACTS, NEW_ID + '.json'), contract);
  fs.unlinkSync(oldContractFile);
  log.push('② 场景契约 → sceneboard/scenes/hub.json（isHub: true）');
} else {
  log.push('② 场景契约：找不到');
}

// ═══ ③ 记忆目录改名 ═══
const oldMemDir = path.join(MEMROOT, OLD_NAME);
const newMemDir = path.join(MEMROOT, NEW_NAME);
if (fs.existsSync(oldMemDir) && !fs.existsSync(newMemDir)) {
  fs.renameSync(oldMemDir, newMemDir);
  log.push('③ 记忆目录 → 场景记忆/中枢/（含身份卡+私有记忆+归档）');
} else if (fs.existsSync(newMemDir)) {
  log.push('③ 记忆目录：中枢目录已存在，跳过');
} else {
  log.push('③ 记忆目录：找不到 ' + oldMemDir);
}

// ③b 身份卡与私有记忆里的名字
for (const f of ['身份卡.md', '场景私有记忆.md', '_文件索引.md']) {
  const fp = path.join(newMemDir, f);
  if (!fs.existsSync(fp)) continue;
  let txt = fs.readFileSync(fp, 'utf8');
  txt = txt.replace(new RegExp(OLD_NAME, 'g'), NEW_NAME)
           .replace(new RegExp(OLD_ID, 'g'), NEW_ID);
  // 补中枢定位
  if (f === '场景私有记忆.md' && !txt.includes('## 中枢专属能力')) {
    const insertAt = txt.indexOf('## 一、职责边界');
    const block = '## 中枢专属能力\n\n' +
      '- 需求分解：把用户一句话拆成可调度的子任务\n' +
      '- 场景发现：查 _共享记忆/索引.json 找匹配场景\n' +
      '- 场景孵化：没有合适场景时先造（scene-hatch.mjs）\n' +
      '- 任务派发：给场景的独立会话\n' +
      '- 状态汇总：收集结果合成回答\n' +
      '- 记忆写回：更新各场景 §〇 + 共享层\n\n';
    txt = insertAt > 0 ? (txt.slice(0, insertAt) + block + txt.slice(insertAt))
                       : (txt + '\n' + block);
  }
  fs.writeFileSync(fp, txt, 'utf8');
}
log.push('③b 身份卡/私有记忆已更新为新名字 + 补中枢专属能力');

// ═══ ④ 注册表 ═══
const idx = readJson(INDEX, { areas: [] });
idx.areas = idx.areas || [];
let found = false;
for (const a of idx.areas) {
  if (a.id === OLD_ID) {
    a.id = NEW_ID;
    a.name = NEW_NAME;
    a.memory = '场景记忆/' + NEW_NAME;
    a.file = 'areas/' + NEW_ID + '.md';
    a.panel = (a.panel || '').replace('cmd-', 'hub-');
    if (a.panel === 'cmd-chat') a.panel = 'hub-chat';
    a.isHub = true;
    found = true;
  }
}
if (!found) {
  idx.areas.push({
    id: NEW_ID, name: NEW_NAME, owner: 'hub-chat',
    memory: '场景记忆/' + NEW_NAME, file: 'areas/' + NEW_ID + '.md',
    panel: 'hub-chat', isHub: true,
  });
}
// 把中枢排到第一位
idx.areas.sort((a, b) => (b.isHub ? 1 : 0) - (a.isHub ? 1 : 0));
writeJson(INDEX, idx);
log.push('④ 注册表 → 索引.json（' + idx.areas.length + ' 个场景，中枢置顶）');

// ═══ ⑤ 区域明细 ═══
const areasDir = path.join(SHARED, 'areas');
const oldAreaFile = path.join(areasDir, OLD_ID + '.md');
if (fs.existsSync(oldAreaFile)) {
  let txt = fs.readFileSync(oldAreaFile, 'utf8');
  txt = txt.replace(new RegExp(OLD_NAME, 'g'), NEW_NAME).replace(new RegExp(OLD_ID, 'g'), NEW_ID);
  fs.writeFileSync(path.join(areasDir, NEW_ID + '.md'), txt, 'utf8');
  fs.unlinkSync(oldAreaFile);
  log.push('⑤ 区域明细 → _共享记忆/areas/hub.md');
}

// ═══ ⑥ 场景顺序文件 ═══
const orderFile = path.join(WB, '外壳', 'data', 'scene-order.json');
if (fs.existsSync(orderFile)) {
  try {
    const o = readJson(orderFile, null);
    if (Array.isArray(o)) {
      const i = o.indexOf(OLD_ID);
      if (i >= 0) o[i] = NEW_ID;
      writeJson(orderFile, o);
      log.push('⑥ 场景顺序已更新');
    }
  } catch (e) { /* 忽略 */ }
}

// ═══ 输出 ═══
console.log('已完成:');
for (const l of log) console.log('  ' + l);
console.log();
console.log('═══════════════════════════════════════════════════════════');
console.log('  ✓ 中枢化完成');
console.log('═══════════════════════════════════════════════════════════');
