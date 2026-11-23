/**
 * 给每个场景生成 AGENTS.local.md —— 让 AI 真正读到场景身份与记忆
 *
 * ══════════════════════════════════════════════════════════════
 *  修的是什么断层（方案/114 断层 1）
 * ══════════════════════════════════════════════════════════════
 *
 *  现状：
 *    scenarios/arch-review-context.md  （1.5 KB 定位卡）← 躺在那，AI 读不到
 *    数据/.dsh/场景记忆/架构梳理/场景私有记忆.md       ← 同样读不到
 *
 *  为什么读不到：
 *    会话 cwd = HARNESS_DIR（数据目录）
 *    引擎 dsh-agent-instructions 只读 cwd 及 projectRoot 下的 AGENTS.md
 *    所以 9 个场景共用同一份 AGENTS.md，AI 不知道自己是哪个场景
 *
 *  修法（依据引擎源码）：
 *    dsh-agent-instructions 的 DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES
 *      = ["AGENTS.local.md", "CLAUDE.local.md"]
 *    local 文件优先级高于 AGENTS.md，且不在场地地图 A 档内
 *
 *    → 给每个场景在工作目录放一份 AGENTS.local.md
 *    → 内容 = 定位卡 + 身份卡 + 私有记忆(§〇交接/§五坑) + 共享铁律摘要
 *
 * ══════════════════════════════════════════════════════════════
 *  关键设计：注入体积必须受控
 * ══════════════════════════════════════════════════════════════
 *
 *  调研指出：每轮对话都要付注入成本。
 *  所以这份文件必须精简 —— 只放「不读就会白干」的内容。
 *
 *  预算：≤ 2048 B（和 AGENTS.md 同口径）
 *  策略：
 *    · 定位卡：只取「身份与职责」+「不碰什么」
 *    · 身份卡：全文（通常很短）
 *    · 私有记忆：只取 §〇 当前交接 + §五 坑与决策最后 3 条
 *    · 共享：只提 AGENTS.md 存在，不复制内容（避免重复计费）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneNameMap } from './_场景清单.mjs';
import { loadPrefs, buildPrefInjection } from './偏好记忆.mjs';
import { buildPersonaInjection } from './场景人格.mjs';
import { buildPortrait } from './场景画像.mjs';
import { buildSignature } from './身份.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const MEM_ROOT = path.join(WB, '数据', '.dsh', '场景记忆');
const OUT_DIR = path.join(WB, '数据', '.dsh', '场景注入');

// ⚠ 2026-11-12 从 3000 提高到 3400
//
//   实测：平均已占 2980B / 预算 3000B，完全饱和。
//        于是 MUST_KEEP 之外的小节全靠「谁的顺序靠前」侥幸活下来 ——
//        「## 命令执行目录」和「## 管线位置」都因此被整节丢弃或截断：
//          · 逆向分析：命令执行目录整节没了
//          · 实施计划：内容截到 `c`（`cd` 都截断）
//        修完后命令可执行体检从 7/9 → 9/9。
//
//   3400 的依据：把这两个「稳定前提信息」小节完整保下来需要约 +400B。
//        它们不是可省的内容 —— 缺了它们，AI 会照抄跑不通的命令、不知道等上游。
//
//   代价：每轮多付约 400B（≈130 token）。相比「命令全跑不通」的损失，
//        这个代价是值得的。
const BUDGET = 3400;   // 2026-11-12 从 3000 提高：管线位置 + 命令执行目录两节必须完整   // 2026-11-11 从 2560 提高：加场景画像摘要后不够   // 2026-11-10 从 2048 提高：加偏好注入后原预算不够

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** 从 markdown 里抽某一节的正文 */
function extractSection(md, startMarker, endMarkers) {
  if (!md) return '';
  const i = md.indexOf(startMarker);
  if (i < 0) return '';
  let end = md.length;
  for (const m of endMarkers) {
    const j = md.indexOf(m, i + startMarker.length);
    if (j > i && j < end) end = j;
  }
  return md.slice(i, end).trim();
}

/** 截断到指定字节数 */
/**
 * 按字节截断，但**保留末尾的关键段落**
 *
 * ⚠ 2026-11-10 重写（发现的关键缺陷）
 *
 *  原实现是「从末尾砍」，结果：
 *    加了偏好注入后，本地电脑 100% 满预算，
 *    被砍掉的正好是末尾的「我的偏好」段
 *    —— 那是我刚接入的、最重要的一段。
 *
 *  根本问题：注入文件的内容有重要性差异，
 *  但截断是「一刀切从头保留」。
 *
 *  修法：
 *    ① 找出「必须保留」的段落（按 ## 标题识别）
 *    ② 优先保证它们完整
 *    ③ 剩下的空间给其他段落
 *    ④ 如果必须砍，砍「可牺牲」段落
 *
 *  必须保留的段落（按优先级）：
 *    - 做完之后必须做的事（不写记忆 = 白干）
 *    - 我的偏好（用户红线）
 *    - 全局铁律
 */
function clampBytes(s, max) {
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= max) return s;

  // 关键段落标记（必须保留）
  const MUST_KEEP = [
  '## 做完之后必须做的事',
  '## 我的偏好',
  '## 我的界面',   // 2026-11-11 加：场景画像摘要，AI 靠它知道自己能改什么
  '## 全局铁律',
  // ⚠ 2026-11-12 加：「管线位置」必须保留
  //
  //   实测事故：9 个场景里只有「调研」的 AGENTS.local.md 有「## 管线位置」，
  //            其余 8 个全都没有 —— 而诊断显示 5 个场景都有管线数据
  //            （架构梳理 ups=5 downs=2、实施计划 ups=2、竞品拆解 ups=1 downs=1 …）。
  //
  //   根因：这个函数在超预算时按 MUST_KEEP 优先保留、其余段**从后往前丢弃**。
  //        「## 管线位置」不在 MUST_KEEP 里，于是被丢掉。
  //        而调研是唯一「管线位置在文件靠前、还没超预算就写完了」的场景。
  //
  //   后果：第 14 轮加的「管线位置进固定注入层」修复只对 1 个场景生效。
  //        实施计划的上游输入（architecture-plan / risk-list）AI 根本看不到
  //        → 封存集「上游输入有哪些？」那 6 道题全错 → 注入效果只有 65%。
  //
  //   为什么它必须保留：管线位置是**稳定的前提信息**（该等谁、该给谁），
  //        不是「可能相关」的记忆。缺了它，AI 不知道该等上游就绪再动手。
  '## 管线位置',
  // ⚠ 2026-11-12 加：「命令执行目录」也必须保留
  //
  //   实测事故：这个函数超预算时按 MUST_KEEP 保留、其余段从后往前丢弃。
  //            「## 命令执行目录」不在 MUST_KEEP 里 ——
  //            · 逆向分析：整节被丢掉（AGENTS.local.md 里完全没有）
  //            · 实施计划：节被保住了，但内容只截到 `c`（`cd` 都截断了）
  //
  //   后果：命令可执行体检报「7 / 9 个场景有保障」，
  //        那两个场景的 AI 又会照抄技能命令然后 Cannot find module。
  //
  //   为什么它必须保留：这节告诉 AI「工具在项目根，命令要先 cd」。
  //        缺了它，技能里 18 处命令一条都跑不通 —— 这是第 14 轮查出的最深缺陷。
  '## 命令执行目录',
];

  // 按 ## 切段
  const lines = s.split('\n');
  const blocks = [];
  let cur = { title: '', lines: [] };
  for (const line of lines) {
    if (/^##\s/.test(line) && cur.lines.length > 0) {
      blocks.push(cur);
      cur = { title: line.trim(), lines: [line] };
    } else {
      if (!cur.title && /^##\s/.test(line)) cur.title = line.trim();
      cur.lines.push(line);
    }
  }
  if (cur.lines.length > 0) blocks.push(cur);

  const mustBlocks = blocks.filter((b) => MUST_KEEP.some((m) => b.title.startsWith(m)));
  const otherBlocks = blocks.filter((b) => !MUST_KEEP.some((m) => b.title.startsWith(m)));

  // 先放必须保留的
  const kept = [];
  let used = 0;
  for (const b of mustBlocks) {
    const t = b.lines.join('\n');
    const sz = Buffer.byteLength(t, 'utf8') + 1;
    kept.push(t);
    used += sz;
  }

  // 剩余空间给其他段（按原顺序）
  for (const b of otherBlocks) {
    const t = b.lines.join('\n');
    const sz = Buffer.byteLength(t, 'utf8') + 1;
    if (used + sz > max - 30) {
      // 这一段放不下：尽量塞一部分
      const remain = max - used - 30;
      if (remain > 100) {
        let part = '';
        for (const ch of t) {
          if (Buffer.byteLength(part + ch, 'utf8') > remain) break;
          part += ch;
        }
        kept.push(part + '\n…');
        used += Buffer.byteLength(part, 'utf8');
      }
      break;
    }
    kept.push(t);
    used += sz;
  }

  return kept.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  生成一个场景的注入文件
// ══════════════════════════════════════════════════════════════
function buildSceneAgents(sceneJson) {
  const id = sceneJson.id;
  const name = sceneJson.name || id;

  const L = [];

  // ── 头：明确身份（这句话最重要，让 AI 知道自己在哪）──
  L.push('# 当前场景：' + name);
  L.push('');
  L.push('> 你正在「' + name + '」这个场景里工作。');
  L.push('> 下面的约束是这个场景的**边界**，不是建议。');
  L.push('');

  // ⚠ 2026-11-12 加：命令执行目录说明（架构级缺陷修复）
  //
  //   问题：技能文件里写的命令全是相对路径 `node 工具/派单.mjs`，
  //        而场景会话的 cwd 是 `数据/.dsh/场景记忆/<场景>/`。
  //        从那里解析 → `<cwd>/工具/派单.mjs` → 不存在
  //        → 场景 AI 照抄技能里的命令，100% 报 Cannot find module。
  //
  //   实测：技能里 18 处命令，4 种工具，从场景 cwd 全部找不到；
  //        从项目根都能找到。
  //
  //   修法：在 AGENTS.local.md（引擎固定注入层）里明确写出
  //        「你的 cwd 在哪、工具的根在哪、命令要加什么前缀」。
  //        这是唯一能被 AI 稳定读到的位置（不靠检索、不靠它自己猜）。
  const projRoot = path.resolve(WB);
  L.push('## 命令执行目录（照抄技能里的命令前必读）');
  L.push('');
  L.push('你的工作目录是：`' + path.join('数据', '.dsh', '场景记忆', name) + '`');
  L.push('但**工具都在项目根目录下**。技能里写的 `工具/xxx.mjs` 是**相对项目根**的。');
  L.push('');
  L.push('所以执行任何 `工具/xxx.mjs` 命令时，先切到项目根：');
  L.push('');
  L.push('```powershell');
  L.push('cd "' + projRoot + '"');
  L.push('node 工具/派单.mjs --list');
  L.push('```');
  L.push('');
  L.push('或者一步到位（不改 cwd）：');
  L.push('');
  L.push('```powershell');
  L.push('node "' + path.join(projRoot, '工具', '派单.mjs') + '" --list');
  L.push('```');
  L.push('');
  L.push('⚠ 直接在你的工作目录里跑 `工具/xxx.mjs` 会报 `Cannot find module` ——');
  L.push('   那是路径问题，不是工具坏了。');
  L.push('');

  // ── ① 定位卡：身份与职责 + 不碰什么 ──
  const ctxPath = path.join(SCEN_DIR, id + '-context.md');
  const ctxMd = readTextSafe(ctxPath);
  if (ctxMd) {
    const duty = extractSection(ctxMd, '## 一、身份与职责', ['## 二、', '## 三、', '## 四、', '## 五、']);
    if (duty) {
      L.push('## 职责');
      // 去掉标题行本身
      L.push(duty.replace(/^##\s*一、身份与职责\s*/m, '').trim());
      L.push('');
    }

    // 铁律（如果有这一节）
    const rules = extractSection(ctxMd, '## 五、铁律', ['## 六、', '## 七、', '## 八、', '## 九、']);
    if (rules) {
      L.push('## 场景铁律');
      L.push(rules.replace(/^##\s*五、铁律\s*/m, '').trim());
      L.push('');
    }
  }

  // ── ② 身份签名（不是完整身份卡）──
  //
  //  ⚠ 2026-11-11 改造（视频 BV1o4xg6RE9m）
  //
  //  他说：「定位卡是文档，身份卡是工具。
  //       它不需要说我要读很多文章知道自己是谁，
  //       是它出厂就知道自己是个什么东西。」
  //
  //  原来：注入完整身份卡（平均 1005 B），每次会话都付这个成本。
  //  现在：注入身份签名（平均 165 B），省 84%。
  //        需要完整身份卡时，AI 自己调 `node 工具/身份.mjs --whoami <场景>`。
  //
  //  这是「文档 → 工具」的落地：把「每次都要读」变成「需要时才查」。
  const idCard = readTextSafe(path.join(MEM_ROOT, name, '身份卡.md'));
  if (idCard && idCard.trim().length > 20) {
    L.push('## 你的角色（签名）');
    try {
      const sig = buildSignature(name, idCard, sceneJson);
      L.push(sig.signature);
    } catch {
      // fail-open：签名失败就退回截断的完整卡
      L.push(clampBytes(idCard.trim(), 400));
    }
    L.push('');
  }

  // ── ③ 私有记忆：§〇 当前交接（最重要，决定能不能接上上次）──
  const priv = readTextSafe(path.join(MEM_ROOT, name, '场景私有记忆.md'));
  if (priv) {
    // ⚠ 2026-11-12 修（区间提取边界全部写错，导致 §〇 段吞到文件尾）
    //
    //   原来传的结束边界是：['## §一', '## §二', ... '## §八']
    //   但记忆文件里的真实标题是：['## 一、职责边界', '## 二、现状 / 接口', ...]（没有 §）
    //   所以一个都没匹配上 → §〇 段一直延伸到文件末尾。
    //
    //   后果：§〇 之后的「## 五、坑与决策」「## 八、项目索引」
    //        和「## 管线位置（自动生成，勿手改）」全被当成 §〇 内容
    //        → 塞进 AGENTS.local.md 的「## 上次交接」里（clampBytes 700 截断）
    //        → 于是同一个「管线位置」出现两次（一次是这段带进来的，
    //          一次是 ⑤a 自己生成的），且分段逻辑全乱。
    //
    //   实测：逆向分析 / 实施计划 / 竞品拆解 三个场景的 AGENTS.local.md
    //        都有两个「## 管线位置」，内容还不同。
    //
    //   修法：结束边界同时支持 `## §N` 和 `## N、` 两种写法，
    //        并且用「任何 `## ` 开头的非 §〇 标题」作为兜底边界。
    const SEC_END = [
      '## §一', '## §二', '## §三', '## §四', '## §五', '## §六', '## §七', '## §八', '## §九',
      '## 一、', '## 二、', '## 三、', '## 四、', '## 五、', '## 六、', '## 七、', '## 八、', '## 九、',
      '## 核心职责',
      '## 管线位置',   // 自动生成的管线段不算交接内容
    ];
    const handoff = extractSection(priv, '## §〇', SEC_END);
    if (handoff) {
      // 去掉空壳内容
      const cleaned = handoff
        .replace(/^##\s*§〇[^\n]*\n+/, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (cleaned.length > 10 && !/（新场景，还没有交接记录）/.test(cleaned)) {
        L.push('## 上次交接');
        L.push(clampBytes(cleaned, 700));
        L.push('');
      }
    }

    // ── ④ 坑与决策（最后 3 条，最有价值）──
    //   ⚠ 2026-11-12 同步修正边界写法（同上：真实标题是 `## 五、` 不是 `## §五`）
    const pits = extractSection(priv, '## 五、坑与决策',
      ['## 六、', '## 七、', '## 八、', '## 九、', '## §六', '## §七', '## §八', '## §九', '## 管线位置']);
    if (pits) {
      const cleanPits = pits
        .replace(/^##\s*§五[^\n]*\n+/, '')
        .trim();
      // 只取最后 3 个条目
      const items = cleanPits
        .split(/\n(?=[-*]\s|\d+\.\s)/)
        .filter((s) => s.trim().length > 10)
        .slice(-3);
      if (items.length > 0) {
        L.push('## 已踩过的坑（别重复踩）');
        L.push(clampBytes(items.join('\n'), 500));
        L.push('');
      }
    }
  }

  // ── ④a 记忆写回指令（最先放，防截断）──
  //
  //  设计依据（视频 BV1qrxD6qEcY）：
  //    「场景自治：每个场景有自己的身份、记忆、项目；别人只能提醒，不能代写」
  //
  //  所以必须明确告诉场景：你自己的记忆自己写。
  L.push('## 做完之后必须做的事');
  L.push('任务结束时，把**这次学到的**写回本场景私有记忆，只写三段：');
  L.push('- §〇 当前交接 → 这次做到哪、下次接手要做什么');
  L.push('- §五 坑与决策 → 如果踩了坑，追加一条（带日期）');
  L.push('- 不写流水账，只写下次会用到的');
  L.push('记忆文件：`数据/.dsh/场景记忆/' + name + '/场景私有记忆.md`');
  L.push('');

  // ── ④b 偏好注入（六类偏好，来自 工具/偏好记忆.mjs）──
  //
  //  设计依据（视频 BV1H1nU6bEJ5）：
  //    「这套记忆不只记事实，还记偏好。我分六类：交互/工具/文件/协作/安全/记忆」
  //
  //  偏好比事实更不可查：用户不会每次都说「叫我宿主」，
  //  但记错了每次都别扭。所以每次开会话都注入。
  try {
    const prefs = loadPrefs();
    if (prefs.length > 0) {
      const inj = buildPrefInjection(prefs);
      if (inj.items.length > 0) {
        L.push('## 我的偏好（六类）');
        for (const p of inj.items) {
          L.push('- ' + p.text);
        }
        L.push('');
      }
    }
  } catch { /* fail-open：偏好失败不阻断注入 */ }

  // ── ④b 场景人格（同一机主在这个场景的一面）──
  //
  //  设计依据（对标 luanyujia-workbench 的「场景即人的一面」）：
  //
  //    同一个机主，在「故障分析」那里语气是急、烦、事多；
  //    在「调研」这边是松、随手、句子短；
  //    在「自我复盘」那里又认真、愿意说细。
  //
  //    这不是「心情」，是**场景决定了他以哪一面出现**。
  //
  //  「只做分工，AI 就会用一套腔调应对所有事。」
  //
  //  ⚠ 和「我的偏好」的区别：
  //    偏好 = 全局的（用中文 / 不要空话 / 结论先给）
  //    人格 = 分场景的（这个场景回多长、先说啥、别踩什么）
  //
  //  ⚠ 现在这张表是**空的** —— 因为：
  //    ① 参考项目的硬边界：原话必须带日期与出处，无出处即删
  //    ② 我们的历史会话里没有真实用户对话（只有测试探针）
  //    所以没有数据可填。**我不会编造。**
  //    机制位已就绪：一旦有真实记录，这里会自动注入。
  try {
    const persona = buildPersonaInjection(name);
    if (persona) L.push(persona);
  } catch { /* fail-open：人格失败不阻断注入 */ }

  // ── ④c 场景画像摘要（让 AI 知道自己长什么样）──
  //
  //  设计依据（视频 BV1o4xg6RE9m）：
  //    「场景画像就是每一个场景，它知道自己的场景长怎么样。
  //     他知道自己这个长什么样子，他就可以掌控全局。
  //     然后这个时候他就想修改什么地方就可以随意修改。」
  //
  //  ⚠ 关键：**只注入摘要，不注入全文**。
  //    全文画像约 3-4 KB，全量注入会挤爆预算。
  //    摘要只给：面板清单 + 网格 + 一句话「怎么改」。
  //    需要细节时 AI 自己去读 场景画像.md。
  try {
    const sj = JSON.parse(readTextSafe(path.join(SCEN_DIR, id + '.json')) || '{}');
    const pt = buildPortrait(sj);
    if (pt.panelCount > 0) {
      L.push('## 我的界面（场景画像摘要）');
      L.push('网格 ' + pt.grid.cols + '×' + pt.grid.rows + '，' + pt.panelCount + ' 个面板：');
      for (const x of pt.panels) {
        L.push('- \`' + x.id + '\`（' + x.title + '）' + x.typeName +
          ' ' + x.w + '×' + x.h + ' @' + x.col + ',' + x.row +
          (x.canEdit ? '' : ' 🔒固定'));
      }
      L.push('改自己 = 改 \`' + pt.configPath + '\` 的 panels 数组；');
      L.push('细节读 \`数据/.dsh/场景记忆/' + name + '/场景画像.md\`；改前先跑 \`node 工具/回滚.mjs --snapshot --type ui\`。');
      L.push('');
    }
  } catch { /* fail-open：画像失败不阻断注入 */ }

  // ── ⑤a 管线位置（2026-11-12 新增，修「上游产物名检索不到」）──
  //
  //  ⚠ 为什么必须放在固定注入层，而不是靠记忆注入检索：
  //
  //    实测：架构梳理的记忆有 461 个候选条目，管线章节在文件 80% 处，
  //    按话术检索「上游输入有哪些？feature-matrix 是不是？」时，
  //    管线表格标题（**上游（我要等）**）得分只有 0.11，
  //    被「违规 1：场景清单有 4 份」等 0.22 分的条目挤出 top 3。
  //
  //    结果：封存集问「上游输入 feature-matrix 是不是？」，注入内容里没有它
  //    → 架构梳理的答对率只有 50%（30 题只答对 15）。
  //
  //  修法：管线位置是**稳定的前提信息**，不是「可能相关」的记忆，
  //       应该无条件出现在 AGENTS.local.md 里。
  //       而且它很短（上游 3-5 行 + 下游 2 行），几乎不增加 token。
  try {
    const pipeDir = path.join(WB, 'sceneboard', 'pipelines');
    if (fs.existsSync(pipeDir)) {
      const SCENE_CN2ID = {
        '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
        '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
        '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
      };
      const myId = SCENE_CN2ID[name] || id;
      let contract = { artifacts: {} };
      try {
        const cp = JSON.parse(readTextSafe(path.join(WB, '数据', '.dsh', '产物契约.json')) || '{}');
        contract = { artifacts: cp.artifacts || cp };
      } catch { /* ignore */ }

      const ups = [];
      const downs = [];
      // ⚠ 2026-11-14 改：不再硬编码 id→中文名 映射，从 scenarios/*.json 动态读
      //
      //   原来写死 9 个，新增 3 个工坊后没更新
      //   → 生成「管线位置」段时查不到工坊中文名 → 那几条边被跳过
      //   → 实施计划的 AGENTS.local.md 里只有上游没有下游
      const NAMES = sceneNameMap();
      for (const f of fs.readdirSync(pipeDir).filter((x) => x.endsWith('.json'))) {
        let pj;
        try { pj = JSON.parse(readTextSafe(path.join(pipeDir, f)) || '{}'); } catch { continue; }
        for (const e of pj.edges || []) {
          if (e.to === myId) ups.push(e);
          if (e.from === myId) downs.push(e);
        }
      }

      if (ups.length || downs.length) {
        L.push('## 管线位置（该等谁、该给谁）');
        if (ups.length) {
          L.push('**上游（我要等）**');
          for (const e of ups) {
            const ent = contract.artifacts[e.artifact] || {};
            const files = Array.isArray(ent.files) ? ent.files : [];
            L.push('- 来自 ' + (NAMES[e.from] || e.from) + '：产物 `' + e.artifact + '`' +
              (files.length ? ' → 具体文件 ' + files.map((x) => '`' + x + '`').join(' / ') : ''));
          }
        }
        if (downs.length) {
          L.push('**下游（我该给）**');
          for (const e of downs) {
            const ent = contract.artifacts[e.artifact] || {};
            const files = Array.isArray(ent.files) ? ent.files : [];
            L.push('- 给 ' + (NAMES[e.to] || e.to) + '：产物 `' + e.artifact + '`' +
              (files.length ? ' → 具体文件 ' + files.map((x) => '`' + x + '`').join(' / ') : ''));
          }
        }
        L.push('上游没就绪时不要硬做 —— 跑 `node 工具/管线调度.mjs --next` 看现在轮到谁。');
        L.push('');
      }
    }
  } catch { /* fail-open：管线失败不阻断注入 */ }

  // ── ⑤c 中枢调度卡（2026-11-12 新增，修「两个工具争写 AGENTS.local.md」）──
  //
  //  原来：中枢调度卡.mjs 直接写 场景记忆/中枢/AGENTS.local.md，
  //       场景注入.mjs 也写同一个文件 —— 谁最后跑谁说话，内容互相覆盖。
  //
  //  实测后果：中枢的 AGENTS.local.md 只剩 1214B 的名册卡，
  //          丢掉了「职责/场景铁律/签名/已踩过的坑/管线位置/全局铁律」六节，
  //          AI 看不到自己的职责边界和管线位置。
  //
  //  现在：中枢调度卡写独立文件 中枢调度卡.md，
  //       这里把它原样追加进来（只对中枢场景）。
  if (name === '中枢' || id === 'hub') {
    try {
      const cardPath = path.join(MEM, name, '中枢调度卡.md');
      if (fs.existsSync(cardPath)) {
        const cardText = fs.readFileSync(cardPath, 'utf8').trim();
        if (cardText) {
          L.push('## 调度卡（中枢专属）');
          L.push('> 由 `工具/中枢调度卡.mjs` 生成到 `中枢调度卡.md`，这里合并进来。');
          L.push('');
          L.push(cardText);
          L.push('');
        }
      }
    } catch { /* fail-open：合并失败不阻断注入 */ }
  }

  // ── ⑤ 共享铁律：只提存在，不复制内容（避免重复计费）──
  L.push('## 全局铁律');
  L.push('（另见 AGENTS.md，已在你的上下文中。核心：换会话先写 §〇 交接；不跨场景写别人记忆。）');
  L.push('');

  // ── ⑥ 记忆写回指令（修断层 3）──
  //
  //  ⚠ 2026-11-10：这一段必须在「全局铁律」之前，
  //     因为 clampBytes 是截末尾 —— 放在最后会被截掉，
  //     而它恰恰是最不能丢的（丢了场景就不写记忆了）。

  let out = L.join('\n');

  // ── 预算控制 ──
  out = clampBytes(out, BUDGET);

  return { id, name, content: out, bytes: Buffer.byteLength(out, 'utf8') };
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════
const sceneFiles = fs.existsSync(SCEN_DIR)
  ? fs.readdirSync(SCEN_DIR).filter((f) => f.endsWith('.json'))
  : [];

if (sceneFiles.length === 0) {
  console.error('找不到场景配置: ' + SCEN_DIR);
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('═'.repeat(70));
console.log('  生成场景注入文件（AGENTS.local.md）');
console.log('═'.repeat(70));
console.log();
console.log('  预算: ' + BUDGET + ' B / 场景');
console.log();

const results = [];
for (const f of sceneFiles) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    console.log('  ⚠ 跳过（JSON 解析失败）: ' + f);
    continue;
  }
  if (!j.id) continue;

  // ★ 中枢特殊处理：它用专属的调度卡，不套用通用场景模板
  //
  //   为什么（用户原话）：
  //     「主 agent 的功能其实只需要能调度其他场景的 agent 就行了，
  //       所以我觉得可以适当的做的精简点」
  //
  //   通用模板给中枢塞了完整身份卡 + §〇项目详情 + 通用铁律 = 1807 B，
  //   但其中只有不到一半与调度有关。
  //   专属调度卡 930 B（-49%），只保留：派给谁 / 怎么派 / 怎么收 / 边界。
  //
  //   生成器：workbench/工具/中枢调度卡.mjs
  if (j.id === 'hub') {
    console.log('  ⏭  中枢       跳过（用专属调度卡，见 工具/中枢调度卡.mjs）');
    continue;
  }

  const r = buildSceneAgents(j);
  results.push(r);

  const pct = Math.round((r.bytes / BUDGET) * 100);
  const ok = r.bytes <= BUDGET;
  console.log('  ' + (ok ? '✓' : '✗') + '  ' + r.name.padEnd(12) +
    r.bytes + ' B (' + pct + '%)');

  // 写到场景工作目录
  //
  //  ⚠ 2026-11-10 修正（架构不一致，偏好写了但 AI 读不到）
  //
  //  问题：原来是 数据/.dsh/场景注入/<sceneId>/
  //  但「场景工作目录」迁移（方案 A）后，会话 cwd 已改为
  //  数据/.dsh/场景记忆/<场景名>/
  //
  //  结果：注入文件写到了旧目录，AI 根本读不到，
  //        导致刚做好的偏好记忆完全没有生效。
  //
  //  修法：写到会话 cwd 实际所在的目录。
  const sceneWorkDir = path.join(MEM_ROOT, r.name);
  fs.mkdirSync(sceneWorkDir, { recursive: true });
  fs.writeFileSync(path.join(sceneWorkDir, 'AGENTS.local.md'), r.content, 'utf8');
}

console.log();
console.log('─'.repeat(70));
console.log('  已写入: ' + MEM_ROOT + '（会话 cwd）');
console.log('─'.repeat(70));
console.log();

// 预览一个
const sample = results.find((r) => r.id === 'arch-review') || results[0];
if (sample) {
  console.log('示例（' + sample.name + '）:');
  console.log('┌' + '─'.repeat(68) + '┐');
  sample.content.split('\n').slice(0, 30).forEach((l) => {
    console.log('│ ' + l.slice(0, 66).padEnd(66) + ' │');
  });
  console.log('└' + '─'.repeat(68) + '┘');
}
