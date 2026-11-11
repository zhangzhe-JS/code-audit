/**
 * 导出维度的历史和报告
 *
 * 历史：没人用的导出（dead、dead-only-ref、internal、test-only）在哪个提交失去了外部引用；
 *       从没被别的文件引用过的，记下定义提交。复用接口维度按函数查历史的逻辑（src/api/history.js）
 * 报告：Markdown（按状态分组，每条写明建议）和 CSV（Excel 直接打开，留一列处理意见）
 */
import { createContext, traceDefinition } from '../api/history.js'
import { EXPORTS_SCHEMA_VERSION, EXPORT_STATUSES, EXPORT_SUGGESTIONS } from './scan.js'

const TRACED = new Set(['dead', 'dead-only-ref', 'internal', 'test-only'])

/**
 * 给结果补上历史（直接改 result）
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} opts.result scanExports 的结果
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {(done: number, total: number) => void} [opts.progress]
 */
export function traceExportsHistory({ root, result, config, progress }) {
  const rev = result.project.rev
  const targets = result.items.filter((c) => TRACED.has(c.status) && !c.reexport)
  const ctx = createContext({ root, rev, config, names: [...new Set(targets.map((c) => c.name))] })
  targets.forEach((c, i) => {
    const h = traceDefinition({ root, rev, file: c.file, fn: c.name, config, ctx })
    if (h.lostRef) c.history = { type: 'lost', ...h.lostRef }
    else if (h.introduced) c.history = { type: 'never', introduced: h.introduced }
    else c.history = null
    if (h.unresolved) c.historyNote = h.unresolved
    progress?.(i + 1, targets.length)
  })
  result.historyTraced = true
  return result
}

/**
 * 校验 exports 的结果：格式和结论之间是否自洽。只返回错误列表，不抛异常
 * @param {unknown} r
 */
export function validateExportsResult(r) {
  const errors = []
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const isStr = (v) => typeof v === 'string' && v !== ''
  if (!isObj(r)) return ['不是 JSON 对象']
  if (r.kind !== 'exports') errors.push(`kind 必须是 "exports"（现在是 ${JSON.stringify(r.kind)}）：不是 code-audit exports 的结果？`)
  if (r.version !== EXPORTS_SCHEMA_VERSION) errors.push(`version 必须是 ${EXPORTS_SCHEMA_VERSION}：用当前版本的 code-audit exports 重新生成`)
  if (!isObj(r.project) || !isStr(r.project.name) || !isStr(r.project.rev)) errors.push('project 必须有 name、rev')
  if (!Array.isArray(r.items)) return [...errors, 'items 必须是数组']
  if (!isObj(r.summary) || r.summary.candidates !== r.items.length) errors.push(`summary.candidates（${r.summary?.candidates}）和清单条数（${r.items.length}）对不上`)
  const seen = new Set()
  r.items.forEach((c, i) => {
    const at = `items[${i}]${isObj(c) && isStr(c.file) ? `（${c.file}#${c.name}）` : ''}`
    if (!isObj(c)) return errors.push(`${at} 必须是对象`)
    if (!isStr(c.file) || !isStr(c.name)) errors.push(`${at} 必须有 file、name`)
    const key = `${c.file}#${c.name}`
    if (seen.has(key)) errors.push(`${at} 重复`)
    seen.add(key)
    if (!EXPORT_STATUSES.includes(c.status)) errors.push(`${at}.status 不认识：${JSON.stringify(c.status)}`)
    if (!Array.isArray(c.evidence) || c.evidence.length === 0 || !c.evidence.every((e) => isObj(e) && typeof e.detail === 'string')) errors.push(`${at}.evidence 必须是非空的 { detail } 数组`)
    if (r.historyTraced !== true && c.history !== undefined && c.history !== null) errors.push(`${at} 有历史，但结果没有标明查过历史`)
  })
  return errors
}

const STATUS_TEXT = { unknown: '无法判定', external: '图外在用', pending: '其他分支在用', dormant: '注释停用', 'test-only': '只有测试用', internal: '本文件内在用', 'dead-only-ref': '只被死代码引用', dead: '没人用' }

function historyText(c) {
  const h = c.history
  if (!h) return c.historyNote ?? ''
  if (h.type === 'never') return `从没被别的文件引用；定义于 ${h.introduced.date} ${h.introduced.hash.slice(0, 8)} ${h.introduced.author}：${h.introduced.subject}`
  const k = h.commitFrom ?? h.commit
  return `${k.date} ${k.hash.slice(0, 8)} ${k.author}：${k.subject}（${h.from} 不再引用）`
}

/** CSV（UTF-8 带 BOM） */
export function exportsCsv(r) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [['状态', '建议', '文件', '行', '导出名', '依据', '失去引用 / 定义提交', '处理意见'].map(esc).join(',')]
  for (const c of sorted(r.items)) {
    lines.push([STATUS_TEXT[c.status], EXPORT_SUGGESTIONS[c.status], c.file, c.line ?? '', c.name, c.evidence.map((e) => e.detail).join('；'), historyText(c), ''].map(esc).join(','))
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

export function exportsMarkdown(r, { now = new Date() } = {}) {
  const out = ['# 导出排查报告', '', `生成时间：${now.toISOString().slice(0, 10)}　项目：${r.project.name}　提交：${r.project.rev.slice(0, 8)}　查了历史：${r.historyTraced ? '是' : '否'}`, '']
  out.push('| 状态 | 个数 | 建议 |', '| --- | --- | --- |')
  for (const s of EXPORT_STATUSES) {
    const n = r.items.filter((c) => c.status === s).length
    if (n > 0) out.push(`| ${STATUS_TEXT[s]}（${s}） | ${n} | ${EXPORT_SUGGESTIONS[s]} |`)
  }
  out.push('', '> 只看从入口走得到的文件里的导出（走不到的文件见文件维度的 scan）。删之前跑构建和测试，小批量处理。')
  if (r.summary?.testEntries === false) out.push('>', '> **注意**：profile 没写 testEntries，只有测试在用的导出也判成了没人用，删之前确认测试有没有引用。')
  out.push('')
  for (const s of EXPORT_STATUSES) {
    const list = sorted(r.items.filter((c) => c.status === s))
    if (list.length === 0) continue
    out.push(`## ${STATUS_TEXT[s]}（${list.length}）`, '', `建议：${EXPORT_SUGGESTIONS[s]}`, '')
    out.push('| 文件 | 导出名 | 依据 | 失去引用 / 定义提交 |', '| --- | --- | --- | --- |')
    for (const c of list) out.push(`| \`${c.file}${c.line ? `:${c.line}` : ''}\` | \`${c.name}\` | ${cell(c.evidence.map((e) => e.detail).join('；'))} | ${cell(historyText(c))} |`)
    out.push('')
  }
  return `${out.join('\n')}\n`
}

function sorted(list) {
  return [...list].sort((a, b) => EXPORT_STATUSES.indexOf(a.status) - EXPORT_STATUSES.indexOf(b.status) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
}

function cell(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}
