#!/usr/bin/env node
/**
 * 技能注入层的反例测试。
 *
 * 9 条反例 + 4 条正例。最关键的一条是：
 *   **catalog 里绝不能出现正文** —— 否则「两段式」退化成「一股脑塞 prompt」，
 *   既费 token 又违背 s07 的设计。这条不守住，整个实现就白做。
 */
import { catalogText, createLoadSkillTool, LIMITS } from './inject.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

/** 假 loader：可控的 list()/load() */
function fakeLoader(items) {
  const m = new Map(items.map((i) => [i.name, i]));
  return {
    list: () => items.map((i) => ({ name: i.name, description: i.description })),
    load: (name) => {
      const v = m.get(name);
      if (!v) throw new Error('技能不存在：' + name);
      return { name, description: v.description, body: v.body, path: '/fake/' + name + '/SKILL.md' };
    },
  };
}

const SKILLS = [
  { name: 'pdf', description: '处理 PDF 文件', body: 'PDF-BODY-不要出现在目录里' },
  { name: 'agent-builder', description: '造 agent', body: 'AGENT-BODY' },
];

// ── catalog ──
{
  const c = catalogText(fakeLoader([]));
  t('正例：空目录 → "(none)" 且 count=0', c.count === 0 && /\(none\)/.test(c.text), JSON.stringify(c));
}
{
  const c = catalogText(fakeLoader(SKILLS));
  t('正例：2 个技能 → 2 行目录', c.count === 2 && /- pdf:/.test(c.text) && /- agent-builder:/.test(c.text), c.text.slice(0, 120));
}
{
  const c = catalogText(fakeLoader(SKILLS));
  t('★反例：catalog 里**不能出现正文**（否则两段式退化）',
    !/PDF-BODY/.test(c.text) && !/AGENT-BODY/.test(c.text), c.text);
}
{
  const long = 'x'.repeat(LIMITS.descChars + 50);
  const c = catalogText(fakeLoader([{ name: 'long', description: long, body: 'b' }]));
  t('反例：超长 description 被截断并记录', c.truncated.includes('long') && c.text.length < long.length + 100, 'len=' + c.text.length);
}
{
  const c = catalogText(fakeLoader([{ name: 'x', description: '多行\n描述\r\n带换行', body: 'b' }]));
  t('反例：description 里的换行被压成空格（不能破坏目录格式）', !/\n.*带换行/.test(c.text.split('\n').slice(2).join('\n')), c.text);
}

// ── load_skill ──
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  const r = tool.run({ name: 'pdf' });
  t('正例：有效名字 → 返回正文', r.ok === true && /PDF-BODY/.test(r.body) && r.bytes > 0, JSON.stringify(r).slice(0, 100));
}
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  const r = tool.run({ name: 'nope' });
  t('反例：不存在的技能 → ok:false 且列出已知技能', r.ok === false && Array.isArray(r.known) && r.known.includes('pdf'), JSON.stringify(r));
}
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  const r = tool.run({ name: '../../etc/passwd' });
  t('反例：路径穿越名 → 被拒（不进 loader）', r.ok === false && /不合法/.test(r.error), JSON.stringify(r));
}
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  const r = tool.run({ name: '' });
  t('反例：空名字 → 被拒', r.ok === false && /需要 name/.test(r.error), JSON.stringify(r));
}
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  const r = tool.run({ name: 'a b' });
  t('反例：名字含空格 → 被拒', r.ok === false && /不合法/.test(r.error), JSON.stringify(r));
}
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  const r = tool.run({});
  t('反例：缺参数对象 → 被拒（不抛）', r.ok === false, JSON.stringify(r));
}

// ── register（DSH 形状）──
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  let registered = null;
  const fakeAgent = { ctx: { tools: { register: (def) => { registered = def; return () => {}; } } } };
  const disposer = tool.register(fakeAgent);
  t('正例：register 调用了 agent.ctx.tools.register 并返回 disposer',
    registered && registered.name === 'load_skill' && typeof disposer === 'function', JSON.stringify(Object.keys(registered || {})));
  t('正例：注册的 tools 定义带 parameters.required=[name]',
    registered && registered.parameters && Array.isArray(registered.parameters.required) && registered.parameters.required.includes('name'));
}
{
  const tool = createLoadSkillTool(fakeLoader(SKILLS));
  let threw = false;
  try { tool.register({}); } catch { threw = true; }
  t('反例：没有 DSH agent 时 register 抛错（不静默）', threw);
}

console.log('');
console.log('  技能注入反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
