/**
 * 引用的时间线：某个文件在什么时候被谁引用、什么时候失去引用
 *
 * 做法：在每个相关的主线提交上「拍快照」，看当时有哪些文件引用了目标，再和上一次比较
 *
 * 怎么算「引用」：解析 import / export from / import() / require 里的路径（相对路径、别名、省略扩展名、目录 index），
 * 和目标文件用过的所有路径比对。注释里的不算，.vue 只看 <script>。
 * 解析不了的写法（没配置的别名、包名）退回按 pattern 字面匹配（如 '@/utils/math' 里有 utils/math）。
 * 所以：同目录的 './math' 认得出；'./math.config'、同名目录下的其他文件、'/api/document/stream' 这种接口地址都不算
 *
 * 找候选提交、候选文件时先按文件名粗筛（'/math'），再逐个解析确认
 */
import { git, COMMIT_FORMAT, parseCommit, plainPath } from './git.js'
import { DEFAULT_CONFIG } from '../core/config.js'
import { buildLookup, IMPORT_SPEC, resolveSpec } from '../collect/path-refs.js'
import { codeOf } from '../collect/source-text.js'
import { posix } from 'node:path'

/**
 * 转义扩展正则（git -G 使用的规则）的特殊字符，让 pattern 按字面匹配
 * 注意：只适用于扩展正则，用在基本正则里 \+ \( 反而会变成特殊符号
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把扩展名列表转成 git 的路径匹配写法，限定只在源码文件里找引用方
 * README、构建产物、翻译 json、sourcemap 等文件里也会出现路径字符串，但不是引用
 * 类型声明文件（.d.ts）也排除：构建后不存在，里面的路径只是类型引用，不是运行时的使用
 *   （如 unplugin-vue-components 生成的 components.d.ts 登记了所有组件，算进来的话组件永远「仍被引用」）
 * 例：['.js', '.ts'] → ['*.js', '*.ts', ':(exclude)*.d.ts']
 */
export function toGlobs(extensions) {
  return [...extensions.map((ext) => `*${ext}`), ':(exclude)*.d.ts']
}

/**
 * 文件在历史上用过的所有路径（改名、移动前的旧路径），包括当前路径
 * 用来排除目标文件自己：旧提交里它还在旧路径上，不能被当成引用方
 * @returns {Set<string>}
 */
export function historicalPaths(root, file, rev = 'HEAD') {
  const out = git(root, ['log', rev, '--follow', '--name-only', '--format=', '--', literalPath(file)])
  const paths = new Set(out.split('\n').filter(Boolean).map(plainPath))
  paths.add(file)
  return paths
}

/**
 * 代码里是否以「完整的路径」出现了 pattern：前后不能紧挨着能组成文件名的字符
 * - utils/math 不匹配 utils/mathHelper、myutils/math（只是名字的一部分，是别的文件）
 * - utils/math 匹配 'utils/math'、utils/math.js、utils/math/index（后面跟的是引号、扩展名、子路径）
 * 已知限制：utils/math 也会匹配 utils/math.config（点号后面无法区分是扩展名还是文件名的一部分）
 */
export function containsPath(code, pattern) {
  return new RegExp(`(?<![\\w$-])${escapeRegex(pattern)}(?![\\w$-])`).test(code)
}

/**
 * 判断一个文件是不是引用了目标
 * @param {object} opts
 * @param {string[]} opts.paths   目标文件用过的所有路径（改名前的旧路径也算）
 * @param {string} opts.pattern   解析不了的写法退回按它字面匹配
 * @param {Record<string, string>} [opts.aliases]
 * @returns {{terms: string[], isRef: (file: string, content: string) => boolean}}
 *   terms：粗筛用的字面（git log -G、git grep）；isRef：解析确认
 */
export function makeRefMatcher({ paths, pattern, aliases = {} }) {
  const lookup = buildLookup(paths)
  const stems = [...new Set(paths.map(stemOf).filter(Boolean))]
  const terms = [...new Set([...stems.map((s) => `/${s}`), pattern])]
  const aliasNames = Object.keys(aliases)
  const isRef = (file, content) => {
    for (const m of codeOf(file, content).matchAll(IMPORT_SPEC)) {
      const spec = (m[2] ?? m[4]).replace(/[?#].*$/, '')
      const resolvable =
        spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || aliasNames.some((a) => spec === a || spec.startsWith(`${a}/`))
      if (resolvable) {
        const r = resolveSpec(spec, file, aliases)
        if (r !== null && lookup.has(r)) return true
      } else if (containsPath(spec, pattern)) {
        return true
      }
    }
    return false
  }
  return { terms, isRef }
}

/** 粗筛用的文件名：去掉扩展名；index 文件用目录名（引用目录时不写 index） */
function stemOf(path) {
  const base = posix.basename(path).replace(/\.[^.]+$/, '')
  return base === 'index' ? posix.basename(posix.dirname(path)) : base
}

/**
 * 某个提交时，哪些文件引用了目标
 * @param {string | {terms: string[], isRef: Function}} matcher pattern（字符串）或 makeRefMatcher 的结果；
 *   传字符串时，目标文件的路径取 exclude
 * @param {string | Set<string>} [exclude] 要排除的文件（目标文件自己），可以传多个路径
 * @param {readonly string[]} [extensions] 只在这些扩展名的文件里找，默认取 DEFAULT_CONFIG
 * @param {Record<string, string>} [aliases] 传字符串 matcher 时用
 * @returns {Set<string>} 引用方文件路径
 * 仓库、提交号无效等错误会抛出，不会当成「没有引用」
 */
export function refsAt(root, commit, matcher, exclude, extensions = DEFAULT_CONFIG.extensions, aliases = {}) {
  const skip = exclude instanceof Set ? exclude : new Set(exclude ? [exclude] : [])
  const m = typeof matcher === 'string' ? makeRefMatcher({ paths: [...skip], pattern: matcher, aliases }) : matcher

  let out
  try {
    // -l 只列出文件名；按文件名粗筛出可能引用的文件，再逐个解析确认。路径匹配限定只搜源码文件
    out = git(root, ['grep', '-l', '-F', ...m.terms.flatMap((t) => ['-e', t]), commit, '--', ...toGlobs(extensions)])
  } catch (e) {
    // git grep 没有匹配时退出码为 1，这是正常情况；其他退出码是真正的错误，必须抛出
    // 否则仓库不存在、提交号写错时会悄悄返回空集合，最终得出错误的 remove / dead 结论
    if (e.status === 1) return new Set()
    throw e
  }

  const files = new Set()
  for (const line of out.split('\n')) {
    // 每行格式：提交号:文件路径
    const file = line.slice(commit.length + 1)
    if (!file) continue
    plainPath(file)
    if (skip.has(file)) continue

    // 读出这个提交时的完整文件，解析 import 确认
    if (m.isRef(file, git(root, ['show', `${commit}:${file}`]))) files.add(file)
  }
  return files
}

/**
 * 引用时间线：每次有文件开始或停止引用 pattern，记一条
 * @returns {{commit: import('../core/schema.js').Commit, change: 'add'|'remove', from: string}[]}
 */
/**
 * @param {string} root
 * @param {string} pattern 引用方代码里会出现的字符串
 * @param {object} [opts]
 * @param {string} [opts.rev] 查到哪个提交为止，默认 HEAD
 * @param {string | string[]} [opts.exclude] 目标文件：传当前路径，或传它用过的全部路径
 * @param {readonly string[]} [opts.extensions] 只在这些扩展名的文件里找引用方，默认取 DEFAULT_CONFIG
 * @param {Record<string, string>} [opts.aliases] 解析 import 路径用的别名
 */
export function buildTimeline(root, pattern, { rev = 'HEAD', exclude, extensions = DEFAULT_CONFIG.extensions, aliases = {} } = {}) {
  // 目标文件改名前的旧路径也要排除，否则旧提交里它自己会被当成引用方
  // 传数组：调用方已经查好了全部路径（如 traceOrigin 的结果）；传字符串：这里用 --follow 查
  const skip = Array.isArray(exclude)
    ? new Set(exclude)
    : exclude
      ? historicalPaths(root, exclude, rev)
      : new Set()
  const matcher = makeRefMatcher({ paths: [...skip], pattern, aliases })
  // 每个提交只用目标当时所在的路径比对：文件改名后，旧路径上可能又新建了一个同名文件，引用那个文件的不算
  // 当时的路径 = 用过的路径里（从新到旧）在这个提交里存在的第一个
  const newestFirst = Array.isArray(exclude) ? exclude : [...skip]
  const matcherAt = (hash) => {
    const here = newestFirst.find((p) => exists(root, hash, p))
    return here ? makeRefMatcher({ paths: [here], pattern, aliases }) : matcher
  }

  // 先找出所有改动过包含文件名（或 pattern）的行的主线提交，按从旧到新排列
  const out = git(root, [
    'log',
    rev,
    '--first-parent', // 只看主线，日期是进入主线的那天
    '-m', // 合并提交也和第一个父提交比较，不会被跳过
    '--reverse', // 从旧到新
    '-E',
    `-G${matcher.terms.map(escapeRegex).join('|')}`, // 改动的行里有这些字面的提交（注释掉也算改动）
    '--date=short',
    `--format=${COMMIT_FORMAT}`
  ])

  // 只改名、内容没改的提交没有改动的行，-G 找不到：引用方在这种提交里改了名，也要拍快照。
  // 主线上有改名的提交另外找出来，按主线顺序和上面的合在一起；只有改名里有当时的引用方时才拍快照
  const commits = new Map(out.split('\n').filter(Boolean).map((l) => [parseCommit(l).hash, { commit: parseCommit(l), byRename: false }]))
  const renameOut = git(root, ['log', rev, '--first-parent', '-m', '-M', '--diff-filter=R', '--date=short', `--format=${COMMIT_FORMAT}`])
  for (const l of renameOut.split('\n').filter(Boolean)) {
    const c = parseCommit(l)
    if (!commits.has(c.hash)) commits.set(c.hash, { commit: c, byRename: true })
  }
  const order = new Map(
    git(root, ['rev-list', '--first-parent', '--reverse', rev])
      .split('\n')
      .filter(Boolean)
      .map((h, i) => [h, i])
  )
  const ordered = [...commits.values()].sort((a, b) => order.get(a.commit.hash) - order.get(b.commit.hash))

  const timeline = []
  let prev = new Set()
  for (const { commit, byRename } of ordered) {
    if (byRename) {
      const renamed = renamesIn(root, commit.hash)
      // 改名的是引用方，或者是目标自己（路径变了，同一个 import 指向的可能不一样了）才拍快照
      const touchesTarget = [...renamed].some(([a, b]) => skip.has(a) || skip.has(b))
      if (!touchesTarget && ![...prev].some((f) => renamed.has(f))) continue
    }
    // 粗筛用全部路径的文件名，确认时只认当时的路径
    const here = newestFirst.find((p) => exists(root, commit.hash, p))
    const now = refsAt(root, commit.hash, { terms: matcher.terms, isRef: matcherAt(commit.hash).isRef }, here, extensions)

    const added = [...now].filter((f) => !prev.has(f))
    const removed = [...prev].filter((f) => !now.has(f))
    // 引用方改了名：同一次提交里一个引用方消失、一个出现，git 认得出是改名，记一条 rename，不记成去掉 + 新增
    const renames = added.length > 0 && removed.length > 0 ? renamesIn(root, commit.hash) : new Map()
    for (const f of removed) {
      const to = renames.get(f)
      if (to && added.includes(to)) {
        timeline.push({ commit, change: 'rename', from: to, previous: f })
        added.splice(added.indexOf(to), 1)
      } else {
        timeline.push({ commit, change: 'remove', from: f })
      }
    }
    for (const f of added) timeline.push({ commit, change: 'add', from: f })

    prev = now
  }
  return timeline
}

/** 这个提交里有没有这个文件 */
function exists(root, hash, path) {
  try {
    git(root, ['cat-file', '-e', `${hash}:${path}`])
    return true
  } catch {
    return false
  }
}

function literalPath(path) {
  return `:(literal)${path}`
}

/**
 * 这次提交里的改名：旧路径 → 新路径（和第一个父提交比较；没有父提交时为空）
 */
function renamesIn(root, hash) {
  const map = new Map()
  let out
  try {
    out = git(root, ['diff', '--name-status', '-M', '-z', `${hash}^1`, hash], { raw: true })
  } catch {
    return map // 第一个提交没有父提交
  }
  const parts = out.split('\0').filter(Boolean)
  for (let i = 0; i < parts.length; ) {
    const status = parts[i]
    if (status.startsWith('R')) {
      map.set(parts[i + 1], parts[i + 2])
      i += 3
    } else if (status.startsWith('C')) {
      i += 3
    } else {
      i += 2
    }
  }
  return map
}

/**
 * 从时间线推出失去引用的提交：最后一次引用方变成空的那次
 * 返回 null 有两种情况，用 timeline 区分：
 * - timeline 为空：从来没被引用过
 * - timeline 不为空：现在仍被引用
 *
 * 时间线必须完整（从第一次引用开始）：remove 一个没有 add 过的引用方、
 * 或重复 add 同一个引用方，说明时间线被截断或拼错了，直接抛错，不猜结论
 * @returns {import('../core/schema.js').Commit | null}
 */
export function findLostRef(timeline) {
  const current = new Set()
  let lost = null
  for (const [k, e] of timeline.entries()) {
    if (e.change === 'rename') {
      // 引用方改名：还在引用，换了个路径
      if (!current.has(e.previous)) throw new Error(`时间线不完整：第 ${k} 条改名的 ${e.previous} 从未引入`)
      current.delete(e.previous)
      current.add(e.from)
    } else if (e.change === 'add') {
      if (current.has(e.from)) {
        throw new Error(`时间线不完整：第 ${k} 条重复引入 ${e.from}`)
      }
      current.add(e.from)
    } else if (e.change === 'remove') {
      if (!current.has(e.from)) {
        throw new Error(`时间线不完整：第 ${k} 条移除了从未引入的 ${e.from}`)
      }
      current.delete(e.from)
      if (current.size === 0) lost = e.commit
    } else {
      throw new Error(`时间线第 ${k} 条的 change 不合法：${e.change}`)
    }
  }
  return current.size === 0 ? lost : null
}
