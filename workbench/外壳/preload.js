// 工作台 preload — 安全暴露 IPC 给渲染层
const { contextBridge, ipcRenderer, webUtils } = require('electron');
// 网页版 AI 桥：任务回调（渲染层注册，见下面 webai.onTask 的说明）
let webAiTaskCb = null;


// [二次开发] 兜底：DSH_CUSTOMER_HOME 缺失时按 preload 所在位置推导
// 原实现只认环境变量，缺失就得到空串 ⇒ 神经元读不到数据。
const __wbHome = (function () {
  if (process.env.DSH_CUSTOMER_HOME) return process.env.DSH_CUSTOMER_HOME;
  try {
    const pathm = require('path');
    const fsp = require('fs');
    const guess = pathm.join(__dirname, '..', '引擎数据', '.dsh');
    if (fsp.existsSync(guess)) return guess;
  } catch (e) { /* ignore */ }
  return '';
})();

// ══════════════════════════════════════════════════════════════════════
//  ⚠ 2026-11-14 重写：路径必须区分「代码根」和「数据根」
// ══════════════════════════════════════════════════════════════════════
//
//  原来这里的路径全部从 DSH_SHELL_DIR（= __dirname）推导：
//     dataDir   = DSH_SHELL_DIR\data
//     reviewDir = DSH_SHELL_DIR(去掉外壳)\自我复盘
//     bootCfg   = DSH_SHELL_DIR\data\boot-animation.json
//
//  源码模式下 __dirname = workbench\外壳 → 都对。
//  **但打包后 __dirname 在 app.asar 内部**，于是：
//     reviewDir = ...\resources\app.asar\自我复盘（不存在）
//     → _generic.js 用它反推 workbenchRoot = ...\app.asar
//     → 场景文档目录 = ...\app.asar\数据\.dsh\场景记忆\架构梳理\文档
//     → main.js 白名单拒绝（正确行为）→ 面板报「列目录失败」
//     实测日志：`[review] 拒绝越界根目录: ...\app.asar\数据\.dsh\场景记忆\架构梳理\文档`
//
//  修法：区分两个根
//     · 代码根（asar 内，只读）：__dirname
//     · 数据根（可写）：打包时用 DSH_USER_ROOT，源码时用 workbench/
//  下面所有「用户数据/场景记忆/自我复盘」一律走数据根。
//
//  ⚠ 注意：自我复盘目录在打包版里可能不存在（它是开发期产物），
//    但那没关系 —— review.parentDir 会指向 USER_ROOT\数据\.dsh\场景记忆，
//    场景文档面板用的是这个。
const __isPacked = process.env.DSH_PACKAGED === '1';
const __dataRoot = (function () {
  // 打包版：主进程已经算好 USER_ROOT
  if (__isPacked && process.env.DSH_USER_ROOT) return process.env.DSH_USER_ROOT;
  // 源码版：DSH_SHELL_DIR 是 workbench\外壳，上一级 = workbench
  const sh = process.env.DSH_SHELL_DIR || '';
  if (sh) return sh.replace(/[\\/]外壳$/, '');
  return '';
})();

const __wbPaths = {
  dataDir: __dataRoot ? (__dataRoot + '\\数据') : '',
  // 自我复盘：数据根下。打包版若无此目录，主进程会 fallback
  reviewDir: __dataRoot ? (__dataRoot + '\\自我复盘') : '',
  bootCfg: __dataRoot ? (__dataRoot + '\\数据\\boot-animation.json') : '',
  memRoot: __wbHome ? (__wbHome + '\\场景记忆') : '',
  skillDir: __wbHome ? (__wbHome + '\\skills') : '',
  projectRoots: [],
  // 新增：把两个根都暴露出去，前端不用再自己反推
  dataRoot: __dataRoot,
  shellDir: process.env.DSH_SHELL_DIR || '',
  appRes: process.env.DSH_APP_RES || '',
};

contextBridge.exposeInMainWorld('app', {
  paths: __wbPaths,
  // ---- 原生浏览器侧栏（官方能力搬迁 ③ · 2026-09-26）----
  // 主进程实现：scripts\sidebar.js（WebContentsView 贴到主窗口 contentView，官方 platform-view.ts 同款）。
  // 渲染层面板类型还没做；先给 API，等做面板时直接调。未调用时对工作台零影响。
  browserSidebar: {
    attach: () => ipcRenderer.invoke('browser-sidebar:attach'),
    detach: () => ipcRenderer.invoke('browser-sidebar:detach'),
    setBounds: (b) => ipcRenderer.invoke('browser-sidebar:setBounds', b),
    navigate: (url) => ipcRenderer.invoke('browser-sidebar:navigate', url),
    back: () => ipcRenderer.invoke('browser-sidebar:back'),
    forward: () => ipcRenderer.invoke('browser-sidebar:forward'),
    state: () => ipcRenderer.invoke('browser-sidebar:state'),
  },
  // 容错：主进程捕获到崩溃/加载失败时通知渲染层（P0 二次开发）
  onFault: (cb) => {
    ipcRenderer.on('fault:event', (_e, ev) => { try { cb(ev); } catch (err) { console.error(err); } });
    return () => ipcRenderer.removeAllListeners('fault:event');
  },
  // [二次开发 P2] 预热配置：读 外壳/data/webai-warm.json
  webaiWarmConfig: () => ipcRenderer.invoke('webai:warm-config'),
  // [二次开发] Sceneflow 场景数据管线
  sfBoard: (sceneId) => ipcRenderer.invoke('sf:board', sceneId),
  // 【2026-11-17 加】任务分派面板
  dispatchRead: () => ipcRenderer.invoke('dispatch:read'),
  sfPipelines: () => ipcRenderer.invoke('sf:pipelines'),
  sfPipeStatus: (id) => ipcRenderer.invoke('sf:pipe-status', id),
  sfClaim: (artifactId) => ipcRenderer.invoke('sf:claim', artifactId),
  getHarnessUrl: () => ipcRenderer.invoke('harness:url'),
  isHarnessReady: () => ipcRenderer.invoke('harness:ready'),
  // 版本信息（左上角品牌区悬停显示）：GUI / 引擎 / Electron·Chromium·Node
  getVersion: () => ipcRenderer.invoke('app:version'),
  // ---- 壳侧能力位（渲染层据此决定"敢不敢用"某个新策略）----
  // ★webaiGuestFreeNav：main.js 的 web-contents-created 是否已对
  //   partition="persist:webai-<key>" 的内置网页版 AI 放行"站点自身跳转/登录 SSO"。
  //   老壳没有这一位 ⇒ 渲染层不预热（否则一开 GUI，站点自己一跳就把系统浏览器弹出来）。
  //   改这里要重启 GUI 才生效，所以它天然是"新壳"的标志。
  //   ★sceneTabOrder：main.js 里 listScenarios() 会按 data\scene-tab-order.json 排好序返回，
  //   并且有 'scenes:order:set' 通道可以回报拖拽结果。老壳没有这一位 ⇒ 渲染层退回去用 localStorage，
  //   绝不"报了顺序却没人接"（那会表现为拖完重启就复位）。
  //   改这里要重启 GUI 才生效，所以它天然是"新壳"的标志。
  caps: { webaiGuestFreeNav: true, sceneTabOrder: true },
  // 场景标签拖拽换位：把新顺序交给主进程（唯一权威，见 main.js 的 SCENE_ORDER_FILE）
  setSceneOrder: (ids) => ipcRenderer.invoke('scenes:order:set', ids),
  // 主进程有没有存过顺序（渲染层据此决定要不要把老版本的 localStorage 顺序迁移过去）
  getSceneOrder: () => ipcRenderer.invoke('scenes:order:get'),
  injectHarnessPanel: (webContentsId, pinTarget) => ipcRenderer.invoke('harness:wv:inject', webContentsId, pinTarget),
  listScenarios: () => ipcRenderer.invoke('scenarios:list'),
  getScenario: (id) => ipcRenderer.invoke('scenario:get', id),
  // ---- 设置：读取 / 打开 Harness 配置文件 ----
  settings: {
    list: () => ipcRenderer.invoke('settings:list'),
    open: (which) => ipcRenderer.invoke('settings:open', which)
  },
  // ---- 余额实时显示（DeepSeek 平台，密钥只在主进程）----
  // [二次开发] 引擎 RPC 代理（绕过 file:// 的 CORS/信任围栏）
  engine: {
    rpc: (method, args) => ipcRenderer.invoke('engine:rpc', method, args),
    prompt: (sessionId, text) => ipcRenderer.invoke('engine:prompt', sessionId, text),
  },

  // ---- 场景工作区注册（2026-11-11）----
  // 引擎的 workspace.json 默认是空的，UI 会停在「选择一个工作区开始」。
  // 主进程在引擎就绪后会自动注册，这里留一个手动触发的口子（调试用）。
  workspace: {
    registerScenes: () => ipcRenderer.invoke('workspace:register-scenes'),
  },

  // ---- 主 Agent（中枢）自研对话界面 · 引擎 RPC 桥（2026-11-11）----
  // 为什么不用 <webview> 内嵌引擎 UI：300px 宽下引擎输入框只有 292px，
  // 且必须先点「选择工作区」才能打字；主 Agent 也失去了特殊性。
  // 改成自己画界面，数据走这些 IPC（都转 engineRpcCall）。
  ma: {
    ensureSession: (cwd) => ipcRenderer.invoke('ma:ensure-session', cwd),
    page: (sessionId) => ipcRenderer.invoke('ma:page', sessionId),
    send: (sessionId, text) => ipcRenderer.invoke('ma:send', sessionId, text),
    abort: (sessionId) => ipcRenderer.invoke('ma:abort', sessionId),
  },

  // [二次开发] dsh-TUI 的 PTY 桥
  tui: {
    start: (id, opts) => ipcRenderer.invoke('tui:start', id, opts),
    input: (id, data) => ipcRenderer.invoke('tui:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('tui:resize', id, cols, rows),
    stop: (id) => ipcRenderer.invoke('tui:stop', id),
    status: () => ipcRenderer.invoke('tui:status'),
    onData: (cb) => {
      const h = (e, id, data) => cb(id, data);
      ipcRenderer.on('tui:data', h);
      return () => ipcRenderer.removeListener('tui:data', h);
    },
    onExit: (cb) => {
      const h = (e, id, ev) => cb(id, ev);
      ipcRenderer.on('tui:exit', h);
      return () => ipcRenderer.removeListener('tui:exit', h);
    },
  },

  balance: {
    get: () => ipcRenderer.invoke('balance:get'),
    refresh: () => ipcRenderer.invoke('balance:refresh'),
    open: () => ipcRenderer.invoke('balance:open'),
    onUpdate: (cb) => { ipcRenderer.on('balance:update', (e, v) => cb(v)); }
  },
  // ---- 手机远程访问（dsh-plugin-remote-access 插件）----
  remoteAccess: {
    status: () => ipcRenderer.invoke('remoteAccess:status'),
    qr: () => ipcRenderer.invoke('remoteAccess:qr'),
    guideImage: () => ipcRenderer.invoke('remoteAccess:guideImage'),
    action: (a) => ipcRenderer.invoke('remoteAccess:action', a)
  },
  // ---- 外观：同步窗口底色（浅色主题避免闪黑）----
  theme: {
    setWindowBg: (color) => ipcRenderer.invoke('theme:set-window-bg', color)
  },
  // ---- 宿主通用能力（不属于任何场景，任何场景都可调用）----
  app: {
    openPath: (target) => ipcRenderer.invoke('app:open-path', target),
    revealPath: (target) => ipcRenderer.invoke('app:reveal-path', target)
  },
  // ---- 宿主通用能力：读写文本文件（预览面板 / 流程画布节点用）----
  // 缺这个命名空间 = 主进程还是旧的（2026-09-20 之前启动的），要重启一次 GUI 才有。
  file: {
    read: (p) => ipcRenderer.invoke('kun:file:read', p),
    write: (p, text) => ipcRenderer.invoke('kun:file:write', p, text),
    stat: (p) => ipcRenderer.invoke('kun:file:stat', p),
    // Office/WPS 文档 → PDF（2026-10-13 加）：主进程借本机 Office 的 COM 转一次，缓存到 %TEMP%，
    // 渲染层拿回来的 pdf 路径喂给内核 PDF 阅读器 ⇒ Word / Excel / PPT 也能在预览面板里看。
    // 缺这个 = 主进程还是旧的 ⇒ 要重启一次 GUI（预览层会退回"用系统默认程序打开"的卡片，不会白屏）。
    toPdf: (p) => ipcRenderer.invoke('kun:file:toPdf', p)
  },
    // ---- 本机系统信息（2026-10-06 新增；本地电脑场景（原名电脑清理）用）：磁盘分区容量 ----
    // 缺这个命名空间 = 主进程还是旧的 ⇒ 要重启一次 GUI 才有（面板会先显示提示，不会白屏）。
    sys: {
      disks: () => ipcRenderer.invoke('kun:sys:disks'),
      load: () => ipcRenderer.invoke('kun:sys:load')
    },
    // ---- 本地电脑场景 · pc:* 只读盘点（2026-11-11 追加）----
    // 对应 main.js 里的 ipcMain.handle('pc:drives' | 'pc:toplarge' | 'pc:junk' | 'pc:ledger')。
    // 全部只读：不删任何文件，面板只负责"列出来 + 报大小"。
    pc: {
      drives: () => ipcRenderer.invoke('pc:drives'),
      toplarge: (opts) => ipcRenderer.invoke('pc:toplarge', opts),
      junk: () => ipcRenderer.invoke('pc:junk'),
      ledger: () => ipcRenderer.invoke('pc:ledger')
    },
    // ---- 本地抠图（2026-10-20 宿主：「智能抠图做成本地工具」）----
    // 引擎 = <工作台>\工具\抠图\venv 里的 rembg（离线，图片不出本机）；status 看引擎/模型在不在。
    // 缺这个命名空间 = 主进程还是旧的 ⇒ 要重启一次工作台才有。
    // ---- 本地模型开关（2026-10-20 dg-dsh 派单）----
    // 状态/切换都转发给 <工作台>\工具\本地模型.mjs（离线 llama.cpp + Qwen3-8B，127.0.0.1:8080）。
    // 缺这个命名空间 = 主进程还是旧的 ⇒ 重启一次工作台。
  // ---- 拖文件进画布 / 选生成路径 / 选具体文件 / 窗口置顶（2026-09-23 第七轮 + 第十一轮）----
  // filePath：拖进画布的文件 → 真实路径（webUtils.getPathForFile 是 Electron 新 API；
  //   老壳没有它 ⇒ 渲染层退回 File.path，照样能用）。pickFolder：选文件夹（待生成的存到哪）；
  //   pickFile：选具体文件（参考素材的路径）；setAlwaysOnTop：独立窗口置顶开关。
  filePath: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  pickFolder: () => ipcRenderer.invoke('kun:pick-folder'),
  pickFile: () => ipcRenderer.invoke('kun:pick-file'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('kun:set-always-on-top', !!on),
  // ---- 宿主通用能力：探测本机端口在不在（流程画布「ComfyUI 控制台 / 工作台」节点的状态点）----
  // 同样：缺这个命名空间 = 主进程还是旧的，要重启一次 GUI 才有（面板里会降级成"要重启一次 GUI"）。
  net: {
    probe: (host, port, timeoutMs) => ipcRenderer.invoke('kun:net:probe', host, port, timeoutMs)
  },
  // ---- 技能（Skill）：清单 / 打开技能目录或正文 ----
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    open: (target) => ipcRenderer.invoke('skills:open', target)
  },
  // ---- Blender 场景（独立命名空间）：实时画面 / 启动 / 关闭 / 工作区文件 / 窗口内置 ----
  blender: {
    state: (opts) => ipcRenderer.invoke('blender:state', opts),
    launch: () => ipcRenderer.invoke('blender:launch'),
    // 默认发 WM_CLOSE 优雅退出（有未保存改动会弹 Blender 自己的保存提示）；opts.force=true 才强杀
    close: (opts) => ipcRenderer.invoke('blender:close', opts),
    capture: (on) => ipcRenderer.invoke('blender:capture', on),
    files: (relPath) => ipcRenderer.invoke('blender:files', relPath),
    open: (target) => ipcRenderer.invoke('blender:open', target),
    reveal: (relPath) => ipcRenderer.invoke('blender:reveal', relPath),
    // on=false 释放回桌面；on=true 时 rect 为面板可视区的 CSS 像素矩形
    embed: (on, rect) => ipcRenderer.invoke('blender:embed', on, rect),
    embedMove: (rect) => ipcRenderer.invoke('blender:embedMove', rect),
    embedStatus: () => ipcRenderer.invoke('blender:embedStatus')
  },
  // 2026-10-28 客户「<客户>」：把工业软件窗口内置成面板（owner-overlay，与 Blender 同一套）
  appwin: {
    status: (proc) => ipcRenderer.invoke('appwin:status', proc),
    launch: (exe, args) => ipcRenderer.invoke('appwin:launch', exe, args),
    embed: (proc, rect) => ipcRenderer.invoke('appwin:embed', proc, rect),
    move: (rect) => ipcRenderer.invoke('appwin:move', rect),
    release: () => ipcRenderer.invoke('appwin:release')
  },
  onHarnessReady: (cb) => {
    ipcRenderer.on('harness:ready', () => cb());
  },
  // ---- 启动加载页：进度订阅 / 快照 / 失败重试 ----
  onBootProgress: (cb) => { ipcRenderer.on('boot:progress', (e, v) => cb(v)); },
  bootState: () => ipcRenderer.invoke('boot:state'),
  bootRetry: () => ipcRenderer.invoke('boot:retry'),
  // ---- 个人站场景：官网预览 / 结构化信息 / 本地文件夹 / 浏览器打开 ----
  site: {
    preview: () => ipcRenderer.invoke('site:preview'),
    info: () => ipcRenderer.invoke('site:info'),
    files: (relPath) => ipcRenderer.invoke('site:files:local', relPath),
    openFile: (relPath) => ipcRenderer.invoke('site:open-file', relPath),
    open: (url) => ipcRenderer.invoke('site:open', url),
    openFolder: (dir) => ipcRenderer.invoke('site:open-folder', dir),
    probe: (url) => ipcRenderer.invoke('site:probe', url),
    // 拖出文件：拖到资源管理器＝复制一份，拖到其他窗口＝把文件交给它（主进程 startDrag）
    startDrag: (relPath) => ipcRenderer.send('site:drag', relPath)
  },
  // ---- 程序开发场景：把项目 H5 用手机尺寸窗口打开（400×830，独立持久会话记住登录）----
  code: {
    phoneWindow: (url, title) => ipcRenderer.invoke('code:phone-window', url, title)
  },
  // ---- 自我复盘场景：本地 md 文档树（只读；根＝<工作台>\自我复盘，路径由主进程夹在本目录内）----
  review: {
    root: () => ipcRenderer.invoke('review:root'),
    // ⚠ 2026-11-11 加第 2 个参数 root（事故 AC-020）：
    //   原来只能浏览全局 REVIEW_DIR（workbench/自我复盘），
    //   所以 5 个场景的文档面板都显示「自我复盘」的路径。
    //   现在可以传场景自己的目录（主进程有白名单，只允许 场景记忆/自我复盘/产物）。
    files: (rel, root) => ipcRenderer.invoke('review:files', rel, root),
    read: (rel, root) => ipcRenderer.invoke('review:read', rel, root)
  },
  // ---- 股票助手：本地存储（记忆 / 聊天 / 行情缓存）----
  stock: {
    mem: {
      add: (m) => ipcRenderer.invoke('stock:mem:add', m),
      list: (kind) => ipcRenderer.invoke('stock:mem:list', kind),
      update: (id, patch) => ipcRenderer.invoke('stock:mem:update', id, patch),
      remove: (id) => ipcRenderer.invoke('stock:mem:delete', id)
    },
    chat: {
      create: (scenario, title) => ipcRenderer.invoke('stock:chat:create', scenario, title),
      list: (scenario) => ipcRenderer.invoke('stock:chat:list', scenario),
      messages: (sid) => ipcRenderer.invoke('stock:chat:messages', sid),
      send: (sid, role, content) => ipcRenderer.invoke('stock:chat:send', sid, role, content),
      remove: (sid) => ipcRenderer.invoke('stock:chat:delete', sid),
      rename: (sid, title) => ipcRenderer.invoke('stock:chat:rename', sid, title)
    },
    watch: {
      set: (code, name) => ipcRenderer.invoke('stock:watch:set', code, name),
      list: () => ipcRenderer.invoke('stock:watch:list'),
      remove: (code) => ipcRenderer.invoke('stock:watch:remove', code)
    },
    pos: {
      set: (code, name, shares, cost) => ipcRenderer.invoke('stock:pos:set', code, name, shares, cost),
      list: () => ipcRenderer.invoke('stock:pos:list'),
      update: (code, patch) => ipcRenderer.invoke('stock:pos:update', code, patch),
      remove: (code) => ipcRenderer.invoke('stock:pos:remove', code)
    },
    trade: {
      buy: (code, name, shares, price) => ipcRenderer.invoke('stock:trade:buy', code, name, shares, price),
      sell: (code, name, shares, price) => ipcRenderer.invoke('stock:trade:sell', code, name, shares, price),
      close: (code, price) => ipcRenderer.invoke('stock:trade:close', code, price),
      list: (limit) => ipcRenderer.invoke('stock:trade:list', limit),
      stats: () => ipcRenderer.invoke('stock:trade:stats')
    },
    // 费率设置（同花顺口径：佣金/印花税/过户费）
    fee: {
      get: () => ipcRenderer.invoke('stock:fee:get'),
      set: (patch) => ipcRenderer.invoke('stock:fee:set', patch)
    },
    acct: {
      init: (amount) => ipcRenderer.invoke('stock:acct:init', amount),
      cash: () => ipcRenderer.invoke('stock:acct:cash'),
      account: () => ipcRenderer.invoke('stock:acct:account'),
      setCash: (amount) => ipcRenderer.invoke('stock:acct:set-cash', amount),
      setTotal: (amount) => ipcRenderer.invoke('stock:acct:set-total', amount),
      adjust: (delta) => ipcRenderer.invoke('stock:acct:adjust', delta),
      snapshot: (snap) => ipcRenderer.invoke('stock:acct:snapshot', snap),
      snapshots: (limit) => ipcRenderer.invoke('stock:acct:snapshots', limit)
    },
    quote: {
      cache: (code, payload) => ipcRenderer.invoke('stock:quote:cache', code, payload),
      latest: (code) => ipcRenderer.invoke('stock:quote:latest', code),
      realtime: (codes) => ipcRenderer.invoke('stock:quote:realtime', codes)
    },
    kline: {
      cache: (code, period, payload) => ipcRenderer.invoke('stock:kline:cache', code, period, payload),
      latest: (code, period) => ipcRenderer.invoke('stock:kline:latest', code, period),
      history: (code, period, count, force) => ipcRenderer.invoke('stock:kline:history', code, period, count, force),
      batch: (codes, count) => ipcRenderer.invoke('stock:kline:batch', codes, count)
    },
    script: {
      run: (script) => ipcRenderer.invoke('stock:script:run', script)
    },
    market: {
      rank: (opts) => ipcRenderer.invoke('stock:market:rank', opts),
      rankCached: (type) => ipcRenderer.invoke('stock:market:rankCached', type)
    },
    sector: {
      // 板块每日快照（趋势看板历史）：set 批量写当天各板块概况；get 读某市场某日全部；history 读某板块近 N 天
      setDaily: (market, date, snapshots) => ipcRenderer.invoke('stock:sector:daily:set', market, date, snapshots),
      getDaily: (market, date) => ipcRenderer.invoke('stock:sector:daily:get', market, date),
      history: (market, sectorId, limit) => ipcRenderer.invoke('stock:sector:daily:history', market, sectorId, limit)
    }
  },
  // ---- OA 运维场景（与股票完全隔离：chat/mem 强制 scenario='oa-ops'，前端无法串到股票数据）----
  oa: {
    status: (force) => ipcRenderer.invoke('oa:status', force),
    logs: (limit) => ipcRenderer.invoke('oa:logs', limit),
    logsReal: (kinds, lines, force) => ipcRenderer.invoke('oa:logs:real', kinds, lines, force),
    files: (base, force) => ipcRenderer.invoke('oa:files', base, force),
    filesLocal: (p) => ipcRenderer.invoke('oa:files:local', p),
    upload: (localPath, remoteDir) => ipcRenderer.invoke('oa:upload', localPath, remoteDir),
    dragStart: (filePath) => ipcRenderer.send('oa:dragstart', filePath),
    openFolder: (dir) => ipcRenderer.invoke('oa:openFolder', dir),
    openPath: (p) => ipcRenderer.invoke('oa:openPath', p),
    image: (p) => ipcRenderer.invoke('oa:image', p),
    download: (remotePath, localDir) => ipcRenderer.invoke('oa:download', remotePath, localDir),
    paths: () => ipcRenderer.invoke('oa:paths'),
    sync: {
      status: (force) => ipcRenderer.invoke('oa:sync:status', force),
      push: (key, via) => ipcRenderer.invoke('oa:sync:push', key, via),
      pull: (key, via) => ipcRenderer.invoke('oa:sync:pull', key, via)
    },
    perms: {
      get: () => ipcRenderer.invoke('oa:ai:perms'),
      set: (p) => ipcRenderer.invoke('oa:ai:perms:set', p)
    },
    web: {
      list: () => ipcRenderer.invoke('oa:web:list'),
      check: (urls, force) => ipcRenderer.invoke('oa:web:check', urls, force),
      open: (url) => ipcRenderer.invoke('oa:open', url),
      // 「手机预览」= 400×830 独立窗口 + 独立配置目录（记住登录），配方同 界面预览\打开*.bat
      appWindow: (which) => ipcRenderer.invoke('oa:appWindow', which),
      // ★ 2026-09-23 预览窗口「置顶」开关：置顶后始终浮在最上层（边聊天边看预览）
      appWindowPin: (which, on) => ipcRenderer.invoke('oa:appWindow:pin', which, on),
      appWindowPinState: (which) => ipcRenderer.invoke('oa:appWindow:pinState', which)
    },
    urls: () => ipcRenderer.invoke('oa:urls'),
    setScenario: (sid) => ipcRenderer.invoke('oa:set-scenario', sid),
    backups: (limit) => ipcRenderer.invoke('oa:backups', limit),
    action: {
      list: () => ipcRenderer.invoke('oa:action:list'),
      run: (id) => ipcRenderer.invoke('oa:action:run', id)
    },
    shell: {
      exec: (cmd) => ipcRenderer.invoke('oa:shell:exec', cmd),
      history: (limit) => ipcRenderer.invoke('oa:shell:history', limit)
    },
    agent: {
      dequeue: () => ipcRenderer.invoke('oa:agent:dequeue'),
      ack: (r) => ipcRenderer.invoke('oa:agent:ack', r)
    },
    config: {
      get: (key) => ipcRenderer.invoke('oa:config:get', key),
      set: (key, value) => ipcRenderer.invoke('oa:config:set', key, value)
    },
    ssh: {
      status: () => ipcRenderer.invoke('oa:ssh:status')
    },
    code: {
      read: (rel) => ipcRenderer.invoke('oa:code:read', rel),
      write: (rel, content) => ipcRenderer.invoke('oa:code:write', rel, content)
    },
    // OA 场景自己的聊天与记忆：场景参数写死 'oa-ops'，与股票会话/记忆互不可见
    chat: {
      create: (title) => ipcRenderer.invoke('stock:chat:create', 'oa-ops', title),
      list: () => ipcRenderer.invoke('stock:chat:list', 'oa-ops'),
      messages: (sid) => ipcRenderer.invoke('stock:chat:messages', sid),
      send: (sid, role, content) => ipcRenderer.invoke('stock:chat:send', sid, role, content),
      remove: (sid) => ipcRenderer.invoke('stock:chat:delete', sid)
    },
    mem: {
      add: (m) => ipcRenderer.invoke('stock:mem:add', Object.assign({ scenario: 'oa-ops' }, m)),
      list: (kind) => ipcRenderer.invoke('stock:mem:list', kind, 'oa-ops'),
      remove: (id) => ipcRenderer.invoke('stock:mem:delete', id)
    }
  },
  // 插件 / 模型 面板（只读，数据来自项目文件夹）
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list')
  },
  models: {
    list: () => ipcRenderer.invoke('models:list')
  },
  // 顶栏状态区（2026-10-16 新增，只给 renderer\topbar-status.js 用；老宿主没这组 IPC 时那边自动不显示）
  topbar: {
    pressure: () => ipcRenderer.invoke('topbar:pressure'),
    pending: () => ipcRenderer.invoke('topbar:pending'),
    snapshots: () => ipcRenderer.invoke('topbar:snapshots'),
    snapshot: () => ipcRenderer.invoke('topbar:snapshot'),
    restore: (name) => ipcRenderer.invoke('topbar:restore', name),
    engineStatus: () => ipcRenderer.invoke('topbar:engine-status'),
    engineSnapshot: () => ipcRenderer.invoke('topbar:engine-snapshot'),
    engineRestore: () => ipcRenderer.invoke('topbar:engine-restore'),
    // 2026-10-24：引擎回退也留 5 代、可挑任意一代回（工具侧 --list / --restore-gen）
    engineGens: () => ipcRenderer.invoke('topbar:engine-gens'),
    engineRestoreGen: (gen) => ipcRenderer.invoke('topbar:engine-restore-gen', gen),
    // 主进程主动推的提示（升级/崩溃保险自动回退后用它告诉用户）
    onToast: (cb) => { ipcRenderer.on('topbar:toast', (e, v) => cb(v)); },
    open: (p) => ipcRenderer.invoke('topbar:open', p),
    // 最近打开的文件夹（读 Windows「最近使用」记录，只读；2026-10-16 加）
    recentFolders: () => ipcRenderer.invoke('topbar:recent-folders')
  },
  // 工具清单（2026-10-21）：顶栏 🛠 面板读 data\工具清单.json
  toolsCatalog: () => ipcRenderer.invoke('tools:catalog'),
  // ---- 内置网页版 AI 桥（2026-09-21 第 10 轮）：把任务派给顶栏那 5 个免费网页版 ----
  // 会话侧入口：HTTP 127.0.0.1:31239/webai/ask，或 node scripts\webai.mjs ask <key> "问题"
  // onTask 只**替换回调**：真正的 ipcRenderer 监听在文件末尾只注册一次 ⇒ 渲染层被「⟳」重跑多少遍，
  // 都不会出现"同一个任务被处理两次"（旧闭包自然作废）。
  webai: {
    ask: (key, text, opts) => ipcRenderer.invoke('webai:ask', key, text, opts),
    claim: (id) => ipcRenderer.invoke('webai:claim', id),
    done: (id, r) => ipcRenderer.invoke('webai:done', id, r),
    state: () => ipcRenderer.invoke('webai:state'),
    // v3.17：窗口加载完就申报自己那份桥的版本。主进程只把活派给"版本相等"的窗口 ——
    // 这样分屏/分离窗口里那份**旧桥**永远抢不到活（它不会申报，也不会抢到单）。
    bridge: (ver) => ipcRenderer.invoke('webai:bridge', ver),
    who: () => ipcRenderer.invoke('webai:who'),
    onTask: (cb) => { webAiTaskCb = (typeof cb === 'function') ? cb : null; }
  },
  // 窗口控制（自定义标题栏）
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  close: () => ipcRenderer.invoke('window:close'),
  // 多窗口（场景分离）：我是谁 / 把场景弹出成独立窗口 / 哪些场景已分离
  win: {
    info: () => ipcRenderer.invoke('window:info'),
    scenes: () => ipcRenderer.invoke('window:scenes'),
    openScene: (sceneId) => ipcRenderer.invoke('window:open-scene', sceneId),
    closeSelf: () => ipcRenderer.invoke('window:close-self'),
    onChanged: (cb) => { ipcRenderer.on('windows:changed', (e, v) => cb(v)); }
  }
});

// 网页版 AI 桥：**单分发器**（整个 preload 生命周期只注册这一个监听）
ipcRenderer.on('webai:task', (e, t) => {
  if (typeof webAiTaskCb === 'function') {
    try { webAiTaskCb(t); } catch (err) { console.error('[webai] 任务处理异常', err); }
  } else {
    console.warn('[webai] 收到任务但渲染层还没注册回调（renderer\\webai-bridge.js 没加载？）', t && t.id);
  }
});
