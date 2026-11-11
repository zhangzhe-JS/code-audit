/**
 * code-audit exports：导出维度。从入口走得到的文件里，找出没人用的导出，判定状态并写明依据
 *
 * 步骤：
 * 1. 跑文件维度的 scan，让 knip 同时报出没人用的导出（只用项目入口跑一次、加上测试入口再跑一次，两次一比得到「只有测试用到」）
 * 2. 解析源码（oxc，接口维度的 extractFile），知道每个导出对应文件里的哪个顶层名字、同文件里谁引用了谁
 * 3. 判定（越不敢动的越优先）：
 *    - unknown       所在文件落在路径确定不了的动态加载范围里（按名字取导出看不出）
 *    - external      构建配置、脚本等源码目录外的代码 import 了这个名字
 *    - pending       没合并的分支里有文件 import 了这个名字
 *    - dormant       在用的代码里有注释掉的引用（注释里写着这个文件的路径和这个名字）
 *    - test-only     只有测试 import 它：要删就连同测试一起删
 *    - internal      外部没人用，但同文件里在用的代码调用它：只去掉 export，声明保留
 *    - dead-only-ref 同文件里只有同样没人用的代码引用它：跟着一起删
 *    - dead          同文件里也没人引用：整个声明可以删
 *    重新导出（export { a } from './x'）没人用的：判 dead，建议删掉这条转出，原文件里的声明另算
 * 4. 自动导入（unplugin-auto-import 的声明文件里登记的本地函数）被按名字用到的不算候选：knip 看不到这种用法
 *
 * 只读：分析提交里的代码，导出到系统临时目录
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../core/config.js'
import { TOOL } from '../core/tool.js'
import { scan as scanFiles, matchesReview } from '../collect/scan.js'
import { findKnip, runKnip } from '../collect/knip.js'
import { createSnapshot } from '../collect/snapshot.js'
import { buildLookup, resolveSpec } from '../collect/path-refs.js'
import { outsideCode } from '../collect/external-refs.js'
import { findCommentRefs } from '../collect/comment-refs.js'
import { findBranchRefs } from '../collect/branch-refs.js'
import { globToRegExp } from '../collect/glob-imports.js'
import { findDynamicLoads, inScope } from '../collect/dynamic-imports.js'
import { findAutoImports, findNameUses } from '../collect/auto-imports.js'
import { git } from '../history/git.js'
import { extractFile, loadParser } from '../api/extract.js'
import { usedBindings } from '../api/scan.js'

export const EXPORTS_SCHEMA_VERSION = 1

/** 状态，顺序就是优先级（越不敢动的越优先） */
export const EXPORT_STATUSES = ['unknown', 'external', 'pending', 'dormant', 'test-only', 'internal', 'dead-only-ref', 'dead']

/** 每种状态建议怎么处理 */
export const EXPORT_SUGGESTIONS = Object.freeze({
  unknown: '人工确认：可能被动态加载后按名字取用',
  external: '保留：源码目录外的代码在用',
  pending: '先不动：等没合并的分支合并或关闭后再判断',
  dormant: '保留：有注释掉的引用，以后可能恢复',
  'test-only': '确认业务还要不要；要删就连同测试一起删',
  internal: '只去掉 export，声明保留（同文件里在用）',
  'dead-only-ref': '和引用它的、同样没人用的代码一起删',
  dead: '删掉这个声明（连同 export）'
})

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.project
 * @param {Readonly<import('../core/config.js').Config>} [opts.config]
 * @param {string} [opts.rev]
 * @param {string} [opts.knipDir]
 * @param {typeof runKnip} [opts.run]
 */
export function scanExports({ root, project, config = DEFAULT_CONFIG, rev = 'HEAD', knipDir, run = runKnip }) {
  // 1. 文件维度 + knip 报出没人用的导出：区分只用项目入口的那次和加上测试入口的那次
  const testSet = new Set(config.testEntries)
  let mainRun = null
  let testRun = null
  const capture = (args) => {
    const r = run({ ...args, exports: true })
    if (args.config.entry.some((e) => testSet.has(e))) testRun = r
    else mainRun = r
    return r
  }
  const files = scanFiles({ root, project, config, rev, knipDir, run: capture })
  const commit = files.candidates.rev
  const unreachable = new Set(mainRun.unusedFiles)
  const unusedMain = mainRun.unusedExports ?? new Map()
  const unusedWithTests = testRun?.unusedExports ?? null

  // 2. 解析
  const parser = loadParser(findKnip(knipDir).dir)
  const snap = createSnapshot(root, commit)
  let parsed
  let outside
  let declarations
  let allSources
  let testFiles
  try {
    testFiles = new Set(snap.list(config.testEntries.map((p) => `:(glob)${p}`)))
    allSources = snap.list(config.sourceRoots).filter((f) => config.extensions.some((e) => f.endsWith(e)))
    declarations = snap.list(config.sourceRoots).filter((f) => f.endsWith('.d.ts'))
    const outsidePaths = outsideCode({ all: snap.list(['.']), sourceRoots: config.sourceRoots, extensions: config.extensions, exclude: (f) => testFiles.has(f) })
    snap.extract([...new Set([...allSources, ...declarations, ...outsidePaths])])
    const read = (path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') })
    const sources = allSources.filter((f) => !f.endsWith('.d.ts') && !testFiles.has(f)).map(read)
    parsed = sources.map(({ path, content }) => ({ ...extractFile({ parser, path, content, calls: [] }), content }))
    outside = outsidePaths.map(read)
    declarations = declarations.map(read)
  } finally {
    snap.cleanup()
  }
  const byPath = new Map(parsed.map((p) => [p.path, p]))
  const lookup = buildLookup(allSources)
  const resolve = (spec, from) => {
    const r = resolveSpec(spec, from, config.aliases)
    return r === null ? null : (lookup.get(r) ?? [])[0] ?? null
  }

  // 自动导入：登记了、并且按名字被用到的本地函数，knip 看不到（scan 只补了默认导入）
  const autos = findAutoImports({ files: declarations, sourceSet: new Set(allSources), extensions: config.extensions, aliases: config.aliases })
  const autoUsed = new Set()
  if (autos.names.size > 0) {
    const liveFiles = parsed.filter((p) => !unreachable.has(p.path)).map((p) => ({ path: p.path, content: p.content }))
    // 按名字逐个找：同一个文件登记了好几个名字，用到一个不代表都用到了
    for (const [name, file] of autos.names) {
      const uses = findNameUses({ files: liveFiles, names: new Map([[name, file]]) })
      if ((uses.get(file) ?? []).length > 0) autoUsed.add(`${file}#${name}`)
    }
  }

  // 3. 候选：走得到的源码文件里，只用项目入口时没人用的导出
  const candidates = []
  for (const p of parsed) {
    if (unreachable.has(p.path)) continue
    const names = unusedMain.get(p.path)
    if (!names || names.size === 0) continue
    const used = usedBindings(p, names)
    for (const name of [...names].sort()) {
      if (autoUsed.has(`${p.path}#${name}`)) continue
      const local = [...p.bindings].find(([, b]) => b.exported.has(name))?.[0] ?? null
      const re = local === null ? p.reexports.find((r) => r.exported === name) : null
      if (local === null && !re) continue // 只在编译时存在的（type、interface）：不在导出维度里
      const item = { file: p.path, name, local, line: local !== null ? p.declLines.get(local) ?? null : re?.line ?? null, status: 'dead', evidence: [] }
      item.evidence.push({ rule: 'knip-unused-export', detail: '从入口出发没有文件 import 这个名字（knip，测试入口不算）' })
      if (re) {
        item.reexport = { source: re.source, imported: re.imported }
        item.evidence.unshift({ rule: 'reexport', detail: `这是转出（export { ${re.imported === name ? name : `${re.imported} as ${name}`} } from '${re.source}'）：没人从这里引入，删掉这条转出即可，原文件里的声明另算` })
      } else if (local !== null && used.has(local)) {
        item.status = 'internal'
        const by = [...p.bindings].filter(([n, b]) => n !== local && used.has(n) && b.refs.has(local)).map(([n]) => n)
        item.evidence.unshift({ rule: 'internal-use', detail: `同文件里在用的${by.length > 0 ? ` ${by.slice(0, 5).join('、')}` : '代码（模块顶层）'} 调用它：只能去掉 export` })
      } else if (local !== null && [...p.bindings].some(([n, b]) => n !== local && b.refs.has(local))) {
        item.status = 'dead-only-ref'
        const by = [...p.bindings].filter(([n, b]) => n !== local && b.refs.has(local)).map(([n]) => n)
        item.evidence.unshift({ rule: 'dead-only-ref', detail: `同文件里只有同样没人用的 ${by.slice(0, 5).join('、')} 引用它` })
      } else {
        item.evidence.push({ rule: 'no-internal-use', detail: '同文件里也没有代码引用它' })
      }
      if (autos.names.get(name) === p.path) item.evidence.push({ rule: 'auto-import', tag: 'auto-import', detail: '自动导入的声明文件里登记了它，但代码里没有用到这个名字' })
      candidates.push(item)
    }
  }

  // 测试里在用
  if (unusedWithTests) {
    for (const c of candidates) {
      if (!(unusedWithTests.get(c.file)?.has(c.name))) {
        raise(c, 'test-only', { rule: 'test-only', detail: '加上测试入口后有文件 import 它：只有测试在用' })
      }
    }
  }

  const targets = [...new Set(candidates.map((c) => c.file))]
  const byFile = (file) => candidates.filter((c) => c.file === file)

  // 源码目录外的代码（构建配置、脚本）import 了这个名字
  for (const f of outside) {
    const p = extractFile({ parser, path: f.path, content: f.content, calls: [] })
    for (const imp of p.imports) {
      const target = resolve(imp.source, f.path)
      if (!target) continue
      for (const c of byFile(target)) {
        if (imp.specifiers.some((sp) => sp.imported === c.name || sp.imported === '*')) raise(c, 'external', { rule: 'outside-import', detail: `${f.path} import 了它（源码目录外，knip 不分析）` })
      }
    }
  }

  // 注释掉的引用：在用的代码的注释里写着这个文件的路径，同一行里有这个名字
  const live = parsed.filter((p) => !unreachable.has(p.path)).map((p) => ({ path: p.path, content: p.content }))
  const comments = findCommentRefs({ files: live, targets, aliases: config.aliases })
  for (const [target, refs] of comments) {
    for (const c of byFile(target)) {
      const word = new RegExp(`(^|[^\\w$])${escapeRe(c.name)}([^\\w$]|$)`)
      const hit = refs.find((r) => word.test(r.text))
      if (hit) raise(c, 'dormant', { rule: 'commented-import', detail: `${hit.from}:${hit.line} 注释掉的引用：${hit.text}` })
    }
  }

  // 没合并的分支：分支改过的文件 import 了这个名字
  const branches = findBranchRefs({ root, rev: commit, targets, extensions: config.extensions, aliases: config.aliases, branches: config.branches })
  const isTest = (path) => testRes.some((re) => re.test(path))
  const testRes = config.testEntries.map(globToRegExp)
  const branchContent = (branch, path) => {
    for (const name of branch.split('、')) {
      try {
        return git(root, ['show', `${name}:${path}`], { raw: true })
      } catch {
        // 换一个同提交的分支名再试
      }
    }
    return null
  }
  for (const [target, refs] of branches.refs) {
    // 分支改过这个文件本身：分支版本里同文件还在用这个名字（新加了调用），这边删掉声明合并时会出问题
    for (const r of refs.filter((x) => x.kind === 'modified')) {
      const content = branchContent(r.branch, target)
      if (content === null) continue
      const bp = extractFile({ parser, path: target, content, calls: [] })
      const here = byPath.get(target)
      for (const c of byFile(target)) {
        if (!c.local) continue
        // 分支版本里有当前版本没有的调用方（新加的调用）才算；原来就有的引用两边一样，不影响
        const callers = (p) => new Set([...(p?.bindings ?? [])].filter(([n, b]) => n !== c.local && b.refs.has(c.local)).map(([n]) => n))
        const before = callers(here)
        const added = [...callers(bp)].filter((n) => !before.has(n))
        if (added.length > 0) raise(c, 'pending', { rule: 'branch-modified', detail: `没合并的分支 ${r.branch}（最后提交 ${r.date}）改过这个文件，分支版本里新加了调用：${added.slice(0, 3).join('、')}` })
      }
    }
    // 分支上测试文件里的引用不算：测试在用不是业务在用
    for (const r of refs.filter((x) => x.kind === 'import' && !isTest(x.from))) {
      let content = null
      for (const name of r.branch.split('、')) {
        try {
          content = git(root, ['show', `${name}:${r.from}`], { raw: true })
          break
        } catch {
          // 换一个同提交的分支名再试
        }
      }
      if (content === null) continue
      const p = extractFile({ parser, path: r.from, content, calls: [] })
      for (const c of byFile(target)) {
        const imp = p.imports.find((i) => resolve(i.source, r.from) === target && i.specifiers.some((sp) => sp.imported === c.name || sp.imported === '*'))
        if (imp) raise(c, 'pending', { rule: 'branch-import', detail: `没合并的分支 ${r.branch}（最后提交 ${r.date}）里 ${r.from}:${r.line} 引用了它` })
      }
    }
  }

  // 路径确定不了的动态加载：加载进来的模块可能按名字取导出
  const loads = findDynamicLoads({ files: [...live, ...outside], aliases: config.aliases }).filter((l) => !config.reviewedDynamicLoads.some((rv) => matchesReview(rv, l)))
  for (const c of candidates) {
    const l = loads.find((x) => x.kind !== 'component' && inScope(c.file, x.scope))
    if (l) raise(c, 'unknown', { rule: 'dynamic-load', detail: `可能被 ${l.from}:${l.line} 动态加载（${l.expr}），加载后按名字取导出看不出。人工确认后可以写进配置 reviewedDynamicLoads` })
  }

  for (const c of candidates) c.suggestion = EXPORT_SUGGESTIONS[c.status]
  candidates.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name))
  const byStatus = {}
  for (const c of candidates) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
  return {
    version: EXPORTS_SCHEMA_VERSION,
    kind: 'exports',
    generatedAt: new Date().toISOString(),
    tool: { ...TOOL },
    project: { name: project, root, rev: commit, entries: [...config.entries] },
    summary: { candidates: candidates.length, byStatus, files: targets.length, testEntries: config.testEntries.length > 0, branches: { checked: branches.checked.length, skipped: branches.skipped.length } },
    items: candidates
  }
}

/** 改成更不敢动的状态（按 EXPORT_STATUSES 的顺序），证据放在最前面 */
function raise(item, status, evidence) {
  item.evidence.unshift(evidence)
  if (EXPORT_STATUSES.indexOf(status) < EXPORT_STATUSES.indexOf(item.status)) item.status = status
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
