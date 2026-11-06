/**
 * 项目配置：每个项目不同的地方（目录、扩展名、显示格式）都放在这里
 *
 * 代码里只放通用逻辑；各项目在 profiles/<项目名>.js 里覆盖默认值
 * 默认值选的是最常见的约定，不是某个具体项目的约定
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/**
 * @typedef {object} Config
 * @property {string[]} sourceRoots  源码根目录，相对仓库根目录。推 pattern 时去掉这一段
 *                                   （对应项目里 @/ 这类别名指向的目录）
 * @property {string[]} extensions   只在这些扩展名的文件里找引用方
 * @property {number} shortHashLength 报告里提交号显示几位
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
  shortHashLength: 8
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

  if (errors.length > 0) throw new Error(`配置有误：\n- ${errors.join('\n- ')}`)

  return Object.freeze({
    ...config,
    sourceRoots: Object.freeze([...config.sourceRoots]),
    extensions: Object.freeze([...config.extensions])
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
