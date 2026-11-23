# Dify 拆解（A12 插件 / 工具生态为主要目标）

> 仓库：`D:\refs\dify`（langgenius/dify，2026-11-17 拉取，commit `ef7c7d620d9e41bd35b26e7dbcf59d7e4fe47d4a`）
> 口径：只写「能抄什么」，每条结论带 `文件:行号`；找不到就写「未找到」。

---

## 1. 定位与规模

一句话：Dify 是「LLM 应用/Agent/工作流」的一体化平台，本仓库是 **API(Flask) + Web(Next.js) + CLI + 两个独立运行时** 的 monorepo；
它的插件能力**不在本仓库内实现**，本仓库只有「宿主侧适配器」，真正的插件运行时是外部 Go 服务 `langgenius/dify-plugin-daemon`。

- 文件数：16,363；主语言：TypeScript 7,585 个（`*.ts/*.tsx`）、Python 5,127 个（`*.py`），其余为 Go（`dify-agent-runtime`）与配置。
- 版本事实：`api/pyproject.toml:1-2`（`name = "dify-api"` / `version = "1.19.0"`）、`web/package.json:2-3`（`dify-web 1.19.0`）、`cli/package.json`（`@langgenius/difyctl 1.19.0`）。
- 最近提交：`ef7c7d6 chore: upgrade vite-plus to 1.7.0 (#46564)`，2026-11-17（`git log -1`）。
- 插件运行时版本：`docker/docker-compose.yaml:628` → `image: langgenius/dify-plugin-daemon:0.6.14-local`。
- star：**未找到**（本机离线、clone 无 star 元数据；web_search 不可用）。上游为 `github.com/langgenius/dify`（`git remote -v`）。

顶层目录 → 职责（`D:\refs\dify` 实测）：

| 目录 | 职责 | 证据 |
|---|---|---|
| `api/` | Flask 后端：controllers / services / core / models / tasks / schedule | `api/core/`、`api/controllers/` |
| `web/` | Next.js App Router 前端（React + Tailwind） | `web/package.json:2`、`web/app/` |
| `cli/` | `@langgenius/difyctl` 命令行，**自带一套 TS 插件内核** | `cli/src/kernel/`、`cli/src/plugins/` |
| `dify-agent/` | Python agent 框架（含 plugin tool/llm 层） | `dify-agent/src/dify_agent/layers/dify_plugin/` |
| `dify-agent-runtime/` | **Go 沙箱运行时**（landlock + sqlite + server） | `dify-agent-runtime/go.mod:1`、`internal/landlock/` |
| `packages/` | `dify-ui` 等共享包 | `packages/dify-ui/` |
| `sdks/` | 多语言 SDK | `sdks/` |
| `skills/difyctl/` | 给 agent 用的 difyctl skill | `skills/difyctl/` |
| `docker/` | 单机编排（api/worker/worker_beat/web/plugin_daemon/nginx…） | `docker/docker-compose.yaml` |

---

## 2. 架构骨架

### 2.1 依赖方向（真实 import）

- **插件运行时是硬边界**：`api/core/plugin/impl/base.py:51` 读 `dify_config.PLUGIN_DAEMON_URL`；所有插件操作都是 HTTP 到 daemon（见 §3.4）。所以 `core/plugin` 是**适配层/客户端**，不是装载器。
- 宿主内部依赖是环状的（实体层互相引用），没有单向约束：
  - `api/core/tools/plugin_tool/provider.py:3` → `from core.plugin.impl.tool import PluginToolManager`（tools 依赖 plugin）
  - `api/core/plugin/entities/plugin.py:9-16` → 反向 import `core.tools.entities.tool_entities`、`core.agent.plugin_entities`、`core.datasource.entities...`、`core.trigger.entities...`（plugin 依赖 tools/agent/datasource/trigger）
  - 结论：**没有像 OpenHands 那样靠 CI 强制单向依赖**；边界不是靠目录约定，而是靠「进程边界」——插件代码永远不 import 宿主，只发 HTTP。
- 前端：`web/app/(commonLayout)/plugins/page.tsx`、`web/app/marketplace/`、`web/app/components/plugins/**`；插件详情/安装/任务在 `web/app/components/plugins/plugin-page/plugin-tasks/`。
- CLI 有一层**真正的类型化插件内核**：`cli/src/kernel/plugin.ts:1-25` + `cli/src/kernel/context.ts:7-40`（详见 §9-机制 C）。

### 2.2 核心/插件边界靠什么强制

不是目录、不是 CI，而是**三段物理隔离**：

1. **独立进程**：`docker/docker-compose.yaml:626-655` 单独起 `plugin_daemon`（端口 5003 调试，内部 5002）；
2. **独立存储**：`docker/docker-compose.yaml:654` 挂 `./volumes/plugin_daemon:/app/storage`；
3. **双向 HTTP 契约**：宿主→daemon 用 `X-Api-Key`（`impl/base.py:185`）；daemon/插件→宿主反向调用走 `/inner-api/plugin/invoke/*`（`api/controllers/inner_api/plugin/plugin.py:99-596`）。

---

## 3. 【A12】插件 / 扩展机制（重中之重）

### 3.1 插件清单字段（真实片段）

**关键事实：本仓库没有 `manifest.yaml` 文件**（`Get-ChildItem -Recurse -Filter manifest.yaml` 为空）。清单的**生产者与校验者都在 daemon（Go，另仓）**；本仓库只有清单的**消费端 Pydantic 模型** `PluginDeclaration`，它就是宿主看到的清单 schema：

`api/core/plugin/entities/plugin.py:70-113`
```python
class PluginDeclaration(BaseModel):
    class Plugins(BaseModel):
        tools: list[str] | None = Field(default_factory=list[str])
        models: list[str] | None = Field(default_factory=list[str])
        endpoints: list[str] | None = Field(default_factory=list[str])
        datasources: list[str] | None = Field(default_factory=list[str])
        triggers: list[str] | None = Field(default_factory=list[str])

    class Meta(BaseModel):
        minimum_dify_version: str | None = Field(default=None)
        version: str | None = Field(default=None)

    version: str = Field(...)
    author: str | None = Field(..., pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    name: str = Field(..., pattern=r"^[a-z0-9_-]{1,128}$")
    description: I18nObject
    icon: str
    icon_dark: str | None = Field(default=None)
    label: I18nObject
    category: PluginCategory
    created_at: datetime.datetime
    resource: PluginResourceRequirements
    plugins: Plugins
    tags: list[str] = Field(default_factory=list)
    repo: str | None = Field(default=None)
    verified: bool = Field(default=False)
    tool: ToolProviderEntity | None = None
    model: ProviderEntity | None = None
    endpoint: EndpointProviderDeclaration | None = None
    agent_strategy: AgentStrategyProviderEntity | None = None
    datasource: DatasourceProviderEntity | None = None
    trigger: TriggerProviderEntity | None = None
    meta: Meta
```

分类枚举 `PluginCategory`（`entities/plugin.py:61-67`）：`tool / model / extension / agent-strategy / datasource / trigger`。

**资源与权限声明**（清单里最该抄的部分，`entities/plugin.py:26-58`）：
```python
class PluginResourceRequirements(BaseModel):
    memory: int
    class Permission(BaseModel):
        class Tool(BaseModel):     enabled: bool | None = Field(default=False)
        class Model(BaseModel):    enabled/llm/text_embedding/rerank/tts/speech2text/moderation ...
        class Node(BaseModel):     enabled: bool | None = Field(default=False)
        class Endpoint(BaseModel): enabled: bool | None = Field(default=False)
        class Storage(BaseModel):
            enabled: bool | None = Field(default=False)
            size: int = Field(ge=1024, le=1073741824, default=1048576)   # 1KB~1GB
        tool / model / node / endpoint / storage
    permission: Permission | None
```

清单的解码返回契约：`PluginDecodeResponse{ unique_identifier, manifest: PluginDeclaration, verification: PluginVerification }`（`entities/plugin_daemon.py:230-233`）。

> 真实的 `manifest.yaml` 文本（含 `meta.minimum_dify_version`、`plugins:`、`resource.permission`）**未找到**——它在 `dify-plugin-daemon` 仓库与插件打包产物里，不在本仓库。

### 3.2 怎么被发现

**没有文件系统扫描**。宿主不做 discover，直接向 daemon 要「已安装列表」：

- `api/core/plugin/impl/plugin.py:63-70` — `GET plugin/{tenant_id}/management/list`（分页 1/256）→ `PluginListResponse`
- `api/core/plugin/impl/plugin.py:72-80` — `GET .../management/installation/ids?category=...`（按分类列已装 id）
- 工具 provider 的「发现」也是查 daemon：`api/core/plugin/impl/tool.py:35-50` — `GET plugin/{tenant}/management/tools`，并对每个 tool 的 `identity.provider` 重写为 `{plugin_id}/{provider_name}`

即：**发现 = 查已装清单**。真正的「扫盘/解包/注册」在 daemon 内（本仓库不可见）。

### 3.3 怎么校验

分两层：**宿主侧结构校验 + daemon 侧包校验/签名**。

1. 结构校验全在 Pydantic validator：
   - 版本格式：`entities/plugin.py:115-122`（`Version(v)`，非法抛 `InvalidVersion`）
   - 最低宿主版本：`entities/plugin.py:82-91`
   - 名字/作者正则：`entities/plugin.py:94-95`（`name: ^[a-z0-9_-]{1,128}$`，`author: ^[a-zA-Z0-9_-]{1,64}$`）
   - **分类自动推导**（不信任清单自报）：`entities/plugin.py:124-140`，按 `tool/model/datasource/agent_strategy/trigger` 字段反推 `category`，否则 `Extension`
2. 包与签名校验**下发给 daemon**：上传包时把 `verify_signature` 作为表单字段传过去：
   - `impl/plugin.py:115-138`（`POST .../management/install/upload/package`，`data={"verify_signature": "true"/"false"}`）
   - `plugin_service.py:1151-1167` 里由权限策略决定是否强制验签：`verify_signature=permission.restrict_to_marketplace_only`
   - 失败上报走 `PluginDaemonError{error_type,message}` + 统一异常映射 `impl/base.py:400-466`（`PluginDaemonBadRequestError / PluginNotFoundError / PluginPermissionDeniedError / PluginUniqueIdentifierError …`）
3. **来源/授权范围校验**（宿主侧）：`plugin_service.py:736-761` 按 `PluginVerification.authorized_category ∈ {langgenius, partner, community}` 判定，策略枚举在 `plugin_daemon.py:217-228`；`plugin_service.py:729-734` 还有「完全禁止安装」的 deny-all。

> **签名算法本仓库未找到**（只在 `verify_signature` 这一个布尔上转发给 daemon）。

### 3.4 怎么装载：**独立进程（daemon），不是动态 import、不是子进程内嵌**

通信协议 = **HTTP + JSON（流式用行分隔的 `data:` 帧）**：

- 客户端基类 `api/core/plugin/impl/base.py:120-201`
  - `plugin_daemon_inner_api_baseurl = URL(dify_config.PLUGIN_DAEMON_URL)`（:51）
  - `_prepare_request`：`X-Api-Key = dify_config.PLUGIN_DAEMON_KEY`（:185）；`Accept-Encoding gzip/deflate/br`（:186）；注入 `X-Plugin-ID`（见 tool invoke）
  - **路径穿越防护**：路径长度 ≤4096、最多 8 层 URL 解码、禁止 `..` 段（:169-182）——很值得抄的加固
  - 响应统一包一层 `PluginDaemonBasicResponse{code,message,data}`（`entities/plugin_daemon.py:23-30`），`code!=0` 时解析 `PluginDaemonError` 再按类型抛（:345-356）
- 流式：`_stream_request`（:228-268）按行读，剥 `data:` 前缀；`_request_with_plugin_daemon_response_stream`（:358-398）逐行 `model_validate_json`
- 反向（插件→宿主）：daemon/插件调宿主 inner-api：
  - 路由清单：`api/controllers/inner_api/plugin/plugin.py:99-596`（`/invoke/llm`、`/invoke/llm/structured-output`、`/invoke/text-embedding`、`/invoke/rerank`、`/invoke/tts`、`/invoke/speech2text`、`/invoke/moderation`、`/invoke/tool`、`/invoke/datasource`、`/invoke/encrypt`、`/invoke/parameter-extractor`、`/invoke/question-classifier`、`/invoke/app`、`/upload/file/request`、`/download/file/request`、`/fetch/app/info`）
  - 鉴权：`@plugin_inner_api_only` + `@get_user_tenant`（`controllers/inner_api/plugin/wraps.py:103-132`，租户范围限定，注释明确「user_id 不可信」:27-31）
  - 加密/解密代理：`core/plugin/backwards_invocation/encrypt.py:7-34`（宿主替插件做凭据 encrypt/decrypt，插件不碰明文 key）
  - 流式封装：`libs/helper.length_prefixed_response`（`controllers/inner_api/plugin/plugin.py:119`，`0xF` 长度前缀帧）

一句话：**插件是「带 key 的 HTTP 服务」，宿主是「带 key 的 HTTP 客户端」，插件反向调宿主也走 inner-api + 加密代理」**。

### 3.5 插件能贡献什么（6+1 类，各自落点）

| 贡献类型 | 清单字段 | 宿主侧 daemon 客户端 | 宿主侧消费入口 |
|---|---|---|---|
| **Tool** | `tool` / `plugins.tools` | `impl/tool.py:17-232`（fetch/invoke/validate/get_runtime_parameters） | `core/tools/plugin_tool/provider.py:11-85` → `ToolManager` |
| **Model** | `model` / `plugins.models` | `impl/model.py`、`impl/model_runtime.py:107-732`（`PluginModelRuntime`，LLM/embedding/rerank/TTS/STT/moderation） | `impl/model_runtime_factory.py:53+`（`PluginModelAssembly`） |
| **Endpoint** | `endpoint` / `plugins.endpoints` | `impl/endpoint.py:8-156`（setup/list/update/enable/disable/remove） | `services/plugin/endpoint_service.py`、`controllers/console/workspace/endpoint.py`（对外暴露 webhook URL，模板 `ENDPOINT_URL_TEMPLATE`，`entities/endpoint.py:49-55`） |
| **Agent Strategy** | `agent_strategy` | `impl/agent.py:14-117`（`/management/agent_strategies`、`/dispatch/agent_strategy/invoke`） | `core/agent/strategy/plugin.py:12-69`（`PluginAgentStrategy`） |
| **Datasource** | `datasource` / `plugins.datasources` | `impl/datasource.py`（15KB） | `core/tools/plugin_tool` 之外的 datasource provider 体系 |
| **Trigger** | `trigger` / `plugins.triggers` | `impl/trigger.py:11KB` | `api/core/trigger/entities/entities.py`、`api/tasks/trigger_processing_tasks.py` |
| （Extension） | 兜底 | — | 未细看；`category=extension` 无专属 dispatch |

**「贡献点 ↔ 宿主基类」的桥接方式最值得抄**：`PluginToolProviderController` 直接**继承内置 `BuiltinToolProviderController`**，让「插件工具」和「内置工具」对上层完全同构：

`api/core/tools/plugin_tool/provider.py:11-35`
```python
class PluginToolProviderController(BuiltinToolProviderController):
    entity: ToolProviderEntityWithPlugin
    tenant_id: str
    plugin_id: str
    plugin_unique_identifier: str
    @property
    @override
    def provider_type(self) -> ToolProviderType: return ToolProviderType.PLUGIN
```
`ToolManager.get_builtin_provider` 就是「先查内置，查不到转插件」（`api/core/tools/tool_manager.py:131-154`，`get_plugin_provider`:156-199）。抽象基类见 `api/core/tools/__base/tool_provider.py:14-109`（`get_credentials_schema / get_tool / validate_credentials_format`）。

### 3.6 隔离：插件拿得到宿主内部对象吗？

拿不到——物理上就不在同一个进程。能力限制有三道：

1. **清单声明式权限**：`resource.permission.{tool,model,node,endpoint,storage.size}`（`entities/plugin.py:29-57`），storage 上限 1GB；
2. **反向调用白名单**：插件只能打 inner-api 的固定 `/invoke/*` 路由（§3.4），且必须带 inner key + 通过 `get_user_tenant` 租户绑定；
3. **凭据不落到插件**：加解密由宿主 `PluginEncrypter` 代做（`backwards_invocation/encrypt.py:7-34`）。

### 3.7 热插拔：装 / 卸 / 启用禁用 / 状态存哪

- **安装/升级**（宿主 API）：`controllers/console/workspace/plugin.py` 路由全集
  - `POST .../plugin/install/pkg`（:829）、`.../install/github`（:850）、`.../install/marketplace`（:877）
  - `POST .../plugin/upgrade/marketplace`（:1033）、`.../upgrade/github`（:1056）
  - `POST .../plugin/uninstall`（:1084）
- **安装是异步任务**（不是同步返回），状态四态：`PluginInstallTaskStatus = pending|running|success|failed`（`entities/plugin_daemon.py:187-191`）；任务结构 `PluginInstallTask{status,total_plugins,completed_plugins,plugins[]}`（:204-208）；轮询接口 `impl/plugin.py:180-199`（`GET .../install/tasks` / `.../tasks/{id}`）。
- **卸载会连带清凭据**：`plugin_service.py:1343-1426`，删 `TenantPreferredModelProvider / ProviderCredential / Provider` 里 `provider_name LIKE '{plugin_id}/%'` 的记录，并清缓存；`preserve_credentials` 可保留。
- **启停**：插件级没有 enable/disable，**启用/禁用粒度在 endpoint 实例**：`impl/endpoint.py:120-137`（enable）、:139-156（disable）。
- **状态存哪**：**全在 daemon**（其自有 DB + `./volumes/plugin_daemon` 存储，`docker-compose.yaml:654`）；宿主只额外缓存 model provider 列表到 Redis（`plugin_service.py:131-478` 一大段 cache）。宿主 DB 只存「租户插件安装权限」`TenantPluginPermission`（`services/plugin/plugin_permission_service.py:7-36`）。
- **自动升级**：`services/plugin/plugin_auto_upgrade_service.py`（策略 `TenantPluginAutoUpgradeStrategy`，默认 `LATEST` :40-44）+ 定时巡检 `schedule/check_upgradable_plugin_task.py:30-104`（先拉全局 manifest 到 Redis 再逐插件比对）。

### 3.8 市场（marketplace）机制

Marketplace 是**纯外部 SaaS API**，宿主只是 HTTP 客户端，没有本地市场：

- 配置：`api/configs/feature/__init__.py:378-386`（`MARKETPLACE_ENABLED=True`、`MARKETPLACE_API_URL=https://marketplace.dify.ai`）
- 下载包：`core/helper/marketplace.py:21-27` — `GET {marketplace}/api/v1/plugins/download-url?unique_identifier=...`，带 `PLUGIN_MAX_PACKAGE_SIZE` 大小限制
- 搜索：`core/helper/marketplace.py:110-133` — `POST /api/v1/plugins/search/advanced`（`sort_by=install_count`，带 `X-Dify-Version` 头）
- 批量取清单：`core/helper/marketplace.py:30-43` — `POST /api/v1/plugins/batch`
- 安装计数回传：`core/helper/marketplace.py:136-139` — `POST /api/v1/stats/plugins/install_count`
- 全量 manifest 快照（供升级比对，写 Redis）：`core/helper/marketplace.py:142-178` — `GET /api/v1/dist/plugins/manifest.json`
- 市场条目模型：`core/plugin/entities/marketplace.py:12-66`（`org/name → plugin_id`、`latest_version`、`latest_package_identifier`、`status: active|deleted`、`deprecated_reason`、`alternative_plugin_id`）
- 安装流程：`plugin_service.py:1294-1340`（先 `fetch_plugin_manifest` 命中缓存则免下载，否则 `_download_plugin_pkg` → `upload_pkg(verify_signature=...)` → `_check_plugin_installation_scope` → `install_from_identifiers`）

---

## 4. 【A13】MCP / 工具接入

Dify 是**双向** MCP：既做 client（拉外部 MCP server 当工具），也做 server（把自己的 App 暴露成 MCP）。

- **MCP client**：`api/core/mcp/mcp_client.py`（158 行）
  - 双传输：`streamable_http` 与 `sse`，按 URL path 末段选，失败自动回退（:62-115）
  - `list_tools` 带**分页与上限护栏**：最多 10,000 工具 / 100 次请求 / 重复 cursor 检测（:19-21、117-140）——很值得抄的防爆
  - `invoke_tool`（:142-146）
  - 会话实现：`core/mcp/session/client_session.py`、`core/mcp/types.py`（45KB 协议类型）
  - header 模板替换 `{{ request.headers.x }}`：`mcp_client.py:37-47`
- **MCP 当工具 provider**：`api/core/tools/mcp_tool/provider.py:21-169`
  - `from_entity` 把远端 `Tool{name,title,inputSchema,outputSchema}` 逐个转成 `ToolEntity`（:62-118），`parameters = ToolTransformService.convert_mcp_schema_to_parameter(...)`
  - `provider_type = MCP`（:43-51）
- **UI/CRUD（增删改 + OAuth + 启停）**：`api/controllers/console/workspace/tool_providers.py`
  - `"/workspaces/current/tool-provider/mcp"`（:1384 创建/列表/删除）
  - `"/workspaces/current/tool-provider/mcp/auth"`（:1512）、`"/mcp/oauth/callback"`（:1641）
  - `"/workspaces/current/tool-provider/mcp/tools/<provider_id>"`（:1588，刷新工具列表）、`"/workspaces/current/tools/mcp"`（:1605）、`update`（:1621）
- **结果回填**：`core/tools/mcp_tool/tool.py`（17.5KB）→ 统一 `ToolInvokeMessage`；`has_runtime_parameters` 由 inputSchema 是否为空决定（provider.py:92）
- **反向（App → MCP server）**：`core/mcp/server/streamable_http.py:61+`（`handle_mcp_request`、协议版本协商 :23-45）、`controllers/console/app/mcp_server.py:79-160`（`/apps/<id>/server` GET/POST/PUT + `/refresh`），模型 `AppMCPServer`

---

## 5. 【A11】调度 / 后台任务

- **框架：Celery + Redis**。`api/extensions/ext_celery.py`
  - worker 配置（`worker_hijack_root_logger=False` :158）、`imports=[...]` 显式列出所有任务模块（:200-225）
  - **beat 调度表** `beat_schedule` 在 :229 起逐条注册（`evaluation-run-reconciler` 每分钟 :231-234、`knowledge_fs_*`、`sweep_trace_payloads` …）
- **常驻进程怎么起**：docker compose 分三个进程
  - `worker`（`docker/docker-compose.yaml:375-411`，`MODE: worker`，健康检查 `celery -A celery_healthcheck.celery inspect ping` :403）
  - `worker_beat`（:445）
  - `api`（:301，gunicorn geventwebsocket :351-353）
- **定时任务定义**：`api/schedule/*.py` 一批 `@shared_task`（`check_upgradable_plugin_task.py:30`、`trigger_provider_refresh_task.py:8-10`、`queue_monitor_task.py`…）；工作流定时触发 `api/tasks/workflow_schedule_tasks.py:8-11`（`run_schedule_trigger` → `application_services().triggers.schedules.execute(schedule_id)`，注释明确「no-retry policy」:10）
- **失败/超时/状态**：插件安装任务本身就是四态任务（§3.7）；`check_upgradable_plugin_task.py:56` 注释强调「DB 事务不跨 marketplace I/O 与节流 sleep」，是很好的长任务写法。

---

## 6. 【C1/C2】agent 循环与停止条件

两个 runner，都在 `api/core/agent/`：

- **Function Calling**：`api/core/agent/fc_agent_runner.py`
  - 一轮定义：`_init_prompt_tools()` 把工具转成模型 tool schema（:114-115）→ 调 `model_instance.invoke_llm(..., tools=prompt_messages_tools, stop=...)`（:175-183）→ 收 tool_calls（:198-209）
  - 主循环：`while function_call_state and iteration_step <= max_iteration_steps:`（:144）
  - 上界：`max_iteration_steps = min(app_config.agent.max_iteration, 99) + 1`（:120）；默认 `max_iteration: int = 10`（`api/core/agent/entities.py:86`）
  - **最后一轮剥工具**：`if iteration_step == max_iteration_steps: prompt_messages_tools = []`（:147-149）
  - 超限抛错：:306-308 `raise AgentMaxIterationError(app_config.agent.max_iteration)`（异常定义 `api/core/agent/errors.py:1-9`）
- **CoT**：`api/core/agent/cot_agent_runner.py:82-83,109,197-200` 同构（`max_iteration, 99` + 末轮清工具 + `AgentMaxIterationError`）。
- **停止条件族（我们只有 maxTurns，这里至少 4 类）**：
  1. 模型不再请求工具（`function_call_state=False`，:145/:123）
  2. 达到 `max_iteration`（:120/:147/:306）
  3. 模型 `stop` 序列命中（`app_generate_entity.model_conf.stop` 传入 invoke_llm :179）
  4. 末轮强制无工具（:147-149），逼模型给自然语言终答
- **工具→模型 schema 的唯一入口**：`api/core/agent/base_agent_runner.py:149-235`
  - `ToolManager.get_agent_tool_runtime(...)`（:153-160）
  - 生成 `PromptMessageTool(name=..., description=llm, parameters=get_llm_parameters_json_schema())`（:171-175）
  - `parameters` 更新 `update_prompt_message_tool`（:237-242）
- **状态持久化**：会话/消息落 DB（`models/model.py` 的 `Conversation/Message`，`base_agent_runner.py:244+ create_agent_thought` 逐轮写 `agent_thought`）；靠 `conversation_id` 续跑。进程级崩溃恢复依赖消息表重放（未见独立 checkpoint 快照）。

---

## 7. 【A6/A7】记忆

- **短期记忆 = token 预算内的会话历史**：`api/core/memory/token_buffer_memory.py`（367 行）
  - 从 DB 读 `Message/MessageFile` 重建历史（:26、:35-55）
  - 按模型 token 上限裁剪（`recalc_llm_max_tokens` 在 runner 侧，`fc_agent_runner.py:162`）
  - 无摘要式 condenser；只有截断。→ **A5 只算部分**
- **长期/语义记忆：没有独立模块（未找到）**；唯一「召回」是 **Annotation 回复**：
  - 人工标注 QA 对 → 向量化入 RAG 库：`api/tasks/annotation/add_annotation_to_index_task.py:43-53`（`Vector(dataset).create([document])`，属性 `doc_id/annotation_id/app_id`）
  - `batch_import_annotations_task.py:79-85`、`delete/disable` 任务同套
  - 召回走 `core/app/features/annotation_reply/`（按 app 配置的 embedding + 阈值）
- **溯源/冲突消解/TTL/老化：未找到**（grep `ttl|supersede|decay|conflict` 无记忆相关命中）。
- **跨会话召回**：仅按 `conversation_id` 取本会话历史（`extract_thread_messages`，`token_buffer_memory.py:11`），没有跨会话用户画像。

---

## 8. 【D1–D5】界面

- **技术栈**：Next.js App Router + React + Tailwind（`web/package.json:2`，`"next"/"react"/"tailwindcss": "catalog:"`）；工作流画布 `reactflow`、代码编辑 `@monaco-editor/react`（`web/package.json` 依赖）；`packages/dify-ui` 共享组件库。
- **布局范式**：
  - 插件页：已装列表 + 市场发现双 Tab（`web/app/components/plugins/plugin-routes.ts:5-7`：`plugins` / `discover`）
  - 集成分类路由：`/integrations/tools/built-in`、`/integrations/model-provider`、`/integrations/data-source`、`/integrations/trigger`、`/integrations/agent-strategy`（`plugin-routes.ts:16-23`）
  - 市场页：`web/app/components/plugins/marketplace/index.tsx`（服务端 prefetch `prefetchMarketplaceDehydratedState`）+ `list/detail-dialog/filter/templates/creator-profile`
  - 工作流：画布 + 节点/面板（`web/app/components/workflow/{nodes,panel,block-selector,operator}`）
- **状态可见性**：
  - 安装进度：`plugin-page/plugin-tasks`（前端）+ `PluginInstallTask{total_plugins,completed_plugins,plugins[]}`（`entities/plugin_daemon.py:204-208`）→ 用户能看到「装到第几个/失败原因」
  - Agent 思考流：`QueueAgentThoughtEvent`/`create_agent_thought`（`fc_agent_runner.py:200-202`、`base_agent_runner.py:244+`）
  - 权限开关：`TenantPluginPermission{install_permission,debug_permission}`（`services/plugin/plugin_permission_service.py:7-36`，controller `plugin.py:1109+`）
- **主题/多工作区**：多租户（tenant）+ 多语言 `I18nObject`（`description/label` 都是 i18n）；工作区维度 `with_current_tenant_id`。

---

## 9. ⭐ 最值得抄的 3 条机制

> **总结论先说**：**「插件生态」应该直接采用 Dify 的架构形态（进程外 daemon + 声明式清单 + 统一 provider 控制器 + 独立 skill 包格式），不要继续在 `tools/plugin/kernel.mjs` 里加死贡献点。**但它的 Go daemon 不在本仓库，无法整段复制——我们抄的是**契约与桥接方式**，不是它的 daemon 源码。

### 机制 A：插件 = 进程外 daemon，宿主只做「带 key 的 HTTP 适配器」

```
机制：插件代码跑在独立进程（plugin daemon），宿主通过 HTTP + X-Api-Key 调它；
     插件反向调宿主走 /inner-api/plugin/invoke/* + inner key，凭据加解密由宿主代理。
位置：api/core/plugin/impl/base.py:51,120-201（X-Api-Key:185、路径穿越防护:169-182）
      docker/docker-compose.yaml:626-655（独立服务 + 独立存储）
      api/controllers/inner_api/plugin/plugin.py:99-596（反向调用路由面）
      api/core/plugin/backwards_invocation/encrypt.py:7-34（凭据代理）
为什么好：我们 kernel.mjs 是「进程内 import」，贡献点（commands/panels/verifiers）
     是死代码，因为没有隔离就没有安全边界，也不敢真让别人写。进程边界一旦有了，
     「贡献点」才敢开放；Dify 用同一套 HTTP 契约同时支持 tool/model/endpoint/agent
     strategy/datasource/trigger 六类贡献，靠的就是「宿主只认协议不认实现」。
我们抄到哪：tools/plugin/kernel.mjs → 拆成 host adapter + 独立 runner；
     先在 host 侧实现 PluginClient（对应 impl/base.py），贡献点注册改为
     「声明→provider 控制器」而非直接执行。
```

### 机制 B：插件贡献统一继承内置控制器（`PluginToolProviderController : BuiltinToolProviderController`）

```
机制：插件工具不是"另一种东西"，而是继承内置工具控制器的子类，上层（ToolManager/Agent）
     对"内置/插件/API/工作流/MCP"完全一视同仁。
位置：api/core/tools/plugin_tool/provider.py:11-35（继承 + provider_type=PLUGIN）
      api/core/tools/plugin_tool/tool.py:15-94（PluginTool 继承 Tool，invoke 转发 daemon）
      api/core/tools/tool_manager.py:131-199（内置查不到自动转插件）
      api/core/tools/__base/tool_provider.py:14-109（抽象基类：get_tool/get_credentials_schema/validate）
为什么好：我们的 panels/commands/verifiers 之所以是死代码，是因为没有"上层统一消费口"。
     这里只要贡献物实现同一个基类，Agent 侧 `base_agent_runner.py:149-235` 一行代码就
     把所有来源的工具转成模型 schema——插件工具零改动接入 agent 循环。
我们抄到哪：tools/plugin/ 下新增 provider 抽象 + 让 kernel 的贡献点产出「符合抽象的对象」，
     而不是让每个插件自己想办法被调用。
```

### 机制 C：Skill 包格式（`SKILL.md` + frontmatter + zip 安全校验 + 不可变版本快照）

```
机制：技能 = 一个 zip，根目录必须有 SKILL.md；frontmatter 定 name/description；
      scripts/ references/ assets/ 放文件；导入前先校验 ZIP 元数据（防 zip bomb/路径穿越）；
      publish 生成不可变版本 + 清单 + hash；agent 绑定后再下发。
位置：api/services/skill_management_service.py:641-668（name/path 规范化）
      api/services/skill_management_service.py:3976-4035（读包 + 必须含 SKILL.md + 解析 frontmatter）
      api/services/skill_management_service.py:4232-4251（解压前先校验：条目数/总解压大小/压缩比）
      api/models/skill.py:34-53,56-197（Skill / SkillDraftFile / SkillVersion / AgentSkillBinding）
      api/controllers/console/workspace/skills.py:298+（CRUD/import/export/versions/publish）
为什么好：我们「技能」只有 loader（list/load），没有包格式、没有版本、没有安全导入。
     这套 SKILL.md 约定与我们已有 skill 形态天然一致，且 zip 预校验是可直接抄的安全件。
我们抄到哪：tools/skills/ 增加包导入器（照 4232-4251 的校验顺序）+ 版本目录；
     清单模型照 models/skill.py 的 SkillVersionManifest 落。
```

### 附：内核层还有一个 65 行的「轻量替代品」（强烈建议至少在 host adapter 里抄）

```
机制：typed 插件 = {name, needs, build}；Context 懒构建 + 环检测 + cache + defer；
     `needs` 是编译期能力白名单（ctx.get 只能取允许的插件）。
位置：cli/src/kernel/plugin.ts:1-25、cli/src/kernel/context.ts:7-40
为什么好：我们的 discover/validateManifest/topoSort/activateAll 是"先全量拓扑排序再全启"，
     与 lazy pull 相比更重、更容易死锁；Dify CLI 这套 65 行就完成了依赖解析 + 环检测 + 按需加载。
我们抄到哪：tools/plugin/kernel.mjs 的 topoSort/activateAll 替换为 Context 懒解析，
     保留 manifest 只为"安装/发现"服务（安装态），运行态用 typed needs。
```

---

## 10. 我们不该抄的

1. **整套 Celery + Redis + Postgres + 多租户 DB schema**：Dify 是 SaaS 平台形态，我们是本地 agent harness；抄它的调度会把「一个 loop」变成「一套集群」。
2. **daemon 的 Go 实现本身**：不在本仓库，强行重写成本极高；且它解决的是「多租户 + 不可信第三方上传」问题，我们当前只有内部探针插件，属于过度设计。**先抄契约，别抄实现。**
3. **巨型 god service**：`api/services/skill_management_service.py` 单文件 **5,222 行 / 225KB**（实测），`core/tools/tool_manager.py` 49KB / 1,161 行——反面教材，不要学。
4. **重复的 provider 实体层级**：`ToolProviderEntity` / `ProviderEntity` / `DatasourceProviderEntity` / `AgentStrategyProviderEntity` / `TriggerProviderEntity` 五套近乎同构（`entities/plugin.py:107-112` 一眼可见），我们只做一套泛型 Provider + kind 字段即可。
5. **enterprise 条件分支**：`plugin_service.py:1052-1069` 这种「企业版才保留版本」的逻辑，与开源形态强耦合，不要带进来。
6. **marketplace 依赖外部 SaaS**：我们若要做市场，先做本地目录/文件源，别一上来依赖 `marketplace.dify.ai`。
7. **`endpoint` 贡献点的 URL 模板外露**：`entities/endpoint.py:35` 还有 `TODO: Confirm daemon masks secret-input settings`，说明这块自己都没收干净，不宜照搬。
