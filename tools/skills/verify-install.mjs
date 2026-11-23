#!/usr/bin/env node
/**
 * 技能安装/卸载 验收 —— A12 第三条线
 *
 * ══ 这份验收要证明什么 ══════════════════════════════════════════
 * 不是「install.mjs 文件存在」，而是**六条设计规矩真的生效**：
 *   1. 先校验后落盘 —— 不合格的包绝不落盘
 *   2. 原子写入 —— 中途失败不留半成品
 *   3. 不覆盖已存在 —— 必须显式 --force
 *   4. 路径不许穿越 —— `..`/绝对路径/盘符全部拒绝
 *   5. 有清单可查 —— 装了什么、什么时候、从哪来
 *   6. 卸载可逆 —— 移到 .trash 而非删除；内置技能不许卸
 *
 * ══ 反例为什么是重点 ════════════════════════════════════════════
 * 「能装上」很容易做到；难的是「该拒的真的拒了」。
 * 所以每个反例都断言**具体错误码**，而不是「返回了 ok:false」——
 * 后者可能是别的原因导致的失败，那就等于没测到。
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const GOOD_SKILL = (name) => `---
name: ${name}
category: 测试
description: 这是验收用的临时技能，仅用于测试安装器，不应留在技能池里。
---

# ${name}

## 什么时候用

验收用，不用于真实任务。

## 怎么做

1. 无操作（这是测试技能）
`;

async function main() {
  const { installSkill, uninstallSkill, listInstalled, safeName, hashDir, readManifest, MANIFEST_NAME } =
    await import('../skills/install.mjs');

  // 用临时目录当技能池，绝不碰真实的 prototype/scenes
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nianchu-install-'));
  const pool = path.join(tmpRoot, 'scenes');
  fs.mkdirSync(pool, { recursive: true });
  const srcRoot = path.join(tmpRoot, 'src');
  fs.mkdirSync(srcRoot, { recursive: true });

  const mkSrc = (name, text) => {
    const d = path.join(srcRoot, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), text, 'utf8');
    return d;
  };

  console.log('\n  0. 工具自检：safeName 必须先拒掉危险名字');
  t('拒绝 ..', safeName('..').ok === false);
  t('拒绝含 .. 的名字', safeName('a..b').ok === false);
  t('拒绝路径分隔符 /', safeName('a/b').ok === false);
  t('拒绝路径分隔符 \\', safeName('a\\b').ok === false);
  t('拒绝 Windows 盘符', safeName('C:foo').ok === false);
  t('拒绝空名', safeName('').ok === false);
  t('拒绝 . 开头之外的空格名', safeName(' a').ok === false);
  t('接受正常名字', safeName('my-skill_1.0').ok === true);
  t('拒绝以 . 开头（隐藏目录）', safeName('.hidden').ok === false, JSON.stringify(safeName('.hidden')));

  console.log('\n  1. 正常安装（正例）');
  const s1 = mkSrc('alpha', GOOD_SKILL('alpha'));
  const r1 = installSkill({ source: s1, target: pool, origin: 'test:local' });
  t('安装成功', r1.ok === true, JSON.stringify(r1).slice(0, 120));
  t('目标目录已创建', fs.existsSync(path.join(pool, 'alpha')));
  t('SKILL.md 已就位', fs.existsSync(path.join(pool, 'alpha', 'SKILL.md')));
  t('清单已写', fs.existsSync(path.join(pool, MANIFEST_NAME)));
  const m1 = readManifest(pool);
  t('清单里有这条记录', !!m1.installed.alpha);
  t('记录含来源', m1.installed.alpha?.origin === 'test:local');
  t('记录含哈希', typeof m1.installed.alpha?.hash === 'string' && m1.installed.alpha.hash.length === 64);
  t('暂存目录已清理', !fs.existsSync(path.join(pool, '.staging')) ||
    fs.readdirSync(path.join(pool, '.staging')).length === 0);

  console.log('\n  2. 反例：不合格的包必须拒绝且不落盘');
  const badNoFm = mkSrc('nofm', '# 没有 frontmatter\n\n正文\n');
  const rNoFm = installSkill({ source: badNoFm, target: pool });
  t('缺 frontmatter → 拒绝（code=invalid_skill）', rNoFm.ok === false && rNoFm.code === 'invalid_skill', JSON.stringify(rNoFm).slice(0, 100));
  t('缺 frontmatter → 未落盘', !fs.existsSync(path.join(pool, 'nofm')));

  const badNoDesc = mkSrc('nodesc', '---\nname: nodesc\n---\n\n正文\n');
  const rNoDesc = installSkill({ source: badNoDesc, target: pool });
  t('缺 description → 拒绝', rNoDesc.ok === false && rNoDesc.code === 'invalid_skill');
  t('缺 description → 未落盘', !fs.existsSync(path.join(pool, 'nodesc')));

  const mismatch = mkSrc('dirname-a', GOOD_SKILL('different-name'));
  const rMis = installSkill({ source: mismatch, target: pool });
  t('name 与目录名不一致 → 拒绝', rMis.ok === false && rMis.code === 'invalid_skill');
  t('不一致 → 未落盘', !fs.existsSync(path.join(pool, 'dirname-a')));

  const noSkillMd = path.join(srcRoot, 'empty-dir');
  fs.mkdirSync(noSkillMd, { recursive: true });
  const rNoMd = installSkill({ source: noSkillMd, target: pool });
  t('源目录无 SKILL.md → 拒绝（code=no_skill_md）', rNoMd.ok === false && rNoMd.code === 'no_skill_md');

  const rNoSrc = installSkill({ source: path.join(srcRoot, 'does-not-exist'), target: pool });
  t('源不存在 → 拒绝（code=source_missing）', rNoSrc.ok === false && rNoSrc.code === 'source_missing');

  console.log('\n  3. 反例：路径穿越必须拒绝');
  const sEvil = mkSrc('evil', GOOD_SKILL('evil'));
  for (const evilName of ['../escape', '..\\escape', '/abs/path', 'C:evil', 'a/b', 'a\\b']) {
    const r = installSkill({ source: sEvil, name: evilName, target: pool });
    t('拒绝目标名 ' + JSON.stringify(evilName), r.ok === false && r.code === 'bad_name', JSON.stringify(r).slice(0, 90));
  }
  const dirsNow = fs.readdirSync(pool).filter((x) => !x.startsWith('.') && fs.statSync(path.join(pool, x)).isDirectory()).sort();
  t('穿越尝试后池里没有多余目录', dirsNow.join(',') === 'alpha', '实际目录: ' + dirsNow.join(','));

  console.log('\n  4. 反例：重名必须拒绝（不静默覆盖）');
  const s2 = mkSrc('alpha', GOOD_SKILL('alpha').replace('这是验收用', '这是覆盖后的版本'));
  const r2 = installSkill({ source: s2, target: pool });
  t('已存在 → 拒绝（code=already_exists）', r2.ok === false && r2.code === 'already_exists', JSON.stringify(r2).slice(0, 100));
  const after2 = fs.readFileSync(path.join(pool, 'alpha', 'SKILL.md'), 'utf8');
  t('拒绝后原内容未被改动', after2.includes('这是验收用') && !after2.includes('覆盖后的版本'));

  console.log('\n  5. force 覆盖：旧目录必须留备份');
  const hashBefore = hashDir(path.join(pool, 'alpha'));
  const r3 = installSkill({ source: s2, target: pool, force: true });
  t('force 覆盖成功', r3.ok === true, JSON.stringify(r3).slice(0, 100));
  t('内容确实变了', hashDir(path.join(pool, 'alpha')) !== hashBefore);
  t('旧版本留了 .bak', !!r3.backup && fs.existsSync(r3.backup));
  t('备份里是旧内容', r3.backup && fs.readFileSync(path.join(r3.backup, 'SKILL.md'), 'utf8').includes('这是验收用'));

  console.log('\n  6. dryRun 不落盘');
  const s4 = mkSrc('dry', GOOD_SKILL('dry'));
  const r4 = installSkill({ source: s4, target: pool, dryRun: true });
  t('dryRun 返回 ok', r4.ok === true && r4.dryRun === true);
  t('dryRun 未创建目录', !fs.existsSync(path.join(pool, 'dry')));
  t('dryRun 预告了 wouldOverwrite', r4.wouldOverwrite === false);

  console.log('\n  7. 卸载：只许卸自己装的，且移到 .trash');
  const rU1 = uninstallSkill({ name: 'alpha', target: pool });
  t('卸载成功', rU1.ok === true, JSON.stringify(rU1).slice(0, 100));
  t('目录已移走', !fs.existsSync(path.join(pool, 'alpha')));
  t('移到了 .trash 而非删除', !!rU1.movedTo && fs.existsSync(path.join(pool, rU1.movedTo)));
  t('清单记录已删', !readManifest(pool).installed.alpha);

  const rU2 = uninstallSkill({ name: 'alpha', target: pool });
  t('重复卸载 → not_found', rU2.ok === false && rU2.code === 'not_found');

  // 内置技能（不在清单里）不许卸
  const builtin = path.join(pool, 'builtin-one');
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, 'SKILL.md'), GOOD_SKILL('builtin-one'), 'utf8');
  const rU3 = uninstallSkill({ name: 'builtin-one', target: pool });
  t('内置技能 → 拒绝卸载（code=not_installed）', rU3.ok === false && rU3.code === 'not_installed', JSON.stringify(rU3).slice(0, 100));
  t('内置技能目录仍在', fs.existsSync(builtin));

  console.log('\n  8. 检测「装完之后被改过」');
  const s5 = mkSrc('tamper', GOOD_SKILL('tamper'));
  installSkill({ source: s5, target: pool });
  fs.appendFileSync(path.join(pool, 'tamper', 'SKILL.md'), '\n\n手动追加的一行\n');
  const list = listInstalled(pool);
  const row = list.rows.find((x) => x.name === 'tamper');
  t('清单能报出被改动', row && row.modified === true, JSON.stringify(row));
  const rU4 = uninstallSkill({ name: 'tamper', target: pool, dryRun: true });
  t('卸载前能报 modified', rU4.ok === true && rU4.modified === true);

  console.log('\n  9. 清单损坏必须拒绝操作（不静默当空）');
  const pool2 = path.join(tmpRoot, 'scenes2');
  fs.mkdirSync(pool2, { recursive: true });
  fs.writeFileSync(path.join(pool2, MANIFEST_NAME), '{ 这不是合法 JSON', 'utf8');
  const s6 = mkSrc('beta', GOOD_SKILL('beta'));
  const r6 = installSkill({ source: s6, target: pool2 });
  t('清单损坏 → 拒绝安装（code=manifest_corrupt）', r6.ok === false && r6.code === 'manifest_corrupt', JSON.stringify(r6).slice(0, 100));
  t('清单损坏 → 未落盘', !fs.existsSync(path.join(pool2, 'beta')));
  t('readManifest 报 corrupt', readManifest(pool2).corrupt === true);

  console.log('\n  10. 装进去的技能能被真 loader 扫到');
  const { createSkillLoader } = await import('../skills/loader.mjs');
  const s7 = mkSrc('gamma', GOOD_SKILL('gamma'));
  installSkill({ source: s7, target: pool });
  const loader = createSkillLoader([pool]).scanAll();
  const names = loader.list().map((x) => x.name);
  t('loader 扫到 gamma', names.includes('gamma'), JSON.stringify(names));
  t('loader 无错误', loader.stats().issues.filter((i) => i.level === 'error').length === 0,
    JSON.stringify(loader.stats().issues));
  const body = loader.load('gamma').body;
  t('能懒加载到正文', typeof body === 'string' && body.includes('验收用'));

  // 清理
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力 */ }

  console.log('\n  ──────────────────────────────────────────');
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  const state = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'UNKNOWN');
  console.log('  四态: ' + state);
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}

main().catch((e) => {
  console.error('  ✗ 工具自检失败：' + (e && e.stack || e));
  process.exit(2);
});
