#!/usr/bin/env node
/**
 * 技能自我进化台账 —— 让每个场景 skill 可以持续精进且**可追溯**。
 *
 * 依据 claude.dev 文章：skills 应「encode your own opinions / best practices」，且模型越强越该由
 *   人（或未来由模型）不断精简精进。但「进化」必须留痕：谁改了、为什么、改前改后、体检是否通过。
 *
 * 本工具维护 append-only 台账 research/skill-evolution.json：
 *   { skills: { <name>: { version, updatedAt, history: [{at, version, bytes, hard, hardPerKB, verdict, trigger, note}] } } }
 *
 * 动作：
 *   snapshot                 把所有现有技能记为基线（version=1；已存在则仅在有变化时追加）
 *   record <name> --trigger ... --note ...   记录一次精进（version+1）；**doctor 判 FAIL 则拒绝**
 *   list                     打印每个技能的版本/体量/硬约束/历史条数
 *
 * 不调用模型：本工具是「进化记录 + 体检闸门」的机制；真正的改写可由人、或将来由模型按 doctor 建议做。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSkills, diagnose } from './doctor.mjs';
import { validateSkill } from './loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEDGER = path.join(ROOT, 'research/skill-evolution.json');
const GATEWAY = process.env.NIANCHU_GATEWAY || 'http://127.0.0.1:3425/v1/chat/completions';
const DEFAULT_MODEL = process.env.NIANCHU_MODEL || 'auto/claude-haiku-5-5';

function load() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { skills: {} }; } }
function save(d) { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(d, null, 2) + '\n', 'utf8'); }
const now = () => new Date().toISOString();
function metrics(s) { return { bytes: s.bytes, hard: s.hard, hardPerKB: s.hardPerKB }; }
function verdictOf(skills, name) {
  const d = diagnose(skills);
  const row = d.rows.find((r) => r.name === name);
  if (!row) return 'UNKNOWN';
  return row.flags.some((f) => f.level === 'FAIL') ? 'FAIL' : row.flags.some((f) => f.level === 'WARN') ? 'WARN' : 'PASS';
}

const args = process.argv.slice(2);
const action = args[0] || 'list';
const skills = readSkills();
const d = load();
const dg = diagnose(skills);

if (action === 'snapshot') {
  let added = 0, updated = 0;
  for (const s of skills) {
    const m = metrics(s);
    const verdict = verdictOf(skills, s.name);
    if (!d.skills[s.name]) { d.skills[s.name] = { version: 1, updatedAt: now(), history: [{ at: now(), version: 1, ...m, verdict, trigger: 'snapshot', note: '基线' }] }; added++; }
    else {
      const last = d.skills[s.name].history[d.skills[s.name].history.length - 1];
      if (last.bytes !== m.bytes || last.hard !== m.hard) {
        const v = d.skills[s.name].version + 1;
        d.skills[s.name].version = v; d.skills[s.name].updatedAt = now();
        d.skills[s.name].history.push({ at: now(), version: v, ...m, verdict, trigger: 'snapshot', note: '内容变化（snapshot 自动记录）' });
        updated++;
      }
    }
  }
  save(d);
  console.log('  快照完成：新增 ' + added + ' · 变化 ' + updated + ' · 共 ' + Object.keys(d.skills).length + ' 个技能台账');
  process.exit(0);
}

if (action === 'record') {
  const name = args[1];
  if (!name) { console.error('  用法: evolve.mjs record <skillName> --trigger <t> --note <n>'); process.exit(2); }
  if (!d.skills[name]) { console.error('  ✗ 台账无此技能（先 snapshot）：' + name); process.exit(2); }
  const trig = (args[args.indexOf('--trigger') + 1] || 'manual');
  const note = (args[args.indexOf('--note') + 1] || '');
  const verdict = verdictOf(skills, name);
  if (verdict === 'FAIL') { console.error('  ✗ doctor 判 FAIL，拒绝记录这次「精进」（先修到不 FAIL）：' + name); process.exit(1); }
  const s = skills.find((x) => x.name === name);
  if (!s) { console.error('  ✗ 未发现技能：' + name); process.exit(2); }
  const v = d.skills[name].version + 1;
  d.skills[name].version = v; d.skills[name].updatedAt = now();
  d.skills[name].history.push({ at: now(), version: v, ...metrics(s), verdict, trigger: trig, note });
  save(d);
  console.log('  ✓ 已记录 ' + name + ' v' + v + ' · ' + JSON.stringify(metrics(s)) + ' · doctor=' + verdict);
  process.exit(0);
}

// evolve-skill：模型按 doctor 建议重写正文 → 校验 → 复检 → 变小才留（否则回滚）→ 记录
if (action === 'evolve-skill') {
  const name = args[1];
  if (!name) { console.error('  用法: evolve.mjs evolve-skill <skillName>'); process.exit(2); }
  const file = path.join(ROOT, 'prototype/scenes', name, 'SKILL.md');
  if (!fs.existsSync(file)) { console.error('  ✗ 无此技能文件：' + file); process.exit(2); }
  const beforeText = fs.readFileSync(file, 'utf8');
  const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(beforeText);
  if (!fmMatch) { console.error('  ✗ 无 frontmatter'); process.exit(2); }
  const fm = fmMatch[0];
  const beforeBody = beforeText.slice(fm.length);
  const beforeBytes = Buffer.byteLength(beforeBody, 'utf8');
  const row = diagnose(skills).rows.find((r) => r.name === name);
  const hints = row ? row.flags : [];
  const hintText = hints.length ? hints.map((f) => '- ' + f.code + ': ' + f.msg).join('\n')
    : '（无明显问题，仍可精简冗余与显然内容、去重复、强化本场景特有的判断与坑）';

  const sys = 'You are a ruthless editor of an AGENT SKILL (a lightweight guide read by an AI agent). Rewrite the BODY smaller and sharper per context-engineering rules for stronger models: prefer judgement over rigid rules; keep hard constraints ONLY where truly important; drop obvious/file-system-knowable content; avoid repeating yourself; encode product/team-specific opinions, gotchas, and verification steps. Output ONLY the new markdown body (no frontmatter, no code fences). Keep the same language as the input (Chinese).';
  const user = 'Current body of skill "' + name + '":\n\n' + beforeBody + '\n\nDoctor hints:\n' + hintText +
    '\n\nRewrite the body per the rules. Keep it under ' + Math.max(300, Math.floor(beforeBytes * 0.85)) + ' bytes and do not lose unique domain value.';

  let content = '';
  try {
    const res = await fetch(GATEWAY, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: 1600, stream: false }) });
    if (!res.ok) { const t = (await res.text()).slice(0, 120); throw new Error('gateway ' + res.status + ' ' + t); }
    const j = await res.json();
    content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) { console.error('  ✗ 模型调用失败：' + e.message + '  → 本次进化未发生（UNKNOWN）'); process.exit(2); }

  let body = String(content).trim().replace(/^```[a-zA-Z]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();
  if (!body) { console.error('  ✗ 模型返回空，拒绝落盘'); process.exit(1); }
  const newText = fm + '\n' + body + '\n';
  const v = validateSkill(name, newText);
  if (!v.ok) { console.error('  ✗ 重写后 loader 校验不过（拒绝落盘）：' + JSON.stringify(v.issues)); process.exit(1); }

  const newBytes = Buffer.byteLength(body, 'utf8');
  // ★语义保真闸（反例驱动）：重写后正文必须仍覆盖 description 里的关键意图词，
  //   否则视为「精简把该说的丢了」→ 拒绝落盘。从 description 抽中文/英文实词（去停用词）。
  const desc = (/description:\s*(.+)/.exec(fm) || [])[1] || '';
  const STOP = new Set(['当用户','检查','修复','相关','使用','一个','以及','或者','进行','是否','可以','需要','然后','这个','那个','我们','对','的','了','和','与','在','是','要','能','会','把','被','给','为','个']);
  const intentWords = (desc.match(/[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}/g) || [])
    .map((w) => w.trim()).filter((w) => !STOP.has(w) && w.length >= 2);
  const covered = intentWords.filter((w) => body.includes(w));
  const coverRatio = intentWords.length ? covered.length / intentWords.length : 1;
  if (intentWords.length >= 2 && coverRatio < 0.5) {
    fs.writeFileSync(file, beforeText, 'utf8'); // 回滚
    console.error('  ✗ 拒绝：重写疑似丢失意图（description 关键意图词覆盖 ' + Math.round(coverRatio * 100) + '%<' + '50%，未覆盖：' +
      intentWords.filter((w) => !body.includes(w)).slice(0, 6).join('、') + '），已回滚');
    process.exit(1);
  }

  fs.writeFileSync(file, newText, 'utf8');
  const after = readSkills();
  const row2 = diagnose(after).rows.find((r) => r.name === name);
  const afterFail = row2 && row2.flags.some((f) => f.level === 'FAIL');
  if (afterFail || newBytes >= beforeBytes) {
    fs.writeFileSync(file, beforeText, 'utf8'); // 回滚
    console.error('  ✗ 拒绝：' + (afterFail ? '重写后 doctor FAIL' : '未变小(' + beforeBytes + '→' + newBytes + 'B)') + '，已回滚，版本不变');
    process.exit(1);
  }
  const rec = d.skills[name] || { version: 0, history: [] };
  const v2 = rec.version + 1;
  const s2 = after.find((x) => x.name === name);
  d.skills[name] = { version: v2, updatedAt: now(), history: [...(rec.history || []), { at: now(), version: v2, ...metrics(s2), verdict: 'PASS', trigger: 'model-doctor-evolve', note: '模型按 doctor 精简' }] };
  save(d);
  const logPath = path.join(ROOT, 'evidence/skills/evolution-log.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify({ at: now(), skill: name, beforeBytes, afterBytes: newBytes, model: DEFAULT_MODEL, hints: hints.map((h) => h.code) }) + '\n', 'utf8');
  console.log('  ✓ ' + name + ' 进化 v' + v2 + '：' + beforeBytes + 'B → ' + newBytes + 'B（doctor PASS）');
  process.exit(0);
}

// list
console.log('');
console.log('  技能进化台账 · ' + Object.keys(d.skills).length + ' 个技能');
console.log('  ' + '─'.repeat(66));
for (const [name, rec] of Object.entries(d.skills).sort()) {
  const last = rec.history[rec.history.length - 1] || {};
  console.log('  ' + name.padEnd(20) + ' v' + String(rec.version).padEnd(3) + ' ' + String(last.bytes || '?').padStart(6) + 'B 硬' + String(last.hard || 0).padStart(2) + ' · 历史 ' + rec.history.length + ' 条 · ' + (last.verdict || ''));
}
console.log('');