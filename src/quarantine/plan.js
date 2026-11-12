/**
 * 隔离计划：哪些文件移进隔离区、移到哪、要改哪些路径、头注释写什么；哪些不移、为什么
 *
 * 只是算，不改任何东西。quarantine 不带 --apply 时只打印这份计划
 *
 * 放在哪（配置 quarantine.layout）：
 * - nearby（默认）：就近，放进文件所在目录下的 _deprecated：src/a/b.js → src/a/_deprecated/b.js
 * - central：集中放进 quarantine.dir，按相对 quarantine.base 的路径，子目录结构不变
 *
 * 挑哪些：
 * - 状态是 dead / dead-only-ref，并且实删验证通过（verify.passed）。没跑 verify、验证没通过的不移
 * - 有 import 关系的绑成一组（verify 也是这样删的）：一组里有一个不能移，整组都不移，免得留下的那个引用指空
 * - 不移：已经隔离过的（路径里有一段叫 _deprecated，免得隔离区套隔离区）、集中隔离时不在 base 下的、
 *   新位置已经有同名文件的、挪过去以后会被 glob / require.context 等重新加载的（见 recapture.js）
 *
 * README：每个隔离目录一份（就近隔离时每个 _deprecated 目录各一份），已有的原样保留，在最后追加这一批
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
 * @property {'nearby'|'central'} layout
 * @property {string} dirName
 * @property {string|null} dir   central 时的隔离区
 * @property {string|null} base  central 时的 base
 * @property {Move[]} moves
 * @property {{file: string, reason: string}[]} skipped
 * @property {{dir: string, path: string, exists: boolean, moves: Move[]}[]} readmes  每个隔离目录一份
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
 * @param {(path: string) => string|null} [opts.recaptured] 新位置会不会被重新加载（见 recapture.js）；不传就不查
 * @returns {QuarantinePlan}
 */
export function buildPlan({ data, config, files, readFile, movedAt, branch, recaptured = () => null, isSymlink = () => false }) {
  const { layout, dirName } = config.quarantine
  const central = layout === 'central'
  const dir = central ? (config.quarantine.dir ?? `${config.sourceRoots[0]}/${dirName}`) : null
  const base = central ? (config.quarantine.base ?? config.sourceRoots[0]) : null
  const toOf = (file) => (central ? posix.join(dir, posix.relative(base, file)) : posix.join(posix.dirname(file), dirName, posix.basename(file)))
  const fileSet = new Set(files)
  const skipped = []

  const candidates = data.items.filter((i) => i.kind === 'file' && DELETABLE.includes(i.status))
  const byFile = new Map(candidates.map((i) => [i.target, i]))
  const reasonOf = (item) => {
    if (isSymlink(item.target)) return '原文件是符号链接，隔离会跟随到仓库外，需人工处理'
    if (central && item.target.startsWith(`${dir}/`)) return '已经在隔离区里'
    if (item.target.split('/').slice(0, -1).includes(dirName)) return `已经隔离过（路径里有 ${dirName}）`
    if (!item.verify) return '没有实删验证（先跑 verify）'
    if (!item.verify.passed) return '实删验证没通过'
    if (central && !item.target.startsWith(`${base}/`)) return `不在 quarantine.base（${base}）下，不知道放进隔离区哪里`
    const to = toOf(item.target)
    if (fileSet.has(to)) return `新位置已经有同名文件：${to}`
    const parts = to.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      if (isSymlink(parent)) return `新位置的父目录是符号链接：${parent}`
      if (fileSet.has(parent)) return `新位置的父路径被文件占用：${parent}`
    }
    if ([...fileSet].some((f) => f.startsWith(`${to}/`))) return `新位置被同名目录占用：${to}`
    const again = recaptured(to)
    if (again) return `挪到 ${to} 以后${again}，不能放这里`
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

  const moved = new Map(moving.map((f) => [f, toOf(f)]))
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

  // README：每个隔离目录一份
  const byDir = new Map()
  for (const m of moves) {
    const d = central ? dir : posix.dirname(m.to)
    byDir.set(d, [...(byDir.get(d) ?? []), m])
  }
  const readmes = [...byDir]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, ms]) => ({ dir: d, path: `${d}/README.md`, exists: fileSet.has(`${d}/README.md`), moves: ms }))

  return {
    layout,
    dirName,
    dir,
    base,
    moves,
    skipped: skipped.sort((a, b) => (a.file < b.file ? -1 : 1)),
    readmes,
    lintHints: lintHints(fileSet, central ? `${dir}/**` : `**/${dirName}/**`)
  }
}

/**
 * lint 配置不自动改（各项目写法差别很大），只提示要加什么
 */
function lintHints(fileSet, glob) {
  const hints = []
  if (fileSet.has('.eslintignore')) hints.push(`.eslintignore 里加一行：${glob}`)
  const flat = [...fileSet].find((f) => /^eslint\.config\.(js|mjs|cjs|ts)$/.test(f))
  if (flat) hints.push(`${flat} 的 ignores 里加上：'${glob}'`)
  const legacy = [...fileSet].find((f) => /^\.eslintrc(\.(js|cjs|json|yml|yaml))?$/.test(f))
  if (legacy && !fileSet.has('.eslintignore')) hints.push(`${legacy} 的 ignorePatterns 里加上：'${glob}'`)
  if (fileSet.has('tsconfig.json')) hints.push(`如果跑类型检查（vue-tsc / tsc），tsconfig.json 的 exclude 里可以加上：'${glob}'`)
  return hints
}
