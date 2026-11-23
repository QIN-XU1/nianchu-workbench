// 最小验证插件：证明 agentPresets.select() 可以在运行时把会话切到指定 preset。
// 目的：补上 F-1 缺失的"动态激活"环节 —— 证明"preset 定义 → 会话真正使用"这条链路存在。
//
// 用法：挂进 profile 的 cordis.patch.yml，然后在 agent/created 事件里对目标会话 select。
// 观察点：会话日志里必须出现 agent-preset/selected，且 system prompt 必须含 persona 文本。

export const name = 'sea-preset-probe'
export const inject = ['agentPresets', 'agents']

export function apply(ctx) {
  const target = 'sea-data-reconcile'

  ctx.on('agent/created', async ({ agent, source }) => {
    // 只在会话真正被创建时尝试切换
    try {
      const preset = await ctx.agentPresets.resolve(target)
      if (!preset) {
        console.error(`[sea-preset-probe] preset '${target}' not resolvable`)
        return
      }
      const chosen = await ctx.agentPresets.select(agent, target)
      console.error(`[sea-preset-probe] selected '${chosen}' for session ${agent.id} (source=${source})`)
    } catch (error) {
      console.error(`[sea-preset-probe] select failed: ${String(error)}`)
    }
  })

  // 反向探针：尝试一个不存在的 preset，验证 select 会报错（证明机制不是空转）
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ctx.agentPresets.select(agent, 'SEA-THIS-PRESET-DOES-NOT-EXIST')
      console.error('[sea-preset-probe] NEGATIVE PROBE FAILED: selecting a bogus preset did NOT throw')
    } catch (error) {
      console.error(`[sea-preset-probe] NEGATIVE PROBE OK: bogus preset rejected: ${String(error).slice(0, 120)}`)
    }
  })
}
