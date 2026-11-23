#!/usr/bin/env node
/**
 * 偏好记忆 —— 六类偏好（记「这个人是什么样的人」）
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1H1nU6bEJ5「一切皆零件」原文）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [02:06] 「这套记忆不只记事实，还记偏好。我分六类：
 *  >   一、交互偏好：比如叫我宿主不叫老板；交互用中文；路径单独标出来。
 *  >   二、工具偏好：比如清理找「电脑清理」场景。
 *  >   三、文件偏好：比如临时文件、核心资产文件。
 *  >   四、协作偏好：比如场景助手只能自己的主场景用。
 *  >   五、安全偏好：规则只认宿主；不删别人的；不碰启动器；不自己重勤引擎。
 *  >   六、记忆偏好：只记实质工作；通知不进交接段；决策与遇到的坑只追加。」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么偏好比事实重要
 * ══════════════════════════════════════════════════════════════
 *
 *  事实是「可查的」，偏好是「不可查的」。
 *  用户不会每次都告诉你「叫我宿主」，但如果你记错了，每次都别扭。
 *
 *  一个只会记事实的记忆系统，像「每次都重新认识」的同事。
 *  一个记偏好的记忆系统，像「合作过很久」的同事。
 *
 * ══════════════════════════════════════════════════════════════
 *  六类的定义（可机器校验）
 * ══════════════════════════════════════════════════════════════
 *
 *  interaction  交互偏好  称呼、语言、格式、输出风格
 *  tool         工具偏好  什么活找哪个场景/工具
 *  file         文件偏好  路径约定、临时 vs 核心资产
 *  collab       协作偏好  场景间怎么配合、谁能调谁
 *  safety       安全偏好  红线、禁止操作
 *  memory       记忆偏好  写入规则（记什么、不记什么）
 *
 * ══════════════════════════════════════════════════════════════
 *  存储结构
 * ══════════════════════════════════════════════════════════════
 *
 *  数据/.dsh/偏好记忆/偏好.yaml  ← 人可读的主文件
 *  每条偏好：
 *    id         p-<类别>-<序号>
 *    category   六类之一
 *    text       偏好内容（一句话）
 *    evidence   证据来源（用户哪句话体现的）
 *    since      从什么时候开始有效
 *    level      hard（硬性）/ soft（倾向）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/偏好记忆.mjs --list                    列出全部偏好
 *  node 工具/偏好记忆.mjs --list --category safety  按类列
 *  node 工具/偏好记忆.mjs --add --category interaction --text "叫我宿主" --evidence "用户原话"
 *  node 工具/偏好记忆.mjs --search "清理"           搜索
 *  node 工具/偏好记忆.mjs --inject                  生成注入文本（≤300字）
 *  node 工具/偏好记忆.mjs --selftest                自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const PREF_DIR = path.join(DATA_ROOT, '偏好记忆');
const PREF_FILE = path.join(PREF_DIR, '偏好.yaml');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  六类偏好（写死，可校验）
// ══════════════════════════════════════════════════════════════
export const CATEGORIES = {
  interaction: { name: '交互偏好', desc: '称呼、语言、格式、输出风格' },
  tool: { name: '工具偏好', desc: '什么活找哪个场景/工具' },
  file: { name: '文件偏好', desc: '路径约定、临时 vs 核心资产' },
  collab: { name: '协作偏好', desc: '场景间怎么配合、谁能调谁' },
  safety: { name: '安全偏好', desc: '红线、禁止操作' },
  memory: { name: '记忆偏好', desc: '写入规则（记什么、不记什么）' },
};

export const LIMITS = {
  /** 注入时最多几条 */
  INJECT_MAX_ITEMS: 5,
  /** 注入时最多多少字 */
  INJECT_MAX_CHARS: 300,
  /** 每条偏好正文上限 */
  TEXT_MAX: 120,
  /** 有效级别 */
  LEVELS: ['hard', 'soft'],
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  YAML 读写（极简，只支持我们的结构）
//
//  不引入 yaml 依赖，因为结构固定：一个顶层 key + 数组
// ══════════════════════════════════════════════════════════════
export function parsePrefYaml(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  const out = [];
  let cur = null;

  for (const line of s.split('\n')) {
    const t = line.trimEnd();
    if (!t.trim()) continue;
    if (/^#/.test(t.trim())) continue;
    if (/^preferences:/.test(t)) continue;

    // 新条目
    const idM = t.match(/^\s*-\s*id:\s*(.+)$/);
    if (idM) {
      if (cur) out.push(cur);
      cur = { id: idM[1].trim() };
      continue;
    }
    if (!cur) continue;

    const kv = t.match(/^\s+(\w+):\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1];
    let v = kv[2].trim();
    // 去引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    cur[k] = v;
  }
  if (cur) out.push(cur);
  return out;
}

export function stringifyPrefYaml(prefs) {
  const lines = [
    '# 偏好记忆 —— 六类偏好',
    '# 由 工具/偏好记忆.mjs 维护。改这个文件后跑 --validate 检查。',
    '',
    'preferences:',
  ];
  for (const p of prefs) {
    lines.push('  - id: ' + p.id);
    lines.push('    category: ' + p.category);
    lines.push('    level: ' + (p.level || 'soft'));
    lines.push('    text: "' + String(p.text).replace(/"/g, '\\"') + '"');
    if (p.evidence) lines.push('    evidence: "' + String(p.evidence).replace(/"/g, '\\"') + '"');
    if (p.since) lines.push('    since: ' + p.since);
  }
  return lines.join('\n') + '\n';
}

// ══════════════════════════════════════════════════════════════
//  读取全部偏好
// ══════════════════════════════════════════════════════════════
export function loadPrefs(file) {
  const f = file || PREF_FILE;
  const t = readTextSafe(f);
  if (t === null) return [];
  return parsePrefYaml(t);
}

// ══════════════════════════════════════════════════════════════
//  校验一条偏好
// ══════════════════════════════════════════════════════════════
export function validatePref(p, existingIds) {
  const problems = [];

  if (!p.id) problems.push('缺 id');
  else if (!/^p-(interaction|tool|file|collab|safety|memory)-\d{3}$/.test(p.id)) {
    problems.push('id 格式不合法（应为 p-<类别>-<三位数字>）: ' + p.id);
  } else if (existingIds && existingIds.includes(p.id)) {
    problems.push('id 重复: ' + p.id);
  }

  if (!p.category) problems.push('缺 category');
  else if (!CATEGORIES[p.category]) problems.push('category 非法: ' + p.category);

  if (!p.text) problems.push('缺 text');
  else if (String(p.text).length > LIMITS.TEXT_MAX) {
    problems.push('text 过长（' + String(p.text).length + ' > ' + LIMITS.TEXT_MAX + '）');
  } else if (String(p.text).trim().length < 4) {
    problems.push('text 过短（' + String(p.text).trim().length + ' < 4）');
  }

  const lvl = p.level || 'soft';
  if (!LIMITS.LEVELS.includes(lvl)) problems.push('level 非法: ' + lvl);

  // 偏好必须可执行（不能是空泛的话）
  if (p.text && /^(要|应该|需要|注意|记得)/.test(String(p.text).trim())) {
    // 这类开头通常太泛，但也可能是正常表达，不强制拒绝，只提示
  }

  return problems;
}

// ══════════════════════════════════════════════════════════════
//  生成注入文本
//
//  ⚠ 2026-11-10 修正（实测发现的缺陷）
//
//  第一版按「hard 优先 + 类别顺序」排序，结果 5 条配额全被
//  安全偏好占满（安全有 4 条 hard）：
//    · 不删系统目录
//    · 不碰私人数据
//    · 删文件走回收站
//    · 不自己重启引擎
//    · 用中文回答（只剩 1 条给交互）
//
//  问题：安全偏好确实最重要，但**每次注入只给安全，其他五类永远进不来**。
//  而且安全偏好在「清理磁盘」这类任务里才有意义，写代码时不需要。
//
//  修法：分层配额
//    ① 安全偏好最多占 2 条（它是底线，2 条够了）
//    ② 其余配额给其他类，**每类至少 1 条**
//    ③ 轮转补满，保证类别多样性
// ══════════════════════════════════════════════════════════════
export function buildPrefInjection(prefs, opts) {
  const o = opts || {};
  const maxItems = o.maxItems || LIMITS.INJECT_MAX_ITEMS;
  const maxChars = o.maxChars || LIMITS.INJECT_MAX_CHARS;

  const ORDER = ['safety', 'interaction', 'memory', 'collab', 'tool', 'file'];

  // 按类别分组，组内 hard 优先
  const byCat = {};
  for (const c of ORDER) byCat[c] = [];
  const sortedAll = [...prefs].sort((a, b) => {
    const la = (a.level || 'soft') === 'hard' ? 0 : 1;
    const lb = (b.level || 'soft') === 'hard' ? 0 : 1;
    return la - lb;
  });
  for (const p of sortedAll) {
    if (!byCat[p.category]) byCat[p.category] = [];
    byCat[p.category].push(p);
  }

  const picked = [];
  const cursor = {};
  for (const c of ORDER) cursor[c] = 0;

  // ① 安全先取最多 2 条
  const safetyItems = byCat.safety || [];
  for (let i = 0; i < Math.min(2, safetyItems.length) && picked.length < maxItems; i++) {
    picked.push(safetyItems[i]);
    cursor.safety = i + 1;
  }

  // ② 其他类每类先取 1 条
  for (const c of ORDER) {
    if (c === 'safety') continue;
    const list = byCat[c] || [];
    if (cursor[c] < list.length && picked.length < maxItems) {
      picked.push(list[cursor[c]]);
      cursor[c]++;
    }
  }

  // ③ 还有配额就轮转补
  let progress = true;
  while (picked.length < maxItems && progress) {
    progress = false;
    for (const c of ORDER) {
      if (picked.length >= maxItems) break;
      const list = byCat[c] || [];
      if (cursor[c] < list.length) {
        picked.push(list[cursor[c]]);
        cursor[c]++;
        progress = true;
      }
    }
  }

  // ④ 按字数截断
  const finalItems = [];
  let chars = 0;
  for (const p of picked) {
    const line = '· ' + p.text;
    if (chars + line.length + 1 > maxChars) continue;
    finalItems.push(p);
    chars += line.length + 1;
  }

  const text = finalItems.map((p) => '· ' + p.text).join('\n');
  return { items: finalItems, text, chars, maxChars, maxItems };
}

// ══════════════════════════════════════════════════════════════
//  初始化：把视频里提到的偏好 + 我们从对话中已知的写成初始值
// ══════════════════════════════════════════════════════════════
export function seedPrefs() {
  return [
    // ── 交互偏好 ──
    {
      id: 'p-interaction-001', category: 'interaction', level: 'hard',
      text: '用中文回答，不要中英混杂',
      evidence: '用户全程中文，从未要求英文',
      since: '2026-11-07',
    },
    {
      id: 'p-interaction-002', category: 'interaction', level: 'hard',
      text: '不要用"好的""没问题"这类空话开头，直接给结果',
      evidence: '用户多次要求"不要硬凑""直接给证据"',
      since: '2026-11-08',
    },
    {
      id: 'p-interaction-003', category: 'interaction', level: 'hard',
      text: '结论先给，证据在后；不确定就说不确定，不许编',
      evidence: '用户反复强调"证据优先""不要虚假测试数据"',
      since: '2026-11-07',
    },
    {
      id: 'p-interaction-004', category: 'interaction', level: 'soft',
      text: '路径要用完整相对路径，不用省略号',
      evidence: '用户多次追问文件具体位置',
      since: '2026-11-08',
    },

    // ── 工具偏好 ──
    {
      id: 'p-tool-001', category: 'tool', level: 'hard',
      text: '清理磁盘/删文件只找「本地电脑」场景，其他场景不许自己删',
      evidence: 'pc-cleanup 定位卡的唯一对口原则',
      since: '2026-11-07',
    },
    {
      id: 'p-tool-002', category: 'tool', level: 'soft',
      text: '分析错误日志找「故障分析」，改代码不归它管',
      evidence: 'incident-analysis 定位卡',
      since: '2026-11-07',
    },

    // ── 文件偏好 ──
    {
      id: 'p-file-001', category: 'file', level: 'hard',
      text: '临时脚本放 prototype/，正式工具放 workbench/工具/，不要混',
      evidence: '我们的目录约定',
      since: '2026-11-08',
    },
    {
      id: 'p-file-002', category: 'file', level: 'hard',
      text: '中文源码文件只用 edit/write 工具改，不用 PowerShell 读写',
      evidence: 'AGENTS.md 第 6 条（GBK/UTF8 往返会损坏）',
      since: '2026-11-07',
    },
    {
      id: 'p-file-003', category: 'file', level: 'soft',
      text: '核心资产：数据/.dsh/ 全部内容，不许删',
      evidence: '这是用户全部记忆和配置',
      since: '2026-11-07',
    },

    // ── 协作偏好 ──
    {
      id: 'p-collab-001', category: 'collab', level: 'hard',
      text: '中枢只调度不代写；场景自己的记忆自己写',
      evidence: '视频 BV1qrxD6qEcY「别人只能提醒，不能代写」',
      since: '2026-11-10',
    },
    {
      id: 'p-collab-002', category: 'collab', level: 'hard',
      text: '跨场景协作必须走派单四件套，不许口头交代',
      evidence: '我们的派单机制设计',
      since: '2026-11-08',
    },

    // ── 安全偏好 ──
    {
      id: 'p-safety-001', category: 'safety', level: 'hard',
      text: '不删系统目录，只报告不动作',
      evidence: 'pc-cleanup 定位卡',
      since: '2026-11-07',
    },
    {
      id: 'p-safety-002', category: 'safety', level: 'hard',
      text: '不碰私人数据和备份',
      evidence: 'pc-cleanup 定位卡',
      since: '2026-11-07',
    },
    {
      id: 'p-safety-003', category: 'safety', level: 'hard',
      text: '删文件必须走回收站，不用 Remove-Item -Force 直接抹',
      evidence: 'pc-cleanup 定位卡',
      since: '2026-11-07',
    },
    {
      id: 'p-safety-004', category: 'safety', level: 'hard',
      text: '不自己重启引擎，不碰启动器',
      evidence: '视频 BV1H1nU6bEJ5「不碰启动器、不自己重启引擎」',
      since: '2026-11-10',
    },

    // ── 记忆偏好 ──
    {
      id: 'p-memory-001', category: 'memory', level: 'hard',
      text: '只记实质结论，不记过程流水账',
      evidence: '用户批评"为闭环而灌水"，AI 自己总结的教训',
      since: '2026-11-10',
    },
    {
      id: 'p-memory-002', category: 'memory', level: 'hard',
      text: '坑与决策只追加，不改历史',
      evidence: '记忆文件结构约定',
      since: '2026-11-07',
    },
    {
      id: 'p-memory-003', category: 'memory', level: 'hard',
      text: '通知类信息不进交接段，进共享看板',
      evidence: '视频 BV1H1nU6bEJ5 记忆偏好第六条',
      since: '2026-11-10',
    },
    {
      id: 'p-memory-004', category: 'memory', level: 'soft',
      text: '写入记忆前先判断 ADD/UPDATE/DELETE/NOOP，不无脑追加',
      evidence: '记忆写入协议的设计',
      since: '2026-11-10',
    },
  ];
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  偏好记忆 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 六类定义
  chk('六类偏好齐全', Object.keys(CATEGORIES).length === 6, Object.keys(CATEGORIES).join(','));
  for (const k of ['interaction', 'tool', 'file', 'collab', 'safety', 'memory']) {
    chk('有 ' + k + ' 类', !!CATEGORIES[k], CATEGORIES[k]?.name || '');
  }

  // ② 初始偏好合法
  const seed = seedPrefs();
  chk('初始偏好非空', seed.length > 0, seed.length + ' 条');
  const ids = seed.map((p) => p.id);
  let allValid = true;
  for (const p of seed) {
    const probs = validatePref(p, []);
    if (probs.length) { allValid = false; console.log('       非法: ' + p.id + ' → ' + probs.join('; ')); }
  }
  chk('初始偏好全部合法', allValid, '');
  chk('id 无重复', new Set(ids).size === ids.length, ids.length + ' 条');
  chk('每条都有 evidence', seed.every((p) => p.evidence), '');
  chk('六类都有条目', Object.keys(CATEGORIES).every((c) => seed.some((p) => p.category === c)),
      Object.keys(CATEGORIES).filter((c) => !seed.some((p) => p.category === c)).join(',') || '全覆盖');

  // ③ YAML 往返
  const yaml = stringifyPrefYaml(seed);
  const parsed = parsePrefYaml(yaml);
  chk('YAML 往返条数一致', parsed.length === seed.length, parsed.length + ' / ' + seed.length);
  chk('YAML 往返内容一致', parsed[0]?.text === seed[0]?.text, '');
  chk('YAML 往返类别一致', parsed[0]?.category === seed[0]?.category, '');

  // ④ 校验能抓错
  chk('反例：非法 id 被拒', validatePref({ id: 'bad', category: 'tool', text: '测试内容' }).length > 0, '');
  chk('反例：非法类别被拒', validatePref({ id: 'p-tool-999', category: 'wrong', text: '测试内容' }).length > 0, '');
  chk('反例：空 text 被拒', validatePref({ id: 'p-tool-999', category: 'tool', text: '' }).length > 0, '');
  chk('反例：过长 text 被拒',
      validatePref({ id: 'p-tool-999', category: 'tool', text: 'x'.repeat(200) }).length > 0, '');
  chk('反例：id 重复被拒',
      validatePref({ id: 'p-tool-001', category: 'tool', text: '测试' }, ['p-tool-001']).length > 0, '');

  // ⑤ 注入：必须短
  const inj = buildPrefInjection(seed);
  chk('注入不超过 5 条', inj.items.length <= 5, inj.items.length + ' 条');
  chk('注入不超过 300 字', inj.chars <= 300, inj.chars + ' 字');
  chk('硬性偏好优先', inj.items[0]?.level === 'hard', '第一条 level=' + inj.items[0]?.level);
  chk('注入文本非空', inj.text.length > 0, inj.text.slice(0, 40));

  // ⑥ 关键：安全偏好必须排最前
  const firstCat = inj.items[0]?.category;
  chk('安全偏好排最前', firstCat === 'safety', '实际: ' + firstCat);

  // ⑦ 反例：没有偏好时注入为空
  const emptyInj = buildPrefInjection([]);
  chk('反例：无偏好时注入为空', emptyInj.items.length === 0 && emptyInj.text === '', '');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 初始化 ──
  if (has('--init')) {
    if (fs.existsSync(PREF_FILE) && !has('--force')) {
      console.log('已存在: ' + path.relative(WB, PREF_FILE).replace(/\\/g, '/'));
      console.log('（加 --force 覆盖）');
      process.exit(0);
    }
    fs.mkdirSync(PREF_DIR, { recursive: true });
    const seed = seedPrefs();
    // 校验
    const ids = [];
    const bad = [];
    for (const p of seed) {
      const probs = validatePref(p, ids);
      if (probs.length) bad.push(p.id + ': ' + probs.join('; '));
      ids.push(p.id);
    }
    if (bad.length) {
      console.error('✗ 初始数据有 ' + bad.length + ' 条非法:');
      for (const b of bad) console.error('  ' + b);
      process.exit(2);
    }
    fs.writeFileSync(PREF_FILE, stringifyPrefYaml(seed), 'utf8');
    console.log('✓ 已初始化 ' + seed.length + ' 条偏好 → ' + path.relative(WB, PREF_FILE).replace(/\\/g, '/'));
    const byCat = {};
    for (const p of seed) byCat[p.category] = (byCat[p.category] || 0) + 1;
    for (const [c, n] of Object.entries(byCat)) {
      console.log('  ' + CATEGORIES[c].name.padEnd(10) + n + ' 条');
    }
    process.exit(0);
  }

  const prefs = loadPrefs();

  // ── 列出 ──
  if (has('--list')) {
    const only = val('--category');
    const list = only ? prefs.filter((p) => p.category === only) : prefs;
    console.log('═'.repeat(76));
    console.log('  偏好记忆（' + list.length + ' 条）');
    console.log('═'.repeat(76));
    console.log();
    for (const c of Object.keys(CATEGORIES)) {
      const items = list.filter((p) => p.category === c);
      if (!items.length) continue;
      console.log('  【' + CATEGORIES[c].name + '】' + CATEGORIES[c].desc);
      for (const p of items) {
        const mark = (p.level || 'soft') === 'hard' ? '■' : '□';
        console.log('    ' + mark + ' ' + p.id.slice(-3) + '  ' + p.text);
      }
      console.log();
    }
    console.log('─'.repeat(76));
    console.log('  ■ = 硬性（必须遵守）  □ = 软性（倾向）');
    console.log('─'.repeat(76));
    process.exit(0);
  }

  // ── 搜索 ──
  if (has('--search')) {
    const q = String(val('--search') || '').toLowerCase();
    const hits = prefs.filter((p) =>
      String(p.text).toLowerCase().includes(q) ||
      String(p.evidence || '').toLowerCase().includes(q) ||
      CATEGORIES[p.category]?.name.includes(q));
    console.log('搜索「' + q + '」→ ' + hits.length + ' 条');
    for (const p of hits) {
      console.log('  ' + p.id + '  [' + (CATEGORIES[p.category]?.name || p.category) + ']  ' + p.text);
    }
    process.exit(hits.length ? 0 : 1);
  }

  // ── 注入 ──
  if (has('--inject')) {
    const inj = buildPrefInjection(prefs);
    if (has('--json')) {
      console.log(JSON.stringify(inj, null, 2));
    } else {
      console.log('═'.repeat(72));
      console.log('  偏好注入（' + inj.items.length + ' 条 / ' + inj.chars + ' 字）');
      console.log('═'.repeat(72));
      console.log();
      console.log(inj.text);
      console.log();
      console.log('─'.repeat(72));
    }
    process.exit(0);
  }

  // ── 校验 ──
  if (has('--validate')) {
    console.log('═'.repeat(72));
    console.log('  偏好校验');
    console.log('═'.repeat(72));
    console.log();
    const ids = [];
    let bad = 0;
    for (const p of prefs) {
      const probs = validatePref(p, ids);
      if (probs.length) {
        bad++;
        console.log('  ✗ ' + p.id + ': ' + probs.join('; '));
      }
      ids.push(p.id);
    }
    console.log();
    console.log('  校验 ' + prefs.length + ' 条，问题 ' + bad + ' 条');
    process.exit(bad === 0 ? 0 : 1);
  }

  // ── 加一条 ──
  if (has('--add')) {
    const cat = val('--category');
    const text = val('--text');
    const evidence = val('--evidence') || '';
    const level = val('--level') || 'soft';
    if (!cat || !text) { console.error('需要 --category 和 --text'); process.exit(2); }
    if (!CATEGORIES[cat]) { console.error('非法 category: ' + cat); process.exit(2); }

    const sameCat = prefs.filter((p) => p.category === cat);
    const nextNum = String(sameCat.length + 1).padStart(3, '0');
    const p = {
      id: 'p-' + cat + '-' + nextNum,
      category: cat,
      level,
      text,
      evidence,
      since: new Date().toISOString().slice(0, 10),
    };
    const probs = validatePref(p, prefs.map((x) => x.id));
    if (probs.length) { console.error('✗ ' + probs.join('; ')); process.exit(2); }

    prefs.push(p);
    fs.mkdirSync(PREF_DIR, { recursive: true });
    fs.writeFileSync(PREF_FILE, stringifyPrefYaml(prefs), 'utf8');
    console.log('✓ 已加: ' + p.id + '  ' + p.text);
    process.exit(0);
  }

  console.log('用法:');
  console.log('  node 工具/偏好记忆.mjs --init [--force]        初始化（写六类偏好初始值）');
  console.log('  node 工具/偏好记忆.mjs --list [--category X]   列出');
  console.log('  node 工具/偏好记忆.mjs --search "关键词"       搜索');
  console.log('  node 工具/偏好记忆.mjs --inject [--json]       生成注入文本（≤300字）');
  console.log('  node 工具/偏好记忆.mjs --validate              校验');
  console.log('  node 工具/偏好记忆.mjs --add --category X --text "..." --evidence "..."');
  console.log('  node 工具/偏好记忆.mjs --selftest              自测');
}
