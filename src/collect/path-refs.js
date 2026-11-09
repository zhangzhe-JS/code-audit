/**
 * 代码里写的路径 → 仓库里的哪个文件
 *
 * - resolveSpec：把 import 路径、注释里的路径换成相对仓库根目录的路径
 * - buildLookup：解析出的路径可能指哪个候选（完整路径、省略扩展名、index 文件的目录）
 * - findImportRefs：找出代码里 import / export from / import() / require() 指向候选的地方
 *
 * comment-refs（注释里的引用）和规则层（测试引用、候选之间的引用）共用
 */
import { posix } from 'node:path'
import { codeOf, lineAt } from './source-text.js'

/**
 * 代码、注释里的路径换成相对仓库根目录的路径（不带结尾的 /）；不像路径的返回 null
 * @param {string} spec
 * @param {string} from
 * @param {Record<string, string>} aliases
 * @param {{text?: boolean}} [opts] text：spec 来自注释、报错这类文字时为 true，带空格的当成一句话不当路径；
 *   import 里的路径不设（文件名真有带空格的）
 */
export function resolveSpec(spec, from, aliases, { text = false } = {}) {
  let p = spec.replace(/[?#].*$/, '')
  if (text) p = p.trim()
  if (p.trim() === '' || (text && /\s/.test(p)) || /^[a-z]+:/i.test(p)) return null // 文字里带空格的是句子，http: 等是网址
  if (p.startsWith('./') || p.startsWith('../')) {
    p = posix.join(posix.dirname(from), p)
  } else {
    const name = Object.keys(aliases)
      .filter((a) => p === a || p.startsWith(`${a}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (name !== undefined) p = aliases[name] + p.slice(name.length)
    else if (p.startsWith('/')) p = p.slice(1)
  }
  p = posix.normalize(p).replace(/\/+$/, '')
  if (p === '' || p === '.' || p.startsWith('../') || p.startsWith('/')) return null
  return p
}

/** 解析出的路径 → 它可能指的候选文件：完整路径、去掉扩展名、index 文件的目录 */
export function buildLookup(targets) {
  const lookup = new Map()
  const add = (key, t) => lookup.set(key, [...(lookup.get(key) ?? []), t])
  for (const t of targets) {
    add(t, t)
    const ext = posix.extname(t)
    if (!ext) continue
    const stem = t.slice(0, -ext.length)
    add(stem, t)
    if (posix.basename(stem) === 'index' && posix.dirname(stem) !== '.') add(posix.dirname(stem), t)
  }
  return lookup
}

/** import x from 'a'、import 'a'、export { x } from 'a'、import('a')、require('a') 里的路径 */
export const IMPORT_SPEC = /\b(?:from|import)\s*\(?\s*(['"`])([^'"`\n]+)\1|\brequire\s*\(\s*(['"`])([^'"`\n]+)\3/g

/**
 * @typedef {object} ImportRef
 * @property {string} from  写 import 的文件
 * @property {number} line
 */

/**
 * 代码里（去掉注释后）指向候选文件的 import
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files
 * @param {string[]} opts.targets  候选文件
 * @param {Record<string, string>} [opts.aliases]
 * @returns {Map<string, ImportRef[]>} 被引用的候选 → 引用它的地方；自己引用自己不算
 */
export function findImportRefs({ files, targets, aliases = {} }) {
  const lookup = buildLookup(targets)
  const result = new Map()
  for (const { path, content } of files) {
    const code = codeOf(path, content)
    for (const m of code.matchAll(IMPORT_SPEC)) {
      const resolved = resolveSpec(m[2] ?? m[4], path, aliases)
      if (resolved === null) continue
      for (const target of lookup.get(resolved) ?? []) {
        if (target === path) continue
        const line = lineAt(code, m.index)
        const refs = result.get(target) ?? []
        if (!refs.some((r) => r.from === path && r.line === line)) refs.push({ from: path, line })
        result.set(target, refs)
      }
    }
  }
  for (const refs of result.values()) refs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line))
  return result
}
