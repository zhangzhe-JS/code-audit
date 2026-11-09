/**
 * 顺着候选之间的 import 传递「要保留」的状态
 *
 * 候选 X 只被候选 Y 引用时，X 的命运跟着 Y：
 * - Y 要保留（unknown、external、dormant 等，或者 Y 自己又是从别的要保留的文件传来的），X 也要保留，状态和 Y 一样
 * - 一路往上都没有要保留的，X 才是 dead-only-ref（由 judge 判定）
 *
 * 沿引用方向（Y → X）一直传下去，直到没有变化：状态只会往「更不敢删」的方向变，所以一定会停下来。
 * 互相引用的一组文件也能正确处理
 */
import { STATUSES } from '../core/schema.js'

/** 取最不敢删的状态（STATUSES 里最靠前的）；都没有时返回 null */
export function best(statuses) {
  const valid = statuses.filter((s) => s != null)
  if (valid.length === 0) return null
  return [...valid].sort((a, b) => STATUSES.indexOf(a) - STATUSES.indexOf(b))[0]
}

/**
 * @param {object} opts
 * @param {Map<string, string|null>} opts.own  每个候选自己命中的状态；null = 没命中
 * @param {Map<string, {from: string, line: number}[]>} opts.importers  候选 → 引用它的候选
 * @returns {Map<string, {status: string, from: string, line: number}>} 从引用方传来的状态（只记传来的里最不敢删的）
 */
export function propagate({ own, importers }) {
  // 反过来：Y → 它引用的候选
  const imports = new Map()
  for (const [target, refs] of importers) {
    for (const r of refs) imports.set(r.from, [...(imports.get(r.from) ?? []), { target, line: r.line }])
  }

  const inherited = new Map()
  const effective = (f) => best([own.get(f), inherited.get(f)?.status])
  const queue = [...own.keys()].filter((f) => own.get(f) !== null)
  while (queue.length > 0) {
    const y = queue.shift()
    const status = effective(y)
    for (const { target, line } of imports.get(y) ?? []) {
      if (!own.has(target)) continue
      const current = inherited.get(target)?.status
      if (best([status, current]) === current) continue // 已经有同样或更不敢删的
      inherited.set(target, { status, from: y, line })
      queue.push(target)
    }
  }
  return inherited
}
