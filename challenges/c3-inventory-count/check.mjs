#!/usr/bin/env node
// 库存盘点校验脚本（严格按 BRIEF.md 契约）
//
// 契约：
//   node check.mjs <sceneId>
//   数据目录：process.env.SEA_DATA_DIR ?? join(import.meta.dirname, 'data')
//   通过：stdout 一行 `PASS <id>: 差异集合 = 0`，exit 0
//   失败：stdout 一行 `FAIL <id>: 差异集合 = N 项`，随后每项一行 `  - <具体项>`，exit 非 0
//   只使用 node:fs / node:path 内置模块，容忍 UTF-8 BOM。
//
// 校验的不变量：
//   completeness          — book 与 count 的 SKU 集合必须完全相同
//   referential-integrity — 所有 SKU 必须出现在 master.json
//   required-field        — book 中 name 不得为空；sku / qty 必须存在且合法
//   （业务语义）           — 同一 SKU 两边 qty 必须相等

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_ID = 'c3-inventory-count'
const ID = process.argv[2] || DEFAULT_ID

const dataDir = process.env.SEA_DATA_DIR
  ? process.env.SEA_DATA_DIR
  : join(import.meta.dirname, 'data')

/** 差异集合：每项都是可按行定位到具体数据的字符串 */
const diffs = []

function addDiff(line) {
  if (!diffs.includes(line)) diffs.push(line)
}

/** 读取 JSON，容忍 UTF-8 BOM，错误转为可定位的差异项 */
function readJson(fileName) {
  const full = join(dataDir, fileName)
  let raw
  try {
    raw = readFileSync(full, 'utf8')
  } catch (err) {
    addDiff(`${fileName} 无法读取（${full}）：${err && err.message ? err.message : String(err)}`)
    return undefined
  }
  // 去 BOM：容忍开头 0..n 个 U+FEFF
  // （PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写入 preamble BOM，
  //   若内容本身以 U+FEFF 开头就会叠加成多个 BOM。）
  while (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1)
  }
  if (raw.trim() === '') {
    addDiff(`${fileName} 为空文件（${full}）`)
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    addDiff(`${fileName} JSON 解析失败（${full}）：${err && err.message ? err.message : String(err)}`)
    return undefined
  }
}

function typeName(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

function asRows(value, fileName) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    addDiff(`${fileName} 顶层应为数组，实际为 ${typeName(value)}`)
    return []
  }
  const rows = []
  for (let i = 0; i < value.length; i++) {
    const row = value[i]
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      addDiff(`${fileName} 第 ${i + 1} 项应为对象，实际为 ${typeName(row)}`)
      continue
    }
    rows.push({ index: i, row })
  }
  return rows
}

const EMPTY = Symbol('empty')
function normSku(v) {
  if (typeof v === 'string') {
    const s = v.trim()
    return s === '' ? EMPTY : s
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return EMPTY
}

function qtyOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return { ok: true, value: v }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return { ok: true, value: n }
  }
  return { ok: false, value: v }
}

function show(v) {
  if (v === undefined) return '（缺失）'
  if (typeof v === 'string') return `"${v}"`
  if (v === null) return 'null'
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function label(row, fileName) {
  return `${fileName} 第 ${row.index + 1} 项`
}

// ---------- 1. 读取 ----------
const bookRaw = readJson('book.json')
const countRaw = readJson('count.json')
const masterRaw = readJson('master.json')

const bookRows = asRows(bookRaw, 'book.json')
const countRows = asRows(countRaw, 'count.json')

// ---------- 2. master.json：SKU 白名单 ----------
const masterSet = new Set()
if (masterRaw !== undefined) {
  if (!Array.isArray(masterRaw)) {
    addDiff(`master.json 顶层应为 SKU 数组，实际为 ${typeName(masterRaw)}`)
  } else {
    for (let i = 0; i < masterRaw.length; i++) {
      const item = masterRaw[i]
      let sku = EMPTY
      if (typeof item === 'string') sku = normSku(item)
      else if (item && typeof item === 'object') sku = normSku(item.sku)
      if (sku === EMPTY) {
        addDiff(`master.json 第 ${i + 1} 项缺少有效 SKU：${show(item)}`)
        continue
      }
      masterSet.add(sku)
    }
  }
}

// ---------- 3. book.json：必填字段 + 主数据外键 + 重复 ----------
const bookBySku = new Map() // sku -> { qty, name, label }
for (const { index, row } of bookRows) {
  const loc = label({ index }, 'book.json')
  const sku = normSku(row.sku)
  if (sku === EMPTY) {
    addDiff(`${loc} 缺少有效 sku`)
    continue
  }
  if (bookBySku.has(sku)) {
    addDiff(`${loc} 的 sku "${sku}" 重复（首次出现在 ${bookBySku.get(sku).loc}）`)
  } else {
    bookBySku.set(sku, { qty: undefined, name: undefined, loc })
  }
  const entry = bookBySku.get(sku)

  if (typeof row.name !== 'string' || row.name.trim() === '') {
    addDiff(`${loc} 的 sku "${sku}" name 为空`)
  }
  entry.name = row.name

  const qty = qtyOf(row.qty)
  if (!qty.ok) {
    addDiff(`${loc} 的 sku "${sku}" qty 缺失或非数字：${show(row.qty)}`)
  } else {
    entry.qty = qty.value
  }

  if (!masterSet.has(sku)) {
    addDiff(`${loc} 的 sku "${sku}" 不在 master.json`)
  }
}

// ---------- 4. count.json：实盘外键 + 重复 ----------
const countBySku = new Map() // sku -> { qty, loc }
for (const { index, row } of countRows) {
  const loc = label({ index }, 'count.json')
  const sku = normSku(row.sku)
  if (sku === EMPTY) {
    addDiff(`${loc} 缺少有效 sku`)
    continue
  }
  if (countBySku.has(sku)) {
    addDiff(`${loc} 的 sku "${sku}" 重复（首次出现在 ${countBySku.get(sku).loc}）`)
  } else {
    countBySku.set(sku, { qty: undefined, loc })
  }
  const entry = countBySku.get(sku)

  const qty = qtyOf(row.qty)
  if (!qty.ok) {
    addDiff(`${loc} 的 sku "${sku}" qty 缺失或非数字：${show(row.qty)}`)
  } else {
    entry.qty = qty.value
  }

  if (!masterSet.has(sku)) {
    addDiff(`${loc} 的 sku "${sku}" 不在 master.json`)
  }
}

// ---------- 5. completeness：SKU 集合对称差 ----------
for (const [sku, entry] of bookBySku) {
  if (!countBySku.has(sku)) {
    addDiff(`book.json 有 sku "${sku}"（${entry.loc}），count.json 缺失该实盘记录`)
  }
}
for (const [sku, entry] of countBySku) {
  if (!bookBySku.has(sku)) {
    addDiff(`count.json 有 sku "${sku}"（${entry.loc}），book.json 无对应账面记录`)
  }
}

// ---------- 6. qty 一致性 ----------
for (const [sku, bookEntry] of bookBySku) {
  const countEntry = countBySku.get(sku)
  if (!countEntry) continue // 缺失已由完整性检查覆盖
  if (!Number.isFinite(bookEntry.qty) || !Number.isFinite(countEntry.qty)) continue // 缺失/非法已单独报告
  if (bookEntry.qty !== countEntry.qty) {
    addDiff(`sku "${sku}" qty 不一致：book.json=${bookEntry.qty}（${bookEntry.loc}），count.json=${countEntry.qty}（${countEntry.loc}）`)
  }
}

// ---------- 输出 ----------
if (diffs.length === 0) {
  console.log(`PASS ${ID}: 差异集合 = 0`)
  process.exit(0)
}

console.log(`FAIL ${ID}: 差异集合 = ${diffs.length} 项`)
for (const line of diffs) console.log(`  - ${line}`)
process.exit(1)
