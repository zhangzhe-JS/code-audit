/**
 * 生成排查报告（Markdown）：概况 → 状态汇总 → 清单表格 → 每一项的详情
 * 纯函数：输入整份数据和配置，返回报告文本，不读写文件
 *
 * 只展示 JSON 里的内容，不做判断；输入不符合格式就报错，不生成半成品
 * 状态文案、表格的列、提交号长度来自配置
 */
import { DEFAULT_CONFIG } from '../core/config.js'
import { STATUSES, validate } from '../core/schema.js'
import { formatCommit, shortHash, groupTimeline, oneLine, inlineCode, escapeTableCell } from './format.js'
import { renderQuarantineTable } from './quarantine-table.js'

/**
 * @param {import('../core/schema.js').Report} report
 * @param {object} [opts]
 * @param {Readonly<import('../core/config.js').Config>} [opts.config]
 * @returns {string} 以换行结尾的 Markdown 文本
 */
export function renderReport(report, { config = DEFAULT_CONFIG } = {}) {
  const errors = validate(report)
  if (errors.length > 0) {
    throw new Error(`数据不符合格式，无法生成报告：\n- ${errors.join('\n- ')}`)
  }

  const sections = [
    renderOverview(report, config),
    renderSummary(report.items, config),
    `## 清单\n\n${renderQuarantineTable(report.items, { config })}`,
    renderDetails(report.items, config)
  ]
  return `${sections.join('\n\n')}\n`
}

/** 概况：项目、分析的提交、入口、生成时间 */
function renderOverview(report, config) {
  const { project, tool } = report
  return [
    `# 排查报告：${oneLine(project.name)}`,
    '',
    `- 分析提交：${inlineCode(shortHash(project.rev, config.shortHashLength))}`,
    `- 入口：${project.entries.length ? project.entries.map(inlineCode).join('、') : '无'}`,
    `- 生成时间：${report.generatedAt}`,
    `- 生成工具：${oneLine(tool.name)} ${oneLine(tool.version)}`
  ].join('\n')
}

/** 状态汇总：按状态优先级排列，只列出现过的状态，最后一行是合计 */
function renderSummary(items, config) {
  const counts = new Map()
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)

  const rows = STATUSES
    .filter((s) => counts.has(s))
    // 状态文案来自配置，可能带 | 或换行，和其他表格单元格一样要转义
    .map((s) => `| ${escapeTableCell(`${s}（${config.statusLabels[s]}）`)} | ${counts.get(s)} |`)

  return [
    '## 状态汇总',
    '',
    '| 状态 | 数量 |',
    '| --- | --- |',
    ...rows,
    `| 合计 | ${items.length} |`
  ].join('\n')
}

/** 每一项的详情：证据、引用、历史、验证、备注 */
function renderDetails(items, config) {
  if (items.length === 0) return '## 详情\n\n无'
  return ['## 详情', ...items.map((item) => renderItem(item, config))].join('\n\n')
}

function renderItem(item, config) {
  const full = (c) => formatCommit(c, { hashLength: config.shortHashLength })
  const brief = (c) => formatCommit(c, { subject: false, hashLength: config.shortHashLength })
  const lines = [`### ${inlineCode(item.id)}`, '']

  lines.push(`- 状态：${item.status}（${config.statusLabels[item.status]}）`)

  lines.push('- 证据：')
  for (const ev of item.evidence) {
    const tag = ev.tag ? `（标签：${ev.tag}）` : ''
    lines.push(`  - [${ev.rule}] ${oneLine(ev.detail)}${tag}`)
  }

  if (item.refs.length === 0) {
    lines.push('- 引用：无')
  } else {
    lines.push('- 引用：')
    for (const ref of item.refs) lines.push(`  - ${inlineCode(`${ref.from}:${ref.line}`)}（${ref.via}）`)
  }

  const h = item.history
  if (!h) {
    lines.push('- 历史：未查询')
  } else {
    lines.push('- 历史：')
    const origin = h.paths?.at(-1)
    if (origin && origin !== item.target) lines.push(`  - 原路径：${inlineCode(origin)}`)
    // 时间线是按字面搜索这个字符串得出的；看报告的人据此判断有没有漏掉的引用写法
    if (h.pattern) lines.push(`  - 搜索的引用写法：${inlineCode(h.pattern)}`)
    lines.push(`  - 引入：${oneLine(full(h.introduced))}`)
    for (const g of groupTimeline(h.timeline)) {
      const parts = []
      if (g.added.length) parts.push(`新增引用 ${g.added.map(inlineCode).join('、')}`)
      if (g.removed.length) parts.push(`去掉引用 ${g.removed.map(inlineCode).join('、')}`)
      lines.push(`  - ${brief(g.commit)}：${parts.join('；')}`)
    }
    if (h.lostRef) lines.push(`  - 失去引用：${oneLine(full(h.lostRef))}`)
    else lines.push(`  - ${h.timeline.length === 0 ? '从未被引用' : '仍被引用'}`)
  }

  const v = item.verify
  if (!v) {
    lines.push('- 验证：未验证')
  } else {
    lines.push(`- 验证：${v.passed ? '删除后与基线一致' : '删除后与基线不一致'}（提交 ${inlineCode(shortHash(v.rev, config.shortHashLength))}）`)
    lines.push(`  - 构建：${v.build.ok ? '通过' : '失败'}，新增警告 ${v.build.newWarnings.length} 条`)
    for (const w of v.build.newWarnings) lines.push(`    - ${oneLine(w)}`)
    lines.push(`  - 测试：新增失败 ${v.test.newFailures.length} 个`)
    for (const f of v.test.newFailures) lines.push(`    - ${oneLine(f)}`)
  }

  for (const note of item.notes ?? []) lines.push(`- ⚠️ ${oneLine(note)}`)

  return lines.join('\n')
}
