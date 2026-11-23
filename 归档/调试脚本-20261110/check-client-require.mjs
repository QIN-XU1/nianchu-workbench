#!/usr/bin/env node
/**
 * 查 client 的 require 能拿到什么
 *
 * 关键问题：插件 client.js 里 require('react') 能拿到 React。
 * 那能不能 require 到 primitives 的图标？
 *
 * 规范明确说：不可以 import Harness Client package
 * 验证方式：看 published plugin 的 client.cjs 里 require 了什么
 */

import fs from 'node:fs';
import path from 'node:path';

const PLUGIN = 'C:/Users/15282/.dsh/profiles/desktop/node_modules/@wxg-prc-cpg/browser-skill-dsh-plugin/lib/client.cjs';
const src = fs.readFileSync(PLUGIN, 'utf8');

console.log('browser-skill client.cjs: ' + src.length + ' B');
console.log();

// require 用法
const reqs = [...new Set([...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))];
console.log('require 的模块: ' + (reqs.length ? reqs.join(', ') : '(无)'));
console.log();

// 是否用 __ModuleLoader__
console.log('用 __ModuleLoader__: ' + src.includes('__ModuleLoader__'));
console.log();

// 开头的 module table
const headIdx = src.indexOf('require');
console.log('前 600 字符:');
console.log(src.slice(0, 600));
console.log();

// 找 factory 签名
const m = src.match(/factory\s*[:(]/);
if (m) {
  const start = Math.max(0, m.index - 300);
  console.log('factory 附近:');
  console.log(src.slice(start, m.index + 500));
}
