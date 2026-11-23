import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ── 文档一：design-system/VENDOR.md ──
const vendor = `# design-system（vendor 自 OpenBitFun）

本目录**原样复制**自 OpenBitFun 的设计系统包，作为「四鉴 Vouch」的组件与令牌基线。
只读，不在此目录内改代码。

## 来源与许可

- 上游仓库：https://github.com/openBitFun/OpenBitFun （前身 GCWing/BitFun）
- 上游版本：v1.0.10（安装版 version.json 记录 gitCommit 760934b）
- 拉取方式：codeload tarball（refs/heads/main），完整仓库 88.4MB / 10527 文件
- 拉取日期：2026-11-14
- 许可：**MIT License, Copyright (c) 2026 CWing**（见本目录 LICENSE、packages/*/LICENSE）
  MIT 允许 use / copy / modify / merge / publish / sublicense / sell，
  只要求保留版权与许可声明。我们保留本文件与 LICENSE 即满足。

## 复制了哪些

    packages/design-tokens       令牌契约（system / density-compact / density-touch）
    packages/theme-openbitfun    明 / 暗 / 高对比主题值（reference / light / dark …）
    packages/ui                  48 个 React 组件 + flow-chat 零件库（372 ts/tsx、115 css module）

被 extends 的根配置也一并带上（否则 ui/tsconfig.json 解析失败）：

    tsconfig.base.json
    package.json  LICENSE  README.md  AGENTS.md

## 没有复制哪些

- 上游的 app/ 外壳与全部场景业务代码（src/web-ui）—— 我们的场景是自研的
- 上游的双语 i18n、产品文案
- 上游的 Tauri 后端

## 用法（已在 apps/agent-ui/vite.config.ts 里落地）

Vite **直接编译 ui 的 src**，不等它构建出 dist：

    alias  @openbitfun/ui        -> packages/ui/src/index.ts
    alias  @openbitfun/ui/flow-chat -> packages/ui/src/flow-chat/index.ts

成立的前提（已实测）：该包源码**不 import** 兄弟令牌包（0 处命中），只用 CSS + --openbitfun-* 变量名。
一旦上游改成 import '@openbitfun/design-tokens'，就必须先构建包再消费。

另外必须把宿主提供的包显式钉到我们自己的 node_modules，否则 vendored 源码在
design-system/ 下往上找永远找不到：

    react / react-dom / react/jsx-runtime / lucide-react

## 令牌怎么来

不是手抄，是生成：tools/gen-tokens.mjs 读上面的令牌 JSON，按上游
theme-openbitfun/scripts/build.mjs 的命名规则产出 apps/agent-ui/src/tokens/tokens.css。

规则：令牌路径 -> --openbitfun-<kebab>，主题色按 [data-color-scheme=light|dark] 分组。

一条踩过的坑：**必须导出全部令牌组**。第一版只导 color/space/radius/motion，
结果组件读 --openbitfun-component-button-primary-background 拿不到值，
主按钮渲染成白字白底。实测 ui 的 CSS 会消费 577 个唯一变量、横跨 16 个组
（color/type/space/control/motion/border/layout/focus/radius/overlay/shadow/
component/opacity/layer/font/effect）。现在导出 895 个。

上游刻意不暴露参考色（ref.*），生成器也跳过它们。

## 升级流程

1. 换上游版本：重新复制这几个包，更新本文件的版本与 commit
2. 跑 node tools/gen-tokens.mjs
3. 跑 pnpm --dir apps/agent-ui build
4. 跑 node prototype/agent-ui/verify-s0.mjs（含真渲染断言）
5. 全绿才提交
`;

// ── 文档二：research/依赖与镜像说明.md ──
const deps = `# 依赖与镜像说明（网络间歇性下怎么装得上）

本机实测网络是**间歇性**的，同一个域名前一次 200、后一次 000。
本文把「怎么装得上」固化成可复现步骤，避免每次重装靠运气。

## 实测可达性（2026-11-14）

    unpkg.com                      200
    registry.npmmirror.com (tgz)   200
    cdn.jsdelivr.net               000
    registry.npmjs.org             000
    raw.githubusercontent.com      000
    api.github.com                 200
    codeload.github.com            200

结论：**用 npmmirror 装 npm 包，用 codeload/api 取 GitHub 内容，不要用 jsdelivr / npmjs / raw。**

## 工具链（已确认）

    node v24.18.0
    npm 11.16.0
    pnpm 11.21.0
    yarn 1.22.22

本机还有 6.4 万文件的 npm 缓存与 pnpm store，所以重装通常是秒级。

## apps/agent-ui/.npmrc（已落盘）

    registry=https://registry.npmmirror.com
    fetch-retries=6
    fetch-retry-mintimeout=2000
    fetch-retry-maxtimeout=30000
    fetch-timeout=120000

## 标准安装命令

    pnpm --dir apps/agent-ui install --prefer-offline

## 两个 pnpm 11 的坑

1. **pnpm 字段不再从 package.json 读**
   pnpm 会提示：The "pnpm" field in package.json is no longer read。
   onlyBuiltDependencies 等设置已迁到 pnpm-workspace.yaml。

2. **esbuild 的 build script 被忽略会以 exit=1 结束安装**
   输出：ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild@0.25.0
   实测**无害**：esbuild 的平台二进制由 optionalDependencies 提供，
   vite build 能正常调用它（本项目实测构建成功）。
   所以不要把 install 的 exit=1 当成失败；以 build 是否成功为准。

## PowerShell 写文件的坑（本项目踩过两次）

- Out-File -Encoding utf8 在 Windows PowerShell 5.1 下会写 **BOM**，
  导致 pnpm 报 Invalid package.json。用 node 写文件，或 [System.IO.File]::WriteAllText。
- PowerShell 双引号里 **\\n 不会被解析成换行**（要用反引号 n），
  用它拼代码会把字面反斜杠-n 写进源码。改代码请用 write 工具或 node 脚本。
`;

fs.mkdirSync(path.join(ROOT, 'design-system'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'design-system/VENDOR.md'), vendor, 'utf8');
fs.mkdirSync(path.join(ROOT, 'research'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'research/依赖与镜像说明.md'), deps, 'utf8');
console.log('  ✓ design-system/VENDOR.md');
console.log('  ✓ research/依赖与镜像说明.md');
