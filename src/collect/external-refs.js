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
 * index 文件也认目录写法：src/a/index.js 匹配 'src/a'（只认多级目录：'src' 这种顶层目录名太常见）
 * 省略扩展名的写法正好也是个目录（提交里有 src/i18n/menu.js，也有 src/i18n/menu/ 目录）时，'src/i18n/menu' 指哪个说不准：
 * 不算确认的引用，记进 ambiguous，由规则判 unknown（写了扩展名的照常算）
 * JS 类文件、html 先去掉注释（注释掉的引用不算在用，由 comment-refs 判为注释停用）；json、yml 等原样搜
 *
 * JS 类文件里还会：
 * - 按文件所在目录解析引号里的相对路径（build/ 下写 './x' 指 build/x）
 * - 把 path.join / path.resolve 的各段拼起来（__dirname、process.cwd()、ROOT 这类变量当成文件所在目录或仓库根目录）
 *
 * 拼接出来、算不出来的路径（中间有变量），由 findExternalMaybe 兜底：出现了同名文件名就判 unknown，不判死
 */
import { posix } from 'node:path'
import { stripComments } from './strip-comments.js'
import { lineAt } from './source-text.js'
import { buildLookup, resolveSpec } from './path-refs.js'

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
 * @param {Record<string, string>} [opts.aliases]
 * @param {(path: string) => boolean} [opts.isDir] 提交里有没有这个目录（省略扩展名的写法判断歧义用）
 * @param {Map<string, ExternalRef[]>} [opts.ambiguous] 有歧义的写法收集到这里（判 unknown）
 * @returns {Map<string, ExternalRef[]>} 候选文件 → 写着它路径的地方；没有的不在 Map 里
 */
export function findExternalRefs({ files, targets, aliases = {}, isDir = () => false, ambiguous = new Map() }) {
  const matchers = targets.map((t) => ({ target: t, forms: formsOf(t, isDir) }))
  const lookup = buildLookup(targets)
  const result = new Map()
  const add = (target, path, code, index, line = lineAt(code, index)) => {
    const refs = result.get(target) ?? []
    if (!refs.some((r) => r.from === path && r.line === line)) refs.push({ from: path, line, text: lineText(code, line) })
    result.set(target, refs)
  }
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
          if (!form.ambiguous) {
            add(target, path, code, m.index)
            continue
          }
          const line = lineAt(code, m.index)
          const list = ambiguous.get(target) ?? []
          if (!list.some((r) => r.from === path && r.line === line)) {
            list.push({ from: path, line, text: `${lineText(code, line)}（不带扩展名，也可能指同名目录 ${form.text}/）` })
          }
          ambiguous.set(target, list)
        }
      }
    }
    if (!JS_LIKE.some((e) => path.endsWith(e))) continue
    // 解析出的路径：正好是个目录（又不是文件本身）时说不准，记成有歧义
    const addResolved = (resolved, line) => {
      for (const target of lookup.get(resolved) ?? []) {
        if (resolved !== target && isDir(resolved)) {
          const list = ambiguous.get(target) ?? []
          if (!list.some((r) => r.from === path && r.line === line)) {
            list.push({ from: path, line, text: `${lineText(code, line)}（不带扩展名，也可能指同名目录 ${resolved}/）` })
          }
          ambiguous.set(target, list)
        } else {
          add(target, path, code, 0, line)
        }
      }
    }
    // 相对这个文件的路径：'./x'、'../src/x'
    for (const m of code.matchAll(/(["'`])(\.\.?\/[^"'`\n]+)\1/g)) addResolved(resolveSpec(m[2], path, aliases), lineAt(code, m.index))
    // path.join / path.resolve 的各段都能算出来时，拼起来
    for (const { line, candidates } of joinedPaths(code, path)) for (const p of candidates) addResolved(p, line)
  }
  for (const refs of result.values()) refs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line))
  return result
}

/**
 * path.join(...) / path.resolve(...)：各段是字符串、__dirname、process.cwd() 或一个变量（如 ROOT）时拼出路径
 * 变量不知道指哪里：按仓库根目录和文件所在目录各算一次
 * @returns {{line: number, candidates: string[]}[]}
 */
export function joinedPaths(code, from) {
  const out = []
  const text = code.replace(/process\.cwd\(\)/g, '__CWD__')
  for (const m of text.matchAll(/\bpath\.(?:join|resolve)\s*\(([^()]*)\)/g)) {
    const args = m[1].split(',').map((a) => a.trim()).filter(Boolean)
    if (args.length === 0) continue
    const segs = []
    let bases = ['']
    let ok = true
    args.forEach((a, i) => {
      const lit = a.match(/^(["'`])([^"'`]*)\1$/)
      if (lit) segs.push(lit[2])
      else if (i === 0 && a === '__dirname') bases = [posix.dirname(from)]
      else if (i === 0 && a === '__CWD__') bases = ['']
      else if (i === 0 && /^[A-Za-z_$][\w$.]*$/.test(a)) bases = ['', posix.dirname(from)]
      else ok = false
    })
    if (!ok || segs.length === 0) continue
    const candidates = bases
      .map((b) => posix.normalize(posix.join(b, ...segs.map((s) => s.replace(/^\//, '')))).replace(/\/+$/, ''))
      .filter((p) => p !== '.' && !p.startsWith('../'))
    // 换占位符不会增减换行：在替换后的文本里算的行号就是原文的行号
    out.push({ line: lineAt(text, m.index), candidates })
  }
  return out
}

/** 第几行的内容，压缩空白、过长截断 */
function lineText(code, line) {
  return shortenLine(code.split('\n')[line - 1] ?? '')
}

/**
 * 兜底：算不出路径（中间有变量）时，引号里出现了候选的文件名（带扩展名），就可能是拼出来的路径
 * 只用带扩展名的文件名，index.* 不算（太常见）；已经确认是 external 的不再报
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files
 * @param {string[]} opts.targets
 * @param {Map<string, ExternalRef[]>} opts.found  findExternalRefs 已经找到的
 * @returns {Map<string, ExternalRef[]>}
 */
export function findExternalMaybe({ files, targets, found }) {
  const result = new Map()
  const names = targets
    .filter((t) => !found.has(t) && !/^index\./.test(posix.basename(t)))
    .map((t) => ({ target: t, re: new RegExp(`(["'\`])[^"'\`\n]*(?<![\\w.-])${escape(posix.basename(t))}\\1`, 'g') }))
  for (const { path, content } of files) {
    const code = JS_LIKE.some((e) => path.endsWith(e)) ? stripComments(content) : content
    for (const { target, re } of names) {
      for (const m of code.matchAll(re)) {
        const line = lineAt(code, m.index)
        const refs = result.get(target) ?? []
        if (!refs.some((r) => r.from === path && r.line === line)) refs.push({ from: path, line, text: lineText(code, line) })
        result.set(target, refs)
      }
    }
  }
  return result
}

/**
 * 一个文件的几种写法，每种配一个带边界的正则
 * - 去掉扩展名的路径，后面可以跟原扩展名：src/a/b → src/a/b、src/a/b.js
 * - index 文件再加目录写法：src/a/index.js → src/a、src/a/
 */
function formsOf(file, isDir = () => false) {
  const ext = posix.extname(file)
  const stem = ext ? file.slice(0, -ext.length) : file
  const forms = []
  if (ext && isDir(stem)) {
    // 省略扩展名的写法也可能指同名目录：只认带扩展名的；不带的单独记成有歧义
    forms.push({ text: stem, re: bounded(escape(stem) + escape(ext)) })
    forms.push({ text: stem, re: bounded(`${escape(stem)}/?`), ambiguous: true })
  } else {
    forms.push({ text: stem, re: bounded(escape(stem) + (ext ? `(?:${escape(ext)})?` : '')) })
  }
  if (posix.basename(stem) === 'index' && posix.dirname(stem).includes('/')) {
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

function shortenLine(text) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1)}…` : line
}
