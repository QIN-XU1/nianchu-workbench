import fs from 'node:fs';
import path from 'node:path';

console.log('═══════════════════════════════════════════════════════════════');
console.log('  对比诊断：原项目 vs 我的实现');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const CHECKS = [
  {
    name: '① 场景 json 支持 cols 字段',
    original: '有（默认4列，可配任意列数实现任意比例）',
    check() {
      const p = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\scenarios`;
      let hasCols = false;
      for (const f of fs.readdirSync(p).filter(x => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(p, f), 'utf8'));
        if (j.cols) hasCols = true;
      }
      // 我的 index.js 是否读 cols
      const idx = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\ui\index.js`;
      const t = fs.readFileSync(idx, 'utf8');
      return { pass: t.includes('cols'), detail: 'index.js 读 cols: ' + t.includes('cols') };
    },
  },
  {
    name: '② 面板 col/row/w/h 精确摆放',
    original: '有（grid-column: col / span w）',
    check() {
      const idx = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\ui\index.js`;
      const t = fs.readFileSync(idx, 'utf8');
      const useCol = t.includes('gridColumn') || t.includes('grid-column');
      const useColRow = t.includes('p.col') && t.includes('p.row');
      return { pass: useColRow, detail: '用了 col/row: ' + useColRow + ', gridColumn: ' + useCol };
    },
  },
  {
    name: '③ 面板 ▲ 展开到最高',
    original: '有（AI面板默认，其它写 expand:true）',
    check() {
      const dir = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\ui`;
      let found = false;
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f);
          if (fs.statSync(full).isDirectory()) { walk(full); continue; }
          if (!f.endsWith('.js')) continue;
          const t = fs.readFileSync(full, 'utf8');
          if (t.includes('expand') || t.includes('展开到最高')) found = true;
        }
      };
      walk(dir);
      return { pass: found, detail: '找到 expand 实现: ' + found };
    },
  },
  {
    name: '④ 面板序号徽标 01/02',
    original: '有（宿主自动装配）',
    check() {
      const dir = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\ui`;
      let found = false;
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f);
          if (fs.statSync(full).isDirectory()) { walk(full); continue; }
          if (!f.endsWith('.js')) continue;
          const t = fs.readFileSync(full, 'utf8');
          if (/padStart\(2/.test(t) && /index/.test(t)) found = true;
        }
      };
      walk(dir);
      return { pass: found, detail: '找到序号实现: ' + found };
    },
  },
  {
    name: '⑤ 面板注入 scenario 字段（数据分区）',
    original: '有（meta.scenario，存储键加前缀）',
    check() {
      const idx = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\ui\index.js`;
      const t = fs.readFileSync(idx, 'utf8');
      return { pass: t.includes('scenario'), detail: 'index.js 注入 scenario: ' + t.includes('scenario') };
    },
  },
  {
    name: '⑥ 自动排版（不写坐标时补洞）',
    original: '有（渲染完自动补洞拉伸填满）',
    check() {
      const idx = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\ui\index.js`;
      const t = fs.readFileSync(idx, 'utf8');
      const hasAuto = t.includes('autoFlow') || t.includes('自动排版');
      return { pass: hasAuto, detail: '自动排版: ' + hasAuto };
    },
  },
  {
    name: '⑦ 面板自刷新通道（不重启生效）',
    original: '有（指令文件 + 500ms 轮询）',
    check() {
      const main = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\main.js`;
      const t = fs.readFileSync(main, 'utf8');
      const has = t.includes('刷新面板') || t.includes('refresh-panel') || t.includes('panel-reload');
      return { pass: has, detail: '主进程有自刷新通道: ' + has };
    },
  },
  {
    name: '⑧ 面板类型数量',
    original: '24 种（7 族）',
    check() {
      const idx = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\ui\index.js`;
      const t = fs.readFileSync(idx, 'utf8');
      const m = t.match(/RENDERERS\s*=\s*\[([\s\S]*?)\]/);
      const count = m ? (m[1].match(/type:/g) || []).length : 0;
      return { pass: count >= 10, detail: '注册 ' + count + ' 种' };
    },
  },
];

let passCount = 0;
for (const c of CHECKS) {
  let r;
  try { r = c.check(); } catch (e) { r = { pass: false, detail: '异常: ' + e.message }; }
  if (r.pass) passCount++;
  console.log((r.pass ? '  ✓ ' : '  ✗ ') + c.name);
  console.log('      原项目: ' + c.original);
  console.log('      我的:   ' + r.detail);
  console.log();
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  通过 ' + passCount + ' / ' + CHECKS.length);
console.log('═══════════════════════════════════════════════════════════════');
