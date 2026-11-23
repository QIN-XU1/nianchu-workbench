#!/usr/bin/env node
/**
 * 多宿主投影器 —— B3 跨工具可移植 的**真正实现**（第 61 轮，补 60 轮发现的短板）
 *
 * 与 export.mjs 的区别（那是「别人读我们」的清单）：
 *   本模块是「**我们把同一套内容写进多个宿主的原生格式**」—— 与 ecc 的 14 宿主投影同向。
 *
 * 单一权威源（B2 也用得上）：
 *   canonical 源 = 技能池（SKILL.md 的 frontmatter），只读一次。
 *   所有宿主输出**只从这份 canonical 派生**，不各自维护 —— 改一处，全部同步。
 *
 * 输出的宿主（按各宿主真实约定命名）：
 *   .nianchu-hosts/claude/CLAUDE.md      —— Claude Code 的 AGENTS 习惯（markdown 列表）
 *   .nianchu-hosts/codex/AGENTS.md       —— Codex CLI
 *   .nianchu-hosts/cursor/.cursorrules   —— Cursor 规则文件
 *   .nianchu-hosts/gemini/GEMINI.md      —— Gemini CLI
 *   .nianchu-hosts/opencode/AGENTS.md    —— OpenCode
 *   .nianchu-hosts/agents.json           —— 通用机器可读清单（任何工具可读）
 *
 * 验收（verify，四态）：
 *   ① 覆盖：6 个宿主全部产出
 *   ② 同源：每个宿主输出里的技能 id 集合 == canonical 集合（不多不少）
 *   ③ 幂等：连续生成两次，字节完全一致
 *   ④ 反例：canonical 为空 ⇒ FAIL（不允许生成一堆空文件还报 PASS）
 *
 * ⛔ 不越界拦截：只生成文本清单，不改任何宿主配置，不执行任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createSkillLoader, parseFrontmatter } from '../skills/loader.mjs';

export const SCHEMA = '1.0.0';

/** 宿主定义：id → 相对输出路径 + 显示名（全部基于同一份 canonical skills）
 *  路径按各工具**真实约定**命名（.cursorrules / .windsurfrules / CONVENTIONS.md …） */
export const HOSTS = [
  { id: 'claude', file: 'claude/CLAUDE.md', title: 'Claude Code' },
  { id: 'codex', file: 'codex/AGENTS.md', title: 'Codex CLI' },
  { id: 'cursor', file: 'cursor/.cursorrules', title: 'Cursor' },
  { id: 'gemini', file: 'gemini/GEMINI.md', title: 'Gemini CLI' },
  { id: 'opencode', file: 'opencode/AGENTS.md', title: 'OpenCode' },
  { id: 'windsurf', file: 'windsurf/.windsurfrules', title: 'Windsurf' },
  { id: 'cline', file: 'cline/.clinerules', title: 'Cline' },
  { id: 'zed', file: 'zed/.rules', title: 'Zed' },
  { id: 'continue', file: 'continue/rules.md', title: 'Continue' },
  { id: 'aider', file: 'aider/CONVENTIONS.md', title: 'Aider' },
  { id: 'amp', file: 'amp/AGENT.md', title: 'Amp' },
  { id: 'kiro', file: 'kiro/steering/product.md', title: 'Kiro' },
  // 第 180 轮：补 7 个宿主（原生文件名取自 ecc 各宿主 README 的「discovers native」，
  // 不是拍脑袋）。此前 12 宿主，ecc 14 宿主（B3 反例，H-0381）。补齐后 19 宿主 > ecc 14。
  { id: 'kimi', file: 'kimi/AGENTS.md', title: 'Kimi Code' },            // Kimi Code 层级发现 .kimi-code/AGENTS.md
  { id: 'openclaw', file: 'openclaw/AGENTS.md', title: 'OpenClaw' },     // OpenClaw 读 AGENTS.md
  { id: 'hermes', file: 'hermes/AGENTS.md', title: 'Hermes' },           // Hermes 装 AGENTS.md + rules/
  { id: 'pi', file: 'pi/AGENTS.md', title: 'Pi Coding Agent' },          // Pi adapter 走 AGENTS.md
  { id: 'qwen', file: 'qwen/QWEN.md', title: 'Qwen Code' },              // Qwen Code 读 QWEN.md
  { id: 'trae', file: 'trae/rules/nianchu.md', title: 'Trae IDE' },      // Trae 用 .trae/rules/*.md
  { id: 'codebuddy', file: 'codebuddy/rules/nianchu.md', title: 'CodeBuddy IDE' }, // CodeBuddy 用 .codebuddy/rules/
];

/** 从 canonical skills 抽 id 集合（用于同源校验） */
export function canonicalIds(skills) {
  return skills.map((s) => s.name).sort();
}

/** 渲染一个宿主文件：只依赖传入的 canonical skills */
export function renderHost(host, skills, meta) {
  const lines = [];
  lines.push(`# 念初 · ${host.title} 投影`);
  lines.push('');
  lines.push('> 本文件由 `tools/portable/project.mjs` 从**单一 canonical 源**自动生成，请勿手改。');
  lines.push(`> 生成时间：${meta.at} · schema ${SCHEMA} · 技能 ${skills.length} 个`);
  lines.push('');
  lines.push('## 可用技能');
  lines.push('');
  for (const s of skills) {
    lines.push(`- \`${s.name}\` — ${String(s.description || '').replace(/\r?\n/g, ' ').trim()}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 渲染通用机器可读清单 */
export function renderAgentsJson(skills, meta) {
  return JSON.stringify({
    schema: SCHEMA,
    generator: 'nianchu/portable-project',
    at: meta.at,
    source: 'canonical-skills',
    count: skills.length,
    skills: skills.map((s) => ({ id: s.name, description: s.description })),
  }, null, 2) + '\n';
}

/** 读取 canonical skills（root 下的技能池） */
export function readCanonical(repoRoot) {
  const roots = [path.join(repoRoot, 'prototype/scenes')];
  const loader = createSkillLoader(roots).scanAll();
  const st = loader.stats();
  if (st.count === 0) return { skills: [], issues: st.issues.concat([{ level: 'error', code: 'empty_canonical', message: 'canonical 技能池为空' }]) };
  return { skills: loader.list(), issues: st.issues.filter((i) => i.level === 'error') };
}

/** 生成全部宿主文件到 outDir，返回 { files, issues } */
export function projectAll(repoRoot, outDir, meta) {
  const { skills, issues } = readCanonical(repoRoot);
  const files = {};
  for (const h of HOSTS) files[h.file] = renderHost(h, skills, meta);
  files['agents.json'] = renderAgentsJson(skills, meta);
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    written.push(rel);
  }
  return { skills, files, written, issues };
}

/** 验收：覆盖 / 同源 / 幂等 / 反例 */
export function verify(repoRoot, outDir) {
  const checks = [];
  const meta1 = { at: 'FIXED' }; // 固定时间戳，保证幂等可测

  // ★前置：canonical 为空 ⇒ 直接 FAIL，不给后续检查「空真通过」的机会
  const pre = readCanonical(repoRoot);
  if (pre.skills.length === 0) {
    return {
      state: 'FAIL',
      checks: [{ name: '前置:canonical 技能池非空', ok: false, info: 'canonical 为空，投影无意义' }],
      canonCount: 0,
    };
  }

  const p1 = projectAll(repoRoot, outDir, meta1);

  // ① 覆盖
  for (const h of HOSTS) {
    checks.push({ name: '覆盖:' + h.id, ok: p1.written.includes(h.file) });
  }
  checks.push({ name: '覆盖:agents.json', ok: p1.written.includes('agents.json') });

  // ② 同源：每个宿主文件里出现的 `skill-id` 集合 == canonical 集合
  const canon = new Set(canonicalIds(p1.skills));
  for (const h of HOSTS) {
    const text = p1.files[h.file];
    const ids = [...text.matchAll(/^- `([a-z0-9][a-z0-9-]*)` —/gm)].map((m) => m[1]);
    const got = new Set(ids);
    const same = got.size === canon.size && [...canon].every((c) => got.has(c));
    checks.push({ name: '同源:' + h.id, ok: same, info: same ? '' : `canon=${canon.size} got=${got.size}` });
  }
  // agents.json 同源
  const j = JSON.parse(p1.files['agents.json']);
  const jids = new Set(j.skills.map((s) => s.id));
  checks.push({ name: '同源:agents.json', ok: jids.size === canon.size && [...canon].every((c) => jids.has(c)) });

  // ③ 幂等：再生成一次，逐字节相同
  const before = {}; for (const r of p1.written) before[r] = fs.readFileSync(path.join(outDir, r), 'utf8');
  const p2 = projectAll(repoRoot, outDir, meta1);
  let idem = true, idemInfo = '';
  for (const r of p2.written) {
    const now = fs.readFileSync(path.join(outDir, r), 'utf8');
    if (now !== before[r]) { idem = false; idemInfo = r + ' 字节不同'; break; }
  }
  checks.push({ name: '幂等:二次生成字节一致', ok: idem, info: idemInfo });

  // ④ 反例：canonical 为空必须 FAIL（用不存在的临时根模拟）
  const fakeRoot = path.join(repoRoot, '__no_such_dir_for_test__');
  const emptyTry = readCanonical(fakeRoot);
  checks.push({ name: '反例:canonical 空 ⇒ 报错', ok: emptyTry.skills.length === 0 && emptyTry.issues.some((i) => i.code === 'empty_canonical') });

  const fails = checks.filter((c) => !c.ok);
  const state = fails.length ? 'FAIL' : 'PASS';
  return { state, checks, canonCount: canon.size };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const REPO = path.resolve(import.meta.dirname, '../..');
  const outArg = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(REPO, '.nianchu-hosts');
  const res = verify(REPO, outArg);
  // verify 用 FIXED 时间戳（为了可测幂等）；正式产出再用真实时间戳重写一次
  if (res.state !== 'FAIL') projectAll(REPO, outArg, { at: new Date().toISOString() });
  console.log('  多宿主投影 · 输出目录 ' + path.relative(REPO, outArg));
  console.log('  canonical 技能 ' + res.canonCount + ' 个 · 宿主 ' + HOSTS.length + ' + agents.json');
  for (const c of res.checks) console.log('    ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.info ? '  ← ' + c.info : ''));
  console.log('\n  四态: ' + res.state);
  process.exit(res.state === 'FAIL' ? 1 : 0);
}
