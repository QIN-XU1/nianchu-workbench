#!/usr/bin/env node
// 自测脚本：node selftest.mjs
// 1) 原始 data/ 必须 PASS
// 2) 系统临时目录里造错误副本，逐个确认 FAIL 且差异集合命中
// 3) 原始 data/ 字节不变，临时目录自动清理

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const sceneDir = import.meta.dirname
const checkPath = join(sceneDir, 'check.mjs')
const dataDir = join(sceneDir, 'data')
const ID = 'c3-inventory-count'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'OK  ' : 'BAD '} ${name}${detail ? ' — ' + detail : ''}`)
}

function hashDir(dir) {
  const map = {}
  for (const f of ['book.json', 'count.json', 'master.json']) {
    map[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
  }
  return map
}

function runCheck(env) {
  const r = spawnSync(process.execPath, [checkPath, ID], {
    cwd: sceneDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: (r.stdout || '').replace(/\r\n/g, '\n').trim(), err: (r.stderr || '').trim() }
}

const before = hashDir(dataDir)

// ---------- 用例 1：原始数据 PASS ----------
{
  const r = runCheck({ SEA_DATA_DIR: '' })
  const ok = r.code === 0 && r.out === `PASS ${ID}: 差异集合 = 0` && r.err === ''
  record('原始 data/ 应 PASS', ok, `exit=${r.code} out=${JSON.stringify(r.out)}`)
}

// ---------- 临时目录 ----------
const tmpRoot = mkdtempSync(join(tmpdir(), 'c3-selftest-'))

/** 在临时目录构造一个数据副本并用它跑 check */
function scenario(name, files, expectSubstrings, expectCount) {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  const base = {
    'book.json': [
      { sku: 'SKU-A', qty: 10, name: '螺丝' },
      { sku: 'SKU-B', qty: 20, name: '螺母' },
    ],
    'count.json': [
      { sku: 'SKU-A', qty: 10 },
      { sku: 'SKU-B', qty: 20 },
    ],
    'master.json': ['SKU-A', 'SKU-B'],
  }
  const merged = { ...base, ...files }
  for (const [f, content] of Object.entries(merged)) {
    writeFileSync(join(dir, f), JSON.stringify(content, null, 2) + '\n', 'utf8')
  }
  const r = runCheck({ SEA_DATA_DIR: dir })
  const lines = r.out.split('\n')
  const head = lines[0] || ''
  const items = lines.slice(1).map((l) => l.replace(/^  - /, ''))

  const countOk = expectCount === undefined ? head.includes('FAIL') : head === `FAIL ${ID}: 差异集合 = ${expectCount} 项`
  const codeOk = r.code !== 0
  const substrOk = expectSubstrings.every((s) => r.out.includes(s))
  const wellFormed = lines.length > 1 && lines.slice(1).every((l) => l.startsWith('  - ') && l.length > 4)

  const ok = countOk && codeOk && substrOk && wellFormed
  record(
    name,
    ok,
    `exit=${r.code} head=${JSON.stringify(head)} 命中=${expectSubstrings.filter((s) => !r.out.includes(s)).length === 0 ? '全部' : '有缺失'}`
  )
  if (!ok) console.log(r.out)
  return r
}

// 错误 1：book 里某 SKU 在 count 缺失
scenario(
  '错误1 book 中 SKU-B 在 count 缺失',
  { 'count.json': [{ sku: 'SKU-A', qty: 10 }] },
  ['SKU-B', 'count.json 缺失']
)

// 错误 2：count 里出现 book 没有的 SKU
scenario(
  '错误2 count 出现 book 没有的 SKU-C',
  {
    'count.json': [
      { sku: 'SKU-A', qty: 10 },
      { sku: 'SKU-B', qty: 20 },
      { sku: 'SKU-C', qty: 5 },
    ],
    'master.json': ['SKU-A', 'SKU-B', 'SKU-C'],
  },
  ['SKU-C']
)

// 错误 3：同 SKU 两边 qty 不一致
scenario(
  '错误3 SKU-B qty 不一致 (20 vs 21)',
  {
    'count.json': [
      { sku: 'SKU-A', qty: 10 },
      { sku: 'SKU-B', qty: 21 },
    ],
  },
  ['SKU-B', 'qty 不一致']
)

// 错误 4a：SKU 不在 master.json
scenario(
  '错误4a SKU-B 不在 master.json',
  { 'master.json': ['SKU-A'] },
  ['SKU-B', '不在 master.json'],
  2 // book 与 count 各报一条
)

// 错误 4b：name 为空
scenario(
  '错误4b SKU-B name 为空',
  {
    'book.json': [
      { sku: 'SKU-A', qty: 10, name: '螺丝' },
      { sku: 'SKU-B', qty: 20, name: '  ' },
    ],
  },
  ['SKU-B', 'name 为空'],
  1
)

// ---------- 清理 & 原始数据未变 ----------
rmSync(tmpRoot, { recursive: true, force: true })
record('临时目录已清理', !existsSync(tmpRoot), tmpRoot)

const after = hashDir(dataDir)
const unchanged = JSON.stringify(before) === JSON.stringify(after)
record('原始 data/ 字节未变（SHA256 一致）', unchanged, unchanged ? '一致' : `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n自测结果：${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
