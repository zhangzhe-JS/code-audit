/**
 * 查找文件最初被加入仓库的提交
 */
import { git, COMMIT_FORMAT, parseCommit } from './git.js'

/**
 * @param {string} root 仓库目录
 * @param {string} file 文件路径，相对 root
 * @param {string} [rev] 从哪个提交往前查，默认当前 HEAD
 * @returns {import('../core/schema.js').Commit | null} 找不到时返回 null
 * 
 */
export function findIntroduced(root, file, rev = 'HEAD') {
  const out = git(root, [
    'log',
    rev,
    '--follow',          // 跟踪改名：文件被移动过，也能追到最初的位置
    '--diff-filter=A',   // 只看「新增文件」的提交
    '--date=short',      // 日期格式 YYYY-MM-DD
    `--format=${COMMIT_FORMAT}`,// 输出内容 
    '--', //表示后面的内容是文件路径，避免路径被误认为 Git 参数
    file
  ])
  if (!out) return null

  // git log 从新到旧排列，最后一行才是最早的那次
  const lines = out.split('\n')
  return parseCommit(lines[lines.length - 1])
}