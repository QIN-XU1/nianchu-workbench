import fs from 'node:fs';
import path from 'node:path';

const SC = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\scenarios`;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  诊断 1：场景的 AI 面板是否独立（用户核心批评）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// 收集所有 harness 面板
const rows = [];
for (const f of fs.readdirSync(SC).filter(x => x.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8'));
  const harnesses = (j.panels || []).filter(p => p.type === 'harness');
  for (const h of harnesses) {
    rows.push({
      scene: j.id,
      sceneName: j.name,
      panelId: h.id,
      title: h.title,
      sid: h.sessionId || h.session || '(无)',
      sessionTitle: h.sessionTitle || '(无)',
      pinTarget: JSON.stringify(h.pinTarget || []),
    });
  }
}

console.log('所有 harness 面板（' + rows.length + ' 个）:');
console.log();
console.log('  ' + '场景'.padEnd(20) + '面板标题'.padEnd(16) + 'sessionId');
console.log('  ' + '─'.repeat(78));
for (const r of rows) {
  console.log('  ' + (r.scene + '(' + r.sceneName + ')').padEnd(20) + 
              r.title.padEnd(16) + r.sid.slice(0, 42));
}

console.log();
console.log('═══════════════════════════════════════════════════════════════');
console.log('  诊断 2：sessionId 是否唯一（共用一个 agent 的证据）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const sidMap = {};
for (const r of rows) {
  if (!sidMap[r.sid]) sidMap[r.sid] = [];
  sidMap[r.sid].push(r.scene);
}

const unique = Object.keys(sidMap).length;
console.log('  面板总数: ' + rows.length);
console.log('  唯一 sessionId: ' + unique);
console.log();
for (const sid of Object.keys(sidMap)) {
  const scenes = sidMap[sid];
  const isShared = scenes.length > 1;
  console.log('  ' + (isShared ? '⚠ 共用' : '✓ 独立') + '  ' + sid.slice(0, 42) + '  ← ' + scenes.join(', '));
}

console.log();
if (unique === rows.length) {
  console.log('  结论：每个场景确实有独立 session，但用户感知不同——');
  console.log('        可能是因为所有面板标题都是「AI·命令」这一族，视觉上像同一个。');
} else {
  console.log('  结论：存在共用，需要拆分。');
}

console.log();
console.log('═══════════════════════════════════════════════════════════════');
console.log('  诊断 3：场景私有记忆是否存在');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const MEMROOT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\引擎数据\.dsh\场景记忆`;
const ALT_MEMROOT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\..\引擎数据\场景记忆`;

for (const root of [MEMROOT, String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\场景记忆`]) {
  console.log('检查: ' + root);
  console.log('  存在: ' + fs.existsSync(root));
  if (fs.existsSync(root)) {
    const items = fs.readdirSync(root);
    console.log('  子项 (' + items.length + '):');
    for (const it of items.slice(0, 15)) {
      const full = path.join(root, it);
      const st = fs.statSync(full);
      console.log('    ' + (st.isDirectory() ? '📁 ' : '📄 ') + it);
    }
  }
  console.log();
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  诊断 4：主 Agent 面板布局冗余（用户批评）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();
console.log('  用户原话：');
console.log('  「主agent在上方有个对话窗口，下方也有一个，自选子agent在中间，');
console.log('   但下方又有一个可展开选择子agent的下拉框。」');
console.log();
console.log('  当前 main-agent.js 结构：');
console.log('  ┌─────────────────────────────┐');
console.log('  │ 头：主 Agent                │');
console.log('  ├─────────────────────────────┤');
console.log('  │ dsh-TUI 终端 (42%)          │  ← 上方对话窗口');
console.log('  ├─────────────────────────────┤');
console.log('  │ 子 Agent 列表 (34%)         │  ← 中间');
console.log('  ├─────────────────────────────┤');
console.log('  │ select 下拉框 ← 冗余!       │  ← 下方又选一次');
console.log('  │ textarea 输入框             │  ← 下方第二个对话入口');
console.log('  │ 派发按钮                    │');
console.log('  │ 日志                        │');
console.log('  └─────────────────────────────┘');
console.log();
console.log('  问题：select 和 子Agent列表 功能重复；textarea 和 TUI 功能重复。');
