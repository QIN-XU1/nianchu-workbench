/**
 * 生成 --openbitfun-* 令牌 CSS（我们的令牌层）
 *
 * 输入 design-system/packages/theme-openbitfun/src/{reference,light,dark}.tokens.json
 *      design-system/packages/design-tokens/src/{system,density-compact,density-touch}.tokens.json
 * 规则（照抄上游 theme-openbitfun/scripts/build.mjs）
 *      令牌路径 -> --openbitfun-<kebab>
 *      主题色按 [data-color-scheme=light|dark] 分组
 * 输出 apps/agent-ui/src/tokens/tokens.css
 *
 * 为什么自己写生成器：上游 build 依赖它自己的构建链（tsdown 等），我们只需要 CSS。
 * 为什么导出全部组：实测 @openbitfun/ui 的 CSS 会消费 577 个唯一变量、横跨 16 个组
 *   （color/type/space/control/motion/border/layout/focus/radius/overlay/shadow/
 *     component/opacity/layer/font/effect）。只导 color/space 这类，按钮会拿到空值
 *   —— 第一版就是这样把主按钮渲染成白字白底的。
 *   上游刻意不暴露参考色（ref.*），所以 ref.* 不导出。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DS = path.join(ROOT, 'design-system/packages');
const OUT = path.join(ROOT, 'apps/agent-ui/src/tokens/tokens.css');

const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.$value !== undefined) out[p] = v.$value;
      else if (v.value !== undefined) out[p] = v.value;
      else flat(v, p, out);
    } else out[p] = v;
  }
  return out;
}

const reference = flat(readJ(path.join(DS, 'theme-openbitfun/src/reference.tokens.json')));
const lightDoc = flat(readJ(path.join(DS, 'theme-openbitfun/src/light.tokens.json')));
const darkDoc = flat(readJ(path.join(DS, 'theme-openbitfun/src/dark.tokens.json')));
const system = flat(readJ(path.join(DS, 'design-tokens/src/system.tokens.json')));
const densityCompact = flat(readJ(path.join(DS, 'design-tokens/src/density-compact.tokens.json')));
const densityTouch = flat(readJ(path.join(DS, 'design-tokens/src/density-touch.tokens.json')));

function resolveAll(...maps) {
  const merged = Object.assign({}, ...maps);
  const out = {};
  // 关键修正：{ref} 不只出现在"整个值"，也嵌在 color-mix / calc 里面，
  // 例如 color-mix(in srgb, {color.accent.default} 9%, transparent)。
  // 第一版只处理整值匹配，导致花括号被原样写进 CSS —— 产物非法，块解析全乱。
  // 现在对所有出现的 {ref} 逐个替换，并递归解析。
  const resolve = (v, chain) => {
    if (typeof v !== 'string') return v;
    if (!v.includes('{')) return v;
    return v.replace(/\{([^}]+)\}/g, (whole, key) => {
      if (chain.includes(key) || chain.length > 12) return whole;
      const next = merged[key];
      if (next === undefined) return whole;
      return resolve(String(next), chain.concat(key));
    });
  };
  for (const [k, v] of Object.entries(merged)) out[k] = resolve(v, []);
  return out;
}

const light = resolveAll(reference, system, lightDoc);
const dark = resolveAll(reference, system, darkDoc);

const kebab = (p) => '--openbitfun-' + p
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase().replace(/\./g, '-').replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

// 全量导出：排除上游刻意不暴露的参考色（ref.*）与类型标记（$type / $value）
const pickable = (k) => !k.startsWith('ref.') && !k.includes('.$type') && !k.endsWith('$value');
const isColor = (k) => k.startsWith('color.');

function block(map, selector, keys, indent = '  ') {
  const lines = [];
  for (const k of keys) {
    const v = map[k];
    if (v === undefined || v === null || typeof v === 'object') continue;
    lines.push(indent + kebab(k) + ': ' + v + ';');
  }
  return selector + ' {\n' + lines.join('\n') + '\n}';
}

const allKeys = Object.keys(light).filter(pickable).sort();
const colorKeys = allKeys.filter(isColor);
const plainKeys = allKeys.filter((k) => !isColor(k));

const out = [];
out.push('/* 自动生成，请勿手改。生成器：tools/gen-tokens.mjs');
out.push(' * 来源：design-system/packages（vendor 自 OpenBitFun，MIT License, Copyright (c) 2026 CWing）');
out.push(' * 规则：令牌路径 -> --openbitfun-<kebab>；主题色按 data-color-scheme 分组。');
out.push(' */');
out.push('');
out.push('/* 与主题无关：版式 / 间距 / 半径 / 动效 / 层级 / 组件级令牌 */');
out.push(block(light, ':root, [data-vouch-root]', plainKeys));
out.push('');
out.push('/* 亮色语义色 */');
out.push(block(light, ':root, [data-vouch-root][data-color-scheme="light"]', colorKeys));
out.push('');
out.push('/* 暗色语义色 */');
out.push(block(dark, '[data-vouch-root][data-color-scheme="dark"]', colorKeys));
out.push('');

const densityKeys = (m) => Object.keys(m).filter((k) => pickable(k) && typeof m[k] !== 'object');
for (const [name, m, sel] of [
  ['compact', densityCompact, '[data-vouch-root][data-density="compact"]'],
  ['cozy', densityTouch, '[data-vouch-root][data-density="cozy"]'],
]) {
  const keys = densityKeys(m);
  if (!keys.length) continue;
  out.push('/* 密度 ' + name + '：只改间距类令牌，不改字号 */');
  out.push(block(m, sel, keys));
  out.push('');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n'), 'utf8');
const kb = Math.round(Buffer.byteLength(out.join('\n')) / 1024);
console.log('  ✓ 生成 apps/agent-ui/src/tokens/tokens.css  ' + kb + 'KB');
console.log('    变量 ' + allKeys.length + '（颜色 ' + colorKeys.length + '，非颜色 ' + plainKeys.length + '）');
const probe = [
  ['color.surface.canvas', 'dark'],
  ['color.surface.chrome', 'light'],
  ['color.accent.default', 'light'],
  ['component.button.primary.background', 'light'],
  ['component.button.primary.background', 'dark'],
  ['component.button.textContent', 'light'],
  ['control.composer.surface.radius', 'light'],
  ['layout.navigation.panel.inline.size', 'light'],
  ['type.label.md.fontSize', 'light'],
];
console.log('    抽查：');
for (const [k, mode] of probe) {
  const v = (mode === 'dark' ? dark : light)[k];
  console.log('      ' + kebab(k).padEnd(52) + (v === undefined ? '（缺）' : v));
}
