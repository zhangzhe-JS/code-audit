/**
 * 引用的时间线：某个文件在什么时候被谁引用、什么时候失去引用
 *
 * 做法：在每个相关的主线提交上「拍快照」，看当时有哪些文件引用了目标，再和上一次比较
 */
import { git, COMMIT_FORMAT, parseCommit, plainPath } from './git.js'
import { stripComments } from '../collect/strip-comments.js'
import { DEFAULT_CONFIG } from '../core/config.js'

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
 * 例：['.js', '.vue'] → ['*.js', '*.vue']
 */
export function toGlobs(extensions) {
  return extensions.map((ext) => `*${ext}`)
}

/**
 * 文件在历史上用过的所有路径（改名、移动前的旧路径），包括当前路径
 * 用来排除目标文件自己：旧提交里它还在旧路径上，不能被当成引用方
 * @returns {Set<string>}
 */
export function historicalPaths(root, file, rev = 'HEAD') {
  const out = git(root, ['log', rev, '--follow', '--name-only', '--format=', '--', file])
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
 * 某个提交时，哪些文件在注释以外的地方包含 pattern
 * @param {string | Set<string>} [exclude] 要排除的文件（目标文件自己），可以传多个路径
 * @param {readonly string[]} [extensions] 只在这些扩展名的文件里找，默认取 DEFAULT_CONFIG
 * @returns {Set<string>} 引用方文件路径
 * 仓库、提交号无效等错误会抛出，不会当成「没有引用」
 */
export function refsAt(root, commit, pattern, exclude, extensions = DEFAULT_CONFIG.extensions) {
  const skip = exclude instanceof Set ? exclude : new Set(exclude ? [exclude] : [])

  let out
  try {
    // -l 只列出文件名，-F 按字面匹配；先用它快速找出可能引用的文件
    // 最后的路径匹配限定只搜源码文件
    out = git(root, ['grep', '-l', '-F', pattern, commit, '--', ...toGlobs(extensions)])
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

    // 读出这个提交时的完整文件，去掉注释后再确认
    const code = git(root, ['show', `${commit}:${file}`])
    if (containsPath(stripComments(code), pattern)) files.add(file)
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
 */
export function buildTimeline(root, pattern, { rev = 'HEAD', exclude, extensions = DEFAULT_CONFIG.extensions } = {}) {
  // 先找出所有改动过包含 pattern 的行的主线提交，按从旧到新排列
  const out = git(root, [
    'log',
    rev,
    '--first-parent', // 只看主线，日期是进入主线的那天
    '-m', // 合并提交也和第一个父提交比较，不会被跳过
    '--reverse', // 从旧到新
    `-G${escapeRegex(pattern)}`, // 只要改动的行里包含 pattern 的提交（注释掉也算改动）
    '--date=short',
    `--format=${COMMIT_FORMAT}`
  ])

  // 目标文件改名前的旧路径也要排除，否则旧提交里它自己会被当成引用方
  // 传数组：调用方已经查好了全部路径（如 traceOrigin 的结果）；传字符串：这里用 --follow 查
  const skip = Array.isArray(exclude)
    ? new Set(exclude)
    : exclude
      ? historicalPaths(root, exclude, rev)
      : new Set()

  const timeline = []
  let prev = new Set()
  // 加了 -m 后输出里可能夹带空行，过滤掉
  for (const line of out.split('\n').filter(Boolean)) {
    const commit = parseCommit(line)
    const now = refsAt(root, commit.hash, pattern, skip, extensions)

    for (const f of now) if (!prev.has(f)) timeline.push({ commit, change: 'add', from: f })
    for (const f of prev) if (!now.has(f)) timeline.push({ commit, change: 'remove', from: f })

    prev = now
  }
  return timeline
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
    if (e.change === 'add') {
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
