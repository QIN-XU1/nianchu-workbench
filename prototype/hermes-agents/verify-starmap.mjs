#!/usr/bin/env node
/**
 * 星图接入的端到端验证：数据层 + 传输层 + 界面层，三层都要有证据。
 *
 * 为什么不能只看一层：
 *   数据层绿（Python 函数返回 12 个节点）不代表前端收到了；
 *   前端收到了不代表画出来了。所以要三段都验。
 *
 * 用法：node verify-starmap.mjs
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';
const PY = 'C:/hermes/.venv/Scripts/python.exe';
// 端口可用环境变量覆盖：既方便换环境，也是**证明 UNKNOWN 分支真的会触发**的手段
// （指一个死端口就能验证「判不了」这条路，不必真的把桌面端关掉）。
const CDP = process.env.VERIFY_STARMAP_CDP || 'http://127.0.0.1:9333';

// 截图分两处落，因为「验收」和「取证」是两件事：
//
//   SCRATCH（默认）→ research/ui-survey/scratch/，已 gitignore。
//     为什么：星图是 canvas 动画，两次截图像素不同（实测 186822 → 187296 字节）。
//     如果验收直接写进已跟踪的路径，**每跑一次验收就把仓库搞脏**，R8 的
//     「未提交 0 项」就永远是红的 —— 而这不是产品问题，是取证方式的问题。
//     这正好撞上 .gitignore 开头那条判据：「删掉它能不能 5 分钟内从源头恢复？
//     能 → 不进 git」。星图一条命令就能重生成，按规矩不该被每次改写。
//
//   EVIDENCE（--save）→ research/screenshots/hermes-星图.png，已跟踪。
//     界面证据必须在仓里能直接看到，所以留一条**显式**取证路径：
//     界面真的变了才 --save 一次并提交，而不是每次验收都改。
const SCRATCH_DIR = REPO + '/research/ui-survey/scratch';
const SCRATCH = SCRATCH_DIR + '/starmap.png';
const EVIDENCE = REPO + '/research/screenshots/hermes-星图.png';
const SAVE = process.argv.includes('--save');
const OUT = SAVE ? EVIDENCE : SCRATCH;

let pass = 0, fail = 0;
const ok = (name, detail) => { pass++; console.log('    ✓ ' + name + (detail ? '  ' + detail : '')); };
const no = (name, detail) => { fail++; console.log('    ✗ ' + name + (detail ? '  ' + detail : '')); };

// ── 第一层：数据层（Python 直接算）──
console.log('  ── ① 数据层：build_neuron_layer() ──');
let layer = null;
try {
  const raw = execFileSync(PY, ['-c', `
import json, sys
sys.path.insert(0, r'C:\\hermes')
from agent.neuron_graph import build_neuron_layer
L = build_neuron_layer()
# 中文名计数在 Python 侧算完只回一个数字：
# 走 stdout 回传中文会被 PowerShell 的代码页 mangled（实测 12 个变 0 个），
# 那是测具的编码问题，不是数据问题。测具不该有这种假失败。
cjk = sum(1 for n in L["nodes"] if any('\\u4e00' <= ch <= '\\u9fa5' for ch in n["label"]))
print(json.dumps({
  "nodes": len(L["nodes"]),
  "edges": len(L["edges"]),
  "domains": len(L["clusters"]),
  "cjkNames": cjk,
  "hubs": L["stats"].get("neuron_hubs", [])[:1],
  "dispatchTotal": L["stats"].get("neuron_dispatch_total"),
  "never": len(L["stats"].get("neuron_never_dispatched") or []),
  "allPrefixed": all(str(n["id"]).startswith("scene:") for n in L["nodes"]),
}))
`], { env: { ...process.env, HERMES_HOME: 'C:/Users/15282/AppData/Local/hermes', PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8' });
  layer = JSON.parse(raw.trim().split('\n').pop());
} catch (e) {
  no('调用 build_neuron_layer 失败', String(e.message).slice(0, 160));
}

if (layer) {
  layer.nodes === 12 ? ok('12 个场景节点') : no('节点数应为 12', '实为 ' + layer.nodes);
  layer.edges === 29 ? ok('29 条无向边（31 条有向边 − 2 处环合并）') : no('边数应为 29', '实为 ' + layer.edges);
  layer.domains === 6 ? ok('6 个领域簇') : no('领域数应为 6', '实为 ' + layer.domains);
  layer.allPrefixed ? ok('所有节点 id 加了 scene: 前缀（避开与 hermes 技能重名）') : no('存在未加前缀的节点 id');
  layer.hubs[0]?.id === 'scene:build-plan' ? ok('枢纽识别正确', layer.hubs[0].id + ' 度=' + layer.hubs[0].degree) : no('枢纽异常', JSON.stringify(layer.hubs[0]));
  layer.dispatchTotal === 76 ? ok('派单台账 76 条真实使用记录') : no('派单数应为 76', '实为 ' + layer.dispatchTotal);
  layer.never === 7 ? ok('7 个场景从未被派单（如实统计，不隐藏）') : no('未派单数应为 7', '实为 ' + layer.never);
  const cjk = layer.cjkNames;
  cjk === 12 ? ok('12 个中文场景名') : no('中文名应为 12', '实为 ' + cjk);
}

// ── 第二层 + 第三层：界面层（CDP 读 DOM + 截图）──
console.log('  ── ② 界面层：/starmap 实际渲染 ──');

// 前置条件：桌面端在不在。
// 这里必须和「断言不通过」分开记 —— 桌面端没起时旧版记的是 FAIL「没有 canvas」，
// 报的是「星图坏了」，真相是「没人能看」。上一轮我被这条假红骗了整整一轮。
let cdpUp = false;
try {
  const r = await fetch(CDP + '/json/list', { signal: AbortSignal.timeout(3000) });
  cdpUp = r.ok;
} catch {
  cdpUp = false;
}
let unknown = 0;
if (!cdpUp) {
  unknown++;
  console.log('  ❔ 界面层无法验证：桌面端未启动（CDP ' + CDP + ' 不通）');
  console.log('     这不是「星图没渲染」，是「判不了」。起桌面端后重跑，不许把这条当绿。');
}

let uiOk = false;
if (cdpUp) {
  try {
  const list = await (await fetch(CDP + '/json/list')).json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('没有 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq; pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await send('Page.enable');
  await send('Runtime.enable');

  const base = 'file:///C:/hermes/apps/desktop/dist/index.html';
  // 只改 hash，不要 Page.navigate 到 file:// URL —— 整页导航会让应用解析失败（-6），
  // 渲染层再也起不来，后面的断言全部误报「没有 canvas」。这个 bug 曾经让 R8 红过：
  // 应用停在会话路由时，整页导航把页面搞坏，验收器却报「星图没渲染」。
  await send('Runtime.evaluate', {
    expression: `(() => {
      if (!location.href.startsWith('file://')) return 'not-file';
      location.hash = '#/starmap';
      return location.hash;
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 16000));

  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.body ? document.body.innerText : '';
      const m = t.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
      return {
        canvas: document.querySelectorAll('canvas').length,
        counter: m ? m[0] : null,
        shown: m ? Number(m[1]) : 0,
        total: m ? Number(m[2]) : 0,
        legend: /core = oldest/.test(t),
        url: location.hash,
      };
    })()`,
    returnByValue: true,
  });
  const info = probe.result?.value || {};
  info.url === '#/starmap' ? ok('路由到 /starmap') : no('路由未生效', String(info.url));
  info.canvas >= 1 ? ok('星图 canvas 已挂载', info.canvas + ' 个') : no('没有 canvas');
  info.legend ? ok('图例「core = oldest · outer = newer」在位') : no('图例缺失');
  if (info.total === 12) { ok('画布上是 12 个节点', info.counter); uiOk = true; }
  else no('节点计数应为 12', String(info.counter));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  ok('截图已存' + (SAVE ? '（证据，需提交）' : '（临时，不入仓）'),
    OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
  ws.close();
  } catch (e) {
    // 走到这里的异常有两种，必须分开：
    //   网络类（fetch failed / ECONNREFUSED / socket hang up）→ 环境问题 → UNKNOWN
    //   其它（断言过程抛错）→ 真的是问题 → FAIL
    const msg = String(e.message).slice(0, 160);
    if (/fetch failed|ECONNREFUSED|socket hang up|network|timed? ?out|aborted/i.test(msg)) {
      unknown++;
      console.log('  ❔ 界面层无法验证（连接异常）：' + msg);
    } else {
      no('CDP 验证失败', msg);
    }
  }
}

console.log('');
console.log('  ──────────────────────────────────────────────');
console.log('    断言：通过 ' + pass + '  失败 ' + fail +
  (unknown ? '  无法判断 ' + unknown : '') +
  (unknown ? '  （界面层判不了）' : uiOk ? '' : '  （界面层未通过）'));
console.log('  ──────────────────────────────────────────────');
// 退出码三态：1 = 断言失败；2 = 判断不了；0 = 全通过
process.exit(fail ? 1 : unknown ? 2 : 0);
