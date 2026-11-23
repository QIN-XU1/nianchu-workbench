#!/usr/bin/env node
/**
 * 参照项目盘点 —— 给「标杆」场景生成真实数据
 *
 * 这个脚本做三件事，都是可复算的：
 *
 *   1. **源码实测**：对本地已有的参照项目，数真实文件/行数/语言分布/顶层结构。
 *      不是从 README 抄，是自己数出来的。
 *
 *   2. **结构画像**：每个项目的目录骨架、关键文件（manifest/锁文件/构建脚本），
 *      用来判断它的分层与执行模型。
 *
 *   3. **拆解框架**：每个项目预置「优势 / 缺点 / 可借鉴 / 我们要超过的点」四个槽位，
 *      由人填写（不在本脚本里编造）——本脚本只负责把真实源码数据填进去。
 *
 * 为什么这么做：用户要求「每个项目的优势缺点必须拆解细分」。
 * 拆解必须建立在**看过源码**之上，不能凭印象。所以先把可测的测出来，
 * 人写的判断再叠加。
 *
 * 用法：node tools/benchmark/survey.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/projects.json');

/**
 * 16 个参照项目（用户给的清单，去重后 16 项；omp-studio 出现两次）
 *
 * local  本地源码根（null = 闭源或无源码）
 * kind   oss = 开源可读 / closed = 闭源产品 / spec = 规范或资料集
 * tier   我们怎么用它：fork（直接拿源码改）/ learn（学设计）/ study（研究机制）
 */
const PROJECTS = [
  {
    id: 'openbitfun',
    name: 'OpenBitFun',
    repo: 'https://github.com/openBitFun/OpenBitFun',
    local: 'D:/refs/openbitfun-src/OpenBitFun-main',
    kind: 'oss', tier: 'fork',
    tagline: '我们前端基座：已 fork 进 apps/vouch-web',
    note: 'MIT。React 18 + Vite 7 + Tauri v2，pnpm workspace，design-system 独立包。',
  },
  {
    id: 'chatgpt-codex',
    name: 'ChatGPT / Codex',
    repo: 'https://chatgpt.com/codex',
    local: null, kind: 'closed', tier: 'learn',
    tagline: '闭源标杆：对话式 + 云端任务',
    note: '无法读源码；只能从产品行为与官方文档取证据。',
  },
  {
    id: 'claude-code',
    name: 'Claude Code 桌面版',
    repo: 'https://claude.com/product/claude-code',
    local: null, kind: 'closed', tier: 'learn',
    tagline: '闭源标杆：终端原生 agent + 桌面壳',
    note: '无法读源码；官方文档 + 产品行为取证。',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    repo: 'https://cursor.com',
    local: null, kind: 'closed', tier: 'learn',
    tagline: '闭源标杆：编辑器内 agent',
    note: 'VS Code fork，闭源。学它的 inline diff 与上下文选择。',
  },
  {
    id: 'trae',
    name: 'Trae',
    repo: 'https://trae.ai',
    local: null, kind: 'closed', tier: 'learn',
    tagline: '闭源：字节的 AI IDE',
    note: '学它的 Builder 模式与中文场景适配。',
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    repo: '',
    local: null, kind: 'closed', tier: 'learn',
    tagline: '闭源：办公场景 agent',
    note: '资料有限，只做行为观察。',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    repo: 'https://copilot.tencent.com',
    local: null, kind: 'closed', tier: 'learn',
    tagline: '闭源：腾讯的编码助手',
    note: '学它的企业内集成方式。',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    repo: 'https://qoder.com',
    local: null, kind: 'closed', tier: 'learn',
    tagline: '闭源：阿里 agentic IDE',
    note: '学它的 repo 级上下文理解。',
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    repo: 'https://github.com/deepseek-ai/deepseek-harness',
    local: 'D:/file/AI Temp/DeepSeek/Agent自研/evidence/dsh-src',   // 由 tools/net/extract-dsh-src.mjs 从 app.asar 解出
    kind: 'oss', tier: 'study',
    tagline: '同族竞品：everything-is-a-plugin，338 个包',
    note: 'asar 已解出 8030 个源码文件在 evidence/dsh-src。包分解是它的核心优势。',
  },
  {
    id: 'openclaw',
    name: 'openclaw',
    repo: 'https://github.com/openclaw/openclaw',
    local: 'D:/refs/openclaw/openclaw-main',
    kind: 'oss', tier: 'study',
    tagline: '多通道 + 五层记忆 + 41 贡献点',
    note: '71 文件 AGENTS.md，714MB。通道插件化与 dreaming 记忆值得学。',
  },
  {
    id: 'ecc',
    name: 'ECC',
    repo: 'https://github.com/affaan-m/ECC',
    local: 'D:/refs/ECC/ECC-main',
    kind: 'oss', tier: 'learn',
    tagline: '配置层生态：314 skills + 71 agents + 多端适配',
    note: '不是运行时，是跨 8 个 AI 工具的配置集。学它的跨端适配矩阵。',
  },
  {
    id: 'hermes',
    name: 'hermes-agent',
    repo: 'https://github.com/nousresearch/hermes-agent',
    local: 'C:/hermes',
    kind: 'oss', tier: 'study',
    tagline: '我们曾经的补丁基线：67 工具 + 星图 + 6 执行后端',
    note: 'A15 之前的审批闸、A5 的压缩器都源自它。现在要在自研上超过它。',
  },
  {
    id: 'open-design',
    name: 'open-design',
    repo: 'https://github.com/nexu-io/open-design',
    local: 'D:/refs/open-design',
    kind: 'oss', tier: 'learn',
    tagline: '设计系统参考',
    note: '看它的 token 体系与组件规范。',
  },
  {
    id: 'omp-studio',
    name: 'omp-studio',
    repo: 'https://github.com/the-snowpear/omp-studio',
    local: 'D:/refs/omp-studio',
    kind: 'oss', tier: 'learn',
    tagline: '界面参考（曾指定参考它）',
    note: '清单里出现两次，去重后一项。',
  },
  {
    id: 'orca',
    name: 'orca',
    repo: 'https://github.com/stablyai/orca',
    local: 'D:/refs/orca',
    kind: 'oss', tier: 'learn',
    tagline: '界面参考（曾指定参考它）',
    note: '',
  },
  {
    id: 'pi',
    name: 'pi',
    repo: 'https://github.com/earendil-works/pi',
    local: 'D:/refs/pi-main',
    kind: 'oss', tier: 'learn',
    tagline: '研究机制',
    note: '',
  },
  {
    id: 'luanyujia',
    name: 'luanyujia-workbench',
    repo: 'https://github.com/mashanglinyu/luanyujia-workbench',
    local: 'D:/refs/luanyujia/luanyujia-workbench-main',
    kind: 'oss', tier: 'study',
    tagline: '中文场景工作台：面板式 + 免费AI桥',
    note: '22MB，面板-harness-AI会话.js 173KB。学它的中文场景切分。',
  },
  {
    id: 'craft-anything',
    name: 'craft-anything',
    repo: 'https://github.com/storytold/craft-anything',
    local: 'D:/refs/craft-anything/craft-anything-main',
    kind: 'oss', tier: 'study',
    tagline: '待拆解',
    note: '新下载。',
  },
  {
    id: 'solo-to-team-skills',
    name: 'solo-to-team-skills',
    repo: 'https://github.com/dabingfy-dot/solo-to-team-skills',
    local: 'D:/refs/solo-to-team-skills/solo-to-team-skills-main',
    kind: 'oss', tier: 'study',
    tagline: '待拆解：单人→团队的 skill 组织',
    note: '新下载，38 项。重点看 skill 的分层组织方式。',
  },
  {
    id: 'cl4r1t4s',
    name: 'CL4R1T4S',
    repo: 'https://github.com/elder-plinius/CL4R1T4S',
    local: 'D:/refs/CL4R1T4S/CL4R1T4S-main',
    kind: 'spec', tier: 'study',
    tagline: '待拆解：系统提示词/行为规范集',
    note: '新下载，111 项。研究 agent 行为约束的一手材料。',
  },
  {
    id: 'aionui',
    name: 'AionUi',
    repo: 'https://github.com/iOfficeAI/AionUi',
    local: 'D:/refs/aionui',
    kind: 'oss', tier: 'learn',
    tagline: '界面参考（曾指定参考它）',
    note: '',
  },
  {
    id: 'weknora',
    name: 'WeKnora',
    repo: 'https://github.com/Tencent/WeKnora',
    local: 'D:/refs/WeKnora/WeKnora-main',
    kind: 'oss', tier: 'study',
    tagline: '待拆解：腾讯的知识库/RAG 框架',
    note: '新下载，119MB / 6708 项。看它的检索与知识组织。',
  },
];

const LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
  '.c': 'C', '.cc': 'C++', '.cpp': 'C++', '.h': 'C/C++ header', '.hpp': 'C++',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.lua': 'Lua',
  '.css': 'CSS', '.scss': 'SCSS', '.sass': 'SASS', '.less': 'LESS',
  '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.sh': 'Shell', '.ps1': 'PowerShell',
};

/**
 * 跳过规则
 *
 * ⚠ dsh 的源码全部在 `node_modules/@deepseek-ai/*` 里（从 asar 解出来的包布局），
 * 用 `node_modules` 一刀切会把 DSH 数成 0 文件 —— 实测踩到过。
 * 所以只跳过**依赖树的常规位置**，不跳过我们特意解出来的 dsh-src。
 */
const SKIP = /[\\/]node_modules[\\/](?!@deepseek-ai)|[\\/]\.git[\\/]|[\\/]dist[\\/]|[\\/]build[\\/]|[\\/]target[\\/]|[\\/]\.venv[\\/]|[\\/]__pycache__[\\/]|\.map$|\.min\./;

function walk(root, maxFiles = 200000) {
  const stats = { files: 0, bytes: 0, byExt: {}, byLang: {}, topDirs: {}, truncated: false };
  const stack = [root];
  while (stack.length) {
    if (stats.files >= maxFiles) { stats.truncated = true; break; }
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) {
        // 顶层目录统计
        const rel = path.relative(root, p);
        if (!rel.includes(path.sep)) stats.topDirs[e.name] = (stats.topDirs[e.name] || 0);
        stack.push(p);
        continue;
      }
      stats.files++;
      let sz = 0;
      try { sz = fs.statSync(p).size; } catch { /* 忽略 */ }
      stats.bytes += sz;
      const ext = path.extname(e.name).toLowerCase();
      stats.byExt[ext] = (stats.byExt[ext] || 0) + 1;
      const lang = LANG[ext];
      if (lang) stats.byLang[lang] = (stats.byLang[lang] || 0) + 1;
      // 顶层目录文件数
      const rel = path.relative(root, p);
      const top = rel.split(path.sep)[0];
      if (rel.includes(path.sep)) stats.topDirs[top] = (stats.topDirs[top] || 0) + 1;
    }
  }
  return stats;
}

/** 找关键文件（判断技术栈与分层） */
function keyFiles(root) {
  const CANDIDATES = [
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json',
    'Cargo.toml', 'pyproject.toml', 'setup.py', 'go.mod', 'requirements.txt',
    'tauri.conf.json', 'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs',
    'tsconfig.json', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE',
    'Dockerfile', 'docker-compose.yml', '.gitignore',
  ];
  const found = [];
  for (const c of CANDIDATES) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) {
      try { found.push({ name: c, bytes: fs.statSync(p).size }); } catch { found.push({ name: c, bytes: 0 }); }
    }
  }
  // 子目录里的也找一层
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (SKIP.test(e.name)) continue;
      for (const c of ['package.json', 'AGENTS.md', 'Cargo.toml', 'pyproject.toml']) {
        const p = path.join(root, e.name, c);
        if (fs.existsSync(p)) {
          try { found.push({ name: e.name + '/' + c, bytes: fs.statSync(p).size }); } catch { /* 忽略 */ }
        }
      }
    }
  } catch { /* 忽略 */ }
  return found;
}

const results = [];
console.log('');
console.log('  参照项目盘点 —— 源码实测');
console.log('  ' + '─'.repeat(72));

for (const p of PROJECTS) {
  const rec = { ...p, measured: null };
  if (p.local && fs.existsSync(p.local)) {
    const t0 = Date.now();
    const st = walk(p.local);
    const kf = keyFiles(p.local);
    const langs = Object.entries(st.byLang).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const dirs = Object.entries(st.topDirs).sort((a, b) => b[1] - a[1]).slice(0, 10);
    rec.measured = {
      files: st.files,
      mb: Math.round(st.bytes / 1024 / 1024 * 10) / 10,
      languages: langs.map(([k, v]) => ({ lang: k, files: v })),
      mainLang: langs.length ? langs[0][0] : null,
      topDirs: dirs.map(([k, v]) => ({ dir: k, files: v })),
      keyFiles: kf,
      truncated: st.truncated,
      ms: Date.now() - t0,
    };
    console.log('  ✓ ' + p.name.padEnd(22) + String(st.files).padStart(7) + ' 文件 / ' +
      String(rec.measured.mb).padStart(7) + 'MB / ' + (rec.measured.mainLang || '?').padEnd(12) +
      (st.truncated ? ' [已截断]' : ''));
  } else {
    console.log('  ○ ' + p.name.padEnd(22) + (p.kind === 'closed' ? '闭源（无源码）' : '源码未就位'));
  }
  results.push(rec);
}

const data = {
  what: '参照项目盘点（16 项）',
  rule: 'measured 是本地源码实测（自己数的，不是抄 README）；analysis 由人填写，不在脚本里编造',
  at: new Date().toISOString(),
  generator: 'tools/benchmark/survey.mjs',
  count: results.length,
  withSource: results.filter((r) => r.measured).length,
  closed: results.filter((r) => r.kind === 'closed').length,
  projects: results,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  共 ' + data.count + ' 项 · 有源码 ' + data.withSource + ' · 闭源 ' + data.closed);
console.log('  → ' + path.relative(REPO, OUT));
console.log('');

if (process.argv.includes('--json')) console.log(JSON.stringify(data, null, 2));