import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sceneId = process.argv[2] ?? 'c1-order-ledger';
const dataDir = process.env.SEA_DATA_DIR ?? join(import.meta.dirname, 'data');

function loadJson(name) {
  const raw = readFileSync(join(dataDir, name), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${name} 顶层不是数组`);
  return parsed;
}

const diffs = [];
const push = (msg) => diffs.push(msg);

let orders;
let shipments;
try {
  orders = loadJson('orders.json');
  shipments = loadJson('shipments.json');
} catch (err) {
  diffs.push(`数据加载失败: ${err.message}`);
  orders = [];
  shipments = [];
}

{
  const orderById = new Map();
  const seenOrderIds = new Set();
  for (const [i, o] of orders.entries()) {
    const id = o?.id;
    if (typeof id !== 'string' || id.length === 0) {
      push(`orders.json 第 ${i + 1} 项缺少有效 id（值: ${JSON.stringify(id)}）`);
      continue;
    }
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) {
      push(`订单 ${id} 的 amount 不是有效数字（值: ${JSON.stringify(o.amount)}）`);
    }
    if (seenOrderIds.has(id)) {
      push(`订单 id 重复: ${id}（uniqueness 不变量被破坏）`);
    } else {
      seenOrderIds.add(id);
    }
    orderById.set(id, o);
  }

  const seenShipmentIds = new Set();
  const shipmentsByOrderId = new Map();

  for (const [i, s] of shipments.entries()) {
    const sid = s?.id;
    const orderId = s?.orderId;

    if (typeof sid !== 'string' || sid.length === 0) {
      push(`shipments.json 第 ${i + 1} 项缺少有效 id（值: ${JSON.stringify(sid)}）`);
    } else if (seenShipmentIds.has(sid)) {
      push(`发货记录 id 重复: ${sid}（uniqueness 不变量被破坏）`);
    } else {
      seenShipmentIds.add(sid);
    }

    if (typeof orderId !== 'string' || orderId.length === 0) {
      push(`发货记录 ${JSON.stringify(sid)} 缺少有效 orderId（值: ${JSON.stringify(orderId)}）`);
      continue;
    }

    const label = `发货记录 ${sid ?? `#${i + 1}`}（orderId=${orderId}）`;

    if (!orderById.has(orderId)) {
      push(`${label} 指向不存在的订单：orderId=${orderId}（referential-integrity 不变量被破坏）`);
    }

    const prev = shipmentsByOrderId.get(orderId);
    if (prev !== undefined) {
      push(`orderId 重复: ${orderId} 同时被发货记录 ${prev} 和 ${sid ?? `#${i + 1}`} 引用（每个订单只能有一条发货记录）`);
    } else {
      shipmentsByOrderId.set(orderId, sid ?? `#${i + 1}`);
    }

    const order = orderById.get(orderId);
    if (order && typeof order.amount === 'number' && Number.isFinite(order.amount)) {
      if (typeof s.amount !== 'number' || !Number.isFinite(s.amount)) {
        push(`${label} 的 amount 不是有效数字（值: ${JSON.stringify(s.amount)}），订单金额为 ${order.amount}`);
      } else if (s.amount !== order.amount) {
        push(`金额不一致: 订单 ${orderId} amount=${order.amount}，但发货记录 ${sid ?? `#${i + 1}`} amount=${s.amount}`);
      }
    }
  }

  for (const [id, o] of orderById) {
    if (seenOrderIds.has(id) && !shipmentsByOrderId.has(id)) {
      push(`订单 ${id} 缺少对应发货记录（completeness 不变量被破坏）`);
    }
  }
}

if (diffs.length === 0) {
  console.log(`PASS ${sceneId}: 差异集合 = 0`);
  process.exit(0);
}

console.log(`FAIL ${sceneId}: 差异集合 = ${diffs.length} 项`);
for (const d of diffs) console.log(`  - ${d}`);
process.exit(1);
