/**
 * 引用的时间线：某个文件在什么时候被谁引用、什么时候失去引用
 *
 * 做法：在每个相关的主线提交上「拍快照」，看当时有哪些文件引用了目标，再和上一次比较
 */
import { git, COMMIT_FORMAT, parseCommit } from './git.js'
import { stripComments } from '../collect/strip-comments.js'

/**
 * 转义扩展正则（git -G 使用的规则）的特殊字符，让 pattern 按字面匹配
 * 注意：只适用于扩展正则，用在基本正则里 \+ \( 反而会变成特殊符号
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 文件在历史上用过的所有路径（改名、移动前的旧路径），包括当前路径
 * 用来排除目标文件自己：旧提交里它还在旧路径上，不能被当成引用方
 * @returns {Set<string>}
 */
export function historicalPaths(root, file, rev = 'HEAD') {
  const out = git(root, ['log', rev, '--follow', '--name-only', '--format=', '--', file])
  const paths = new Set(out.split('\n').filter(Boolean))
  paths.add(file)
  return paths
}

/**
 * 某个提交时，哪些文件在注释以外的地方包含 pattern
 * @param {string | Set<string>} [exclude] 要排除的文件（目标文件自己），可以传多个路径
 * @returns {Set<string>} 引用方文件路径
 * 仓库、提交号无效等错误会抛出，不会当成「没有引用」
 */
export function refsAt(root, commit, pattern, exclude) {
  const skip = exclude instanceof Set ? exclude : new Set(exclude ? [exclude] : [])

  let out
  try {
    // -l 只列出文件名，-F 按字面匹配；先用它快速找出可能引用的文件
    out = git(root, ['grep', '-l', '-F', pattern, commit, '--'])
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
    if (!file || skip.has(file)) continue

    // 读出这个提交时的完整文件，去掉注释后再确认
    const code = git(root, ['show', `${commit}:${file}`])
    if (stripComments(code).includes(pattern)) files.add(file)
  }
  return files
}

/**
 * 引用时间线：每次有文件开始或停止引用 pattern，记一条
 * @returns {{commit: import('../core/schema.js').Commit, change: 'add'|'remove', from: string}[]}
 */
export function buildTimeline(root, pattern, { rev = 'HEAD', exclude } = {}) {
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
  const skip = exclude ? historicalPaths(root, exclude, rev) : new Set()

  const timeline = []
  let prev = new Set()
  // 加了 -m 后输出里可能夹带空行，过滤掉
  for (const line of out.split('\n').filter(Boolean)) {
    const commit = parseCommit(line)
    const now = refsAt(root, commit.hash, pattern, skip)

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
