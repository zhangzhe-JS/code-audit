/**
 * 找出路径不固定的动态加载，算出它可能加载哪些文件
 *
 * knip 只认路径固定的引用。下面这些写法加载的文件，knip 会误报为「从入口走不到」：
 * - import(`./views/${name}.vue`)、import('./views/' + name)  拼接路径
 * - require(`./locale/${lang}.js`)                             同上
 * - require.context('./modules', true, /\.js$/)               按目录批量加载
 *
 * 范围的算法：取路径里固定的开头和结尾。
 *   `./views/${name}.vue` → 目录 views（含子目录），文件名以 .vue 结尾
 *   `./views/page-${x}`   → 目录 views，文件名以 page- 开头
 * 变量里可能有 /，所以一律包括子目录；路径没写扩展名时，去掉扩展名再比较。宁可多圈，不可漏圈。
 *
 * 开头没有固定的目录（如 import(path)、import(name + '.vue')、目录不是字符串的 require.context）时，
 * 确定不了目录：范围是整个仓库（wide），只按路径里固定的结尾、require.context 的正则缩小。
 * 宁可多圈：这类加载圈到的候选都判 unknown，除非人工确认过（配置 reviewedDynamicLoads）
 */
import { resolvePattern } from './glob-imports.js'
import { codeOf, inStringAt, lineAt, readString } from './source-text.js'
import { joinedPathOf } from './external-refs.js'

/**
 * @typedef {object} DynamicLoad
 * @property {string} from  写这处加载的文件
 * @property {number} line
 * @property {'import'|'require'|'require.context'|'import.meta.glob'|'component'} kind
 *   import.meta.glob：换算不了的 glob（scan 补进来）；component：名字是变量的动态组件（scan 补进来）
 * @property {string} expr  代码里的写法，压成一行，过长截断
 * @property {LoadScope} scope  可能加载哪些文件
 * @property {string} [note]  为什么判 unknown、怎么放过；不写时按 kind 生成
 */

/**
 * @typedef {object} LoadScope
 * @property {string} dir         目录，相对仓库根目录；'' = 确定不了目录，整个仓库
 * @property {boolean} wide       确定不了目录（dir 为 ''）
 * @property {boolean} recursive  是否包括子目录
 * @property {string} prefix      相对 dir 的路径的开头（require.context 时为空）
 * @property {string} suffix      结尾（require.context 时为空）
 * @property {RegExp|null} regex  require.context 的正则：对「./相对 dir 的路径」测试；null = 不限
 * @property {Set<string>} [files] 直接给出可能用到的文件（名字是变量的动态组件：所有全局组件）；有它时只看它
 * @property {string[]} [paths] 算得出的路径（require(path.join(ROOT, 'x'))）：这个文件、省略扩展名的写法、目录的 index；有它时只看它
 */

const CALLS = /(?<![\w$.])(import|require\.context|require)\s*\(/g
const DYNAMIC = Symbol('dynamic')
const EXPR_MAX = 80

/**
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files
 * @param {Record<string, string>} [opts.aliases]
 * @returns {DynamicLoad[]}
 */
export function findDynamicLoads({ files, aliases = {} }) {
  const loads = []
  for (const { path, content } of files) {
    if (!/\b(import|require)\b/.test(content)) continue
    const code = codeOf(path, content)
    const inString = inStringAt(code)
    for (const m of code.matchAll(CALLS)) {
      if (inString(m.index)) continue // 写在字符串里的 import(、require(：是文字，不是调用
      const call = readArgs(code, m.index + m[0].length)
      if (call === null || call.args.length === 0) continue
      const kind = m[1]
      const scope = kind === 'require.context' ? contextScope(call.args, path, aliases) : concatScope(call.args[0], path, aliases)
      if (scope === STATIC) continue // 路径固定：knip 能处理
      loads.push({ from: path, line: lineAt(code, m.index), kind, expr: shorten(code.slice(m.index, call.end)), scope })
    }
  }
  return loads
}

/**
 * 文件在不在这处加载的范围里
 * @param {string} file 相对仓库根目录
 * @param {LoadScope} scope
 */
export function inScope(file, scope) {
  if (scope.files) return scope.files.has(file)
  if (scope.paths) return scope.paths.some((p) => file === p || file.replace(/\.[^./]+$/, '') === p || file.startsWith(`${p}/index.`))
  if (scope.dir !== '' && !file.startsWith(`${scope.dir}/`)) return false
  const rel = scope.dir === '' ? file : file.slice(scope.dir.length + 1)
  if (!scope.recursive && rel.includes('/')) return false
  if (scope.regex) return scope.regex.test(`./${rel}`)
  if (!rel.startsWith(scope.prefix)) return false
  if (scope.suffix === '') return true
  // 路径里可以省略扩展名：import(`./views/${x}`) 能加载 views/a.vue
  return rel.endsWith(scope.suffix) || rel.replace(/\.[^./]+$/, '').endsWith(scope.suffix)
}

const STATIC = Symbol('static')

/** import() / require() 的第一个参数：拼接路径时返回范围；路径固定返回 STATIC */
function concatScope(arg, from, aliases) {
  // path.join(ROOT, 'package.json') 这类各段都算得出的：就是那几个路径，不是整个仓库
  // （变量 ROOT 不知道指哪里，按仓库根目录和文件所在目录各算一个）
  const joined = joinedPathOf(arg, from)
  if (joined) return { dir: '', wide: false, recursive: true, prefix: '', suffix: '', regex: null, paths: joined }
  const segs = segmentsOf(arg)
  if (!segs.includes(DYNAMIC)) return STATIC
  const prefix = typeof segs[0] === 'string' ? segs[0] : ''
  const last = segs.at(-1)
  const suffix = typeof last === 'string' ? last.replace(/\?.*$/, '') : '' // 去掉 ?raw 这类查询参数

  const cut = prefix.lastIndexOf('/')
  const dir = cut < 0 ? null : resolveDir(prefix.slice(0, cut + 1), from, aliases)
  // 开头没有固定的目录，或目录换算不了（包名、没配置的别名）：整个仓库，只按结尾缩小
  if (dir === null) return wideScope(suffix, null)
  return { dir, wide: false, recursive: true, prefix: prefix.slice(cut + 1), suffix, regex: null }
}

/** require.context(目录, 是否含子目录, 正则)：第二、三个参数可以不写，默认含子目录、不限文件 */
function contextScope(args, from, aliases) {
  const dirLit = literalOf(args[0])
  const dir = dirLit === null ? null : resolveDir(dirLit, from, aliases)
  const recursive = args[1] === undefined || args[1] !== 'false' // 不是字面量 false 就按含子目录算
  let regex = null
  const re = args[2]?.match(/^\/([\s\S]+)\/([a-z]*)$/)
  if (re) {
    try {
      regex = new RegExp(re[1], re[2].replace(/[gy]/g, '')) // 去掉 g、y：反复 test 不受 lastIndex 影响
    } catch {
      regex = null // 正则解析不了：不限文件，宁可多圈
    }
  }
  // 目录不是字符串、换算不了：整个仓库，只按正则缩小（正则对 ./相对路径 测试，这时按整个路径测）
  if (dir === null) return wideScope('', regex)
  return { dir, wide: false, recursive, prefix: '', suffix: '', regex }
}

export function wideScope(suffix, regex) {
  return { dir: '', wide: true, recursive: true, prefix: '', suffix, regex }
}

/** 目录写法换成相对仓库根目录的路径；换不了（不认识的写法、包名、仓库根目录本身）返回 null */
function resolveDir(pattern, from, aliases) {
  const dir = resolvePattern(pattern, from, aliases)
  return dir === null || dir.startsWith('!') ? null : dir
}

/**
 * 把参数拆成固定的字符串和变量：'./a/' + x + '.vue' → ['./a/', DYNAMIC, '.vue']
 * 相邻的字符串合并，空字符串去掉
 */
function segmentsOf(text) {
  const segs = []
  for (const raw of splitTopLevel(text, '+')) {
    const part = raw.trim()
    const lit = literalOf(part)
    if (lit !== null) segs.push(lit)
    else if (part.startsWith('`') && skipQuoted(part, 0) === part.length) segs.push(...templatePieces(part))
    else segs.push(DYNAMIC)
  }
  const merged = []
  for (const s of segs) {
    if (s === '') continue
    if (typeof s === 'string' && typeof merged.at(-1) === 'string') merged[merged.length - 1] += s
    else merged.push(s)
  }
  return merged
}

/** 整段是一个不含变量的字符串字面量时返回内容，否则返回 null */
function literalOf(text) {
  if (text === undefined || text === '') return null
  const lit = readString(text, 0)
  return lit !== null && lit.end === text.length ? lit.value : null
}

/** 模板字符串拆成固定部分和变量：`./a/${x}.vue` → ['./a/', DYNAMIC, '.vue'] */
function templatePieces(text) {
  const out = []
  let cur = ''
  for (let j = 1; j < text.length - 1; j++) {
    if (text[j] === '\\') {
      cur += text[j + 1] ?? ''
      j++
    } else if (text[j] === '$' && text[j + 1] === '{') {
      out.push(cur, DYNAMIC)
      cur = ''
      j = skipExpr(text, j + 2) - 1
    } else {
      cur += text[j]
    }
  }
  out.push(cur)
  return out
}

/**
 * 从 ( 后面读参数，到配对的 ) 为止
 * @returns {{args: string[], end: number} | null} end 是 ) 后面的位置；没有配对的 ) 返回 null
 */
function readArgs(code, start) {
  const args = []
  let depth = 0
  let cur = start
  let i = start
  while (i < code.length) {
    const c = code[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(code, i)
      continue
    }
    if (c === '/' && regexAllowed(code, i)) {
      i = skipRegex(code, i)
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        args.push(code.slice(cur, i))
        const trimmed = args.map((a) => a.trim())
        if (trimmed.at(-1) === '') trimmed.pop() // 结尾多写的逗号
        return { args: trimmed, end: i + 1 }
      }
      depth--
    } else if (c === ',' && depth === 0) {
      args.push(code.slice(cur, i))
      cur = i + 1
    }
    i++
  }
  return null
}

/** 按顶层的分隔符拆分：字符串、括号里的不算 */
function splitTopLevel(text, sep) {
  const parts = []
  let depth = 0
  let cur = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(text, i)
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === sep && depth === 0) {
      parts.push(text.slice(cur, i))
      cur = i + 1
    }
    i++
  }
  parts.push(text.slice(cur))
  return parts
}

/** 跳过一个字符串（含模板字符串里的 ${}），返回它后面的位置 */
function skipQuoted(code, i) {
  const quote = code[i]
  let j = i + 1
  while (j < code.length) {
    const c = code[j]
    if (c === '\\') j += 2
    else if (c === quote) return j + 1
    else if (quote === '`' && c === '$' && code[j + 1] === '{') j = skipExpr(code, j + 2)
    else if (c === '\n' && quote !== '`') return j // 没闭合的字符串：到行尾为止
    else j++
  }
  return code.length
}

/** 跳过 ${ 后面的表达式，返回配对的 } 后面的位置 */
function skipExpr(code, j) {
  let depth = 0
  while (j < code.length) {
    const c = code[j]
    if (c === "'" || c === '"' || c === '`') {
      j = skipQuoted(code, j)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0) return j + 1
      depth--
    }
    j++
  }
  return code.length
}

/** 参数里的 / 是不是正则的开头：前一个有意义的字符是 ( , = 等时是 */
function regexAllowed(code, i) {
  let k = i - 1
  while (k >= 0 && /\s/.test(code[k])) k--
  return k < 0 || '(,=:[!&|?{};'.includes(code[k])
}

/** 跳过一个正则字面量（含结尾的修饰符），返回它后面的位置 */
function skipRegex(code, i) {
  let inClass = false
  let j = i + 1
  while (j < code.length) {
    const c = code[j]
    if (c === '\\') j += 2
    else if (c === '\n') return j
    else {
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        j++
        while (j < code.length && /[a-z]/.test(code[j])) j++
        return j
      }
      j++
    }
  }
  return code.length
}

function shorten(expr) {
  const one = expr.replace(/\s+/g, ' ')
  return one.length > EXPR_MAX ? `${one.slice(0, EXPR_MAX - 1)}…` : one
}
