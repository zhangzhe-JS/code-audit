/**
 * 从一份完整数据算出 report 命令要输出的全部文件（只在内存里，不写盘）
 *
 *   report.md            排查报告
 *   quarantine-table.md  隔离清单表格
 *   headers/<路径>.txt   每个文件的头注释，路径和 target 一致，不会重名
 *
 * 先全部算好再由命令统一写盘：中途出错时不会留下写了一半的目录
 * 生成不了头注释的项（没有历史、文件类型不能写注释）跳过并说明原因，不影响其他输出
 */
import { DEFAULT_CONFIG } from '../core/config.js'
import { validate } from '../core/schema.js'
import { renderReport } from './markdown.js'
import { renderQuarantineTable } from './quarantine-table.js'
import { renderHeader } from './header.js'

export const REPORT_FILE = 'report.md'
export const TABLE_FILE = 'quarantine-table.md'
export const HEADERS_DIR = 'headers'

/**
 * @param {import('../core/schema.js').Report} report
 * @param {object} [opts]
 * @param {Readonly<import('../core/config.js').Config>} [opts.config]
 * @param {string} [opts.movedAt] 头注释里的移入日期
 * @param {string} [opts.branch]  头注释里的分支
 * @returns {{files: {path: string, content: string}[], skipped: {id: string, reason: string}[]}}
 *   files 里的 path 是相对输出目录的路径，统一用 / 分隔
 */
export function buildOutputs(report, { config = DEFAULT_CONFIG, movedAt, branch } = {}) {
  const errors = validate(report)
  if (errors.length > 0) throw new Error(`数据不符合格式，无法生成：\n- ${errors.join('\n- ')}`)

  const files = [
    { path: REPORT_FILE, content: renderReport(report, { config }) },
    { path: TABLE_FILE, content: `${renderQuarantineTable(report.items, { config })}\n` }
  ]
  const skipped = []

  for (const item of report.items) {
    if (!item.history) {
      skipped.push({ id: item.id, reason: '没有 git 历史，请先运行 history' })
      continue
    }
    if (item.kind !== 'file') {
      skipped.push({ id: item.id, reason: `头注释只用于文件，这一项是 ${item.kind}` })
      continue
    }
    // target 已经过 schema 校验：是相对路径且不含 ..，拼出来的位置一定在 headers 目录里
    try {
      files.push({ path: `${HEADERS_DIR}/${item.target}.txt`, content: `${renderHeader(item, { config, movedAt, branch })}\n` })
    } catch (e) {
      skipped.push({ id: item.id, reason: e.message })
    }
  }

  return { files, skipped }
}
