/**
 * 项目配置：每个项目不同的地方（目录、扩展名、显示格式）都放在这里
 *
 * 代码里只放通用逻辑；各项目在 profiles/<项目名>.js 里覆盖默认值
 * 默认值选的是最常见的约定，不是某个具体项目的约定
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { STATUSES, STATUS_LABELS } from './schema.js'

/** 头注释支持的注释格式：block 是 JS 的 /** *\/，html 是 <!-- --> */
export const COMMENT_STYLES = Object.freeze(['block', 'html'])

/**
 * @typedef {object} Config
 * @property {string[]} sourceRoots  源码根目录，相对仓库根目录。推 pattern 时去掉这一段
 *                                   （对应项目里 @/ 这类别名指向的目录）
 * @property {string[]} extensions   只在这些扩展名的文件里找引用方
 * @property {number} shortHashLength 报告里提交号显示几位
 * @property {string} headerTitle    头注释的第一行（标题）
 * @property {string[]} headerFooter 头注释最后的提示，每项一行；可以为空数组
 * @property {Record<string, 'block'|'html'|null>} headerStyles 各扩展名用哪种注释格式；
 *                                   没列出或为 null 的扩展名不支持生成头注释（如 .json 不能写注释）
 * @property {Record<string, string>} statusLabels 各状态的显示文案；状态 ID 本身不变
 */

/** @type {Readonly<Config>} */
export const DEFAULT_CONFIG = Object.freeze({
  // Vue、React、Vite 等脚手架默认的源码目录
  sourceRoots: Object.freeze(['src']),
  // 主流前端框架的源码文件
  extensions: Object.freeze([
    '.js', '.mjs', '.cjs', '.jsx',
    '.ts', '.mts', '.cts', '.tsx',
    '.vue', '.svelte'
  ]),
  // git 默认 7 位，8 位在提交多的仓库里更不容易重复
  shortHashLength: 8,
  // 头注释的标题：默认只陈述事实（这是工具生成的排查记录），不包含任何流程要求
  headerTitle: '[code-audit] 文件排查记录',
  // 头注释最后的提示：默认没有。隔离、恢复等流程要求属于项目约定，由项目自己配置
  headerFooter: Object.freeze([]),
  // 各扩展名的注释格式。.html 没有列出：放在 <!doctype> 前面的注释会让浏览器进入怪异模式
  headerStyles: Object.freeze({
    '.js': 'block', '.mjs': 'block', '.cjs': 'block', '.jsx': 'block',
    '.ts': 'block', '.mts': 'block', '.cts': 'block', '.tsx': 'block',
    '.vue': 'html', '.svelte': 'html'
  }),
  // 状态的显示文案，默认取 schema 里的中文说明；项目可以只覆盖其中几个
  statusLabels: STATUS_LABELS
})

/**
 * 用项目配置覆盖默认值，并校验
 * 写错的配置项（拼错名字、类型不对）直接报错，不会被悄悄忽略
 * @param {Partial<Config>} [overrides]
 * @returns {Readonly<Config>}
 */
export function resolveConfig(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('配置必须是对象')
  }

  const errors = []
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_CONFIG)) errors.push(`不认识的配置项：${key}`)
  }

  const config = { ...DEFAULT_CONFIG, ...overrides }
  // 这两项按键合并：项目只需要写想改的那几个，其余保留默认值
  config.headerStyles = { ...DEFAULT_CONFIG.headerStyles, ...overrides.headerStyles }
  config.statusLabels = { ...DEFAULT_CONFIG.statusLabels, ...overrides.statusLabels }

  if (!Array.isArray(config.sourceRoots) || !config.sourceRoots.every(isRelativeDir)) {
    errors.push('sourceRoots 必须是相对目录组成的数组，如 ["src"]，不能以 / 开头或结尾')
  }
  if (
    !Array.isArray(config.extensions) ||
    config.extensions.length === 0 ||
    !config.extensions.every((e) => typeof e === 'string' && /^\.[\w.-]+$/.test(e))
  ) {
    errors.push('extensions 必须是非空数组，每项以点开头，如 [".js", ".vue"]')
  }
  if (!isValidHashLength(config.shortHashLength)) {
    errors.push('shortHashLength 必须是 4 到 40 之间的整数')
  }

  if (typeof config.headerTitle !== 'string' || config.headerTitle.trim() === '') {
    errors.push('headerTitle 必须是非空字符串')
  }
  if (!Array.isArray(config.headerFooter) || !config.headerFooter.every((l) => typeof l === 'string' && l.trim() !== '')) {
    errors.push('headerFooter 必须是非空字符串组成的数组（可以是空数组）')
  }
  for (const [ext, style] of Object.entries(config.headerStyles)) {
    if (!/^\.[\w.-]+$/.test(ext)) errors.push(`headerStyles 的键必须是扩展名，如 ".js"：${ext}`)
    if (style !== null && !COMMENT_STYLES.includes(style)) {
      errors.push(`headerStyles["${ext}"] 必须是 ${COMMENT_STYLES.join(' / ')} 或 null：${style}`)
    }
  }
  for (const [status, label] of Object.entries(config.statusLabels)) {
    if (!STATUSES.includes(status)) errors.push(`statusLabels 里有不认识的状态：${status}`)
    if (typeof label !== 'string' || label.trim() === '') errors.push(`statusLabels["${status}"] 必须是非空字符串`)
  }

  if (errors.length > 0) throw new Error(`配置有误：\n- ${errors.join('\n- ')}`)

  return Object.freeze({
    ...config,
    sourceRoots: Object.freeze([...config.sourceRoots]),
    extensions: Object.freeze([...config.extensions]),
    headerFooter: Object.freeze([...config.headerFooter]),
    headerStyles: Object.freeze({ ...config.headerStyles }),
    statusLabels: Object.freeze({ ...config.statusLabels })
  })
}

/**
 * 读取项目配置文件（profiles/<项目名>.js），文件里 export default 一个对象
 * @param {string} file 配置文件路径
 * @returns {Promise<Readonly<Config>>}
 */
export async function loadProfile(file) {
  const mod = await import(pathToFileURL(resolve(file)).href)
  if (mod.default === undefined) throw new Error(`配置文件没有 export default：${file}`)
  return resolveConfig(mod.default)
}

/** 提交号显示长度是否合法：太短容易重复，超过 40 位没有意义 */
export function isValidHashLength(n) {
  return Number.isInteger(n) && n >= 4 && n <= 40
}

function isRelativeDir(v) {
  return typeof v === 'string' && v !== '' && !v.startsWith('/') && !v.endsWith('/') && !v.includes('\\')
}
