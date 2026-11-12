/**
 * 找出哪些候选删了没问题、哪些删了会出问题
 *
 * 以「组」为单位：有 import 关系的候选绑在一起（dead 引用 dead-only-ref），
 * 只删被引用的、留着引用方，构建一定报错，会冤枉被引用的那个。
 *
 * 步骤（每一轮 = 删掉一批文件，跑一遍构建、测试，和基线比较）：
 * 1. 全部删掉跑一轮。通过就结束（最常见：2 轮，含基线）
 * 2. 不通过：从新增的报错里认出是哪些文件（locate），把它们先放回去，剩下的再跑一轮；
 *    还不通过就继续认，认不出来为止
 * 3. 认不出来的那批：对半分，逐步缩小（每次只知道「这一半有问题」，所以慢，只作兜底）
 * 4. 认出来的嫌疑：逐组单独确认（报错也可能冤枉人）
 *
 * 每一轮都是「已确认能删的 + 这一轮要试的」一起删：一起删才出问题的组合在过程中就会被发现，
 * 最后一次通过的那一轮，删的正好就是全部确认能删的，它的结果就是最终结果，不用再跑一轮。
 * （万一对不上，再跑一轮确认）
 *
 * 轮数有上限：到了上限还没确认的，记为「未验证」，不猜
 */

/**
 * @typedef {object} SearchResult
 * @property {string[][]} good        确认能删的组
 * @property {{unit: string[], cmp: import('./signals.js').Comparison}[]} bad  删了会出问题的组，以及那一轮的比较结果
 * @property {string[][]} unverified  轮数用完还没确认的组
 * @property {import('./signals.js').Comparison|null} final  全部确认能删的一起删掉时的结果
 * @property {number} rounds
 */

/**
 * @param {object} opts
 * @param {string[][]} opts.units  要删的文件，按组
 * @param {(deleted: Set<string>) => Promise<import('./signals.js').Comparison>} opts.run  删掉这些文件跑一轮
 * @param {(cmp: import('./signals.js').Comparison, deleted: string[]) => Set<string>} opts.locate  从报错里认出文件
 * @param {number} opts.maxRounds
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<SearchResult>}
 */
export async function searchDeletions({ units, run, locate, maxRounds, deadline = Infinity, log = () => {} }) {
  const good = []
  const bad = []
  const unverified = []
  let rounds = 0
  const unitOf = new Map(units.flatMap((u) => u.map((f) => [f, u])))

  let lastPass = null // 最近一次通过的那一轮：删了哪些、结果
  const test = async (batch, why) => {
    rounds++
    const deleted = new Set([...good.flat(), ...batch.flat()])
    const cmp = await run(deleted)
    if (cmp.passed) lastPass = { deleted, cmp }
    log(`第 ${rounds} 轮（${why}）：删 ${deleted.size} 个文件 → ${cmp.passed ? '通过' : `不通过：${cmp.problems.join('、')}`}`)
    return cmp
  }
  const out = () => rounds >= maxRounds || Date.now() >= deadline

  // 1、2：全部删掉；不通过就按报错把嫌疑放回去
  let pending = [...units]
  const suspects = []
  let lastFail = null
  while (pending.length > 0 && !out()) {
    const cmp = await test(pending, suspects.length === 0 ? '全部删掉' : '放回认出的文件')
    if (cmp.passed) {
      good.push(...pending)
      pending = []
      break
    }
    const named = new Set([...locate(cmp, pending.flat())].map((f) => unitOf.get(f)).filter(Boolean))
    const hit = pending.filter((u) => named.has(u))
    if (hit.length === 0 || hit.length === pending.length) {
      lastFail = cmp
      break // 认不出来，或者认出来的就是全部：对半找
    }
    log(`  报错里认出 ${hit.length} 组：${hit.map((u) => u[0]).join('、')}`)
    suspects.push(...hit)
    pending = pending.filter((u) => !named.has(u))
  }

  // 3：认不出来的对半找
  const bisect = async (list, knownFail) => {
    if (list.length === 0) return
    if (out()) {
      unverified.push(...list)
      return
    }
    const cmp = knownFail ?? (await test(list, '对半找'))
    if (cmp.passed) {
      good.push(...list)
      return
    }
    if (list.length === 1) {
      bad.push({ unit: list[0], cmp })
      return
    }
    const mid = Math.ceil(list.length / 2)
    await bisect(list.slice(0, mid))
    await bisect(list.slice(mid))
  }
  await bisect(pending, lastFail)

  // 4：嫌疑逐组确认
  for (const u of suspects) {
    if (out()) {
      unverified.push(u)
      continue
    }
    const cmp = await test([u], `确认 ${u[0]}`)
    if (cmp.passed) good.push(u)
    else bad.push({ unit: u, cmp })
  }

  // 最终结果：最近一次通过的那一轮删的就是全部确认能删的，直接用；对不上（不应该发生）才再跑一轮
  let final = null
  if (good.length > 0) {
    const all = new Set(good.flat())
    const same = lastPass && lastPass.deleted.size === all.size && [...all].every((f) => lastPass.deleted.has(f))
    if (same) final = lastPass.cmp
    else if (!out()) final = await test([], '一起删掉确认')
  }
  return { good, bad, unverified, final, rounds }
}
