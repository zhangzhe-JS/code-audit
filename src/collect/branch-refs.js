/**
 * 在没合并的分支里找候选文件的引用：当前分支没人用，但别的分支在用（pending）
 *
 * 只看分支自己改过的文件（从分叉点到分支最新提交）：
 * - 改过 / 新增的源码文件 import 了候选：合并回来以后就有人用了
 * - 分支直接改了候选文件本身：还有人在改它，现在删，合并时会冲突
 * 分支没动过的文件，合并后用的是当前分支的版本，不会把引用带回来，所以不看。
 *
 * 只读：只读本地已有的分支（含远程跟踪分支 origin/xxx），不 fetch；远程分支以上次 fetch 的为准
 */
import { git } from '../history/git.js'
import { findImportRefs } from './path-refs.js'

/**
 * @typedef {object} BranchRef
 * @property {string} branch  分支名（同一个提交的多个分支名用「、」连起来）
 * @property {string} date    分支最新提交的日期 YYYY-MM-DD
 * @property {'import'|'modified'} kind  import：分支里有文件 import 了它；modified：分支改了它本身
 * @property {string} [from]  kind 为 import 时：写 import 的文件（分支上的路径）
 * @property {number} [line]
 */

/**
 * @typedef {object} BranchScan
 * @property {Map<string, BranchRef[]>} refs  候选 → 别的分支里的引用
 * @property {{name: string, date: string}[]} checked  查过的分支
 * @property {{name: string, reason: string}[]} skipped  没查的分支和原因
 */

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.rev  完整提交号（scan 分析的提交）
 * @param {string[]} opts.targets  候选文件
 * @param {string[]} opts.extensions  源码扩展名
 * @param {Record<string, string>} [opts.aliases]
 * @param {{ignore: string[], maxAgeDays: number|null}} opts.branches  配置
 * @returns {BranchScan}
 */
export function findBranchRefs({ root, rev, targets, extensions, aliases = {}, branches }) {
  const refs = new Map()
  const checked = []
  const skipped = []
  if (targets.length === 0) return { refs, checked, skipped }

  const revTime = Number(git(root, ['log', '-1', '--format=%ct', rev]))
  const ignore = branches.ignore.map(globToRegExp)

  // 没合并进当前提交的分支；同一个提交的多个名字（本地和 origin/ 同名分支）合成一个
  const out = git(root, [
    'for-each-ref',
    `--no-merged=${rev}`,
    '--format=%(objectname)%00%(refname:short)%00%(committerdate:unix)%00%(symref)',
    'refs/heads',
    'refs/remotes'
  ])
  const byCommit = new Map()
  for (const line of out.split('\n').filter(Boolean)) {
    const [hash, name, time, symref] = line.split('\0')
    if (symref) continue // origin/HEAD 这种指向别的分支的名字
    if (ignore.some((re) => re.test(name))) {
      skipped.push({ name, reason: '配置里排除' })
      continue
    }
    const ageDays = (revTime - Number(time)) / 86400
    if (branches.maxAgeDays !== null && ageDays > branches.maxAgeDays) {
      skipped.push({ name, reason: `最后提交在 ${Math.floor(ageDays)} 天前，超过 ${branches.maxAgeDays} 天` })
      continue
    }
    const entry = byCommit.get(hash) ?? { hash, names: [], time: Number(time) }
    entry.names.push(name)
    byCommit.set(hash, entry)
  }

  const targetSet = new Set(targets)
  const add = (target, ref) => refs.set(target, [...(refs.get(target) ?? []), ref])
  for (const { hash, names, time } of byCommit.values()) {
    const branch = names.join('、')
    const date = new Date(time * 1000).toISOString().slice(0, 10)
    checked.push({ name: branch, date })

    const base = git(root, ['merge-base', rev, hash])
    // 分支改过的文件：A 新增、M 修改、D 删除（不认改名，改名算一删一增）
    const diff = git(root, ['diff', '--name-status', '--no-renames', '-z', base, hash], { raw: true })
    const parts = diff.split('\0').filter(Boolean)
    const changed = []
    for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ status: parts[i], path: parts[i + 1] })

    for (const { status, path } of changed) {
      if (status === 'M' && targetSet.has(path)) add(path, { branch, date, kind: 'modified' })
    }
    const files = changed
      .filter((c) => c.status !== 'D' && extensions.some((e) => c.path.endsWith(e)))
      .map((c) => ({ path: c.path, content: git(root, ['show', `${hash}:${c.path}`], { raw: true }) }))
    for (const [target, list] of findImportRefs({ files, targets, aliases })) {
      for (const r of list) add(target, { branch, date, kind: 'import', from: r.from, line: r.line })
    }
  }
  return { refs, checked, skipped }
}

/**
 * 分支名的 glob：* 不跨 /，** 跨 /，? 一个字符
 * 例：origin/dev_2.* 匹配 origin/dev_2.4.2，不匹配 origin/dev_2/x
 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
