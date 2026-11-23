#!/usr/bin/env node
/**
 * /api/collab —— 把多代理协作协议接进产品主链路
 *
 * 背景（独立审计 audit-a9 的降级理由原文）：
 *   「协议本身为真，但未接进产品主链路：全仓 createBus/runTeam 只有模块自身与测试在用；
 *    不在 audit-verifiers 扫描白名单、不在全工具自测与 evidence 驱动列表；
 *    出厂包与产品 profile 搜 cause_by/collab 零命中。」
 *
 * 这个 handler 就是补那一刀：产品服务器真的暴露协作协议。
 * 签名与 serve.mjs 里其它 handler 一致：`(req, res, done)`，自己解析 body、自己写响应
 * （serve.mjs 没有 readBody/json 这类助手，别假设它们存在 —— 我第一版就假设错了）。
 *
 * 协议本体来自 tools/collab/bus.mjs（搬自 metagpt roles/role.py:125、schema.py:232-242）。
 */
import { createBus, makeMessage, runTeam } from './bus.mjs';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function createCollabHandler() {
  return async function handleCollab(req, res, done) {
    try {
      let body;
      try {
        body = await readJson(req);
      } catch {
        send(res, 400, { ok: false, error: 'body 不是合法 JSON' });
        return;
      }
      const action = String(body?.action ?? '');

      if (action === 'ping') {
        send(res, 200, { ok: true, protocol: 'cause_by', version: 1 });
        return;
      }

      if (action === 'run') {
        const roles = Array.isArray(body.roles) ? body.roles : [];
        if (!roles.length) { send(res, 400, { ok: false, error: 'roles 必须是非空数组' }); return; }
        for (const r of roles) {
          if (typeof r?.name !== 'string' || !r.name) {
            send(res, 400, { ok: false, error: '每个角色都要有 name' });
            return;
          }
        }
        const maxRounds = Number.isFinite(body.maxRounds) ? body.maxRounds : 10;
        const budget = Number.isFinite(body.budget) ? body.budget : 200;

        // 第一个角色当协调者：kickoff 必须由**某个角色**发出，
        // 否则 ack 没有可回的收件人，cause_by 往返就断了（实测只有 kickoff 没有 ack）。
        const coordinator = roles[0].name;
        const bus = createBus();
        for (const r of roles) bus.join(r.name);

        for (const r of roles.slice(1)) {
          bus.publish(makeMessage({
            sentFrom: coordinator,
            sendTo: r.name,
            causeBy: 'kickoff',
            content: typeof r.task === 'string' ? r.task : '',
          }));
        }
        if (roles.length === 1) {
          // 【2026-11-18 修·P1】原为 `sentTo:` —— makeMessage 解构的是 `sendTo`，
        // 于是默认 null ⇒ 广播给 watch 订阅者 ⇒ 没人订阅 ⇒ 零投递。
        // 实测后果：state=idle、handled=0，但 journal 里留着一条 kickoff，**看起来像发了**。
        bus.publish(makeMessage({ sentFrom: coordinator, sendTo: coordinator, causeBy: 'kickoff', content: 'solo' }));
        }

        // 每个角色一个**真实处理函数**：收到 kickoff 就回一条 ack（走 cause_by 订阅）。
        // 不传 handle 会让 runTeam 抛 TypeError（r.handle is not a function），
        // 那样这个接口就是「看起来有实际是空」。
        const names = new Set(roles.map((r) => r.name));
        const wired = roles.map((r) => ({
          name: r.name,
          handle(m, b) {
            if (m.causeBy === 'kickoff' && names.has(m.sentFrom) && m.sentFrom !== r.name) {
              b.publish(makeMessage({
                sentFrom: r.name,
                sendTo: m.sentFrom,
                causeBy: 'ack',
                content: 'ack:' + String(m.content || '').slice(0, 40),
              }));
            }
          },
        }));
        const result = await runTeam(bus, wired, { maxRounds, budget });
        send(res, 200, {
          ok: true,
          state: result.state,
          rounds: result.rounds ?? null,
          handled: result.handled ?? null,
          journal: bus.journal(),
          pending: Object.fromEntries(roles.map((r) => [r.name, bus.pending(r.name)])),
        });
        return;
      }

      send(res, 400, { ok: false, error: '未知 action：' + action + '（支持 ping / run）' });
    } catch (e) {
      // 【2026-11-18 修·P0 未授权远程 DoS】
      // 原实现只有 try/finally，没有 catch。`bus.join()` 在角色重名时抛错，
      // 异常逃出 async 函数 ⇒ 未处理的 Promise 拒绝 ⇒ **整个 node 进程退出**。
      // 实测：POST /api/collab {"action":"run","roles":[{"name":"x"},{"name":"x"}]}
      //   → 服务器死，后续任何请求都连不上。这是单个请求打死产品服务器。
      //
      // 修法：catch 住一切异常，回 500 且**进程继续活**。
      // 这不是「越界拦截」（用户明确不做那类机制），是「自己不要崩」。
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: false,
            error: '协作模块内部错误：' + String(e && e.message ? e.message : e).slice(0, 160),
            note: '服务器仍在运行；这是本请求的错误，不是进程级故障',
          }));
        }
      } catch { /* 连回错误都失败就放弃这个请求，但绝不抛出去 */ }
    } finally {
      if (typeof done === 'function') done();
    }
  };
}
