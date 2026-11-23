#!/usr/bin/env node
/**
 * 多代理协作协议（A9）—— 角色 + 私有收件箱 + 按 cause_by 订阅。
 *
 * 为什么做：verify-goal 的 R3 里另一个真缺口就是「A9 多代理协作协议」。
 *
 * 出处（metagpt 拆解，已核行号）：
 *   · `roles/role.py:125` Role 基类；钩子 `_observe:399-427` / `_think:340-379`
 *     / `_act:381-397` / `_react:454-470`
 *   · 消息三字段 `schema.py:232-242`（sent_from / send_to / cause_by）
 *   · 每角色私有收件箱 `MessageQueue` `schema.py:713-743`；
 *     路由 `base_env.py:175-195` + `common.py:423-431`
 *   · 订阅过滤 `_watch:284-288` + `_observe:410-412`（按 cause_by）
 *   · 收敛四闸 `role.py:113,461-469` / `end:431-432` / `team.py:98-100,123-136`
 *
 * 我们**不照抄**的：Pydantic 全模型、491 行 RoleZero 万能类、星形 MGX 路由。
 * 我们**不做**越界拦截：这里只管消息路由与收敛，不管权限。
 */

let SEQ = 0;

/** 一条消息：三字段是协议核心（谁发的 / 发给谁 / 因为什么） */
export function makeMessage({ sentFrom, sendTo = null, causeBy, content = '', at = null }) {
  if (!sentFrom) throw new Error('消息必须有 sentFrom');
  if (!causeBy) throw new Error('消息必须有 causeBy（订阅靠它过滤）');
  return { id: 'm' + (++SEQ), sentFrom, sendTo, causeBy, content, at: at ?? Date.now() };
}

/**
 * 消息总线：每条消息按 `sendTo` 与订阅者的 `watch` 路由到**私有**收件箱。
 * @param {{now?: () => number}} [deps]
 */
export function createBus(deps = {}) {
  const now = deps.now || (() => Date.now());
  /** roleName -> { watch:Set<string>, inbox:[] } */
  const members = new Map();
  const journal = [];

  function join(roleName, { watch = [] } = {}) {
    if (members.has(roleName)) throw new Error('角色已存在：' + roleName);
    members.set(roleName, { watch: new Set(watch), inbox: [] });
  }

  /** 是否该收这条消息：点名发给我，或我订阅了这个 causeBy */
  function accepts(roleName, msg) {
    const m = members.get(roleName);
    if (!m) return false;
    if (msg.sendTo && msg.sendTo !== roleName) return false;      // 点名发给别人
    if (msg.sendTo === roleName) return true;                     // 点名发给我
    return m.watch.has(msg.causeBy);                              // 否则看订阅
  }

  function publish(msg) {
    journal.push(msg);
    const delivered = [];
    for (const [name, m] of members) {
      if (accepts(name, msg)) { m.inbox.push(msg); delivered.push(name); }
    }
    return delivered;
  }

  return {
    join,
    publish,
    /** 只读某角色自己的收件箱（**别的角色读不到**） */
    inboxOf(roleName) {
      const m = members.get(roleName);
      if (!m) throw new Error('没有这个角色：' + roleName);
      return m.inbox.slice();
    },
    /** 取走（消费）该角色收件箱里的消息 */
    drain(roleName) {
      const m = members.get(roleName);
      if (!m) throw new Error('没有这个角色：' + roleName);
      const out = m.inbox.slice();
      m.inbox.length = 0;
      return out;
    },
    pending(roleName) {
      const m = members.get(roleName);
      return m ? m.inbox.length : 0;
    },
    journal: () => journal.slice(),
    now,
  };
}

/**
 * 跑一个团队。
 *
 * @param {object} bus createBus() 的结果
 * @param {Array<{name:string, handle:(msg,bus)=>any}>} roles
 * @param {{maxRounds?:number, budget?:number}} [opts]
 * @returns {{state:string, rounds:number, handled:number, why:string}}
 *
 * 收敛四闸（照 metagpt）：
 *   ① 所有收件箱都空 ⇒ idle（自然结束）
 *   ② 达到 maxRounds ⇒ capped
 *   ③ 达到 budget（处理消息条数）⇒ budget_exhausted
 *   ④ 某角色 handle 抛错 ⇒ error
 */
export function runTeam(bus, roles, opts = {}) {
  const maxRounds = opts.maxRounds ?? 10;
  const budget = opts.budget ?? Infinity;
  let handled = 0;
  let rounds = 0;

  for (; rounds < maxRounds; rounds++) {
    // 闸①：没有待处理消息 ⇒ 自然结束
    const pendingTotal = roles.reduce((a, r) => a + bus.pending(r.name), 0);
    if (pendingTotal === 0) {
      return { state: rounds === 0 ? 'idle' : 'drained', rounds, handled, why: '所有收件箱为空' };
    }
    for (const r of roles) {
      const msgs = bus.drain(r.name);
      for (const m of msgs) {
        // 闸③：预算
        if (handled >= budget) {
          return { state: 'budget_exhausted', rounds, handled, why: '处理条数到预算 ' + budget };
        }
        try {
          r.handle(m, bus);
        } catch (e) {
          return { state: 'error', rounds, handled, why: r.name + ' 处理失败：' + String(e && e.message).slice(0, 80) };
        }
        handled++;
      }
    }
  }
  // 闸②：轮数上限
  return { state: 'capped', rounds, handled, why: '达到 maxRounds ' + maxRounds + ' 仍有消息' };
}
