// history 模块依赖 git 历史，fixture 那种静态文件做不到。所以测试时用代码临时建一个仓库，按设定好的日期和作者提交几次，再看函数能不能查对。跑完就删掉。
/**
 * 执行 git 命令的公共函数，history 模块的所有 git 调用都经过这里
 */
import { execFileSync } from 'node:child_process'

/**
 * 在 root 目录下执行 git 命令，返回去掉首尾空白的输出
 * @param {string} root 仓库目录
 * @param {string[]} args git 参数，如 ['log', '--oneline']
 * @param {{raw?: boolean, env?: Record<string, string>, input?: string}} [opts]
 *   raw：输出原样返回，不去首尾空白（-z 列文件时，文件名本身可能以空格开头）
 *   env：追加的环境变量（如 GIT_INDEX_FILE 指向临时索引）
 *   input：写给 git 标准输入的内容（如 --stdin 读文件列表）
 * 备注不使用execSync，execSync 会把整条命令交给 shell 去解析，文件名里有空格或特殊字符就会出问题
 */
export function git(root, args, { raw = false, env, input } = {}) {
  try {
    // core.quotePath=false：中文等非 ASCII 文件名原样输出，不转成 "\345\217..." 这种转义形式
    const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, // 大仓库的 log 输出可能很长，默认 1MB 不够
      env: env ? { ...process.env, ...env } : undefined,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] // 收集 stderr 放进错误信息，不直接打印到终端
    })
    return raw ? out : out.trim()
  } catch (e) {
    // 统一成带 git 报错原文的错误，并保留退出码，调用方据此区分「没有匹配」和真正的错误
    const detail = String(e.stderr || e.message).trim()
    const err = new Error(`git ${args.join(' ')} 失败（退出码 ${e.status ?? '无'}）：${detail}`)
    err.status = e.status
    throw err
  }
}

/** 把提交名（HEAD、分支名、短提交号）换成完整提交号；不存在时报错 */
export function resolveCommit(root, rev) {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  } catch {
    throw new Error(`找不到提交：${rev}（仓库：${root}）`)
  }
}

/**
 * 检查 git 输出里的路径没有被转义
 * 关掉 core.quotePath 后，中文路径原样输出；但文件名里有引号、反斜杠、控制字符时，git 仍会加上引号转义。
 * 转义后的字符串不是真实路径，拿去查只会得出错误结果，所以直接报错
 * @param {string} p
 */
export function plainPath(p) {
  if (p.startsWith('"')) {
    throw new Error(`文件名里有引号、反斜杠或控制字符，暂不支持：${p}`)
  }
  return p
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