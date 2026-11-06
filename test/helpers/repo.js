/**
 * 测试用：在系统临时目录建一个 git 仓库，可以指定每次提交的日期和作者
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

export function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'code-audit-'))

  const run = (args, env = {}) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env }
    }).trim()

  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.name', 'test'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'commit.gpgsign', 'false']) // 避免本机全局开了签名导致提交卡住

  return {
    root,
    run,

    /** 写入文件，目录不存在会自动创建 */
    write(file, content) {
      const p = join(root, file)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
    },

    /** 提交全部改动，返回提交号 */
    commit(message, { date = '2024-01-01', author = 'alice' } = {}) {
      run(['add', '-A'])
      const time = `${date}T12:00:00`
      run(
        ['commit', '-q', '-m', message, `--author=${author} <${author}@example.com>`],
        { GIT_AUTHOR_DATE: time, GIT_COMMITTER_DATE: time }
      )
      return run(['rev-parse', 'HEAD'])
    },

    /** 删除整个临时仓库 */
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}