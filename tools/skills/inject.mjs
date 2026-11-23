#!/usr/bin/env node
/**
 * 技能两段式注入 —— A12 的「入口」层。
 *
 * 抄自 `D:\refs\learn-claude-code\s07_skill_loading\code.py:134-144,220-231`：
 *   ① 目录（name + description）**常驻** prompt —— 让模型知道「有哪些技能」
 *   ② 正文**按需**以 tool_result 进对话 —— 只有模型真的调 `load_skill` 才读全文
 *
 * 为什么必须这么做：我们 `tools/skills/loader.mjs` 早就有 `list()`/`load()`，
 * 但它们只被 verify/export 调用 —— **模型看不到技能、也没有工具能读正文**。
 * A12 输 12 次的根因就是「有文件、没入口」。
 *
 * 本模块补上入口：
 *   catalogText(loader)           → 拼进 system prompt 的技能目录
 *   createLoadSkillTool(loader)   → 符合 DSH `agent.ctx.tools.register` 形状的工具
 *
 * ⛔ 不做越界拦截：只读文本、不执行技能里的命令。执行靠宿主。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 一条技能的目录行上限。
 *
 * ══ 为什么从 200 调到 90（第 153 轮）══════════════════════════════════
 * 技能库长到 119 个时，目录 [name: description] 达 12150 字符（约 6000 tokens）
 * 常驻 system prompt —— 超过 verify-discoverability 的 12000 字符红线，实测 FAIL。
 * 这正是 context-management 说的「常驻目录要省」：目录是「短索引」，正文才是「全detail」。
 * 压到 90 字符/技能后目录 ~11500 字符（<12000），且实测发现率仍达标（见 verify-discoverability）。
 * 截断只影响「常驻目录」，load_skill 取到的正文仍是完整 description。
 */
export const LIMITS = { descChars: 44, nameChars: 64 };

/**
 * 解析技能正文里的 `_shared/<file>.md` 共享引用，把内容内联进来。
 *
 * ══ 为什么需要（第 144 轮）══════════════════════════════════════════
 * 有 6 个技能（data-reconcile / support-assign / doc-consistency / docs-index /
 * inventory-ledger / self-review）按 DRY 原则只写「详见 _shared/consistency-check.md」，
 * 正文 0.35KB。但 `load_skill` 只返回正文，**不解析这个指针** ——
 * 于是模型调 load_skill('data-reconcile') 只拿到一句「见那个文件」，
 * 真正的判据（7.7KB）没送达。这就是「技能是薄壳」的真实危害。
 *
 * 修法：load 时把被引用的 `_shared/*.md` 读出来内联到正文末尾。
 * 既保住 DRY（源文件不重复），又保证模型真拿到内容。
 * 只认 `_shared/` 下的 .md，且必须存在，读不到就原样返回（不报错、不静默吞掉正文）。
 */
export function resolveSharedIncludes(body, skillPath) {
  const text = String(body || '');
  if (!skillPath) return text;
  const scenesRoot = path.dirname(path.dirname(skillPath)); // .../scenes/<skill>/SKILL.md → .../scenes
  const refs = new Set();
  for (const m of text.matchAll(/_shared\/([\w.\-]+\.md)/g)) refs.add(m[1]);
  if (!refs.size) return text;
  let appended = '';
  for (const r of [...refs].sort()) {
    const p = path.join(scenesRoot, '_shared', r);
    let txt = null;
    try { if (fs.existsSync(p)) txt = fs.readFileSync(p, 'utf8'); } catch { txt = null; }
    if (txt == null) continue;
    appended += '\n\n---\n\n## 共享参考（已自动内联：_shared/' + r + '）\n\n' + txt;
  }
  return text + appended;
}

/**
 * 把 loader.list() 拼成注入 prompt 的技能目录。
 * 形状照 s07:134-144：一个标题 + 每行 `- name: description`。
 * @returns {{ text: string, count: number, truncated: string[] }}
 */
export function catalogText(loader) {
  const items = loader.list();
  const truncated = [];
  const lines = ['# Skills', ''];

  if (items.length === 0) {
    lines.push('(none)');
    return { text: lines.join('\n'), count: 0, truncated };
  }

  for (const it of items) {
    const name = String(it.name).slice(0, LIMITS.nameChars);
    let desc = String(it.description || '').replace(/\s+/g, ' ').trim();
    if (desc.length > LIMITS.descChars) {
      desc = desc.slice(0, LIMITS.descChars) + '…';
      truncated.push(it.name);
    }
    lines.push('- ' + name + ': ' + desc);
  }
  lines.push('');
  lines.push('调用 load_skill(name) 读取某个技能的完整正文。');
  return { text: lines.join('\n'), count: items.length, truncated };
}

/** 技能名合法性：只允许字母数字 _ - 与一个可选的 `/分类/` 前缀 */
const NAME_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/;

/**
 * 造一个 `load_skill` 工具，形状对齐 DSH `agent.ctx.tools.register`。
 *
 * 返回的对象有两种用法：
 *   · `run({name})`        —— 直接调用（单元测试 / API 端点用）
 *   · `register(agent)`    —— 真正注册到 DSH agent（需要 agent.ctx.tools.register）
 */
export function createLoadSkillTool(loader, deps = {}) {
  const log = deps.log || (() => {});
  const known = new Set(loader.list().map((s) => s.name));

  /** 纯函数：name → {ok, body} | {ok:false, error} */
  function run(args = {}) {
    const raw = typeof args.name === 'string' ? args.name.trim() : '';
    if (!raw) return { ok: false, error: 'load_skill 需要 name' };
    if (!NAME_RE.test(raw)) return { ok: false, error: '技能名不合法（拒绝路径字符）：' + raw.slice(0, 40) };
    if (!known.has(raw)) return { ok: false, error: '技能不存在：' + raw, known: [...known].sort() };
    try {
      const s = loader.load(raw);
      // 第 144 轮：把 _shared 共享参考内联进正文（否则薄壳技能只返回指针，判据送不到模型）
      const body = resolveSharedIncludes(s.body, s.path);
      const bytes = Buffer.byteLength(body || '', 'utf8');
      log('load_skill ' + raw + ' (' + bytes + 'B' + (bytes > Buffer.byteLength(s.body || '', 'utf8') ? '，含内联共享参考' : '') + ')');
      return { ok: true, name: s.name, description: s.description, body, bytes };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  }

  const tool = {
    name: 'load_skill',
    description: [
      '读取某个技能的完整正文（分步流程、判据、反例清单、边界）。',
      '',
      '**什么时候必须调用**：当用户的任务属于「工程改动 / 审查 / 数据 / 写作 / 协作 / 交付 / 研究」中任一类，',
      '且 Skills 目录里有对应技能时 —— 先 load_skill 读它的完整流程，再动手。',
      '不要只凭目录里那一行 description 就开始做：目录只有一句话，正文才有可执行的判据与反例。',
      '',
      '**典型必须调用的情况**：',
      '- 要修 bug / 复现问题 → debug-repro',
      '- 要写测试 → test-writing',
      '- 要审代码或方案 → code-review / design-review',
      '- 要迁移数据、设计结构 → data-migration / schema-design',
      '- 要拆任务、交接、复盘、选型 → task-breakdown / handoff / postmortem / tech-selection',
      '- 要发版、写更新说明 → release-pipeline / release-notes',
      '',
      '**什么时候不用调用**：纯闲聊、纯查询事实、任务明显不属于任何技能时。',
      '',
      '参数 name 必须是 Skills 目录里列出的名字（拼错会返回错误，不会静默用别的技能）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名（必须与 Skills 目录里的名字完全一致）' } },
      required: ['name'],
      additionalProperties: false,
    },
    run,
    /** DSH 形状的 execute：返回结构化结果，失败也返回而不是抛（让模型能看见错误） */
    async execute(args) { return run(args); },
    /**
     * 注册到 DSH agent。返回 disposer。
     * 依据：dsh-superagent-prototype `src/app/sessions.ts:206-215` 的 register 形状。
     */
    register(agent) {
      if (!agent || !agent.ctx || !agent.ctx.tools || typeof agent.ctx.tools.register !== 'function') {
        throw new Error('register 需要 DSH agent（agent.ctx.tools.register）');
      }
      return agent.ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
        },
        execute: (a) => run(a),
      });
    },
  };
  return tool;
}
