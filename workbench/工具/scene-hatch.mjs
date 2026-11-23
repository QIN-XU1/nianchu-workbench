/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  场景孵化器（Scene Hatcher）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户核心要求：
 *   「当我提出了一份任务，但是没有相应场景，则必须先构建场景」
 *
 * 这是"自我进化"的执行器 —— 超级智能体发现自己缺能力时，自己长出能力。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  一个场景 = 五件套（缺一不可）
 * ───────────────────────────────────────────────────────────────────────────
 *   ① 场景契约  sceneboard/scenes/<id>.json
 *      定义：role（这场景干什么）/ inputs / outputs（产物给谁）
 *      → 这是 AI 判断"要不要用这个场景"的依据
 *
 *   ② 场景定义  外壳/scenarios/<id>.json
 *      定义：panels（用哪些面板）/ layout
 *      → 这是 UI 渲染的依据
 *
 *   ③ 身份卡    场景记忆/<中文名>/身份卡.md
 *      定义：这个场景是谁 / 面板清单
 *      → 这是场景 AI 启动时读的自我认知
 *
 *   ④ 私有记忆  场景记忆/<中文名>/场景私有记忆.md
 *      定义：§〇交接（≤4KB）+ 核心职责 + 职责边界 + 坑
 *      → 这是 luanyujia 三层记忆的核心，场景 AI 只读自己的
 *
 *   ⑤ 注册表    _共享记忆/索引.json 增加一条
 *      定义：id / name / owner / memory / file / panel
 *      → 这是中枢查询"有哪些场景"的唯一真源
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  用法
 * ───────────────────────────────────────────────────────────────────────────
 *   # 从描述自动建场景
 *   node 工具\scene-hatch.mjs --create --id xxx --name "中文名" --role "一句话职责"
 *
 *   # 从 AI 生成的 JSON 建场景（最适合自动化）
 *   node 工具\scene-hatch.mjs --create --spec spec.json
 *
 *   # 列出所有场景（AI 调度前先查这个）
 *   node 工具\scene-hatch.mjs --list
 *
 *   # 校验某场景五件套是否齐全
 *   node 工具\scene-hatch.mjs --check <id>
 *
 *   # 校验所有场景
 *   node 工具\scene-hatch.mjs --check-all
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  AI 调度决策流程（中枢用）
 * ───────────────────────────────────────────────────────────────────────────
 *   接到需求
 *     ↓
 *   node scene-hatch.mjs --list           ← 查现有场景的 role
 *     ↓
 *   role 能覆盖需求？
 *     ├── 是 → 直接派给那个场景
 *     └── 否 → node scene-hatch.mjs --create --spec ... ← 先造场景
 *                 ↓
 *               再造完派单
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════════
//  路径
// ═══════════════════════════════════════════════════════════════
// ⚠ Windows 上 new URL().pathname 会带前导斜杠（/D:/...），
//    必须用 fileURLToPath 才能正确解析。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');                       // workbench
const SCENARIOS = path.join(WB, '外壳', 'scenarios');       // 场景定义
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');    // 场景契约
const MEMROOT = path.join(WB, '数据', '.dsh', '场景记忆'); // 记忆
const SHARED = path.join(MEMROOT, '_共享记忆');
const INDEX = path.join(SHARED, '索引.json');               // 注册表

// ═══════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════
function readJson(p, fallback) {
  try {
    const t = fs.readFileSync(p, 'utf8').replace(/\uFEFF/g, '');
    return JSON.parse(t);
  } catch (e) {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function nowDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 中文名 → 安全的目录名（保留中文，去掉路径非法字符） */
function safeDirName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed';
}

// ═══════════════════════════════════════════════════════════════
//  ① 读现有场景（AI 调度前必查）
// ═══════════════════════════════════════════════════════════════
function listScenes() {
  const idx = readJson(INDEX, { areas: [] });
  const areas = idx.areas || [];

  return areas.map(a => {
    const contract = readJson(path.join(CONTRACTS, a.id + '.json'), null);
    const scenJson = readJson(path.join(SCENARIOS, a.id + '.json'), null);
    const memDir = path.join(MEMROOT, safeDirName(a.name));
    return {
      id: a.id,
      name: a.name,
      owner: a.owner,
      memory: a.memory,
      // 契约里的定位（AI 判断"用不用它"的关键）
      role: contract ? (contract.role || '') : '(无契约)',
      inputs: contract ? (contract.inputs || []) : [],
      outputs: contract ? (contract.outputs || []).map(o => o.id || o.name) : [],
      // 五件套齐全度
      hasContract: !!contract,
      hasSceneJson: !!scenJson,
      hasIdentity: fs.existsSync(path.join(memDir, '身份卡.md')),
      hasMemory: fs.existsSync(path.join(memDir, '场景私有记忆.md')),
      panelCount: scenJson ? (scenJson.panels || []).length : 0,
      complete: !!(contract && scenJson &&
        fs.existsSync(path.join(memDir, '身份卡.md')) &&
        fs.existsSync(path.join(memDir, '场景私有记忆.md'))),
    };
  });
}

// ═══════════════════════════════════════════════════════════════
//  ② 场景私有记忆骨架（§〇 四问题）
// ═══════════════════════════════════════════════════════════════
function buildMemoryMd(spec) {
  return `# ${spec.name} · 场景私有记忆

> 场景：${spec.name}（${spec.id}）｜这份文件只有本场景写。
> 结构：§〇 当前交接（≤4KB）｜核心职责｜§一 职责边界｜§二 现状/接口｜§五 坑与决策（只追加）｜§八 项目索引

## §〇 当前交接

> ★ 只有四个回答：我是谁 / 干到哪 / 下一步 / 卡在哪。
> ★ 固定五小节，只留最新一份（覆盖不追加），≤4KB。

### 1) 上次交接
- （新场景，还没有交接记录）  ·  ${nowStr()}

### 2) 当前项目
| 项目 | 记忆文件 | 状态 | 下一步 |
|---|---|---|---|
| 无 | — | — | 接入第一个任务 |

### 3) 私有记忆变更
- ${nowDate()}：初始化场景记忆骨架（${spec.reason || 'AI 孵化'}）

### 4) 下一步 / 卡点
- 下一步：${spec.next || '等待首个任务派入'}
- 卡点：无

### 5) 全貌
- 项目记忆 0 个 · 归档 0 份

## 核心职责

- 负责：${spec.role}
- 不碰：${(spec.notDo || ['（待明确）']).join('；')}
- 一句话：${spec.role}

## 一、职责边界

${(spec.boundaries || ['- （待填）']).join('\n')}

## 二、现状 / 接口

- 场景文件：「外壳/scenarios/${spec.id}.json」
- 记忆目录：「数据/.dsh/场景记忆/${safeDirName(spec.name)}/」
- 会话绑定：待创建

## 五、坑与决策（只追加）

- ${nowDate()}：场景由 AI 孵化器创建。原因：${spec.reason || '任务需要但场景不存在'}

## 八、项目索引

| 项目 | 文件 | 状态 |
|---|---|---|
| 无 | — | — |
`;
}

function buildIdentityMd(spec, panels) {
  return `# ${spec.name} · 身份卡

> 由工具生成，手改即校验失败（原项目规矩）。

## 基本信息

- 场景 id：${spec.id}
- 场景名：${spec.name}
- 定位：${spec.role}
- 面板数：${panels.length}
- 记忆目录：数据/.dsh/场景记忆/${safeDirName(spec.name)}/

## 面板清单

${panels.map(p => '- ' + p.id + ' (' + p.type + ')  ' + (p.title || '')).join('\n')}

## 我能做什么

${spec.capabilities || '- ' + spec.role}

## 我不做什么

${(spec.notDo || ['- （待明确）']).map(x => x.startsWith('-') ? x : '- ' + x).join('\n')}
`;
}

// ═══════════════════════════════════════════════════════════════
//  ③ 创建场景（五件套）
// ═══════════════════════════════════════════════════════════════
function createScene(spec) {
  const id = String(spec.id || '').trim();
  if (!id) throw new Error('缺少 --id');
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('id 必须小写字母开头，只含 a-z0-9-');

  const name = String(spec.name || id).trim();
  const role = String(spec.role || '（待明确）').trim();

  const log = [];
  const warnings = [];

  // ① 检查是否已存在
  const idx = readJson(INDEX, { areas: [] });
  if ((idx.areas || []).some(a => a.id === id)) {
    throw new Error('场景已存在: ' + id + '（如需修改用 --check 或手工）');
  }

  // ② 面板方案（默认：神经元 + 对话）
  let panels = spec.panels;
  if (!Array.isArray(panels) || !panels.length) {
    panels = [
      {
        id: id.slice(0, 2) + '-neuron',
        title: '记忆神经元',
        sub: '拖拽旋转 · 滚轮缩放 · 点击节点看详情',
        type: 'neuron',
        col: 1, row: 1, w: 2, h: 5,
      },
      {
        id: id.slice(0, 2) + '-chat',
        title: 'AI·' + name,
        sub: '',
        type: 'harness',
        col: 3, row: 1, w: 2, h: 5,
        sessionTitle: name,
        pinTarget: [name],
        sessionId: '',      // 待绑
      },
    ];
  }

  const panelId = panels.find(p => p.type === 'harness');
  const ownerPanel = panelId ? panelId.id : (panels[0] ? panels[0].id : 'ai');

  // ═══ 写 ① 场景契约 ═══
  const contract = {
    id,
    name,
    role,
    description: spec.description || role,
    inputs: spec.inputs || [],
    outputs: spec.outputs || [],
    capabilities: spec.capabilities || [],
    notDo: spec.notDo || [],
    hatchedAt: new Date().toISOString(),
    hatchedBy: spec.hatchedBy || 'scene-hatch',
  };
  writeJson(path.join(CONTRACTS, id + '.json'), contract);
  log.push('① 场景契约 → sceneboard/scenes/' + id + '.json');

  // ═══ 写 ② 场景定义 ═══
  const sceneJson = {
    id,
    name,
    description: spec.description || role,
    layout: 'grid',
    theme: 'dark',
    panels,
    hatchedAt: new Date().toISOString(),
  };
  writeJson(path.join(SCENARIOS, id + '.json'), sceneJson);
  log.push('② 场景定义 → 外壳/scenarios/' + id + '.json');

  // ═══ 写 ③ 身份卡 + ④ 私有记忆 ═══
  const memDir = path.join(MEMROOT, safeDirName(name));
  fs.mkdirSync(memDir, { recursive: true });
  fs.mkdirSync(path.join(memDir, '归档'), { recursive: true });

  fs.writeFileSync(path.join(memDir, '身份卡.md'), buildIdentityMd(spec, panels), 'utf8');
  log.push('③ 身份卡 → 场景记忆/' + safeDirName(name) + '/身份卡.md');

  fs.writeFileSync(path.join(memDir, '场景私有记忆.md'), buildMemoryMd(spec), 'utf8');
  log.push('④ 私有记忆 → 场景记忆/' + safeDirName(name) + '/场景私有记忆.md');

  // 文件索引
  fs.writeFileSync(path.join(memDir, '_文件索引.md'),
    '# ' + name + ' · 文件索引\n\n> 本场景的东西在哪。\n\n| 类型 | 路径 | 说明 |\n|---|---|---|\n' +
    '| 场景定义 | 外壳\\scenarios\\' + id + '.json | 面板布局 |\n' +
    '| 场景契约 | sceneboard\\scenes\\' + id + '.json | 定位/输入/输出 |\n' +
    '| 身份卡 | 场景记忆\\' + safeDirName(name) + '\\身份卡.md | 自我认知 |\n' +
    '| 私有记忆 | 场景记忆\\' + safeDirName(name) + '\\场景私有记忆.md | §〇交接 |\n',
    'utf8');

  // ═══ 写 ⑤ 注册表 ═══
  idx.areas = idx.areas || [];
  idx.areas.push({
    id,
    name,
    owner: ownerPanel,
    memory: '场景记忆/' + safeDirName(name),
    file: 'areas/' + id + '.md',
    panel: ownerPanel,
  });
  writeJson(INDEX, idx);
  log.push('⑤ 注册表 → _共享记忆/索引.json（现在共 ' + idx.areas.length + ' 个场景）');

  // 区域明细
  const areasDir = path.join(SHARED, 'areas');
  fs.mkdirSync(areasDir, { recursive: true });
  fs.writeFileSync(path.join(areasDir, id + '.md'),
    '# ' + name + '\n\n- 场景 id：' + id + '\n- 定位：' + role + '\n- 记忆：场景记忆/' + safeDirName(name) + '\n- 孵化工：' + (spec.hatchedBy || 'scene-hatch') + ' · ' + nowStr() + '\n',
    'utf8');

  return { id, name, role, panels: panels.length, log, warnings, memDir };
}

// ═══════════════════════════════════════════════════════════════
//  ④ 校验
// ═══════════════════════════════════════════════════════════════
function checkScene(id) {
  const idx = readJson(INDEX, { areas: [] });
  const area = (idx.areas || []).find(a => a.id === id);
  if (!area) return { id, ok: false, err: '不在注册表里' };

  const contract = readJson(path.join(CONTRACTS, id + '.json'), null);
  const scen = readJson(path.join(SCENARIOS, id + '.json'), null);
  const memDir = path.join(MEMROOT, safeDirName(area.name));

  const checks = {
    '① 场景契约': !!contract,
    '② 场景定义': !!scen,
    '③ 身份卡': fs.existsSync(path.join(memDir, '身份卡.md')),
    '④ 私有记忆': fs.existsSync(path.join(memDir, '场景私有记忆.md')),
    '⑤ 在注册表': true,
  };

  const issues = [];
  if (contract && !contract.role) issues.push('契约缺 role（AI 无法判断何时用它）');
  if (scen) {
    const h = (scen.panels || []).find(p => p.type === 'harness');
    if (!h) issues.push('缺 harness 面板（这个场景没有 AI）');
    else if (!h.sessionId) issues.push('harness 未绑定 sessionId（需建会话）');
  }
  if (fs.existsSync(path.join(memDir, '场景私有记忆.md'))) {
    const mem = fs.readFileSync(path.join(memDir, '场景私有记忆.md'), 'utf8');
    const kb = Buffer.byteLength(mem, 'utf8') / 1024;
    if (kb > 25) issues.push('私有记忆超过 25KB 红线（当前 ' + kb.toFixed(1) + 'KB）');
    const sec0 = mem.match(/## §〇[\s\S]*?(?=\n## |$)/);
    if (sec0) {
      const k0 = Buffer.byteLength(sec0[0], 'utf8') / 1024;
      if (k0 > 4) issues.push('§〇交接超过 4KB 红线（当前 ' + k0.toFixed(1) + 'KB）');
    } else {
      issues.push('缺 §〇 交接小节');
    }
  }

  return {
    id,
    name: area.name,
    ok: Object.values(checks).every(Boolean) && issues.length === 0,
    checks,
    issues,
  };
}

// ═══════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}
function has(name) {
  return argv.includes('--' + name);
}

function printList() {
  const list = listScenes();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  场景清单（' + list.length + ' 个）—— AI 调度前先查这张表');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log('  ' + 'ID'.padEnd(20) + '名称'.padEnd(12) + '五件套'.padEnd(8) + '定位');
  console.log('  ' + '─'.repeat(84));
  for (const s of list) {
    const badge = s.complete ? '✓ 齐' : '⚠ 缺';
    console.log('  ' + s.id.padEnd(20) + s.name.padEnd(12) + badge.padEnd(8) +
      String(s.role || '(无契约)').slice(0, 40));
  }
  console.log();
  const incomplete = list.filter(s => !s.complete);
  if (incomplete.length) {
    console.log('  ⚠ 五件套不全: ' + incomplete.map(s => s.id).join(', '));
    console.log('    用 --check <id> 看缺什么');
  } else {
    console.log('  ✓ 全部场景五件套齐全');
  }
  console.log();
  console.log('  JSON 输出（供程序消费）: node ' + path.relative(process.cwd(), import.meta.filename).replace(/\\/g, '\\') + ' --list --json');
}

function printListJson() {
  console.log(JSON.stringify(listScenes(), null, 2));
}

function printCheck(r) {
  console.log('场景: ' + (r.name || r.id) + ' (' + r.id + ')');
  console.log('结论: ' + (r.ok ? '✓ 五件套齐全' : '⚠ 有问题'));
  if (r.checks) {
    for (const k of Object.keys(r.checks)) {
      console.log('  ' + (r.checks[k] ? '✓' : '✗') + ' ' + k);
    }
  }
  if (r.issues && r.issues.length) {
    console.log();
    console.log('  问题:');
    for (const i of r.issues) console.log('    · ' + i);
  }
  if (r.err) console.log('  ✗ ' + r.err);
}

(function main() {
  try {
    if (has('list')) {
      if (has('json')) printListJson();
      else printList();
      return;
    }

    if (has('create')) {
      let spec;
      const specFile = arg('spec');
      if (specFile) {
        spec = readJson(path.resolve(specFile), null);
        if (!spec) throw new Error('读不到 spec 文件: ' + specFile);
      } else {
        spec = {
          id: arg('id'),
          name: arg('name'),
          role: arg('role'),
          description: arg('description'),
          inputs: arg('inputs') ? arg('inputs').split(',') : [],
          capabilities: arg('capabilities') ? arg('capabilities').split(';') : [],
          notDo: arg('notdo') ? arg('notdo').split(';') : [],
          reason: arg('reason') || '任务需要但场景不存在',
          hatchedBy: arg('by') || 'scene-hatch',
        };
      }
      spec.hatchedBy = spec.hatchedBy || arg('by') || 'scene-hatch';
      const r = createScene(spec);
      console.log('═══════════════════════════════════════════════════════════');
      console.log('  ✓ 场景已孵化: ' + r.name + ' (' + r.id + ')');
      console.log('═══════════════════════════════════════════════════════════');
      console.log();
      for (const l of r.log) console.log('  ' + l);
      console.log();
      console.log('  记忆目录: ' + r.memDir);
      console.log();
      console.log('  下一步: 为该场景创建独立会话并绑定 sessionId');
      console.log('    （写回 外壳/scenarios/' + r.id + '.json 的 harness.sessionId）');
      return;
    }

    if (has('check-all')) {
      const list = listScenes();
      let bad = 0;
      for (const s of list) {
        const r = checkScene(s.id);
        if (!r.ok) { bad++; printCheck(r); console.log(); }
      }
      console.log('检查 ' + list.length + ' 个场景，' + (bad ? bad + ' 个有问题' : '全部通过'));
      process.exitCode = bad ? 1 : 0;
      return;
    }

    const checkId = arg('check');
    if (checkId) {
      printCheck(checkScene(checkId));
      return;
    }

    console.log('用法:');
    console.log('  node 工具\\scene-hatch.mjs --list              # 列出场景（AI 调度前查）');
    console.log('  node 工具\\scene-hatch.mjs --list --json       # JSON 输出');
    console.log('  node 工具\\scene-hatch.mjs --create --spec s.json   # 从 spec 建场景');
    console.log('  node 工具\\scene-hatch.mjs --create --id x --name "名字" --role "职责"');
    console.log('  node 工具\\scene-hatch.mjs --check <id>         # 校验单个');
    console.log('  node 工具\\scene-hatch.mjs --check-all          # 校验全部');
  } catch (e) {
    console.error('✗ ' + (e && e.message || e));
    process.exitCode = 1;
  }
})();
