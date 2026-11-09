/**
 * 找出代码里的 import.meta.glob，把它的参数换算成相对仓库根目录的 glob
 *
 * knip 不认识 import.meta.glob：被它批量加载的文件会被误报为没人用。
 * 所以 scan 先找出这些 glob，作为入口交给 knip。
 *
 * 只认字符串字面量（或字符串组成的数组）：参数是变量、拼接出来的字符串时无法换算，记一条警告
 * require.context、拼接路径的 import() 由 dynamic-imports.js 处理
 *
 * 已知限制：
 * - 写 import.meta.glob 的文件本身没人用时，它加载的文件也会被当成在用（少报，不会误删）
 */
import { posix } from 'node:path'
import { codeOf, lineAt, readString, skipSpace } from './source-text.js'

/**
 * @typedef {object} GlobImport
 * @property {string} from     写 glob 的文件
 * @property {number} line
 * @property {string} pattern  代码里写的原样
 * @property {string} resolved 相对仓库根目录的 glob；排除写法（! 开头）保留 !
 */

/**
 * @typedef {object} GlobWarning
 * @property {string} from
 * @property {number} line
 * @property {string} detail
 */

/**
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files 要检查的源码文件（path 相对仓库根目录）
 * @param {Record<string, string>} [opts.aliases] 别名 → 目录
 * @returns {{globs: GlobImport[], warnings: GlobWarning[]}}
 */
export function findGlobImports({ files, aliases = {} }) {
  const globs = []
  const warnings = []

  for (const { path, content } of files) {
    if (!content.includes('import.meta.glob')) continue
    const code = codeOf(path, content)

    for (const m of code.matchAll(/import\.meta\.glob(?:Eager)?\s*\(/g)) {
      const line = lineAt(code, m.index)
      const args = readLiterals(code, m.index + m[0].length)
      if (args === null) {
        warnings.push({ from: path, line, detail: 'import.meta.glob 的参数不是字符串，无法换算，被它加载的文件可能被误报为没人用' })
        continue
      }
      for (const pattern of args) {
        const resolved = resolvePattern(pattern, path, aliases)
        if (resolved === null) {
          warnings.push({ from: path, line, detail: `无法换算的 glob 写法：${pattern}，被它加载的文件可能被误报为没人用` })
        } else {
          globs.push({ from: path, line, pattern, resolved })
        }
      }
    }
  }
  return { globs, warnings }
}

/**
 * 把 glob 换算成相对仓库根目录的写法
 * - ./  ../  相对写 glob 的文件
 * - /        相对项目根目录（Vite 的约定）
 * - 别名     按 aliases 换成目录，取最长的匹配
 * 换算不了（不认识的写法、跑到仓库外面）返回 null
 * @param {string} pattern
 * @param {string} from
 * @param {Record<string, string>} aliases
 * @returns {string | null}
 */
export function resolvePattern(pattern, from, aliases = {}) {
  const negated = pattern.startsWith('!')
  const p = negated ? pattern.slice(1) : pattern
  let resolved = null

  if (p.startsWith('./') || p.startsWith('../')) {
    resolved = posix.normalize(posix.join(posix.dirname(from), p))
  } else if (p.startsWith('/')) {
    resolved = posix.normalize(p.slice(1))
  } else {
    const name = Object.keys(aliases)
      .filter((a) => p === a || p.startsWith(`${a}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (name !== undefined) resolved = posix.normalize(aliases[name] + p.slice(name.length))
  }

  if (resolved !== null) resolved = resolved.replace(/\/+$/, '').replace(/^\.\//, '')
  if (resolved === null || resolved === '' || resolved === '.' || resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    return null
  }
  return negated ? `!${resolved}` : resolved
}

/**
 * 从 ( 后面读参数：一个字符串，或字符串组成的数组
 * 第一个参数不是字面量时返回 null；模板字符串里有 ${} 也算不是字面量
 * @param {string} code
 * @param {number} i 紧跟在 ( 后面的位置
 * @returns {string[] | null}
 */
function readLiterals(code, i) {
  i = skipSpace(code, i)
  if (code[i] === '[') {
    const out = []
    i = skipSpace(code, i + 1)
    while (code[i] !== ']') {
      const lit = readString(code, i)
      if (lit === null) return null
      out.push(lit.value)
      i = skipSpace(code, lit.end)
      if (code[i] === ',') i = skipSpace(code, i + 1)
      else if (code[i] !== ']') return null
    }
    return out.length > 0 ? out : null
  }
  const lit = readString(code, i)
  return lit === null ? null : [lit.value]
}
