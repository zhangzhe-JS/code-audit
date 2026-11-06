/**
 * 查找文件最初被加入仓库的提交，以及它历史上用过的所有路径
 *
 * 和时间线、失去引用一样，只看主线（first-parent）：分支上加入的文件，引入是合并进主线的那个提交
 *
 * 几种情况要分清：
 * - 改名（git 标记 R）：同一个文件，继续往前追旧路径
 * - 复制（git 标记 C）：复制出来的是新文件，引入就是这次复制
 *   （git --follow 会顺着复制继续追，追到被复制文件的历史，需要在这里截住）
 * - git 没认出来的移动：移动时内容改动太大（如小文件加了头注释），git 只看到「新增」
 *   如果同一次提交里删掉了一个同名文件，就当作移动，接着追那个旧路径
 * - 删除后又重新加入（同一路径有过几段生命）：取最早的那次，因为时间线覆盖的也是整个历史
 */
import { basename } from 'node:path'
import { git, COMMIT_FORMAT, parseCommit } from './git.js'

// 输出里用 \x1e 标记提交行的开头，和文件状态行区分开
const COMMIT_MARK = '\x1e'

// 没认出来的移动最多连续追几次，防止异常数据导致死循环
const MAX_MOVES = 5

/**
 * @param {string} root 仓库目录
 * @param {string} file 文件路径，相对 root
 * @param {string} [rev] 从哪个提交往前查，默认当前 HEAD
 * @returns {import('../core/schema.js').Commit | null}
 *   文件在 rev 之前的历史里从未出现过时返回 null；
 *   仓库不存在、rev 无效等错误会抛出，不会返回 null（避免把错误当成「查不到」）
 */
export function findIntroduced(root, file, rev = 'HEAD') {
  return traceOrigin(root, file, rev).introduced
}

/**
 * 追溯文件的来历
 * @returns {{introduced: import('../core/schema.js').Commit | null, paths: string[]}}
 *   paths：从当前路径到最初路径，依次列出用过的所有路径
 */
export function traceOrigin(root, file, rev = 'HEAD', moves = 0) {
  const out = git(root, [
    'log',
    rev,
    '--first-parent', // 只看主线
    '-m', // 合并提交也和第一个父提交比较，分支上加入的文件会在合并提交里显示为新增
    '--follow', // 跟踪改名
    '--name-status', // 每个提交附带文件状态：A 新增、M 修改、R 改名、C 复制
    '--date=short',
    `--format=${COMMIT_MARK}${COMMIT_FORMAT}`,
    '--',
    file
  ])

  const paths = [file]
  let commit = null
  let introduced = null

  // git log 从新到旧排列
  for (const line of out.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) {
      commit = parseCommit(line.slice(COMMIT_MARK.length))
      continue
    }
    const [status, a, b] = line.split('\t')
    if (!status || !commit) continue

    // 改名：a 是旧路径，同一个文件，继续往前
    if (status.startsWith('R')) {
      if (!paths.includes(a)) paths.push(a)
      continue
    }

    // 复制：b 是复制出来的新文件，它的引入就是这次，不再追被复制的文件
    if (status.startsWith('C')) {
      return { introduced: commit, paths }
    }

    // 新增：先看是不是 git 没认出来的移动
    if (status === 'A') {
      const from = moves < MAX_MOVES ? findMovedFrom(root, commit.hash, a) : null
      if (from) {
        const older = traceOrigin(root, from, `${commit.hash}^`, moves + 1)
        if (older.introduced) {
          return { introduced: older.introduced, paths: [...paths, ...older.paths] }
        }
      }
      // 不是移动：先记下，继续往前看有没有更早的一段生命（删除后又重新加入）
      introduced = commit
    }
  }

  return { introduced, paths }
}

/**
 * 同一次提交里删掉了一个同名文件，就当作是移动，返回旧路径
 * 同名比较时去掉首尾空格（finicr-web 里有文件名原本带前导空格的情况）
 * 删掉的同名文件不止一个时无法确定，返回 null
 */
function findMovedFrom(root, commit, file) {
  const name = basename(file).trim()
  const out = git(root, [
    'show',
    '--format=',
    '--name-only',
    '--diff-filter=D', // 只看删除的文件
    '--no-renames', // 关掉改名检测，让移动显示成「删除 + 新增」
    commit
  ])
  const same = out.split('\n').filter((p) => p && basename(p).trim() === name)
  return same.length === 1 ? same[0] : null
}
