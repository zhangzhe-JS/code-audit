/**
 * 生成隔离清单表格（Markdown）：一张表列出一批排查对象的路径、状态、引入、失去引用
 * 纯函数：输入排查对象和配置，返回表格文本，不读写文件
 *
 * 显示哪些列、列的标题、状态文案都来自配置；不按任何项目的 README 格式写死
 * 只展示 JSON 里的内容，不做判断：没有 history 的显示「未查询」，不猜
 */
import { DEFAULT_CONFIG } from '../core/config.js'
import { formatCommit, escapeTableCell } from './format.js'

/**
 * @param {import('../core/schema.js').Item[]} items 按传入的顺序输出，调用方负责筛选和排序
 * @param {object} [opts]
 * @param {Readonly<import('../core/config.js').Config>} [opts.config]
 * @returns {string} Markdown 表格，末尾不带换行
 */
export function renderQuarantineTable(items, { config = DEFAULT_CONFIG } = {}) {
  const columns = config.tableColumns
  const cellOf = buildCells(config)

  const header = `| ${columns.map((c) => escapeTableCell(config.columnTitles[c])).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const rows = items.map((item) => `| ${columns.map((c) => escapeTableCell(cellOf[c](item))).join(' | ')} |`)

  return [header, divider, ...rows].join('\n')
}

/** 每一列的内容怎么取：返回的是原始文本，统一在外面转义 */
function buildCells(config) {
  const brief = (c) => formatCommit(c, { subject: false, hashLength: config.shortHashLength })
  // 表格里的提交说明按配置截断：合并提交的说明可能很长，会把列撑宽
  const max = config.tableSubjectMaxLength
  const cut = (s) => (max !== null && s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const full = (c) => formatCommit({ ...c, subject: cut(c.subject) }, { hashLength: config.shortHashLength })

  return {
    // id 去掉开头的类型：file:a.js → a.js，export:a.js#fn → a.js#fn，api:GET /x → GET /x
    target: (item) => item.id.slice(item.id.indexOf(':') + 1),

    origin: (item) => {
      const origin = item.history?.paths?.at(-1)
      return origin && origin !== item.target ? origin : '—'
    },

    status: (item) => `${item.status}（${config.statusLabels[item.status]}）`,

    // 引入是合并提交时，补上分支上真正写代码的人
    introduced: (item) => {
      const h = item.history
      if (!h) return '未查询'
      return h.introducedFrom ? `${brief(h.introduced)}（分支上 ${h.introducedFrom.author}）` : brief(h.introduced)
    },

    lostRef: (item) => {
      const h = item.history
      if (!h) return '未查询'
      if (h.lostRef) return full(h.lostRef)
      return h.timeline.length === 0 ? '从未被引用' : '仍被引用'
    },

    notes: (item) => (item.notes?.length ? item.notes.join('；') : '—')
  }
}
