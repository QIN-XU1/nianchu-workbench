/**
 * 构建「Agent 自写 check」实验场。
 *
 * 设计：
 *   挑战场景只提供 scene.json（含 protects）+ data/ + baseline/
 *   **不提供 check.mjs** —— 必须由 Agent 自己写。
 *
 * 这样测的是：一个不知道我设计的 Agent，仅凭契约能否写出通过门禁的 check。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..', 'challenges');

if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

/** 每个挑战：id / name / desc / protects / data 文件内容 / 一句"它该保证什么" */
const CHALLENGES = [
  {
    id: 'c1-order-ledger',
    name: '订单台账',
    desc: '订单与发货记录必须一一对应，金额一致',
    protects: ['completeness', 'uniqueness', 'referential-integrity'],
    brief: 'orders.json 是订单列表（每项有 id / amount / status）。shipments.json 是发货记录（每项有 id / orderId / amount）。任意订单必须有对应发货记录；任意发货记录必须指向存在的订单；orderId 不得重复；金额必须一致。',
    files: {
      'orders.json': [
        { id: 'O-1', amount: 120, status: 'paid' },
        { id: 'O-2', amount: 80, status: 'paid' },
        { id: 'O-3', amount: 200, status: 'pending' },
      ],
      'shipments.json': [
        { id: 'S-1', orderId: 'O-1', amount: 120 },
        { id: 'S-2', orderId: 'O-2', amount: 80 },
        { id: 'S-3', orderId: 'O-3', amount: 200 },
      ],
    },
  },
  {
    id: 'c2-config-sync',
    name: '配置同步',
    desc: '三个环境的配置键集合必须一致',
    protects: ['completeness', 'uniqueness'],
    brief: 'dev.json / staging.json / prod.json 是三个环境的配置项数组（每项有 key / value）。三个环境必须拥有相同的 key 集合（不允许某环境缺键或多键）。每个环境内部 key 不得重复。',
    files: {
      'dev.json': [{ key: 'timeout', value: 30 }, { key: 'retries', value: 3 }, { key: 'logLevel', value: 'debug' }],
      'staging.json': [{ key: 'timeout', value: 60 }, { key: 'retries', value: 3 }, { key: 'logLevel', value: 'info' }],
      'prod.json': [{ key: 'timeout', value: 60 }, { key: 'retries', value: 5 }, { key: 'logLevel', value: 'warn' }],
    },
  },
  {
    id: 'c3-inventory-count',
    name: '库存盘点',
    desc: '账面库存与实盘记录一致，且 SKU 必须在主数据',
    protects: ['completeness', 'referential-integrity', 'required-field'],
    brief: 'book.json 是账面库存（每项有 sku / qty / name）。count.json 是实盘记录（每项有 sku / qty）。每个 SKU 必须有实盘记录（反之亦然）；qty 必须相等；SKU 必须在 master.json 列表里；name 不得为空。',
    files: {
      'book.json': [
        { sku: 'SKU-A', qty: 10, name: '螺丝' },
        { sku: 'SKU-B', qty: 20, name: '螺母' },
      ],
      'count.json': [
        { sku: 'SKU-A', qty: 10 },
        { sku: 'SKU-B', qty: 20 },
      ],
      'master.json': ['SKU-A', 'SKU-B'],
    },
  },
];

for (const c of CHALLENGES) {
  const dir = join(ROOT, c.id);
  const data = join(dir, 'data');
  const base = join(dir, 'baseline');
  mkdirSync(data, { recursive: true });
  mkdirSync(base, { recursive: true });

  for (const [f, v] of Object.entries(c.files)) {
    const text = JSON.stringify(v, null, 2);
    writeFileSync(join(data, f), text, 'utf8');
    writeFileSync(join(base, f), text, 'utf8');
  }

  writeFileSync(join(dir, 'scene.json'), JSON.stringify({
    id: c.id,
    name: c.name,
    desc: c.desc,
    check: 'check.mjs',
    baselineDir: 'baseline',
    protects: c.protects,
  }, null, 2), 'utf8');

  // 契约说明（给 Agent 看的唯一材料）
  writeFileSync(join(dir, 'BRIEF.md'), [
    `# ${c.name}`,
    '',
    c.desc,
    '',
    '## 你必须保证的不变量',
    '',
    c.protects.map(p => '- `' + p + '`').join('\n'),
    '',
    '## 业务语义',
    '',
    c.brief,
    '',
    '## check 脚本契约',
    '',
    '- 文件：同目录下 `check.mjs`',
    '- 运行时：`node check.mjs <sceneId>`',
    '- 数据目录：环境变量 `SEA_DATA_DIR`（默认同目录 `data/`）',
    '- 退出码：0 = 通过；非 0 = 失败',
    '- **失败时必须输出一行 `FAIL <id>: 差异集合 = N 项`，随后每项一行 `  - <具体项>`**',
    '- 通过时输出 `PASS <id>: 差异集合 = 0`',
    '- 只允许用 Node 内置模块（node:fs / node:path）',
    '',
    '## 可用数据',
    '',
    Object.keys(c.files).map(f => '- `' + f + '`').join('\n'),
  ].join('\n'), 'utf8');

  console.log(`created challenge: ${c.id}  (protects: ${c.protects.join(', ')})`);
}

console.log(`\n实验场：${ROOT}`);
