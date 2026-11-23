import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DS = path.resolve(here, '../../design-system/packages');
const NM = path.resolve(here, 'node_modules');

/**
 * 两件事决定了这份配置的样子：
 *
 * 1) 为什么直接 alias 到 @openbitfun/ui 的 src，而不是等它构建出 dist
 *    实测该包源码**不 import** 兄弟令牌包（0 处命中），只用自己的 CSS + --openbitfun-* 变量名。
 *    所以 Vite 直接编译它的 tsx / css module 就能用，省掉一整套 tsdown 构建链。
 *    一旦上游改了这层依赖（出现 import '@openbitfun/design-tokens'），就退回"先构建包"。
 *
 * 2) 为什么 react / lucide-react 也要显式 alias
 *    vendored 源码在 apps/agent-ui 之外，Node 的模块解析会从 design-system/ 往上找，
 *    永远找不到我们的 node_modules。所以对这几个"宿主提供"的包显式钉到我们的副本，
 *    否则 rollup 会报 "failed to resolve import lucide-react"。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // 宿主提供的运行时（必须钉死，见上面第 2 点）
      { find: /^react$/, replacement: path.join(NM, 'react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: path.join(NM, 'react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(NM, 'react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: path.join(NM, 'react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: path.join(NM, 'react-dom/client.js') },
      { find: /^lucide-react$/, replacement: path.join(NM, 'lucide-react/dist/cjs/lucide-react.js') },

      // 复用基线
      { find: /^@openbitfun\/ui$/, replacement: path.join(DS, 'ui/src/index.ts') },
      { find: /^@openbitfun\/ui\/flow-chat$/, replacement: path.join(DS, 'ui/src/flow-chat/index.ts') },
      { find: /^@openbitfun\/ui\/brand$/, replacement: path.join(DS, 'ui/src/brand/index.ts') },

      // 我们自己的别名
      { find: /^@vouch\//, replacement: path.resolve(here, 'src') + '/' },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 5273, strictPort: false },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
