/**
 * 生成文件头注释：放在隔离文件顶部的说明块
 * 纯函数：输入排查对象和配置，返回注释文本，不读写文件
 *
 * 标题、结尾提示、状态文案、各文件类型的注释格式都来自配置；代码里不写任何项目的路径和约定
 * 不支持的文件类型（如 .json 不能写注释）直接报错，不生成会破坏文件的内容
 */
import { extname } from 'node:path'
import { DEFAULT_CONFIG } from '../core/config.js'
import { formatCommit, escapeComment, escapeHtmlComment, groupTimeline } from './format.js'

/** 每条引用历史最多列出几个文件，超出的显示「等 N 个文件」 */
export const MAX_FILES_PER_LINE = 3

/**
 * @param {import('../core/schema.js').Item} item 必须已经有 history
 * @param {object} [opts]
 * @param {Readonly<import('../core/config.js').Config>} [opts.config] 项目配置
 * @param {string} [opts.movedAt]  移入隔离区的日期；不传就不显示这一行
 * @param {string} [opts.branch]   移入时所在的分支；只在有 movedAt 时显示
 * @param {number} [opts.maxFiles] 每条引用历史最多列出几个文件
 * @returns {string} 注释块，格式由文件扩展名决定（见配置 headerStyles），末尾不带换行
 */
export function renderHeader(item, { config = DEFAULT_CONFIG, movedAt, branch, maxFiles = MAX_FILES_PER_LINE } = {}) {
  const h = item.history
  if (!h) throw new Error(`${item.id} 还没有 git 历史，请先运行 history`)

  // 头注释要写进 target 这个文件，按它的扩展名决定注释格式
  const ext = extname(item.target)
  const style = config.headerStyles[ext]
  if (!style) {
    throw new Error(
      `不支持为 ${ext || '无扩展名'} 文件生成头注释：${item.target}。` +
      '如果这类文件可以写注释，请在配置 headerStyles 里指定注释格式（block 或 html）'
    )
  }

  const full = (c) => formatCommit(c, { hashLength: config.shortHashLength })
  const brief = (c) => formatCommit(c, { subject: false, hashLength: config.shortHashLength })

  const lines = [
    config.headerTitle,
    `状态：${item.status}（${config.statusLabels[item.status]}）`,
    `原路径：${h.paths?.at(-1) ?? item.target}`
  ]
  if (movedAt) lines.push(`移入：${movedAt}${branch ? `（分支 ${branch}）` : ''}`)
  lines.push(`引入：${full(h.introduced)}`)
  if (h.introducedFrom) lines.push(`  分支上新增：${full(h.introducedFrom)}`)

  lines.push('引用历史：')
  for (const g of groupTimeline(h.timeline)) {
    const parts = []
    if (g.added.length > 0) parts.push(`新增引用 ${listFiles(g.added, maxFiles)}`)
    if (g.removed.length > 0) parts.push(`去掉引用 ${listFiles(g.removed, maxFiles)}`)
    for (const r of g.renamed) parts.push(`引用方改名 ${r.from} → ${r.to}`)
    lines.push(`  - ${brief(g.commit)}：${parts.join('；')}`)
  }
  if (h.lostRef) lines.push(`  - 失去引用：${full(h.lostRef)}`)
  else if (h.timeline.length === 0) lines.push('  - 从未被引用')
  else lines.push('  - 仍被引用（时间线结束时还有引用方）')

  for (const note of item.notes ?? []) lines.push(`⚠️ ${note}`)
  lines.push(...config.headerFooter)

  // 每行先把换行换成空格（一行内容只占注释里的一行），再按注释格式转义、加前缀
  const oneLine = lines.map((l) => l.replace(/\r?\n/g, ' '))
  return COMMENT_RENDERERS[style](oneLine)
}

/** 各注释格式的写法：统一在这里转义，不会漏掉哪一行 */
const COMMENT_RENDERERS = {
  block: (lines) => ['/**', ...lines.map((l) => ` * ${escapeComment(l)}`), ' */'].join('\n'),
  html: (lines) => ['<!--', ...lines.map((l) => `  ${escapeHtmlComment(l)}`), '-->'].join('\n')
}

/** 列出文件，超过 max 个时只列前 max 个，后面写总数 */
function listFiles(files, max) {
  if (files.length <= max) return files.join('、')
  return `${files.slice(0, max).join('、')} 等 ${files.length} 个文件`
}