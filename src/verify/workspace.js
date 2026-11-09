/**
 * verify 的临时工作目录：某个提交的完整代码 + 克隆来的依赖
 *
 * 代码：和 scan 一样，用临时索引把提交里的文件导出到系统临时目录。
 *   不用 git worktree：worktree 会在目标仓库的 .git 里留下记录，这里什么都不写进目标仓库
 * 依赖：把目标项目的 node_modules 克隆一份过来
 *   macOS（APFS）用 clonefile，几秒完成、不占额外磁盘；Linux 先试 reflink，不支持就普通复制
 *   不用软链接：构建工具会往 node_modules 里写缓存，软链接会写进原项目
 *   monorepo：提交里每个 package.json 旁边的 node_modules 都克隆
 *
 * 工作目录里没有 .git：构建脚本要读 git 信息的项目，基线就会失败，verify 会如实报出来
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { createSnapshot } from '../collect/snapshot.js'

/**
 * @typedef {object} Workspace
 * @property {string} dir     工作目录（代码在这里）
 * @property {string} commit  完整提交号
 * @property {number} files   导出的文件数
 * @property {{dir: string, method: 'clone'|'copy'}[]} deps  克隆了哪些 node_modules（dir 相对仓库根目录，'' 是根目录）
 * @property {(files: Set<string>) => void} setRemoved  让工作目录里恰好删掉这些文件（之前删的、这次不在里面的放回去）
 * @property {() => void} cleanup  删掉整个临时目录
 */

/**
 * @param {object} opts
 * @param {string} opts.root 仓库目录
 * @param {string} [opts.rev] 提交名，默认 HEAD
 * @param {(src: string, dst: string) => 'clone'|'copy'} [opts.copyDir] 测试时可以替换
 * @returns {Workspace}
 */
export function createWorkspace({ root, rev = 'HEAD', copyDir = cloneDir }) {
  const snap = createSnapshot(root, rev)
  try {
    const all = snap.list(['.'])
    snap.extract(all)
    mkdirSync(snap.dir, { recursive: true })

    const deps = []
    const pkgDirs = all.filter((f) => posix.basename(f) === 'package.json').map((f) => posix.dirname(f))
    for (const d of pkgDirs.map((x) => (x === '.' ? '' : x)).sort()) {
      const src = join(root, d, 'node_modules')
      if (!existsSync(src)) continue
      // node_modules 本身是软链接时，克隆它指向的目录：不能把软链接原样拷过来，否则还是写进原处
      const real = lstatSync(src).isSymbolicLink() ? realpathSync(src) : src
      const dst = join(snap.dir, d, 'node_modules')
      mkdirSync(dirname(dst), { recursive: true })
      deps.push({ dir: d, method: copyDir(real, dst) })
    }
    // 删掉的文件挪到工作目录外面的 removed/，放回时再挪回来：不用重新导出
    const removedDir = join(dirname(snap.dir), 'removed')
    const removed = new Set()
    const move = (from, to) => {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    }
    const setRemoved = (files) => {
      for (const f of [...removed]) {
        if (files.has(f)) continue
        move(join(removedDir, f), join(snap.dir, f))
        removed.delete(f)
      }
      for (const f of files) {
        if (removed.has(f)) continue
        if (!existsSync(join(snap.dir, f))) throw new Error(`要删的文件不在这个提交里：${f}`)
        move(join(snap.dir, f), join(removedDir, f))
        removed.add(f)
      }
    }
    return { dir: snap.dir, commit: snap.commit, files: all.length, deps, setRemoved, cleanup: () => snap.cleanup() }
  } catch (e) {
    snap.cleanup()
    throw e
  }
}

/**
 * 复制目录：能克隆（写时复制）就克隆，不能就普通复制。软链接原样保留（pnpm 的 node_modules 靠相对软链接）
 * @returns {'clone'|'copy'}
 */
export function cloneDir(src, dst) {
  const tries =
    process.platform === 'darwin'
      ? [['cp', ['-c', '-R', '-P', src, dst]]]
      : process.platform === 'linux'
        ? [['cp', ['-R', '-P', '--reflink=always', src, dst]]]
        : []
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    if (r.status === 0) return 'clone'
    // 克隆失败（文件系统不支持等）：清掉可能拷了一半的目录，再普通复制
    spawnSync('rm', ['-rf', dst])
  }
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true })
  return 'copy'
}
