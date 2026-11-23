#!/usr/bin/env node
/**
 * 技能可见性体检 —— 每个场景会话能不能看到自己的技能
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-12 改（机制审计 ①2「判据唯一出处」一直不满足）
 * ══════════════════════════════════════════════════════════════
 *
 *  病根不是「没写 export」，而是**同一个判据在这个文件里写了两份**：
 *
 *    自测【二】【三】：手写 /^---\r?\n[\s\S]*?\r?\n---/ 判 frontmatter，
 *                      手写 /^name:\s*\S+/m 判 name、/^description:\s*\S+/m 判 desc
 *    真实检查（磁盘层）：**又手写一遍**同样的三条正则，还多一条「name 与目录名一致」
 *
 *  两份判据的必然结局是漂移：自测只验了「有 name」，真实检查却还查「name 是否等于目录名」，
 *  于是自测全绿也不代表真实检查的判据是对的；改一处忘另一处，就是「两处各判一次」。
 *
 *  修法（不是加一行假 export）：
 *    把判据提成唯一的 judgeSkill() / judgeVisible()，**export 出去**，
 *    自测和真实检查都调它 —— 文件里不再有第二份 frontmatter 正则。
 *    机制审计 ①2 认的「判据已 export」因此是真的：别的工具也能 import 同一份判据。
 *
 *  另外把网络探测收进 main() 并加 isMain 守卫：
 *    原来 import 这个文件就会发 HTTP 请求（顶层 await），
 *    「可复用的唯一出处」如果一 import 就联网，那 export 也只是个摆设。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { sceneNames } from './_场景清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const SKILLS_DIR = path.join(DATA, 'skills');

// ══════════════════════════════════════════════════════════════
//  判据唯一出处（export 出去，自测 / 真实检查 / 其他工具共用这一份）
// ══════════════════════════════════════════════════════════════

/** 技能 frontmatter 必备字段（判据的一部分，唯一出处） */
export const REQUIRED_FIELDS = ['name', 'description'];

/** YAML frontmatter 的唯一正则 —— 全文件只此一处定义 */
export const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * 取出 frontmatter 正文
 * @returns {string|null} 没有 frontmatter 返回 null（区别于「有但为空」）
 */
export function parseFrontmatter(content) {
  const m = String(content || '').match(FM_RE);
  return m ? m[1] : null;
}

/**
 * 判一个技能目录是否合格 —— **唯一判据出处**
 *
 * 判据四条：
 *   ① 有 YAML frontmatter
 *   ② frontmatter 里有 name
 *   ③ frontmatter 里有 description
 *   ④ name 与目录名一致（`_` 开头的是探针/共享目录，不做这条）
 *
 * @param {string} dirName 技能目录名
 * @param {string} content SKILL.md 全文
 * @returns {{ok:boolean, problems:string[], name:string|null}}
 */
export function judgeSkill(dirName, content) {
  const fm = parseFrontmatter(content);
  // 判据①：没有 frontmatter 直接出局，后面的字段检查没有意义
  if (fm === null) {
    return { ok: false, problems: ['无 frontmatter'], name: null };
  }

  const problems = [];
  const nameM = fm.match(/^name:\s*(\S+)/m);
  const descM = fm.match(/^description:\s*(\S+)/m);

  // 判据②③
  if (!nameM) problems.push('frontmatter 缺 name');
  if (!descM) problems.push('frontmatter 缺 description');

  // 判据④：目录名与 name 必须一致，否则引擎按目录挂载、按 name 暴露，两边对不上
  const dir = String(dirName || '');
  if (nameM && dir && !dir.startsWith('_') && nameM[1] !== dir) {
    problems.push('name=' + nameM[1] + ' 与目录名不一致');
  }

  return { ok: problems.length === 0, problems, name: nameM ? nameM[1] : null };
}

/**
 * 判「引擎可见性」—— 场景会话的 skills/list 里有没有期望的那个技能
 * @param {string[]} names 引擎返回的技能名列表
 * @param {string} want 该场景期望看到的技能名
 */
export function judgeVisible(names, want) {
  const list = Array.isArray(names) ? names : [];
  if (!want) return { ok: false, problems: ['没有期望技能（场景→技能映射缺失）'] };
  const ok = list.includes(want);
  return { ok, problems: ok ? [] : ['期望技能 ' + want + ' 不在可见列表里（可见 ' + list.length + ' 个）'] };
}

// ══════════════════════════════════════════════════════════════
//  真实检查（联网）
//
//  ⚠ 2026-11-12：原来这段是模块顶层直接执行（含 await），
//    import 本文件就会发请求、读 server.log、甚至 process.exit。
//    收进 main() + isMain 守卫后，export 出来的判据才是真能复用的。
// ══════════════════════════════════════════════════════════════
async function main() {
  const logPath = path.join(WB, '外壳', 'server.log');
  let log = '';
  try { log = fs.readFileSync(logPath, 'utf8'); } catch { log = ''; }
  const ms = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)];
  const token = ms.length ? ms[ms.length - 1][1] : '';

  const cookie = await new Promise((r) => {
    const q = http.request({ hostname: '127.0.0.1', port: 3083, path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 5000 }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => r(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    q.on('error', () => r(''));
    q.end();
  });

  function rpc(method, args) {
    return new Promise((resolve) => {
      const body = JSON.stringify({ type: 'client-request', rpcId: 'r' + Date.now(), method, payload: { args: args || {} } });
      const req = http.request({ hostname: '127.0.0.1', port: 3083, path: '/api/' + method, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie, Origin: 'http://127.0.0.1:3083' }, timeout: 30000 },
        (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /**/ } resolve(j); }); });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }

  console.log('='.repeat(78));
  console.log('  每个场景会话能看到哪些技能');
  console.log('='.repeat(78));
  console.log();

  const sl = await rpc('session/list', { _request: {} });
  const items = (sl && sl.result && sl.result.value && sl.result.value.items) || [];
  const MEM = path.join(DATA, '场景记忆');
  const norm = (s) => String(s || '').replace(/[\\/]+/g, '/').toLowerCase();

  // ⚠ 2026-11-14 改：不再硬编码，从 scenarios/*.json 动态读
  const SCENES = sceneNames();
  const SKILL_BY_SCENE = {
    '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
    '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
    '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
  };

  let allOk = 0;
  const problems = [];

  for (const scene of SCENES) {
    const tgt = norm(path.join(MEM, scene));
    const sess = items.filter((x) => norm(x.cwd) === tgt).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (!sess) { console.log('  ? ' + scene.padEnd(12) + ' 无会话'); continue; }

    const r = await rpc('skills/list', { request: { sessionId: sess.sessionId } });
    if (!r || !r.result || !r.result.ok) {
      console.log('  ✗ ' + scene.padEnd(12) + ' 调用失败: ' + JSON.stringify(r && r.result && r.result.error).slice(0, 80));
      problems.push({ scene, why: 'rpc-fail' });
      continue;
    }

    const v = r.result.value || {};
    const list = v.skills || [];
    const names = list.map((s) => s.name || s.id || '');
    const want = SKILL_BY_SCENE[scene];
    // ⚠ 2026-11-12：可见性判据走唯一出处 judgeVisible()
    const vis = judgeVisible(names, want);
    const has = vis.ok;

    if (has) allOk++;
    else problems.push({ scene, why: 'skill-not-visible', want, got: names.slice(0, 8) });

    console.log('  ' + (has ? 'OK' : 'XX') + ' ' + scene.padEnd(12) +
      ' 技能数=' + String(list.length).padStart(2) +
      '  期望技能=' + want +
      '  ' + (has ? '(可见)' : '(不可见!)'));
    if (!has) {
      console.log('       实际可见: ' + names.slice(0, 10).join(', '));
    }
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  结果: ' + allOk + ' / ' + SCENES.length + ' 个场景能看到自己的技能');
  if (problems.length) {
    console.log();
    console.log('  问题:');
    problems.forEach((p) => console.log('    ' + p.scene + ': ' + p.why + (p.want ? ' 期望=' + p.want : '')));
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增：磁盘层检查（破坏性验证抓出来的）
  //
  //  只测引擎 skills/list 的局限：
  //    · 引擎有缓存，改磁盘后要等 watcher 重扫才反映
  //    · 实测：把 research 技能目录改名后立刻跑，它仍报「9 / 9 能看到」
  //    · 所以「引擎能看到」≠「磁盘上真的是对的」
  //
  //  补一层直接读磁盘的检查 —— 判据用 judgeSkill()，与自测同一份，不再另写正则。
  // ══════════════════════════════════════════════════════════════════════
  const diskProblems = [];
  if (fs.existsSync(SKILLS_DIR)) {
    for (const d of fs.readdirSync(SKILLS_DIR)) {
      const dir = path.join(SKILLS_DIR, d);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const p = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(p)) { diskProblems.push(d + ': 无 SKILL.md'); continue; }
      let cc = '';
      try { cc = fs.readFileSync(p, 'utf8'); } catch { diskProblems.push(d + ': 读不了'); continue; }
      // 唯一判据出处
      const r = judgeSkill(d, cc);
      for (const x of r.problems) diskProblems.push(d + ': ' + x);
    }
  }
  if (diskProblems.length) {
    console.log();
    console.log('  ⚠ 磁盘层问题（引擎缓存可能掩盖）:');
    diskProblems.forEach((x) => console.log('    · ' + x));
  }
  // ⚠ 2026-11-12 修（破坏性验证抓出来的）：
  //   原来只 process.exit(problems.length ? 1 : 0) —— 只按「引擎层问题」决定。
  //   实测：把技能目录改名后，引擎缓存仍报 9/9（problems=0），
  //        但磁盘层抓到了「name 与目录名不一致」。
  //        结果输出里明明印了警告，exit code 却是 0 → 机制体检判 PASS → 装饰。
  //
  //   修法：两层任一有问题都要 exit 1。
  const totalProblems = problems.length + diskProblems.length;
  process.exit(totalProblems > 0 ? 1 : 0);
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  技能可见性体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】本地技能文件');
  const dirs = fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR).filter((d) => fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md'))) : [];
  chk('技能目录存在', fs.existsSync(SKILLS_DIR));
  chk('技能数 >= 9', dirs.length >= 9, dirs.length + ' 个');

  console.log();
  console.log('【二】每个真实技能都过 judgeSkill（唯一判据，与磁盘层检查同一份）');
  // ⚠ 2026-11-12：这里原来自己写了一遍 frontmatter 正则和 name/description 正则，
  //   与下面磁盘层检查的第二份判据并存。现在两边都调 judgeSkill()。
  const judged = dirs.map((d) => {
    let cc = '';
    try { cc = fs.readFileSync(path.join(SKILLS_DIR, d, 'SKILL.md'), 'utf8'); } catch { cc = ''; }
    return { d, r: judgeSkill(d, cc) };
  });
  const badReal = judged.filter((x) => !x.r.ok);
  chk('所有技能都有 YAML frontmatter（判据①）',
    badReal.every((x) => !x.r.problems.includes('无 frontmatter')),
    judged.filter((x) => x.r.problems.includes('无 frontmatter')).map((x) => x.d).join(', ') || dirs.length + ' 个全有');
  chk('都有 name 字段（判据②）',
    badReal.every((x) => !x.r.problems.some((p) => p.includes('缺 name'))),
    judged.filter((x) => x.r.problems.some((p) => p.includes('缺 name'))).map((x) => x.d).join(', ') || '全有');
  chk('都有 description 字段（判据③）',
    badReal.every((x) => !x.r.problems.some((p) => p.includes('缺 description'))),
    judged.filter((x) => x.r.problems.some((p) => p.includes('缺 description'))).map((x) => x.d).join(', ') || '全有');
  chk('name 与目录名一致（判据④）',
    badReal.every((x) => !x.r.problems.some((p) => p.includes('不一致'))),
    judged.filter((x) => x.r.problems.some((p) => p.includes('不一致'))).map((x) => x.d + ':' + x.r.problems.join('/')).join('; ') || '全一致');

  console.log();
  console.log('【三】反例：判据对坏数据必须判不合格（不是永远为真）');
  // ⚠ 2026-11-12 新增。这几条是**真造坏数据**，不是 chk('反例', 1===1)。
  //   每条都直接打 judgeSkill —— 也就是真实检查用的同一份判据。

  // 反例①：完全没有 frontmatter
  const noFm = judgeSkill('demo', '# 无 frontmatter 的技能\n\n这是自测探针。\n');
  chk('反例：无 frontmatter 必须判不合格',
    noFm.ok === false && noFm.problems.includes('无 frontmatter'),
    noFm.problems.join(','));

  // 反例②：有 frontmatter 但缺 description
  const noDesc = judgeSkill('demo', '---\nname: demo\n---\n\n正文\n');
  chk('反例：缺 description 必须判不合格',
    noDesc.ok === false && noDesc.problems.some((p) => p.includes('缺 description')),
    noDesc.problems.join(','));

  // 反例③：name 与目录名不一致（引擎按目录挂载、按 name 暴露，对不上就是挂错）
  const nameMis = judgeSkill('demo', '---\nname: other\ndescription: 说明文字\n---\n');
  chk('反例：name 与目录名不一致必须判不合格',
    nameMis.ok === false && nameMis.problems.some((p) => p.includes('不一致')),
    nameMis.problems.join(','));

  // 反例④：引擎列表里没有期望技能 → 必须判不可见
  chk('反例：引擎列表缺期望技能必须判不可见',
    judgeVisible(['arch-review', 'hub'], 'reverse-eng').ok === false,
    judgeVisible(['arch-review', 'hub'], 'reverse-eng').problems.join(','));

  // 正面对照（防止判据退化成「全拒」）
  chk('合格样例必须能过（否则判据是「全拒」）',
    judgeSkill('demo', '---\nname: demo\ndescription: 说明文字\n---\n').ok === true, '');
  chk('引擎列表有期望技能必须判可见',
    judgeVisible(['arch-review', 'hub'], 'hub').ok === true, '');

  console.log();
  console.log('【四】反例：真的写一个无 frontmatter 的文件到磁盘，判据必须报出来');
  {
    const probeDir = path.join(SKILLS_DIR, '__selftest_probe__');
    const probeFile = path.join(probeDir, 'SKILL.md');
    let restored = false;
    try {
      fs.mkdirSync(probeDir, { recursive: true });
      fs.writeFileSync(probeFile, '# 无 frontmatter 的技能\n\n这是自测探针。\n', 'utf8');
      // ⚠ 2026-11-12：改用 judgeSkill（唯一判据），不再在自测里另写一遍正则
      const r = judgeSkill('__selftest_probe__', fs.readFileSync(probeFile, 'utf8'));
      chk('反例：磁盘上的无 frontmatter 文件被判「缺失」',
        r.ok === false && r.problems.includes('无 frontmatter'),
        r.ok ? '竟然认为合格' : '正确识别');
    } finally {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); restored = true; } catch { /* */ }
    }
    chk('清理探针', restored);
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  } else {
    await main();
  }
}
