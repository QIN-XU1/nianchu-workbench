/**
 * 宿主「缺口补齐」方法（从 ws-host.mjs 拆出，守单文件 <32KB 红线）
 *
 * 依据：真实横扫设置页后，宿主导出的 runtime-demand 显示这些方法被请求但未实现
 * （2026-11-21）。这里按各 API 的返回类型给**保守默认值**：
 *   · 列表型 → []（确实一个都没有）
 *   · 对象型 → 字段齐全的空对象（不编造内容，但形状对得上，页面不崩）
 * 目的：让设置里对应页面能渲染、可操作，而不是一律「无法加载」。
 * 诚实边界：这些是「本机没有/尚未配置」的真实空态，不是假装有数据。
 */
export function hostGapMethods(REPO) {
  return {
    // 终端：本机无托管 shell 列表
    terminal_list: () => [],
    // ACP：未安装任何 ACP 客户端
    get_acp_clients: () => [],
    probe_acp_client_requirements: () => [],
    load_acp_json_config: () => ({}),
    // 外部导入：没有导入过任何 hook / 外部会话
    get_external_hook_import_snapshot: () => ({ schemaVersion: 1, revision: '', catalog: {}, imports: [], diagnostics: [] }),
    get_external_source_discovery_snapshot: () => ({ sources: [], entries: [], revision: '' }),
    list_removed_external_sessions: () => [],
    // SSH 已保存连接：本机没有
    ssh_list_saved_connections: () => [],
    // 外部源控制快照：无外部受控源
    get_external_source_control_snapshot: () => ({ sources: [], controls: [], revision: '' }),
    // 订阅账号实例：无
    list_subscription_account_instances: () => [],
    // 模型：本机未配置任何供应商/模型（空目录，但不崩）
    get_local_models_dev_catalogs: () => ({}),
    get_ai_model_catalog: () => ({ version: 1, models: [], default_models: {} }),
    get_model_routing_status: () => ({
      apiVersion: 1, available: false, mode: 'default', defaultMode: 'default',
      ready: false, connected: false, issue: '尚未配置模型路由', summaryEnabled: false,
    }),
    get_models_dev_catalog_status: () => ({
      active_source: 'bundled', revision: '', cache_path: '', cache_exists: false,
      provider_count: 0, reasoning_model_count: 0, refresh_in_progress: false,
    }),
  };
}
