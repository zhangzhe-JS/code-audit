/**
 * 找出代码里的 import.meta.glob，把它的参数换算成相对仓库根目录的 glob
 *
 * knip 不认识 import.meta.glob：被它批量加载的文件会被误报为没人用。
 * 所以 scan 先找出这些 glob，作为入口交给 knip。
 *
 * 只认字符串字面量（或字符串组成的数组）：参数是变量、拼接出来的字符串时无法换算，记一条警告
 * require.context 暂不展开，只记警告：被它加载的文件可能被误报
 *
 * 已知限制：
 * - 写 import.meta.glob 的文件本身没人用时，它加载的文件也会被当成在用（少报，不会误删）
 */
import { posix } from 'node:path'
import { stripComments } from './strip-comments.js'

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
    if (!content.includes('import.meta.glob') && !content.includes('require.context')) continue
    // 去掉注释：注释里的 glob 不算；去注释后行号不变
    const code = stripComments(SFC_EXTENSIONS.some((e) => path.endsWith(e)) ? scriptOnly(content) : content)

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

    for (const m of code.matchAll(/\brequire\.context\s*\(/g)) {
      warnings.push({
        from: path,
        line: lineAt(code, m.index),
        detail: 'require.context 暂不支持展开，被它加载的文件可能被误报为没人用'
      })
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

/** 读一个字符串字面量，返回内容和结束位置；不是字面量返回 null */
function readString(code, i) {
  const quote = code[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let value = ''
  for (let j = i + 1; j < code.length; j++) {
    const ch = code[j]
    if (ch === '\\') {
      value += code[j + 1] ?? ''
      j++
    } else if (ch === quote) {
      return { value, end: j + 1 }
    } else if (quote === '`' && ch === '$' && code[j + 1] === '{') {
      return null // 模板字符串里有变量：不是固定的值
    } else if (ch === '\n' && quote !== '`') {
      return null
    } else {
      value += ch
    }
  }
  return null
}

/** 单文件组件：模板里的文字不是 JS，只看 <script> 里的内容 */
const SFC_EXTENSIONS = ['.vue', '.svelte', '.astro']

/**
 * 只保留 <script> 块里的内容，其余部分换成同样多的空行，行号不变
 * .astro 的代码写在开头的 --- 之间，也一并保留
 * @param {string} content
 */
export function scriptOnly(content) {
  const keep = []
  for (const m of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const start = m.index + m[0].indexOf('>') + 1
    keep.push([start, start + m[1].length])
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const start = content.indexOf('\n') + 1 // 第一行 --- 之后
    keep.push([start, start + fm[1].length])
  }
  keep.sort((a, b) => a[0] - b[0])

  let out = ''
  let pos = 0
  for (const [s, e] of keep) {
    if (s < pos) continue
    out += blankLines(content.slice(pos, s)) + content.slice(s, e)
    pos = e
  }
  return out + blankLines(content.slice(pos))
}

function blankLines(text) {
  return '\n'.repeat((text.match(/\n/g) ?? []).length)
}

function skipSpace(code, i) {
  while (i < code.length && /\s/.test(code[i])) i++
  return i
}

function lineAt(code, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (code[i] === '\n') line++
  return line
}
