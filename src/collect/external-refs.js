/**
 * 在 knip 不分析的文件里找候选文件的路径：构建配置、脚本、index.html、json 配置等
 *
 * knip 只分析源码目录下、配置扩展名的文件。其余文件里写着某个源码文件的路径，比如
 *   vite 配置里 path.resolve(process.cwd(), 'src/shims/stub.js')
 *   脚本里     path.join(ROOT, 'src/i18n/menu.js')
 * 说明它在 import 图之外被使用，knip 看不到
 *
 * 按路径匹配（去掉扩展名，带不带扩展名都算），两侧有边界：
 *   src/a 不匹配 src/a.config.js、src/a/b.js、src/ab.js
 * index 文件也认目录写法：src/a/index.js 匹配 'src/a'
 * JS 类文件、html 先去掉注释（注释掉的引用不算在用，由 comment-refs 判为注释停用）；json、yml 等原样搜
 *
 * 已知限制：只认从仓库根目录写起的路径（前面可以有 ./、/、../ 等）。
 * 相对配置文件所在目录的写法（如 build/ 下写 '../src/a' 能匹配，但写 'a' 不行）、拼接出来的路径找不到
 */
import { posix } from 'node:path'
import { stripComments } from './strip-comments.js'
import { lineAt } from './source-text.js'

/** 要搜的文本文件类型 */
export const EXTERNAL_EXTENSIONS = Object.freeze([
  '.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx',
  '.json', '.html', '.yml', '.yaml', '.sh'
])

/** 锁文件很大，只有包名，不会写源码路径 */
const LOCK_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'])

const JS_LIKE = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx']
const SNIPPET_MAX = 80

/**
 * 从提交里的文件中挑出要搜的：knip 分析的源码文件之外的文本文件
 * @param {object} opts
 * @param {string[]} opts.all          提交里扩展名在 EXTERNAL_EXTENSIONS 里的文件
 * @param {string[]} opts.sourceRoots
 * @param {string[]} opts.extensions   knip 分析的扩展名
 * @param {Set<string>} opts.exclude   不搜的文件（测试文件：测试里引用算「只有测试用到」，不算图外使用）
 * @returns {string[]}
 */
export function externalFiles({ all, sourceRoots, extensions, exclude }) {
  return all.filter((f) => {
    if (exclude.has(f) || LOCK_FILES.has(posix.basename(f))) return false
    const inSource = sourceRoots.some((r) => f.startsWith(`${r}/`))
    const analyzed = inSource && extensions.some((e) => f.endsWith(e))
    return !analyzed
  })
}

/**
 * @typedef {object} ExternalRef
 * @property {string} from  写着路径的文件
 * @property {number} line
 * @property {string} text  那一行，压缩空白，过长截断
 */

/**
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files  要搜的文件
 * @param {string[]} opts.targets  候选文件
 * @returns {Map<string, ExternalRef[]>} 候选文件 → 写着它路径的地方；没有的不在 Map 里
 */
export function findExternalRefs({ files, targets }) {
  const matchers = targets.map((t) => ({ target: t, forms: formsOf(t) }))
  const result = new Map()
  for (const { path, content } of files) {
    const code = JS_LIKE.some((e) => path.endsWith(e))
      ? stripComments(content)
      : path.endsWith('.html')
        ? stripHtmlComments(content)
        : content
    for (const { target, forms } of matchers) {
      for (const form of forms) {
        if (!code.includes(form.text)) continue
        for (const m of code.matchAll(form.re)) {
          const line = lineAt(code, m.index)
          const refs = result.get(target) ?? []
          if (!refs.some((r) => r.from === path && r.line === line)) {
            refs.push({ from: path, line, text: snippet(code, m.index) })
          }
          result.set(target, refs)
        }
      }
    }
  }
  for (const refs of result.values()) refs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line))
  return result
}

/**
 * 一个文件的几种写法，每种配一个带边界的正则
 * - 去掉扩展名的路径，后面可以跟原扩展名：src/a/b → src/a/b、src/a/b.js
 * - index 文件再加目录写法：src/a/index.js → src/a、src/a/
 */
function formsOf(file) {
  const ext = posix.extname(file)
  const stem = ext ? file.slice(0, -ext.length) : file
  const forms = [{ text: stem, re: bounded(escape(stem) + (ext ? `(?:${escape(ext)})?` : '')) }]
  if (posix.basename(stem) === 'index' && posix.dirname(stem) !== '.') {
    const dir = posix.dirname(stem)
    forms.push({ text: dir, re: bounded(`${escape(dir)}/?`) })
  }
  return forms
}

/** 左边不是名字的一部分；右边不再接名字、扩展名或下一级路径 */
function bounded(body) {
  return new RegExp(`(?<![\\w$@-])${body}(?![\\w.$/-])`, 'g')
}

/** 去掉 html 的 <!-- -->，换行保留：行号不变 */
function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function snippet(code, index) {
  const start = code.lastIndexOf('\n', index) + 1
  const end = code.indexOf('\n', index)
  const line = code.slice(start, end < 0 ? code.length : end).replace(/\s+/g, ' ').trim()
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1)}…` : line
}
