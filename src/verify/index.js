/**
 * verify 主流程：在临时目录里删掉 dead / dead-only-ref，跑构建、测试，和基线比较，结果写进数据
 *
 * - 用数据里记录的提交（project.rev）：和 scan、history 看到的是同一份代码
 * - 基线构建本来就失败时无法验证，直接报错；基线测试本来就有失败的，按「新增失败」比较
 * - 删了会出问题的：status 改成 unknown，证据写上实际删掉后出的问题。静态分析没看出来的使用，不能当死代码
 * - 轮数用完还没确认的：verify 留空（未验证），状态不变
 * - 启用了打包器证据（verify.bundler）：静态分析说当前构建用不到（CLAIMS_UNUSED）、基线构建却加载了的，判 unknown。
 *   要删的就不删了：这类文件删了多半构建失败，提前拿掉就不用走对半查找
 * - 基线有缓存就复用（cache.js）：重跑时省掉一遍构建和测试
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkspace } from './workspace.js'
import { prepareBaseline, runSteps } from './baseline.js'
import { runCommand } from './run-command.js'
import { compare } from './signals.js'
import { locate } from './locate.js'
import { searchDeletions } from './search.js'
import { validate } from '../core/schema.js'

/** 要验证的状态：静态分析认为能删的 */
export const DELETABLE = Object.freeze(['dead', 'dead-only-ref'])

/**
 * 这些状态都在说「当前分支的构建用不到它」（其他分支在用、只有测试用、只在注释里、没人用）。
 * 打包器却加载了它，说明静态分析漏看了引用，结论不可信
 */
export const CLAIMS_UNUSED = Object.freeze(['dead', 'dead-only-ref', 'test-only', 'dormant', 'pending'])

/** 轮数上限：一轮几十秒到几分钟，几十轮就是一两个小时，再多不如人工看 */
export const MAX_ROUNDS = 40

/**
 * @param {object} opts
 * @param {import('../core/schema.js').Report} opts.data   history 输出的数据
 * @param {string} opts.root
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.maxRounds]
 * @param {typeof runCommand} [opts.run] 测试时可以替换
 * @param {boolean} [opts.useCache] 复用缓存的基线，默认 true
 * @param {string} [opts.cacheDir]  测试时可以换
 * @returns {Promise<{data: import('../core/schema.js').Report, summary: object}>}
 */
export async function verifyReport({ data, root, config, log = () => {}, maxRounds = MAX_ROUNDS, run = runCommand, useCache = true, cacheDir }) {
  const errors = validate(data)
  if (errors.length > 0) throw new Error(`数据不符合格式：\n- ${errors.join('\n- ')}`)
  if (!config.verify.build && !config.verify.test) throw new Error('配置里没有写 verify 的命令（build、test）')

  let targets = data.items.filter((i) => i.kind === 'file' && DELETABLE.includes(i.status)).map((i) => i.target)
  const result = structuredClone(data)
  if (targets.length === 0) {
    log('没有要验证的文件（dead、dead-only-ref）')
    return { data: result, summary: { targets: 0, passed: 0, failed: 0, unverified: 0, rounds: 0, bundled: [], contradicted: [] } }
  }
  const total = targets.length

  log(`准备临时目录：提交 ${data.project.rev}`)
  const ws = createWorkspace({ root, rev: data.project.rev })
  try {
    const steps = (logDir) => runSteps({ cwd: ws.dir, verify: config.verify, run, logDir })
    log('基线（不删任何文件）…')
    const base = await prepareBaseline({ root, ws, verify: config.verify, useCache, cacheDir, run, log })
    const baseline = base.results
    if (baseline.build && !baseline.build.ok) {
      throw new Error('基线构建就失败了，无法判断删文件有没有影响。先用 verify（不带 --in）试跑，确认构建命令能跑通')
    }
    if (baseline.test && !baseline.test.ok) log('  基线测试本来就有失败：按「新增失败的测试」比较')

    // 打包器加载过、静态分析却说「当前构建用不到」的：判 unknown，要删的不删
    const contradicted = base.modules ? result.items.filter((i) => i.kind === 'file' && CLAIMS_UNUSED.includes(i.status) && base.modules.has(i.target)) : []
    const bundled = contradicted.filter((i) => targets.includes(i.target)).map((i) => i.target)
    if (config.verify.bundler) {
      if (base.bundlerDropped) {
        log(`  没有打包器证据：${base.bundlerDropped}。照常验证`)
      } else if (!base.modules) {
        log(`  没拿到打包器的模块列表：构建没有经过套好的配置（构建命令用了别的配置文件？可以在 verify.bundlerConfig 里写上）。照常验证，只是没有这条证据`)
      } else {
        log(`  打包器（${config.verify.bundler}）记录了 ${base.builds} 次构建，加载了 ${base.modules.size} 个源码文件`)
        if (contradicted.length > 0) {
          log(`  其中 ${contradicted.length} 个静态分析说当前构建用不到（${[...new Set(contradicted.map((i) => i.status))].join('、')}），构建却加载了：判 unknown${bundled.length > 0 ? `，${bundled.length} 个要删的不删` : ''}`)
        }
      }
    }
    for (const item of contradicted) {
      const was = item.status
      item.status = 'unknown'
      item.evidence.push({
        rule: 'bundler-included',
        detail: `构建（${config.verify.bundler}）加载了这个文件，和静态分析的结论（${was}）矛盾：静态分析漏看了引用（可能是 glob、插件、别名等）。${DELETABLE.includes(was) ? '不删，' : ''}请人工确认`
      })
    }
    targets = targets.filter((t) => !bundled.includes(t))
    if (targets.length === 0) {
      log('剩下没有要删的文件')
      const errs = validate(result)
      if (errs.length > 0) throw new Error(`生成的数据不符合格式（工具内部错误）：\n- ${errs.join('\n- ')}`)
      return {
        data: result,
        summary: { targets: total, passed: 0, failed: 0, unverified: 0, rounds: 0, bundled, contradicted: contradicted.map((i) => i.target), bundlerDropped: base.bundlerDropped, baselineCachedAt: base.cachedAt }
      }
    }

    const workDirs = [ws.dir, realpathSync(ws.dir)]
    const units = groupUnits(result.items, targets)
    log(`要验证 ${targets.length} 个文件，有 import 关系的绑在一起，共 ${units.length} 组`)

    const search = await searchDeletions({
      units,
      maxRounds,
      log,
      run: async (deleted) => {
        ws.setRemoved(deleted)
        return compare(baseline, await steps(), workDirs)
      },
      locate: (cmp, deleted) =>
        locate({
          newLines: cmp.newLines,
          newFailures: cmp.test.newFailures,
          deleted,
          aliases: config.aliases,
          readFile: (p) => (existsSync(join(ws.dir, p)) ? readFileSync(join(ws.dir, p), 'utf8') : null)
        })
    })

    // 轮数用完、没来得及一起删掉确认：能删的也算未验证
    if (search.good.length > 0 && !search.final) {
      search.unverified.push(...search.good)
      search.good = []
    }
    // 分开删没问题、一起删出了问题：能删的也不敢说能删
    const finalFailed = search.final && !search.final.passed
    const byFile = new Map(result.items.map((i) => [i.target, i]))
    const stamp = (cmp, passed) => ({ rev: ws.commit, build: { ...cmp.build }, test: { ...cmp.test }, passed })

    for (const unit of search.good) {
      for (const f of unit) byFile.get(f).verify = stamp(search.final, !finalFailed)
    }
    for (const { unit, cmp } of search.bad) {
      for (const f of unit) {
        const item = byFile.get(f)
        item.verify = stamp(cmp, false)
        item.status = 'unknown'
        item.evidence.push({ rule: 'verify-failed', detail: failureDetail(cmp, unit) })
      }
    }
    if (finalFailed) {
      for (const unit of search.good) {
        for (const f of unit) {
          const item = byFile.get(f)
          item.status = 'unknown'
          item.evidence.push({ rule: 'verify-failed', detail: `单独删没问题，和其他文件一起删掉后：${search.final.problems.join('、')}` })
        }
      }
    }

    const errs = validate(result)
    if (errs.length > 0) throw new Error(`生成的数据不符合格式（工具内部错误）：\n- ${errs.join('\n- ')}`)
    const count = (units) => units.reduce((n, u) => n + u.length, 0)
    return {
      data: result,
      summary: {
        targets: total,
        bundled,
        contradicted: contradicted.map((i) => i.target),
        bundlerDropped: base.bundlerDropped,
        baselineCachedAt: base.cachedAt,
        passed: finalFailed ? 0 : count(search.good),
        failed: count(search.bad.map((b) => b.unit)) + (finalFailed ? count(search.good) : 0),
        unverified: count(search.unverified),
        rounds: search.rounds,
        bad: search.bad.map((b) => ({ files: b.unit, problems: b.cmp.problems })),
        newWarnings: search.final?.build.newWarnings ?? []
      }
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * 有 import 关系的候选绑成一组：引用方和被引用的要一起删
 * 关系取自 refs 里 via 为 static、引用方也在要删的文件里的
 * @returns {string[][]} 每组按路径排序，组按第一个文件排序
 */
export function groupUnits(items, targets) {
  const set = new Set(targets)
  const parent = new Map(targets.map((t) => [t, t]))
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)))
  const union = (a, b) => parent.set(find(a), find(b))
  for (const item of items) {
    if (!set.has(item.target)) continue
    for (const r of item.refs) if (r.via === 'static' && set.has(r.from)) union(item.target, r.from)
  }
  const groups = new Map()
  for (const t of [...targets].sort()) {
    const root = find(t)
    groups.set(root, [...(groups.get(root) ?? []), t])
  }
  return [...groups.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/** 删了出问题时写进证据：出了什么问题，加上几行相关的报错 */
function failureDetail(cmp, unit) {
  const related = cmp.newLines.filter((l) => /error|fail|cannot|could not|not found|unresolved|无法|失败/i.test(l)).slice(0, 3)
  const group = unit.length > 1 ? `（和 ${unit.length - 1} 个互相引用的文件一起删）` : ''
  return `实际删掉后${group}：${cmp.problems.join('、')}${related.length ? `。报错：${related.join(' | ')}` : ''}`
}
