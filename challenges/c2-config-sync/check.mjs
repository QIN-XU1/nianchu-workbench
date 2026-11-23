#!/usr/bin/env node
// c2-config-sync 校验脚本
//
// 契约（见同目录 BRIEF.md）：
//   node check.mjs <sceneId>
//   数据目录：环境变量 SEA_DATA_DIR（默认 本脚本同目录下 data/）
//   通过：打印 "PASS <id>: 差异集合 = 0"，exit 0
//   失败：打印 "FAIL <id>: 差异集合 = N 项"，随后每项单独一行 "  - <具体项>"，exit 1
//
// 校验的不变量：
//   completeness — dev / staging / prod 三个环境的 key 集合必须完全一致
//   uniqueness   — 每个环境内部 key 不得重复
//
// 仅使用 node:fs / node:path。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENVS = ['dev', 'staging', 'prod']

const sceneId = process.argv[2] || 'c2-config-sync'
const dataDir = process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data')

/** @type {{phase: number, text: string}[]} */
const diffs = []

function addDiff(phase, text) {
  diffs.push({ phase, text })
}

function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function describeValue(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  const repr = JSON.stringify(v)
  return `${typeof v} ${repr.length > 40 ? `${repr.slice(0, 40)}…` : repr}`
}

function show(key) {
  return JSON.stringify(key)
}

// ---------------------------------------------------------------
// 阶段 1：读取三个环境的数据，并做基本结构校验
// envState: Map<env, string[] | null>  null 表示该环境数据不可用（读取/解析失败）
// ---------------------------------------------------------------
const envState = new Map()

for (const env of ENVS) {
  const file = `${env}.json`
  let raw
  try {
    raw = readFileSync(join(dataDir, file), 'utf8')
  } catch (err) {
    addDiff(1, `${file}: 无法读取（${err && err.code ? err.code : err && err.message ? err.message : String(err)}）`)
    envState.set(env, null)
    continue
  }

  let doc
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, '')) // 容忍文件头 BOM
  } catch (err) {
    addDiff(1, `${file}: JSON 解析失败（${err.message}）`)
    envState.set(env, null)
    continue
  }

  if (!Array.isArray(doc)) {
    addDiff(1, `${file}: 顶层应为数组，实际为 ${describeValue(doc)}`)
    envState.set(env, null)
    continue
  }

  const keys = []
  doc.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      addDiff(1, `${file}: 第 ${i + 1} 项应为对象，实际为 ${describeValue(entry)}`)
      return
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'key')) {
      addDiff(1, `${file}: 第 ${i + 1} 项缺少 key 字段`)
      return
    }
    if (typeof entry.key !== 'string' || entry.key.length === 0) {
      addDiff(1, `${file}: 第 ${i + 1} 项的 key 应为非空字符串，实际为 ${describeValue(entry.key)}`)
      return
    }
    keys.push(entry.key)
  })

  envState.set(env, keys)
}

// ---------------------------------------------------------------
// 阶段 2：uniqueness —— 每个环境内部 key 不得重复
// ---------------------------------------------------------------
for (const env of ENVS) {
  const keys = envState.get(env)
  if (keys === null) continue

  const counts = new Map()
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1)

  const dups = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => compareKeys(a[0], b[0]))

  for (const [key, c] of dups) {
    const positions = keys
      .map((k, i) => (k === key ? i + 1 : -1))
      .filter((i) => i > 0)
    addDiff(2, `${env}.json: key ${show(key)} 重复出现 ${c} 次（第 ${positions.join('、')} 项）`)
  }
}

// ---------------------------------------------------------------
// 阶段 3：completeness —— 三个环境的 key 集合必须完全一致
// 仅对数据可用的环境做比较；缺键按 (key, env) 逐项报告，便于定位
// ---------------------------------------------------------------
const knownEnvs = ENVS.filter((e) => envState.get(e) !== null)
const keySets = new Map(knownEnvs.map((e) => [e, new Set(envState.get(e))]))

const allKeys = [...new Set(knownEnvs.flatMap((e) => envState.get(e)))].sort(compareKeys)

for (const key of allKeys) {
  const holders = knownEnvs.filter((e) => keySets.get(e).has(key))
  for (const env of knownEnvs) {
    if (keySets.get(env).has(key)) continue
    addDiff(3, `${env}.json: 缺少 key ${show(key)}（该 key 存在于 ${holders.join('、')}）`)
  }
}

// ---------------------------------------------------------------
// 输出
// ---------------------------------------------------------------
diffs.sort((a, b) => (a.phase === b.phase ? 0 : a.phase - b.phase))

if (diffs.length === 0) {
  console.log(`PASS ${sceneId}: 差异集合 = 0`)
  process.exit(0)
}

console.log(`FAIL ${sceneId}: 差异集合 = ${diffs.length} 项`)
for (const d of diffs) {
  console.log(`  - ${d.text}`)
}
process.exit(1)
