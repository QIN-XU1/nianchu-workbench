#!/usr/bin/env node
/**
 * 把拆解结论灌进界面数据（benchmark/data/analysis.json）
 *
 * 数据来源：research/拆解/*.md 的结论（人工阅读后结构化）。
 * 纪律：只填**有证据的结论**；没把握的留空，界面会显示「还没写」。
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/analysis.json';

const A = {
  openbitfun: {
    arch: [
      'Tauri v2：Rust 54 个 crate / 约 109 万行，六层单向依赖，由 CI 脚本强制检查（不是文档约定）',
      '前端 2809 文件 / 约 46 万行，只负责投影展示',
      'design-system 三层（design-tokens 零依赖 / theme-openbitfun / ui 48 组件）可独立发包',
      'layout.* 约 100 项按组件族命名，由契约测试逐条固定',
    ],
    exec: [
      '61 个内置工具，按 12 个编译期 feature 与 11 个 provider 组装配',
      'ACP 集成支持双向通信，内置 6 家预设',
      '取消分三级，状态机不允许取消后直接回到 IDLE',
      'Tauri 命令 334 个（desktop 注册块实测），agentic:// 事件 39 个',
    ],
    features: [
      '有：16 个静态场景、60 个 Zustand store、48 个 UI 组件、127 个 registry 项',
      '有：动效由六个 data-motion 语义角色控制 + 零特异性 :where() 兜底',
      '刻意没做：不做云端任务、不做多用户协作',
    ],
    ui: [
      '信息架构：.openbitfun-app-layout > workspace-body > nav-area + scene-area',
      'layout.navigation-panel.inline-size: 216px，item-height: 30px',
      'data-density / data-contrast 全局开关',
      '动效 80/140/220/320/420ms，cubic-bezier(0.23,1,0.32,1)',
    ],
    strengths: [
      '六层单向依赖由 CI 强制 —— 不是靠人记，是构建会红 [证据: openbitfun.md]',
      '设计系统三层可独立发包 —— 换主题不改组件，换组件不改 token',
      '契约测试逐条固定 layout token —— 界面回归可被断言而不是目测',
      '零特异性 :where() 兜底 —— 让覆盖样式不需要 !important',
    ],
    weaknesses: [
      'FlowChatStore 9703 行 —— 任何对话相关改动都要读近万行上下文',
      'data-density 一个属性承载三种含义 —— 想只调一个维度会连带改变其他',
      'singleton 字段是死代码 —— 读代码时会被误导',
      '首包 5.44MB，冷启动被串行阻塞 —— 首次打开明显等待',
      '性能结论仅覆盖 macOS —— Windows/Linux 未验证',
    ],
    borrow: [
      '六层单向依赖的 CI 强制脚本',
      'layout.* 按组件族命名 + 契约测试',
      '六个 data-motion 语义角色',
      '零特异性 :where() 兜底',
    ],
    surpass: [
      'FlowChatStore 拆到 <1000 行：验证方法是单文件体量红线（我们的 B4 已实现 32KB 红线）',
      '首包 <2MB：验证方法是构建产物分析',
      'Windows 上也有性能结论：验证方法是在本机跑同一套测量',
    ],
  },

  dsh: {
    arch: [
      '338 个包按「能力 seam（定义/实现/消费）」与「客户端面」切分，不按功能模块',
      '命名用角色后缀（Controller/Store/Registry/Runtime/Resolver/Engine/Policy/Executor/Gateway/Provider/Backend/Handle），由 docs/cookbook/adding-a-package.md:31-52 的 15 行表强制',
      '单进程 + in-process 插件宿主；334 包 src 中 child_process/Worker/fork 零命中',
      '通信：Cordis 服务注入 ctx.<key> + 5 种类型化事件（emit/waterfall/parallel/serial/bail）',
      '状态真相：append-only SessionEvent 日志，「Model-visible means logged」',
    ],
    exec: [
      'turn = 0..N step，step = 一次模型请求及其工具调用；retry 不重复 assembly/pre-step/user admission',
      '工具三层 waterfall + 单调 guard —— guard 返回类型故意没有 allow，策略不可被后注册者撤销',
      '并发分类 fail-closed，只认 === true；抛异常或未声明一律 exclusive',
      '取消不抛弃已启动 body（先到 quiescence 才标 ABORTED），分 TOOL_ABORTED / TOOL_ABORTED_BEFORE_DISPATCH 两档',
      '默认并行度硬编码 10；retry 默认 5 次，退避 500ms→10s',
    ],
    features: [
      '有而我们没有：整树可 patch 的 profile/bundle、会话格式一跳一包迁移链、PTC 模式、workflow 引擎、Agent Teams 共享任务板、Typert 严格生成',
      '刻意没做：无内建 turn 预算、并发分类一元、Approval 请求故意不带工具参数、不支持 OpenRouter 归因头',
    ],
    ui: [
      'React 18，62 个 dsh-client-ui-* 包',
      '三列 grid，slot 树驱动；子 slot：sidebar|main|rightbar|shell.bottom|shell.overlay|shell.leading',
      '列宽求解而非 CSS 断点：CENTER_MIN=400 / SIDEBAR_MIN=264,MAX=420 / COLLAPSED=56 / RIGHTBAR_MIN=300 / MAX_RATIO=0.7',
      '会话事件节点化：conversation-nodes/ 下 22 个独立节点，错误与重试不塞进 assistant 气泡',
      '统计用 step/end（非 assistant/message）作计数权威',
      '成本：完全没有（rg usd|dollar|pricing 零命中）',
    ],
    strengths: [
      '「无特权内核」真的消除 patch 面 —— 换 provider 不必 fork 包，--dump-config 可验证 [证据: architecture.md:9-11,57-65]',
      'guard 只能单调收缩权限 —— 把「策略不可被撤销」编码进返回类型，事故在编译期不成立 [证据: tools.md:458]',
      '取消不抛弃已启动 body —— 下游拿到「确定被中断」而非「不知道」 [证据: pipeline.ts:254-293]',
      '并发判定 fail-closed —— 默认独占只慢一点，默认并行会带来偶发难复现的写冲突 [证据: pipeline.ts:106-115]',
      '压缩不改写 surface 语义 —— 复用 replace，UI/transcript/token-meter 消费者零改动 [证据: compaction.md:11]',
      '错误/重试/压缩是一等公民节点 —— 天然可追溯，不是塞进对话气泡',
    ],
    weaknesses: [
      '完全没有成本或计价 —— 长任务无法回答「这轮花了多少」，无预算控制 [证据: rg usd|dollar|pricing 零命中]',
      '无内建 turn 预算 —— 工具反复失败或 steering 持续注入时 turn 可无限跑 [证据: dsh-agent-loop/README.md]',
      '并发分类一元 —— 3 个 edit 改同文件不同段落无法表达，整批退化为串行',
      'root 关闭可能丢最后一帧 —— CI 里 headless 后立刻退出会产生悬空 turn',
      '默认 10 并发 + 单进程 —— 50 并发 grep 撞天花板，无「丢另一个进程」的 seam',
      '本 checkout 无测试文件（分发形态限制，非设计缺陷）',
    ],
    borrow: [
      'batch.ts 的 batch settlement 三分支（commitReady/startCall/skip）',
      'fuseToolSignals()（35 行）解决 wrapper 替换 signal 后取消失效',
      'columns.ts 三列求解（65 行纯函数，可单测）',
      '「用 step/end 计数」的统计口径',
      'adding-a-package.md 的角色命名表 → 转 lint 规则',
    ],
    surpass: [
      '成本可见性（DSH 完全无）：会话结束给可复算金额，两次展示一致，换模型不重算',
      'turn 预算熔断（DSH 明确不做）：步数/秒数/金额任一触顶即终止',
      '并发从一元升级到声明式资源互斥：mutexKeys 相交则串行',
      '崩溃安全尾部：SIGKILL 100 次后 100% 三态可分类，零 unclassified',
    ],
  },

  openclaw: {
    arch: [
      '单 Gateway 守护进程 + 多客户端 + worker/沙箱子进程；「One Gateway per host」',
      '188 扩展 + 25 共享库 + src/ 77 功能域（平铺）',
      '通信：单一 WS JSON 协议，首帧必须 connect；TypeBox → JSON Schema → Swift codegen',
      '状态真相：Gateway 唯一 owner + SQLite；并发靠 writer claim（expectedWriterRunId）',
      '依赖方向单向，且用 17+ 个 *.import-boundary*.test.ts 强制成 CI 红线',
    ],
    exec: [
      'agent RPC 立即返回 {runId, acceptedAt}；先预留 session controller turn 再进 global capacity',
      'core 工具 73 个可解析名（66 定义 + 7 runtime-only），11 section / 4 profile，分层 policy pipeline 带 provenance',
      '11 静态 lane + 动态 subagent:<session> lane + lane group（共享预算 + 预留槽位）',
      'priority 有界抢先（前台 15s / 后台 30s），之后 FIFO；running turns never preempted',
      '重试按 HTTP 请求：限流 16 次、其他瞬态 8 次/90s；provider retry-after 优先',
    ],
    features: [
      '有而我们没有：20+ 真实渠道、多用户 multiplayer、成本与用量追踪、记忆分层 + dreaming 离线巩固、Swarm 并行专家 lane（32）、Tool Search 三模式、OTel/Prometheus',
      '刻意没做：不做配置兼容别名（升级即断）、不为理论性竞态加复杂度、事件不重放',
    ],
    ui: [
      'SolidJS + Vite；ui/src 下 pages 2361 / components 1193 / lib 813 / app 410',
      '56 条路由，但侧栏只 11 项（templates/dashboards/usage/cron/sessions/systems/activity/meetings/plugins/apps/portals）',
      '收敛规则写在注释：Skills/Workshop 从 Plugins hub 进、Worktrees 是 Sessions 的 tab',
      '侧边栏是用户可编排 zone（route|plugin|session|person 四型）',
      '状态三分：progress-drafts（mode/labels/detail/commentary lane）、streaming（human-like pacing）、usage-tracking（account-scoped quotas）',
    ],
    strengths: [
      'manifest-first 让 188 扩展守住启动时间 —— 发现与执行分离，未激活插件零运行时成本 [证据: tool-plugins.md:14-16]',
      'writer claim 让「旧 run 不能提交新数据」成为事务级保证 —— restart 场景经典 bug 变不可能 [证据: agent-loop.md:82]',
      'lane + 有界抢先同时解决「别互相踩」与「前台别被饿死」—— 只做优先级会饥饿，只做 FIFO 交互不可接受 [证据: server-lanes.ts:20-24,56-74]',
      'Tool Search 把「工具多」从线性成本变可选成本，并专门保护 KV-cache [证据: tool-search.md]',
      '重试预算按失败类别分配 —— 一个全局 maxRetries 要么对限流太短、要么对认证太长 [证据: retry.md:11-16]',
      '56 路由收敛到 11 侧栏项 —— 这个收敛比是界面信息架构的关键决策',
    ],
    weaknesses: [
      'src/ 平铺，src/sessions 下 82 个 session-controller*.ts 同级 —— 必须靠前缀猜',
      '事件不重放 + 客户端自修复 —— 移动端切后台 10 分钟后回来事件全丢，每个客户端要各自实现 gap 检测 [证据: architecture.md:174]',
      '无配置兼容别名 —— 升级即断，对非技术用户是硬门槛',
      '测试 22233 个占 42.6% —— 改一个被广泛引用的模块需同步调整两位数测试',
      'Gateway 侧职责过载 —— src/gateway 2953 个顶层文件含 cron/plugins/reload/auth/http/lanes/maintenance',
      '三段 codegen 链路是单点 —— 改一个核心帧要重生两侧，Swift 生成物未同步会静默不兼容',
    ],
    borrow: [
      'lanes.ts + lane group 共享预算 + 预留槽位三件套',
      'manifest-first 插件发现（能力/模型/单价/config schema/UI 提示全前置）',
      'writer claim 事务级校验',
      'agent-limits.ts 并发 floor（IO-bound agent 不能只按 CPU 算）',
      '「接受边界必须命名」规则',
      '56 路由 → 11 侧栏项的收敛方法',
    ],
    surpass: [
      '可定位性：任意功能名 ≤3 跳从入口到实现，由 lint 强制（同目录 >60 文件报警）',
      '配置演进兼容：保留最近两 minor 可读 + doctor 报弃用 + 旧配置启动测试作门禁',
      '测试成本：单次改动同步修改测试 ≤5 文件',
      '崩溃安全：SIGKILL 100 次后 100% 三态可分类',
    ],
  },

  hermes: {
    arch: [
      '一个 agent core，多个宿主（CLI/TUI/Electron/web dashboard/ACP/gateway 25+ 平台插件）',
      '执行是 spawn-per-call，不是长驻 shell —— 牺牲状态连续性换后端无关性 [证据: tools/environments/base.py:3]',
      '6 后端统一靠窄契约：BaseEnvironment 只 3 个必需方法（__init__/execute/cleanup）+ 20+ 模板方法',
      '后端差异用声明式规格 _BACKEND_SPECS（pre/binary/module/post）而非 if-else [证据: terminal_tool_backends.py:375-384]',
      '状态双轨：SQLite（18 张表，其中 7 张是租约/心跳/代际）+ curated 记忆纯文本 Markdown',
      '前缀缓存不可变是第一公理 [证据: AGENTS.md:18-21]',
    ],
    exec: [
      '工具发现用 AST 静态扫描 + (mtime_ns, size) 磁盘记忆化，避免 import 试错的副作用与 145ms 冷启动 [证据: registry.py:121-125]',
      '注册 ≠ 暴露：68 注册，当前环境只有 34 可暴露（check_fn 过滤 + 30s TTL）',
      '插件不能影子覆盖内置：三重闸（scope / override / allow_tool_override）[证据: registry.py:876-910]',
      '审批 8 层：容器短路 → 无条件地板 → 预备批次 → yolo 旁路 → 永久白名单 → 无人值守 → fail-closed 兜底 → 人类决策',
      '旁路必须可听见：不只 log，还把 guard_bypassed 写进工具结果的结构化字段 [证据: approval.py:1338-1359]',
      'yolo 环境变量在 import 时冻结，封死「skill 在进程内改 env 绕过全部审批」整类攻击 [证据: approval.py:46-48]',
    ],
    features: [
      '有而我们没有：6 后端统一抽象、插件覆盖内置三重闸、引号感知的 shell 复合命令检测、AST 级工具发现、_compressed_summary + absorbed_message_uids 消息身份模型、cron 四级降级 + EMFILE 退避、外部 skill trust 分级',
      '刻意没做：不做记忆 TTL/衰减、不做 core 工具扩张、不做插件改核心文件、不做无消费者的 hook、不做 spoof-able 的 shell 状态连续性',
    ],
    ui: ['有 Electron 桌面端（6102 文件 / 102.6MB）+ 星图可视化（--starmap-reveal CSS 变量驱动的零 JS 逐帧动画）'],
    strengths: [
      '极窄 backend 契约让 6 个异构后端真可互换 —— 新增后端只需 3 个方法 + 两处各加一行',
      '注册与暴露分离 —— 68 注册 / 34 可暴露，「装了但不可用」是正常状态',
      '审批错误方向被实测数据强制修正过（两处注释带具体复现）',
      '旁路可审计而不是可关闭 —— guard_bypassed 是工具结果的结构化字段',
      'YOLO 提权面被 import-time 冻结封死 —— 单行代码消除整类攻击',
      'cron 可用性是设计目标而非 best-effort —— 四级降级 + 受保护写入 + EMFILE 退避',
      '跨进程并发被建模而非被祈祷 —— 18 张表里 7 张是租约/心跳/代际',
      '数学上界守住 token 成本 —— 2200+1375 字符硬上限，都是常数不是「通常」',
    ],
    weaknesses: [
      '无记忆 TTL —— 陈旧记忆永久污染 system prompt；memory 工具只有 add/replace/remove/patch，无 age/decay 语义',
      'god-file：cron/scheduler.py 219KB、agent/auxiliary_client.py 440KB、context_compressor.py 328KB',
      '压缩三态 + absorbed_message_uids 正确性靠 6 处重复 SQL 条件维持，任一遗漏就漏数据或重复注入',
      '注册顺序敏感 + 静默覆盖 —— 同 toolset 同名工具后者静默替换前者，无 warning',
      'execute_code 在纯本地非交互非 gateway session 下 fail-open',
      'SKILL.md 的 mtime 签名看不见内容修改，30s 内改完可能拿到旧内容',
      '无 plan/read-only 模式 —— 想「先看方案再批准」只能逐个 tool call 拦',
    ],
    borrow: [
      'AST 扫描 + mtime/size 磁盘记忆化做工具发现',
      '插件覆盖内置的三重闸',
      '注册与暴露分离（check_fn + 30s TTL）',
      '8 层审批闸的顺序（地板在 bypass 前、白名单在 bypass 后）',
      '旁路必须 alarm + 结构化写进 result',
      '提权 env 在 import 时冻结',
      '引号感知 + -c/--eval 再解释检测',
      'ABC 的「3 必需 + 20 模板」模式',
      '退出 fence + 在途 spawn 等待 + 硬预算',
    ],
    surpass: [
      '记忆新鲜度：我们的 A7 已实现 TTL + supersede（expiresAt + effectiveState），hermes 无',
      '单文件体量：我们的 B4 已实现 32KB 红线（扫描 97 文件，红线 0），hermes 有 219KB/440KB',
      'execute_code fail-open：我们的 A15 从工具调用层拦截，不依赖脚本内容扫描',
      '工具注册冲突：注入两个同名工具，我们必须启动时报错并指出两个来源模块',
      '整轮只读模式：存在一个「本轮所有写操作拒绝、读放行」的开关',
    ],
  },

  ecc: {
    arch: [
      '无自有运行时 —— 5 个纯工具库依赖（@iarna/toml/ajv/js-yaml/sql.js/zod），宿主是 Claude Code/Codex/Cursor/…',
      '内容与投影分离：314 skill / 71 agent / 98 command / 122 rule 是唯一真源，16 个 install-target adapter 投影到各宿主格式',
      '「注册」= 文件写到目标工具会扫描的路径；adapter 只需声明 rootSegments + planOperations',
      'manifest 驱动按需安装：47 modules × 370 路径条目，每 module 带 cost/stability/defaultInstall',
      '记忆是独立模型：8 kind × 3 scope × 3 status + 10 条 secret 正则 + biDi 拒绝',
    ],
    exec: [
      '不做 agent loop —— 在宿主的 8 个事件上挂 hook（Claude：PreToolUse 10 / Stop 8 / SessionStart 2 …）',
      '单 hook 命令内嵌 1200+ 字符的 ECC root 解析器，且在每个 hook 里重复一遍（hooks.json 54KB 几乎全是它）',
      '审批在 hook 形式：gateguard-fact-force.js 103KB + 9 个 gateguard-* 库 ~150KB',
      'hook profile 四档（off/minimal/standard/strict）+ 逐 hook 声明适用档位 + 安装时 consent',
      '记忆按需检索（MCP memory_search），不是常驻 system prompt',
    ],
    features: [
      '有而我们没有：16 宿主投影器 + 声明式 manifest、hook profile 四档、类型化记忆 + supersede 状态机、biDi override 拒绝、记忆默认不进 git、Agent IR、跨宿主 skill 兼容性静态门、80% 覆盖率硬门、supply-chain IOC 扫描',
      '刻意没做：不做自己的 agent loop、不接管宿主审批、不做记忆 TTL、Hermes 目标刻意不装 hook 运行时、Agent 转换只做 claude→pi 一条边',
    ],
    ui: ['无独立前端 —— 全部界面能力寄生于宿主'],
    strengths: [
      '零运行时依赖 = 零启动成本、零崩溃面 —— npm i 后在任意支持 skill 的工具里立即生效',
      '内容与投影分离，加一个宿主 = 加一个 10 行文件（gemini-project.js 全文 10 行）',
      'manifest 驱动按需安装 —— --modules rules-core 只装 rules',
      '跨宿主差异被 CI 硬门守住 —— canonical bash fence 里加 ${CLAUDE_PROJECT_DIR} 跑校验必然失败',
      '记忆 schema 类型化程度高 —— 8 kind × 3 scope × 3 status + secret 正则 + biDi 拒绝',
      '记忆默认不进 git（PROJECT_MEMORY_GITIGNORE = "*\\n!.gitignore\\n"）',
      '对「自己做不到」极其诚实 —— HERMES-HOOKS.md 明说 24 个 hook 只移植 2 个及原因',
    ],
    weaknesses: [
      '副本必然漂移且无再生机制 —— 314 canonical → Codex 47 / Kiro 43 / Cursor 12，差 267 个没有任何机制会去补',
      '能力上限被宿主 hooks API 卡死 —— Codex 下全部安全 hook 只有 1 个 SessionStart，250KB 闸门代码完全不生效',
      'always-on 注入量不可控 —— opencode 每次请求注入 158KB ≈ 39K tokens，静态数组无按需加载',
      'hook preamble 重复是结构性的 —— 改解析逻辑要改 N 处，且被迫用 String.fromCharCode(92) 绕 MSYS 反斜杠折叠',
      '用 hook 重写审批引擎 = 更多代码做更少的事 —— ~250KB 只能在支持 PreToolUse 的宿主用，无法跨事件共享状态',
      'shell 扫描靠 76KB+103KB 正则堆，任何未覆盖的 shell 都是空白',
      '记忆 trust 字段是死字段（只有 unreviewed 一个值）；superseded 只有枚举没有迁移逻辑',
    ],
    borrow: [
      'adapter 注册表 + plan/validate/apply 三分离',
      'module 声明 paths[] + targets[] + dependencies[] + cost + stability',
      'Agent IR（parse canonical → IR → emit host）',
      '每宿主能力矩阵（channel/installMode/availability/hooks.mode）',
      '跨宿主 frontmatter allowlist + Claude-only 替换 token 清单',
      '记忆 schema 8 kind × 3 scope × 3 status + secret 正则 + biDi 拒绝',
      '记忆默认不进 git',
      'hook explicit consent',
    ],
    surpass: [
      '跨宿主副本一致性：改 1 个 canonical skill，所有已装宿主目标文件自动同步（内容 hash 一致），CI 报出任何漂移',
      'always-on 注入预算：仓库级 always-on 内容 ≤ 2K tokens，其余走渐进式披露',
      'hook 性能：同会话 20 次工具调用，hook 总耗时 < 200ms',
      '跨调用状态共享：同 session 连续 5 次危险命令，第 3 次起触发熔断',
      '记忆 trust/status 落地：我们的 A7 已实现 supersede 链 + 冲突检测',
      '记忆 TTL：ECC 与 hermes 都没有，我们的 A7 已实现（净增量）',
    ],
  },

  'cl4r1t4s': {
    arch: [
      '26 家厂商 / 80 份系统提示词 / 8.34MB / ≈209 万 tokens，全部一手材料',
      '按厂商分目录（ANTHROPIC 17 / OPENAI 18 / XAI 7 / GOOGLE 3 / CURSOR 3 / DEVIN 3 / MANUS 2 …）',
      '关键文件：CLAUDE-OPUS-5.5.md 1.9MB、GPT-6-Astra_Prompts.md 331KB、5.6-Sol_SystemPrompt.md 294KB',
    ],
    exec: [
      'Codex 已实现严格四态证据判定：「Treat uncertain or indirect evidence as not achieved」+「must prove completion, not merely fail to find obvious remaining work」',
      'ZAI 继承并加码：把判定权交给 runtime verifier',
      'Devin 用 BLOCK 正反例界定「真卡住」',
      'XAI 唯一把不确定性当可调量',
      'Anthropic 三个好零件（猜测留痕 / 不可逆才停 / 独立验证者）但未组装',
    ],
    features: [
      'Anthropic 零件最好却未组装 —— 这是最大可超越点',
      'Manus 只猜不记，Cline 只问不猜 —— 猜测无结构化留痕',
      '无人写「规则可判定性」',
    ],
    ui: ['非产品，无界面'],
    strengths: [
      'Codex 的四态证据判定措辞可直接改写成我们的提示词纪律 —— 与我们「判不了就说判不了」高度重合',
      'Devin 用正反例界定「真卡住」—— 比只写正向条件可验证',
      'XAI 把不确定性当可调量 —— 唯一这么做的',
    ],
    weaknesses: [
      '多数厂商的「完成」判定是二元 —— 没有「做了一半但判不了」',
      '猜测无结构化留痕 —— Manus 只猜不记，Cline 只问不猜',
      '无人写「规则可判定性」—— 提示词里的规则本身是否可被机器判定，没有一家表态',
      '文件是拼接产物 —— CLAUDE-OPUS-5.5.md 单文件含 12 段独立 prompt，1.9MB ≠ 1.9MB 提示词',
    ],
    borrow: [
      'Codex 的四态证据判定措辞',
      'Anthropic 的猜测留痕机制',
      'Anthropic 的「不可逆才停」原则',
      'Anthropic 的独立验证者角色',
      'Devin 的 BLOCK 正反例写法',
    ],
    surpass: [
      '四态 × 各自动作未打通（行业空白区 1）：我们的 A7/A5/A15 已把四态做成机制',
      '猜测留痕结构化：每次猜测记「依据是什么、置信度、可证伪条件」',
      '规则可判定性：每条规则标注它由什么机制保证（断言/类型/CI/人工）',
    ],
  },
};

const out = {
  what: '参照项目拆解结论（人写，基于 research/拆解/*.md）',
  rule: '每条都要能验证；读不到源码就留空，界面会显示「还没写」',
  at: new Date().toISOString(),
  byId: A,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

const n = Object.keys(A).length;
const items = Object.values(A).reduce((a, b) => a + Object.values(b).reduce((x, y) => x + (Array.isArray(y) ? y.length : 0), 0), 0);
console.log('  ✓ analysis.json: ' + n + ' 个项目 / ' + items + ' 条结论');
console.log('  → ' + OUT);