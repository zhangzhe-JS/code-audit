// history 模块依赖 git 历史，fixture 那种静态文件做不到。所以测试时用代码临时建一个仓库，按设定好的日期和作者提交几次，再看函数能不能查对。跑完就删掉。
/**
 * 执行 git 命令的公共函数，history 模块的所有 git 调用都经过这里
 */
import { execFileSync } from 'node:child_process'

/**
 * 在 root 目录下执行 git 命令，返回去掉首尾空白的输出
 * @param {string} root 仓库目录
 * @param {string[]} args git 参数，如 ['log', '--oneline']
 * 备注不使用execSync，execSync 会把整条命令交给 shell 去解析，文件名里有空格或特殊字符就会出问题
 */
export function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024 // 大仓库的 log 输出可能很长，默认 1MB 不够
  }).trim()
}

// 提交信息的输出格式：字段之间用 \x1f（不可见的分隔符）隔开
// 不用空格或 tab，是因为提交说明里可能本身就有空格和 tab
// %H %ad %an %s 分别是：完整提交号、日期、作者、提交说明。
export const COMMIT_FORMAT = '%H%x1f%ad%x1f%an%x1f%s'

/** 把一行 git log 输出解析成 Commit 对象 */
export function parseCommit(line) {
  const [hash, date, author, subject] = line.split('\x1f')
  return { hash, date, author, subject }
}