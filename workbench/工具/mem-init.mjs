/**
 * 记忆初始化 —— 为新场景建立记忆骨架
 *
 * 原项目的规矩：
 *   每个场景一份 场景私有记忆.md，首个固定小节是 §〇 交接（≤4KB），
 *   外加 核心职责（≥3条）+ 职责边界 + 现状/接口 + 坑与决策 + 项目索引。
 *
 * 本工具从「场景 json + 场景契约」自动生成这份骨架，避免手工抄。
 *
 * 用法：
 *   node 工具\mem-init.mjs --all          为所有缺记忆的场景建骨架
 *   node 工具\mem-init.mjs --scene <id>   为指定场景建
 *   node 工具\mem-init.mjs --dry          只打印将要做什么
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..', '..');   // 工具/ -> workbench/ -> 项目根
const WB = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');   // 工具/ -> workbench
const SHELL = path.join(WB, '外壳');
const SC_DIR = path.join(SHELL, 'scenarios');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const CONTRACT = path.join(WB, 'sceneboard', 'scenes');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 读场景 json（取 id / name / 面板清单） */
function loadScenarios() {
  if (!fs.existsSync(SC_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SC_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC_DIR, f), 'utf8'));
      if (j.id && j.name) out.push(j);
    } catch { /* ignore */ }
  }
  return out;
}

/** 读场景契约（取 role / inputs / outputs） */
function loadContract(sceneId) {
  const f = path.join(CONTRACT, sceneId + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

/** 生成记忆骨架 */
function buildSkeleton(sc) {
  const c = loadContract(sc.id) || {};
  const panels = (sc.panels || []).map(p => p.id + '(' + (p.type || '?') + ')').join(' · ');
  const inputs = (c.inputs || []).length ? c.inputs.map(x => '「' + x + '」').join(' / ') : '（无）';
  const outputs = (c.outputs || []).length
    ? c.outputs.map(o => '- 「' + o.id + '」（' + o.name + '）→ ' + ((o.to || []).join(', ') || '（无接收方）')).join('\n')
    : '- （无）';

  return `# ${sc.name} · 场景私有记忆

> 场景：${sc.name}（${sc.id}）｜这份文件只有本场景写。
> 结构：§〇 当前交接（≤4KB）｜核心职责｜§一 职责边界｜§二 现状/接口｜§五 坑与决策（只追加）｜§八 项目索引

## §〇 当前交接

### 1) 上次交接
- （新场景，还没有交接记录）  ·  ${now()}

### 2) 当前项目
| 项目 | 记忆文件 | 状态 | 下一步 |
|---|---|---|---|
| 无 | — | — | — |

### 3) 私有记忆变更
- ${now()}：初始化场景记忆骨架

### 4) 下一步 / 卡点
- 下一步：跟这个场景的 AI 说第一句"我要用它做什么"，让它写进这里
- 卡点：（无）

### 5) 全貌
- 项目记忆 0 个 · 归档 0 份

## 核心职责

- 负责：${c.role || '（待补）'}
- 不碰：（待补）
- 一句话：能用一句话说清"什么事找我、什么别找我"才算立住。

## 一、职责边界

- （待填）

## 二、现状 / 接口

- 面板文件：外壳\\scenarios\\${sc.id}.json
- 面板清单：${panels || '（无）'}
- 记忆目录：数据\\.dsh\\场景记忆\\${sc.name}
- 上游输入：${inputs}
- 我的产出：
${outputs}

## 五、坑与决策

- （只追加：症状 → 根因 → 修法）

## 八、项目索引

- （空）
`;
}

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const onlyId = (() => { const i = argv.indexOf('--scene'); return i >= 0 ? argv[i + 1] : ''; })();
const wantAll = argv.includes('--all') || (!onlyId && !argv.includes('--help'));

// --dry 不带 --all 时也要扫描全部（dry 只是"不写入"，不是"不选择"）
const scenarios = loadScenarios().filter(s => (onlyId ? s.id === onlyId : true));
if (!scenarios.length) { console.error('找不到场景'); process.exit(1); }

fs.mkdirSync(MEM, { recursive: true });
let made = 0, skipped = 0;

for (const sc of scenarios) {
  const dir = path.join(MEM, sc.name);
  const f = path.join(dir, '场景私有记忆.md');
  if (fs.existsSync(f)) {
    skipped++;
    if (!dry) console.log(C.dim + '跳过 ' + sc.name + '（已存在）' + C.reset);
    continue;
  }
  const body = buildSkeleton(sc);
  if (dry) {
    console.log(C.yellow + '[dry] ' + C.reset + '将创建 ' + sc.name + '  (' + Math.round(body.length / 1024 * 10) / 10 + ' KB)');
    made++;
    continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, body, 'utf8');
  // 顺手建 归档/ 与 项目记忆/ 两个标准子目录
  fs.mkdirSync(path.join(dir, '归档'), { recursive: true });
  fs.mkdirSync(path.join(dir, '项目记忆'), { recursive: true });
  made++;
  console.log(C.green + 'OK' + C.reset + ' ' + sc.name.padEnd(12) + ' 已建骨架（' + Math.round(body.length / 1024 * 10) / 10 + ' KB）');
}

console.log('');
console.log('新建 ' + made + ' 个 · 跳过 ' + skipped + ' 个');
if (dry) console.log(C.dim + '（dry 预览，未实际写入）' + C.reset);
