/**
 * 规则 pending（其他分支在用）：没合并的分支里有文件 import 了它，或者分支改了它本身
 *
 * 当前分支没人用，但那个分支合并回来以后就有人用了；或者有人还在改它，现在删，合并时会冲突。
 * 等那个分支合并或关闭后再判断。不想管的分支（比如不会再合回来的老版本线）在配置 branches.ignore 里排除
 */
export const RULE = 'branch-ref'

/**
 * @param {string} file
 * @param {import('./index.js').RuleContext} ctx
 * @returns {import('./index.js').RuleHit | null}
 */
export function pendingRule(file, { branchRefs }) {
  const refs = branchRefs.get(file)
  if (!refs) return null
  return {
    status: 'pending',
    evidence: refs.map((r) => ({
      rule: RULE,
      detail:
        r.kind === 'modified'
          ? `没合并的分支 ${r.branch}（最后提交 ${r.date}）改了这个文件`
          : `没合并的分支 ${r.branch}（最后提交 ${r.date}）里 ${r.from}:${r.line} 引用了它`
    })),
    // 引用方在别的分支上，当前提交里不一定有这个文件：不记进 refs，只写证据
    refs: []
  }
}
