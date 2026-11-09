/**
 * 隔离计划：哪些文件移进隔离区、移到哪、要改哪些路径、头注释写什么；哪些不移、为什么
 *
 * 只是算，不改任何东西。quarantine 不带 --apply 时只打印这份计划
 *
 * 挑哪些：
 * - 状态是 dead / dead-only-ref，并且实删验证通过（verify.passed）。没跑 verify、验证没通过的不移
 * - 有 import 关系的绑成一组（verify 也是这样删的）：一组里有一个不能移，整组都不移，免得留下的那个引用指空
 * - 已经在隔离区里的、不在 quarantine.base 下的、隔离区里已经有同名文件的，不移
 *   「已经在隔离区里」也包括项目里别的隔离区：路径里有一段和隔离区目录同名（如 _deprecated）的都算，免得隔离区套隔离区
 */
import { posix } from 'node:path'
import { DELETABLE, groupUnits } from '../verify/index.js'
import { renderHeader } from '../report/header.js'
import { makeLocator, rewriteRelativePaths } from './rewrite.js'

/**
 * @typedef {object} Move
 * @property {string} from
 * @property {string} to
 * @property {import('../core/schema.js').Item} item
 * @property {string|null} header        头注释；这类文件不能写注释时为 null
 * @property {string|null} headerSkipped 为什么没有头注释
 * @property {{line: number, before: string, after: string}[]} changes  要改的路径
 * @property {{line: number, spec: string}[]} unresolved  解析不出指向哪个文件、没改的路径
 */

/**
 * @typedef {object} QuarantinePlan
 * @property {string} dir
 * @property {string} base
 * @property {Move[]} moves
 * @property {{file: string, reason: string}[]} skipped
 * @property {{path: string, exists: boolean}} readme
 * @property {string[]} lintHints
 */

/**
 * @param {object} opts
 * @param {import('../core/schema.js').Report} opts.data  verify 输出的数据
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {string[]} opts.files  分析的提交里的所有文件
 * @param {(path: string) => string} opts.readFile  读提交里的文件
 * @param {string} opts.movedAt  移入日期 YYYY-MM-DD
 * @param {string} [opts.branch] 头注释里写的分支
 * @returns {QuarantinePlan}
 */
export function buildPlan({ data, config, files, readFile, movedAt, branch }) {
  const dir = config.quarantine.dir ?? `${config.sourceRoots[0]}/_deprecated`
  const base = config.quarantine.base ?? config.sourceRoots[0]
  const fileSet = new Set(files)
  const skipped = []

  const candidates = data.items.filter((i) => i.kind === 'file' && DELETABLE.includes(i.status))
  const byFile = new Map(candidates.map((i) => [i.target, i]))
  const dirName = posix.basename(dir)
  const reasonOf = (item) => {
    if (item.target === dir || item.target.startsWith(`${dir}/`)) return '已经在隔离区里'
    if (item.target.split('/').slice(0, -1).includes(dirName)) return `已经在别的隔离区里（路径里有 ${dirName}）`
    if (!item.verify) return '没有实删验证（先跑 verify）'
    if (!item.verify.passed) return '实删验证没通过'
    if (!item.target.startsWith(`${base}/`)) return `不在 quarantine.base（${base}）下，不知道放进隔离区哪里`
    const to = posix.join(dir, posix.relative(base, item.target))
    if (fileSet.has(to)) return `隔离区里已经有同名文件：${to}`
    return null
  }

  const moving = []
  for (const unit of groupUnits(data.items, candidates.map((i) => i.target))) {
    const reasons = unit.map((f) => [f, reasonOf(byFile.get(f))])
    const blocked = reasons.filter(([, r]) => r !== null)
    if (blocked.length === 0) {
      moving.push(...unit)
      continue
    }
    for (const [f, r] of reasons) {
      skipped.push({ file: f, reason: r ?? `和 ${blocked.map(([b]) => b).join('、')} 互相引用，要一起移，那边不能移` })
    }
  }

  const moved = new Map(moving.map((f) => [f, posix.join(dir, posix.relative(base, f))]))
  const locate = makeLocator(fileSet, config.extensions)
  const moves = moving.map((from) => {
    const item = byFile.get(from)
    const to = moved.get(from)
    const { changes, unresolved } = rewriteRelativePaths({ content: readFile(from), from, to, moved, aliases: config.aliases, locate })
    let header = null
    let headerSkipped = null
    try {
      header = renderHeader(item, { config, movedAt, branch })
    } catch (e) {
      headerSkipped = e.message
    }
    return { from, to, item, header, headerSkipped, changes, unresolved }
  })

  const readmePath = `${dir}/README.md`
  return {
    dir,
    base,
    moves,
    skipped: skipped.sort((a, b) => (a.file < b.file ? -1 : 1)),
    readme: { path: readmePath, exists: fileSet.has(readmePath) },
    lintHints: lintHints(fileSet, dir)
  }
}

/**
 * lint 配置不自动改（各项目写法差别很大），只提示要加什么
 */
function lintHints(fileSet, dir) {
  const hints = []
  if (fileSet.has('.eslintignore')) hints.push(`.eslintignore 里加一行：${dir}/`)
  const flat = [...fileSet].find((f) => /^eslint\.config\.(js|mjs|cjs|ts)$/.test(f))
  if (flat) hints.push(`${flat} 的 ignores 里加上：'${dir}/**'`)
  const legacy = [...fileSet].find((f) => /^\.eslintrc(\.(js|cjs|json|yml|yaml))?$/.test(f))
  if (legacy && !fileSet.has('.eslintignore')) hints.push(`${legacy} 的 ignorePatterns 里加上：'${dir}/**'`)
  if (fileSet.has('tsconfig.json')) hints.push(`如果跑类型检查（vue-tsc / tsc），tsconfig.json 的 exclude 里可以加上：'${dir}/**'`)
  return hints
}
