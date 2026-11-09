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
 * 清单表格可以显示的列
 * - target     当前路径（导出显示为 路径#名字，接口显示为 方法 路径）
 * - origin     原路径（没有移动过显示 —）
 * - status     状态
 * - introduced 引入
 * - lostRef    失去引用
 * - notes      人工备注
 */
export const TABLE_COLUMNS = Object.freeze(['target', 'origin', 'status', 'introduced', 'lostRef', 'notes'])

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
 * @property {string[]} tableColumns 清单表格显示哪些列、按什么顺序（取值见 TABLE_COLUMNS）
 * @property {Record<string, string>} columnTitles 清单表格各列的标题
 * @property {string[]} entries      scan 用：项目入口，相对仓库根目录，可以写 glob（如 src/main.js）
 * @property {string[]} testEntries  scan 用：测试入口（如 src/**\/*.test.js）。写了就能区分「只被测试用到」；
 *                                   匹配到的测试文件本身不会列为候选
 * @property {Record<string, string>} aliases scan 用：路径别名 → 相对仓库根目录的目录，如 { "@": "src" }
 *                                   （对应构建配置里的 resolve.alias）
 * @property {string[]} scanIgnore   scan 用：不列为候选的文件（glob），如 mock、构建脚本
 * @property {{from: string, expr: string, reason: string}[]} reviewedDynamicLoads scan 用：人工确认过、
 *                                   不会加载本地源码的动态加载（如加载 CDN 上的脚本）。
 *                                   from 是写加载的文件，expr 照抄 scan 输出里的写法，reason 写确认的理由（会写进报告）
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
  statusLabels: STATUS_LABELS,
  // 清单表格：默认显示全部列；项目可以去掉不需要的列、调整顺序
  tableColumns: TABLE_COLUMNS,
  columnTitles: Object.freeze({
    target: '文件',
    origin: '原路径',
    status: '状态',
    introduced: '引入',
    lostRef: '失去引用',
    notes: '备注'
  }),
  // scan 的入口没有默认值：猜错入口会把在用的文件当成没人用，所以必须由项目写明
  entries: Object.freeze([]),
  testEntries: Object.freeze([]),
  // 别名没有默认值：@ 指向哪里各项目不同，猜错了引用会解析不到
  aliases: Object.freeze({}),
  scanIgnore: Object.freeze([]),
  // 动态加载默认都不放过：人工确认过的才写进来
  reviewedDynamicLoads: Object.freeze([])
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
  // 这几项按键合并：项目只需要写想改的那几个，其余保留默认值
  // 写了就必须是普通对象：null、数组、字符串展开时会被悄悄忽略或拆散，配置失效却没有提示
  for (const key of MERGED_KEYS) {
    if (key in overrides && !isPlainObject(overrides[key])) {
      errors.push(`${key} 必须是对象，如 { 键: 值 }；不需要修改时不要写这一项`)
    }
    config[key] = { ...DEFAULT_CONFIG[key], ...(isPlainObject(overrides[key]) ? overrides[key] : {}) }
  }

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
  if (
    !Array.isArray(config.tableColumns) ||
    config.tableColumns.length === 0 ||
    !config.tableColumns.every((c) => TABLE_COLUMNS.includes(c)) ||
    new Set(config.tableColumns).size !== config.tableColumns.length
  ) {
    errors.push(`tableColumns 必须是不重复的非空数组，可选的列：${TABLE_COLUMNS.join('、')}`)
  }
  for (const [col, title] of Object.entries(config.columnTitles)) {
    if (!TABLE_COLUMNS.includes(col)) errors.push(`columnTitles 里有不认识的列：${col}`)
    if (typeof title !== 'string' || title.trim() === '') errors.push(`columnTitles["${col}"] 必须是非空字符串`)
  }

  for (const key of ['entries', 'testEntries', 'scanIgnore']) {
    if (!Array.isArray(config[key]) || !config[key].every(isRelativeGlob)) {
      errors.push(`${key} 必须是相对仓库根目录的路径或 glob 组成的数组，如 ["src/main.js"]，不能以 / 开头，不能含 ..`)
    }
  }
  if (!isPlainObject(config.aliases)) {
    errors.push('aliases 必须是对象，如 { "@": "src" }')
  } else {
    for (const [name, dir] of Object.entries(config.aliases)) {
      if (name === '' || name.includes('*') || name.endsWith('/')) {
        errors.push(`aliases 的键必须是别名本身，如 "@"，不要写 /* 或结尾的 /：${name}`)
      }
      if (!isRelativeDir(dir) || dir.split('/').includes('..')) {
        errors.push(`aliases["${name}"] 必须是相对仓库根目录的目录，如 "src"：${dir}`)
      }
    }
  }

  if (!Array.isArray(config.reviewedDynamicLoads)) {
    errors.push('reviewedDynamicLoads 必须是数组，如 [{ from: "src/a.js", expr: "import(url)", reason: "加载的是 CDN 脚本" }]')
  } else {
    config.reviewedDynamicLoads.forEach((r, i) => {
      const at = `reviewedDynamicLoads[${i}]`
      if (!isPlainObject(r)) return errors.push(`${at} 必须是对象，如 { from, expr, reason }`)
      for (const k of Object.keys(r)) if (!['from', 'expr', 'reason'].includes(k)) errors.push(`${at} 不认识的字段：${k}`)
      if (!isRelativeGlob(r.from) || /[*?[]/.test(r.from)) errors.push(`${at}.from 必须是相对仓库根目录的文件路径：${r.from}`)
      if (typeof r.expr !== 'string' || r.expr.trim() === '') errors.push(`${at}.expr 必须照抄 scan 输出里的写法，如 "import(url)"`)
      if (typeof r.reason !== 'string' || r.reason.trim() === '') errors.push(`${at}.reason 必须写确认的理由：会写进报告，说明为什么不会加载本地源码`)
    })
  }

  if (errors.length > 0) throw new Error(`配置有误：\n- ${errors.join('\n- ')}`)

  return Object.freeze({
    ...config,
    sourceRoots: Object.freeze([...config.sourceRoots]),
    extensions: Object.freeze([...config.extensions]),
    headerFooter: Object.freeze([...config.headerFooter]),
    headerStyles: Object.freeze({ ...config.headerStyles }),
    statusLabels: Object.freeze({ ...config.statusLabels }),
    tableColumns: Object.freeze([...config.tableColumns]),
    columnTitles: Object.freeze({ ...config.columnTitles }),
    entries: Object.freeze([...config.entries]),
    testEntries: Object.freeze([...config.testEntries]),
    aliases: Object.freeze({ ...config.aliases }),
    scanIgnore: Object.freeze([...config.scanIgnore]),
    reviewedDynamicLoads: Object.freeze(config.reviewedDynamicLoads.map((r) => Object.freeze({ ...r })))
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

/** 按键合并的配置项 */
const MERGED_KEYS = Object.freeze(['headerStyles', 'statusLabels', 'columnTitles'])

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isRelativeDir(v) {
  return typeof v === 'string' && v !== '' && !v.startsWith('/') && !v.endsWith('/') && !v.includes('\\')
}

/** 相对仓库根目录的路径或 glob：不以 / 开头，不含 ..，用 / 分隔 */
function isRelativeGlob(v) {
  return (
    typeof v === 'string' &&
    v !== '' &&
    !v.startsWith('/') &&
    !v.startsWith('!') &&
    !v.includes('\\') &&
    !v.split('/').includes('..')
  )
}
