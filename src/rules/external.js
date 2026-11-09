/**
 * 规则 external（图外使用）：knip 不分析的文件里写着它的路径（构建配置、脚本、index.html 等）
 *
 * 这些地方的使用 knip 看不到，删了构建或脚本会出错。判为 external：保留
 */
export const RULE = 'external-ref'

/**
 * @param {string} file
 * @param {import('./index.js').RuleContext} ctx
 * @returns {import('./index.js').RuleHit | null}
 */
export function externalRule(file, { externalRefs }) {
  const refs = externalRefs.get(file)
  if (!refs) return null
  return {
    status: 'external',
    evidence: refs.map((r) => ({ rule: RULE, detail: `${r.from}:${r.line} 写着它的路径：${r.text}（knip 不分析这个文件）` })),
    refs: refs.map((r) => ({ from: r.from, line: r.line, via: 'config' }))
  }
}
