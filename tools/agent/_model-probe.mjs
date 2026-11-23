/**
 * 模型可用性探针（第 190 轮新增，第 220 轮修正）
 *
 * 为什么：本环境网关进程在（/models 能列 834 个），但账号返回 401「User not affiliated」，
 * completions 一律失败；视觉模型还返回 400 model_not_supported。多个 verify 脚本原先把
 * 「模型不可用」当成「代码缺陷」判 FAIL——这是把环境的锅甩给代码。
 *
 * 【第 220 轮修的第二个坑】探针原本用 `maxTokens: 8`，而推理模型会把这点预算全花在
 * reasoning 上，`choices[0].message.content` 为空 → 被当成「模型不可用」判 FAIL。
 * 实测：maxTokens 8/32 空、64/128 正常。**探针自己制造了假阴性**，让 12 个验收器
 * 白白标 UNKNOWN。现在用 64——足够让推理模型吐出可见内容。
 *
 * 用法：在真跑段前 `if (!(await modelAvailable())) { 标 UNKNOWN 跳过 }`。
 * 结果缓存，多次调用只探一次。
 */
import { callWithFailover } from './models.mjs';

let _cached = null;
export async function modelAvailable() {
  if (_cached !== null) return _cached;
  try {
    const r = await callWithFailover({
      messages: [{ role: 'user', content: 'ping' }],
      role: 'default',
      maxTokens: 64,
    });
    _cached = r && r.state === 'PASS';
  } catch {
    _cached = false;
  }
  return _cached;
}
export function _resetModelProbe() { _cached = null; }