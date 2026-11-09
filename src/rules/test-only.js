/**
 * 规则 test-only（只有测试用到）：从入口走不到，加上测试入口就走得到（scan 跑两次 knip 得出）
 *
 * 业务已经不用了，只剩测试在用。确认业务不再需要的话，连同测试一起删
 * 能找到是哪些测试直接引用的，就列出来；经过别的文件间接用到的，只有 knip 的结论
 */
import { SCAN_RULES } from '../collect/scan-rules.js'

export const RULE = 'test-ref'

/**
 * @param {string} file
 * @param {import('./index.js').RuleContext} ctx
 * @returns {import('./index.js').RuleHit | null}
 */
export function testOnlyRule(file, { knipRules, testRefs }) {
  if (knipRules.get(file) !== SCAN_RULES.testOnly) return null
  const refs = testRefs.get(file) ?? []
  return {
    status: 'test-only',
    evidence: refs.map((r) => ({ rule: RULE, detail: `被测试 ${r.from}:${r.line} 引用` })),
    refs: refs.map((r) => ({ from: r.from, line: r.line, via: 'static' }))
  }
}
