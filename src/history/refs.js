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
 * 某个提交时，哪些文件在注释以外的地方包含 pattern（排除 exclude 指定的文件）
 * @returns {Set<string>} 引用方文件路径
 */
export function refsAt(root, commit, pattern, exclude) {
  let out
  try {
    // -l 只列出文件名，-F 按字面匹配；先用它快速找出可能引用的文件
    out = git(root, ['grep', '-l', '-F', pattern, commit, '--'])
  } catch {
    return new Set() // 没有匹配时 git grep 的退出码是 1，会抛错，当作没有引用
  }

  const files = new Set()
  for (const line of out.split('\n')) {
    // 每行格式：提交号:文件路径
    const file = line.slice(commit.length + 1)
    if (!file || file === exclude) continue

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

  const timeline = []
  let prev = new Set()
  // 加了 -m 后输出里可能夹带空行，过滤掉
  for (const line of out.split('\n').filter(Boolean)) {
    const commit = parseCommit(line)
    const now = refsAt(root, commit.hash, pattern, exclude)

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
 * @returns {import('../core/schema.js').Commit | null}
 */
export function findLostRef(timeline) {
  const current = new Set()
  let lost = null
  for (const e of timeline) {
    if (e.change === 'add') {
      current.add(e.from)
    } else {
      current.delete(e.from)
      if (current.size === 0) lost = e.commit
    }
  }
  return current.size === 0 ? lost : null
}
