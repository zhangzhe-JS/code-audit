/**
 * 生成文件头注释：放在隔离文件顶部的说明块
 * 纯函数：输入排查对象和配置，返回注释文本，不读写文件
 *
 * 标题和结尾提示来自配置；代码里不写任何项目的路径和约定
 */
import { DEFAULT_CONFIG } from '../core/config.js'
import { STATUS_LABELS } from '../core/schema.js'
import { formatCommit, escapeComment, groupTimeline } from './format.js'

/** 每条引用历史最多列出几个文件，超出的显示「等 N 个文件」 */
export const MAX_FILES_PER_LINE = 3

/**
 * @param {import('../core/schema.js').Item} item 必须已经有 history
 * @param {object} [opts]
 * @param {Readonly<import('../core/config.js').Config>} [opts.config] 项目配置
 * @param {string} [opts.movedAt]  移入隔离区的日期；不传就不显示这一行
 * @param {string} [opts.branch]   移入时所在的分支；只在有 movedAt 时显示
 * @param {number} [opts.maxFiles] 每条引用历史最多列出几个文件
 * @returns {string} 以 /** 开头、以 *\/ 结尾，末尾不带换行
 */
export function renderHeader(item, { config = DEFAULT_CONFIG, movedAt, branch, maxFiles = MAX_FILES_PER_LINE } = {}) {
  const h = item.history
  if (!h) throw new Error(`${item.id} 还没有 git 历史，请先运行 history`)

  const full = (c) => formatCommit(c, { hashLength: config.shortHashLength })
  const brief = (c) => formatCommit(c, { subject: false, hashLength: config.shortHashLength })

  const lines = [
    config.headerTitle,
    `状态：${item.status}（${STATUS_LABELS[item.status]}）`,
    `原路径：${h.paths?.at(-1) ?? item.target}`
  ]
  if (movedAt) lines.push(`移入：${movedAt}${branch ? `（分支 ${branch}）` : ''}`)
  lines.push(`引入：${full(h.introduced)}`)

  lines.push('引用历史：')
  for (const g of groupTimeline(h.timeline)) {
    const parts = []
    if (g.added.length > 0) parts.push(`新增引用 ${listFiles(g.added, maxFiles)}`)
    if (g.removed.length > 0) parts.push(`去掉引用 ${listFiles(g.removed, maxFiles)}`)
    lines.push(`  - ${brief(g.commit)}：${parts.join('；')}`)
  }
  if (h.lostRef) lines.push(`  - 失去引用：${full(h.lostRef)}`)
  else if (h.timeline.length === 0) lines.push('  - 从未被引用')
  else lines.push('  - 仍被引用（时间线结束时还有引用方）')

  for (const note of item.notes ?? []) lines.push(`⚠️ ${note}`)
  lines.push(...config.headerFooter)

  // 每行都转义 *\/，并把换行换成空格：一行内容只占注释里的一行
  const body = lines.map((l) => ` * ${escapeComment(l.replace(/\r?\n/g, ' '))}`)
  return ['/**', ...body, ' */'].join('\n')
}

/** 列出文件，超过 max 个时只列前 max 个，后面写总数 */
function listFiles(files, max) {
  if (files.length <= max) return files.join('、')
  return `${files.slice(0, max).join('、')} 等 ${files.length} 个文件`
}