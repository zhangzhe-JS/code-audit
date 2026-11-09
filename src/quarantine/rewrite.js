/**
 * 被移进隔离区的文件，里面的相对路径要改成新位置下也对的写法
 *
 * 文件本来就没人用，构建不受影响；但类型检查、lint 会检查所有源码文件，相对路径指错了会报错。
 *
 * 改法：
 * - 优先改成别名写法（../api/x → @/api/x）：别名不随文件位置变，以后移回原路径也不用再改
 * - 没有合适的别名时，按新位置算相对路径
 * - 指向同一批被移走的文件的，按它们的新位置算（子目录结构不变时等于不变）
 * - 解析不出指向哪个文件的（文件不存在）不改，列出来
 *
 * 认的写法：import / export from / import() / require 的路径；样式里的 @import、url()；模板里的 src、href
 * 注释行里的不改（// 或 * 开头的行）
 */
import { posix } from 'node:path'

const PATTERNS = [
  // import x from './a'、export { x } from './a'、import './a'、import('./a')、require('./a')
  /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])(\.\.?\/[^'"`\n]+)\2/g,
  // @import '../a.scss'、@import url('../a.css')
  /(@import\s+(?:url\(\s*)?)(['"])(\.\.?\/[^'"\n]+)\2/g,
  // url('../img/a.png')、url(../img/a.png)
  /(\burl\(\s*)(['"]?)(\.\.?\/[^'")\s\n]+)\2/g,
  // <img src="../a.png">、<link href="./a.css">
  /(\s(?:src|href)\s*=\s*)(["'])(\.\.?\/[^"'\n]+)\2/g
]

/**
 * @param {object} opts
 * @param {string} opts.content  文件内容
 * @param {string} opts.from     原路径
 * @param {string} opts.to       新路径
 * @param {Map<string, string>} opts.moved  这一批移走的文件：原路径 → 新路径
 * @param {Record<string, string>} [opts.aliases]
 * @param {(path: string) => string|null} opts.locate  路径（可能没写扩展名、指向目录）→ 提交里的文件或目录；不存在返回 null
 * @returns {{content: string, changes: {line: number, before: string, after: string}[], unresolved: {line: number, spec: string}[]}}
 */
export function rewriteRelativePaths({ content, from, to, moved, aliases = {}, locate }) {
  const changes = []
  const unresolved = []
  const lines = content.split('\n')
  const out = lines.map((text, i) => {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return text
    let line = text
    for (const re of PATTERNS) {
      line = line.replace(re, (all, lead, quote, spec) => {
        const [path, suffix] = splitSuffix(spec)
        const resolved = posix.normalize(posix.join(posix.dirname(from), path))
        if (resolved.startsWith('../')) return all // 指到仓库外面：不管
        const hit = locate(resolved)
        if (hit === null) {
          unresolved.push({ line: i + 1, spec })
          return all
        }
        const next = newSpec({ resolved, hit, to, moved, aliases }) + suffix
        if (next === spec) return all
        changes.push({ line: i + 1, before: spec, after: next })
        return `${lead}${quote}${next}${quote}`
      })
    }
    return line
  })
  return { content: out.join('\n'), changes, unresolved }
}

/** 算新的写法：指向的文件也移走了，按它的新位置；否则优先别名，没有别名按相对路径 */
function newSpec({ resolved, hit, to, moved, aliases }) {
  let target = resolved
  if (moved.has(hit)) {
    const movedTo = moved.get(hit)
    // 原写法省略了扩展名、或者指向目录（index 文件）：新写法保持一样的省略方式
    if (hit === resolved) target = movedTo
    else if (posix.dirname(hit) === resolved && /^index\./.test(posix.basename(hit))) target = posix.dirname(movedTo)
    else target = movedTo.slice(0, movedTo.length - posix.extname(movedTo).length)
    return relative(posix.dirname(to), target)
  }
  // 原文件和指向的文件都在某个别名目录下：改成别名写法
  const alias = Object.entries(aliases)
    .filter(([, dir]) => target === dir || target.startsWith(`${dir}/`))
    .sort((a, b) => b[1].length - a[1].length)[0]
  if (alias) return alias[0] + target.slice(alias[1].length)
  return relative(posix.dirname(to), target)
}

function relative(fromDir, target) {
  const rel = posix.relative(fromDir, target)
  return rel.startsWith('.') ? rel : `./${rel}`
}

/** 把 ?raw、#hash 这种后缀分出来，原样保留 */
function splitSuffix(spec) {
  const i = spec.search(/[?#]/)
  return i < 0 ? [spec, ''] : [spec.slice(0, i), spec.slice(i)]
}

/**
 * 按提交里的文件列表，把路径（可能没写扩展名、指向目录）落到具体的文件或目录
 * @param {Set<string>} files  提交里的所有文件
 * @param {string[]} extensions  省略扩展名时试哪些
 * @returns {(path: string) => string|null}
 */
export function makeLocator(files, extensions) {
  const dirs = new Set()
  for (const f of files) {
    let d = posix.dirname(f)
    while (d !== '.' && !dirs.has(d)) {
      dirs.add(d)
      d = posix.dirname(d)
    }
  }
  return (path) => {
    if (files.has(path)) return path
    for (const e of extensions) if (files.has(path + e)) return path + e
    for (const e of extensions) if (files.has(`${path}/index${e}`)) return `${path}/index${e}`
    if (dirs.has(path)) return path
    return null
  }
}
