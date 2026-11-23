/**
 * 产出物校验器 —— 堵住「模型撒谎说做完了但什么都没产出 → 循环仍 PASS」的洞。
 *
 * 背景（第 64 轮发现）：runWithTools / runTeam 的 state=PASS 只表示「循环正常结束」，
 * 不代表「任务真的完成」。模型可以只用文字声称完成而不调任何工具。
 * 上层若把 PASS 当「做成」，就是假绿。
 *
 * 用法（**可选**，默认不启用，避免破坏既有行为）：
 *   runWithTools({ task, expectArtifacts: [{ path: 'out.txt', contains: 'team-ok-777' }] })
 *   跑完后若声明的产出物不存在/内容不符 → 把 state 从 PASS 降为 FAIL，并给出 detail。
 *
 * 支持字段：
 *   path      必填，相对 cwd 或绝对路径
 *   contains  可选，文件内容必须包含该子串
 *   minBytes  可选，文件至少这么大（防「建了个空文件也算」）
 *
 * 设计原则：**只做「有没有/对不对」的事实校验**，不猜测语义；
 *   任一产出缺失 → FAIL（不是 WARN），因为这是「声称完成但没做」的硬伤。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {Array<{path:string, contains?:string, minBytes?:number}>} list
 * @param {string} cwd
 * @returns {{ok:boolean, results:Array<{path:string,ok:boolean,reason?:string}>}}
 */
export function checkArtifacts(list, cwd = process.cwd()) {
  if (!Array.isArray(list) || list.length === 0) return { ok: true, results: [] };
  const results = [];
  for (const spec of list) {
    const rel = String(spec && spec.path || '').trim();
    if (!rel) { results.push({ path: '(空)', ok: false, reason: '未声明 path' }); continue; }
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (!st || !st.isFile()) { results.push({ path: rel, ok: false, reason: '产出物不存在' }); continue; }
    if (typeof spec.minBytes === 'number' && st.size < spec.minBytes) {
      results.push({ path: rel, ok: false, reason: `文件过小（${st.size} < ${spec.minBytes}B）` });
      continue;
    }
    if (typeof spec.contains === 'string' && spec.contains.length > 0) {
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { text = ''; }
      if (!text.includes(spec.contains)) {
        results.push({ path: rel, ok: false, reason: `内容不含「${spec.contains}」` });
        continue;
      }
    }
    results.push({ path: rel, ok: true });
  }
  return { ok: results.every((r) => r.ok), results };
}

/** 把产出物校验结果并入一次运行结果：缺失则把 PASS 降 FAIL */
export function applyArtifactCheck(runResult, list, cwd) {
  const chk = checkArtifacts(list, cwd);
  if (chk.ok) return { ...runResult, artifacts: chk };
  const missing = chk.results.filter((r) => !r.ok);
  return {
    ...runResult,
    // 只要声明了产出却没产出 → 不得为 PASS（这是「声称完成但没做」）
    state: runResult.state === 'PASS' ? 'FAIL' : runResult.state,
    artifactCheck: chk,
    artifacts: chk,
    reason: (runResult.reason ? runResult.reason + '；' : '') +
      '产出物校验失败：' + missing.map((m) => m.path + '(' + m.reason + ')').join('；'),
  };
}