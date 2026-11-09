/**
 * 规则 unknown（动态加载）：文件落在某处拼接路径的 import()、require.context 的范围里
 *
 * 运行时到底加载了哪些文件，取决于变量的值，静态分析看不出来。工具不猜，判为 unknown，交给人确认。
 * 写这处加载的文件本身也是候选（没人用）时照样判 unknown，只在证据里注明：那很可能是一组死代码，
 * 但「可能」不够，确认要等 dead-only-ref 规则或人工
 */
import { inScope } from '../collect/dynamic-imports.js'

export const RULE = 'dynamic-load'

/**
 * @param {string} file
 * @param {import('./index.js').RuleContext} ctx
 * @returns {import('./index.js').RuleHit | null}
 */
export function dynamicLoadRule(file, { loads, candidates }) {
  const hits = loads.filter((l) => l.scope !== null && l.from !== file && inScope(file, l.scope))
  if (hits.length === 0) return null
  return {
    status: 'unknown',
    evidence: hits.map((l) => ({
      rule: RULE,
      detail:
        `可能被 ${l.from}:${l.line} 动态加载：${l.expr}；路径里有变量，无法确定是否用到` +
        (candidates.has(l.from) ? `（${l.from} 本身也从入口走不到）` : '')
    })),
    refs: hits.map((l) => ({ from: l.from, line: l.line, via: 'dynamic' }))
  }
}
