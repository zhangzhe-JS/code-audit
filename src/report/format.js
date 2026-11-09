/**
 * 报告用的格式化工具：头注释、隔离清单、排查报告共用
 * 全部是纯函数，只处理字符串，不读写文件
 */
import { DEFAULT_CONFIG, isValidHashLength } from '../core/config.js'

/** 默认显示的提交号长度，取自默认配置；各项目通过配置的 shortHashLength 修改 */
export const SHORT_HASH_LENGTH = DEFAULT_CONFIG.shortHashLength

/**
 * 截短提交号
 * @param {string} hash 完整提交号
 * @param {number} [length] 显示几位（4～40），默认 SHORT_HASH_LENGTH
 */
export function shortHash(hash, length = SHORT_HASH_LENGTH) {
  // 不合法的长度直接报错：slice 遇到负数会从末尾倒数，悄悄返回一个看起来正常的错误结果
  if (!isValidHashLength(length)) throw new RangeError(`提交号长度必须是 4 到 40 之间的整数：${length}`)
  return hash.slice(0, length)
}

/**
 * 一个提交显示成一行
 * @param {import('../core/schema.js').Commit} commit
 * @param {object} [opts]
 * @param {boolean} [opts.subject]    是否带上提交说明，默认带
 * @param {number} [opts.hashLength] 提交号显示几位，默认 SHORT_HASH_LENGTH
 * @returns {string} 如：2022-04-14 44bd21eb alice「first commit」
 */
export function formatCommit(commit, { subject = true, hashLength = SHORT_HASH_LENGTH } = {}) {
  const base = `${commit.date} ${shortHash(commit.hash, hashLength)} ${commit.author}`
  return subject ? `${base}「${commit.subject}」` : base
}

/**
 * 放进 /* *\/ 块注释之前转义：把 *\/ 换成 *\\/
 * 不转义的话，提交说明里的 *\/ 会提前结束注释，后面的内容变成代码，文件直接报语法错误
 */
export function escapeComment(text) {
  return text.replaceAll('*/', '*\\/')
}

/**
 * 放进 Markdown 表格单元格之前转义
 * - 先把 \ 换成 \\：否则原文里的 \| 转义后变成 \\|，
 *   Markdown 会把 \\ 当成一个转义好的反斜杠，后面的 | 就成了列分隔符
 * - 再把 | 换成 \|：| 会被当成列分隔符，导致表格错位
 * - 换行会把一行表格拆断，换成空格
 * 顺序不能反：先换 | 再换 \，刚加上的 \ 也会被重复转义
 */
export function escapeTableCell(text) {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ')
}

/**
 * 时间线按提交分组：同一次提交里增加或去掉的多处引用，合成一条
 * 例：一次重构提交里去掉了 8 处引用，报告里只显示一行，而不是 8 行
 * @param {{commit: object, change: 'add'|'remove', from: string}[]} timeline
 * @returns {{commit: object, added: string[], removed: string[]}[]} 保持原来的时间顺序
 */
export function groupTimeline(timeline) {
  const groups = []
  const byHash = new Map()

  for (const e of timeline) {
    let g = byHash.get(e.commit.hash)
    if (!g) {
      g = { commit: e.commit, added: [], removed: [] }
      byHash.set(e.commit.hash, g)
      groups.push(g)
    }
    if (e.change === 'add') g.added.push(e.from)
    else if (e.change === 'remove') g.removed.push(e.from)
    else throw new Error(`时间线里的 change 不合法：${e.change}`) // 不认识的值不能悄悄当成「去掉」
  }

  return groups
}
/**
 * 放进 <!-- --> 注释之前转义：把 --> 换成 -- >
 * 不转义的话，内容里的 --> 会提前结束注释，后面的内容会被当成模板或页面内容
 */
export function escapeHtmlComment(text) {
  return text.replaceAll('-->', '-- >')
}

/** 把换行换成空格：Markdown 列表项、标题里的内容只占一行，换行会把结构拆乱 */
export function oneLine(text) {
  return text.replace(/\r?\n/g, ' ')
}

/**
 * 把文字包成 Markdown 行内代码
 * 围栏（两边的反引号）要比文字里最长的一串连续反引号多一个，否则代码会在中间提前结束：
 *   src/a.js → `src/a.js`      a`b → `` a`b ``      a``b → ``` a``b ```
 * 文字里有反引号，或者以空格开头、结尾时，两侧各加一个空格（Markdown 显示时会去掉这一个空格）
 */
export function inlineCode(text) {
  const t = oneLine(text)
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = longest > 0 || t.startsWith(' ') || t.endsWith(' ') ? ' ' : ''
  return `${fence}${pad}${t}${pad}${fence}`
}
