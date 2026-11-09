/**
 * 规则 dormant（注释停用）：在用的代码、构建配置里有注释掉的引用
 *
 * 引用被注释掉，说明以前用过、以后可能恢复，必须留在原位，不能隔离。
 * 只看在用的文件里的注释：写注释的文件本身也是候选（没人用）时，恢复那行注释也用不上它，不算
 */
export const RULE = 'commented-ref'

/**
 * @param {string} file
 * @param {import('./index.js').RuleContext} ctx
 * @returns {import('./index.js').RuleHit | null}
 */
export function dormantRule(file, { commentRefs }) {
  const refs = commentRefs.get(file)
  if (!refs) return null
  return {
    status: 'dormant',
    evidence: refs.map((r) => ({ rule: RULE, detail: `${r.from}:${r.line} 有注释掉的引用：${r.text}` })),
    refs: refs.map((r) => ({ from: r.from, line: r.line, via: 'comment' }))
  }
}
