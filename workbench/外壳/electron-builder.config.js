// ══════════════════════════════════════════════════════════════════════
//  打包配置（electron-builder）
// ══════════════════════════════════════════════════════════════════════
//
//  为什么需要这个文件
//  ──────────────────────────────────────────────────────────────────
//  用户要求「项目直接做成软件」—— 明确选了「完整桌面软件」（不是 exe 快捷方式、
//  不是 Web 应用）。
//
//  现状：`electron-builder` 早就装在 devDependencies 里，但**零配置**，
//  所以这个工作台至今只能双击 `启动.vbs` 跑源码 —— 那不是一个软件，
//  那是一份需要 Node.js + 依赖目录的源码。
//
//  打包要解决的三个真实问题
//  ──────────────────────────────────────────────────────────────────
//  ① 目录关系
//     源码结构是四个同级目录：引擎/ 外壳/ 数据/ 工具/
//     而 Electron 打包后，app 在 resources/app.asar 里，
//     引擎和工具在它外面 —— 必须用 extraResources 把这三块放进去，
//     并且在运行时把路径算对（main.js 里的 DATA_DIR / 引擎路径）。
//
//  ② 不能把运行时数据打进包
//     数据/.dsh/sessions、storages、外壳/data/electron-profile 都是
//     可再生的运行时数据，打进安装包会让包大几百 MB，而且第一次启动就是脏的。
//
//  ③ 升级不能覆盖用户的场景记忆
//     数据/.dsh/场景记忆 是核心资产（12 个场景的记忆/身份卡/产物）。
//     装新版本如果把这些覆盖掉 = 用户的所有积累丢失。
//     electron-builder 的 extraResources 每次安装会覆盖，
//     所以不能把「用户数据」放在 extraResources 里 ——
//     应该首次启动时从模板复制到 %APPDATA% 或用户指定的位置。
//
//  ⚠ 当前这一步只做「能打包出可运行的安装包」，
//    用户数据的安全迁移（第 ③ 点）在 main.js 里单独处理。
// ══════════════════════════════════════════════════════════════════════

const path = require('path');

const ROOT = '..';   // workbench/ 根

module.exports = {
  electronVersion: '43.4.0',   // 【2026-11-17】把 node_modules/electron 移出打包后必须显式指定
  appId: 'com.dsh.workbench',
  productName: 'DSH 工作台',
  copyright: 'Copyright © 2026',

  // ── 输出目录 ──
  directories: {
    output: path.join(ROOT, '..', 'dist2'),
    buildResources: 'build',
  },

  // ── 哪些文件打进 asar ──
  //
  //  🔴 2026-11-13 修一个致命漏配：原来只写了 main.js / preload.js / ui/
  //     结果 main.js 里 4 个 require 的本地文件**一个都没打进去**：
  //       ./fault-handlers.cjs   ← main.js:217
  //       ./tui-bridge.cjs       ← main.js:5403
  //       ./scripts/sidebar.js   ← main.js:6513
  //       ./crash.js             ← main.js:6522
  //
  //     症状（用户实测截图）：
  //       Error: Cannot find module './fault-handlers.cjs'
  //       Require stack: ...resources\app.asar\main.js
  //       随后 0x00007FF7B41F642B 指令引用了 0x0000000000000008 内存（崩溃）
  //
  //     这是「白名单式 files」的经典坑：**列白名单就必须列全**，
  //     而 main.js 的 require 依赖没有被自动包含（electron-builder
  //     默认会包含整个目录，是我用白名单把它切掉了）。
  //
  //     修法：把 main.js 的同级 .js/.cjs 和 scripts/ 全部包含进来。
  //           并加了一条自检（见文件末尾的 assertEntryFilesPacked）。
  files: [
    'main.js',
    'preload.js',
    // ⚠ 必须包含 main.js / preload.js 的所有本地 require
    '*.cjs',
    '*.js',
    'scripts/**/*',
    'ui/**/*',
    // 【2026-11-17 加】场景定义（panel 布局/hub 分派面板）必须进包
    'scenarios/**/*',
    'fault-handlers.cjs',
    'tui-bridge.cjs',
    'crash.js',
    'package.json',
    // 排除不需要的
    '!**/node_modules/*/{CHANGELOG.md,README.md,readme.md,LICENSE,license}',
    '!**/*.{md,map}',
    '!**/.git*',
    // ⚠ 排掉自身配置和构建脚本（不需要进包）
    '!electron-builder.config.js',
    '!build/**/*',
    // 【2026-11-17 修·根因】我的构建把开发依赖打进了 asar → 727MB → 启动崩溃。
    // node_modules/electron 本身 215MB，electron-builder 全套 500MB+，全是构建工具，运行时不需要。
    // 只保留 4 个生产依赖（xterm / @xterm/addon-fit / electron-updater / node-pty）。
    '!node_modules/electron/**',
    '!node_modules/electron-builder/**',
    '!node_modules/electron-builder-*/**',
    '!node_modules/app-builder-lib/**',
    '!node_modules/builder-util/**',
    '!node_modules/builder-util-runtime/**',
    '!node_modules/@electron/**',
    '!node_modules/@electron-internal/**',
    '!node_modules/@malept/**',
    '!node_modules/@isaacs/**',
    '!node_modules/@types/**',
    '!node_modules/typescript/**',
    '!node_modules/.bin/**',
    '!node_modules/*.map',
  ],

  // ── 额外资源（在 asar 外面，运行时用 process.resourcesPath 找）──
  //
  //   ⚠ 关键：这里只放「程序」和「初始模板」，
  //     不放运行时数据，也不放用户的场景记忆。
  extraResources: [
    // ⚠ 2026-11-13 修：引擎的 node_modules 没被打包进去
    //
    //   实测打包后：
    //     引擎/package.json  ✓
    //     引擎/node.exe      ✓
    //     引擎/node_modules  ✗  ← 缺！
    //
    //   后果：CLI_BUILT = 引擎/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js
    //        找不到 → 引擎启动失败 → 界面显示「会话列表暂不可用」
    //
    //   原因：electron-builder 对 extraResources 里的 `**/*` 会**默认排除
    //        node_modules**（它认为 node_modules 由它自己管）。
    //        必须用 `dot: true` + 显式包含 node_modules 才生效。
    //
    //   代价：引擎的 node_modules 很大（几百 MB），包体积会明显增加。
    //        但引擎没有它就是个空壳，这是必需的。
    {
      from: '../引擎',
      to: '引擎',
      filter: [
        '**/*',
        // 显式包含 node_modules（默认会被排除）
        'node_modules/**/*',
        '!**/node_modules/.cache/**',
        '!**/node_modules/**/*.md',
        '!**/node_modules/**/*.map',
        '!**/node_modules/**/test/**',
        '!**/node_modules/**/tests/**',
      ],
    },
    { from: '../工具', to: '工具', filter: ['**/*.mjs'] },
    // 数据只带「模板骨架」，不带 sessions/storages/electron-profile
    {
      from: '../数据',
      to: '数据模板',
      filter: [
        '**/*',
        '!**/sessions/**',
        '!**/storages/**',
        '!**/.dsh-temp/**',
        '!**/缓存/**',
      ],
    },
  ],

  // ── Windows ──
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    // 没有图标就不指定，electron-builder 会用默认 Electron 图标
    // 有图标后改成：icon: 'build/icon.ico'
    artifactName: '${productName}-${version}-${arch}.${ext}',

    // ⚠ 2026-11-13 加：关掉签名与 rcedit（网络受限时的必需项）
    //
    //   实测：打包时反复报错
    //     ⨯ connect ETIMEDOUT 20.205.243.166:443
    //     ⨯ read ECONNRESET
    //
    //   原因：electron-builder 要下载 `winCodeSign`（约 5 MB）
    //        来执行 rcedit（改写 exe 的图标/版本信息）和签名。
    //        而这个环境的网络到 GitHub 不稳定，下载反复超时。
    //
    //   影响：
    //     · exe 的图标会是 Electron 默认图标（不是自定义的）
    //     · exe 的「属性 → 详细信息」里产品名/版本号是 Electron 的
    //     · 不签名（本来也没有证书，所以无实际损失）
    //
    //   收益：打包不再依赖网络，可离线完成。
    //   如果将来网络恢复，把这两行删掉就能恢复完整功能。
    signAndEditExecutable: false,
    signtoolOptions: null,
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DSH 工作台',
    // ⚠ 不删用户数据 —— 卸载时保留场景记忆
    deleteAppDataOnUninstall: false,
  },

  portable: {
    artifactName: '${productName}-${version}-portable.${ext}',
  },

  // ── 不让 electron-builder 去重新下载 electron，用本地的 ──
  electronVersion: '43.4.0',

  // ── 打包后钩子：生成启动器（见 build/after-pack.js）──
  afterPack: "./build/after-pack.js",

  // ── asar 打包（代码，不含资源）──
  asar: true,
  asarUnpack: [],

  // ══════════════════════════════════════════════════════════════════
  //  关掉 npmRebuild（2026-11-13 加 —— 绕开一个真实的环境阻塞）
  // ══════════════════════════════════════════════════════════════════
  //  实测报错：
  //    node-gyp failed to rebuild 'node-pty'
  //    Error: Could not find any Visual Studio installation to use
  //    ⨯ Attempting to build a module with a space in the path
  //
  //  两个叠加的原因：
  //    ① 本机没装 Visual Studio 生成工具（C++ 编译器）
  //    ② 项目路径含空格（`AI Temp`）—— node-gyp 的已知问题
  //
  //  但**不需要重新编译**：node-pty 自带预编译二进制：
  //    node_modules/node-pty/prebuilds/win32-x64/pty.node      296 KB
  //    node_modules/node-pty/prebuilds/win32-x64/conpty.node   305 KB
  //  且实测 `require('node-pty')` 在当前 Electron 里能正常加载。
  //
  //  所以正确做法是跳过 rebuild，直接用现成的二进制 ——
  //  重新编译只会因为环境缺失而失败，收益为零。
  //
  //  ⚠ 代价与风险：如果将来 Electron 大版本升级导致 ABI 变化，
  //     预编译二进制会不兼容。那时必须装 VS 生成工具重新编译，
  //     或者把项目迁到无空格路径。这个风险写在这里，不隐瞒。
  npmRebuild: false,

  // ── 压缩 ──
  compression: 'normal',
};

// ══════════════════════════════════════════════════════════════════════
//  构建前自检：main.js 的本地 require 是否都会被包含
// ══════════════════════════════════════════════════════════════════════
//
//  为什么需要（真实事故驱动，2026-11-13）
//  ──────────────────────────────────────────────────────────────────
//  上一次打包，`files` 白名单只写了 main.js / preload.js / ui/，
//  于是 main.js 里 4 个 `require('./xxx')` 的文件**一个都没打进去**。
//  打出来的 exe 双击就崩：
//
//    Error: Cannot find module './fault-handlers.cjs'
//    Require stack: ...resources\app.asar\main.js
//    0x00007FF7B41F642B 指令引用了 0x0000000000000008 内存。该内存不能为 read。
//
//  而我在**交付前没有自己跑一遍**，直接让用户去双击验证 ——
//  这是流程上的错误，不只是配置错误。
//
//  这个自检：打包时先把所有本地 require 找出来，对照 files 白名单，
//  有漏的**直接报错**。这样同样的坑不可能出现第二次。
// ══════════════════════════════════════════════════════════════════════
(function preflight() {
  const fsP = require('fs');
  const pathP = require('path');

  function localRequires(file) {
    const out = new Set();
    try {
      const c = fsP.readFileSync(file, 'utf8');
      const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(c)) !== null) {
        if (/\.(c?js)$/.test(m[1])) out.add(m[1].replace(/^\.\//, ''));
      }
    } catch { /* ignore */ }
    return out;
  }

  const patterns = module.exports.files.filter((p) => !String(p).startsWith('!'));
  const required = new Set();
  for (const entry of ['main.js', 'preload.js']) {
    for (const r of localRequires(pathP.join(__dirname, entry))) required.add(r);
  }

  const covered = (rel) => patterns.some((pat) => {
    const p = String(pat);
    if (p === rel) return true;
    if (p.endsWith('/**/*')) return rel.startsWith(p.slice(0, -4));
    if (p.startsWith('*.')) return rel.endsWith(p.slice(1));
    return false;
  });

  const missing = [...required].filter((r) => !covered(r) && fsP.existsSync(pathP.join(__dirname, r)));

  if (missing.length) {
    console.error('[preflight] ✗ 打包会漏掉 ' + missing.length + ' 个本地依赖：');
    for (const m of missing) console.error('            - ' + m);
    console.error('          这会导致 exe 启动即崩溃（Cannot find module）。');
    console.error('          修法：在 electron-builder.config.js 的 files 里补上。');
    process.exitCode = 1;
    throw new Error('preflight failed: missing local requires');
  }
  console.log('[preflight] ✓ main.js/preload.js 的 ' + required.size + ' 个本地依赖都会被包含');
})();
