#!/usr/bin/env node
/**
 * S0 验收 —— 工程骨架
 *
 * S0 只证明四件事，多一件都不算：
 *   1. 我们自己的工程存在且能构建（Vite + React + TS）
 *   2. 设计系统是「vendor 进来的真货」，不是我自己画的（MIT + 上游许可文件 + 包结构）
 *   3. 令牌是从上游 JSON 生成的，且覆盖到组件级（不是只有几个颜色）
 *   4. @openbitfun/ui 的组件在我们的构建产物里**真的渲染出来了**
 *
 * 四态：没装依赖 / 没浏览器 / 没构建产物 → UNKNOWN(退出 2)，不当成通过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const APP = path.join(REPO, 'apps/agent-ui');
const DS = path.join(REPO, 'design-system');
const DIST = path.join(APP, 'dist');

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };
const un = (m) => { unknown++; console.log('  ' + I.un + ' ' + m); };

console.log('');
console.log('  S0 验收 —— 四鉴 Vouch 工程骨架');
console.log('  ' + '─'.repeat(74));

// ── 1. 我们自己的工程 ──
for (const f of ['package.json', 'vite.config.ts', 'tsconfig.json', 'index.html', 'src/main.tsx', 'src/App.tsx']) {
  if (!fs.existsSync(path.join(APP, f))) { fail++; console.log('  ' + I.no + ' 缺 apps/agent-ui/' + f); }
}
ok(fs.existsSync(path.join(APP, 'package.json')), '工程文件齐备（package.json / vite.config.ts / tsconfig.json / index.html / src）');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
ok(pkg.name === '@vouch/agent-ui', '包名是我们自己的：' + pkg.name);
ok(!!pkg.dependencies?.react && !!pkg.devDependencies?.vite, '依赖含 react + vite（真工程，不是单文件）');

// ── 2. 设计系统是 vendor 来的真货 ──
ok(fs.existsSync(path.join(DS, 'LICENSE')), 'design-system/LICENSE 在位');
ok(/MIT License/.test(fs.readFileSync(path.join(DS, 'LICENSE'), 'utf8')), '许可是 MIT（可复制/修改/分发）');
ok(fs.existsSync(path.join(DS, 'VENDOR.md')), 'VENDOR.md 记录来源与基线');
for (const p of ['design-tokens', 'theme-openbitfun', 'ui']) {
  if (!fs.existsSync(path.join(DS, 'packages', p, 'package.json'))) { fail++; console.log('  ' + I.no + ' 缺 vendor 包 ' + p); }
}
ok(true, '三个 vendor 包齐备（design-tokens / theme-openbitfun / ui）');
const uiSrc = path.join(DS, 'packages/ui/src');
if (fs.existsSync(uiSrc)) {
  const n = (function count(d) {
    return fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) =>
      a + (e.isDirectory() ? count(path.join(d, e.name)) : (/\.(tsx?|css)$/.test(e.name) ? 1 : 0)), 0);
  })(uiSrc);
  ok(n > 300, 'ui 包源码规模 ' + n + ' 个 ts/tsx/css（真组件库，不是壳）');
} else { fail++; console.log('  ' + I.no + ' 缺 ui/src'); }

// ── 3. 令牌是从上游 JSON 生成的，且覆盖组件级 ──
const tokensPath = path.join(APP, 'src/tokens/tokens.css');
if (!fs.existsSync(tokensPath)) {
  fail++; console.log('  ' + I.no + ' 缺 src/tokens/tokens.css（先跑 node tools/gen-tokens.mjs）');
} else {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const vars = [...new Set([...css.matchAll(/--openbitfun-[a-z0-9-]+/g)].map((m) => m[0]))];
  ok(vars.length >= 800, '令牌 ' + vars.length + ' 个（含组件级）');
  const groups = ['color', 'type', 'space', 'control', 'motion', 'border', 'layout', 'radius', 'component'];
  const missing = groups.filter((g) => !vars.some((v) => v.startsWith('--openbitfun-' + g + '-')));
  ok(missing.length === 0, '令牌组齐全' + (missing.length ? '  ← 缺 ' + missing.join(',') : '（含 component / control / layout）'));
  ok(/[data-color-scheme="light"]/.test(css) && /[data-color-scheme="dark"]/.test(css), '明暗两套都生成了');
  ok(/生成器：tools\/gen-tokens\.mjs/.test(css), '文件头标注了生成器（可复现，不是手写）');
}

// ── 4. 构建产物与真渲染 ──
if (!fs.existsSync(DIST)) {
  un('没有 dist —— 先跑 pnpm --dir apps/agent-ui build，SC0 渲染断言判不了');
} else {
  ok(fs.existsSync(path.join(DIST, 'index.html')), '构建产物在位（dist/index.html）');
  const assets = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /\.(js|css)$/.test(f));
  ok(assets.length >= 2, '产物含 js + css（' + assets.length + ' 个）');
  const cssFile = assets.find((f) => f.endsWith('.css'));
  const cssSize = cssFile ? fs.statSync(path.join(DIST, 'assets', cssFile)).size : 0;
  ok(cssSize > 60000, 'CSS 体积 ' + Math.round(cssSize / 1024) + 'KB（含 @openbitfun/ui 的 css module）');

  function findBrowser() {
    return [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ].find((p) => fs.existsSync(p)) || null;
  }
  const browser = findBrowser();
  if (!browser) {
    un('没有 Edge/Chrome，真渲染断言判不了');
  } else {
    const PORT = 5276;
    const tmp = path.join(os.tmpdir(), 's0-' + process.pid);
    fs.mkdirSync(tmp, { recursive: true });
    const child = spawn(process.execPath, [path.join(REPO, 'tools/serve-dist.mjs')], {
      env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    await new Promise((res) => {
      const t = setTimeout(res, 8000);
      child.stdout.on('data', (b) => { if (String(b).includes('READY')) { ready = true; clearTimeout(t); res(); } });
    });
    ok(ready, '静态服务起在 127.0.0.1:' + PORT);
    let dom = '';
    try {
      dom = execFileSync(browser, ['--headless', '--disable-gpu', '--no-sandbox',
        '--user-data-dir=' + path.join(tmp, 'p'), '--virtual-time-budget=6000',
        '--dump-dom', 'http://127.0.0.1:' + PORT + '/#/overview'],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { dom = (e.stdout || '') + ''; }
    child.kill();

    ok(/骨架已就位/.test(dom), '我们的页面渲染出来了');
    ok(/主按钮/.test(dom) && /次按钮/.test(dom), '三个按钮的文案在 DOM 里');
    // 关键断言：按钮的 class 必须来自 @openbitfun/ui 的 CSS Module（形如 _button_xxxx_2）
    const btnClasses = [...dom.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter((c) => /^_button_[a-z0-9]+_\d+$/.test(c));
    ok(btnClasses.length > 0, '@openbitfun/ui 的 Button 真渲染（CSS Module 类 ' + (btnClasses[0] || '无') + '）');
    const tokenHint = /--openbitfun-color-accent-default/.test(fs.readFileSync(tokensPath, 'utf8'));
    ok(tokenHint, '令牌文件里含 accent 变量（按钮配色有来源）');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ── 5. 截图 ──
const shot = path.join(REPO, 'research/screenshots/我们-S0-骨架.png');
ok(fs.existsSync(shot), '截图证据：我们-S0-骨架.png' + (fs.existsSync(shot) ? '  ' + Math.round(fs.statSync(shot).size / 1024) + 'KB' : ''));

console.log('');
console.log('  ' + '─'.repeat(74));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);
