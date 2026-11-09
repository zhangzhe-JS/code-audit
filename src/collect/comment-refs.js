/**
 * 在注释里找候选文件的引用：被注释掉的 import、构建配置里注释掉的路径
 *
 *   // import { checkBrowser } from '@/utils/browser-check.js'
 *   // old: path.resolve(__dirname, 'src/old.js')
 *   <!-- <script src="/src/old.js"></script> -->
 *
 * 引用被注释掉，说明以前用过、以后可能恢复（注释停用）。
 *
 * 只认注释里引号括起来的路径，按写注释的文件解析：
 *   ./ ../   相对写注释的文件
 *   别名     按 aliases 换成目录
 *   /        相对仓库根目录
 *   其他     当成从仓库根目录写起（构建配置里常见的 'src/a.js'）
 * 解析出的路径等于候选文件、等于去掉扩展名的候选文件，或是 index 文件所在的目录，就算引用
 * 注释里不带引号的文字（如「旧的 src/a.js 已不用」）不算：那是说明，不是代码
 *
 * 已知限制：.vue 模板里注释掉的组件标签（<!-- <OldComp /> -->）不认：标签名对不上文件路径，
 * 一般同一个文件里注释掉的 import 会被认出来
 */
import { findComments } from './strip-comments.js'
import { SFC_EXTENSIONS, scriptOnly } from './source-text.js'
import { buildLookup, resolveSpec } from './path-refs.js'

const JS_LIKE = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx']
const QUOTED = /(['"`])([^'"`\n]+?)\1/g
const SNIPPET_MAX = 80

/**
 * @typedef {object} CommentRef
 * @property {string} from  写注释的文件
 * @property {number} line
 * @property {string} text  注释所在的那一行，压缩空白，过长截断
 */

/**
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files  要搜注释的文件
 * @param {string[]} opts.targets  候选文件
 * @param {Record<string, string>} [opts.aliases]
 * @returns {Map<string, CommentRef[]>} 候选文件 → 注释掉的引用；没有的不在 Map 里
 */
export function findCommentRefs({ files, targets, aliases = {} }) {
  const lookup = buildLookup(targets)
  const result = new Map()
  for (const { path, content } of files) {
    const lines = content.split('\n')
    for (const c of commentsOf(path, content)) {
      for (const m of c.text.matchAll(QUOTED)) {
        const resolved = resolveSpec(m[2], path, aliases)
        if (resolved === null) continue
        for (const target of lookup.get(resolved) ?? []) {
          const line = c.line + countNewlines(c.text.slice(0, m.index))
          const refs = result.get(target) ?? []
          if (!refs.some((r) => r.from === path && r.line === line)) {
            refs.push({ from: path, line, text: shorten(lines[line - 1] ?? '') })
          }
          result.set(target, refs)
        }
      }
    }
  }
  for (const refs of result.values()) refs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line))
  return result
}

/** 文件里的注释：JS 类文件、单文件组件的 <script> 用 JS 注释；html 用 <!-- --> */
function commentsOf(path, content) {
  if (SFC_EXTENSIONS.some((e) => path.endsWith(e))) return findComments(scriptOnly(content))
  if (JS_LIKE.some((e) => path.endsWith(e))) return findComments(content)
  if (path.endsWith('.html')) return htmlComments(content)
  return [] // json、yml 等：json 没有注释，yml 的 # 注释暂不处理
}

/** html 的 <!-- --> 注释，记下开始的行号 */
export function htmlComments(content) {
  const out = []
  for (const m of content.matchAll(/<!--([\s\S]*?)-->/g)) {
    out.push({ line: 1 + countNewlines(content.slice(0, m.index)), text: m[1] })
  }
  return out
}

function countNewlines(s) {
  return (s.match(/\n/g) ?? []).length
}

function shorten(line) {
  const one = line.replace(/\s+/g, ' ').trim()
  return one.length > SNIPPET_MAX ? `${one.slice(0, SNIPPET_MAX - 1)}…` : one
}
