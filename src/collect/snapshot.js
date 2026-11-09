/**
 * 把某个提交里的文件导出到系统临时目录，供 scan 分析
 *
 * 为什么不直接分析工作区：history 查的是提交里的历史。工作区有没提交的改动时
 * （比如本地删掉了一处 import），按工作区分析得出的候选，和 history 看到的代码对不上。
 * 所以 scan 和 history 都以同一个提交为准，工作区的改动一概不看。
 *
 * 做法：用一份临时索引（GIT_INDEX_FILE 指向临时目录）读入提交，
 * 列文件、导出文件都只经过这份临时索引。不碰目标仓库的工作区、索引和分支，用完整个临时目录删掉
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, resolveCommit } from '../history/git.js'

/**
 * @typedef {object} Snapshot
 * @property {string} commit 完整提交号
 * @property {string} dir    导出的目录，文件按仓库里的相对路径放
 * @property {(pathspecs: string[]) => string[]} list  列出提交里匹配的文件（git pathspec 写法），排好序
 * @property {(files: string[]) => void} extract       把这些文件导出到 dir
 * @property {() => void} cleanup                      删掉临时目录
 */

/**
 * @param {string} root 仓库目录
 * @param {string} [rev] 提交名，默认 HEAD
 * @returns {Snapshot}
 */
export function createSnapshot(root, rev = 'HEAD') {
  const commit = resolveCommit(root, rev)
  const tmp = mkdtempSync(join(tmpdir(), 'code-audit-snapshot-'))
  const dir = join(tmp, 'tree')
  const env = { GIT_INDEX_FILE: join(tmp, 'index') }

  try {
    git(root, ['read-tree', commit], { env })
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }

  return {
    commit,
    dir,
    list(pathspecs) {
      if (pathspecs.length === 0) return []
      const out = git(root, ['ls-files', '-z', '--', ...pathspecs], { env, raw: true })
      return out.split('\0').filter(Boolean).sort()
    },
    extract(files) {
      if (files.length === 0) return
      // --prefix 以 / 结尾：文件写到 dir/<相对路径>
      git(root, ['checkout-index', '-z', '--stdin', `--prefix=${dir}/`], { env, input: files.join('\0') })
    },
    cleanup() {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}
