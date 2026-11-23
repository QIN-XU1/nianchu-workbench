#!/usr/bin/env node
// 工具/破坏性验证.mjs —— 检查器在系统真坏时会不会失败
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（比自测更强的一层）
// ══════════════════════════════════════════════════════════════════════
//  自测验证的是「判据逻辑对不对」（用假数据）。
//  但那还不够 —— 实测发现过这些情况：
//
//    · 文件索引写入：默认模式会**自动修复**缺失文件，然后报成功
//      → 删掉索引文件，它不但不报错，还自己补回来 → 装饰
//
//    · 派单验证生成：输出「达标: 7 / 8」却不设 exitCode
//      → 机制体检看到 exit 0 → 判 PASS → 装饰
//
//    · 检查器可靠性体检：靠文件名判断「是不是检查器」
//      → 换个名字的装饰检查器直接跳过 → 审计失效
//
//    · 技能可见性体检：只测引擎 skills/list（有缓存）
//      → 磁盘上改坏了，引擎仍报 9/9 → 装饰
//
//    · 技能可见性体检：磁盘层抓到问题、也打印了警告，
//      但 `process.exit(problems.length ? 1 : 0)` 只看引擎层
//      → 输出有警告，exit code 仍是 0 → 装饰
//
//  共同点：**工具跑起来「看起来正常」，但系统真坏时它也不报错。**
//
//  所以需要这一层：人为破坏系统，看检查器是否失败。
//    能失败 = 真检查；仍然通过 = 装饰。
//
// ══════════════════════════════════════════════════════════════════════
//  用法
// ══════════════════════════════════════════════════════════════════════
//    node 工具/破坏性验证.mjs            # 跑全部破坏用例
//    node 工具/破坏性验证.mjs --selftest
//    node 工具/破坏性验证.mjs --only 技能可见性体检
// ══════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');
const DATA = path.join(WB, '数据', '.dsh');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

/**
 * 破坏用例表
 *
 * 每个用例：
 *   name   检查器名
 *   file   文件名
 *   args   跑它时的参数（要与机制体检一致）
 *   break  制造破坏，返回 restore 函数
 */
export const CASES = [
  {
    name: '技能可见性体检',
    file: '技能可见性体检.mjs',
    // 破坏：把技能目录改名（引擎立刻不可见；磁盘层也会报 name 不一致）
    //
    // ⚠ 2026-11-13 修（残留 bak 目录会导致永久损坏）
    //
    //   实测事故：上一轮跑完留下 research_bak，之后：
    //     · 本次 renameSync(dir, bak) —— dir 不存在（已被改走）→ 抛错或 return null
    //     · restore 的 renameSync(bak, dir) —— 若 dir 已恢复过就 EEXIST → 被 catch 吞掉
    //   结果：research 目录长期缺失、research_bak 长期残留，
    //        技能可见性体检 / 全工具自测 / 内容哨兵 一起红。
    //
    //   修法：break 前先清残留；restore 时用「先删目标再改名」，
    //        并且失败要**打印出来**而不是静默 catch。
    break() {
      const dir = path.join(DATA, 'skills', 'research');
      const bak = path.join(DATA, 'skills', 'research_bak');

      // ① 先清上次残留：如果 bak 存在而 dir 不存在，说明上次没恢复
      if (fs.existsSync(bak) && !fs.existsSync(dir)) {
        fs.renameSync(bak, dir);   // 先把上次的残留恢复回来
      } else if (fs.existsSync(bak) && fs.existsSync(dir)) {
        fs.rmSync(bak, { recursive: true, force: true });   // 两边都在 → bak 是垃圾
      }

      if (!fs.existsSync(dir)) return null;
      fs.renameSync(dir, bak);

      return () => {
        try {
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          fs.renameSync(bak, dir);
        } catch (e) {
          // ⚠ 不静默：restore 失败必须让人看见
          console.error('  ⛔ restore 失败（技能目录可能损坏）: ' + (e && e.message));
          console.error('     手动恢复：把 数据/.dsh/skills/research_bak 改名回 research');
        }
      };
    },
  },
  {
    name: '文件索引写入',
    file: '文件索引写入.mjs',
    args: ['--check'],
    // 破坏：删掉一个场景的索引（--check 模式应报缺失）
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '_文件索引.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p, 'utf8');
      fs.unlinkSync(p);
      return () => fs.writeFileSync(p, orig, 'utf8');
    },
  },
  {
    name: '管线产物体检',
    file: '管线产物体检.mjs',
    // 破坏：清空契约表的 files（下游就找不到产物）
    break() {
      const p = path.join(DATA, '产物契约.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(orig);
      for (const k of Object.keys(j.artifacts || {})) j.artifacts[k].files = [];
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig, 'utf8');
    },
  },
  {
    name: '派单验证生成',
    file: '派单验证生成.mjs',
    // 破坏：删掉一个被契约引用的产出文件
    break() {
      const p = path.join(DATA, '场景记忆', '竞品拆解', '项目功能矩阵.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p, 'utf8');
      fs.unlinkSync(p);
      return () => fs.writeFileSync(p, orig, 'utf8');
    },
  },
  {
    name: '工具去重体检',
    file: '工具去重体检.mjs',
    // 破坏：造一个写同一个文件的新工具
    break() {
      const p = path.join(TOOLS, 'zz_dup_probe.mjs');
      if (fs.existsSync(p)) return null;
      fs.writeFileSync(p,
        "import fs from 'node:fs';\n" +
        "import path from 'node:path';\n" +
        "const X = path.join('数据', '.dsh', '场景记忆', '_共享记忆', '健康度.json');\n" +
        "fs.writeFileSync(X, '{}');\n", 'utf8');
      return () => { try { fs.unlinkSync(p); } catch { /* */ } };
    },
  },
  {
    name: '检查器可靠性体检',
    file: '检查器可靠性体检.mjs',
    // 破坏：造一个恒 true 的装饰检查器
    break() {
      const p = path.join(TOOLS, 'zz_decorative_probe.mjs');
      if (fs.existsSync(p)) return null;
      fs.writeFileSync(p,
        '#!/usr/bin/env node\n' +
        "function chk(n, ok) { console.log(n); }\n" +
        'function main() {\n' +
        "  chk('永远通过', true);\n" +
        '}\n' +
        'main();\n', 'utf8');
      return () => { try { fs.unlinkSync(p); } catch { /* */ } };
    },
  },
  {
    name: '身份哨兵',
    file: '身份哨兵.mjs',
    // 破坏：把场景配置的 sessionId 改成「格式合法但不存在」的值，
    //       而索引表没跟着变 → INV-9「索引 vs 配置一致」应报出来
    //
    //   ⚠ 不能用含 0000-0000 的假 id —— PLACEHOLDER_RE 会把它当占位符放过。
    //     实测那会误判成「装饰」，其实是测试用错了数据。
    break() {
      const dir = path.join(WB, '外壳', 'scenarios');
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
        const p = path.join(dir, f);
        const orig = fs.readFileSync(p, 'utf8');
        let j;
        try { j = JSON.parse(orig); } catch { continue; }
        const ai = (j.panels || []).find((x) => x.type === 'harness');
        if (!ai || !ai.sessionId) continue;
        ai.sessionId = 'session-11111111-2222-3333-4444-555555555555';
        fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
        return () => fs.writeFileSync(p, orig, 'utf8');
      }
      return null;
    },
  },
  {
    name: '记忆哨兵',
    file: '记忆哨兵.mjs',
    // 破坏：往场景私有记忆末尾追加 31KB，超 25600 字节红线（INV-3）
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '场景私有记忆.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, orig + '\n\n## 超限测试\n' + 'X'.repeat(31000) + '\n', 'utf8');
      return () => fs.writeFileSync(p, orig, 'utf8');
    },
  },
  {
    name: '技能执行器',
    file: '技能执行器.mjs',
    // 破坏：删掉一个技能的 SKILL.md（可执行性应报不可执行）
    break() {
      const p = path.join(DATA, 'skills', 'research', 'SKILL.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p, 'utf8');
      fs.unlinkSync(p);
      return () => fs.writeFileSync(p, orig, 'utf8');
    },
  },
  {
    name: '经验真实性体检',
    file: '经验真实性体检.mjs',
    // 破坏：造 3 条完全自我安慰的经验（实体在后续一次都不出现）
    //
    // ⚠ 两个细节（都决定测试成败）：
    //   ① 必须用真实格式：`- 日期：**标题** — 症状：...`
    //      第一次我写的是纯文本块，extractExperiences 根本没认出来
    //      → 经验数没变 → 误判成「装饰」
    //   ② 必须注入 3 条，不是 1 条
    //      一条无证据稀释在 41 条里占比太低，判据抓不到
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '场景私有记忆.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p, 'utf8');
      const marker = '## 五、坑与决策';
      if (!orig.includes(marker)) return null;
      let fake = '';
      for (let i = 1; i <= 3; i++) {
        fake += '\n- 2026-11-12：**虚构经验' + i + '** — 症状：ZzFake' + i +
          'Module 报错。根因：ZzFake' + i + 'Cause 缺初始化。';
      }
      fs.writeFileSync(p, orig.replace(marker, marker + fake), 'utf8');
      return () => fs.writeFileSync(p, orig, 'utf8');
    },
  },

  // ════════════════════════════════════════════════════════════════
  //  记忆类（12 个）
  //
  //  ⚠ 记忆类用例的通用约定：
  //    ① 破坏前把原文读成 **Buffer**，restore 用 Buffer 原样写回
  //       —— 这 12 个文件里有 GBK 编码的历史产物（身份索引、问答库），
  //         用 utf8 字符串往返会悄悄改字节，数据看着在、其实已经不一样了。
  //    ② 只改「语义」，不改「格式」：故意用真数据格式写破坏内容，
  //       否则检查器解析不出来，会误判成「装饰」。
  // ════════════════════════════════════════════════════════════════
  {
    name: '记忆写入协议',
    file: '记忆写入.mjs',
    args: ['--check'],
    // 判据：§五 里每条经验必须带日期前缀 `- YYYY-MM-DD：`
    // 破坏：往「调研」的 §五 追加一条**没有日期**的经验
    //       （这是 AI 真实会犯的错：直接贴一句结论就写进去）
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '场景私有记忆.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);            // 字节级备份
      const md = orig.toString('utf8');
      const marker = '## 五、坑与决策';
      if (!md.includes(marker)) return null;
      fs.writeFileSync(p, md.replace(marker, marker +
        '\n\n- 这条经验故意没写日期前缀，记忆写入协议应当发现它。'), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '记忆评估',
    file: '记忆评估.mjs',
    args: ['--check'],
    // 判据：judgePass() 三条闸 —— recall / distractor / 成本。
    //       其中 distractor 是「记忆里有没有与事实相反的**断言**」
    //       （记忆评估.mjs 的「调研」封存集 distractor = 「没有产物」）
    // 破坏：在「调研」记忆里写一句相反的断言
    //       —— 必须写成「- 没有产物：…」这种子句起始形式，
    //          写在长句中间只会被判成「顺带提及」，不算断言。
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '场景私有记忆.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, orig.toString('utf8') +
        '\n- 没有产物：这个场景调研完什么都不产出。\n', 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '记忆注入',
    file: '记忆注入.mjs',
    args: ['--check'],
    // 判据：300 字检索式注入的 recall（单场景 >= 0.30 / 合计 >= 0.55）
    // 破坏：把「架构梳理」的场景记忆清空
    //       —— 检索再怎么好，记忆里没有东西也注入不出答案。
    //       （实测：该场景 38 道题 recall 掉到 0.05 以下，单场景闸先炸）
    break() {
      const p = path.join(DATA, '场景记忆', '架构梳理', '场景私有记忆.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, '# 架构梳理 · 场景私有记忆\n\n（清空：模拟记忆丢失）\n', 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '影子记忆',
    file: '影子记忆.mjs',
    args: ['--check'],
    // 判据：每个场景至少 1 个快照（0 个 = 这个机制从没跑过）
    // 破坏：把「调研」的快照目录改名
    //       —— 等价于「周期验证从没对这个场景执行过」
    //
    // ⚠ 另一个更诱人的破坏是「改快照里的 hash」，
    //    实测**不会 FAIL**：checkReal 用的是 listSnapshotsRescored()，
    //    它按 content 重算 hash 后再比对，所以 hash 自洽判据永远成立。
    //    这一点已在报告里单独说明，不拿它当用例。
    break() {
      const dir = path.join(DATA, '影子记忆', '调研');
      const bak = path.join(DATA, '影子记忆', '调研__break');
      if (!fs.existsSync(dir) || fs.existsSync(bak)) return null;
      fs.renameSync(dir, bak);
      return () => { try { fs.renameSync(bak, dir); } catch { /* */ } };
    },
  },
  {
    name: '记忆精简',
    file: '记忆精简.mjs',
    args: ['--check'],
    // 判据：`> 项目信息已剥离 → \`路径\`` 必须指向**真实存在**的文件
    // 破坏：把「调研」的剥离指针改成指向一个不存在的文件
    //       —— 等于记忆里留了个死链接，AI 按指针去查会查空
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '场景私有记忆.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const md = orig.toString('utf8');
      const good = '数据/.dsh/项目记忆/调研/项目信息.md';
      if (!md.includes(good)) return null;
      fs.writeFileSync(p, md.replace(good, '数据/.dsh/项目记忆/调研/__不存在的项目信息__.md'), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '场景画像',
    file: '场景画像.mjs',
    args: ['--check'],
    // 判据：每个场景必须有 场景画像.md，且内容必须与**当前配置**重新生成的一致
    // 破坏：把「调研」的画像文件改名藏起来
    //       —— 等价于「这个场景的画像从没生成过」，AI 不知道自己界面长什么样
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '场景画像.md');
      const bak = p + '.break';
      if (!fs.existsSync(p) || fs.existsSync(bak)) return null;
      fs.renameSync(p, bak);
      return () => { try { fs.renameSync(bak, p); } catch { /* */ } };
    },
  },
  {
    name: '身份签名',
    file: '身份.mjs',
    args: ['--check'],
    // 判据：签名里的「我是谁」必须真的来自身份卡 `## 我是谁` 段；
    //       卡里该段为空 → 报「没有「## 我是谁」段」
    // 破坏：清空「调研」身份卡的 `## 我是谁` 小节**正文**（保留标题）
    //       —— 模拟身份卡被改坏 / 正在重建
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '身份卡.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const lines = orig.toString('utf8').split('\n');
      const i = lines.findIndex((l) => /^##\s*我是谁/.test(l));
      if (i < 0) return null;
      let j = i + 1;
      while (j < lines.length && !/^##\s/.test(lines[j])) j++;
      const broken = [...lines.slice(0, i + 1), '', ...lines.slice(j)].join('\n');
      if (broken === orig.toString('utf8')) return null;
      fs.writeFileSync(p, broken, 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '关键资产',
    file: '关键资产.mjs',
    args: ['--audit'],
    // 判据：清单里列了、但磁盘上不存在的资产 → 缺失告警
    // 破坏：把 research 技能的 skill.json 改名
    //       —— 技能元数据丢了（清单里它是 valuable，可重建但不该「悄悄没了」）
    break() {
      const p = path.join(DATA, 'skills', 'research', 'skill.json');
      const bak = p + '.break';
      if (!fs.existsSync(p) || fs.existsSync(bak)) return null;
      fs.renameSync(p, bak);
      return () => { try { fs.renameSync(bak, p); } catch { /* */ } };
    },
  },
  {
    name: '场景互问',
    file: '互问.mjs',
    args: ['--check'],
    // 判据：status=answered 的问答，回答内容必须出现在**提问者**的场景记忆里
    //       （「学到」是这机制的全部意义，没写进去 = 白问）
    // 破坏：往问答库追加一条已答、但回答从没落进「调研」记忆的记录
    break() {
      const p = path.join(DATA, '场景互问', '问答.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      let j;
      try { j = JSON.parse(orig.toString('utf8')); } catch { return null; }
      if (!Array.isArray(j.items)) return null;
      j.items.push({
        id: 'q999',
        from: '调研',
        to: '架构梳理',
        about: '破坏性验证探针',
        at: '2026-11-12T00:00:00.000Z',
        status: 'answered',
        answer: 'ZzProbeAnswer：这条回答只存在于问答库，从来没写进提问者的记忆。',
        answeredAt: '2026-11-12T00:00:00.000Z',
      });
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '记忆召回哨兵',
    file: '记忆召回哨兵.mjs',
    // 无 args（机制体检里也是默认模式）
    // 判据：每个场景 recall_all >= 0.70（记忆里能不能找到封存集的关键事实）
    // 破坏：把「本地电脑」的场景记忆目录整个移走
    //       —— 记忆没了，recall 必然掉到 0
    //
    // ⚠ 不能只改「场景私有记忆.md」：这个哨兵 loadSceneMemory 读目录下**所有** .md，
    //    实测清空那一个文件，本地电脑 recall 仍是 1.00（事实散落在其他 4 个 md 里）。
    break() {
      const dir = path.join(DATA, '场景记忆', '本地电脑');
      const bak = path.join(DATA, '场景记忆', '_本地电脑__break');
      if (!fs.existsSync(dir) || fs.existsSync(bak)) return null;
      fs.renameSync(dir, bak);
      return () => { try { fs.renameSync(bak, dir); } catch { /* */ } };
    },
  },
  {
    name: '六件套',
    file: '六件套.mjs',
    // 无 args（机制体检里也是默认模式）
    // 判据：第 6 件「常驻会话 + 身份索引」要求索引里的 sessionId
    //       在 数据/.dsh/sessions 里**真实存在**（不是格式合法的字符串就行）
    // 破坏：把身份索引里 research 的 sessionId 改成格式合法但不存在的 id
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '身份索引.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      let j;
      try { j = JSON.parse(orig.toString('utf8')); } catch { return null; }
      const row = (j.rows || []).find((r) => r.scene === 'research');
      if (!row) return null;
      row.sessionId = 'session-11111111-2222-3333-4444-555555555555';
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '偏好记忆',
    file: '偏好记忆.mjs',
    args: ['--validate'],
    // 判据：id 必须匹配 p-<类别>-<三位数字> 且**不重复**
    // 破坏：把 p-tool-002 的 id 改成 p-tool-001（与已有条目撞号）
    //       —— 偏好条目一旦撞号，注入时就会互相覆盖
    break() {
      const p = path.join(DATA, '偏好记忆', '偏好.yaml');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const md = orig.toString('utf8');
      if (!md.includes('  - id: p-tool-002')) return null;
      fs.writeFileSync(p, md.replace('  - id: p-tool-002', '  - id: p-tool-001'), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },

  // ════════════════════════════════════════════════════════════════
  //  闸门 / 校验类（12 个）
  //
  //  ⚠ 通用约定（都是踩出来的）：
  //    ① 备份一律用 **Buffer**，restore 原样写回 ——
  //       本项目有 GBK 残留文件，utf8 字符串往返会悄悄改字节。
  //    ② 破坏内容必须用「真实数据格式」写，否则检查器解析不出来，
  //       会被误判成「装饰」—— 那是测试写错了，不是检查器坏了。
  //    ③ 闸门类（成本/负载/消息/硬规矩）的 --check 验的是「判据本身」，
  //       破坏要打在判据的**输入或常量**上，不是打业务数据。
  //
  //  ══════════════════════════════════════════════════════════════
  //  两个**已知盖不住**的地方（不是漏写，是这层方法本身测不到）
  //  ══════════════════════════════════════════════════════════════
  //  ① 验证闸 --check 只量「放行率在 0 和 100 之间」，量不到判据的**质量**。
  //     实测：把 gate4IsConclusion 改成 Math.random()<0.5 随机放行，
  //     放行率 49.6% → 它照样 exit 0 报「判据有区分度」。
  //     也就是说：判据被换成抛硬币，这条检查抓不到。
  //     真正能抓住的是 selftest（那个假定 pass===false 的反例），
  //     本表按机制体检的 args 走 --check，所以盖不住这一层。
  //     要补，得让 --check 也跑一组固定反例（不是靠语料统计）。
  //
  //  ② 消息闸 --audit 的「≤3 条」判据按 (from,to) 对数累计，
  //     不是按「同一件事」累计。不同 subject 的 4 条合法消息
  //     也会被判「同一件事已发 4 条」。这是**误判方向**的偏差，
  //     破坏性验证只能证明它「会红」，证明不了它「红得对」。
  // ════════════════════════════════════════════════════════════════
  {
    name: '进度判定',
    file: '进度判定.mjs',
    args: ['--check'],
    // 判据：同一 target+subject 在**在途**里重复出现 → 打转 → exit 1
    //       （停滞也会红，但那条要等 24h，不能靠时间造）
    // 破坏：往台账追加两条同 target+subject 的 delivered 单
    //       —— 形态是真实的在途派单（有 createdAt/deliveredAt/deadline），
    //          不是缺字段的假数据，否则 in_loop 那一段统计不到它们。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '派单台账.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const j = JSON.parse(orig.toString('utf8'));
      const now = Date.now();
      for (const i of [1, 2]) {
        j.dispatches.push({
          id: 'zz-progress-' + i,
          type: 'dispatch',
          from: 'hub',
          to: '调研',
          subject: '打转探针-同一件事派两次',
          phenomenon: '造破坏：同一件事重复派单',
          howto: '造破坏用，跑完即恢复',
          verify: '产物存在',
          state: 'delivered',
          createdAt: new Date(now).toISOString(),
          deliveredAt: new Date(now).toISOString(),
          deadline: new Date(now + 86400000).toISOString(),
        });
      }
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '汇总校验',
    file: '汇总校验.mjs',
    args: ['--check'],
    // 判据：中枢实际照抄的模板（中枢/AGENTS.local.md 的「## 汇总」段）
    //       必须和校验器认的四个节名口径一致。
    // 破坏：把模板里的「## 分歧与缺口」改成「## 风险与假设」
    //       —— 中枢会照新模板写，校验器还在找旧名字，
    //          每一份合格汇总都会被判「缺节」。这正是它防的那种漂移。
    break() {
      const p = path.join(DATA, '场景记忆', '中枢', 'AGENTS.local.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const md = orig.toString('utf8');
      if (!md.includes('## 分歧与缺口')) return null;
      fs.writeFileSync(p, md.replace('## 分歧与缺口', '## 风险与假设'), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '章节唯一性',
    file: '合并重复章节.mjs',
    args: ['--check'],
    // 判据：同一份场景记忆里，规范化后的章节标题必须唯一
    //       （「## 五、坑与决策」和「## 五、坑与决策（只追加）」算同一节）
    // 破坏：在「调研」记忆末尾复制一个已有章节标题
    //       —— 这正是 AI 在真实闭环里犯过的错：两个「五、坑与决策」，
    //          新经验该追加到哪一节产生歧义，锚点索引随之失效。
    break() {
      const p = path.join(DATA, '场景记忆', '调研', '场景私有记忆.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const md = orig.toString('utf8');
      if (!md.includes('## 五、坑与决策')) return null;
      // 带括号注释，验证 normalizeHeading 真的把两者当同一节
      fs.writeFileSync(p, md +
        '\n## 五、坑与决策（只追加）\n\n- 2026-11-12：造破坏留下的重复章节。\n', 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '自动回执',
    file: '自动回执.mjs',
    args: ['--check'],
    // 判据：台账里不允许有「state=delivered 但没有 receipt」的单
    //       —— 那是闭环最后一跳断了的直接证据。
    // 破坏：塞一条 delivered 无回执的记录。
    //
    // ⚠ 只认 delivered，不认 closed —— 实测 confirmation：
    //    塞 closed 缺回执，自动回执仍然 exit 0（它不管销账那一跳），
    //    不能拿它去测这个工具，否则会误判成「装饰」。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '派单台账.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const j = JSON.parse(orig.toString('utf8'));
      j.dispatches.push({
        id: 'zz-no-receipt',
        type: 'dispatch',
        from: 'hub',
        to: '调研',
        subject: '造破坏：投递了但永远等不到回执',
        phenomenon: '造破坏用',
        howto: '造破坏用',
        verify: '产物存在',
        state: 'delivered',
        createdAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
      });
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '验证闸',
    file: '验证闸.mjs',
    args: ['--check'],
    // 判据：用真实记忆语料量闸 4（结论/过程）的放行率，
    //       两个边界任一破了就红：100% 放行 = 没闸，0% 放行 = 真结论也进不去。
    // 破坏：把真实语料换成一堆**全是结论**的条目
    //       —— 放行率立刻 100%，「判据太松，等于没闸」必须报出来。
    //
    // ⚠ 为什么不能简单删光记忆：
    //    删光后 total=0，它走「无数据，不算通过也不算失败」分支 exit 0 ——
    //    那是**正确的设计**（没数据不能假装查过），但也就测不到判据。
    //    所以这里故意留一份「判据会全放行」的语料去撞它的上边界。
    //
    // ⚠ 两个必须注意的点（第一版都踩了）：
    //    ① 语料目录名不能以 _ 开头（会被当共享目录跳过）
    //    ② 原场景目录必须**移出 场景记忆/ 之外**，不能只改个名 ——
    //       改名后它仍在 场景记忆/ 下、仍不以 _ 开头，照样被当场景扫，
    //       于是真实语料还在，放行率到不了 100%，破坏白做。
    //       移到 数据/.dsh/_zz_brk_验证闸/ 这种 _ 开头的外部目录，
    //       验证闸根本不看那里，restore 再挪回来。
    break() {
      const MEM = path.join(DATA, '场景记忆');
      if (!fs.existsSync(MEM)) return null;
      const scenes = fs.readdirSync(MEM, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
      if (scenes.length === 0) return null;

      const park = path.join(DATA, '_zz_brk_验证闸_' + process.pid);
      fs.mkdirSync(park, { recursive: true });

      // 原样记下每个场景目录名，restore 时逐个改回（不用通配，风险太大）
      const moves = scenes.map((n) => ({
        from: path.join(MEM, n),
        to: path.join(park, n),
      }));
      for (const m of moves) fs.renameSync(m.from, m.to);

      const probe = path.join(MEM, 'zz闸门探针场景');
      fs.mkdirSync(probe, { recursive: true });
      const lines = [];
      for (let i = 1; i <= 20; i++) {
        lines.push('- 改动判据前必须先造一个反例验证它真的会失败，否则就是在装饰第' + i + '条');
      }
      fs.writeFileSync(path.join(probe, '场景私有记忆.md'), lines.join('\n') + '\n', 'utf8');

      return () => {
        try { fs.rmSync(probe, { recursive: true, force: true }); } catch { /* */ }
        for (const m of moves) {
          try { fs.renameSync(m.to, m.from); } catch { /* */ }
        }
        try { fs.rmSync(park, { recursive: true, force: true }); } catch { /* */ }
      };
    },
  },
  {
    name: '成本闸',
    file: '成本闸.mjs',
    args: ['--check'],
    // 性质：运行时闸门（--check [--tokens N] 判「这次跑得起吗」）。
    //       但它的判据是纯函数 checkBudget，输入来自 成本预算.json + 成本台账.jsonl，
    //       所以「判据还行不行」是可以造数据撞的。
    // 破坏：写一条今日已消耗 500 万 token 的台账记录（日上限 200 万）
    //       —— 复现事故条件「余额烧穿」，此时任何申请都必须被拒。
    //
    // ⚠ 恢复要区分「原来没有这个文件」：本仓库当前没有 成本台账.jsonl，
    //    直接写回空内容会凭空造出一个文件，必须删掉才算真恢复。
    break() {
      const p = path.join(DATA, '成本台账.jsonl');
      const existed = fs.existsSync(p);
      const orig = existed ? fs.readFileSync(p) : null;
      const today = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(p, JSON.stringify({
        at: today + 'T00:00:01.000Z',
        tokens: 5000000,
        note: '造破坏：模拟今日已烧穿日预算',
      }) + '\n', 'utf8');
      return () => {
        if (existed) fs.writeFileSync(p, orig);
        else { try { fs.unlinkSync(p); } catch { /* */ } }
      };
    },
  },
  {
    name: '负载闸',
    file: '负载闸.mjs',
    args: ['--check'],
    // 性质：运行时闸门，但 --check 用**注入的假数据**验判据边界，
    //       所以判据常量被改坏时它必须红。
    // 破坏：把 GATE.WARN_PCT 从 90 改成 96 —— 两档（90 warn / 95 stop）语义重叠，
    //       「正好 90% 该 warn」这条边界不再成立。
    //
    // ⚠ 用 Buffer 做等长字节替换（'WARN_PCT: 90,' → 'WARN_PCT: 96,'），
    //    不用正则整文件重写 —— 少一次「顺手改了别的字节」的机会。
    //    替换前先数出现次数，不是正好 1 次就放弃（返回 null 由上层跳过），
    //    免得改错地方还以为在测这条判据。
    break() {
      const p = path.join(TOOLS, '负载闸.mjs');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const needle = Buffer.from('WARN_PCT: 90,');
      const md = orig.toString('utf8');
      if (md.split(needle.toString('utf8')).length - 1 !== 1) return null;
      const at = orig.indexOf(needle);
      if (at < 0) return null;
      const next = Buffer.concat([
        orig.subarray(0, at), Buffer.from('WARN_PCT: 96,'), orig.subarray(at + needle.length),
      ]);
      if (next.length !== orig.length) return null;
      fs.writeFileSync(p, next);
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '消息闸',
    file: '消息闸.mjs',
    args: ['--audit'],
    // 判据：所有**真实落盘**的跨场景消息，首行必须是
    //       【需要回执】/【不需要回执·知悉】，末行必须是【结束】。
    // 破坏：往 _跨场景通知.md 追加一条真实的违规消息「收到」
    //       —— 纯确认语 + 无标记 + 无结束，三处违规同时命中。
    //
    // ⚠ 该文件是 UTF-8 带 \n；仍按 Buffer 备份，restore 原样写回。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '_跨场景通知.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, orig.toString('utf8').replace(/\r\n/g, '\n') +
        '\n- → 调研：收到\n', 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '口径对齐',
    file: '口径对齐.mjs',
    args: ['--json'],
    // 判据：同一个「场景数」在 场景路由/场景层级/记忆目录/scenarios JSON/skills
    //       五处必须一致。
    // 破坏：从 场景路由.yaml 里删掉 research 那一条
    //       —— 路由=8、其余=9，口径立刻对不上。
    //
    // ⚠ 这是「多源一致性」检查，破坏必须打在**其中一源**上。
    //    往台账塞 delivered 无回执（自动回执那条的破坏）撞不动它 ——
    //    实测口径对齐仍 exit 0，因为它只核状态合法性，不核回执正文。
    break() {
      const p = path.join(DATA, '场景路由.yaml');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const md = orig.toString('utf8').replace(/\r\n/g, '\n');
      // 删「- id: research」这一条（含其后的缩进子字段，直到下一个同级条目）
      const next = md.replace(/^ *- id: research\n(?:[ \t]+[^\n]*\n)*/m, '');
      if (next === md) return null;
      fs.writeFileSync(p, next, 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '场景层级',
    file: '场景层级.mjs',
    args: ['--validate'],
    // 判据：role 必须和 parent/children 自洽 ——
    //       root 不许有 parent，sub 必须有 parent，main 必须有子场景。
    // 破坏：把 research 的 role 从 root 改成 sub（parent 仍为空）
    //       —— 直接违反「sub 必须有 parent」。
    break() {
      const p = path.join(DATA, '场景层级.yaml');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const md = orig.toString('utf8').replace(/\r\n/g, '\n');
      // 只改 research 那一段里的 role，不动别的场景
      const idx = md.indexOf('  research:');
      if (idx < 0) return null;
      const seg = md.slice(idx);
      const end = seg.search(/\n {2}[a-z][a-z0-9-]*:\s*\n/);
      const block = end < 0 ? seg : seg.slice(0, end);
      const newBlock = block.replace('role: root', 'role: sub');
      if (newBlock === block) return null;
      fs.writeFileSync(p, md.slice(0, idx) + newBlock + (end < 0 ? '' : seg.slice(end)), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '硬规矩',
    file: '硬规矩.mjs',
    args: ['--check'],
    // 性质：运行时闸门，--check 用**假数据**验三条规矩的边界。
    // 破坏：把 judgeLoad 的边界从 `>=` 改成 `>`
    //       —— 正好 90.0% 时会被放行。这不是随便造的错：
    //          本项目历史上真的这样错过一次（自测用复制品盖住了它），
    //          这条破坏就是在守那个回归。
    //
    // ⚠ 等长替换（`loadPct >= max;` → `loadPct >  max;`），
    //    保留字节数不变，替换后能原样回退。
    break() {
      const p = path.join(TOOLS, '硬规矩.mjs');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const needle = Buffer.from('loadPct >= max;');
      const md = orig.toString('utf8');
      if (md.split(needle.toString('utf8')).length - 1 !== 1) return null;
      const at = orig.indexOf(needle);
      if (at < 0) return null;
      const next = Buffer.concat([
        orig.subarray(0, at), Buffer.from('loadPct >  max;'), orig.subarray(at + needle.length),
      ]);
      if (next.length !== orig.length) return null;
      fs.writeFileSync(p, next);
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '回滚',
    file: '回滚.mjs',
    args: ['--check'],
    // 判据：最新快照里每个文件的内容，sha256 必须和 manifest 记录一致
    //       —— 不一致 = 快照已损坏，回滚会恢复出错误内容（比不恢复更糟）。
    // 破坏：改掉 memory 类最新快照里的一个内容文件（不动 manifest）
    //       —— 模拟快照被写坏。
    //
    // ⚠ 为什么不用「删掉整个快照」：
    //    实测删掉 memory 最新快照后仍然 exit 0 —— 因为这一类还有更早的一个，
    //    它校验的是「最新那个」，不是「总共几个」。删光才会红，
    //    但删光测的是「快照库空着」，不是「快照损坏」，两回事。
    //    这里打的是它真正声称要防的东西：内容与 hash 不符。
    break() {
      const memRoot = path.join(DATA, '回滚快照', 'memory');
      if (!fs.existsSync(memRoot)) return null;
      const dirs = fs.readdirSync(memRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name).sort();
      if (dirs.length === 0) return null;
      const snapDir = path.join(memRoot, dirs[dirs.length - 1]);
      const manPath = path.join(snapDir, 'manifest.json');
      if (!fs.existsSync(manPath)) return null;

      let man;
      try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch { return null; }
      const rec = (man.files || []).find((f) => f.contentFile && !f.truncated);
      if (!rec) return null;
      const target = path.join(snapDir, rec.contentFile);
      if (!fs.existsSync(target)) return null;

      const orig = fs.readFileSync(target);
      fs.writeFileSync(target, 'TAMPERED BY 破坏性验证\n', 'utf8');
      return () => fs.writeFileSync(target, orig);
    },
  },

  // ════════════════════════════════════════════════════════════════
  //  业务 / 结构类（12 个）
  //
  //  ⚠ 通用约定：
  //    ① 破坏前把原文读成 **Buffer**，restore 用 Buffer 原样写回
  //       —— 这些文件里有 GBK/CRLF/BOM 的历史产物，utf8 字符串往返会
  //         悄悄改字节：数据看着在，其实已经不一样了。
  //    ② args 必须与 机制体检.mjs 的 GUARDS 完全一致（默认模式写空数组）。
  //    ③ 破坏点必须打在该检查器的**判据**上，不是打在无关的地方。
  // ════════════════════════════════════════════════════════════════

  {
    name: '派单哨兵',
    file: '派单哨兵.mjs',
    args: [],
    // 判据：INV-6 id 必须是 d-YYYYMMDD-NNN。
    // 破坏：往台账追加一条 id 不合法的派单（其余字段合法，避免一次报太多项
    //       掩盖住真正要证的那条判据）。
    //       createdAt 给「现在」，避开 INV-4 的超时判定，只留 id 这一处违规。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '派单台账.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      let j;
      try { j = JSON.parse(orig.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
      if (!Array.isArray(j.dispatches)) return null;
      j.dispatches.push({
        id: 'BAD-ID-日期段缺失',
        type: 'dispatch',
        from: 'hub',
        to: '调研',
        subject: '破坏性验证探针',
        phenomenon: '一句足够长的现象描述',
        howto: '一句足够长的做法描述',
        verify: '一句足够长的验收描述',
        state: 'created',
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '健康度计算',
    file: '健康度计算.mjs',
    args: [],
    // ⚠ 诚实说明：这是「计算器」不是「判据检查器」。
    //   读它的 main() 只有两条失败路径：
    //     ① 派单台账读不到 / JSON 解析失败 → 「✗ 找不到派单台账」+ exit 1
    //     ② 健康度.json 写盘失败           → exitCode 1
    //   算出来的判定全是 bad，它也照样 exit 0（那是 健康哨兵 的活）。
    //   所以这里打的是它唯一的真前置条件：台账不可读。
    //   副作用：正常运行会重写 健康度.json（这是它的本职），restore 只还原台账。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '派单台账.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, '{"dispatches": [ 台账被破坏性验证写成非法 JSON', 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '健康哨兵',
    file: '健康哨兵.mjs',
    args: [],
    // 判据：INV-1 一次通过率 < 40%（且样本足够）必须报。
    // 破坏：把某个 hasEnoughSamples=true 的场景改成 10%。
    //       —— 只改 firstPassRate/firstPass，不动 hasEnoughSamples，
    //          确保它走的是 INV-1 而不是「样本不足 → 跳过」。
    // ⚠ 2026-11-13 修（依赖「已有样本充足」→ 样本不足时 break 返回 null）
    //
    //   原来：找 hasEnoughSamples=true 的场景去改。
    //   实测：所有 9 个场景的 hasEnoughSamples 都是 false
    //        （因为作废了测试单，真实派单样本不够）。
    //        → break() 返回 null → 破坏性验证报「前置状态不对，无法制造破坏」
    //        → 这一项从「能证伪」变成「无法验证」。
    //
    //   根本问题：一个**验证工具**不该依赖「生产数据恰好够用」。
    //   修法：造一个临时的、样本充足的场景条目（不碰真实数据），
    //        测完删掉。这样无论生产数据多寡，这条用例都能跑。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '健康度.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      let j;
      try { j = JSON.parse(orig.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }

      // 优先用真实场景（如果样本够）；否则造一个临时场景
      let target = Object.values(j.scenes || {}).find((s) => s && s.hasEnoughSamples);
      let injectedKey = null;
      if (!target) {
        if (!j.scenes) j.scenes = {};
        injectedKey = '__probe_health__';
        j.scenes[injectedKey] = {
          hasEnoughSamples: true,
          firstPassRate: 0.10,
          firstPass: 1,
          total: 10,
          scene: injectedKey,
        };
        target = j.scenes[injectedKey];
      } else {
        target.firstPassRate = 0.10;
        target.firstPass = 1;
      }
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '闭环断点体检',
    file: '闭环断点体检.mjs',
    args: [],
    // 判据：断点2 —— 各工具抓 token 的正则长度下限必须一致（都是 {20,}）。
    //       混用 {30,} 会让部分工具静默抓不到 token。
    // 破坏：把 中枢代写.mjs 的 {20,} 改成 {30,}，制造不一致。
    break() {
      const p = path.join(TOOLS, '中枢代写.mjs');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const src = orig.toString('utf8');
      const marker = 'token=([A-Za-z0-9_-]{20,})';
      if (!src.includes(marker)) return null;
      fs.writeFileSync(p, src.replace(marker, 'token=([A-Za-z0-9_-]{30,})'), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '派单闭环',
    file: '派单闭环验证.mjs',
    args: [],
    // 判据：派单.mjs 必须拒绝「只说好了」这种凑字数的回执（>= 20 字符）。
    // 破坏：把 派单.mjs 的 MIN_EVIDENCE_LEN 从 20 改成 1。
    //       → 「好了」2 字也能过闸 → 验证脚本里的
    //         「回执"好了"必须拒绝」与交叉断言「坏证据 ⇔ 真实工具拒绝」双双变红。
    break() {
      const p = path.join(TOOLS, '派单.mjs');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const src = orig.toString('utf8');
      const marker = 'export const MIN_EVIDENCE_LEN = 20;';
      if (!src.includes(marker)) return null;
      fs.writeFileSync(p, src.replace(marker, 'export const MIN_EVIDENCE_LEN = 1;'), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '进化哨兵',
    file: '进化哨兵.mjs',
    args: [],
    // 判据：INV-3 —— L2（技能进化）必须带回测，且回测全通过。
    // 破坏：把一条真实的 L1 记录改成 L2（它本来就没有 backtest 字段）。
    //       —— 不新造记录，避免撞上 INV-5/INV-7 等别的判据。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '进化台账.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      let j;
      try { j = JSON.parse(orig.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
      const evo = (j.evolutions || [])[0];
      if (!evo) return null;
      evo.level = 'L2';
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '归因完整性',
    file: '归因.mjs',
    args: [],
    // 判据：窗口内有非终态（不是 acked/closed/cancelled）的派单 → 报 unacked 并 exit 1。
    // 破坏：追加一条 state=unacked、createdAt=现在 的派单（落在 30 天窗口内）。
    //       subject 用唯一值，避免再触发「同类任务失败 ≥3 次」的技能缺口判据。
    break() {
      const p = path.join(DATA, '场景记忆', '_共享记忆', '派单台账.json');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      let j;
      try { j = JSON.parse(orig.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
      if (!Array.isArray(j.dispatches)) return null;
      j.dispatches.push({
        id: 'd-20261112-901',
        type: 'dispatch',
        from: 'hub',
        to: '调研',
        subject: '破坏性验证-未回执探针',
        state: 'unacked',
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '备份完整性',
    file: '备份.mjs',
    args: ['--verify'],
    // 判据：manifest 里每个文件的 SHA256 必须与实际文件一致。
    // 破坏：把最新一份备份里的某个文件翻转一个字节（不动 manifest）。
    //       —— 这正是「备份被写坏却照样 PASS」要防的那类事故。
    break() {
      const root = path.join(WB, '备份');
      if (!fs.existsSync(root)) return null;
      let ids;
      try {
        ids = fs.readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
      } catch { return null; }
      for (const id of ids) {
        const manPath = path.join(root, id, 'manifest.json');
        if (!fs.existsSync(manPath)) continue;
        let man;
        try { man = JSON.parse(fs.readFileSync(manPath, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
        for (const e of (man.entries || [])) {
          if (!e.path || !e.sha256) continue;
          const target = path.join(root, id, e.path);
          if (!fs.existsSync(target)) continue;
          const orig = fs.readFileSync(target);
          if (orig.length === 0) continue;
          const tampered = Buffer.from(orig);
          tampered[0] = tampered[0] ^ 0xFF;     // 只翻第一个字节
          fs.writeFileSync(target, tampered);
          return () => fs.writeFileSync(target, orig);
        }
      }
      return null;
    },
  },
  {
    name: '内容哨兵',
    file: '内容哨兵.mjs',
    args: [],
    // 判据：INV-1 身份卡不能是模板（含"待明确"/"由工具生成"）。
    // 破坏：往一张真实身份卡末尾追加「（待明确）」。
    break() {
      const p = path.join(DATA, '场景记忆', '架构梳理', '身份卡.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, orig.toString('utf8') + '\n## 待明确\n\n（待明确）\n', 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '中枢调度卡',
    file: '中枢调度卡哨兵.mjs',
    args: [],
    // 判据：INV-6 不能含有害内容（think step by step / be thorough / 别偷懒 …）。
    // 破坏：往调度卡末尾追加一句 "think step by step"。
    //       —— 追加后约 2253 B，仍在 2800 B 预算内，不会同时触发 INV-1。
    // ⚠ 2026-11-12 修（改的是废弃目录，破坏失效）
    //
    //   原来：path.join(DATA, '场景注入', 'hub', 'AGENTS.local.md')
    //   但第 14 轮「场景工作目录迁移（方案 A）」后，中枢会话实际读的是
    //        数据/.dsh/场景记忆/中枢/AGENTS.local.md
    //   而 中枢调度卡哨兵 也已经（本轮）改指向新路径。
    //   于是：破坏写旧文件 → 哨兵读新文件 → 内容没变 → 判「装饰」。
    //
    //   实测：这条用例从 OK 变成「XX 正常=PASS 破坏后=PASS（装饰！）」。
    //
    //   修法：指向会话 cwd 里真正被 AI 读到的那个文件。
    break() {
      const p = path.join(DATA, '场景记忆', '中枢', 'AGENTS.local.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, orig.toString('utf8') + '\n派单前请 think step by step 地想一想。\n', 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '文档体检',
    file: '文档体检.mjs',
    args: [],
    // 判据：有索引的目录里，新增的 .md 必须在索引里登记过（§2.7 硬规矩①）。
    // 破坏：往 场景记忆/中枢 丢一个没登记的新文档 → 报「漏登记」→ exit 1。
    //
    // ⚠ 附带修了工具本身一个缺陷（不在本用例范围，但不修这条根本测不了）：
    //   文档体检 原来用 `path.join('workbench', norm)` 解析索引里的相对路径，
    //   即**按 cwd** 解析。在 workbench/ 里跑会变成 workbench/workbench/...，
    //   9 个索引全报幽灵行 54 处 → 正常状态下就恒 FAIL；换到项目根跑又全绿。
    //   已锚定到 WB，与 cwd 无关（见 文档体检.mjs checkIndexAccuracy）。
    break() {
      const p = path.join(DATA, '场景记忆', '中枢', '破坏性验证探针.md');
      if (fs.existsSync(p)) return null;
      fs.writeFileSync(p,
        '# 破坏性验证探针\n\n这个文件不该存在。它用来验证索引对账能不能抓到「漏登记」。\n', 'utf8');
      return () => { try { fs.unlinkSync(p); } catch { /* */ } };
    },
  },
  {
    name: '设计一致性',
    file: '设计一致性.mjs',
    args: [],
    // 判据：① 无游离 hex ② 圆角必须在阶梯上 ③ 间距必须是 4 的倍数。
    // 破坏：往 main-agent.js 末尾注入一行，一次同时踩中三条：
    //         color:#ABCDEF  → 游离 hex
    //         border-radius:5px → 不在 0/4/6/8/12/16/999 阶梯上
    //         padding:7px    → 不是 4 的倍数
    //       —— 必须是「非注释行」，否则 findStrayHex 会跳过注释放过 hex。
    break() {
      const p = path.join(WB, '外壳', 'ui', 'panels', 'main-agent.js');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      fs.writeFileSync(p, orig.toString('utf8') +
        "\nconst __destructiveProbe = 'border-radius:5px;padding:7px;color:#ABCDEF';\n", 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
  {
    name: '命令可执行体检',
    file: '命令可执行体检.mjs',
    args: [],
    // 判据：每个场景的 AGENTS.local.md 必须有「## 命令执行目录」小节。
    //
    // 破坏：删掉「调研」场景的该小节。
    //      这是**基础设施缺失** —— 缺了它，将来技能里加任何
    //      `工具/xxx.mjs` 命令，AI 照抄都会报 Cannot find module。
    break() {
      const p = path.join(DATA, '场景记忆', '调研', 'AGENTS.local.md');
      if (!fs.existsSync(p)) return null;
      const orig = fs.readFileSync(p);
      const txt = orig.toString('utf8');
      const i0 = txt.indexOf('## 命令执行目录');
      if (i0 < 0) return null;
      const rest = txt.slice(i0 + 5);
      const nxt = rest.indexOf('\n## ');
      const endPos = nxt < 0 ? txt.length : i0 + 5 + nxt + 1;
      const modified = txt.slice(0, i0) + txt.slice(endPos);
      fs.writeFileSync(p, modified, 'utf8');
      return () => fs.writeFileSync(p, orig);
    },
  },
];

// ══════════════════════════════════════════════════════════════════════
function run(file, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(TOOLS, file), ...(args || [])], {
      cwd: WB, encoding: 'utf8', timeout: 240000, windowsHide: true,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: (e && e.status) || 1, out: String(((e && e.stdout) || '') + ((e && e.stderr) || '')) };
  }
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  破坏性验证 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】用例表完整');
  chk('有用例', CASES.length > 0, CASES.length + ' 个');
  chk('每个用例有 name/file/break',
    CASES.every((c) => c.name && c.file && typeof c.break === 'function'));

  console.log();
  console.log('【二】run 能判成功/失败');
  {
    const ok = run('文件索引写入.mjs', ['--check']);
    chk('正常检查能跑', ok.code === 0, 'exit=' + ok.code);
    const fail = run('__不存在的工具__.mjs', []);
    chk('不存在的工具判失败', fail.code !== 0, 'exit=' + fail.code);
  }

  console.log();
  console.log('【三】破坏-恢复闭环不失手');
  {
    const c = CASES[0];
    const target = path.join(DATA, 'skills', 'research');
    const before = fs.existsSync(target);
    const restore = c.break();
    const broken = !fs.existsSync(target);
    if (restore) restore();
    const after = fs.existsSync(target);
    chk('破坏成功', before && broken);
    chk('恢复成功', after);
  }

  // ⚠ 2026-11-12 加【三b】：恢复必须是**内容级**的，不只是文件存在
  //
  //   为什么加：原来的【三】只验 `fs.existsSync(after)` —— 文件在就算恢复成功。
  //   实测后果：测「经验真实性体检」时注入的 3 条虚构经验，
  //            恢复时没删干净，留在 调研/场景私有记忆.md 里。
  //            真实数据被污染，那个检查从此正常状态就红。
  //
  //   这是**破坏性验证本身的缺陷**：它污染了它要保护的数据。
  //
  //   修法：加一个「内容级恢复」验证用例：
  //     ① 记下目标文件的 sha256
  //     ② break() → 确认内容变了
  //     ③ restore() → 确认 sha256 与最初**完全一致**
  console.log();
  console.log('【三b】恢复必须是内容级的（不只是文件存在）');
  {
    // crypto 已在文件顶部 import
    const hashFile = (p) => {
      try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
      catch { return null; }
    };

    // 找一个会改内容（不是删文件）的用例
    const contentCase = CASES.find((x) =>
      /记忆评估|经验真实性体检|消息闸|验证闸|健康哨兵/.test(x.name));
    if (!contentCase) {
      chk('找到内容型用例', false, '没有可测的用例');
    } else {
      // 先跑一遍正常 break/restore 看有没有残留
      // 用「跑完 restore 后，该用例涉及的所有文件哈希必须与跑前一致」
      const preHashes = new Map();
      // 记录 数据 目录下所有 md/json 的哈希（粗粒度，够用来发现残留）
      const snapAll = () => {
        const m = new Map();
        const walk = (dir, depth) => {
          if (depth > 4) return;
          let ents = [];
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (['sessions', 'node_modules', '.git'].includes(e.name)) continue;
              walk(p, depth + 1);
            } else if (e.name.endsWith('.md') || e.name.endsWith('.json')) {
              const h = hashFile(p);
              if (h) m.set(p, h);
            }
          }
        };
        walk(DATA, 0);
        return m;
      };

      const before = snapAll();
      let restoreFn = null;
      try { restoreFn = contentCase.break(); } catch { restoreFn = null; }
      if (restoreFn) {
        restoreFn();
        const after = snapAll();
        // 找出内容被改变的
        const changed = [];
        for (const [p, h] of before) {
          if (after.get(p) !== h) changed.push(path.relative(DATA, p));
        }
        const added = [...after.keys()].filter((p) => !before.has(p)).map((p) => path.relative(DATA, p));
        chk('内容型用例 restore 后无残留修改',
            changed.length === 0 && added.length === 0,
            changed.length || added.length
              ? '残留: ' + [...changed, ...added].slice(0, 3).join(', ')
              : '逐字节一致');
      } else {
        chk('内容型用例能造破坏', false, contentCase.name + ' break() 返回空');
      }
    }
  }

  // ⚠ 2026-11-12 加【三c】：源文件基线校验必须真的能抓到损坏
  //
  //   真实事故：派单.mjs 的 MIN_EVIDENCE_LEN 被上次中断的运行留在 1，
  //            然后被 git add -A 提交，导致"好了"空话回执能过闸好几天。
  //
  //   这条自测逐个制造损坏，验证 checkSourceBaseline() 都能抓到。
  console.log();
  console.log('【三c】源文件基线校验要能抓到每一类损坏');
  {
    const cases = [
      { file: '派单.mjs', from: 'MIN_EVIDENCE_LEN = 20;', to: 'MIN_EVIDENCE_LEN = 1;', desc: '派单：证据下限 20→1' },
      { file: '负载闸.mjs', from: 'WARN_PCT: 90,', to: 'WARN_PCT: 96,', desc: '负载闸：warn 90→96' },
      { file: '负载闸.mjs', from: 'STOP_PCT: 95,', to: 'STOP_PCT: 90,', desc: '负载闸：stop 95→90' },
      { file: '硬规矩.mjs', from: 'LOAD_MAX_PCT: 90,', to: 'LOAD_MAX_PCT: 80,', desc: '硬规矩：上限 90→80' },
      { file: '中枢代写.mjs', from: 'token=([A-Za-z0-9_-]{20,})', to: 'token=([A-Za-z0-9_-]{30,})', desc: '中枢代写：token 20→30' },
    ];

    // 先确认基线本身是绿的（否则后续断言无意义）
    const pre = checkSourceBaseline();
    chk('基线起点全绿', pre.ok, pre.problems.join('; ') || '4 个源文件判据都在预期值');

    let caught = 0;
    for (const t of cases) {
      const p = path.join(TOOLS, t.file);
      if (!fs.existsSync(p)) continue;
      const orig = fs.readFileSync(p);
      const src0 = orig.toString('utf8');
      if (!src0.includes(t.from)) continue;
      fs.writeFileSync(p, src0.replace(t.from, t.to), 'utf8');
      const r = checkSourceBaseline();
      fs.writeFileSync(p, orig);
      const hit = !r.ok && r.problems.some((x) => x.includes(t.file));
      if (hit) caught++;
      chk('反例：' + t.desc + ' 必须被抓', hit,
          hit ? '已抓' : '没抓到（判据失效）');
    }

    chk('5 类损坏全部被抓', caught === 5, caught + ' / 5');

    // 恢复后必须全绿
    const post = checkSourceBaseline();
    chk('恢复后基线全绿', post.ok, post.problems.join('; ') || '已恢复');
  }

  console.log();
  console.log('【四】反例：如果一个检查器是装饰（恒 exit 0），本工具必须判它失败');
  {
    // 造一个永远 exit 0 的假检查器
    const fake = path.join(TOOLS, 'zz_fake_pass.mjs');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("我永远通过");\n', 'utf8');
    const r = run('zz_fake_pass.mjs', []);
    fs.unlinkSync(fake);
    chk('反例：恒 exit 0 的工具会被判「抓不到问题」', r.code === 0,
      '它 exit=' + r.code + ' → 若被当检查器，破坏后仍 exit 0 = 装饰');
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
//  残留探测（2026-11-12 新增）
//
//  为什么需要：破坏性验证会临时改真实文件/造探针文件，靠 break() 返回的
//  restore 恢复。但如果进程被中断（Ctrl+C、超时、kill），restore 就没跑。
//
//  实测：一次中断后，`数据/.dsh/场景记忆/中枢/破坏性验证探针.md` 留了下来，
//       导致 文档体检 一直报「漏登记」，而那个检查本身是对的。
//
//  这个函数不自动删（不能猜哪些文件是残留、哪些是真实数据），
//  只**报告**：跑之前先看有没有已知的探针残留，有就明确说出来。
// ══════════════════════════════════════════════════════════════════════

/** 已知的探针/残留文件模式（break() 会造的临时文件） */
export const STALE_PATTERNS = [
  { path: ['场景记忆', '中枢', '破坏性验证探针.md'], case: '文档体检' },
];

// ══════════════════════════════════════════════════════════════════════
//  源文件基线（2026-11-12 新增，真实事故驱动）
//
//  事故：破坏性验证的「派单闭环」用例会把 派单.mjs 的
//        MIN_EVIDENCE_LEN 从 20 改成 1 制造破坏。
//        那次运行被中断，restore 没跑 → 文件永久停在 MIN_EVIDENCE_LEN=1。
//        然后 `git add -A` 把这个损坏状态提交进了 git（提交 910d371）。
//
//  后果：派单.mjs 从此接受「好了」这种空话回执；
//        派单闭环验证 报「回执"好了"必须拒绝 exit=0」（应该 exit 2）、
//        「交叉断言：坏证据 ⇔ 真实工具拒绝 判据ok=false 真实exit=0」。
//        连续几天没人发现，因为这两个断言平时是 OK 的，
//        只有真正跑一遍派单闭环验证才会看到。
//
//  修法：跑破坏性验证之前，先校验这些源文件的**关键判据常量**是否在预期值上。
//        不在就明确报「源文件可能被上次中断的运行改坏了」，并拒绝继续。
//        （拒绝而不是「自动修复」—— 因为不能猜哪些值是对的。）
// ══════════════════════════════════════════════════════════════════════

/** 被 break() 改写的源文件 + 它们的关键判据预期值 */
export const SOURCE_BASELINE = [
  {
    file: '派单.mjs',
    // 证据最少 20 字符 —— 低于这个值「好了」这类空话就能过闸
    expect: [{ name: 'MIN_EVIDENCE_LEN', value: 20 }],
    why: '低于 20 时空话回执能过闸',
  },
  {
    file: '负载闸.mjs',
    // 三档阈值：90 warn / 95 stop。被改成 96 会让 warn/stop 语义重叠
    expect: [
      { name: 'WARN_PCT', value: 90 },
      { name: 'STOP_PCT', value: 95 },
    ],
    why: 'WARN 改大会与 STOP 语义重叠，边界判据失效',
  },
  {
    file: '硬规矩.mjs',
    // 负载上限 90%。judgeLoad 的边界被从 >= 改成 > 时正好 90.0% 会被放行
    expect: [{ name: 'LOAD_MAX_PCT', value: 90 }],
    why: '改小会让负载闸提前拒绝，改大则失守',
  },
  {
    file: '中枢代写.mjs',
    // token 正则长度下限必须与其他工具一致（都是 {20,}）
    // 这是正则不是常量，单独用 pattern 校验
    expect: [],
    pattern: {
      re: 'token=\\(\\[A-Za-z0-9_-\\]\\{20,\\}\\)',
      desc: 'token 正则必须是 {20,}',
    },
    why: '混用 {30,} 会让部分工具静默抓不到 token',
  },
];

// ══════════════════════════════════════════════════════════════════════
//  源文件基线校验
//
//  ⚠ 判据要支持两种常量形式（实测项目里都有）：
//    ① 顶层常量：  export const MIN_EVIDENCE_LEN = 20;
//    ② 对象属性：  export const GATE = { WARN_PCT: 90, STOP_PCT: 95 };
//    ③ 对象属性（硬规矩）：export const HARD_RULES = { LOAD_MAX_PCT: 90 };
// ══════════════════════════════════════════════════════════════════════

/**
 * 从源码里取出某个判据常量的数值
 * 支持 `const NAME = N` 和 `NAME: N` 两种形式
 * @returns {number|null}
 */
export function readConstValue(src, name) {
  // ① 顶层常量
  const m1 = src.match(new RegExp('(?:export\\s+)?const\\s+' + name + '\\s*=\\s*(-?[\\d.]+)'));
  if (m1) return Number(m1[1]);
  // ② 对象属性（后面跟逗号或右括号）
  const m2 = src.match(new RegExp('\\b' + name + '\\s*:\\s*(-?[\\d.]+)\\s*[,}]'));
  if (m2) return Number(m2[1]);
  return null;
}

/**
 * 自动修复可证明的基线损坏
 *
 * ⚠ 2026-11-12 加：为什么敢自动修
 *
 *   实测循环：机制体检跑破坏性验证 → 某次 600s 超时被 kill → restore 没跑
 *            → 派单.mjs 的 MIN_EVIDENCE_LEN 留在 1
 *            → 下次跑提交前体检/机制体检都报红
 *            → 而人（我）每次都要手工改回来，改了几次还是会再发生
 *
 *   关键判断：这些值的**正确值是已知的、唯一的**（写在 SOURCE_BASELINE 里），
 *            而且它们只会被 break() 改成**特定值**（1/96/90/80/{30,}）。
 *            所以「当前值 != 预期值」这一个条件就足以判定是损坏，不是正常改动。
 *
 *   唯一的风险：如果将来有人**有意**改这些阈值，自动修复会把它改回去。
 *   缓解：① 打印明明白白「我改了什么」，让人能看见
 *        ② 只有当「当前值是已知损坏值」时才修（不是「任何不等于预期」）
 *        ③ 提供 --no-autofix 关闭
 *
 * @returns {{fixed: string[], problems: string[]}}
 */
export function autofixSourceBaseline() {
  // 已知的损坏值（break() 会写进去的那些，加上常见的手误值）
  const KNOWN_BROKEN = {
    MIN_EVIDENCE_LEN: [1, 2, 3, 5, 10],
    WARN_PCT: [96, 95.5, 100, 0],
    STOP_PCT: [90, 91, 100, 0],
    LOAD_MAX_PCT: [80, 85, 100, 0],
  };
  const KNOWN_BROKEN_PATTERN = ['token=\\(\\[A-Za-z0-9_-\\]\\{30,\\}\\)'];

  const fixed = [];
  const problems = [];

  for (const b of SOURCE_BASELINE) {
    const p = path.join(TOOLS, b.file);
    if (!fs.existsSync(p)) continue;
    let src = fs.readFileSync(p, 'utf8');
    let changed = false;

    for (const e of b.expect) {
      const v = readConstValue(src, e.name);
      if (v === null || v === e.value) continue;
      const broken = KNOWN_BROKEN[e.name] || [];
      if (!broken.includes(v)) {
        problems.push(b.file + ' 的 ' + e.name + ' = ' + v +
          '（应为 ' + e.value + '，但不是已知损坏值，不敢自动修）');
        continue;
      }
      // 修复：把 `NAME: v,` 或 `const NAME = v;` 改成预期值
      const re1 = new RegExp('(\\b' + e.name + '\\s*:\\s*)(-?[\\d.]+)(\\s*[,}])');
      const re2 = new RegExp('((?:export\\s+)?const\\s+' + e.name + '\\s*=\\s*)(-?[\\d.]+)');
      if (re1.test(src)) {
        src = src.replace(re1, '$1' + e.value + '$3');
        changed = true;
      } else if (re2.test(src)) {
        src = src.replace(re2, '$1' + e.value);
        changed = true;
      }
      if (changed) fixed.push(b.file + ' 的 ' + e.name + '：' + v + ' → ' + e.value);
    }

    // 正则类
    if (b.pattern) {
      for (const bp of KNOWN_BROKEN_PATTERN) {
        if (src.includes(bp.replace(/\\\\/g, '\\'))) {
          // 把 {30,} 改回 {20,}
          const before = src;
          src = src.replace(/token=\(\[A-Za-z0-9_-\]\{30,\}\)/, 'token=([A-Za-z0-9_-]{20,})');
          if (src !== before) {
            changed = true;
            fixed.push(b.file + ' 的 token 正则：{30,} → {20,}');
          }
        }
      }
    }

    if (changed) fs.writeFileSync(p, src, 'utf8');
  }

  return { fixed, problems };
}

/**
 * 拍快照（供 main() 调用，静默版，同步）
 * @returns {{dir:string, count:number}|null}
 */
export function takeSnapshotQuiet() {
  const SNAP_ROOT = path.join(DATA, '破坏性验证快照');
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const name = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const dir = path.join(SNAP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });

  // 监视清单：破坏性验证会碰的文件（与 破坏性验证备份.mjs 的 WATCHED 一致）
  const WATCHED = [
    ['WB', '工具/派单.mjs'], ['WB', '工具/负载闸.mjs'],
    ['WB', '工具/硬规矩.mjs'], ['WB', '工具/中枢代写.mjs'],
    ['WB', '工具/机制体检.mjs'],
    ['WB', '外壳/ui/panels/main-agent.js'],
    ['WB', '外壳/scenarios/arch-review.json'], ['WB', '外壳/scenarios/hub.json'],
    ['DATA', 'skills/research/SKILL.md'],
    ['DATA', '产物契约.json'], ['DATA', '场景层级.yaml'],
    ['DATA', '偏好记忆/偏好.yaml'],
    ['DATA', '场景记忆/_共享记忆/派单台账.json'],
    ['DATA', '场景记忆/_共享记忆/健康度.json'],
    ['DATA', '场景记忆/_共享记忆/进化台账.json'],
    ['DATA', '场景记忆/_共享记忆/身份索引.json'],
    ['DATA', '场景记忆/_共享记忆/_跨场景通知.md'],
    ['DATA', '场景互问/问答.json'],
    ['DATA', '场景注入/hub/AGENTS.local.md'],
    ['DATA', '场景记忆/中枢/AGENTS.local.md'],
    ['DATA', '场景记忆/架构梳理/身份卡.md'],
    ['DATA', '场景记忆/架构梳理/场景私有记忆.md'],
    ['DATA', '场景记忆/调研/场景私有记忆.md'],
    ['DATA', '场景记忆/调研/身份卡.md'],
    ['DATA', '场景记忆/调研/AGENTS.local.md'],
  ];

  const manifest = { at: new Date().toISOString(), files: [] };
  let count = 0;
  for (const [root, rel] of WATCHED) {
    const full = root === 'WB' ? path.join(WB, rel) : path.join(DATA, rel);
    const key = (root + ':' + rel).replace(/[:/\\]/g, '_');
    if (!fs.existsSync(full)) {
      manifest.files.push({ root, rel, missing: true });
      continue;
    }
    const buf = fs.readFileSync(full);
    fs.writeFileSync(path.join(dir, key), buf);
    manifest.files.push({
      root, rel, key,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    });
    count++;
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // ⚠ 2026-11-12 加：轮转，防止快照无限增长（每个约 0.26MB）
  try {
    const MAX = 5;
    const all = fs.readdirSync(SNAP_ROOT).filter((x) => /^\d{8}-\d{6}$/.test(x)).sort();
    while (all.length > MAX) {
      const old = all.shift();
      try { fs.rmSync(path.join(SNAP_ROOT, old), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return { dir, count };
}

/**
 * 对比快照时忽略的「易变字段」
 *
 * ⚠ 2026-11-12 加（快照判据太严格导致假警报）
 *
 *   实测：每次跑完破坏性验证，「派单台账.json」和「健康度.json」都报不一致。
 *        逐字符对比后发现**数据内容完全一致**，只是时间戳被重写：
 *          · 派单台账：ackedAt 10:58:54 → 12:32:25
 *          · 健康度：window.from/to 和 _at 都是重新生成的时间
 *
 *   原因：健康度计算 会重新计算窗口并写入当前时间，
 *        派单闭环验证 会重写它自己测试单的时间戳 —— 这些是**正常行为**。
 *
 *   修法：这类文件的对比改成「结构化对比 + 忽略易变字段」，
 *        而不是逐字节 hash。否则每次跑都报假不一致，
 *        人会习惯性忽略这个警报，那它就废了。
 */
export const VOLATILE_FIELDS = ['_at', 'at', 'ackedAt', 'deliveredAt', 'closedAt',
  'createdAt', 'updatedAt', 'cancelledAt', 'answeredAt',
  // 健康度的统计窗口：每次重算都是「过去 7 天」，边界必然变
  'from', 'to', 'generatedAt', 'computedAt', 'asOf'];

/** 文件是否应该用「结构化对比」而不是 hash 对比 */
export const STRUCTURED_COMPARE = [/台账\.json$/, /健康度\.json$/, /进化台账\.json$/];

/**
 * 结构化对比两个 JSON，忽略易变字段
 * @returns {string[]} 差异描述（空数组 = 内容一致）
 */
export function diffJsonIgnoringTimestamps(aText, bText) {
  let a, b;
  try { a = JSON.parse(aText); b = JSON.parse(bText); } catch { return ['JSON 解析失败']; }

  const diffs = [];
  const walk = (x, y, prefix) => {
    if (x === y) return;
    if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') {
      diffs.push(prefix + ': ' + JSON.stringify(x) + ' ≠ ' + JSON.stringify(y));
      return;
    }
    if (Array.isArray(x) !== Array.isArray(y)) {
      diffs.push(prefix + ': 数组/对象类型不同');
      return;
    }
    if (Array.isArray(x)) {
      if (x.length !== y.length) diffs.push(prefix + ': 长度 ' + x.length + ' ≠ ' + y.length);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], prefix + '[' + i + ']');
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) {
      // 忽略易变字段
      if (VOLATILE_FIELDS.includes(k)) continue;
      walk(x[k], y[k], prefix ? prefix + '.' + k : k);
    }
  };
  walk(a, b, '');
  return diffs;
}

/**
 * 对比最新快照，返回不一致的文件
 * @returns {{snapDir:string|null, changed:string[], manifest:any}}
 */
export function diffAgainstSnapshot() {
  const SNAP_ROOT = path.join(DATA, '破坏性验证快照');
  if (!fs.existsSync(SNAP_ROOT)) return { snapDir: null, changed: [], manifest: null };
  const dirs = fs.readdirSync(SNAP_ROOT).filter((x) => /^\d{8}-\d{6}$/.test(x)).sort();
  if (!dirs.length) return { snapDir: null, changed: [], manifest: null };
  const dir = path.join(SNAP_ROOT, dirs[dirs.length - 1]);
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) return { snapDir: dir, changed: [], manifest: null };
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const changed = [];
  for (const f of manifest.files) {
    if (f.missing) continue;
    const full = f.root === 'WB' ? path.join(WB, f.rel) : path.join(DATA, f.rel);
    if (!fs.existsSync(full)) { changed.push(f.rel + '（文件不见了）'); continue; }

    // ⚠ 2026-11-12 修：台账/健康度这类文件用结构化对比（忽略时间戳）
    //
    //   逐字节 hash 会把「时间戳被重写」当成内容变化，每次跑都报假不一致。
    //   实测：派单台账的 ackedAt、健康度的 window.from/to 每次都会被重算，
    //        但数据内容完全一致。假警报会让人习惯性忽略，那它就废了。
    const isStructured = STRUCTURED_COMPARE.some((re) => re.test(f.rel));
    if (isStructured) {
      const snapText = fs.readFileSync(path.join(dir, f.key), 'utf8');
      const curText = fs.readFileSync(full, 'utf8');
      const diffs = diffJsonIgnoringTimestamps(snapText, curText);
      if (diffs.length) {
        changed.push(f.rel + '（内容差异 ' + diffs.length + ' 处：' +
          diffs.slice(0, 2).join('; ').slice(0, 100) + '）');
      }
      continue;
    }

    const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (h !== f.sha256) changed.push(f.rel);
  }
  return { snapDir: dir, changed, manifest };
}

/**
 * 校验源文件基线
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkSourceBaseline() {
  const problems = [];
  for (const b of SOURCE_BASELINE) {
    if (!b.expect.length && !b.pattern) continue;
    const p = path.join(TOOLS, b.file);
    if (!fs.existsSync(p)) { problems.push(b.file + ' 不存在'); continue; }
    const src = fs.readFileSync(p, 'utf8');

    for (const e of b.expect) {
      const v = readConstValue(src, e.name);
      if (v === null) {
        problems.push(b.file + ' 找不到常量 ' + e.name);
        continue;
      }
      if (v !== e.value) {
        problems.push(b.file + ' 的 ' + e.name + ' = ' + v +
          '（应为 ' + e.value + '）—— ' + b.why);
      }
    }

    if (b.pattern) {
      if (!new RegExp(b.pattern.re).test(src)) {
        problems.push(b.file + ' 的 ' + b.pattern.desc + ' 不成立 —— ' + b.why);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 已知的「追加式残留」标记
 *
 * ⚠ 2026-11-12 加：
 *   有些用例的破坏方式是「往真实文件末尾追加一段」，靠 restore 整体回写恢复。
 *   进程被中断时，追加的那段就留在真实文件里，且**不会**被 STALE_PATTERNS 发现
 *   （因为原文件本来就存在）。
 *
 *   实测：内容哨兵用例往 架构梳理/身份卡.md 追加了「## 待明确\n\n（待明确）」，
 *        上次中断后残留 → 内容哨兵一直报「身份卡是模板」，
 *        而这个检查本身是对的。身份卡看起来像被截断，实际是尾部多了垃圾。
 *
 *   这些标记必须是**只有破坏性验证会写**的唯一字符串，否则会误删真实内容。
 */
export const STALE_MARKERS = [
  {
    file: ['场景记忆', '架构梳理', '身份卡.md'],
    marker: '## 待明确\n\n（待明确）',
    case: '内容哨兵',
  },
  {
    // ⚠ 2026-11-12 修：指向会话 cwd 里的真实文件（原为废弃的 场景注入/hub/）
    file: ['场景记忆', '中枢', 'AGENTS.local.md'],
    marker: '派单前请 think step by step 地想一想。',
    case: '中枢调度卡',
  },
  {
    // ⚠ 2026-11-12 加：设计一致性用例往 main-agent.js 追加的探针行
    //
    //   实测事故：这条残留被 `git add -A` 提交进了 HEAD，
    //   于是 设计一致性 报「游离 hex #ABCDEF / 圆角 5px / 间距 7」三项，
    //   而破坏性验证判它「正常=FAIL 破坏后=FAIL」→ 46/47。
    //
    //   根因：restore 靠 break() 返回值，进程被中断就没跑。
    //   修法：把这个标记纳入残留扫描，下次启动就能发现并清理。
    file: ['..', '外壳', 'ui', 'panels', 'main-agent.js'],
    marker: "const __destructiveProbe = 'border-radius:5px;padding:7px;color:#ABCDEF';",
    case: '设计一致性',
    root: 'WB',
  },
];

/** 扫描残留，返回存在的那些 */
export function scanStaleProbes() {
  const found = [];
  for (const p of STALE_PATTERNS) {
    const full = path.join(DATA, ...p.path);
    if (fs.existsSync(full)) found.push({ full, case: p.case });
  }

  // ⚠ 2026-11-12 加：工具目录里的 zz_* 探针残留
  //
  //   有些用例会往 工具/ 目录里造一个假的检查器（zz_xxx_probe.mjs），
  //   测完靠 restore 删除。进程被中断时它就留下了。
  //
  //   实测后果：检查器可靠性体检 把它当成「真实存在的检查器」扫进去，
  //            报「有问题的检查器: 1 个（zz_decorative_probe.mjs）」，
  //            而这个检查本身是对的 —— 它抓的确实是个装饰检查，
  //            只是那个文件不该存在。
  try {
    for (const f of fs.readdirSync(TOOLS)) {
      if (!/^zz_/.test(f)) continue;
      found.push({ full: path.join(TOOLS, f), case: '破坏性验证探针（工具目录）' });
    }
  } catch { /* ignore */ }

  // 追加式残留
  for (const m of STALE_MARKERS) {
    // ⚠ 2026-11-12 加 root 支持：有些残留写在 WB 下（如 外壳/ui/panels/main-agent.js），
    //   不是 DATA 下。默认 DATA，m.root === 'WB' 时用 WB。
    const base = m.root === 'WB' ? WB : DATA;
    const full = m.root === 'WB' ? path.join(WB, ...m.file.slice(1)) : path.join(base, ...m.file);
    try {
      const c = fs.readFileSync(full, 'utf8');
      if (c.includes(m.marker)) {
        found.push({ full, case: m.case, appendMarker: m.marker });
      }
    } catch { /* 文件不存在就跳过 */ }
  }

  // ⚠ 2026-11-12 加：台账里的残留测试单
  //
  //   有些用例会「建一条派单」，靠 restore 整体回写台账来清理。
  //   如果进程被中断，那条单就留在台账里，且是 created 状态（非终态）：
  //     · 归因工具报「哪类交付总要返工」「有多少派单没回执」
  //     · 进度判定报「打转：重复派单」
  //     · 破坏性验证自己的「归因完整性」用例正常状态就红（无法判断）
  //
  //   实测：d-20261112-004 等多条「闭环验证-完整四件套」created 状态残留。
  try {
    const ledgerPath = path.join(DATA, '场景记忆', '_共享记忆', '派单台账.json');
    if (fs.existsSync(ledgerPath)) {
      const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const TERMINAL = new Set(['acked', 'closed', 'cancelled']);
      const staleDispatches = (j.dispatches || []).filter(
        (d) => !TERMINAL.has(d.state) && String(d.subject || '').startsWith('闭环验证')
      );
      if (staleDispatches.length) {
        found.push({
          full: ledgerPath,
          case: '派单闭环 / 自动回执（台账残留测试单）',
          staleDispatches: staleDispatches.map((d) => d.id + ' ' + String(d.subject || '').slice(0, 30)),
          ledgerPath,
        });
      }
    }
  } catch { /* ignore */ }

  return found;
}

/** 清理残留（--clean-stale 用） */
export function cleanStaleProbes() {
  const found = scanStaleProbes();
  const cleaned = [];
  for (const s of found) {
    if (s.staleDispatches) {
      // 台账残留：作废，不删除（保留审计痕迹）
      try {
        const j = JSON.parse(fs.readFileSync(s.ledgerPath, 'utf8'));
        const TERMINAL = new Set(['acked', 'closed', 'cancelled']);
        let n = 0;
        for (const d of j.dispatches || []) {
          if (TERMINAL.has(d.state)) continue;
          if (!String(d.subject || '').startsWith('闭环验证')) continue;
          d.state = 'cancelled';
          d.cancelledAt = new Date().toISOString();
          d.cancelReason = '破坏性验证用例造单后未清理的残留（--clean-stale）';
          n++;
        }
        fs.writeFileSync(s.ledgerPath, JSON.stringify(j, null, 2), 'utf8');
        cleaned.push({ what: '台账残留测试单', n, path: s.ledgerPath });
      } catch { /* ignore */ }
    } else if (s.appendMarker) {
      // 追加式残留：精确删掉那段标记（不整体回写，避免覆盖期间的真实改动）
      try {
        const c = fs.readFileSync(s.full, 'utf8');
        const i0 = c.indexOf(s.appendMarker);
        if (i0 >= 0) {
          const before = c.slice(0, i0).replace(/\n+$/, '\n');
          fs.writeFileSync(s.full, before, 'utf8');
          cleaned.push({ what: '追加式残留', path: s.full });
        }
      } catch { /* ignore */ }
    } else {
      try {
        fs.unlinkSync(s.full);
        cleaned.push({ what: '探针文件', path: s.full });
      } catch { /* ignore */ }
    }
  }
  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const only = val('only', null);
  const cases = only ? CASES.filter((c) => c.name === only || c.file === only) : CASES;

  console.log('='.repeat(80));
  console.log('  破坏性验证 —— 检查器在系统真坏时会不会失败');
  console.log('='.repeat(80));
  console.log();
  console.log('  方法：人为制造该发现的问题，看检查器是否失败。');
  console.log('        能失败 = 真检查；仍然通过 = 装饰。');
  console.log();

  // ⚠ 2026-11-12 加：跑之前先查源文件基线
  //
  //   真实事故：派单.mjs 的 MIN_EVIDENCE_LEN 被上次中断的运行留在 1，
  //   然后被 git add -A 提交，导致「好了」空话回执能过闸好几天没人发现。
  //
  //   现在：先尝试自动修复**已知损坏值**（只修能证明是 break() 写的那些），
  //        修不了才拒绝继续。
  // ⚠ 2026-11-13 修（顺序反了：先拍快照 → 后查残留 → 快照把污染固化了）
  //
  //   原来：L1950 拍快照，L1983 才查上次残留。
  //   实测后果（这轮踩到的）：
  //     · 上次跑留下 main-agent.js 的探针（__destructiveProbe）
  //     · 这次跑：先拍快照 → 快照里**带着探针**
  //     · 跑完对比 → 「restore 干净」（因为跟带探针的快照一致）
  //     · 但实际文件里探针还在 → 设计一致性永远红
  //   这就是「快照污染」：快照本来是干净基准，却被污染成了新基准。
  //
  //   修法：**先清残留，再拍快照**。
  //        清残留是幂等的（没有残留就什么也不做），先做没有副作用。

  // ① 先清上次残留
  const stalePre = scanStaleProbes();
  if (stalePre.length && !has('no-clean-stale')) {
    console.log('  ⚠ 发现上次运行残留，先清理（否则快照会把污染固化）：');
    try {
      const cleaned = cleanStaleProbes();
      console.log('    已清理 ' + (Array.isArray(cleaned) ? cleaned.length : stalePre.length) + ' 处');
    } catch { /* ignore */ }
    console.log();
  }

  // ② 再拍快照（此时状态是干净的）
  let snapDir = null;
  if (!has('no-snapshot')) {
    try {
      snapDir = takeSnapshotQuiet();
      if (snapDir) console.log('  （已快照 ' + snapDir.count + ' 个受影响的文件到 ' +
        path.basename(snapDir.dir) + '）');
      console.log();
    } catch { /* fail-open：快照失败不阻断验证 */ }
  }

  let baseline = checkSourceBaseline();
  if (!baseline.ok && !has('no-autofix')) {
    const fix = autofixSourceBaseline();
    if (fix.fixed.length) {
      console.log('  ⚠ 上次运行可能被中断，已自动修复源文件基线：');
      for (const f of fix.fixed) console.log('    · ' + f);
      console.log();
    }
    if (fix.problems.length) {
      for (const p of fix.problems) console.log('    XX ' + p);
      console.log();
    }
    baseline = checkSourceBaseline();
  }
  if (!baseline.ok) {
    console.log('  XX 源文件可能被上次中断的运行改坏了（拒绝继续）：');
    for (const p of baseline.problems) console.log('    · ' + p);
    console.log();
    console.log('  先恢复正确的值（可用 git diff 对比 HEAD 看改了什么）：');
    console.log('    git diff -- workbench/工具/');
    console.log();
    process.exitCode = 1;
    return;
  }

  // ⚠ 2026-11-12 加：跑之前先查上次残留
  const stale = scanStaleProbes();
  if (stale.length) {
    console.log('  ⚠ 发现上次运行残留（上次可能被中断）：');
    for (const s of stale) {
      if (s.staleDispatches) {
        console.log('    · 台账里的残留测试单（来自用例「' + s.case + '」）：');
        for (const d of s.staleDispatches) console.log('        ' + d);
      } else if (s.appendMarker) {
        console.log('    · ' + path.relative(DATA, s.full) +
          '  末尾多了「' + s.appendMarker.split('\n')[0] + '」（来自用例「' + s.case + '」）');
      } else {
        console.log('    · ' + path.relative(DATA, s.full) + '  （来自用例「' + s.case + '」）');
      }
    }
    console.log();
    console.log('    这些不是真实数据，会干扰其他检查（文档体检报「漏登记」/');
    console.log('    归因报「哪类交付总要返工」「有多少派单没回执」）。');
    if (has('clean-stale')) {
      const cleaned = cleanStaleProbes();
      for (const c of cleaned) {
        if (c.what === '台账残留测试单') {
          console.log('    ✓ 已作废台账残留测试单 ' + c.n + ' 条');
        } else if (c.what === '追加式残留') {
          console.log('    ✓ 已删掉追加段：' + path.relative(DATA, c.path));
        } else {
          console.log('    ✓ 已删除探针文件：' + path.relative(DATA, c.path));
        }
      }
      console.log();
    } else {
      console.log('    清理：node 工具/破坏性验证.mjs --clean-stale');
      console.log();
    }
  }

  let good = 0;
  const bad = [];

  for (const t of cases) {
    // ① 正常时应该通过
    const before = run(t.file, t.args);
    const beforeOk = before.code === 0;

    // ② 制造破坏
    let restore = null;
    try { restore = t.break(); } catch { restore = null; }
    if (!restore) {
      // ⚠ 2026-11-12 修（判据漏洞：「跳过」不该静默拉低分母）
      //
      //   原来：console.log('?? ' + name + ' 无法制造破坏（跳过）'); continue;
      //         —— 既不 ++good，也不 push 到 bad，也不设 exitCode。
      //
      //   实测后果：身份签名 用例因「调研身份卡 ## 我是谁 段本来就是空的」
      //            无法制造破坏 → 跳过 → 统计出 46/47，
      //            但因为 bad 为空，打印「✓ 全部能证伪」且 exit 0。
      //            **既不是通过也不是失败，结论自相矛盾。**
      //
      //   而那个「该小节本来就是空的」其实是真实缺陷
      //   （身份卡内容缺失，身份签名 --check 直接报错）。
      //   「无法制造破坏」往往意味着**前置状态本身就不对**。
      //
      //   修法：`break()` 返回 null 时必须记为**失败**，并明确指出
      //        「无法制造破坏」本身就是一个需要查的信号。
      const skipReason = 'break() 返回 null（前置状态不对，无法制造破坏）';
      console.log('  XX ' + t.name.padEnd(20) + ' ' + skipReason);
      console.log('        → 这通常意味着该检查的前置状态本身就有问题，');
      console.log('          不是「测不了」而是「该查」');
      bad.push({ name: t.name, beforeOk, afterFail: false, skipped: true });
      continue;
    }

    // ③ 破坏后应该失败
    let after;
    try { after = run(t.file, t.args); } finally { restore(); }

    const afterFail = after.code !== 0;
    const pass = beforeOk && afterFail;

    console.log('  ' + (pass ? 'OK ' : 'XX ') + t.name.padEnd(20) +
      ' 正常=' + (beforeOk ? 'PASS' : 'FAIL') +
      '  破坏后=' + (afterFail ? 'FAIL' : 'PASS（装饰！）'));

    if (pass) good++;
    else {
      bad.push({ name: t.name, beforeOk, afterFail });
      if (!beforeOk) console.log('        ⚠ 正常状态下就失败，无法判断');
      if (!afterFail) {
        console.log('        ⚠ **破坏后仍然通过** —— 这个检查抓不到该抓的问题');
        console.log('        输出尾部: ' + after.out.split('\n').slice(-3).join(' | ').slice(0, 160));
      }
    }
  }

  console.log();
  console.log('-'.repeat(80));
  console.log('  能证伪的检查: ' + good + ' / ' + cases.length);
  if (bad.length) {
    console.log('  抓不到问题的检查: ' + bad.map((b) => b.name).join(', '));
    process.exitCode = 1;
  } else {
    console.log('  ✓ 全部能证伪');
  }

  // ⚠ 2026-11-12 加：跑完对比快照，看 restore 是否干净
  //
  //   实测：每次跑完都有 2 个台账文件与快照不一致
  //        （派单台账.json / 健康度.json）——
  //        它们的 restore 不完整，残留会导致归因/健康哨兵报假异常。
  //
  // ⚠ 2026-11-13 改：从「只报告」改成「自动恢复 + 报告」
  //
  //   原来：只打印「不一致」+ 提示用户手动跑 --restore --apply，
  //        然后 process.exitCode = 1。
  //
  //   实测后果（这轮踩到的）：
  //     · 跑机制体检 → 破坏性验证留下 main-agent.js 的探针 →
  //       设计一致性报「游离 hex #ABCDEF」→ 机制体检红
  //     · 再跑一次机制体检 → 又留一次 → 又红
  //     残留反复出现，每轮都要手动 --clean-stale，这就是「手动跑等于没跑」。
  //
  //   现在：发现不一致就**自己恢复**，恢复完再报「曾经不一致但已自动修好」。
  //        理由：快照里存的就是干净状态，恢复它永远是安全的；
  //        让调用方（机制体检/目标验收）拿到一个干净的环境，
  //        比让它自己去收拾残局更合理。
  if (snapDir && !has('no-snapshot')) {
    try {
      const diff = diffAgainstSnapshot();
      if (diff.changed.length) {
        console.log();
        console.log('  ⚠ 跑完后有 ' + diff.changed.length + ' 个文件与快照不一致：');
        for (const c of diff.changed) console.log('     · ' + c);

        // 自动恢复（快照即干净状态，恢复总是安全的）
        //
        // ⚠ 用 subprocess 调用而不是 import ——
        //   备份工具的 doRestore/doSnapshot 是内部函数，没导出。
        //   与其为了这次改动去改它的导出（会牵动它的自测），
        //   不如走 CLI（它本来就提供 --restore --apply）。
        let restored = 0;
        try {
          const out = execFileSync(process.execPath, [
            path.join(HERE, '破坏性验证备份.mjs'), '--restore', '--apply',
          ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
          const m = out.match(/已恢复\s*(\d+)\s*个文件/);
          restored = m ? Number(m[1]) : 0;
        } catch { /* ignore */ }

        const after = diffAgainstSnapshot();
        console.log();
        if (after.changed.length === 0) {
          console.log('  ✓ 已自动恢复 ' + restored + ' 个文件（现在与快照一致）');
          console.log('    残留来源：某些用例的 restore() 在中断时没跑到；');
          console.log('    这里用跑前快照兜底，保证调用方拿到干净环境。');
        } else {
          console.log('  XX 自动恢复后仍有 ' + after.changed.length + ' 个不一致：');
          for (const c of after.changed) console.log('     · ' + c);
          console.log('  手动：node 工具/破坏性验证备份.mjs --restore --apply');
          process.exitCode = 1;
        }
      } else {
        console.log('  ✓ 跑完后所有监视文件与快照一致（restore 干净）');
      }
    } catch { /* fail-open */ }
  }

  console.log('='.repeat(80));
}

// ⚠ 2026-11-12 加 isMain 守卫
//
//   问题：这个文件原来无条件调用 main()，于是**别的工具 import 它的判据时
//        （如 提交前体检 要 import checkSourceBaseline），会把整套破坏性验证
//        跑一遍** —— 判据没法复用，而且会真的去改源文件/造探针。
//
//   实测：提交前体检 import 之后，跑一次它输出了两遍
//        「XX 源文件可能被上次中断的运行改坏了」——
//        一遍来自破坏性验证自己的 main()，一遍来自提交前体检。
//
//   修法：只有直接运行本文件才跑 main()。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
